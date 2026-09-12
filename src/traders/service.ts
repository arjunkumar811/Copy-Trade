import { AppError } from '../api/errors.js';
import { isValidSolanaAddress } from '../auth/crypto.js';
import type { CopyTradeSettings, FollowedTraderService, FollowedTraderStore } from './types.js';

const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decimal(value: unknown, field: string, allowZero = false): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !decimalPattern.test(value) || (!allowZero && Number(value) <= 0)) {
    throw new AppError(400, 'INVALID_SETTINGS', `${field} must be a positive decimal string`);
  }
  return value;
}

function tokens(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((token) => typeof token !== 'string' || !isValidSolanaAddress(token))) {
    throw new AppError(400, 'INVALID_SETTINGS', `${field} must contain valid Solana token addresses`);
  }
  return [...new Set(value)];
}

function settings(input: unknown): CopyTradeSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'INVALID_SETTINGS', 'Settings must be an object');
  const value = input as Record<string, unknown>;
  const fixedAmount = decimal(value.fixedAmount, 'fixedAmount');
  const balancePercentage = decimal(value.balancePercentage, 'balancePercentage');
  if (fixedAmount && balancePercentage) throw new AppError(400, 'INVALID_SETTINGS', 'Choose fixedAmount or balancePercentage, not both');
  const maxTradeAmount = decimal(value.maxTradeAmount, 'maxTradeAmount');
  const maxDailyLoss = decimal(value.maxDailyLoss, 'maxDailyLoss', true);
  const maxSlippageBps = value.maxSlippageBps ?? 100;
  if (typeof maxSlippageBps !== 'number' || !Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 10_000) {
    throw new AppError(400, 'INVALID_SETTINGS', 'maxSlippageBps must be an integer from 0 to 10000');
  }
  const allowedTokens = tokens(value.allowedTokens, 'allowedTokens');
  const blockedTokens = tokens(value.blockedTokens, 'blockedTokens');
  if (allowedTokens.some((token) => blockedTokens.includes(token))) {
    throw new AppError(400, 'INVALID_SETTINGS', 'A token cannot be both allowed and blocked');
  }
  if (typeof value.enabled !== 'boolean') throw new AppError(400, 'INVALID_SETTINGS', 'enabled must be boolean');
  return { enabled: value.enabled, fixedAmount, balancePercentage, maxTradeAmount, maxDailyLoss, maxSlippageBps, allowedTokens, blockedTokens };
}

function requireId(value: string): void {
  if (!idPattern.test(value)) throw new AppError(400, 'INVALID_ID', 'A valid followed trader ID is required');
}

export function createFollowedTraderService(store: FollowedTraderStore): FollowedTraderService {
  return {
    async follow(userId, traderWalletAddress) {
      if (!isValidSolanaAddress(traderWalletAddress)) throw new AppError(400, 'INVALID_WALLET_ADDRESS', 'A valid Solana trader wallet is required');
      return store.follow(userId, traderWalletAddress);
    },
    async list(userId) {
      return store.list(userId);
    },
    async remove(userId, followedTraderId) {
      requireId(followedTraderId);
      if (!await store.remove(userId, followedTraderId)) throw new AppError(404, 'FOLLOWED_TRADER_NOT_FOUND', 'Followed trader not found');
    },
    async updateSettings(userId, followedTraderId, input) {
      requireId(followedTraderId);
      const result = await store.updateSettings(userId, followedTraderId, settings(input));
      if (!result) throw new AppError(404, 'FOLLOWED_TRADER_NOT_FOUND', 'Followed trader not found');
      return result;
    }
  };
}
