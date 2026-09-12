import { Pool, type PoolConfig } from 'pg';
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../infrastructure/logger.js';

export interface Database {
  query(text: string): Promise<unknown>;
  healthCheck(): Promise<void>;
  close(): Promise<void>;
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
    async query(text: string): Promise<unknown> {
      return pool.query(text);
    },
    async healthCheck(): Promise<void> {
      await pool.query('SELECT 1');
    },
    async close(): Promise<void> {
      await pool.end();
    }
  };
}
