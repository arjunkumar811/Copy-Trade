import type { Logger } from '../infrastructure/logger.js';
import { isValidSolanaAddress } from '../auth/crypto.js';
import type {
  BlockchainTransactionEvent,
  IngestionListener,
  SolanaProvider,
  SolanaSubscription,
  SourceTransactionStore,
  TransactionEventQueue,
  WatchedWalletStore
} from './types.js';

export interface IngestionOptions {
  maxConcurrentEvents?: number;
  maxConcurrentSubscriptions?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
}

function rateLimitDelay(error: unknown, fallback: number): number {
  if (typeof error === 'object' && error !== null && 'retryAfterMs' in error && typeof error.retryAfterMs === 'number') {
    return Math.max(fallback, error.retryAfterMs);
  }
  return fallback;
}

function isValidEvent(event: BlockchainTransactionEvent, expectedAddress: string): boolean {
  return event.sourceWalletAddress === expectedAddress &&
    isValidSolanaAddress(event.sourceWalletAddress) &&
    typeof event.signature === 'string' && event.signature.length > 0 && event.signature.length <= 128 &&
    (event.slot === null || (Number.isSafeInteger(event.slot) && event.slot >= 0)) &&
    (event.blockTime === null || !Number.isNaN(event.blockTime.getTime())) &&
    typeof event.rawData === 'object' && event.rawData !== null;
}

class ConcurrencyLimiter {
  private active = 0;
  private readonly pending: Array<() => void> = [];
  private readonly running = new Set<Promise<void>>();
  private readonly idleWaiters: Array<() => void> = [];

  public constructor(private readonly limit: number) {}

  public run(task: () => Promise<void>): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.pending.push(() => {
        this.active += 1;
        const running = task().then(resolve, reject).finally(() => {
          this.active -= 1;
          this.running.delete(running);
          this.drain();
        });
        this.running.add(running);
      });
      this.drain();
    });
    return promise;
  }

  public async waitForIdle(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private drain(): void {
    while (this.active < this.limit && this.pending.length > 0) this.pending.shift()?.();
    if (this.active === 0 && this.pending.length === 0) {
      while (this.idleWaiters.length > 0) this.idleWaiters.shift()?.();
    }
  }
}

export function createIngestionListener(
  provider: SolanaProvider,
  watchedWallets: WatchedWalletStore,
  sourceTransactions: SourceTransactionStore,
  queue: TransactionEventQueue,
  logger: Logger,
  options: IngestionOptions = {}
): IngestionListener {
  const maxEvents = options.maxConcurrentEvents ?? 10;
  const maxSubscriptions = options.maxConcurrentSubscriptions ?? 10;
  const baseDelay = options.reconnectBaseDelayMs ?? 250;
  const maxDelay = options.reconnectMaxDelayMs ?? 30_000;
  const setTimeoutFn = options.setTimeoutFn ?? ((callback, delay) => setTimeout(callback, delay));
  const eventLimiter = new ConcurrencyLimiter(maxEvents);
  const subscriptions = new Map<string, SolanaSubscription>();
  const retries = new Map<string, number>();
  const timers = new Map<string, NodeJS.Timeout>();
  let stopped = true;

  const processEvent = async (address: string, event: BlockchainTransactionEvent): Promise<void> => {
    if (!isValidEvent(event, address)) {
      logger.warn('Ignoring malformed blockchain event', { sourceWallet: address, signature: event.signature });
      return;
    }
    const inserted = await sourceTransactions.persist(event);
    if (inserted) await queue.enqueue(event);
  };

  const subscribe = async (address: string): Promise<void> => {
    if (stopped || subscriptions.has(address)) return;
    try {
      const subscription = await provider.subscribe(
        address,
        async (event) => {
          const task = eventLimiter.run(() => processEvent(address, event));
          task.catch((error: unknown) => logger.error('Blockchain event processing failed', { sourceWallet: address, error: error instanceof Error ? error.message : 'unknown' }));
          await task;
        },
        (error) => {
          subscriptions.delete(address);
          scheduleReconnect(address, error);
        }
      );
      if (stopped) {
        await subscription.unsubscribe();
        return;
      }
      subscriptions.set(address, subscription);
      retries.set(address, 0);
      logger.info('Subscribed to trader wallet', { sourceWallet: address });
    } catch (error) {
      scheduleReconnect(address, error);
    }
  };

  const scheduleReconnect = (address: string, error: unknown): void => {
    if (stopped || timers.has(address)) return;
    const attempt = (retries.get(address) ?? 0) + 1;
    retries.set(address, attempt);
    const exponential = Math.min(maxDelay, baseDelay * (2 ** Math.min(attempt - 1, 10)));
    const delay = Math.min(maxDelay, rateLimitDelay(error, exponential));
    logger.warn('Scheduling blockchain subscription reconnect', { sourceWallet: address, attempt, delayMs: delay });
    const timer = setTimeoutFn(() => {
      timers.delete(address);
      void subscribe(address);
    }, delay);
    if ('unref' in timer) timer.unref();
    timers.set(address, timer);
  };

  return {
    async start(): Promise<void> {
      if (!stopped) return;
      stopped = false;
      const addresses = [...new Set(await watchedWallets.listWatchedWalletAddresses())].filter(isValidSolanaAddress);
      const limiter = new ConcurrencyLimiter(maxSubscriptions);
      await Promise.all(addresses.map((address) => limiter.run(() => subscribe(address))));
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.all([...subscriptions.values()].map((subscription) => subscription.unsubscribe()));
      subscriptions.clear();
      await eventLimiter.waitForIdle();
      await provider.close();
      logger.info('Blockchain ingestion stopped');
    }
  };
}
