import type { Pool, PoolClient } from 'pg';
import { isDatabaseUnavailable } from '../../database-errors.js';
import { AppError } from '../../errors.js';
import { validateFixture } from '../../storage/fixture.js';
import { allCandidates, findCandidate } from '../candidates/repository.js';
import { allJobs, findJob } from '../jobs/repository.js';
import { rankCandidates, rankJobs } from './policy.js';

async function snapshot<T>(pool: Pool, load: (client: PoolClient) => Promise<T>): Promise<T> {
  // Acquisition belongs to the same failure boundary as the SQL reads.
  try {
    const client = await pool.connect();
    let damaged = false;
    let connectionError: Error | undefined;
    // pg removes the pool's idle error listener while a client is checked out.
    // Capture errors between queries as well as rejected query promises.
    const onError = (error: Error) => { connectionError = error; damaged = true; };
    client.on('error', onError);
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const profiles = await load(client);
      if (connectionError) throw connectionError;
      await client.query('COMMIT');
      return profiles;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { damaged = true; }
      throw connectionError ?? error;
    } finally {
      client.release(damaged);
      client.removeListener('error', onError);
    }
  } catch (error) {
    if (isDatabaseUnavailable(error)) throw new AppError('DATABASE_UNAVAILABLE');
    throw error;
  }
}

export function createMatchingService(pool: Pool, ranking = { rankCandidates, rankJobs }) {
  return {
    async forJob(id: number) {
      const profiles = await snapshot(pool, async (client) => {
        const subject = await findJob(client, id);
        if (!subject) throw new AppError('JOB_NOT_FOUND');
        // Reuse ingestion's full profile validation without reading a fixture file.
        // Validate the subject before loading counterparts, even for an empty ranking.
        validateFixture({ candidates: [], jobs: [subject] });
        return validateFixture({ candidates: await allCandidates(client), jobs: [subject] });
      });
      const subject = profiles.jobs[0]!;
      return { subject, matches: ranking.rankCandidates(subject, profiles.candidates) };
    },
    async forCandidate(id: number) {
      const profiles = await snapshot(pool, async (client) => {
        const subject = await findCandidate(client, id);
        if (!subject) throw new AppError('CANDIDATE_NOT_FOUND');
        validateFixture({ candidates: [subject], jobs: [] });
        return validateFixture({ candidates: [subject], jobs: await allJobs(client) });
      });
      const subject = profiles.candidates[0]!;
      return { subject, matches: ranking.rankJobs(subject, profiles.jobs) };
    },
  };
}

export type MatchingService = ReturnType<typeof createMatchingService>;
