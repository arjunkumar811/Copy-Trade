import type { Logger } from '../infrastructure/logger.js';
import type { JobHandler, JobQueue, QueueJob, QueueWorker } from './types.js';

export interface WorkerOptions {
  workerId: string;
  concurrency?: number;
  pollIntervalMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

const defaultSleep = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

export function createQueueWorker(queue: JobQueue, handlers: Partial<Record<QueueJob['type'], JobHandler>>, logger: Logger, options: WorkerOptions): QueueWorker {
  const concurrency = options.concurrency ?? 5;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
  const retryMaxDelayMs = options.retryMaxDelayMs ?? 30_000;
  const sleep = options.sleep ?? defaultSleep;
  let running = false;
  let loopPromise: Promise<void> | undefined;
  const active = new Set<Promise<void>>();

  const process = async (job: QueueJob): Promise<void> => {
    try {
      const handler = handlers[job.type];
      if (!handler) throw new Error(`No handler registered for ${job.type}`);
      await handler(job);
      await queue.acknowledge(job.id, options.workerId);
      logger.info('Queue job completed', { jobId: job.id, jobType: job.type, workerId: options.workerId });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Unknown job failure');
      const delay = Math.min(retryMaxDelayMs, retryBaseDelayMs * (2 ** Math.min(job.attempts - 1, 10)));
      const disposition = await queue.fail(job.id, options.workerId, failure, delay);
      logger.error('Queue job failed', { jobId: job.id, jobType: job.type, workerId: options.workerId, disposition, error: failure.message });
    }
  };

  const loop = async (): Promise<void> => {
    while (running) {
      const available = Math.max(0, concurrency - active.size);
      if (available > 0) {
        const jobs = await queue.claim(options.workerId, available);
        for (const job of jobs) {
          const task = process(job).finally(() => active.delete(task));
          active.add(task);
        }
      }
      if (active.size === 0 && running) await sleep(pollIntervalMs);
      else await Promise.race(active);
    }
    await Promise.all(active);
  };

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      loopPromise = loop();
      await Promise.resolve();
    },
    async stop(): Promise<void> {
      if (!running) return;
      running = false;
      await loopPromise;
      loopPromise = undefined;
      await queue.close();
      logger.info('Queue worker stopped', { workerId: options.workerId });
    }
  };
}
