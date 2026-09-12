ALTER TABLE wallets ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE copy_trade_settings
  ADD COLUMN IF NOT EXISTS balance_percentage numeric(7, 4),
  ADD COLUMN IF NOT EXISTS max_daily_loss numeric(38, 18),
  ADD COLUMN IF NOT EXISTS allowed_tokens text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS blocked_tokens text[] NOT NULL DEFAULT '{}';

ALTER TABLE copy_trade_settings
  DROP CONSTRAINT IF EXISTS copy_trade_settings_amounts_check;
ALTER TABLE copy_trade_settings
  ADD CONSTRAINT copy_trade_settings_amounts_check CHECK (
    (fixed_amount IS NULL OR fixed_amount > 0) AND
    (max_trade_amount IS NULL OR max_trade_amount > 0) AND
    (max_daily_loss IS NULL OR max_daily_loss >= 0) AND
    (balance_percentage IS NULL OR (balance_percentage > 0 AND balance_percentage <= 100))
  );
