import pg from 'pg';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

export class DatabaseTargetError extends Error {
  constructor() {
    super('The connected database must be recruiter_bot.');
    this.name = 'DatabaseTargetError';
  }
}

export interface DatabaseLifecycle {
  checkReady(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(config: Config, logger: Logger) {
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
      // Handwritten, read-only infrastructure probe; no domain/schema access.
      const result = await pool.query<{ database_name: string }>(
        'SELECT current_database() AS database_name',
      );
      if (result.rows.length !== 1 || result.rows[0]?.database_name !== 'recruiter_bot') {
        throw new DatabaseTargetError();
      }
    },
    async close(): Promise<void> { await pool.end(); },
  } satisfies DatabaseLifecycle & { pool: pg.Pool };
}
