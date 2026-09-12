export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  databaseUrl: string;
  databasePoolSize: number;
  sessionSecret: string;
  authChallengeTtlSeconds: number;
  sessionTtlSeconds: number;
  solanaRpcUrl: string;
  solanaWsUrl: string;
}

export class ConfigurationError extends Error {
  public readonly issues: string[];

  public constructor(issues: string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

function requiredString(env: NodeJS.ProcessEnv, name: string, issues: string[]): string {
  const value = env[name]?.trim();
  if (!value) {
    issues.push(`${name} is required`);
    return '';
  }
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, issues: string[]): number {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    issues.push(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const issues: string[] = [];
  const nodeEnv = env.NODE_ENV ?? 'development';
  const logLevel = env.LOG_LEVEL ?? 'info';

  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    issues.push('NODE_ENV must be development, test, or production');
  }
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    issues.push('LOG_LEVEL must be debug, info, warn, or error');
  }

  const databaseUrl = requiredString(env, 'DATABASE_URL', issues);
  const sessionSecret = requiredString(env, 'SESSION_SECRET', issues);
  if (nodeEnv === 'production' && sessionSecret.length < 32) {
    issues.push('SESSION_SECRET must be at least 32 characters in production');
  }

  const port = integer(env, 'PORT', 3000, issues);
  const databasePoolSize = integer(env, 'DATABASE_POOL_SIZE', 10, issues);
  const authChallengeTtlSeconds = integer(env, 'AUTH_CHALLENGE_TTL_SECONDS', 300, issues);
  const sessionTtlSeconds = integer(env, 'SESSION_TTL_SECONDS', 86_400, issues);
  const solanaRpcUrl = requiredString(env, 'SOLANA_RPC_URL', issues);
  const solanaWsUrl = requiredString(env, 'SOLANA_WS_URL', issues);

  if (issues.length > 0) {
    throw new ConfigurationError(issues);
  }

  return {
    nodeEnv: nodeEnv as AppConfig['nodeEnv'],
    port,
    logLevel: logLevel as AppConfig['logLevel'],
    databaseUrl,
    databasePoolSize,
    sessionSecret,
    authChallengeTtlSeconds,
    sessionTtlSeconds,
    solanaRpcUrl,
    solanaWsUrl
  };
}
