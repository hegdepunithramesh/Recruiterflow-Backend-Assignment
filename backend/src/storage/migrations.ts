import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { StorageError, writerTransaction, type DatabaseName } from './support.js';

export interface Migration { version: number; checksum: string; sql: string }
export interface AppliedMigration { version: number; checksum: string }
const directory = new URL('../../sql/migrations/', import.meta.url);

export async function readMigrations(): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    if (!/^[0-9]{3}_[a-z_]+\.sql$/.test(file)) throw new StorageError('MIGRATION_FILES', 'Invalid migration filename.');
    const sql = await readFile(new URL(file, directory), 'utf8');
    migrations.push({ version: Number(file.slice(0, 3)), checksum: createHash('sha256').update(sql).digest('hex'), sql });
  }
  if (!migrations.length || migrations.some((m, i) => m.version !== i + 1 || !m.sql.trim())) {
    throw new StorageError('MIGRATION_FILES', 'Migration versions must be nonempty, unique and consecutive from one.');
  }
  return migrations;
}

export function assertHistory(applied: AppliedMigration[], migrations: Migration[], complete = false) {
  if (applied.some((row, index) => row.version !== migrations[index]?.version || row.checksum !== migrations[index]?.checksum) ||
    (complete && applied.length !== migrations.length)) {
    throw new StorageError('MIGRATION_HISTORY', 'Migration history differs from local files or required migrations are missing. Do not edit applied migrations.');
  }
}

export async function requireMigrations(client: PoolClient, migrations: Migration[]) {
  const exists = await client.query<{ ledger: string | null }>("SELECT to_regclass('public.schema_migrations')::text AS ledger");
  if (!exists.rows[0]?.ledger) throw new StorageError('MIGRATION_REQUIRED', 'Run db:migrate before seeding or verifying.');
  const applied = await client.query<AppliedMigration>('SELECT version, checksum FROM public.schema_migrations ORDER BY version');
  assertHistory(applied.rows, migrations, true);
}

export async function migrate(pool: Pool, database: DatabaseName, supplied?: Migration[]) {
  const migrations = supplied ?? await readMigrations();
  return writerTransaction(pool, database, async (client) => {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await client.query('REVOKE ALL ON TABLE public.schema_migrations FROM PUBLIC, recruiter_bot_app');
    const applied = await client.query<AppliedMigration>('SELECT version, checksum FROM public.schema_migrations ORDER BY version');
    assertHistory(applied.rows, migrations);
    const pending = migrations.slice(applied.rows.length);
    for (const migration of pending) {
      await client.query(migration.sql);
      await client.query('INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)',
        [migration.version, migration.checksum]);
    }
    return { applied: pending.map((m) => m.version), alreadyApplied: applied.rows.length };
  });
}
