import type { Database } from '../db/pool.js';
import type { CopyTradeSettings, FollowedTrader, FollowedTraderStore } from './types.js';

interface QueryResult<T> { rows: T[]; }
interface TraderRow {
  id: string;
  traderWalletAddress: string;
  status: FollowedTrader['status'];
  enabled: boolean;
  fixedAmount: string | null;
  balancePercentage: string | null;
  maxTradeAmount: string | null;
  maxDailyLoss: string | null;
  maxSlippageBps: number;
  allowedTokens: string[];
  blockedTokens: string[];
  createdAt: Date;
  updatedAt: Date;
}

const traderSelect = `
  SELECT f.id, w.address AS "traderWalletAddress", f.status,
    COALESCE(s.enabled, false) AS enabled, s.fixed_amount AS "fixedAmount", s.balance_percentage AS "balancePercentage",
    s.max_trade_amount AS "maxTradeAmount", s.max_daily_loss AS "maxDailyLoss",
    COALESCE(s.slippage_bps, 100) AS "maxSlippageBps",
    COALESCE(s.allowed_tokens, '{}') AS "allowedTokens",
    COALESCE(s.blocked_tokens, '{}') AS "blockedTokens",
    f.created_at AS "createdAt", f.updated_at AS "updatedAt"
  FROM followed_traders f
  JOIN wallets w ON w.id = f.trader_wallet_id
  LEFT JOIN copy_trade_settings s ON s.followed_trader_id = f.id`;

function mapRow(row: TraderRow): FollowedTrader {
  const settings: CopyTradeSettings = {
    enabled: row.enabled,
    fixedAmount: row.fixedAmount,
    balancePercentage: row.balancePercentage,
    maxTradeAmount: row.maxTradeAmount,
    maxDailyLoss: row.maxDailyLoss,
    maxSlippageBps: row.maxSlippageBps,
    allowedTokens: row.allowedTokens,
    blockedTokens: row.blockedTokens
  };
  return { id: row.id, traderWalletAddress: row.traderWalletAddress, status: row.status, settings, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export function createDatabaseFollowedTraderStore(database: Database): FollowedTraderStore {
  const getOne = async (userId: string, id: string): Promise<FollowedTrader | null> => {
    const result = await database.query(`${traderSelect} WHERE f.follower_user_id = $1 AND f.id = $2`, [userId, id]) as QueryResult<TraderRow>;
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  };

  return {
    async follow(userId, traderWalletAddress) {
      return database.transaction(async (client) => {
        const wallet = await client.query(
          `INSERT INTO wallets (user_id, chain, address) VALUES (NULL, 'solana', $1)
           ON CONFLICT (chain, address) DO UPDATE SET updated_at = wallets.updated_at
           RETURNING id`,
          [traderWalletAddress]
        ) as QueryResult<{ id: string }>;
        const walletId = wallet.rows[0]?.id;
        if (!walletId) throw new Error('Unable to create or find trader wallet');
        const followed = await client.query(
          `INSERT INTO followed_traders (follower_user_id, trader_wallet_id, status)
           VALUES ($1, $2, 'active')
           ON CONFLICT (follower_user_id, trader_wallet_id)
           DO UPDATE SET status = 'active', updated_at = now()
           RETURNING id`,
          [userId, walletId]
        ) as QueryResult<{ id: string }>;
        const id = followed.rows[0]?.id;
        if (!id) throw new Error('Unable to follow trader');
        const result = await client.query(`${traderSelect} WHERE f.follower_user_id = $1 AND f.id = $2`, [userId, id]) as QueryResult<TraderRow>;
        if (!result.rows[0]) throw new Error('Unable to load followed trader');
        return mapRow(result.rows[0]);
      });
    },
    async list(userId) {
      const result = await database.query(`${traderSelect} WHERE f.follower_user_id = $1 AND f.status <> 'unfollowed' ORDER BY f.created_at DESC`, [userId]) as QueryResult<TraderRow>;
      return result.rows.map(mapRow);
    },
    async remove(userId, followedTraderId) {
      const result = await database.query(
        `DELETE FROM followed_traders WHERE id = $1 AND follower_user_id = $2 RETURNING id`,
        [followedTraderId, userId]
      ) as QueryResult<{ id: string }>;
      return result.rows.length > 0;
    },
    async updateSettings(userId, followedTraderId, settings) {
      const result = await database.query(
        `INSERT INTO copy_trade_settings
          (followed_trader_id, enabled, fixed_amount, balance_percentage, max_trade_amount, max_daily_loss, slippage_bps, allowed_tokens, blocked_tokens)
         SELECT id, $3, $4, $5, $6, $7, $8, $9, $10
         FROM followed_traders
         WHERE id = $1 AND follower_user_id = $2 AND status <> 'unfollowed'
         ON CONFLICT (followed_trader_id) DO UPDATE SET
           enabled = EXCLUDED.enabled, fixed_amount = EXCLUDED.fixed_amount,
           balance_percentage = EXCLUDED.balance_percentage, max_trade_amount = EXCLUDED.max_trade_amount,
           max_daily_loss = EXCLUDED.max_daily_loss, slippage_bps = EXCLUDED.slippage_bps,
           allowed_tokens = EXCLUDED.allowed_tokens, blocked_tokens = EXCLUDED.blocked_tokens,
           updated_at = now()
         RETURNING followed_trader_id`,
        [followedTraderId, userId, settings.enabled, settings.fixedAmount, settings.balancePercentage, settings.maxTradeAmount, settings.maxDailyLoss, settings.maxSlippageBps, settings.allowedTokens, settings.blockedTokens]
      ) as QueryResult<{ followed_trader_id: string }>;
      return result.rows[0] ? getOne(userId, followedTraderId) : null;
    }
  };
}
