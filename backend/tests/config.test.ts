import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ConfigurationError, readConfig } from '../src/config.js';
import { testDatabaseUrl } from './helpers.js';

void test('valid environment has explicit defaults and supports production configuration', () => {
  assert.deepEqual(readConfig({ DATABASE_URL: testDatabaseUrl }), {
    databaseUrl: testDatabaseUrl, port: 3000, nodeEnv: 'development',
  });
  assert.equal(readConfig({ DATABASE_URL: testDatabaseUrl, PORT: '65535', NODE_ENV: 'production' }).port, 65535);
});

for (const [label, url] of [
  ['missing', undefined], ['empty', ''], ['malformed', 'secret-not-a-url'],
  ['wrong protocol', 'https://user:secret@localhost/recruiter_bot'],
  ['wrong target', testDatabaseUrl.replace('recruiter_bot', 'sql_detective')],
  ['query override', `${testDatabaseUrl}?dbname=sql_detective`],
  ['fragment', `${testDatabaseUrl}#secret`],
  ['missing credentials', testDatabaseUrl.replace('test_user:test_password@', '')],
  ['invalid database port', testDatabaseUrl.replace('5432', '70000')],
] as const) {
  void test(`rejects database configuration: ${label}`, () => {
    assert.throws(() => readConfig(url === undefined ? {} : { DATABASE_URL: url }),
      (error: unknown) => error instanceof ConfigurationError && error.fields.includes('DATABASE_URL')
        && !error.message.includes('secret'));
  });
}

for (const port of ['', '0', '-1', '03000', '1.5', '1e3', '65536', ' 3000']) {
  void test(`rejects invalid PORT ${JSON.stringify(port)}`, () => {
    assert.throws(() => readConfig({ DATABASE_URL: testDatabaseUrl, PORT: port }), ConfigurationError);
  });
}

void test('rejects an unknown NODE_ENV', () => {
  assert.throws(() => readConfig({ DATABASE_URL: testDatabaseUrl, NODE_ENV: 'preview' }), ConfigurationError);
});

void test('server entry exits before listening on missing or wrong-target configuration without leaking values', () => {
  for (const url of ['', testDatabaseUrl.replace('recruiter_bot', 'sql_detective')]) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 8000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.equal(child.stderr, '');
    const record: unknown = JSON.parse(child.stdout.trim());
    assert.deepEqual(record, {
      timestamp: (record as { timestamp: string }).timestamp,
      event: 'startup_failed', category: 'configuration', invalidFields: ['DATABASE_URL'],
    });
    assert.doesNotMatch(child.stdout, /test_password|test_user|server_listening/);
  }
});
