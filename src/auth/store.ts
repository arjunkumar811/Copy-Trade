import type { Database } from '../db/pool.js';
import type { AuthChallenge, AuthenticatedUser, AuthStore } from './types.js';

interface QueryResult<T> {
  rows: T[];
}

export function createDatabaseAuthStore(database: Database): AuthStore {
  return {
    async saveChallenge(challenge: AuthChallenge, nonce: string): Promise<void> {
      await database.query(
        `INSERT INTO auth_challenges (id, wallet_address, nonce, message, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [challenge.id, challenge.walletAddress, nonce, challenge.message, challenge.expiresAt]
      );
    },
    async getChallenge(id: string): Promise<(AuthChallenge & { nonce: string; consumedAt: Date | null }) | null> {
      const result = await database.query(
        `SELECT id, wallet_address AS "walletAddress", message, nonce, expires_at AS "expiresAt", consumed_at AS "consumedAt"
         FROM auth_challenges WHERE id = $1`,
        [id]
      ) as QueryResult<AuthChallenge & { nonce: string; consumedAt: Date | null }>;
      return result.rows[0] ?? null;
    },
    async completeChallenge(challengeId: string, walletAddress: string, tokenHash: string, expiresAt: Date): Promise<string | null> {
      return database.transaction(async (client) => {
        const consumed = await client.query(
          `UPDATE auth_challenges
           SET consumed_at = now()
           WHERE id = $1 AND wallet_address = $2 AND consumed_at IS NULL AND expires_at > now()
           RETURNING id`,
          [challengeId, walletAddress]
        ) as QueryResult<{ id: string }>;
        if (consumed.rows.length === 0) return null;

        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [walletAddress]);
        const existingWallet = await client.query(
          'SELECT user_id FROM wallets WHERE chain = \'solana\' AND address = $1',
          [walletAddress]
        ) as QueryResult<{ user_id: string }>;
        let userId = existingWallet.rows[0]?.user_id;
        if (!userId) {
          const user = await client.query('INSERT INTO users DEFAULT VALUES RETURNING id') as QueryResult<{ id: string }>;
          userId = user.rows[0]?.id;
          if (userId) {
            await client.query(
              'INSERT INTO wallets (user_id, chain, address, is_primary) VALUES ($1, \'solana\', $2, true)',
              [userId, walletAddress]
            );
          }
        }
        if (!userId) throw new Error('Unable to create or find authenticated wallet');

        await client.query(
          `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
           VALUES ($1, $2, $3)`,
          [userId, tokenHash, expiresAt]
        );
        return userId;
      });
    },
    async findSession(tokenHash: string): Promise<AuthenticatedUser | null> {
      const result = await database.query(
        `SELECT s.user_id AS "userId", w.address AS "walletAddress"
         FROM auth_sessions s
         JOIN wallets w ON w.user_id = s.user_id AND w.chain = 'solana'
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
         ORDER BY w.is_primary DESC, w.created_at ASC
         LIMIT 1`,
        [tokenHash]
      ) as QueryResult<AuthenticatedUser>;
      return result.rows[0] ?? null;
    }
  };
}
