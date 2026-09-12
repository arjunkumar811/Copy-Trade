export interface BlockchainTransactionEvent {
  sourceWalletAddress: string;
  signature: string;
  slot: number | null;
  blockTime: Date | null;
  rawData: unknown;
}

export interface SolanaSubscription {
  unsubscribe(): Promise<void>;
}

export type TransactionHandler = (event: BlockchainTransactionEvent) => Promise<void>;
export type ProviderErrorHandler = (error: unknown) => void;

export interface SolanaProvider {
  subscribe(address: string, onTransaction: TransactionHandler, onError: ProviderErrorHandler): Promise<SolanaSubscription>;
  close(): Promise<void>;
}

export interface SourceTransactionStore {
  persist(event: BlockchainTransactionEvent): Promise<boolean>;
}

export interface TransactionEventQueue {
  enqueue(event: BlockchainTransactionEvent): Promise<void>;
}

export interface WatchedWalletStore {
  listWatchedWalletAddresses(): Promise<string[]>;
}

export interface IngestionListener {
  start(): Promise<void>;
  stop(): Promise<void>;
}
