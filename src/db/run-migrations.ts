import { loadConfig } from '../config/env.js';
import { createDatabase } from './pool.js';
import { runMigrations } from './migrations.js';
import { createLogger } from '../infrastructure/logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const database = createDatabase(config, logger);

try {
  await runMigrations(database);
  logger.info('Database migrations completed');
} finally {
  await database.close();
}
