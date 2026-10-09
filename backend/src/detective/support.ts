import pg from 'pg';
import type { PoolClient } from 'pg';

export class DetectiveError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'DetectiveError'; }
}

export function detectiveConfig(env: NodeJS.ProcessEnv): string {
  try {
    const url = new URL(env.DETECTIVE_DATABASE_URL ?? '');
    decodeURIComponent(url.password);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
      decodeURIComponent(url.username) === 'recruiter_bot_app' || decodeURIComponent(url.pathname) !== '/sql_detective' ||
      url.search || url.hash || (url.port && (!/^[1-9][0-9]*$/.test(url.port) || Number(url.port) > 65535))) throw new Error();
    return url.toString();
  } catch {
    throw new DetectiveError('CONFIGURATION', 'Set DETECTIVE_DATABASE_URL locally to a credentialed owner URL targeting sql_detective, without URL query parameters or fragments.');
  }
}

export function detectivePool(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 3000,
    statement_timeout: 10000, query_timeout: 12000, lock_timeout: 5000,
    application_name: 'sql_detective_offline' });
  pool.on('error', () => { /* Offline failures are reported without driver details. */ });
  return pool;
}

export async function assertDetectiveTarget(client: PoolClient) {
  const result = await client.query<{ database_name: string; runtime_role: boolean }>(
    "SELECT current_database() AS database_name, current_user = 'recruiter_bot_app' AS runtime_role",
  );
  if (result.rows.length !== 1 || result.rows[0]?.database_name !== 'sql_detective' || result.rows[0].runtime_role) {
    throw new DetectiveError('WRONG_DATABASE_OR_ROLE', 'Detective commands require sql_detective and a separate owner login. No setup was performed.');
  }
}

export async function assertBotIsolation(client: PoolClient) {
  const result = await client.query<{ isolated: boolean }>(`SELECT CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recruiter_bot_app')
    THEN NOT has_database_privilege('recruiter_bot_app', current_database(), 'CONNECT')
    ELSE TRUE END AS isolated`);
  if (result.rows[0]?.isolated !== true) throw new DetectiveError('BOT_DATABASE_ISOLATION',
    'Revoke CONNECT to sql_detective from PUBLIC and recruiter_bot_app using the documented owner setup.');
}
