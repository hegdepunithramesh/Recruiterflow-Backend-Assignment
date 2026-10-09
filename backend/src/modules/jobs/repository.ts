import type { PoolClient } from 'pg';
import type { JobFixture } from '../../storage/fixture.js';

const select = `SELECT j.id, j.title, j.min_experience_years, j.culture_keywords, j.tagline,
  COALESCE(array_agg(s.name ORDER BY s.name) FILTER (WHERE s.id IS NOT NULL), '{}'::TEXT[]) AS skills
  FROM public.jobs j LEFT JOIN public.job_skills js ON js.job_id = j.id
  LEFT JOIN public.skills s ON s.id = js.skill_id`;

export async function findJob(client: PoolClient, id: number): Promise<JobFixture | undefined> {
  const result = await client.query<JobFixture>(`${select} WHERE j.id = $1 GROUP BY j.id`, [id]);
  return result.rows[0];
}

export async function allJobs(client: PoolClient): Promise<JobFixture[]> {
  return (await client.query<JobFixture>(`${select} GROUP BY j.id ORDER BY j.id`)).rows;
}
