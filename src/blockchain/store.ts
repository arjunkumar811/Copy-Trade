import type { Database } from '../db/pool.js';
import type { SourceTransactionStore, WatchedWalletStore } from './types.js';

interface QueryResult<T> { rows: T[]; }

export function createDatabaseSourceTransactionStore(database: Database): SourceTransactionStore {
  return {
    async persist(event): Promise<boolean> {
      return database.transaction(async (client) => {
        const wallet = await client.query(
          `INSERT INTO wallets (user_id, chain, address) VALUES (NULL, 'solana', $1)
           ON CONFLICT (chain, address) DO UPDATE SET updated_at = wallets.updated_at
           RETURNING id`,
          [event.sourceWalletAddress]
        ) as QueryResult<{ id: string }>;
        const walletId = wallet.rows[0]?.id;
        if (!walletId) throw new Error('Unable to resolve source wallet');
        const source = await client.query(
          `INSERT INTO source_transactions (source_wallet_id, signature, slot, block_time, status, raw_data)
           VALUES ($1, $2, $3, $4, 'observed', $5)
           ON CONFLICT (source_wallet_id, signature) DO NOTHING
           RETURNING id`,
          [walletId, event.signature, event.slot, event.blockTime, event.rawData]
        ) as QueryResult<{ id: string }>;
        return source.rows.length > 0;
      });
    }
  };
}

export function createDatabaseWatchedWalletStore(database: Database): WatchedWalletStore {
  return {
    async listWatchedWalletAddresses(): Promise<string[]> {
      const result = await database.query(
        `SELECT DISTINCT w.address
         FROM followed_traders f
         JOIN wallets w ON w.id = f.trader_wallet_id
         WHERE f.status = 'active' AND w.chain = 'solana'`,
      ) as QueryResult<{ address: string }>;
      return result.rows.map((row) => row.address);
    }
  };
}
