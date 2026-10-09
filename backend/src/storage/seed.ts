import type { Pool, PoolClient } from 'pg';
import { assignmentFixture, validateFixture, type Fixture } from './fixture.js';
import { readMigrations, requireMigrations } from './migrations.js';
import { StorageError, writerTransaction, type DatabaseName } from './support.js';

async function checkIdentities(client: PoolClient, fixture: Fixture) {
  const candidates = await client.query<{ id: number; name: string }>(
    'SELECT id, name FROM public.candidates WHERE id = ANY($1::INTEGER[]) FOR UPDATE',
    [fixture.candidates.map((row) => row.id)],
  );
  const jobs = await client.query<{ id: number; title: string }>(
    'SELECT id, title FROM public.jobs WHERE id = ANY($1::INTEGER[]) FOR UPDATE',
    [fixture.jobs.map((row) => row.id)],
  );
  if (candidates.rows.some((row) => fixture.candidates.find((candidate) => candidate.id === row.id)?.name !== row.name) ||
    jobs.rows.some((row) => fixture.jobs.find((job) => job.id === row.id)?.title !== row.title)) {
    throw new StorageError('FIXTURE_ID_CONFLICT', 'A reserved fixture ID belongs to a different name/title; nothing was overwritten.');
  }
}

export async function ingestFixture(client: PoolClient, fixture: Fixture) {
  await checkIdentities(client, fixture);
  // Blocks noncooperative skill inserts while reconciling the identity sequence.
  await client.query('LOCK TABLE public.skills IN SHARE ROW EXCLUSIVE MODE');
  await client.query(`SELECT setval('public.skills_id_seq',
    GREATEST((SELECT COALESCE(MAX(id), 1) FROM public.skills), (SELECT last_value FROM public.skills_id_seq)),
    (SELECT is_called FROM public.skills_id_seq) OR EXISTS (SELECT 1 FROM public.skills))`);
  const names = [...new Set([...fixture.candidates, ...fixture.jobs].flatMap((row) => row.skills))].sort();
  const existing = await client.query<{ id: number; name: string }>(
    'SELECT id, name FROM public.skills WHERE name = ANY($1::TEXT[])', [names],
  );
  const skills = new Map(existing.rows.map((row) => [row.name, row.id]));
  for (const name of names) {
    if (!skills.has(name)) {
      const inserted = await client.query<{ id: number }>('INSERT INTO public.skills (name) VALUES ($1) RETURNING id', [name]);
      const id = inserted.rows[0]?.id;
      if (!id) throw new StorageError('INGESTION_FAILED', 'Skill ingestion failed.');
      skills.set(name, id);
    }
  }

  for (const row of fixture.candidates) {
    const result = await client.query(`INSERT INTO public.candidates (id, name, experience_years, availability, traits, quirk)
      VALUES ($1, $2, $3, $4, $5::TEXT[], $6)
      ON CONFLICT (id) DO UPDATE SET experience_years = EXCLUDED.experience_years,
        availability = EXCLUDED.availability, traits = EXCLUDED.traits, quirk = EXCLUDED.quirk
      WHERE candidates.name = EXCLUDED.name RETURNING id`,
    [row.id, row.name, row.experience_years, row.availability, row.traits, row.quirk]);
    if (result.rowCount !== 1) throw new StorageError('FIXTURE_ID_CONFLICT', 'A reserved candidate ID has a conflicting identity.');
  }
  for (const row of fixture.jobs) {
    const result = await client.query(`INSERT INTO public.jobs (id, title, min_experience_years, culture_keywords, tagline)
      VALUES ($1, $2, $3, $4::TEXT[], $5)
      ON CONFLICT (id) DO UPDATE SET min_experience_years = EXCLUDED.min_experience_years,
        culture_keywords = EXCLUDED.culture_keywords, tagline = EXCLUDED.tagline
      WHERE jobs.title = EXCLUDED.title RETURNING id`,
    [row.id, row.title, row.min_experience_years, row.culture_keywords, row.tagline]);
    if (result.rowCount !== 1) throw new StorageError('FIXTURE_ID_CONFLICT', 'A reserved job ID has a conflicting identity.');
  }
  await client.query('DELETE FROM public.candidate_skills WHERE candidate_id = ANY($1::INTEGER[])', [fixture.candidates.map((row) => row.id)]);
  await client.query('DELETE FROM public.job_skills WHERE job_id = ANY($1::INTEGER[])', [fixture.jobs.map((row) => row.id)]);
  for (const row of fixture.candidates) {
    await client.query('INSERT INTO public.candidate_skills (candidate_id, skill_id) SELECT $1, unnest($2::INTEGER[])',
      [row.id, row.skills.map((name) => skills.get(name))]);
  }
  for (const row of fixture.jobs) {
    await client.query('INSERT INTO public.job_skills (job_id, skill_id) SELECT $1, unnest($2::INTEGER[])',
      [row.id, row.skills.map((name) => skills.get(name))]);
  }
}

export async function seed(pool: Pool, database: DatabaseName, supplied?: unknown) {
  // Validate the complete input before checking out a client or making any writes.
  const fixture = supplied === undefined ? await assignmentFixture() : validateFixture(supplied);
  const migrations = await readMigrations();
  await writerTransaction(pool, database, async (client) => {
    await requireMigrations(client, migrations);
    await ingestFixture(client, fixture);
  });
  return { candidates: fixture.candidates.length, jobs: fixture.jobs.length };
}
