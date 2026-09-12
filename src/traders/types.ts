export interface CopyTradeSettings {
  enabled: boolean;
  fixedAmount: string | null;
  balancePercentage: string | null;
  maxTradeAmount: string | null;
  maxDailyLoss: string | null;
  maxSlippageBps: number;
  allowedTokens: string[];
  blockedTokens: string[];
}

export interface FollowedTrader {
  id: string;
  traderWalletAddress: string;
  status: 'active' | 'paused' | 'unfollowed';
  settings: CopyTradeSettings;
  createdAt: string;
  updatedAt: string;
}

export interface FollowedTraderStore {
  follow(userId: string, traderWalletAddress: string): Promise<FollowedTrader>;
  list(userId: string): Promise<FollowedTrader[]>;
  remove(userId: string, followedTraderId: string): Promise<boolean>;
  updateSettings(userId: string, followedTraderId: string, settings: CopyTradeSettings): Promise<FollowedTrader | null>;
}

export interface FollowedTraderService {
  follow(userId: string, traderWalletAddress: string): Promise<FollowedTrader>;
  list(userId: string): Promise<FollowedTrader[]>;
  remove(userId: string, followedTraderId: string): Promise<void>;
  updateSettings(userId: string, followedTraderId: string, input: unknown): Promise<FollowedTrader>;
}
