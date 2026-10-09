import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

export type DatabaseName = 'recruiter_bot' | 'recruiter_bot_phase05_test';

export class StorageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export function storageConfig(env: NodeJS.ProcessEnv, test = false) {
  const database: DatabaseName = test ? 'recruiter_bot_phase05_test' : 'recruiter_bot';
  const variable = test ? 'TEST_ADMIN_DATABASE_URL' : 'ADMIN_DATABASE_URL';
  function connection(value: string | undefined, name: string, target: DatabaseName): URL {
    try {
      const url = new URL(value ?? '');
      decodeURIComponent(url.username);
      decodeURIComponent(url.password);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname ||
        !url.username || !url.password || decodeURIComponent(url.pathname) !== `/${target}` ||
        url.search || url.hash || (url.port && (!/^[1-9][0-9]*$/.test(url.port) || Number(url.port) > 65535))) {
        throw new Error();
      }
      return url;
    } catch {
      throw new StorageError('CONFIGURATION', `Set ${name} to a credentialed PostgreSQL URL with the documented database target and no query parameters.`);
    }
  }
  const runtime = connection(env.DATABASE_URL, 'DATABASE_URL', 'recruiter_bot');
  const admin = connection(env[variable], variable, database);
  if (decodeURIComponent(runtime.username) !== 'recruiter_bot_app' ||
    decodeURIComponent(admin.username) === 'recruiter_bot_app') {
    throw new StorageError('CONFIGURATION', 'Keep DATABASE_URL on recruiter_bot_app and use a separate privileged login for offline commands.');
  }
  runtime.pathname = `/${database}`;
  if (runtime.hostname !== admin.hostname || (runtime.port || '5432') !== (admin.port || '5432')) {
    throw new StorageError('CONFIGURATION', 'Privileged and runtime URLs must use the same PostgreSQL instance.');
  }
  return { database, adminUrl: admin.toString(), runtimeUrl: runtime.toString() };
}

export function storagePool(connectionString: string): Pool {
  const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 3000,
    statement_timeout: 10000, query_timeout: 12000, lock_timeout: 5000,
    application_name: 'recruiter_bot_offline' });
  pool.on('error', () => { /* Command promises report safe failures; never log driver details. */ });
  return pool;
}

export async function assertTarget(client: PoolClient, database: DatabaseName, privileged: boolean) {
  const result = await client.query<{ database_name: string; runtime_role: boolean }>(
    "SELECT current_database() AS database_name, current_user = 'recruiter_bot_app' AS runtime_role",
  );
  if (result.rows[0]?.database_name !== database || result.rows[0].runtime_role === privileged) {
    throw new StorageError('WRONG_DATABASE_OR_ROLE', 'The connected database or login does not match this command.');
  }
}

export async function writerTransaction<T>(pool: Pool, database: DatabaseName,
  work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let damaged = false;
  try {
    await assertTarget(client, database, true);
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path = pg_catalog, public');
    await client.query('SELECT pg_advisory_xact_lock(190512, 5)');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { damaged = true; }
    throw error;
  } finally { client.release(damaged); }
}
