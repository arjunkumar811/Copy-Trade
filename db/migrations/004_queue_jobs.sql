CREATE TABLE IF NOT EXISTS queue_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type varchar(64) NOT NULL,
  idempotency_key varchar(256) NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by varchar(128),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT queue_jobs_status_check CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT queue_jobs_attempts_check CHECK (attempts >= 0 AND max_attempts > 0)
);
CREATE INDEX IF NOT EXISTS queue_jobs_claim_idx ON queue_jobs(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS queue_jobs_lease_idx ON queue_jobs(status, locked_at);

CREATE TABLE IF NOT EXISTS queue_dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE,
  job_type varchar(64) NOT NULL,
  idempotency_key varchar(256) NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL,
  error_message text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS queue_dead_letters_type_idx ON queue_dead_letters(job_type, failed_at);
