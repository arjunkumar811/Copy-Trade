import type { BlockchainTransactionEvent, TransactionEventQueue } from '../blockchain/types.js';
import { JOB_TYPES, type JobQueue } from './types.js';

export function createSourceTransactionQueue(queue: JobQueue): TransactionEventQueue {
  return {
    async enqueue(event: BlockchainTransactionEvent): Promise<void> {
      await queue.enqueue(
        JOB_TYPES.SOURCE_TRANSACTION_PROCESSING,
        `source-transaction:${event.sourceWalletAddress}:${event.signature}`,
        event
      );
    }
  };
}
