import { createServer } from 'node:http';
import type { Config } from './config.js';
import type { DatabaseLifecycle } from './db.js';
import type { Logger } from './logger.js';
import { createApp } from './app.js';

export async function startServer(config: Config, database: DatabaseLifecycle, logger: Logger) {
  const server = createServer(createApp(database, logger));
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  try {
    await database.checkReady();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    try { await database.close(); }
    catch { logger({ event: 'database_close_failed', category: 'database_unavailable' }); }
    throw error;
  }
  const address = server.address();
  logger({ event: 'server_listening', port: typeof address === 'object' && address ? address.port : config.port });

  let shutdownPromise: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    shutdownPromise ??= (async () => {
      logger({ event: 'shutdown_started' });
      let deadline: NodeJS.Timeout | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          server.closeAllConnections();
          reject(new Error('Shutdown deadline exceeded.'));
        }, 10000);
        deadline.unref();
      });
      try {
        await Promise.race([
          (async () => {
            await new Promise<void>((resolve, reject) => {
              server.close((error) => { if (error) reject(error); else resolve(); });
            });
            await database.close();
          })(),
          expired,
        ]);
        logger({ event: 'shutdown_complete' });
      } finally { clearTimeout(deadline); }
    })();
    return shutdownPromise;
  }

  return { server, shutdown };
}

export function installSignalHandlers(runtime: Awaited<ReturnType<typeof startServer>>, logger: Logger) {
  const stop = () => {
    void runtime.shutdown().catch(() => {
      logger({ event: 'shutdown_failed' });
      process.exit(1);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
