import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../src/errors.js';
import { isDatabaseUnavailable } from '../src/database-errors.js';
import { createMatchingService } from '../src/modules/matching/service.js';
import { assignmentFixture } from '../src/storage/fixture.js';

const fixture = await assignmentFixture();

void test('service commits and releases one client before returning a complete ranking (SQL double)', async () => {
  const queries: { sql: string; values: unknown[] | undefined }[] = [];
  const client = {
    query: mock.fn((sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      return Promise.resolve({ rows: sql.includes('WHERE j.id = $1') ? [fixture.jobs[0]]
        : sql.includes('FROM public.candidates') ? fixture.candidates : [] });
    }), release: mock.fn(), on: mock.fn(), removeListener: mock.fn(),
  };
  const pool = { connect: mock.fn(() => Promise.resolve(client as unknown as PoolClient)) };
  const result = await createMatchingService(pool as unknown as Pool).forJob(1);
  assert.equal(result.matches.length, 15);
  assert.equal(pool.connect.mock.callCount(), 1);
  assert.equal(queries[0]?.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.deepEqual(queries[1]?.values, [1]);
  assert.equal(queries.at(-1)?.sql, 'COMMIT');
  assert.deepEqual(client.release.mock.calls[0]?.arguments, [false]);
});

for (const discard of [false, true]) {
  void test(`failed SQL rolls back, preserves the original error and discards client=${String(discard)}`, async () => {
    const failure = Object.assign(new Error('private SQL details'), { code: '42P01' });
    const client = {
      query: mock.fn((sql: string) => {
        if (sql.startsWith('SELECT') || (discard && sql === 'ROLLBACK')) return Promise.reject(failure);
        return Promise.resolve({ rows: [] });
      }), release: mock.fn(), on: mock.fn(), removeListener: mock.fn(),
    };
    const pool = { connect: () => Promise.resolve(client as unknown as PoolClient) };
    await assert.rejects(createMatchingService(pool as unknown as Pool).forCandidate(1), (error: unknown) => error === failure);
    assert.equal(client.query.mock.calls.at(-1)?.arguments[0], 'ROLLBACK');
    assert.deepEqual(client.release.mock.calls[0]?.arguments, [discard]);
  });
}

void test('known acquisition failures become a safe availability error; programming failures do not', async () => {
  for (const error of [Object.assign(new Error('private URL'), { code: 'ECONNREFUSED' }),
    new Error('timeout exceeded when trying to connect')]) {
    const pool = { connect: () => Promise.reject(error) };
    await assert.rejects(createMatchingService(pool as unknown as Pool).forJob(1),
      (result: unknown) => result instanceof AppError && result.code === 'DATABASE_UNAVAILABLE');
  }
  assert.equal(isDatabaseUnavailable(Object.assign(new Error('query failed'), { code: '57014' })), true);
  for (const error of [null, 'timeout', new Error('unexpected timeout in scorer'),
    Object.assign(new Error('missing relation'), { code: '42P01' }),
    Object.assign(new Error('syntax'), { code: '42601' })]) assert.equal(isDatabaseUnavailable(error), false);
});
