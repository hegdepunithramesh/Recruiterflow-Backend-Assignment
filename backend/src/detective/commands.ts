import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { assertBotIsolation, assertDetectiveTarget, DetectiveError } from './support.js';
import { publicObjects, tableNames, verifyDetectiveFixture } from './fixture.js';

export async function detectiveTransaction<T>(pool: Pool, readOnly: boolean,
  work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let damaged = false;
  let connectionError: Error | undefined;
  const onError = (error: Error) => { connectionError = error; damaged = true; };
  client.on('error', onError);
  try {
    await assertDetectiveTarget(client);
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    // Original CREATE TABLE statements are unqualified: public must be the creation
    // namespace. PostgreSQL still searches pg_catalog implicitly before public.
    await client.query('SET LOCAL search_path = public');
    await assertBotIsolation(client);
    const result = await work(client);
    if (connectionError) throw connectionError;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { damaged = true; }
    throw connectionError ?? error;
  } finally {
    client.release(damaged);
    client.removeListener('error', onError);
  }
}

export async function loadDetective(pool: Pool) {
  const sql = await readFile(new URL('../../sql/detective/setup.sql', import.meta.url), 'utf8');
  return detectiveTransaction(pool, false, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(190512, 8)');
    const existing = await publicObjects(client);
    const fresh = existing.length === 0;
    if (!fresh && existing.map((row) => row.name).join(',') !== tableNames.join(',')) {
      throw new DetectiveError('FIXTURE_MISMATCH', 'Use an empty sql_detective database or its exact supplied fixture. No reset or cleanup is performed.');
    }
    if (fresh) await client.query(sql);
    else await client.query('LOCK TABLE public.recruiters, public.job_postings, public.applicants, public.interviews IN SHARE MODE');
    const result = await verifyDetectiveFixture(client);
    return { state: fresh ? 'loaded' : 'already_loaded', ...result };
  });
}

export async function readAnswers(): Promise<string[]> {
  const sql = await readFile(new URL('../../sql_detective.sql', import.meta.url), 'utf8');
  const numbers = [...sql.matchAll(/^-- Question ([1-5])\b/gm)].map((match) => Number(match[1]));
  const queries = sql.replace(/^--.*$/gm, '').split(';').map((query) => query.trim()).filter(Boolean);
  if (numbers.join(',') !== '1,2,3,4,5' || queries.length !== 5 || queries.some((query) => !/^(SELECT|WITH)\b/.test(query))) {
    throw new DetectiveError('ANSWER_FILE', 'Keep exactly five numbered read-only queries in sql_detective.sql.');
  }
  return queries;
}

export async function verifyDetective(pool: Pool) {
  return detectiveTransaction(pool, true, (client) => verifyDetectiveFixture(client));
}

export async function runDetectiveAnswers(pool: Pool) {
  const queries = await readAnswers();
  return detectiveTransaction(pool, true, async (client) => {
    await verifyDetectiveFixture(client);
    const answers: { question: number; rows: unknown[] }[] = [];
    for (const [index, query] of queries.entries()) {
      answers.push({ question: index + 1, rows: (await client.query(query)).rows as unknown[] });
    }
    return answers;
  });
}
