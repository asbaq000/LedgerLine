/**
 * Database access.
 *
 * One interface, two backends:
 *
 *   DATABASE_URL set  -> real Postgres over `pg`
 *   otherwise         -> PGlite, actual Postgres 16 compiled to WASM, in-process
 *
 * PGlite is not a mock or a shim. It is the real engine, so CHECK constraints,
 * ON CONFLICT, transaction rollback and FOR UPDATE SKIP LOCKED all behave the
 * way they will in production. That is what lets the correctness tests run with
 * `npm test` and no Docker, without the tests becoming a fiction.
 *
 * The one behaviour that genuinely differs is real concurrency: PGlite is a
 * single connection, so two webhook deliveries cannot truly race. Tests that
 * need that skip themselves unless DATABASE_URL points at a real server.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const DEFAULT_PGLITE_DIR = './.data/pglite';

let instance = null;

/** Normalise a driver result to { rows, rowCount }. */
function normalize(result) {
  const rows = result?.rows ?? [];
  return {
    rows,
    rowCount: result?.rowCount ?? result?.affectedRows ?? rows.length,
  };
}

async function createPgBackend(connectionString) {
  const pg = (await import('pg')).default;

  // node-pg returns BIGINT (oid 20) as a string to avoid precision loss. Every
  // bigint in this schema is money-in-cents or an epoch second, both far inside
  // the safe-integer range, and the domain layer type-checks for Number. Parse
  // to Number here so the two backends agree -- PGlite already returns numbers.
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // NUMERIC (aggregates)

  const pool = new pg.Pool({ connectionString, max: Number(process.env.PG_POOL_MAX ?? 10) });

  return {
    kind: 'postgres',
    async query(text, params = []) {
      return normalize(await pool.query(text, params));
    },
    /** Multi-statement script. `pg` handles these via the simple query protocol. */
    async exec(sql) {
      await pool.query(sql);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const scoped = {
          kind: 'postgres',
          query: async (text, params = []) => normalize(await client.query(text, params)),
        };
        const out = await fn(scoped);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function createPgliteBackend(dataDir) {
  const { PGlite } = await import('@electric-sql/pglite');

  // PGlite creates its own data directory but not the parents, so a nested
  // path like ./.data/pglite fails on a clean checkout unless we do this.
  if (dataDir) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dirname(dataDir), { recursive: true });
  }

  const db = new PGlite(dataDir); // undefined => ephemeral in-memory

  return {
    kind: 'pglite',
    async query(text, params = []) {
      return normalize(await db.query(text, params));
    },
    /**
     * Multi-statement script. PGlite's `query` is prepared-statement only and
     * rejects multiple commands, so schema scripts have to go through `exec`.
     */
    async exec(sql) {
      await db.exec(sql);
    },
    async tx(fn) {
      // PGlite rolls back automatically when the callback throws (verified).
      return db.transaction(async (t) => {
        const scoped = {
          kind: 'pglite',
          query: async (text, params = []) => normalize(await t.query(text, params)),
        };
        return fn(scoped);
      });
    },
    async close() {
      await db.close();
    },
  };
}

/**
 * Get the process-wide database handle.
 * @param {object} [opts]
 * @param {string|null} [opts.connectionString] Overrides DATABASE_URL.
 * @param {string} [opts.dataDir] PGlite persistence dir; omit for in-memory.
 * @param {boolean} [opts.fresh] Build a new isolated handle instead of the singleton (tests).
 */
export async function getDb(opts = {}) {
  if (!opts.fresh && instance) return instance;

  const connectionString = opts.connectionString ?? process.env.DATABASE_URL ?? null;

  // The long-lived server handle persists to disk so seeded data and billing
  // history survive a restart. A `fresh` handle is deliberately in-memory:
  // every test needs its own empty database, and sharing one directory would
  // silently couple them together.
  const dataDir = opts.dataDir
    ?? (opts.fresh ? undefined : (process.env.PGLITE_DIR ?? DEFAULT_PGLITE_DIR));

  const backend = connectionString
    ? await createPgBackend(connectionString)
    : await createPgliteBackend(dataDir);

  if (!opts.fresh) instance = backend;
  return backend;
}

export async function closeDb() {
  if (instance) {
    await instance.close();
    instance = null;
  }
}

/** Apply schema.sql. Idempotent -- every statement is IF NOT EXISTS. */
export async function migrate(db) {
  const target = db ?? (await getDb());
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  await target.exec(sql);
  return target;
}

/** Drop everything. Test helper; never called by the server. */
export async function dropAll(db) {
  const target = db ?? (await getDb());
  await target.exec(`
    DROP TABLE IF EXISTS notifications, dunning_attempts, webhook_events, invoice_lines,
      invoices, usage_events, billed_items, subscriptions, plans, customers CASCADE;
  `);
}
