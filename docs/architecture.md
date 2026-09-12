# Solana Copy-Trading Architecture

## Status

This document records the Phase 0 repository audit and a proposed architecture. The repository is currently empty apart from the specification files, so the proposed design is intentionally high-level. It does not introduce application code or select concrete infrastructure prematurely.

## Current Architecture

The repository currently has no implemented application architecture.

| Area | Current state |
| --- | --- |
| Frontend | Not present |
| Backend/API | Not present |
| Programming language | Not determined |
| Package manager | Not determined |
| Database/ORM | Not present |
| Queue/workers | Not present |
| Solana libraries | Not present |
| Authentication | Not present |
| Docker | Not present |
| Environment configuration | Not present |
| Tests | Not present |
| Linting/type checking | Not present |
| CI/CD | Not present |

## Proposed Architecture

Start with a modular monolith and explicit boundaries. Deployable processes can be separated later without moving business ownership between modules.

```text
Client
  |
  v
API / Authentication
  |
  +--> Relational database
  |
  +--> Queue --> Ingestion worker --> Transaction processor
                         |                    |
                         |                    v
                         |              Trade detector
                         |                    |
                         +--------------> Copy-trade worker
                                              |
                                              v
                                      Solana provider adapter
                                              |
                                              v
                                           Solana
```

### Component Responsibilities

- **Frontend**: wallet connection, signed authentication, trader discovery, settings, order authorization, execution status, and history. It never receives server secrets or private keys.
- **API**: validates requests, authenticates wallet ownership, manages users and follow relationships, creates durable commands, and returns operation status. It does not perform long-running blockchain processing in an HTTP request.
- **Database**: durable source of truth for users, wallets, followed traders, settings, source transactions, detected trades, copy-trade orders, executions, transaction records, and audit events.
- **Queue**: transports asynchronous ingestion, detection, and execution jobs. It provides retry metadata, backoff, bounded concurrency, job identity, and dead-letter handling.
- **Ingestion worker**: consumes provider notifications or controlled polling, normalizes transactions, and records source events idempotently.
- **Transaction processor**: interprets normalized transactions and emits relevant trade candidates without assuming events arrive only once.
- **Trade detector/strategy module**: applies supported trade rules and user settings to produce validated copy-trade orders.
- **Copy-trade worker**: revalidates authorization and risk limits, submits an approved transaction through the blockchain adapter, and records confirmation state.
- **Solana provider adapter**: isolates RPC, websocket, transaction simulation, submission, and confirmation behavior behind interfaces. Provider-specific errors are translated into application-level retryable or permanent failures.
- **Observability**: structured logs, correlation IDs, job IDs, health checks, and metrics hooks at API, queue, worker, database, and RPC boundaries.

## Request Flow

1. A client requests a challenge for a wallet address.
2. The API creates a short-lived, single-use challenge.
3. The wallet signs the challenge and sends the signature back.
4. The API verifies the signature, consumes the challenge, and creates or loads the user session.
5. Authenticated requests validate ownership and input at the API boundary.
6. Commands that require asynchronous work are persisted and enqueued.
7. The API returns a durable identifier and current status rather than holding the request open.
8. The client reads status from an API endpoint designed for polling or a future notification channel.

## Blockchain Event Flow

1. An ingestion worker receives a provider notification or performs bounded backfill polling.
2. The worker normalizes the provider response into a stable internal transaction shape.
3. A unique key such as `(source_wallet, transaction_signature)` prevents duplicate source events.
4. The normalized event is persisted before downstream processing is acknowledged.
5. A transaction-processing job extracts relevant token movements and trade candidates.
6. Temporary RPC/provider failures are retried with exponential backoff; malformed or unsupported transactions are classified as permanent failures.
7. Dead-lettered jobs retain enough metadata for investigation and controlled replay.

## Copy-Trading Flow

1. A detected trade references the source wallet and source transaction signature.
2. For each eligible follower, the strategy module evaluates enabled settings, limits, token allowlists, slippage, and authorization state.
3. The system creates at most one copy-trade order per user and source event using a database uniqueness constraint.
4. The execution worker claims the order with a compare-and-set status transition.
5. Before submission, it revalidates the order, authorization, limits, and current blockchain data.
6. The worker simulates when supported, submits the transaction, and records the provider signature.
7. Confirmation is tracked asynchronously. Retries never create a second order or blindly resubmit a transaction whose submission status is unknown.
8. Every state transition produces an audit event without secrets or private keys.

