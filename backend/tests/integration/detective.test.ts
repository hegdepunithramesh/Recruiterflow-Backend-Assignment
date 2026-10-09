import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient, QueryResultRow } from 'pg';
import { loadDetective, readAnswers, runDetectiveAnswers, verifyDetective } from '../../src/detective/commands.js';
import { fixtureSnapshot, verifyDetectiveFixture } from '../../src/detective/fixture.js';
import { assertDetectiveTarget, detectiveConfig, DetectiveError, detectivePool } from '../../src/detective/support.js';

interface PersonRow { canonical_email: string | null; representative_name: string | null;
  applicant_ids: number[]; job_posting_ids: number[]; job_count: number }
interface RateRow { recruiter_id: number; recruiter_name: string; passed_final_interviews: number;
  total_final_interviews: number; conversion_rate: string }
interface WinnerRow { department: string | null; recruiter_id: number; recruiter_name: string; successful_placements: number }

const people: PersonRow[] = [
  { canonical_email: 'ananya.rao@mail.com', representative_name: 'Ananya Rao', applicant_ids: [1,2], job_posting_ids: [1,4], job_count: 2 },
  { canonical_email: 'ben.turner@mail.com', representative_name: 'Ben Turner', applicant_ids: [3], job_posting_ids: [1,3], job_count: 2 },
  { canonical_email: 'elena.popescu@mail.com', representative_name: 'Elena Popescu', applicant_ids: [6], job_posting_ids: [2,7], job_count: 2 },
];
const winners: WinnerRow[] = [
  { department: 'Data', recruiter_id: 3, recruiter_name: 'Fatima Al-Sayed', successful_placements: 1 },
  { department: 'Engineering', recruiter_id: 1, recruiter_name: 'Priya Shah', successful_placements: 3 },
];

