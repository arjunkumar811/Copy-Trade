import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { getPublicKeyAsync, signAsync } from '@noble/ed25519';
import bs58 from 'bs58';
import test from 'node:test';
import { createApp } from '../src/api/app.js';
import { createAuthService } from '../src/auth/service.js';
import { createSolanaSignatureVerifier } from '../src/auth/crypto.js';
import type { AuthChallenge, AuthenticatedUser, AuthStore } from '../src/auth/types.js';
import type { AppConfig } from '../src/config/env.js';
import { createLogger } from '../src/infrastructure/logger.js';

const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const otherPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const config: AppConfig = {
  nodeEnv: 'test',
  port: 3000,
  logLevel: 'error',
  databaseUrl: 'postgresql://test',
  databasePoolSize: 1,
  sessionSecret: 'test-secret',
  authChallengeTtlSeconds: 300,
  sessionTtlSeconds: 3600
};

class MemoryAuthStore implements AuthStore {
  public challenges = new Map<string, AuthChallenge & { nonce: string; consumedAt: Date | null }>();
  public sessions = new Map<string, AuthenticatedUser>();

  async saveChallenge(challenge: AuthChallenge, nonce: string): Promise<void> {
    this.challenges.set(challenge.id, { ...challenge, nonce, consumedAt: null });
  }

  async getChallenge(id: string) {
    return this.challenges.get(id) ?? null;
  }

  async completeChallenge(challengeId: string, walletAddress: string, tokenHash: string): Promise<string | null> {
    const challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.consumedAt || challenge.expiresAt.getTime() <= Date.now() || challenge.walletAddress !== walletAddress) return null;
    challenge.consumedAt = new Date();
    this.sessions.set(tokenHash, { userId: 'user-1', walletAddress });
    return 'user-1';
  }

  async findSession(tokenHash: string): Promise<AuthenticatedUser | null> {
    return this.sessions.get(tokenHash) ?? null;
  }
}

async function createFixture() {
  const walletAddress = bs58.encode(await getPublicKeyAsync(privateKey));
  const otherWalletAddress = bs58.encode(await getPublicKeyAsync(otherPrivateKey));
  const store = new MemoryAuthStore();
  const service = createAuthService(config, store, createSolanaSignatureVerifier());
  return { walletAddress, otherWalletAddress, store, service };
}

async function signChallenge(message: string) {
  return bs58.encode(await signAsync(new TextEncoder().encode(message), privateKey));
}

test('accepts a valid wallet signature and creates a session', async () => {
  const fixture = await createFixture();
  const challenge = await fixture.service.createChallenge(fixture.walletAddress);
  const result = await fixture.service.verifyChallenge({
    challengeId: challenge.challengeId,
    walletAddress: fixture.walletAddress,
    signature: await signChallenge(challenge.message)
  });
  assert.equal(result.userId, 'user-1');
  assert.ok(result.token.length > 20);
  assert.deepEqual(await fixture.service.authenticate(result.token), { userId: 'user-1', walletAddress: fixture.walletAddress });
});

test('rejects an invalid signature', async () => {
  const fixture = await createFixture();
  const challenge = await fixture.service.createChallenge(fixture.walletAddress);
  await assert.rejects(
    fixture.service.verifyChallenge({ challengeId: challenge.challengeId, walletAddress: fixture.walletAddress, signature: bs58.encode(new Uint8Array(64)) }),
    /Wallet signature is invalid/
  );
});

test('rejects expired challenges', async () => {
  const fixture = await createFixture();
  const challenge = await fixture.service.createChallenge(fixture.walletAddress);
  const stored = fixture.store.challenges.get(challenge.challengeId);
  assert.ok(stored);
  stored.expiresAt = new Date(Date.now() - 1);
  await assert.rejects(
    fixture.service.verifyChallenge({ challengeId: challenge.challengeId, walletAddress: fixture.walletAddress, signature: await signChallenge(challenge.message) }),
    /Challenge has expired/
  );
});

test('rejects a reused challenge', async () => {
  const fixture = await createFixture();
  const challenge = await fixture.service.createChallenge(fixture.walletAddress);
  const input = { challengeId: challenge.challengeId, walletAddress: fixture.walletAddress, signature: await signChallenge(challenge.message) };
  await fixture.service.verifyChallenge(input);
  await assert.rejects(fixture.service.verifyChallenge(input), /Challenge has already been used/);
});

test('rejects a signature submitted for the wrong wallet', async () => {
  const fixture = await createFixture();
  const challenge = await fixture.service.createChallenge(fixture.walletAddress);
  await assert.rejects(
    fixture.service.verifyChallenge({ challengeId: challenge.challengeId, walletAddress: fixture.otherWalletAddress, signature: await signChallenge(challenge.message) }),
    /Challenge is invalid/
  );
});

test('rejects malformed authentication input', async () => {
  const fixture = await createFixture();
  await assert.rejects(
    fixture.service.verifyChallenge({ challengeId: '', walletAddress: fixture.walletAddress, signature: '' }),
    /challengeId is required/
  );
});

test('returns unauthorized for a protected endpoint without a token', async () => {
  const fixture = await createFixture();
  const app = createApp({
    database: { healthCheck: async () => undefined },
    logger: createLogger('error', () => undefined),
    auth: fixture.service,
    requestId: () => 'auth-test-request'
  });
  const server = createServer((request, response) => void app(request, response));
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/auth/me`);
  const body = await response.json() as { error: { code: string; requestId: string } };
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
  assert.equal(body.error.requestId, 'auth-test-request');
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
