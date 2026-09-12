CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	chain varchar(32) NOT NULL DEFAULT 'solana',
	address varchar(64) NOT NULL,
	is_primary boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT wallets_chain_address_unique UNIQUE (chain, address),
	CONSTRAINT wallets_user_address_unique UNIQUE (user_id, address)
);
CREATE INDEX IF NOT EXISTS wallets_user_id_idx ON wallets(user_id);

CREATE TABLE IF NOT EXISTS followed_traders (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	follower_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	trader_wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
	status varchar(16) NOT NULL DEFAULT 'active',
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT followed_traders_pair_unique UNIQUE (follower_user_id, trader_wallet_id),
	CONSTRAINT followed_traders_status_check CHECK (status IN ('active', 'paused', 'unfollowed'))
);
CREATE INDEX IF NOT EXISTS followed_traders_follower_status_idx ON followed_traders(follower_user_id, status);
CREATE INDEX IF NOT EXISTS followed_traders_trader_status_idx ON followed_traders(trader_wallet_id, status);

CREATE TABLE IF NOT EXISTS copy_trade_settings (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	followed_trader_id uuid NOT NULL UNIQUE REFERENCES followed_traders(id) ON DELETE CASCADE,
	enabled boolean NOT NULL DEFAULT false,
	fixed_amount numeric(38, 18),
	max_trade_amount numeric(38, 18),
	slippage_bps integer NOT NULL DEFAULT 100,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT copy_trade_settings_amounts_check CHECK (
		(fixed_amount IS NULL OR fixed_amount > 0) AND
		(max_trade_amount IS NULL OR max_trade_amount > 0)
	),
	CONSTRAINT copy_trade_settings_slippage_check CHECK (slippage_bps BETWEEN 0 AND 10_000)
);

CREATE TABLE IF NOT EXISTS source_transactions (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	source_wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
	signature varchar(128) NOT NULL,
	slot bigint,
	block_time timestamptz,
	status varchar(16) NOT NULL DEFAULT 'observed',
	raw_data jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT source_transactions_wallet_signature_unique UNIQUE (source_wallet_id, signature),
	CONSTRAINT source_transactions_status_check CHECK (status IN ('observed', 'processed', 'failed'))
);
CREATE INDEX IF NOT EXISTS source_transactions_wallet_created_idx ON source_transactions(source_wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS source_transactions_status_idx ON source_transactions(status);

CREATE TABLE IF NOT EXISTS detected_trades (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	source_transaction_id uuid NOT NULL UNIQUE REFERENCES source_transactions(id) ON DELETE RESTRICT,
	input_mint varchar(64) NOT NULL,
	output_mint varchar(64) NOT NULL,
	input_amount numeric(38, 18) NOT NULL,
	output_amount numeric(38, 18) NOT NULL,
	detected_at timestamptz NOT NULL DEFAULT now(),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT detected_trades_amounts_check CHECK (input_amount > 0 AND output_amount > 0)
);

CREATE TABLE IF NOT EXISTS copy_trade_orders (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
	followed_trader_id uuid NOT NULL REFERENCES followed_traders(id) ON DELETE RESTRICT,
	detected_trade_id uuid NOT NULL REFERENCES detected_trades(id) ON DELETE RESTRICT,
	idempotency_key varchar(256) NOT NULL UNIQUE,
	amount numeric(38, 18) NOT NULL,
	slippage_bps integer NOT NULL,
	status varchar(16) NOT NULL DEFAULT 'pending',
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT copy_trade_orders_event_unique UNIQUE (user_id, detected_trade_id),
	CONSTRAINT copy_trade_orders_amount_check CHECK (amount > 0),
	CONSTRAINT copy_trade_orders_slippage_check CHECK (slippage_bps BETWEEN 0 AND 10_000),
	CONSTRAINT copy_trade_orders_status_check CHECK (status IN ('pending', 'authorized', 'submitted', 'completed', 'failed', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS copy_trade_orders_user_status_idx ON copy_trade_orders(user_id, status);
CREATE INDEX IF NOT EXISTS copy_trade_orders_status_created_idx ON copy_trade_orders(status, created_at);

CREATE TABLE IF NOT EXISTS trade_executions (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	copy_trade_order_id uuid NOT NULL UNIQUE REFERENCES copy_trade_orders(id) ON DELETE RESTRICT,
	blockchain_signature varchar(128),
	status varchar(16) NOT NULL DEFAULT 'created',
	error_code varchar(64),
	submitted_at timestamptz,
	confirmed_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT trade_executions_status_check CHECK (status IN ('created', 'submitted', 'confirmed', 'failed'))
);
CREATE INDEX IF NOT EXISTS trade_executions_status_idx ON trade_executions(status);

CREATE TABLE IF NOT EXISTS audit_logs (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid REFERENCES users(id) ON DELETE SET NULL,
	action varchar(128) NOT NULL,
	entity_type varchar(64) NOT NULL,
	entity_id uuid,
	correlation_id varchar(128),
	metadata jsonb,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_user_created_idx ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_logs_correlation_idx ON audit_logs(correlation_id);
