import type { Database } from '../db/pool.js';
import type { EnqueueOptions, JobQueue, JobType, QueueJob } from './types.js';

interface QueryResult<T> { rows: T[]; }
interface JobRow {
  id: string;
  jobType: JobType;
  idempotencyKey: string;
  payload: unknown;
  status: QueueJob['status'];
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  lockedBy: string | null;
}

function mapJob(row: JobRow): QueueJob {
  return {
    id: row.id,
    type: row.jobType,
    idempotencyKey: row.idempotencyKey,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt,
    lockedBy: row.lockedBy
  };
}

const columns = `id, job_type AS "jobType", idempotency_key AS "idempotencyKey", payload,
  status, attempts, max_attempts AS "maxAttempts", available_at AS "availableAt", locked_by AS "lockedBy"`;

export function createDatabaseJobQueue(database: Database, leaseSeconds = 60): JobQueue {
  return {
    async enqueue<T>(type: JobType, idempotencyKey: string, payload: T, options: EnqueueOptions = {}): Promise<QueueJob<T>> {
      const maxAttempts = options.maxAttempts ?? 5;
      const availableAt = options.availableAt ?? new Date();
      const result = await database.query(
        `INSERT INTO queue_jobs (job_type, idempotency_key, payload, max_attempts, available_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = queue_jobs.updated_at
         RETURNING ${columns}`,
        [type, idempotencyKey, payload, maxAttempts, availableAt]
      ) as QueryResult<JobRow>;
      const row = result.rows[0];
      if (!row) throw new Error('Queue insert did not return a job');
      return mapJob(row) as QueueJob<T>;
    },
    async claim(workerId: string, limit: number): Promise<QueueJob[]> {
      const result = await database.query(
        `WITH candidates AS (
           SELECT id FROM queue_jobs
           WHERE (status = 'pending' AND available_at <= now())
              OR (status = 'processing' AND locked_at < now() - ($1 * interval '1 second'))
           ORDER BY available_at ASC, created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE queue_jobs j
         SET status = 'processing', attempts = j.attempts + 1,
             locked_at = now(), locked_by = $3, updated_at = now()
         FROM candidates c
         WHERE j.id = c.id
         RETURNING ${columns}`,
        [leaseSeconds, limit, workerId]
      ) as QueryResult<JobRow>;
      return result.rows.map(mapJob);
    },
    async acknowledge(jobId: string, workerId: string): Promise<void> {
      await database.query(
        `UPDATE queue_jobs SET status = 'completed', locked_at = NULL, locked_by = NULL, updated_at = now()
         WHERE id = $1 AND status = 'processing' AND locked_by = $2`,
        [jobId, workerId]
      );
    },
    async fail(jobId: string, workerId: string, error: Error, retryDelayMs: number): Promise<'retry' | 'dead-letter'> {
      return database.transaction(async (client) => {
        const result = await client.query(
          `SELECT ${columns} FROM queue_jobs WHERE id = $1 AND status = 'processing' AND locked_by = $2 FOR UPDATE`,
          [jobId, workerId]
        ) as QueryResult<JobRow>;
        const job = result.rows[0];
        if (!job) return 'retry';
        if (job.attempts >= job.maxAttempts) {
          await client.query(
            `INSERT INTO queue_dead_letters (job_id, job_type, idempotency_key, payload, attempts, error_message)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (job_id) DO NOTHING`,
            [job.id, job.jobType, job.idempotencyKey, job.payload, job.attempts, error.message]
          );
          await client.query(
            `UPDATE queue_jobs SET status = 'failed', locked_at = NULL, locked_by = NULL, last_error = $2, updated_at = now()
             WHERE id = $1`,
            [job.id, error.message]
          );
          return 'dead-letter';
        }
        await client.query(
          `UPDATE queue_jobs SET status = 'pending', available_at = now() + ($2 * interval '1 millisecond'),
             locked_at = NULL, locked_by = NULL, last_error = $3, updated_at = now()
           WHERE id = $1`,
          [job.id, retryDelayMs, error.message]
        );
        return 'retry';
      });
    },
    async close(): Promise<void> {}
  };
}
