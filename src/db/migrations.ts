import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from './pool.js';

interface AppliedMigration {
  name: string;
}

interface QueryResult<T> {
  rows: T[];
}

export async function runMigrations(database: Database, migrationsDirectory = path.resolve(process.cwd(), 'db/migrations')): Promise<void> {
  await database.query("SELECT pg_advisory_lock(hashtext('solana-copy-trade:migrations'))");
  try {
    const files = (await readdir(migrationsDirectory))
      .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
      .sort();

    await database.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name varchar(255) PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const result = await database.query('SELECT name FROM schema_migrations ORDER BY name') as QueryResult<AppliedMigration>;
    const applied = new Set(result.rows.map((migration) => migration.name));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(migrationsDirectory, file), 'utf8');
      await database.transaction(async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
    }
  } finally {
    await database.query("SELECT pg_advisory_unlock(hashtext('solana-copy-trade:migrations'))");
  }
}
