import { installSignalHandlers, startServer } from '../../src/lifecycle.js';
import { createLogger } from '../../src/logger.js';
import { testDatabaseUrl } from '../helpers.js';

const logger = createLogger();
const runtime = await startServer({ databaseUrl: testDatabaseUrl, port: 0, nodeEnv: 'test' }, {
  checkReady: () => Promise.resolve(),
  close: () => { process.stdout.write('test_database_closed\n'); return Promise.resolve(); },
}, logger);
installSignalHandlers(runtime, logger);
process.once('message', (signal: string) => {
  // Windows process.kill terminates forcibly. Exercise the installed Node handlers through IPC.
  process.emit(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
  process.disconnect();
});
process.send?.('listening');
