import { createApp } from './http/app.js';
import { getDb, migrate } from './db/index.js';
import { getStripe } from './stripe/client.js';
import { startScheduler } from './jobs/scheduler.js';
import { config, describeRuntime } from './config.js';

const db = await getDb();
await migrate(db);

const stripe = await getStripe();
const app = await createApp({ db, stripe });
const scheduler = await startScheduler(db, { stripe });

const server = app.listen(config.port, () => {
  const runtime = describeRuntime();
  console.log(`\n  ledgerline           http://localhost:${config.port}`);
  console.log(`  admin dashboard      http://localhost:${config.port}/admin\n`);
  console.log(`  database   ${runtime.database}`);
  console.log(`  stripe     ${runtime.stripe}`);
  console.log(`  queue      ${runtime.queue} (${scheduler.kind})`);
  console.log(`  email      ${runtime.email}\n`);
  if (!config.stripe.secretKey) {
    console.log('  No STRIPE_SECRET_KEY: running against the offline Stripe double.');
    console.log('  Payments settle through the real webhook path, signed and verified.\n');
  }
});

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down.`);
  await scheduler.stop();
  server.close(() => {});
  await db.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
