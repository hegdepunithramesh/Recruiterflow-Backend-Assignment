import { createServer } from 'node:http';
import type { Express } from 'express';

export async function serve(app: Express) {
  const server = createServer(app);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve(); });
      });
    },
  };
}

export const testDatabaseUrl = 'postgresql://recruiter_bot_app:test_password@127.0.0.1:5432/recruiter_bot';
