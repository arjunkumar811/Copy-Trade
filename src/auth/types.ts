export interface AuthChallenge {
  id: string;
  walletAddress: string;
  message: string;
  expiresAt: Date;
}

export interface AuthenticatedUser {
  userId: string;
  walletAddress: string;
}

export interface AuthStore {
  saveChallenge(challenge: AuthChallenge, nonce: string): Promise<void>;
  getChallenge(id: string): Promise<(AuthChallenge & { nonce: string; consumedAt: Date | null }) | null>;
  completeChallenge(challengeId: string, walletAddress: string, tokenHash: string, expiresAt: Date): Promise<string | null>;
  findSession(tokenHash: string): Promise<AuthenticatedUser | null>;
}

export interface AuthService {
  createChallenge(walletAddress: string): Promise<{ challengeId: string; message: string; expiresAt: string }>;
  verifyChallenge(input: { challengeId: string; walletAddress: string; signature: string }): Promise<{ token: string; expiresAt: string; userId: string; walletAddress: string }>;
  authenticate(token: string): Promise<AuthenticatedUser | null>;
}
