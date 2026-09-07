import { getDb, migrate } from '../src/db/index.js';
import { describeRuntime } from '../src/config.js';

const db = await getDb();
await migrate(db);

const { rows } = await db.query(`
  SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' ORDER BY table_name
`);

console.log(`migrated ${describeRuntime().database}`);
console.log(`tables: ${rows.map((r) => r.table_name).join(', ')}`);
await db.close();
