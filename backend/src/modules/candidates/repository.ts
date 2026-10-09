import type { PoolClient } from 'pg';
import type { CandidateFixture } from '../../storage/fixture.js';

const select = `SELECT c.id, c.name, c.experience_years, c.availability, c.traits, c.quirk,
  COALESCE(array_agg(s.name ORDER BY s.name) FILTER (WHERE s.id IS NOT NULL), '{}'::TEXT[]) AS skills
  FROM public.candidates c LEFT JOIN public.candidate_skills cs ON cs.candidate_id = c.id
  LEFT JOIN public.skills s ON s.id = cs.skill_id`;

export async function findCandidate(client: PoolClient, id: number): Promise<CandidateFixture | undefined> {
  const result = await client.query<CandidateFixture>(`${select} WHERE c.id = $1 GROUP BY c.id`, [id]);
  return result.rows[0];
}

export async function allCandidates(client: PoolClient): Promise<CandidateFixture[]> {
  return (await client.query<CandidateFixture>(`${select} GROUP BY c.id ORDER BY c.id`)).rows;
}
