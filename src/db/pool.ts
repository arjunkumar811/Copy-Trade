import { Pool, type PoolConfig } from 'pg';
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../infrastructure/logger.js';

export interface Database {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
  transaction<T>(callback: (client: DatabaseClient) => Promise<T>): Promise<T>;
  healthCheck(): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

export function createDatabase(config: AppConfig, logger: Logger): Database {
  const poolConfig: PoolConfig = {
    connectionString: config.databaseUrl,
    max: config.databasePoolSize,
    application_name: 'solana-copy-trade'
  };
  const pool = new Pool(poolConfig);
  pool.on('error', (error) => logger.error('Unexpected database pool error', { error: error.message }));

  return {
    async query(text: string, values?: readonly unknown[]): Promise<unknown> {
      return pool.query(text, values as unknown[] | undefined);
    },
    async transaction<T>(callback: (client: DatabaseClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback({ query: (text, values) => client.query(text, values as unknown[] | undefined) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async healthCheck(): Promise<void> {
      await pool.query('SELECT 1');
    },
    async close(): Promise<void> {
      await pool.end();
    }
  };
}
