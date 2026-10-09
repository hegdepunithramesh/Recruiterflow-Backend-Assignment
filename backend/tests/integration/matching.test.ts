import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { PoolClient } from 'pg';
import { createApp } from '../../src/app.js';
import { createDatabase, DatabaseSchemaError } from '../../src/db.js';
import { startServer } from '../../src/lifecycle.js';
import type { LogEntry } from '../../src/logger.js';
import { createMatchingService } from '../../src/modules/matching/service.js';
import { rankJobs } from '../../src/modules/matching/policy.js';
import { assignmentFixture } from '../../src/storage/fixture.js';
import { migrate } from '../../src/storage/migrations.js';
import { seed } from '../../src/storage/seed.js';
import { assertTarget, storageConfig, storagePool, StorageError, writerTransaction } from '../../src/storage/support.js';
import { assertRestrictedRole, verifyDatabase } from '../../src/storage/verify.js';
import { serve } from '../helpers.js';

interface Entity { type: 'job' | 'candidate'; id: number; label: string; availability: string | null }
interface Match extends Entity { score: number; reason: string }
interface Body { policyVersion: string; subject: Entity; matches: Match[] }

// Independently worked fixture expectations: no policy functions provide the oracle.
const scores = [
  [100,20,20,20,20,20], [20,20,100,16,20,46.67], [20,100,20,46.67,20,20],
  [20,20,60,46.67,20,46.67], [20,20,20,20,46.67,46.67], [20,100,20,20,20,20],
  [20,20,100,12,15,46.67], [20,100,20,20,20,20], [46.67,20,60,20,20,20],
  [20,20,20,20,73.33,20], [20,20,60,46.67,20,73.33], [20,20,20,46.67,100,46.67],
  [20,20,60,46.67,20,46.67], [20,20,20,73.33,46.67,46.67], [20,20,20,20,46.67,73.33],
];
const jobOrders = [
  [1,9,2,3,4,5,6,7,8,10,11,12,13,14,15], [3,6,8,1,2,4,5,7,9,10,11,12,13,14,15],
  [2,7,4,9,11,13,1,3,5,6,8,10,12,14,15], [14,3,4,11,12,13,1,5,6,8,9,10,15,2,7],
  [12,10,5,14,15,1,2,3,4,6,8,9,11,13,7], [11,15,2,4,5,7,12,13,14,1,3,6,8,9,10],
];
const candidateOrders = [
  [1,2,3,4,5,6], [3,6,1,2,5,4], [2,4,1,3,5,6], [3,4,6,1,2,5], [5,6,1,2,3,4],
  [2,1,3,4,5,6], [3,6,1,2,5,4], [2,1,3,4,5,6], [3,1,2,4,5,6], [5,1,2,3,4,6],
  [6,3,4,1,2,5], [5,4,6,1,2,3], [3,4,6,1,2,5], [4,5,6,1,2,3], [6,5,1,2,3,4],
];

