/**
 * Migration runner. Numbered .sql files, applied in order, each in its own transaction,
 * recorded in schema_migrations so re-running is a no-op.
 *
 * No ORM and no migration framework: the schema IS the specification of the guarantees
 * in Phase 2, and it should be readable as plain SQL by anyone reviewing the project.
 *
 *   node src/db/migrate.ts          apply pending migrations
 *   node src/db/migrate.ts --reset  drop and recreate the public schema, then apply
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../config.ts';
import { getPool, closePool, withTransaction } from './pool.ts';

loadEnv();

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function resetSchema(): Promise<void> {
  await getPool().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

export async function migrate(opts: { quiet?: boolean } = {}): Promise<string[]> {
  const log = (msg: string) => {
    if (opts.quiet !== true) console.log(msg);
  };

  await ensureMigrationsTable();

  const applied = new Set(
    (await getPool().query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
      (r) => r.filename,
    ),
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    });
    ran.push(file);
    log(`applied ${file}`);
  }

  if (ran.length === 0) log('no pending migrations');
  return ran;
}

if (import.meta.filename === process.argv[1]) {
  const reset = process.argv.includes('--reset');
  try {
    if (reset) {
      await resetSchema();
      console.log('schema reset');
    }
    await migrate();
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
