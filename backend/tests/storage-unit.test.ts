import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignmentFixture, validateFixture } from '../src/storage/fixture.js';
import { assertHistory, readMigrations } from '../src/storage/migrations.js';
import { storageConfig, StorageError } from '../src/storage/support.js';

const runtime = 'postgresql://recruiter_bot_app:unit_password@127.0.0.1:5432/recruiter_bot';
const admin = 'postgresql://owner:unit_password@127.0.0.1:5432/recruiter_bot';

void test('assignment fixture retains 15/6 owners, 27 skills, 50/16 links and page-spanning metadata', async () => {
  const fixture = await assignmentFixture();
  assert.equal(fixture.candidates.length, 15);
  assert.equal(fixture.jobs.length, 6);
  assert.equal(new Set([...fixture.candidates, ...fixture.jobs].flatMap((row) => row.skills)).size, 27);
  assert.equal(fixture.candidates.reduce((total, row) => total + row.skills.length, 0), 50);
  assert.equal(fixture.jobs.reduce((total, row) => total + row.skills.length, 0), 16);
  assert.equal(fixture.candidates[1]?.quirk, 'Reads the entire documentation before writing a single line of code.');
  assert.equal(fixture.candidates[8]?.quirk, 'Correct 95% of the time, insufferable 100% of the time.');
  assert.equal(fixture.candidates[2]?.availability, 'Not looking');
  assert.equal(fixture.jobs[1]?.tagline, 'Ship first, document never (kidding — please document).');
});

void test('ingestion normalizes/deduplicates skills without changing display metadata or input', async () => {
  const fixture = await assignmentFixture();
  const first = fixture.candidates[0];
  assert.ok(first);
  first.skills = [' Deduction ', 'DEDUCTION', 'pattern-recognition'];
  const result = validateFixture(fixture);
  assert.deepEqual(result.candidates[0]?.skills, ['deduction', 'pattern-recognition']);
  assert.equal(first.skills[0], ' Deduction ');
  assert.equal(result.candidates[0]?.quirk, first.quirk);
});

for (const [label, mutate] of [
  ['empty job skills', (x: Record<string, unknown>) => { x.skills = []; }],
  ['blank skill', (x: Record<string, unknown>) => { x.skills = [' ']; }],
  ['null skill', (x: Record<string, unknown>) => { x.skills = [null]; }],
  ['fractional experience', (x: Record<string, unknown>) => { x.min_experience_years = 1.5; }],
  ['negative experience', (x: Record<string, unknown>) => { x.min_experience_years = -1; }],
  ['null metadata', (x: Record<string, unknown>) => { x.culture_keywords = [null]; }],
  ['nested metadata', (x: Record<string, unknown>) => { x.culture_keywords = [['nested']]; }],
  ['blank title', (x: Record<string, unknown>) => { x.title = '\t'; }],
] as const) {
  void test(`fixture rejects ${label} before ingestion`, async () => {
    const fixture = await assignmentFixture();
    const row = fixture.jobs[0];
    assert.ok(row);
    mutate(row as unknown as Record<string, unknown>);
    assert.throws(() => validateFixture(fixture), StorageError);
  });
}

void test('fixture rejects duplicate IDs and unknown availability; empty candidate skills are valid', async () => {
  const fixture = await assignmentFixture();
  const first = fixture.candidates[0];
  assert.ok(first);
  first.skills = [];
  assert.deepEqual(validateFixture(fixture).candidates[0]?.skills, []);
  assert.throws(() => validateFixture({ ...fixture, candidates: [...fixture.candidates, first] }), StorageError);
  assert.throws(() => validateFixture({ ...fixture, candidates: [{ ...first, availability: 'Unknown' }] }), StorageError);
});

void test('offline configuration separates runtime/owner and strictly guards both database targets', () => {
  const env = { DATABASE_URL: runtime, ADMIN_DATABASE_URL: admin,
    TEST_ADMIN_DATABASE_URL: admin.replace('/recruiter_bot', '/recruiter_bot_phase05_test') };
  assert.equal(storageConfig(env).database, 'recruiter_bot');
  assert.equal(storageConfig(env, true).database, 'recruiter_bot_phase05_test');
  for (const invalid of [
    { ...env, ADMIN_DATABASE_URL: undefined }, { ...env, ADMIN_DATABASE_URL: runtime },
    { ...env, DATABASE_URL: admin }, { ...env, ADMIN_DATABASE_URL: `${admin}?dbname=sql_detective` },
    { ...env, ADMIN_DATABASE_URL: admin.replace('recruiter_bot', 'sql_detective') },
    { ...env, ADMIN_DATABASE_URL: admin.replace('5432', '5433') },
  ]) {
    assert.throws(() => storageConfig(invalid), StorageError);
  }
  assert.throws(() => storageConfig({ ...env, TEST_ADMIN_DATABASE_URL: admin }, true), StorageError);
});

void test('migration history detects edited, missing, unknown and incomplete versions', async () => {
  const files = await readMigrations();
  assert.equal(files.length, 2);
  for (const file of files) assert.match(file.checksum, /^[0-9a-f]{64}$/);
  assertHistory(files, files, true);
  assert.throws(() => assertHistory([{ version: 1, checksum: 'changed' }], files), StorageError);
  assert.throws(() => assertHistory(files, files.slice(1)), StorageError);
  assert.throws(() => assertHistory([...files, { version: 99, checksum: 'unknown' }], files), StorageError);
  assert.throws(() => assertHistory(files.slice(0, 1), files, true), StorageError);
});
