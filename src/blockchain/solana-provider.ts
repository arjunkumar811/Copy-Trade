import { Connection, PublicKey, type Commitment } from '@solana/web3.js';
import type { Logger } from '../infrastructure/logger.js';
import type { SolanaProvider, SolanaSubscription, TransactionHandler, ProviderErrorHandler } from './types.js';

export interface SolanaProviderOptions {
  commitment?: Commitment;
}

export function createSolanaProvider(rpcUrl: string, wsUrl: string, logger: Logger, options: SolanaProviderOptions = {}): SolanaProvider {
  const connection = new Connection(rpcUrl, { commitment: options.commitment ?? 'confirmed', wsEndpoint: wsUrl });
  const subscriptionIds = new Set<number>();

  return {
    async subscribe(address: string, onTransaction: TransactionHandler, onError: ProviderErrorHandler): Promise<SolanaSubscription> {
      const publicKey = new PublicKey(address);
      const id = connection.onLogs(publicKey, (logs) => {
        if (logs.err) return;
        void connection.getParsedTransaction(logs.signature, { maxSupportedTransactionVersion: 0 })
          .then((transaction) => {
            if (!transaction) return;
            return onTransaction({
              sourceWalletAddress: address,
              signature: logs.signature,
              slot: transaction.slot,
              blockTime: transaction.blockTime == null ? null : new Date(transaction.blockTime * 1000),
              rawData: transaction
            });
          })
          .catch(onError);
      });
      subscriptionIds.add(id);
      logger.info('Created Solana logs subscription', { sourceWallet: address, subscriptionId: id });
      return {
        async unsubscribe(): Promise<void> {
          if (!subscriptionIds.delete(id)) return;
          await connection.removeOnLogsListener(id);
        }
      };
    },
    async close(): Promise<void> {
      await Promise.all([...subscriptionIds].map((id) => connection.removeOnLogsListener(id)));
      subscriptionIds.clear();
    }
  };
}
