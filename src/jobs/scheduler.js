/**
 * Job scheduling.
 *
 * Two drivers behind one interface:
 *
 *   REDIS_URL set -> BullMQ repeatable jobs (the brief's stack)
 *   otherwise     -> an in-process interval that polls Postgres
 *
 * Both drive the SAME worker functions, and in both cases Postgres holds the
 * schedule (dunning_attempts.scheduled_for). BullMQ contributes timers and
 * multi-process fan-out, not truth. That is deliberate: if Redis is flushed the
 * poller -- or a restarted BullMQ -- picks up exactly the same due rows, so no
 * customer escapes dunning because a queue was cleared.
 *
 * Because the claim is `FOR UPDATE SKIP LOCKED`, running both drivers at once
 * is safe; the row lock, not the queue, is what prevents double-charging.
 */

import { config } from '../config.js';
import { runDueDunning } from './dunningWorker.js';
import { runDueRenewals } from './renewalWorker.js';

export async function startScheduler(db, { stripe } = {}) {
  if (!config.jobs.enabled) {
    return { kind: 'disabled', stop: async () => {} };
  }
  return config.redisUrl
    ? startBullMq(db, { stripe })
    : startPoller(db, { stripe });
}

function startPoller(db, { stripe }) {
  let running = false;

  const tick = async () => {
    if (running) return; // never overlap runs
    running = true;
    try {
      await runDueDunning(db, { stripe });
      await runDueRenewals(db, { stripe });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[scheduler] tick failed:', err.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, config.jobs.pollIntervalMs);
  timer.unref?.(); // never hold the process open
  tick();

  return {
    kind: 'poller',
    intervalMs: config.jobs.pollIntervalMs,
    tick,
    stop: async () => clearInterval(timer),
  };
}

async function startBullMq(db, { stripe }) {
  const { Queue, Worker } = await import('bullmq');
  const connection = { url: config.redisUrl };

  const queue = new Queue('billing', { connection });

  // Repeatable jobs are the timer. The workers still read due rows from
  // Postgres, so a lost Redis state costs latency, never correctness.
  await queue.add('dunning', {}, {
    repeat: { every: config.jobs.pollIntervalMs },
    removeOnComplete: 100,
    removeOnFail: 500,
  });
  await queue.add('renewals', {}, {
    repeat: { every: config.jobs.pollIntervalMs },
    removeOnComplete: 100,
    removeOnFail: 500,
  });

  const worker = new Worker(
    'billing',
    async (job) => {
      if (job.name === 'dunning') return runDueDunning(db, { stripe });
      if (job.name === 'renewals') return runDueRenewals(db, { stripe });
      return null;
    },
    { connection, concurrency: 4 },
  );

  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[bullmq] ${job?.name} failed:`, err.message);
  });

  return {
    kind: 'bullmq',
    queue,
    worker,
    stop: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
