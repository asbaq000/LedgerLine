import 'dotenv/config';

const int = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new TypeError(`expected an integer, got ${value}`);
  return n;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
};

const csvInts = (value, fallback) => {
  if (!value) return fallback;
  return value.split(',').map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n)) throw new TypeError(`expected integer list, got ${value}`);
    return n;
  });
};

export const config = {
  port: int(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  databaseUrl: process.env.DATABASE_URL ?? null,
  pgliteDir: process.env.PGLITE_DIR ?? null,

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? null,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_local_development_secret',
    // 0 disables the replay window. Only ever set that in tests that need to
    // replay a fixed historical payload.
    toleranceSeconds: int(process.env.STRIPE_WEBHOOK_TOLERANCE, 300),
  },

  redisUrl: process.env.REDIS_URL ?? null,

  dunning: {
    // Day offsets from the FIRST failure, not gaps between retries.
    retryOffsetDays: csvInts(process.env.DUNNING_RETRY_DAYS, [1, 3, 7]),
    maxAttempts: int(process.env.DUNNING_MAX_ATTEMPTS, 3),
  },

  jobs: {
    // In-process poller interval when Redis is absent.
    pollIntervalMs: int(process.env.JOB_POLL_INTERVAL_MS, 15_000),
    enabled: bool(process.env.JOBS_ENABLED, true),
  },

  email: {
    from: process.env.EMAIL_FROM ?? 'billing@example.com',
    // No provider key => notifications are logged to console and persisted,
    // which the brief explicitly allows.
    apiKey: process.env.RESEND_API_KEY ?? null,
  },
};

export function describeRuntime() {
  return {
    database: config.databaseUrl ? 'postgres' : 'pglite (in-process)',
    stripe: config.stripe.secretKey ? 'live SDK (test key)' : 'offline fake',
    queue: config.redisUrl ? 'bullmq + redis' : 'postgres-backed poller',
    email: config.email.apiKey ? 'resend' : 'console + db log',
  };
}
