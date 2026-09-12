CREATE TABLE IF NOT EXISTS auth_challenges (
  id uuid PRIMARY KEY,
  wallet_address varchar(64) NOT NULL,
  nonce varchar(128) NOT NULL UNIQUE,
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_challenges_wallet_expiry_idx ON auth_challenges(wallet_address, expires_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash varchar(128) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_expiry_idx ON auth_sessions(user_id, expires_at);
