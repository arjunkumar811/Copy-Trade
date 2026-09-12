import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryJobQueue } from '../src/queue/memory.js';
import { createQueueWorker } from '../src/queue/worker.js';
import { createSourceTransactionQueue } from '../src/queue/source-transaction.js';
import { JOB_TYPES } from '../src/queue/types.js';
import type { BlockchainTransactionEvent } from '../src/blockchain/types.js';
import { createLogger } from '../src/infrastructure/logger.js';

const logger = createLogger('error', () => undefined);
const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const sourceEvent: BlockchainTransactionEvent = {
  sourceWalletAddress: 'wallet-1', signature: 'signature-1', slot: 1, blockTime: new Date(), rawData: { ok: true }
};

test('enqueues idempotent jobs and completes successful work', async () => {
  const queue = createMemoryJobQueue();
  const first = await queue.enqueue(JOB_TYPES.TRADE_DETECTION, 'event-1', { value: 1 });
  const duplicate = await queue.enqueue(JOB_TYPES.TRADE_DETECTION, 'event-1', { value: 2 });
  assert.equal(first.id, duplicate.id);
  const handled: string[] = [];
  const worker = createQueueWorker(queue, { [JOB_TYPES.TRADE_DETECTION]: async (job) => { handled.push(job.id); } }, logger, { workerId: 'worker-1', pollIntervalMs: 1 });
  await worker.start();
  await wait(20);
  await worker.stop();
  assert.deepEqual(handled, [first.id]);
  assert.equal(queue.jobs.get(first.id)?.status, 'completed');
});

test('retries failed jobs with backoff and succeeds later', async () => {
  const queue = createMemoryJobQueue();
  const job = await queue.enqueue(JOB_TYPES.SOURCE_TRANSACTION_PROCESSING, 'retry-1', {}, { maxAttempts: 3 });
  let attempts = 0;
  const worker = createQueueWorker(queue, { [JOB_TYPES.SOURCE_TRANSACTION_PROCESSING]: async () => { attempts += 1; if (attempts === 1) throw new Error('temporary'); } }, logger, { workerId: 'worker-retry', pollIntervalMs: 1, retryBaseDelayMs: 1 });
  await worker.start();
  await wait(30);
  await worker.stop();
  assert.equal(attempts, 2);
  assert.equal(queue.jobs.get(job.id)?.status, 'completed');
});

test('moves permanently failing jobs to the dead-letter collection', async () => {
  const queue = createMemoryJobQueue();
  const job = await queue.enqueue(JOB_TYPES.COPY_TRADE_CREATION, 'dead-1', {}, { maxAttempts: 2 });
  const worker = createQueueWorker(queue, { [JOB_TYPES.COPY_TRADE_CREATION]: async () => { throw new Error('permanent'); } }, logger, { workerId: 'worker-dead', pollIntervalMs: 1, retryBaseDelayMs: 1 });
  await worker.start();
  await wait(30);
  await worker.stop();
  assert.equal(queue.jobs.get(job.id)?.status, 'failed');
  assert.equal(queue.deadLetters.length, 1);
  assert.equal(queue.deadLetters[0]?.errorMessage, 'permanent');
});

test('recovers a leased job after a worker restart', async () => {
  const queue = createMemoryJobQueue(1);
  const job = await queue.enqueue(JOB_TYPES.TRADE_DETECTION, 'restart-1', {});
  const claimed = await queue.claim('crashed-worker', 1);
  assert.equal(claimed[0]?.id, job.id);
  await wait(5);
  let handled = false;
  const worker = createQueueWorker(queue, { [JOB_TYPES.TRADE_DETECTION]: async () => { handled = true; } }, logger, { workerId: 'restarted-worker', pollIntervalMs: 1 });
  await worker.start();
  await wait(15);
  await worker.stop();
  assert.equal(handled, true);
  assert.equal(queue.jobs.get(job.id)?.status, 'completed');
});

test('limits worker concurrency', async () => {
  const queue = createMemoryJobQueue();
  for (let index = 0; index < 5; index += 1) await queue.enqueue(JOB_TYPES.TRADE_DETECTION, `concurrency-${index}`, {});
  let active = 0;
  let maximum = 0;
  const worker = createQueueWorker(queue, { [JOB_TYPES.TRADE_DETECTION]: async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await wait(8);
    active -= 1;
  } }, logger, { workerId: 'worker-concurrency', concurrency: 2, pollIntervalMs: 1 });
  await worker.start();
  await wait(60);
  await worker.stop();
  assert.equal(maximum, 2);
});

test('graceful shutdown waits for active work', async () => {
  const queue = createMemoryJobQueue();
  await queue.enqueue(JOB_TYPES.SOURCE_TRANSACTION_PROCESSING, 'shutdown-1', {});
  let finished = false;
  const worker = createQueueWorker(queue, { [JOB_TYPES.SOURCE_TRANSACTION_PROCESSING]: async () => { await wait(20); finished = true; } }, logger, { workerId: 'worker-shutdown', pollIntervalMs: 1 });
  await worker.start();
  await wait(5);
  await worker.stop();
  assert.equal(finished, true);
});

test('adapts source transactions to idempotent processing jobs', async () => {
  const queue = createMemoryJobQueue();
  const sourceQueue = createSourceTransactionQueue(queue);
  await sourceQueue.enqueue(sourceEvent);
  await sourceQueue.enqueue(sourceEvent);
  assert.equal(queue.jobs.size, 1);
  const job = [...queue.jobs.values()][0];
  assert.equal(job?.type, JOB_TYPES.SOURCE_TRANSACTION_PROCESSING);
});
