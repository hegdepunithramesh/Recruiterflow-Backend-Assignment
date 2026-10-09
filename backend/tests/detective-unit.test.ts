import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mock, test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { detectiveTransaction, readAnswers } from '../src/detective/commands.js';
import { fixtureReference } from '../src/detective/fixture.js';
import { assertDetectiveTarget, detectiveConfig, DetectiveError } from '../src/detective/support.js';

const ownerUrl = 'postgresql://test_owner:placeholder_secret@127.0.0.1:5432/sql_detective';

void test('Detective configuration reads only its separate owner URL', () => {
  assert.equal(detectiveConfig({ DETECTIVE_DATABASE_URL: ownerUrl, DATABASE_URL: 'unused' }), ownerUrl);
});

for (const [label, value] of [
  ['missing', undefined], ['malformed', 'placeholder_secret'], ['Bot target', ownerUrl.replace('sql_detective','recruiter_bot')],
  ['test Bot target', ownerUrl.replace('sql_detective','recruiter_bot_phase05_test')],
  ['runtime login', ownerUrl.replace('test_owner','recruiter_bot_app')],
  ['query override', `${ownerUrl}?dbname=recruiter_bot`], ['fragment', `${ownerUrl}#placeholder_secret`],
  ['missing password', ownerUrl.replace(':placeholder_secret','')], ['protocol', ownerUrl.replace('postgresql:','https:')],
  ['invalid port', ownerUrl.replace('5432','70000')],
] as const) {
  void test(`Detective configuration rejects ${label} without exposing values`, () => {
    assert.throws(() => detectiveConfig(value === undefined ? {} : { DETECTIVE_DATABASE_URL: value }),
      (error: unknown) => error instanceof DetectiveError && error.code === 'CONFIGURATION'
        && !error.message.includes('placeholder_secret') && !error.message.includes('postgresql:'));
  });
}

void test('connected-target guard rejects Bot access; offline transaction creates in public (SQL double)', async () => {
  let rows = [{ database_name: 'recruiter_bot', runtime_role: false }];
  const query = mock.fn((sql: string) => {
    assert.equal(sql, "SELECT current_database() AS database_name, current_user = 'recruiter_bot_app' AS runtime_role");
    return Promise.resolve({ rows });
  });
  const client = { query } as unknown as PoolClient;
  await assert.rejects(assertDetectiveTarget(client), DetectiveError);
  rows = [{ database_name: 'sql_detective', runtime_role: true }];
  await assert.rejects(assertDetectiveTarget(client), DetectiveError);
  rows = [];
  await assert.rejects(assertDetectiveTarget(client), DetectiveError);
  rows = [{ database_name: 'sql_detective', runtime_role: false }];
  await assertDetectiveTarget(client);
  assert.equal(query.mock.callCount(), 4);
  const seen: string[] = [];
  const transactionClient = {
    query: (sql: string) => {
      seen.push(sql);
      return Promise.resolve({ rows: sql.startsWith('SELECT current_database') ? rows : [{ isolated: true }] });
    }, on: mock.fn(), removeListener: mock.fn(), release: mock.fn(),
  };
  const pool = { connect: () => Promise.resolve(transactionClient as unknown as PoolClient) } as unknown as Pool;
  assert.equal(await detectiveTransaction(pool, false, () => Promise.resolve(42)), 42);
  assert.equal(seen[1], 'BEGIN');
  assert.equal(seen[2], 'SET LOCAL search_path = public');
  assert.equal(seen.at(-1), 'COMMIT');
  assert.deepEqual(transactionClient.release.mock.calls[0]?.arguments, [false]);
});

void test('answer artifact has five executable numbered read-only queries, including the window bonus', async () => {
  const queries = await readAnswers();
  assert.equal(queries.length, 5);
  assert.ok(queries.every((query) => /^(SELECT|WITH)\b/.test(query)));
  assert.ok(queries.every((query) => !/\b(INSERT|UPDATE|DELETE|CREATE|DROP|TRUNCATE|ALTER)\b/i.test(query)));
  assert.match(queries[4]!, /DENSE_RANK\(\) OVER \(PARTITION BY department ORDER BY successful_placements DESC\)/);
});

void test('independent fixture reference preserves 47 rows, duplicate email case and NULL values', async () => {
  const fixture = await fixtureReference() as Record<string, unknown[][]>;
  assert.deepEqual(Object.values(fixture).map((rows) => rows.length), [5,7,11,24]);
  assert.equal(fixture.applicants?.[0]?.[2], 'ananya.rao@mail.com');
  assert.equal(fixture.applicants?.[1]?.[2], 'Ananya.Rao@mail.com');
  assert.equal(fixture.applicants?.[3]?.[3], null);
  assert.equal(fixture.applicants?.[8]?.[3], null);
  assert.deepEqual(fixture.interviews?.[21], [22,10,5,'Technical','2026-01-28',null]);
});

void test('offline CLI exits safely before connecting when the separate URL is missing', () => {
  const child = spawnSync(process.execPath, ['--import','tsx','src/detective/cli.ts','load'], {
    env: { ...process.env, DETECTIVE_DATABASE_URL: '' }, encoding: 'utf8', timeout: 8000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.equal(child.stderr, '');
  const result: unknown = JSON.parse(child.stdout);
  assert.ok(result && typeof result === 'object' && 'code' in result && result.code === 'CONFIGURATION');
  assert.doesNotMatch(child.stdout, /placeholder_secret|postgresql?:\/\//);
});
