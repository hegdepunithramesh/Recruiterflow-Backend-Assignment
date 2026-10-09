import { createDatabase } from '../../src/db.js';
import { installSignalHandlers, startServer } from '../../src/lifecycle.js';
import type { LogEntry } from '../../src/logger.js';
import { createMatchingService } from '../../src/modules/matching/service.js';
import { storageConfig } from '../../src/storage/support.js';

const config = storageConfig(process.env, true);
const applicationName = `phase09_shutdown_${process.pid}`;
const send = (event: string, details = {}) => { process.send?.({ event, ...details }); };
const logger = (entry: LogEntry) => {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
  if (entry.event === 'shutdown_started') queueMicrotask(() => send('shutdown_started'));
  if (entry.event === 'shutdown_complete') process.disconnect();
};
const database = createDatabase({ databaseUrl: config.runtimeUrl, port: 0, nodeEnv: 'test' }, logger, config.database);
database.pool.options.application_name = applicationName;
const runtime = await startServer({ databaseUrl: config.runtimeUrl, port: 0, nodeEnv: 'test' }, {
  checkReady: () => database.checkReady(),
  async close() {
    await database.close();
    send('pool_closed', { total: database.pool.totalCount, idle: database.pool.idleCount, waiting: database.pool.waitingCount });
  },
}, logger, createMatchingService(database.pool));
installSignalHandlers(runtime, logger);

async function holdBeyondDeadline() {
  const client = await database.pool.connect();
  try {
    // Test-only fault: outlast the shutdown deadline, overriding normal 2s/3s query limits.
    await client.query('SET statement_timeout = 0');
    const query = { text: 'SELECT pg_sleep(30)', query_timeout: 20000 };
    await client.query(query);
  } finally { client.release(); }
}
process.on('message', (message: unknown) => {
  if (message === 'SIGINT' || message === 'SIGTERM') {
    // Windows process.kill forcibly terminates: IPC invokes the real installed handler.
    process.emit(message);
  } else if (message === 'hold_beyond_deadline') {
    void holdBeyondDeadline().catch(() => { process.stdout.write('{"event":"test_query_finished"}\n'); });
  }
});
const address = runtime.server.address();
if (!address || typeof address === 'string') throw new Error('Expected TCP listener.');
send('listening', { port: address.port, applicationName });
