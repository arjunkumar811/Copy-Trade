import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import bs58 from 'bs58';
import test from 'node:test';
import { createApp } from '../src/api/app.js';
import { createFollowedTraderService } from '../src/traders/service.js';
import type { CopyTradeSettings, FollowedTrader, FollowedTraderStore } from '../src/traders/types.js';
import type { AuthService } from '../src/auth/types.js';
import { createLogger } from '../src/infrastructure/logger.js';

const traderAddress = bs58.encode(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const secondTraderAddress = bs58.encode(Uint8Array.from({ length: 32 }, (_, index) => index + 33));
const settings: CopyTradeSettings = {
  enabled: true,
  fixedAmount: '1.25',
  balancePercentage: null,
  maxTradeAmount: '5',
  maxDailyLoss: '10',
  maxSlippageBps: 100,
  allowedTokens: [],
  blockedTokens: []
};

function trader(id: string, address: string): FollowedTrader {
  return { id, traderWalletAddress: address, status: 'active', settings, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

class MemoryTraderStore implements FollowedTraderStore {
  public records = new Map<string, FollowedTrader>();

  async follow(userId: string, address: string) {
    void userId;
    const result = trader('11111111-1111-4111-8111-111111111111', address);
    this.records.set(result.id, result);
    return result;
  }
  async list(userId: string) { void userId; return [...this.records.values()]; }
  async remove(_userId: string, id: string) { return this.records.delete(id); }
  async updateSettings(_userId: string, id: string, next: CopyTradeSettings) {
    const current = this.records.get(id);
    if (!current) return null;
    const result = { ...current, settings: next };
    this.records.set(id, result);
    return result;
  }
}

const auth: AuthService = {
  async createChallenge() { throw new Error('not used'); },
  async verifyChallenge() { throw new Error('not used'); },
  async authenticate(token) { return token === 'valid-token' ? { userId: 'user-1', walletAddress: traderAddress } : null; }
};

test('follows a valid trader and rejects an invalid address', async () => {
  const store = new MemoryTraderStore();
  const service = createFollowedTraderService(store);
  const result = await service.follow('user-1', traderAddress);
  assert.equal(result.traderWalletAddress, traderAddress);
  await assert.rejects(service.follow('user-1', 'not-a-wallet'), /valid Solana trader wallet/);
});

test('validates settings without using floating-point financial values', async () => {
  const service = createFollowedTraderService(new MemoryTraderStore());
  await assert.rejects(service.updateSettings('user-1', '11111111-1111-4111-8111-111111111111', { enabled: true, fixedAmount: '1.2', balancePercentage: '10', maxSlippageBps: 100 }), /Choose fixedAmount or balancePercentage/);
  await assert.rejects(service.updateSettings('user-1', '11111111-1111-4111-8111-111111111111', { enabled: true, fixedAmount: '-1', maxSlippageBps: 100 }), /positive decimal string/);
  await assert.rejects(service.updateSettings('user-1', '11111111-1111-4111-8111-111111111111', { enabled: true, maxSlippageBps: 100, allowedTokens: [traderAddress], blockedTokens: [traderAddress] }), /both allowed and blocked/);
});

test('does not allow modifying an unknown or unauthorized followed trader', async () => {
  const service = createFollowedTraderService(new MemoryTraderStore());
  await assert.rejects(service.remove('different-user', '11111111-1111-4111-8111-111111111111'), /Followed trader not found/);
  await assert.rejects(service.updateSettings('different-user', '11111111-1111-4111-8111-111111111111', settings), /Followed trader not found/);
});

test('lists and creates followed traders through authenticated API routes', async () => {
  const store = new MemoryTraderStore();
  const app = createApp({
    database: { healthCheck: async () => undefined },
    logger: createLogger('error', () => undefined),
    auth,
    traders: createFollowedTraderService(store),
    requestId: () => 'trader-test-request'
  });
  const server = createServer((request, response) => void app(request, response));
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const createResponse = await fetch(`${baseUrl}/followed-traders`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
    body: JSON.stringify({ traderWalletAddress: secondTraderAddress })
  });
  assert.equal(createResponse.status, 201);
  const listResponse = await fetch(`${baseUrl}/followed-traders`, { headers: { authorization: 'Bearer valid-token' } });
  const body = await listResponse.json() as { traders: FollowedTrader[] };
  assert.equal(listResponse.status, 200);
  assert.equal(body.traders.length, 1);
  assert.equal(body.traders[0]?.traderWalletAddress, secondTraderAddress);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
