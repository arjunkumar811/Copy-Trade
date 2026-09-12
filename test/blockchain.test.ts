import assert from 'node:assert/strict';
import bs58 from 'bs58';
import test from 'node:test';
import { createIngestionListener } from '../src/blockchain/listener.js';
import type { BlockchainTransactionEvent, SolanaProvider, SolanaSubscription, SourceTransactionStore, TransactionEventQueue, WatchedWalletStore } from '../src/blockchain/types.js';
import { createLogger } from '../src/infrastructure/logger.js';

const walletAddress = bs58.encode(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const event = (signature: string): BlockchainTransactionEvent => ({
  sourceWalletAddress: walletAddress,
  signature,
  slot: 42,
  blockTime: new Date(),
  rawData: { signature }
});

class FakeProvider implements SolanaProvider {
  public attempts = 0;
  public closed = false;
  public unsubscribed = false;
  public callback: ((value: BlockchainTransactionEvent) => Promise<void>) | undefined;
  private errorCallback: ((error: unknown) => void) | undefined;

  public constructor(private failures = 0, private readonly errorHandler?: (error: unknown) => void) {}

  async subscribe(_address: string, onTransaction: (value: BlockchainTransactionEvent) => Promise<void>, onError: (error: unknown) => void): Promise<SolanaSubscription> {
    this.attempts += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      const error = this.errorHandler?.({ retryAfterMs: 500 }) ?? { retryAfterMs: 500 };
      onError(error);
      throw error;
    }
    this.callback = onTransaction;
    this.errorCallback = onError;
    return {
      unsubscribe: async () => { this.unsubscribed = true; }
    };
  }

  async close(): Promise<void> { this.closed = true; }

  public emit(value: BlockchainTransactionEvent): void { void this.callback?.(value); }
  public fail(error: unknown): void { this.errorCallback?.(error); }
}

class MemorySourceStore implements SourceTransactionStore {
  public events: BlockchainTransactionEvent[] = [];
  public active = 0;
  public maxActive = 0;
  public delayMs = 0;

  async persist(value: BlockchainTransactionEvent): Promise<boolean> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.active -= 1;
    if (this.events.some((existing) => existing.signature === value.signature)) return false;
    this.events.push(value);
    return true;
  }
}

class MemoryQueue implements TransactionEventQueue {
  public events: BlockchainTransactionEvent[] = [];
  async enqueue(value: BlockchainTransactionEvent): Promise<void> { this.events.push(value); }
}

const watchedWallets: WatchedWalletStore = { listWatchedWalletAddresses: async () => [walletAddress] };
const logger = createLogger('error', () => undefined);
const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function createFixture(provider: SolanaProvider, store = new MemorySourceStore(), queue = new MemoryQueue(), options = {}) {
  const listener = createIngestionListener(provider, watchedWallets, store, queue, logger, options);
  return { listener, store, queue };
}

test('persists and enqueues a new transaction once', async () => {
  const provider = new FakeProvider();
  const fixture = createFixture(provider);
  await fixture.listener.start();
  provider.emit(event('signature-1'));
  await wait();
  assert.equal(fixture.store.events.length, 1);
  assert.equal(fixture.queue.events.length, 1);
  await fixture.listener.stop();
});

test('duplicate transactions are persisted and queued only once', async () => {
  const provider = new FakeProvider();
  const fixture = createFixture(provider);
  await fixture.listener.start();
  provider.emit(event('signature-duplicate'));
  provider.emit(event('signature-duplicate'));
  await wait();
  assert.equal(fixture.store.events.length, 1);
  assert.equal(fixture.queue.events.length, 1);
  await fixture.listener.stop();
});

test('ignores malformed events', async () => {
  const provider = new FakeProvider();
  const fixture = createFixture(provider);
  await fixture.listener.start();
  provider.emit({ ...event('bad'), rawData: null });
  await wait();
  assert.equal(fixture.store.events.length, 0);
  await fixture.listener.stop();
});

test('reconnects after a provider failure', async () => {
  const provider = new FakeProvider(1);
  const fixture = createFixture(provider, new MemorySourceStore(), new MemoryQueue(), { reconnectBaseDelayMs: 1, reconnectMaxDelayMs: 10 });
  await fixture.listener.start();
  await wait(20);
  assert.equal(provider.attempts, 2);
  await fixture.listener.stop();
});

test('honors rate-limit retry delay', async () => {
  const delays: number[] = [];
  const provider = new FakeProvider(1);
  const fixture = createFixture(provider, new MemorySourceStore(), new MemoryQueue(), {
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 1000,
    setTimeoutFn: (callback: () => void, delay: number) => {
      delays.push(delay);
      return setTimeout(callback, 0);
    }
  });
  await fixture.listener.start();
  await wait();
  assert.equal(delays[0], 500);
  await fixture.listener.stop();
});

test('bounds event concurrency and shuts down subscriptions cleanly', async () => {
  const provider = new FakeProvider();
  const store = new MemorySourceStore();
  store.delayMs = 15;
  const fixture = createFixture(provider, store, new MemoryQueue(), { maxConcurrentEvents: 1 });
  await fixture.listener.start();
  provider.emit(event('signature-a'));
  provider.emit(event('signature-b'));
  await fixture.listener.stop();
  assert.equal(store.maxActive, 1);
  assert.equal(store.events.length, 2);
  assert.equal(provider.unsubscribed, true);
  assert.equal(provider.closed, true);
  provider.fail(new Error('after shutdown'));
});
