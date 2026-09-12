import { createServer } from 'node:http';
import { loadConfig } from './config/env.js';
import { createApp } from './api/app.js';
import { createDatabase } from './db/pool.js';
import { createLogger } from './infrastructure/logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const database = createDatabase(config, logger);
const app = createApp({ database, logger });
const server = createServer((request, response) => {
  void app(request, response);
});

server.listen(config.port, () => logger.info('API server started', { port: config.port, environment: config.nodeEnv }));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutdown started', { signal });
  server.close(async (error) => {
    if (error) logger.error('HTTP server close failed', { error: error.message });
    await database.close();
    process.exitCode = error ? 1 : 0;
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
