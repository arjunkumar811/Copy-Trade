import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../src/api/app.js';
import { ConfigurationError, loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/infrastructure/logger.js';

const validEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/test',
  DATABASE_POOL_SIZE: '5',
  SESSION_SECRET: 'test-secret',
  SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
  SOLANA_WS_URL: 'wss://api.mainnet-beta.solana.com'
};

function createTestServer(healthCheck: () => Promise<void>) {
  const logger = createLogger('error', () => undefined);
  const app = createApp({ database: { healthCheck }, logger, requestId: () => 'test-request-id' });
  return createServer((request, response) => void app(request, response));
}

test('loads valid configuration', () => {
  const config = loadConfig(validEnv);
  assert.equal(config.port, 3000);
  assert.equal(config.databasePoolSize, 5);
});

test('rejects missing required configuration', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test' }), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.match(error.message, /DATABASE_URL is required/);
    assert.match(error.message, /SESSION_SECRET is required/);
    return true;
  });
});

test('health endpoint returns a request ID and does not require the database', async () => {
  const server = createTestServer(async () => { throw new Error('database should not be called'); });
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  const body = await response.json() as { status: string };
  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(response.headers.get('x-request-id'), 'test-request-id');
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('readiness returns a consistent error when the database is unavailable', async () => {
  const server = createTestServer(async () => { throw new Error('database offline'); });
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/ready`);
  const body = await response.json() as { error: { code: string; requestId: string } };
  assert.equal(response.status, 503);
  assert.equal(body.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(body.error.requestId, 'test-request-id');
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('unknown routes return a consistent not found error', async () => {
  const server = createTestServer(async () => undefined);
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/missing`, { headers: { 'x-request-id': 'client-request-id' } });
  const body = await response.json() as { error: { code: string; requestId: string } };
  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.equal(body.error.requestId, 'client-request-id');
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
