import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config/env.js';
import { createDatabase } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrations.js';
import { createLogger } from '../src/infrastructure/logger.js';

const databaseUrl = process.env.DATABASE_URL;
const databaseTestOptions = databaseUrl ? {} : { skip: 'DATABASE_URL is not configured' };

test('database schema enforces relationships, idempotency, and rollback', databaseTestOptions, async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: 'test-secret'
  });
  const database = createDatabase(config, createLogger('error', () => undefined));

  try {
    await runMigrations(database);
    await database.query('TRUNCATE trade_executions, copy_trade_orders, detected_trades, source_transactions, copy_trade_settings, followed_traders, wallets, audit_logs, users CASCADE');

    const user = await database.query('INSERT INTO users DEFAULT VALUES RETURNING id') as { rows: [{ id: string }] };
    const trader = await database.query('INSERT INTO users DEFAULT VALUES RETURNING id') as { rows: [{ id: string }] };
    const wallet = await database.query(
      'INSERT INTO wallets (user_id, address) VALUES ($1, $2) RETURNING id',
      [trader.rows[0].id, 'TraderWallet111111111111111111111111111111111']
    ) as { rows: [{ id: string }] };
    const followed = await database.query(
      'INSERT INTO followed_traders (follower_user_id, trader_wallet_id) VALUES ($1, $2) RETURNING id',
      [user.rows[0].id, wallet.rows[0].id]
    ) as { rows: [{ id: string }] };

    await assert.rejects(
      database.query(
        'INSERT INTO followed_traders (follower_user_id, trader_wallet_id) VALUES ($1, $2)',
        [user.rows[0].id, wallet.rows[0].id]
      )
    );

    const source = await database.query(
      'INSERT INTO source_transactions (source_wallet_id, signature) VALUES ($1, $2) RETURNING id',
      [wallet.rows[0].id, 'signature-1']
    ) as { rows: [{ id: string }] };
    await assert.rejects(
      database.query(
        'INSERT INTO source_transactions (source_wallet_id, signature) VALUES ($1, $2)',
        [wallet.rows[0].id, 'signature-1']
      )
    );

    const detected = await database.query(
      `INSERT INTO detected_trades (source_transaction_id, input_mint, output_mint, input_amount, output_amount)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [source.rows[0].id, 'So11111111111111111111111111111111111111112', 'Token1111111111111111111111111111111111111', '1.250000000000000000', '25.500000000000000000']
    ) as { rows: [{ id: string }] };
    const orderValues = [user.rows[0].id, followed.rows[0].id, detected.rows[0].id, 'user-source-event-1', '1.250000000000000000', 100];
    await database.query(
      `INSERT INTO copy_trade_orders (user_id, followed_trader_id, detected_trade_id, idempotency_key, amount, slippage_bps)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      orderValues
    );
    await assert.rejects(
      database.query(
        `INSERT INTO copy_trade_orders (user_id, followed_trader_id, detected_trade_id, idempotency_key, amount, slippage_bps)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.rows[0].id, followed.rows[0].id, detected.rows[0].id, 'user-source-event-2', '1.250000000000000000', 100]
      )
    );

    await assert.rejects(
      database.query('INSERT INTO wallets (user_id, address) VALUES ($1, $2)', [user.rows[0].id, 'TraderWallet111111111111111111111111111111111'])
    );

    await assert.rejects(database.transaction(async (client) => {
      await client.query('INSERT INTO users DEFAULT VALUES');
      throw new Error('force rollback');
    }));

    const users = await database.query('SELECT count(*)::int AS count FROM users') as { rows: [{ count: number }] };
    assert.equal(users.rows[0].count, 2);
  } finally {
    await database.close();
  }
});

test('migration SQL uses exact numeric types for token quantities', async () => {
  const sql = await readFile(path.resolve(process.cwd(), 'db/migrations/001_initial.sql'), 'utf8');
  assert.match(sql, /numeric\(38, 18\)/);
  assert.doesNotMatch(sql, /double precision|real|float/i);
});
