import { ConfigurationError, readConfig } from './config.js';
import { createDatabase, DatabaseSchemaError, DatabaseTargetError } from './db.js';
import { isDatabaseUnavailable } from './database-errors.js';
import { installSignalHandlers, startServer } from './lifecycle.js';
import { createLogger } from './logger.js';
import { createMatchingService } from './modules/matching/service.js';

const logger = createLogger();

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const database = createDatabase(config, logger);
  const runtime = await startServer(config, database, logger, createMatchingService(database.pool));
  installSignalHandlers(runtime, logger);
}

void main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    logger({ event: 'startup_failed', category: 'configuration', invalidFields: error.fields });
  } else {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const category = error instanceof DatabaseTargetError ? 'database_target'
      : error instanceof DatabaseSchemaError ? 'database_schema'
      : code === 'EADDRINUSE' || code === 'EACCES' ? 'listener'
      : isDatabaseUnavailable(error)
        || (typeof code === 'string' && /^(08|28|3D|53|57)/.test(code)) ? 'database_unavailable'
        : 'internal';
    logger({ event: 'startup_failed', category });
  }
  process.exitCode = 1;
});
