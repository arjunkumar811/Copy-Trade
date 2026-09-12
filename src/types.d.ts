declare module 'pg' {
  export interface PoolConfig {
    connectionString?: string;
    max?: number;
    application_name?: string;
  }

  export class Pool {
    constructor(config: PoolConfig);
    on(event: string, listener: (error: Error) => void): void;
    query(text: string): Promise<unknown>;
    end(): Promise<void>;
  }
}
