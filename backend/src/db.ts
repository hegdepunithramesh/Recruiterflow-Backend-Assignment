import pg from 'pg';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { isDatabaseUnavailable } from './database-errors.js';
import type { DatabaseName } from './storage/support.js';
import { verifyPermissions } from './storage/verify.js';

export class DatabaseTargetError extends Error {
  constructor() {
    super('The connected database and runtime login must match the application target.');
    this.name = 'DatabaseTargetError';
  }
}

export class DatabaseSchemaError extends Error {
  constructor() {
    super('Required schema or restricted read permissions are unavailable. Run offline storage verification.');
    this.name = 'DatabaseSchemaError';
  }
}

export interface DatabaseLifecycle {
  checkReady(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(config: Config, logger: Logger, expectedDatabase: DatabaseName = 'recruiter_bot') {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 5,
    connectionTimeoutMillis: 2000,
    statement_timeout: 2000,
    query_timeout: 3000,
    idleTimeoutMillis: 10000,
    application_name: 'recruiter_bot',
  });
  pool.on('error', () => {
    logger({ event: 'database_pool_error', category: 'database_unavailable' });
  });

  return {
    pool,
    async checkReady(): Promise<void> {
      const client = await pool.connect();
      let damaged = false;
      let connectionError: Error | undefined;
      const onError = (error: Error) => { connectionError = error; damaged = true; };
      client.on('error', onError);
      try {
        const result = await client.query<{ database_name: string; runtime_role: boolean }>(
          "SELECT current_database() AS database_name, current_user = 'recruiter_bot_app' AS runtime_role",
        );
        if (result.rows.length !== 1 || result.rows[0]?.database_name !== expectedDatabase || !result.rows[0].runtime_role) {
          throw new DatabaseTargetError();
        }
        try {
          // Effective privileges can be inspected without reading the private ledger.
          await verifyPermissions(client);
          // Parse/check the columns used by repositories without fetching profile rows.
          await client.query(`SELECT c.id, c.name, c.experience_years, c.availability, c.traits, c.quirk,
            j.id, j.title, j.min_experience_years, j.culture_keywords, j.tagline, s.id, s.name,
            cs.candidate_id, cs.skill_id, js.job_id, js.skill_id
            FROM public.candidates c, public.jobs j, public.skills s,
              public.candidate_skills cs, public.job_skills js LIMIT 0`);
        } catch (error) {
          if (isDatabaseUnavailable(error)) throw error;
          throw new DatabaseSchemaError();
        }
      } catch (error) { throw connectionError ?? error; }
      finally {
        client.release(damaged);
        client.removeListener('error', onError);
      }
    },
    async close(): Promise<void> { await pool.end(); },
  } satisfies DatabaseLifecycle & { pool: pg.Pool };
}
