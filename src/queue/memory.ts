import { randomUUID } from 'node:crypto';
import type { EnqueueOptions, JobQueue, JobType, QueueJob } from './types.js';

export interface DeadLetter {
  job: QueueJob;
  errorMessage: string;
}

export function createMemoryJobQueue(leaseMs = 60_000): JobQueue & { jobs: Map<string, QueueJob>; deadLetters: DeadLetter[] } {
  const jobs = new Map<string, QueueJob>();
  const deadLetters: DeadLetter[] = [];
  return {
    jobs,
    deadLetters,
    async enqueue<T>(type: JobType, idempotencyKey: string, payload: T, options: EnqueueOptions = {}): Promise<QueueJob<T>> {
      const existing = [...jobs.values()].find((job) => job.idempotencyKey === idempotencyKey);
      if (existing) return existing as QueueJob<T>;
      const job: QueueJob<T> = {
        id: randomUUID(), type, idempotencyKey, payload, status: 'pending', attempts: 0,
        maxAttempts: options.maxAttempts ?? 5, availableAt: options.availableAt ?? new Date(), lockedBy: null
      };
      jobs.set(job.id, job as QueueJob);
      return job;
    },
    async claim(workerId: string, limit: number): Promise<QueueJob[]> {
      const now = Date.now();
      const candidates = [...jobs.values()]
        .filter((job) => (job.status === 'pending' && job.availableAt.getTime() <= now) ||
          (job.status === 'processing' && job.lockedBy !== workerId && job.availableAt.getTime() <= now - leaseMs))
        .sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime())
        .slice(0, limit);
      return candidates.map((job) => {
        job.status = 'processing';
        job.attempts += 1;
        job.lockedBy = workerId;
        job.availableAt = new Date(now);
        return job;
      });
    },
    async renew(jobId: string, workerId: string): Promise<boolean> {
      const job = jobs.get(jobId);
      if (!job || job.status !== 'processing' || job.lockedBy !== workerId) return false;
      job.availableAt = new Date();
      return true;
    },
    async acknowledge(jobId: string, workerId: string): Promise<void> {
      const job = jobs.get(jobId);
      if (job?.status === 'processing' && job.lockedBy === workerId) {
        job.status = 'completed';
        job.lockedBy = null;
      }
    },
    async fail(jobId: string, workerId: string, error: Error, retryDelayMs: number): Promise<'retry' | 'dead-letter'> {
      const job = jobs.get(jobId);
      if (!job || job.status !== 'processing' || job.lockedBy !== workerId) return 'retry';
      if (job.attempts >= job.maxAttempts) {
        job.status = 'failed';
        job.lockedBy = null;
        deadLetters.push({ job, errorMessage: error.message });
        return 'dead-letter';
      }
      job.status = 'pending';
      job.lockedBy = null;
      job.availableAt = new Date(Date.now() + retryDelayMs);
      return 'retry';
    },
    async close(): Promise<void> {}
  };
}
