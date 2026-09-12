export const JOB_TYPES = {
  SOURCE_TRANSACTION_PROCESSING: 'SOURCE_TRANSACTION_PROCESSING',
  TRADE_DETECTION: 'TRADE_DETECTION',
  COPY_TRADE_CREATION: 'COPY_TRADE_CREATION'
} as const;

export type JobType = typeof JOB_TYPES[keyof typeof JOB_TYPES];
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface QueueJob<T = unknown> {
  id: string;
  type: JobType;
  idempotencyKey: string;
  payload: T;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  lockedBy: string | null;
}

export interface EnqueueOptions {
  maxAttempts?: number;
  availableAt?: Date;
}

export interface JobQueue {
  enqueue<T>(type: JobType, idempotencyKey: string, payload: T, options?: EnqueueOptions): Promise<QueueJob<T>>;
  claim(workerId: string, limit: number): Promise<QueueJob[]>;
  acknowledge(jobId: string, workerId: string): Promise<void>;
  fail(jobId: string, workerId: string, error: Error, retryDelayMs: number): Promise<'retry' | 'dead-letter'>;
  close(): Promise<void>;
}

export type JobHandler = (job: QueueJob) => Promise<void>;

export interface QueueWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
}
