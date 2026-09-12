import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../api/errors.js';
import type { AppConfig } from '../config/env.js';
import { isValidSolanaAddress, type SignatureVerifier } from './crypto.js';
import type { AuthService, AuthStore } from './types.js';

function requireAddress(address: string): void {
  if (!isValidSolanaAddress(address)) {
    throw new AppError(400, 'INVALID_WALLET_ADDRESS', 'A valid Solana wallet address is required');
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    throw new AppError(400, 'INVALID_REQUEST', `${field} is required`);
  }
  return value;
}

export function createAuthService(config: AppConfig, store: AuthStore, verifier: SignatureVerifier): AuthService {
  const tokenHash = (token: string): string => createHmac('sha256', config.sessionSecret).update(token).digest('hex');

  return {
    async createChallenge(walletAddress: string) {
      requireAddress(walletAddress);
      const now = Date.now();
      const expiresAt = new Date(now + config.authChallengeTtlSeconds * 1000);
      const nonce = randomBytes(32).toString('base64url');
      const challengeId = randomUUID();
      const message = [
        'Solana Copy Trade wants you to sign in.',
        '',
        `Wallet: ${walletAddress}`,
        `Nonce: ${nonce}`,
        `Issued At: ${new Date(now).toISOString()}`,
        `Expiration Time: ${expiresAt.toISOString()}`
      ].join('\n');
      await store.saveChallenge({ id: challengeId, walletAddress, message, expiresAt }, nonce);
      return { challengeId, message, expiresAt: expiresAt.toISOString() };
    },
    async verifyChallenge(input) {
      const challengeId = requireText(input.challengeId, 'challengeId');
      const walletAddress = requireText(input.walletAddress, 'walletAddress');
      const signature = requireText(input.signature, 'signature');
      requireAddress(walletAddress);

      const challenge = await store.getChallenge(challengeId);
      if (!challenge || challenge.walletAddress !== walletAddress) {
        throw new AppError(401, 'INVALID_CHALLENGE', 'Challenge is invalid');
      }
      if (challenge.consumedAt) {
        throw new AppError(401, 'CHALLENGE_REUSED', 'Challenge has already been used');
      }
      if (challenge.expiresAt.getTime() <= Date.now()) {
        throw new AppError(401, 'CHALLENGE_EXPIRED', 'Challenge has expired');
      }
      if (!(await verifier.verify(signature, challenge.message, walletAddress))) {
        throw new AppError(401, 'INVALID_SIGNATURE', 'Wallet signature is invalid');
      }

      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);
      const userId = await store.completeChallenge(challengeId, walletAddress, tokenHash(token), expiresAt);
      if (!userId) {
        throw new AppError(401, 'CHALLENGE_REUSED', 'Challenge has already been used or expired');
      }
      return { token, expiresAt: expiresAt.toISOString(), userId, walletAddress };
    },
    async authenticate(token: string) {
      if (!token || token.length > 512) return null;
      return store.findSession(tokenHash(token));
    }
  };
}