void test('Phase 07 real PostgreSQL HTTP matching on the disposable database only', { timeout: 120000 }, async (t) => {
  const config = storageConfig(process.env, true);
  const admin = storagePool(config.adminUrl);
  const appConfig = { databaseUrl: config.runtimeUrl, port: 0, nodeEnv: 'test' as const };
  const logs: LogEntry[] = [];
  const database = createDatabase(appConfig, (entry) => { logs.push(entry); }, config.database);
  t.after(async () => { await Promise.all([admin.end(), database.close()]); });
  const preflight = await admin.connect();
  try {
    await assertTarget(preflight, 'recruiter_bot_phase05_test', true);
    await assertRestrictedRole(preflight);
    const tables = await preflight.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    if (tables.rows.length !== 0 && tables.rows.map((row) => row.tablename).join(',') !==
      'candidate_skills,candidates,job_skills,jobs,schema_migrations,skills') {
      throw new StorageError('DISPOSABLE_NOT_CLEAN', 'Use the dedicated empty test database or its verified baseline.');
    }
  } finally { preflight.release(); }
  await migrate(admin, config.database);
  await seed(admin, config.database);
  const baseline = await verifyDatabase(admin, database.pool, config.database);
  assert.deepEqual(baseline.totals, { candidates: 15, jobs: 6, skills: 27, candidate_skills: 50, job_skills: 16 });
  await database.checkReady();

  const queries: { sql: string; values: unknown[] | undefined; client: PoolClient }[] = [];
  let barrier: ((sql: string, client: PoolClient) => Promise<void>) | undefined;
  // Observe actual driver queries; forwarding always executes real SQL on the runtime login.
  const observe = (client: PoolClient) => {
    const query = client.query.bind(client);
    mock.method(client, 'query', async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values, client });
      const result = await query(sql, values);
      await barrier?.(sql, client);
      return result;
    });
  };
  for (const client of (await Promise.all([database.pool.connect(), database.pool.connect()]))) {
    observe(client); client.release();
  }
  database.pool.on('connect', observe);
  const http = await serve(createApp(database, (entry) => { logs.push(entry); }, createMatchingService(database.pool)));
  t.after(() => http.close());
  const fixture = await assignmentFixture();
  const dataReads = () => queries.filter(({ sql }) => sql.startsWith('SELECT'));
  async function get(path: string, status = 200) {
    queries.length = 0;
    const response = await fetch(`${http.url}${path}`, { headers: { 'X-Request-Id': 'untrusted-secret-token' } });
    assert.equal(response.status, status);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(database.pool.waitingCount, 0);
    assert.equal(database.pool.idleCount, database.pool.totalCount);
    return response;
  }
  async function success(path: string): Promise<Body> { return await (await get(path)).json() as Body; }
  const messages = {
    INVALID_ID: 'id must be a positive integer between 1 and 2147483647 without leading zeros.',
    INVALID_QUERY: 'Query parameters are not supported.', JOB_NOT_FOUND: 'Job not found.',
    CANDIDATE_NOT_FOUND: 'Candidate not found.', ROUTE_NOT_FOUND: 'Route not found.',
    DATABASE_UNAVAILABLE: 'Matching is temporarily unavailable. Please try again later.',
    INTERNAL_ERROR: 'An unexpected error occurred.', DATABASE_NOT_READY: 'Database is not ready.',
  };
  async function failure(path: string, status: number, code: keyof typeof messages) {
    const response = await get(path, status);
    assert.deepEqual(await response.json(), { error: { code, message: messages[code], requestId: response.headers.get('x-request-id') } });
    assert.ok(logs.some((entry) => entry.event === 'http_request' && entry.requestId === response.headers.get('x-request-id')
      && entry.status === status && entry.code === code));
  }
  async function variant(setup: (client: PoolClient) => Promise<void>, check: () => Promise<void>) {
    try { await writerTransaction(admin, config.database, setup); await check(); }
    finally { await seed(admin, config.database); await verifyDatabase(admin, database.pool, config.database); }
  }

  await t.test('API01/02/08/14/15/16 all 90 independently expected pairs in both HTTP directions', async () => {
    const pairs = new Map<string, { score: number; reason: string }>();
    for (const job of fixture.jobs) {
      const body = await success(`/jobs/${job.id}/matches`);
      assert.deepEqual(Object.keys(body).sort(), ['matches','policyVersion','subject']);
      assert.equal(body.policyVersion, 'v1');
      assert.deepEqual(body.subject, { type: 'job', id: job.id, label: job.title, availability: null });
      assert.deepEqual(body.matches.map((match) => match.id), jobOrders[job.id - 1]);
      assert.equal(dataReads().length, 2);
      assert.equal(new Set(queries.map(({ client }) => client)).size, 1);
      assert.equal(queries[0]?.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      assert.equal(queries.at(-1)?.sql, 'COMMIT');
      assert.deepEqual(dataReads()[0]?.values, [job.id]);
      for (const match of body.matches) {
        const person = fixture.candidates[match.id - 1]!;
        const overlap = job.skills.filter((skill) => person.skills.includes(skill)).length;
        const reason = `Matched ${overlap} of ${job.skills.length} required skills; ${person.experience_years} years experience ${person.experience_years >= job.min_experience_years ? 'meets' : 'is below'} the ${job.min_experience_years}-year minimum.`;
        assert.deepEqual(match, { type: 'candidate', id: person.id, label: person.name, availability: person.availability,
          score: scores[person.id - 1]?.[job.id - 1], reason });
        pairs.set(`${person.id}/${job.id}`, { score: match.score, reason });
      }
      assert.deepEqual(await success(`/jobs/${job.id}/matches`), body);
    }
    for (const person of fixture.candidates) {
      const body = await success(`/candidates/${person.id}/matches`);
      assert.deepEqual(Object.keys(body).sort(), ['matches','policyVersion','subject']);
      assert.equal(body.policyVersion, 'v1');
      assert.deepEqual(body.subject, { type: 'candidate', id: person.id, label: person.name, availability: person.availability });
      assert.deepEqual(body.matches.map((match) => match.id), candidateOrders[person.id - 1]);
      assert.equal(dataReads().length, 2);
      for (const match of body.matches) {
        const job = fixture.jobs[match.id - 1]!;
        assert.deepEqual(match, { type: 'job', id: job.id, label: job.title, availability: null,
          ...pairs.get(`${person.id}/${job.id}`) });
      }
      assert.deepEqual(await success(`/candidates/${person.id}/matches`), body);
    }
    assert.equal(pairs.size, 90);
  });

  await t.test('API03/05 malformed IDs and unsupported queries fail before any database access', async () => {
    for (const route of ['jobs', 'candidates']) {
      for (const id of ['0','-1','01','+1','1.5','1e2','abc','%201','1%20','%EF%BC%91','2147483648','9'.repeat(100),
        encodeURIComponent("1'; DROP TABLE candidates;--")]) {
        await failure(`/${route}/${id}/matches`, 400, 'INVALID_ID');
        assert.equal(queries.length, 0);
      }
      for (const query of ['limit=1','x=','id=1&id=2','__proto__=secret']) {
        await failure(`/${route}/1/matches?${query}`, 400, 'INVALID_QUERY');
        assert.equal(queries.length, 0);
      }
      await failure(`/${route}/01/matches?limit=1`, 400, 'INVALID_ID');
      assert.equal(queries.length, 0);
    }
  });

  await t.test('API04/06 valid absent subjects stop after one SELECT; unmatched paths use 404', async () => {
    for (const [route, code] of [['jobs','JOB_NOT_FOUND'], ['candidates','CANDIDATE_NOT_FOUND']] as const) {
      await failure(`/${route}/2147483647/matches`, 404, code);
      assert.equal(dataReads().length, 1);
      assert.equal(queries.at(-1)?.sql, 'ROLLBACK');
      await failure(`/${route}//matches`, 404, 'ROUTE_NOT_FOUND');
      assert.equal(queries.length, 0);
    }
    await failure('/unsupported', 404, 'ROUTE_NOT_FOUND');
  });

  await t.test('API07 existing subjects with empty counterpart tables return exact empty bodies', async () => {
    await variant(async (client) => { await client.query('DELETE FROM public.candidates'); }, async () => {
      assert.deepEqual(await success('/jobs/1/matches'), { policyVersion: 'v1',
        subject: { type: 'job', id: 1, label: 'Backend Detective', availability: null }, matches: [] });
      assert.equal(dataReads().length, 2);
    });
    await variant(async (client) => { await client.query('DELETE FROM public.jobs'); }, async () => {
      assert.deepEqual(await success('/candidates/1/matches'), { policyVersion: 'v1',
        subject: { type: 'candidate', id: 1, label: 'Sherlock H.', availability: 'Immediate' }, matches: [] });
      assert.equal(dataReads().length, 2);
    });
  });

  await t.test('left joins retain a zero-skill candidate including a genuine zero score', async () => {
    await variant(async (client) => {
      await client.query('DELETE FROM public.candidate_skills WHERE candidate_id = $1', [1]);
      await client.query('UPDATE public.candidates SET experience_years = $1 WHERE id = $2', [0,1]);
    }, async () => {
      const match = (await success('/jobs/1/matches')).matches.find((match) => match.id === 1);
      assert.equal(match?.score, 0);
      assert.equal(match?.reason, 'Matched 0 of 3 required skills; 0 years experience is below the 3-year minimum.');
      const reverse = await success('/candidates/1/matches');
      assert.equal(reverse.matches.length, 6);
      assert.ok(reverse.matches.every((match) => match.score === 0));
    });
  });

  await t.test('API09 raw-score ordering survives equal displayed scores', async () => {
    await variant(async (client) => {
      await client.query('UPDATE public.jobs SET min_experience_years = $1 WHERE id = $2', [2147483647,1]);
      await client.query('DELETE FROM public.candidate_skills WHERE candidate_id = $1', [2]);
      await client.query('INSERT INTO public.candidate_skills SELECT $1, skill_id FROM public.candidate_skills WHERE candidate_id = $2', [2,1]);
      await client.query('UPDATE public.candidates SET experience_years = $1 WHERE id = $2', [9,2]);
    }, async () => {
      const body = await success('/jobs/1/matches');
      assert.deepEqual(body.matches.slice(0,2).map(({ id, score }) => ({ id, score })), [{ id: 2, score: 80 }, { id: 1, score: 80 }]);
      assert.deepEqual(await success('/jobs/1/matches'), body);
    });
  });

  await t.test('API13 invalid job subject/counterpart fails rather than returning an empty/partial success', async () => {
    await variant(async (client) => {
      await client.query('DELETE FROM public.job_skills WHERE job_id = $1', [1]);
      await client.query('DELETE FROM public.candidates');
    }, async () => {
      await failure('/jobs/1/matches', 500, 'INTERNAL_ERROR');
      assert.equal(dataReads().length, 1);
    });
    await variant(async (client) => { await client.query('DELETE FROM public.job_skills WHERE job_id = $1', [1]); }, async () => {
      await failure('/candidates/1/matches', 500, 'INTERNAL_ERROR');
      assert.equal(dataReads().length, 2);
    });
  });

  await t.test('DB17 a concurrent commit is invisible within the request snapshot and visible next time', async () => {
    try {
      barrier = async (sql) => {
        if (!sql.includes('WHERE j.id = $1')) return;
        barrier = undefined;
        await writerTransaction(admin, config.database, async (client) => {
          await client.query('UPDATE public.candidates SET experience_years = $1 WHERE id = $2', [0,1]);
        });
      };
      const first = await success('/jobs/1/matches');
      assert.equal(first.matches.find((match) => match.id === 1)?.score, 100);
      const next = await success('/jobs/1/matches');
      assert.equal(next.matches.find((match) => match.id === 1)?.score, 80);
      assert.equal(next.matches.find((match) => match.id === 1)?.reason,
        'Matched 3 of 3 required skills; 0 years experience is below the 3-year minimum.');
    } finally { barrier = undefined; await seed(admin, config.database); }
  });

  await t.test('API10 terminating a real runtime connection returns safe 503 and the pool recovers', async () => {
    try {
      barrier = async (sql, client) => {
        if (!sql.includes('WHERE j.id = $1')) return;
        barrier = undefined;
        const pid = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        await admin.query('SELECT pg_terminate_backend($1)', [pid.rows[0]?.pid]);
      };
      await failure('/jobs/1/matches', 503, 'DATABASE_UNAVAILABLE');
    } finally { barrier = undefined; }
    assert.equal((await success('/jobs/1/matches')).matches.length, 15);
  });

  await t.test('API11 real pool exhaustion and blocked SELECT timeout return safe 503', async () => {
    const held = await Promise.all(Array.from({ length: 5 }, () => database.pool.connect()));
    try {
      // All five clients are deliberately held, so get()'s idle-client assertion is inapplicable here.
      const response = await fetch(`${http.url}/candidates/1/matches`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: { code: 'DATABASE_UNAVAILABLE',
        message: messages.DATABASE_UNAVAILABLE, requestId: response.headers.get('x-request-id') } });
      assert.equal(database.pool.waitingCount, 0);
      assert.equal(database.pool.totalCount, 5);
    } finally { held.forEach((client) => { client.release(); }); }
    const lock = await admin.connect();
    try {
      await assertTarget(lock, config.database, true);
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE public.candidates IN ACCESS EXCLUSIVE MODE');
      await failure('/jobs/1/matches', 503, 'DATABASE_UNAVAILABLE');
      assert.equal(queries.at(-1)?.sql, 'ROLLBACK');
    } finally { await lock.query('ROLLBACK'); lock.release(); }
    assert.equal((await success('/candidates/1/matches')).matches.length, 6);
  });

  await t.test('API12/17 real missing table is a safe 500; readiness/startup fail without schema writes', async () => {
    try {
      await writerTransaction(admin, config.database, async (client) => {
        await client.query('ALTER TABLE public.candidates RENAME TO phase07_hidden_candidates');
      });
      await failure('/jobs/1/matches', 500, 'INTERNAL_ERROR');
      await failure('/candidates/1/matches', 500, 'INTERNAL_ERROR');
      await failure('/ready', 503, 'DATABASE_NOT_READY');
      const broken = createDatabase(appConfig, () => {}, config.database);
      await assert.rejects(startServer(appConfig, broken, () => {}, createMatchingService(broken.pool)), DatabaseSchemaError);
      assert.equal(broken.pool.totalCount, 0);
    } finally {
      await writerTransaction(admin, config.database, async (client) => {
        await client.query('ALTER TABLE public.phase07_hidden_candidates RENAME TO candidates');
      });
    }
    await database.checkReady();
    assert.equal((await success('/jobs/1/matches')).matches.length, 15);
  });

  await t.test('API12 unexpected scorer failure after real reads is safe 500 with the client already released', async () => {
    const faulted = createMatchingService(database.pool, {
      rankJobs,
      rankCandidates() {
        assert.equal(database.pool.idleCount, database.pool.totalCount);
        throw new Error('private scorer stack or SQL details');
      },
    });
    const isolated = await serve(createApp(database, (entry) => { logs.push(entry); }, faulted));
    try {
      queries.length = 0;
      const response = await fetch(`${isolated.url}/jobs/1/matches`);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: { code: 'INTERNAL_ERROR', message: messages.INTERNAL_ERROR,
        requestId: response.headers.get('x-request-id') } });
      assert.equal(dataReads().length, 2);
      assert.equal(queries.at(-1)?.sql, 'COMMIT');
    } finally { await isolated.close(); }
  });

  await t.test('runtime read permission loss fails readiness/startup and produces a safe matching failure', async () => {
    try {
      await writerTransaction(admin, config.database, async (client) => {
        await client.query('REVOKE SELECT ON public.jobs FROM recruiter_bot_app');
      });
      await failure('/ready', 503, 'DATABASE_NOT_READY');
      await failure('/candidates/1/matches', 500, 'INTERNAL_ERROR');
      const broken = createDatabase(appConfig, () => {}, config.database);
      await assert.rejects(startServer(appConfig, broken, () => {}, createMatchingService(broken.pool)), DatabaseSchemaError);
    } finally {
      await writerTransaction(admin, config.database, async (client) => {
        await client.query('GRANT SELECT ON public.jobs TO recruiter_bot_app');
      });
    }
    await database.checkReady();
  });

  await t.test('safe logs use generated request IDs and route templates without user/driver/SQL details', () => {
    const serialized = JSON.stringify(logs);
    assert.doesNotMatch(serialized, /untrusted-secret-token|DROP TABLE|postgresql?:|password|SELECT|terminated|hidden_candidates|limit=|__proto__/i);
    assert.ok(logs.some((entry) => entry.event === 'http_request' && entry.route === '/jobs/:id/matches' && entry.code === 'INVALID_ID'));
    assert.ok(logs.some((entry) => entry.event === 'http_request' && entry.route === '/candidates/:id/matches' && entry.code === 'DATABASE_UNAVAILABLE'));
  });
  await verifyDatabase(admin, database.pool, config.database);
});
