import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mock, test } from 'node:test';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { PoolClient } from 'pg';
import { createDatabase, DatabaseSchemaError, DatabaseTargetError } from '../src/db.js';
import type { LogEntry } from '../src/logger.js';
import { serve, testDatabaseUrl } from './helpers.js';

void test('the probe rejects a wrong connected target and empty result (query double, no PostgreSQL)', async (t) => {
  const database = createDatabase(readConfig({ DATABASE_URL: testDatabaseUrl }), () => {});
  t.after(() => database.close());
  let result: object[] = [{ database_name: 'sql_detective', runtime_role: true }];
  const client = { query: mock.fn(() => Promise.resolve({ rows: result })), release: mock.fn(),
    on: mock.fn(), removeListener: mock.fn() };
  mock.method(database.pool, 'connect', () => Promise.resolve(client as unknown as PoolClient));
  await assert.rejects(database.checkReady(), DatabaseTargetError);
  result = [];
  await assert.rejects(database.checkReady(), DatabaseTargetError);
  result = [{ database_name: 'recruiter_bot', runtime_role: false }];
  await assert.rejects(database.checkReady(), DatabaseTargetError);
  let call = 0;
  client.query.mock.mockImplementation(() => {
    call++;
    return Promise.resolve({ rows: call === 1 ? [{ database_name: 'recruiter_bot', runtime_role: true }]
      : call === 3 ? Array.from({ length: 5 }, () => ({ readable: true, writable: false })) : [{ safe: true }] });
  });
  await database.checkReady();
  assert.equal(client.release.mock.callCount(), 4);
  client.query.mock.mockImplementation(() => Promise.resolve({ rows: [{ database_name: 'recruiter_bot', runtime_role: true }] }));
  await assert.rejects(database.checkReady(), DatabaseSchemaError);
  assert.equal(client.release.mock.callCount(), 5);
});

void test('idle pool errors are consumed and logged without raw driver information', (t) => {
  const logs: LogEntry[] = [];
  const database = createDatabase(readConfig({ DATABASE_URL: testDatabaseUrl }), (entry) => { logs.push(entry); });
  t.after(() => database.close());
  database.pool.emit('error', new Error('secret connection credentials'));
  assert.deepEqual(logs, [{ event: 'database_pool_error', category: 'database_unavailable' }]);
});

void test('real pg connection refusal produces HTTP 503 and allows pool cleanup (no PostgreSQL)', async (t) => {
  const reservation = createServer();
  await new Promise<void>((resolve) => { reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => { reservation.close(() => { resolve(); }); });
  const database = createDatabase(readConfig({
    DATABASE_URL: testDatabaseUrl.replace(':5432/', `:${address.port}/`),
  }), () => {});
  t.after(() => database.close());
  const http = await serve(createApp(database, () => {}));
  t.after(() => http.close());
  const response = await fetch(`${http.url}/ready`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: {
    code: 'DATABASE_NOT_READY', message: 'Database is not ready.', requestId: response.headers.get('X-Request-Id'),
  } });
  assert.equal((await fetch(`${http.url}/health`)).status, 200);
  assert.equal(database.pool.totalCount, 0);
});
