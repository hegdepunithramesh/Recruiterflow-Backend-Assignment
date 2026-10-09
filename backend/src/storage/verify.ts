import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { assignmentFixture, type CandidateFixture, type Fixture, type JobFixture } from './fixture.js';
import { readMigrations, requireMigrations } from './migrations.js';
import { assertTarget, StorageError, type DatabaseName } from './support.js';

export async function verifyFixture(client: PoolClient, fixture: Fixture) {
  const candidates = await client.query<CandidateFixture>(`SELECT c.id, c.name, c.experience_years, c.availability, c.traits, c.quirk,
    COALESCE(array_agg(s.name ORDER BY s.name) FILTER (WHERE s.id IS NOT NULL), '{}'::TEXT[]) AS skills
    FROM public.candidates c LEFT JOIN public.candidate_skills cs ON cs.candidate_id = c.id
    LEFT JOIN public.skills s ON s.id = cs.skill_id WHERE c.id = ANY($1::INTEGER[]) GROUP BY c.id ORDER BY c.id`,
  [fixture.candidates.map((row) => row.id)]);
  const jobs = await client.query<JobFixture>(`SELECT j.id, j.title, j.min_experience_years, j.culture_keywords, j.tagline,
    COALESCE(array_agg(s.name ORDER BY s.name) FILTER (WHERE s.id IS NOT NULL), '{}'::TEXT[]) AS skills
    FROM public.jobs j LEFT JOIN public.job_skills js ON js.job_id = j.id
    LEFT JOIN public.skills s ON s.id = js.skill_id WHERE j.id = ANY($1::INTEGER[]) GROUP BY j.id ORDER BY j.id`,
  [fixture.jobs.map((row) => row.id)]);
  const canonical = <T extends { id: number; skills: string[] }>(rows: T[]) =>
    rows.map((row) => ({ ...row, skills: [...row.skills].sort() })).sort((a, b) => a.id - b.id);
  if (!isDeepStrictEqual(canonical(candidates.rows), canonical(fixture.candidates)) ||
    !isDeepStrictEqual(canonical(jobs.rows), canonical(fixture.jobs))) {
    throw new StorageError('FIXTURE_MISMATCH', 'Stored fixture fields or skill relationships differ from the assignment.');
  }
  const counts = await client.query<{ candidates: number; jobs: number; skills: number; candidate_skills: number; job_skills: number }>(
    `SELECT (SELECT COUNT(*)::INTEGER FROM public.candidates) AS candidates,
      (SELECT COUNT(*)::INTEGER FROM public.jobs) AS jobs,
      (SELECT COUNT(*)::INTEGER FROM public.skills) AS skills,
      (SELECT COUNT(*)::INTEGER FROM public.candidate_skills) AS candidate_skills,
      (SELECT COUNT(*)::INTEGER FROM public.job_skills) AS job_skills`,
  );
  return counts.rows[0];
}

export async function assertRestrictedRole(client: PoolClient) {
  const role = await client.query<{ safe: boolean }>(`SELECT NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
    OR r.rolreplication OR r.rolbypassrls) AND r.rolcanlogin
    AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = r.oid) AS safe
    FROM pg_roles r WHERE r.rolname = 'recruiter_bot_app'`);
  if (role.rows[0]?.safe !== true) throw new StorageError('UNSAFE_RUNTIME_ROLE', 'recruiter_bot_app must be a restricted nonowner login without role memberships.');
}

export async function verifyPermissions(client: PoolClient) {
  await assertRestrictedRole(client);
  const tables = await client.query<{ readable: boolean; writable: boolean }>(`SELECT
    has_table_privilege(current_user, name, 'SELECT') AS readable,
    has_table_privilege(current_user, name, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writable
    FROM unnest(ARRAY['public.candidates','public.jobs','public.skills','public.candidate_skills','public.job_skills']) AS t(name)`);
  const boundaries = await client.query<{ safe: boolean }>(`SELECT
    has_schema_privilege(current_user, 'public', 'USAGE')
    AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
    AND NOT has_database_privilege(current_user, current_database(), 'CREATE,TEMP')
    AND NOT has_table_privilege(current_user, 'public.schema_migrations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_sequence_privilege(current_user, 'public.skills_id_seq', 'USAGE,SELECT,UPDATE') AS safe`);
  if (tables.rows.length !== 5 || tables.rows.some((row) => !row.readable || row.writable) || boundaries.rows[0]?.safe !== true) {
    throw new StorageError('PERMISSION_CHECK_FAILED', 'Runtime privileges must be domain SELECT only, without ledger, sequence, schema-write or temporary-table access.');
  }
}

export async function verifyDatabase(admin: Pool, runtime: Pool, database: DatabaseName) {
  const fixture = await assignmentFixture();
  const migrations = await readMigrations();
  const owner = await admin.connect();
  try { await assertTarget(owner, database, true); await requireMigrations(owner, migrations); }
  finally { owner.release(); }
  const client = await runtime.connect();
  let damaged = false;
  try {
    await assertTarget(client, database, false);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await verifyPermissions(client);
    const totals = await verifyFixture(client, fixture);
    await client.query('COMMIT');
    return { fixtureVerified: true, runtimeReadOnly: true, totals };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { damaged = true; }
    throw error;
  } finally { client.release(damaged); }
}
