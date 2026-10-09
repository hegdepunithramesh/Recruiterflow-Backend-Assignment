import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { assignmentFixture } from '../../src/storage/fixture.js';
import { migrate, readMigrations, type Migration } from '../../src/storage/migrations.js';
import { ingestFixture, seed } from '../../src/storage/seed.js';
import { assertTarget, storageConfig, storagePool, StorageError, writerTransaction } from '../../src/storage/support.js';
import { assertRestrictedRole, verifyDatabase, verifyFixture } from '../../src/storage/verify.js';

class TestRollback extends Error {}
const codeIs = (code: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === code;
const migration = (version: number, sql: string): Migration =>
  ({ version, sql, checksum: createHash('sha256').update(sql).digest('hex') });

void test('Phase 05 real PostgreSQL checks on the explicitly disposable database', { timeout: 120000 }, async (t) => {
  // Missing/unsafe configuration fails visibly; it is never silently counted as a pass.
  const config = storageConfig(process.env, true);
  const admin = storagePool(config.adminUrl);
  const runtime = storagePool(config.runtimeUrl);
  t.after(async () => { await Promise.all([admin.end(), runtime.end()]); });
  const files = await readMigrations();
  const fixture = await assignmentFixture();
  const preflight = await admin.connect();
  let fresh: boolean;
  try {
    await assertTarget(preflight, config.database, true);
    await assertRestrictedRole(preflight);
    const objects = await preflight.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    fresh = objects.rows.length === 0;
    if (!fresh && objects.rows.map((row) => row.tablename).join(',') !==
      'candidate_skills,candidates,job_skills,jobs,schema_migrations,skills') {
      throw new StorageError('DISPOSABLE_NOT_CLEAN', 'Use the dedicated empty test database or its previously verified baseline; no reset is performed.');
    }
  } finally { preflight.release(); }

  async function snapshot() {
    const client = await admin.connect();
    try {
      const result = await client.query<{ snapshot: string }>(`SELECT jsonb_build_object(
        'candidates', (SELECT jsonb_agg(c ORDER BY id) FROM public.candidates c),
        'jobs', (SELECT jsonb_agg(j ORDER BY id) FROM public.jobs j),
        'skills', (SELECT jsonb_agg(s ORDER BY id) FROM public.skills s),
        'candidate_skills', (SELECT jsonb_agg(c ORDER BY candidate_id, skill_id) FROM public.candidate_skills c),
        'job_skills', (SELECT jsonb_agg(j ORDER BY job_id, skill_id) FROM public.job_skills j))::text AS snapshot`);
      return result.rows[0]?.snapshot;
    } finally { client.release(); }
  }
  async function rollbackTrial(work: (client: PoolClient) => Promise<void>) {
    const before = await snapshot();
    await assert.rejects(writerTransaction(admin, config.database, async (client) => {
      await work(client);
      throw new TestRollback();
    }), TestRollback);
    assert.equal(await snapshot(), before);
  }

  await t.test('DB01/DB03 fresh migration application and initial batch failure rollback', { skip: !fresh }, async () => {
    await assert.rejects(migrate(admin, config.database, [files[0]!, migration(2, 'SELECT * FROM public.phase05_missing_relation')]), codeIs('42P01'));
    const client = await admin.connect();
    try {
      const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
      assert.equal(tables.rowCount, 0);
    } finally { client.release(); }
    assert.deepEqual((await migrate(admin, config.database)).applied, [1, 2]);
  });
  if (!fresh) await migrate(admin, config.database);

  await t.test('DB02 migration rerun is a no-op; ledger versions/checksums/timestamps are unchanged', async () => {
    const client = await admin.connect();
    try {
      const before = await client.query('SELECT * FROM public.schema_migrations ORDER BY version');
      assert.deepEqual(await migrate(admin, config.database), { applied: [], alreadyApplied: 2 });
      const after = await client.query('SELECT * FROM public.schema_migrations ORDER BY version');
      assert.deepEqual(after.rows, before.rows);
    } finally { client.release(); }
  });

  await t.test('DB03/DB04 pending batch failure rolls back DDL/ledger and edited history is rejected', async () => {
    await assert.rejects(migrate(admin, config.database, [...files,
      migration(3, 'CREATE TABLE public.phase05_rollback_probe (id INTEGER PRIMARY KEY)'),
      migration(4, 'SELECT * FROM public.phase05_missing_relation')]), codeIs('42P01'));
    const client = await admin.connect();
    try {
      assert.equal((await client.query<{ probe: string | null }>("SELECT to_regclass('public.phase05_rollback_probe')::text AS probe")).rows[0]?.probe, null);
      assert.equal((await client.query('SELECT * FROM public.schema_migrations')).rowCount, 2);
    } finally { client.release(); }
    await assert.rejects(migrate(admin, config.database, files.map((file, i) => i ? file : { ...file, checksum: '0'.repeat(64) })), StorageError);
    await assert.rejects(migrate(admin, config.database, files.slice(0, 1)), StorageError);
  });

  await t.test('DB05 target guards reject a development-target connection before test mutations', async () => {
    const client = await admin.connect();
    try { await assert.rejects(assertTarget(client, 'recruiter_bot', true), StorageError); }
    finally { client.release(); }
  });

  await t.test('DB06 exact fixture values/metadata/relationships and fresh totals', async () => {
    await seed(admin, config.database);
    const verified = await verifyDatabase(admin, runtime, config.database);
    assert.deepEqual(verified.totals, { candidates: 15, jobs: 6, skills: 27, candidate_skills: 50, job_skills: 16 });
  });

  await t.test('DB07 identical second seed run', async () => {
    const before = await snapshot();
    await seed(admin, config.database);
    assert.equal(await snapshot(), before);
  });

  await t.test('DB07/DB08 unrelated owners/skills survive, metadata/links restore, sequence cannot collide', async () => {
    await rollbackTrial(async (client) => {
      await client.query("INSERT INTO public.candidates (id,name,experience_years,availability,quirk) VALUES (1000,'Sherlock H.',0,'Immediate','Unrelated record')");
      await client.query("INSERT INTO public.skills (id,name) VALUES (100000,'unrelated-skill')");
      await client.query('INSERT INTO public.candidate_skills VALUES (1000,100000)');
      await client.query("UPDATE public.candidates SET experience_years=0, traits=ARRAY['changed'] WHERE id=1");
      await client.query('DELETE FROM public.candidate_skills WHERE candidate_id=1');
      await ingestFixture(client, fixture);
      assert.equal((await client.query('SELECT candidate_id FROM public.candidate_skills WHERE candidate_id=1000')).rowCount, 1);
      await verifyFixture(client, fixture);
      const extra = await client.query<{ id: number }>("INSERT INTO public.skills (name) VALUES ('after-explicit-id') RETURNING id");
      assert.ok((extra.rows[0]?.id ?? 0) > 100000);
    });
  });

  await t.test('DB09 reserved identity collision fails without overwriting it', async () => {
    await rollbackTrial(async (client) => {
      await client.query("UPDATE public.candidates SET name='Different identity' WHERE id=1");
      await assert.rejects(ingestFixture(client, fixture), StorageError);
      assert.equal((await client.query<{ name: string }>('SELECT name FROM public.candidates WHERE id=1')).rows[0]?.name, 'Different identity');
    });
  });

  await t.test('DB10 real mid-ingestion SQL failure rolls back candidate writes and trigger DDL', async () => {
    const before = await snapshot();
    await assert.rejects(writerTransaction(admin, config.database, async (client) => {
      await client.query(`CREATE FUNCTION public.phase05_reject_job() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'Injected test failure' USING ERRCODE = '23514'; END; $$`);
      await client.query('CREATE TRIGGER phase05_reject_job BEFORE INSERT OR UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.phase05_reject_job()');
      const altered = structuredClone(fixture);
      altered.candidates[0]!.experience_years = 123;
      await ingestFixture(client, altered);
    }), codeIs('23514'));
    assert.equal(await snapshot(), before);
  });

  for (const [label, sql, code] of [
    ['positive IDs', "INSERT INTO public.skills (id,name) VALUES (0,'invalid-id')", '23514'],
    ['primary key', "INSERT INTO public.skills (id,name) SELECT id,'duplicate-id' FROM public.skills LIMIT 1", '23505'],
    ['canonical unique skills', "INSERT INTO public.skills (name) VALUES ('deduction')", '23505'],
    ['canonical casing', "INSERT INTO public.skills (name) VALUES ('UPPERCASE')", '23514'],
    ['blank required text', "UPDATE public.candidates SET name=' ' WHERE id=1", '23514'],
    ['null required text', 'UPDATE public.jobs SET title=NULL WHERE id=1', '23502'],
    ['nonnegative experience', 'UPDATE public.candidates SET experience_years=-1 WHERE id=1', '23514'],
    ['availability enum', "UPDATE public.candidates SET availability='Unknown' WHERE id=1", '23514'],
    ['metadata null elements', "UPDATE public.jobs SET culture_keywords=ARRAY[NULL]::TEXT[] WHERE id=1", '23514'],
    ['foreign keys', 'INSERT INTO public.candidate_skills VALUES (200000,200000)', '23503'],
    ['unique associations', 'INSERT INTO public.candidate_skills SELECT candidate_id,skill_id FROM public.candidate_skills LIMIT 1', '23505'],
    // PostgreSQL 18 reports RESTRICT with its dedicated SQLSTATE.
    ['referenced skill deletion', "DELETE FROM public.skills WHERE name='deduction'", '23001'],
  ] as const) {
    await t.test(`DB12/DB13 constraint: ${label}`, async () => {
      await assert.rejects(writerTransaction(admin, config.database, async (client) => { await client.query(sql); }), codeIs(code));
    });
  }

  await t.test('DB13 owner deletion cascades and only justified indexes exist', async () => {
    await rollbackTrial(async (client) => {
      await client.query("INSERT INTO public.jobs (id,title,min_experience_years,tagline) VALUES (1000,'Extra job',0,'Extra')");
      await client.query('INSERT INTO public.job_skills SELECT 1000,id FROM public.skills LIMIT 1');
      await client.query('DELETE FROM public.jobs WHERE id=1000');
      assert.equal((await client.query('SELECT * FROM public.job_skills WHERE job_id=1000')).rowCount, 0);
      const indexes = await client.query<{ tablename: string; indexdef: string }>(`SELECT tablename,indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename IN ('candidates','jobs','skills','candidate_skills','job_skills')`);
      assert.equal(indexes.rows.length, 6);
      assert.match(indexes.rows.find((row) => row.tablename === 'candidate_skills')?.indexdef ?? '', /\(candidate_id, skill_id\)/);
      assert.match(indexes.rows.find((row) => row.tablename === 'job_skills')?.indexdef ?? '', /\(job_id, skill_id\)/);
    });
  });

  for (const [label, sql] of [
    ['ledger read', 'SELECT * FROM public.schema_migrations'],
    ['insert', "INSERT INTO public.skills (name) VALUES ('unauthorized')"],
    ['update', 'UPDATE public.candidates SET experience_years=0 WHERE id=1'],
    ['delete', 'DELETE FROM public.job_skills WHERE job_id=1'],
    ['truncate', 'TRUNCATE public.candidate_skills'],
    ['schema DDL', 'CREATE TABLE public.phase05_unauthorized (id INTEGER)'],
    ['temporary DDL', 'CREATE TEMP TABLE phase05_unauthorized (id INTEGER)'],
    ['sequence access', "SELECT nextval('public.skills_id_seq')"],
  ] as const) {
    await t.test(`DB14 runtime is denied ${label}`, async () => {
      const client = await runtime.connect();
      try {
        await assertTarget(client, config.database, false);
        await client.query('BEGIN');
        await assert.rejects(client.query(sql), codeIs('42501'));
      } finally { await client.query('ROLLBACK'); client.release(); }
    });
  }

  await t.test('DB18 concurrent seeds serialize and preserve the fixture', async () => {
    const before = await snapshot();
    await Promise.all([seed(admin, config.database), seed(admin, config.database)]);
    assert.equal(await snapshot(), before);
    await verifyDatabase(admin, runtime, config.database);
  });
});
