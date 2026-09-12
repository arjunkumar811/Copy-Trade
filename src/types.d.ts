declare module 'pg' {
  export interface PoolConfig {
    connectionString?: string;
    max?: number;
    application_name?: string;
  }

  export class Pool {
    constructor(config: PoolConfig);
    on(event: string, listener: (error: Error) => void): void;
    connect(): Promise<PoolClient>;
    query(text: string, values?: unknown[]): Promise<unknown>;
    end(): Promise<void>;
  }

  export interface PoolClient {
    query(text: string, values?: unknown[]): Promise<unknown>;
    release(): void;
  }
}
