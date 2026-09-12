import { verifyAsync } from '@noble/ed25519';
import bs58 from 'bs58';

export function isValidSolanaAddress(address: string): boolean {
  try {
    const bytes = bs58.decode(address);
    return bytes.length === 32 && bs58.encode(bytes) === address;
  } catch {
    return false;
  }
}

export interface SignatureVerifier {
  verify(signature: string, message: string, walletAddress: string): Promise<boolean>;
}

export function createSolanaSignatureVerifier(): SignatureVerifier {
  return {
    async verify(signature: string, message: string, walletAddress: string): Promise<boolean> {
      try {
        const signatureBytes = bs58.decode(signature);
        const publicKeyBytes = bs58.decode(walletAddress);
        if (signatureBytes.length !== 64 || publicKeyBytes.length !== 32) return false;
        return await verifyAsync(signatureBytes, new TextEncoder().encode(message), publicKeyBytes);
      } catch {
        return false;
      }
    }
  };
}