void test('Phase 08 real PostgreSQL Detective answers and rollback-only edge cases', { timeout: 120000 }, async (t) => {
  // Missing connection fails visibly; never substitute a Bot URL or mock database.
  const pool = detectivePool(detectiveConfig(process.env));
  const resources: { client?: PoolClient } = {};
  t.after(async () => { resources.client?.release(); await pool.end(); });
  try { await loadDetective(pool); }
  catch (error) {
    if (error instanceof DetectiveError) throw error;
    throw new DetectiveError('DATABASE_OPERATION_FAILED', 'The separate Detective connection/setup is unavailable; live checks did not run.');
  }
  const queries = await readAnswers();
  const client = await pool.connect();
  resources.client = client;
  await assertDetectiveTarget(client);
  const baseline = await fixtureSnapshot(client);
  async function answer<Row extends QueryResultRow>(number: number) {
    return client.query<Row>(queries[number - 1]!);
  }
  async function trial(work: () => Promise<void>) {
    await client.query('BEGIN');
    try {
      await assertDetectiveTarget(client);
      await client.query('SET LOCAL search_path = public');
      await client.query('SELECT pg_advisory_xact_lock(190512, 8)');
      await work();
    } finally { await client.query('ROLLBACK'); }
    assert.deepEqual(await fixtureSnapshot(client), baseline);
    await verifyDetectiveFixture(client);
  }
  async function interview(id: number, applicant: number, posting: number, outcome: string | null) {
    await client.query('INSERT INTO public.interviews VALUES ($1,$2,$3,$4,$5,$6)',
      [id,applicant,posting,'Final','2026-03-01',outcome]);
  }
  function rate(row: RateRow | undefined, passed: number, total: number) {
    assert.ok(row);
    assert.equal(row.passed_final_interviews, passed);
    assert.equal(row.total_final_interviews, total);
    assert.ok(Math.abs(Number(row.conversion_rate) - passed / total) < 1e-12);
  }

  await t.test('exact source definitions/47 rows and no-op loader rerun', async () => {
    await verifyDetectiveFixture(client);
    assert.equal((await loadDetective(pool)).state, 'already_loaded');
    assert.deepEqual(await fixtureSnapshot(client), baseline);
    await verifyDetective(pool);
  });

  await t.test('SQL01 Q1 exact four open postings and owning recruiters', async () => {
    assert.deepEqual((await answer(1)).rows, [
      { job_posting_id: 1, title: 'Backend Engineer I', recruiter_id: 1, recruiter_name: 'Priya Shah' },
      { job_posting_id: 2, title: 'Backend Engineer I', recruiter_id: 2, recruiter_name: 'Daniel Ortiz' },
      { job_posting_id: 4, title: 'Backend Engineer II', recruiter_id: 1, recruiter_name: 'Priya Shah' },
      { job_posting_id: 5, title: 'DevOps Engineer', recruiter_id: 4, recruiter_name: 'Wei Zhang' },
    ]);
  });

  await t.test('SQL02 Q2 all seven postings and independent Final-applicant counts', async () => {
    assert.deepEqual((await answer(2)).rows, [
      { job_posting_id: 1, title: 'Backend Engineer I', final_applicant_count: 2 },
      { job_posting_id: 2, title: 'Backend Engineer I', final_applicant_count: 2 },
      { job_posting_id: 3, title: 'Data Analyst', final_applicant_count: 1 },
      { job_posting_id: 4, title: 'Backend Engineer II', final_applicant_count: 2 },
      { job_posting_id: 5, title: 'DevOps Engineer', final_applicant_count: 0 },
      { job_posting_id: 6, title: 'Data Analyst', final_applicant_count: 0 },
      { job_posting_id: 7, title: 'Backend Engineer I', final_applicant_count: 2 },
    ]);
  });

  await t.test('SQL03 repeated Finals count once; a second same-person applicant record counts separately', async () => {
    await trial(async () => {
      await interview(1000,1,1,'passed');
      assert.equal((await answer<{ final_applicant_count: number }>(2)).rows[0]?.final_applicant_count, 2);
    });
    await trial(async () => {
      await interview(1000,2,1,'passed');
      assert.equal((await answer<{ final_applicant_count: number }>(2)).rows[0]?.final_applicant_count, 3);
    });
  });

  await t.test('SQL04 Final applicants include passed/failed/no_show/pending without losing zero groups', async () => {
    await trial(async () => {
      for (const [i,outcome] of ['passed','failed','no_show',null].entries()) await interview(1000+i,1+i,5,outcome);
      const rows = (await answer<{ final_applicant_count: number }>(2)).rows;
      assert.equal(rows[4]?.final_applicant_count, 4);
      assert.equal(rows[5]?.final_applicant_count, 0);
    });
  });

  await t.test('SQL05 Q3 exactly Ananya, Ben and Elena with independent identity/posting lists', async () => {
    assert.deepEqual((await answer<PersonRow>(3)).rows, people);
  });

  await t.test('SQL06 trimmed/case-varied duplicate and unlinked record stay in one identity', async () => {
    await trial(async () => {
      await client.query('INSERT INTO public.applicants VALUES ($1,$2,$3,$4,$5),($6,$7,$8,$9,$10)',
        [1000,'Different display name','  ANANYA.RAO@mail.com  ',null,'2026-03-01',
          1001,'Unlinked display name','ananya.rao@mail.com',null,'2026-03-01']);
      await interview(1000,1000,1,'passed');
      assert.deepEqual((await answer<PersonRow>(3)).rows, [{ ...people[0], applicant_ids: [1,2,1000,1001] },people[1],people[2]]);
      assert.equal((await fixtureSnapshot(client) as { applicants: unknown[][] }).applicants[1]?.[2], 'Ananya.Rao@mail.com');
    });
  });

  await t.test('SQL07 unknown email identities and equal names cannot merge or borrow posting links', async () => {
    await trial(async () => {
      await client.query('INSERT INTO public.applicants VALUES ($1,$2,$3,$4,$5),($6,$7,$8,$9,$10),($11,$12,$13,$14,$15)',
        [1000,'Ananya Rao',null,null,'2026-03-01',1001,'Ananya Rao','   ',null,'2026-03-01',
          1002,'Ananya Rao','different@mail.com',null,'2026-03-01']);
      await interview(1000,1000,1,'passed'); await interview(1001,1000,2,'passed');
      await interview(1002,1001,1,'passed'); await interview(1003,1002,3,'passed');
      assert.deepEqual((await answer<PersonRow>(3)).rows, [...people,
        { canonical_email: null, representative_name: 'Ananya Rao', applicant_ids: [1000], job_posting_ids: [1,2], job_count: 2 }]);
    });
  });

  await t.test('SQL08 Q4 only Priya 3/4 and Daniel 2/4 with NUMERIC fractions', async () => {
    const result = await answer<RateRow>(4);
    assert.deepEqual(result.rows.map((row) => ({ ...row, conversion_rate: Number(row.conversion_rate) })), [
      { recruiter_id: 1, recruiter_name: 'Priya Shah', passed_final_interviews: 3, total_final_interviews: 4, conversion_rate: 0.75 },
      { recruiter_id: 2, recruiter_name: 'Daniel Ortiz', passed_final_interviews: 2, total_final_interviews: 4, conversion_rate: 0.5 },
    ]);
    assert.equal(result.fields.find((field) => field.name === 'conversion_rate')?.dataTypeID, 1700);
  });

  await t.test('SQL09 pending/no_show Finals enter denominator; pending Technical remains excluded', async () => {
    await trial(async () => {
      await interview(1000,1,1,null); rate((await answer<RateRow>(4)).rows[0],3,5);
    });
    await trial(async () => {
      await interview(1000,1,1,null); await interview(1001,1,1,'no_show');
      rate((await answer<RateRow>(4)).rows[0],3,6);
    });
  });

  await t.test('SQL10 threshold is three Finals inclusive, with no rounding of one third', async () => {
    await trial(async () => {
      await interview(1000,1,5,'passed'); await interview(1001,2,5,'failed');
      assert.ok(!(await answer<RateRow>(4)).rows.some((row) => row.recruiter_id === 4));
    });
    await trial(async () => {
      await interview(1000,1,5,'passed'); await interview(1001,2,5,'failed'); await interview(1002,3,5,null);
      rate((await answer<RateRow>(4)).rows.find((row) => row.recruiter_id === 4),1,3);
    });
  });

  await t.test('SQL11 duplicate passed Final counts as another interview in conversion', async () => {
    await trial(async () => { await interview(1000,1,1,'passed'); rate((await answer<RateRow>(4)).rows[0],4,5); });
  });

  await t.test('SQL12 Q5 exact Data/Engineering winners; Infrastructure has no success', async () => {
    assert.deepEqual((await answer<WinnerRow>(5)).rows, winners);
  });

  await t.test('SQL13 tied department winners are both returned by the window query', async () => {
    await trial(async () => {
      await client.query('INSERT INTO public.job_postings VALUES ($1,$2,$3,$4,$5,$6)', [1000,'Data Analyst',5,'Data','2026-03-01','closed']);
      await interview(1000,1,1000,'passed');
      assert.deepEqual((await answer<WinnerRow>(5)).rows, [winners[0],
        { department: 'Data', recruiter_id: 5, recruiter_name: 'Grace Okafor', successful_placements: 1 },winners[1]]);
    });
  });

  await t.test('SQL14 zero-success departments are omitted and NULL department wins without a fabricated name', async () => {
    await trial(async () => {
      await client.query('INSERT INTO public.job_postings VALUES ($1,$2,$3,$4,$5,$6)', [1000,'Support Engineer',5,'Support','2026-03-01','open']);
      await interview(1000,1,1000,'failed');
      assert.deepEqual((await answer<WinnerRow>(5)).rows, winners);
    });
    await trial(async () => {
      await client.query('INSERT INTO public.job_postings VALUES ($1,$2,$3,$4,$5,$6)', [1000,'Unassigned',5,null,'2026-03-01','closed']);
      await interview(1000,1,1000,'passed');
      assert.deepEqual((await answer<WinnerRow>(5)).rows, [...winners,
        { department: null, recruiter_id: 5, recruiter_name: 'Grace Okafor', successful_placements: 1 }]);
    });
  });

  await t.test('SQL15 repeated successful Final counts separately for placements', async () => {
    await trial(async () => {
      await interview(1000,3,3,'passed');
      assert.deepEqual((await answer<WinnerRow>(5)).rows, [{ ...winners[0], successful_placements: 2 },winners[1]]);
    });
  });

  await t.test('existing altered data/definition or extra table is rejected without cleanup', async () => {
    for (const sql of ["UPDATE public.applicants SET email = 'altered@mail.com' WHERE id = 2",
      'ALTER TABLE public.applicants ALTER COLUMN email SET NOT NULL',
      'CREATE TABLE public.phase08_unrelated (id INTEGER)']) {
      await trial(async () => {
        await client.query(sql);
        const before = await fixtureSnapshot(client);
        await assert.rejects(verifyDetectiveFixture(client), (error: unknown) => error instanceof DetectiveError && error.code === 'FIXTURE_MISMATCH');
        assert.deepEqual(await fixtureSnapshot(client), before);
      });
    }
  });

  await t.test('SQL16 offline answer runner executes every submitted query with unchanged fixture', async () => {
    const answers = await runDetectiveAnswers(pool);
    assert.deepEqual(answers.map((answer) => answer.rows.length), [4,7,3,2,2]);
    assert.deepEqual(await fixtureSnapshot(client), baseline);
  });
  await verifyDetectiveFixture(client);
});