## Database Responsibilities

The relational database owns durable business state and idempotency boundaries. Expected tables include:

- `users`
- `wallets`
- `followed_traders`
- `copy_trade_settings`
- `source_transactions`
- `detected_trades`
- `copy_trade_orders`
- `trade_executions`
- `transactions`
- `audit_logs`

Use foreign keys, status columns with explicit transitions, UTC timestamps, unique constraints, and indexes for source wallet/signature, user/order status, and pending work. Store structured fields in columns; reserve JSON for provider payloads or forward-compatible metadata that is not queried as core business state.

## Queue Responsibilities

The queue is the boundary for work that can outlive an HTTP request. Job payloads should contain stable identifiers rather than large provider responses. Each job needs a deterministic idempotency key, retry policy, maximum attempts, exponential backoff, visibility/lease handling, and dead-letter routing. Consumers must be safe under at-least-once delivery and must acknowledge only after durable state changes are complete.

## Worker Responsibilities

Workers should be stateless and horizontally scalable. They claim work using database state transitions or queue leases, use bounded concurrency, propagate correlation and job IDs, and release resources during shutdown. A failed item must be isolated from other jobs. Permanent validation errors are recorded and not retried; transient provider, network, and capacity errors are retried according to policy.

## Failure and Retry Strategy

- Validate input and authorization before enqueueing work.
- Classify failures as validation/permanent, dependency/transient, or unknown.
- Retry transient RPC, queue, and database failures with exponential backoff and a cap.
- Use idempotency keys and unique constraints for duplicate events and worker redelivery.
- Do not retry invalid addresses, rejected authorization, unsupported transaction shapes, or permanent on-chain errors.
- Treat unknown transaction submission outcomes as reconciliation work, not automatic duplicate submission.
- Expose health checks for process readiness and dependency health without leaking credentials.
- Shut down by stopping intake, allowing bounded in-flight work to finish, and closing clients cleanly.

## Scaling Strategy

The first deployment can run API and workers as separate processes from one modular codebase. Scale API instances independently from ingestion and execution workers. Add queue partitions or provider-specific consumers only after measured bottlenecks appear. Use pooled database connections, indexed queries, bounded worker concurrency, provider rate-limit budgets, and backpressure. Avoid a single global listener or in-memory state as the source of truth.

## Security Boundaries

- Private keys and seed phrases are never stored, logged, or sent to the frontend.
- Wallet authentication requires cryptographic signature verification, nonce expiry, and single-use challenge consumption.
- Server-side validation is authoritative for addresses, amounts, slippage, authorization, and transaction parameters.
- Execution requires an explicit user authorization recorded in durable state.
- Secrets come from environment variables or a secret manager and are excluded from logs and client responses.
- Database constraints and atomic status transitions protect against duplicate execution and race conditions.
- Rate limiting, input size limits, audit logging, and dependency timeouts protect public boundaries.
- RPC provider credentials are used only by server-side adapters.

## Problems Found

- There is no implementation to run or audit beyond the specification files.
- No technology choices have been made, so framework-specific configuration would be speculative.
- There are no tests, lint rules, type checks, or CI checks to execute.
- There is no deployment or secret-management configuration.

## Future Files and Areas

Future phases should introduce these areas incrementally:

- project/package manifest and language configuration
- centralized environment schema and configuration loader
- database schema and migrations
- blockchain provider interfaces and deterministic mocks
- wallet challenge/signature authentication
- queue abstraction and worker runtime
- API modules for trader following and copy-trade settings
- ingestion, detection, execution, and reconciliation services
- unit, integration, database, and worker tests
- structured logging, metrics, health endpoints, and CI
- Docker and deployment manifests after runtime choices are confirmed

## Recommended Next Phase

Select the implementation stack and create the minimal project foundation: package manifest, source/test directories, configuration validation, and a health-checkable application shell. Do not add blockchain execution, database migrations, or queue infrastructure until that foundation and its test command are established.
