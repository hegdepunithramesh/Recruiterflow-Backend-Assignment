import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Fixture } from '../src/storage/fixture.js';
import { displayScore, MatchingInputError, policyVersion, rankCandidates, rankJobs, scorePair,
  type CandidateProfile, type JobProfile } from '../src/modules/matching/policy.js';

const fixture = JSON.parse(await readFile(new URL('../data/assignment.json', import.meta.url), 'utf8')) as Fixture;
const candidate = (skills: readonly string[] = ['a'], experience_years = 4, id = 1): CandidateProfile =>
  ({ id, name: `Candidate ${id}`, skills, experience_years, availability: 'Immediate' });
const job = (skills: readonly string[] = ['a'], min_experience_years = 2, id = 1): JobProfile =>
  ({ id, title: `Job ${id}`, skills, min_experience_years });
const suppliedCandidate = (id: number) => { const row = fixture.candidates.find((row) => row.id === id); assert.ok(row); return row; };
const suppliedJob = (id: number) => { const row = fixture.jobs.find((row) => row.id === id); assert.ok(row); return row; };

// Literal expectations come from policy examples, not from a second scorer.
for (const [label, person, position, expected, raw, reason] of [
  ['Sherlock / Backend Detective', suppliedCandidate(1), suppliedJob(1), 100, 100,
    'Matched 3 of 3 required skills; 8 years experience meets the 3-year minimum.'],
  ['Sheldon / Backend Detective', suppliedCandidate(9), suppliedJob(1), 46.67, 140 / 3,
    'Matched 1 of 3 required skills; 9 years experience meets the 3-year minimum.'],
  ['Hermione / Chaos Team', suppliedCandidate(2), suppliedJob(4), 16, 16,
    'Matched 0 of 3 required skills; 4 years experience is below the 5-year minimum.'],
  ['Tony / Rapid Prototyping', suppliedCandidate(3), suppliedJob(2), 100, 100,
    'Matched 2 of 2 required skills; 12 years experience meets the 2-year minimum.'],
  ['hypothetical below minimum', candidate(['a', 'b'], 1), job(['a', 'b', 'c'], 4), 58.33, 175 / 3,
    'Matched 2 of 3 required skills; 1 year experience is below the 4-year minimum.'],
  ['hypothetical zero minimum', candidate(['a'], 0), job(['a', 'b'], 0), 60, 60,
    'Matched 1 of 2 required skills; 0 years experience meets the 0-year minimum.'],
  ['hypothetical empty candidate skills', candidate([], 3), job(['a', 'b'], 2), 20, 20,
    'Matched 0 of 2 required skills; 3 years experience meets the 2-year minimum.'],
] as const) {
  void test(`M01 documented example: ${label}`, () => {
    const result = scorePair(person, position);
    assert.equal(result.score, expected);
    assert.ok(Math.abs(result.rawScore - raw) < 1e-12);
    assert.equal(result.reason, reason);
    assert.equal(policyVersion, 'v1');
  });
}

void test('M02 no, partial and complete required-skill overlap', () => {
  for (const [skills, expected, matched] of [[[], 20, 0], [['a'], 60, 1], [['a', 'b'], 100, 2]] as const) {
    const result = scorePair(candidate(skills, 2), job(['a', 'b'], 2));
    assert.equal(result.score, expected);
    assert.equal(result.matchedSkillCount, matched);
    assert.equal(result.requiredSkillCount, 2);
    assert.equal(result.experienceFit, 1);
  }
});

void test('M03 extra candidate skills do not penalize coverage or change reasons', () => {
  const base = scorePair(candidate(['a', 'b']), job(['a', 'b']));
  const extra = scorePair(candidate(['a', 'b', 'unrelated', 'another']), job(['a', 'b']));
  assert.equal(base.score, 100);
  assert.deepEqual(extra, base);
});

void test('M04 experience is partial below the minimum and capped at/above it', () => {
  for (const [years, expected, fit] of [[0, 80, 0], [1, 85, 0.25], [4, 100, 1], [10, 100, 1]] as const) {
    const result = scorePair(candidate(['a'], years), job(['a'], 4));
    assert.equal(result.score, expected);
    assert.equal(result.experienceFit, fit);
  }
});

void test('M05 zero minimum is met at zero years for partial and full coverage', () => {
  assert.equal(scorePair(candidate(['a'], 0), job(['a', 'b'], 0)).score, 60);
  assert.equal(scorePair(candidate(['a', 'b'], 0), job(['a', 'b'], 0)).score, 100);
});

void test('M06 empty candidate skills allow zero-score pairs and experience-only credit', () => {
  assert.equal(scorePair(candidate([], 3), job(['a', 'b'], 2)).score, 20);
  assert.equal(scorePair(candidate([], 0), job(['a', 'b'], 2)).score, 0);
  assert.equal(scorePair(candidate([], 0), job(['a', 'b'], 0)).score, 20);
});

void test('M07 empty required skills fail rather than yielding a score or being skipped', () => {
  assert.throws(() => scorePair(candidate(), job([])), MatchingInputError);
  assert.throws(() => rankCandidates(job([]), []), MatchingInputError);
  assert.throws(() => rankJobs(candidate(), [job(), job([], 2, 2)]), MatchingInputError);
});

void test('M08 trim/lowercase/deduplicate both sides before counting', () => {
  const result = scorePair(candidate([' Deduction ', 'DEDUCTION', '\tpattern-recognition\n']),
    job(['deduction', '\tdeduction\n', 'forensics']));
  assert.equal(result.score, 60);
  assert.equal(result.matchedSkillCount, 1);
  assert.equal(result.requiredSkillCount, 2);
});

void test('M09 internal spaces/hyphens are exact; no synonym or whitespace rewriting', () => {
  assert.equal(scorePair(candidate(['public speaking']), job(['public-speaking'])).score, 20);
  assert.equal(scorePair(candidate(['public-speaking']), job(['public-speaking'])).score, 100);
  assert.equal(scorePair(candidate(['public  speaking']), job(['public speaking'])).score, 20);
  assert.equal(scorePair(candidate(['investigation']), job(['deduction'])).score, 20);
});

for (const [label, skills] of [
  ['missing list', undefined], ['null list', null], ['string list', 'a'], ['object list', {}],
  ['null entry', [null]], ['numeric entry', [1]], ['empty entry', ['']], ['blank entry', [' \t\n']],
  ['missing entry', ['a', undefined]], ['nested entry', [['a']]], ['sparse list', Array<unknown>(1)],
  ['NUL entry', ['a\0']],
] as const) {
  void test(`M10 invalid skills on either side: ${label}`, () => {
    assert.throws(() => scorePair({ ...candidate(), skills } as unknown as CandidateProfile, job()), MatchingInputError);
    assert.throws(() => scorePair(candidate(), { ...job(), skills } as unknown as JobProfile), MatchingInputError);
  });
}

for (const [label, years] of [
  ['negative', -1], ['fractional', 1.5], ['NaN', NaN], ['positive infinity', Infinity],
  ['negative infinity', -Infinity], ['null', null], ['missing', undefined], ['numeric text', '2'],
  ['outside INTEGER', 2147483648],
] as const) {
  void test(`M11 invalid experience on either side: ${label}`, () => {
    assert.throws(() => scorePair({ ...candidate(), experience_years: years } as unknown as CandidateProfile, job()), MatchingInputError);
    assert.throws(() => scorePair(candidate(), { ...job(), min_experience_years: years } as unknown as JobProfile), MatchingInputError);
  });
}

void test('M11 invalid profile shapes fail with the domain error; INTEGER maximum remains valid', () => {
  for (const invalid of [null, undefined, [], 'profile', {}]) {
    assert.throws(() => scorePair(invalid as CandidateProfile, job()), MatchingInputError);
    assert.throws(() => scorePair(candidate(), invalid as JobProfile), MatchingInputError);
  }
  assert.equal(scorePair(candidate(['a'], 2147483647), job(['a'], 2147483647)).score, 100);
});

void test('M12 metadata/availability never affect scores; unavailable candidates remain visible', () => {
  const original = suppliedCandidate(3);
  const position = suppliedJob(2);
  const altered = { ...original, name: 'Different label', availability: 'Immediate' as const,
    traits: ['different'], quirk: 'Different quirk' };
  const alteredJob = { ...position, title: 'Different title', culture_keywords: ['different'], tagline: 'Different tagline' };
  assert.deepEqual(scorePair(altered, alteredJob), scorePair(original, position));
  const ranked = rankCandidates(position, [original]);
  assert.equal(ranked[0]?.candidate.availability, 'Not looking');
  assert.equal(ranked[0]?.candidate.name, 'Tony S.');
  assert.equal(ranked[0]?.match.score, 100);
  assert.equal(rankJobs(original, [position])[0]?.match.score, 100);
});

void test('M13 fixture ties use candidate IDs; output retains every counterpart', () => {
  const result = rankCandidates(suppliedJob(2), [...fixture.candidates].reverse());
  assert.deepEqual(result.slice(0, 3).map((row) => row.candidate.id), [3, 6, 8]);
  assert.deepEqual(result.slice(0, 3).map((row) => row.match.score), [100, 100, 100]);
  assert.equal(result.length, 15);
});

void test('M14 coverage breaks an equal raw-score tie before ID in both directions', () => {
  const candidates = rankCandidates(job(['a', 'b', 'c', 'd'], 4),
    [candidate(['a', 'b', 'c'], 4, 10), candidate(['a', 'b', 'c', 'd'], 0, 20)]);
  assert.deepEqual(candidates.map((row) => row.match.rawScore), [80, 80]);
  assert.deepEqual(candidates.map((row) => row.candidate.id), [20, 10]);
  const jobs = rankJobs(candidate(['a', 'b', 'c'], 0),
    [job(['a', 'b', 'c', 'd'], 0, 10), job(['a', 'b', 'c'], 4, 20)]);
  assert.deepEqual(jobs.map((row) => row.match.rawScore), [80, 80]);
  assert.deepEqual(jobs.map((row) => row.job.id), [20, 10]);
});

void test('M15 raw scores order both directions even when display scores are identical', () => {
  const candidates = rankCandidates(job(['a'], 10000), [candidate(['a'], 1, 10), candidate(['a'], 2, 20)]);
  assert.deepEqual(candidates.map((row) => row.candidate.id), [20, 10]);
  assert.deepEqual(candidates.map((row) => row.match.rawScore), [80.004, 80.002]);
  assert.deepEqual(candidates.map((row) => row.match.score), [80, 80]);
  const jobs = rankJobs(candidate(['a'], 1), [job(['a'], 10000, 10), job(['a'], 5000, 20)]);
  assert.deepEqual(jobs.map((row) => row.job.id), [20, 10]);
  assert.deepEqual(jobs.map((row) => row.match.score), [80, 80]);
});

void test('M15 no epsilon tie: a tiny finite raw difference wins before lower ID', () => {
  const result = rankCandidates(job(['a'], 2147483647), [candidate(['a'], 0, 1), candidate(['a'], 1, 2)]);
  assert.deepEqual(result.map((row) => row.candidate.id), [2, 1]);
  assert.equal(result[0]?.match.score, result[1]?.match.score);
});

void test('M16 decimal half-up boundaries, scientific notation and range guards', () => {
  for (const [raw, expected] of [[42.3449, 42.34], [42.345, 42.35], [42.3451, 42.35],
    [42.34499999999999, 42.34], [1.005, 1.01], [2.675, 2.68], [0.005, 0.01],
    [0.004999999999999999, 0], [1e-7, 0], [Number.MIN_VALUE, 0], [99.995, 100], [0, 0], [100, 100]] as const) {
    assert.equal(displayScore(raw), expected);
  }
  for (const invalid of [-0.01, 100.01, NaN, Infinity]) assert.throws(() => displayScore(invalid), MatchingInputError);
});

void test('M17 reason grammar for one year, exact minimum, below minimum and zero minimum', () => {
  assert.equal(scorePair(candidate(['a', 'b'], 1), job(['a', 'b', 'c'], 4)).reason,
    'Matched 2 of 3 required skills; 1 year experience is below the 4-year minimum.');
  assert.equal(scorePair(candidate(['a'], 1), job(['a'], 1)).reason,
    'Matched 1 of 1 required skills; 1 year experience meets the 1-year minimum.');
  assert.equal(scorePair(candidate([], 0), job(['a'], 0)).reason,
    'Matched 0 of 1 required skills; 0 years experience meets the 0-year minimum.');
  assert.equal(scorePair(candidate(['a'], 4), job(['a'], 4)).reason,
    'Matched 1 of 1 required skills; 4 years experience meets the 4-year minimum.');
});

void test('M18 all 90 supplied pair scores agree with an independently calculated literal matrix', () => {
  // Rows: PDF candidate IDs 1–15; columns: PDF job IDs 1–6.
  const expected = [
    [100, 20, 20, 20, 20, 20],
    [20, 20, 100, 16, 20, 46.67],
    [20, 100, 20, 46.67, 20, 20],
    [20, 20, 60, 46.67, 20, 46.67],
    [20, 20, 20, 20, 46.67, 46.67],
    [20, 100, 20, 20, 20, 20],
    [20, 20, 100, 12, 15, 46.67],
    [20, 100, 20, 20, 20, 20],
    [46.67, 20, 60, 20, 20, 20],
    [20, 20, 20, 20, 73.33, 20],
    [20, 20, 60, 46.67, 20, 73.33],
    [20, 20, 20, 46.67, 100, 46.67],
    [20, 20, 60, 46.67, 20, 46.67],
    [20, 20, 20, 73.33, 46.67, 46.67],
    [20, 20, 20, 20, 46.67, 73.33],
  ];
  for (const person of fixture.candidates) {
    for (const position of fixture.jobs) {
      const result = scorePair(person, position);
      assert.equal(result.score, expected[person.id - 1]?.[position.id - 1], `candidate ${person.id}, job ${position.id}`);
      assert.ok(Number.isFinite(result.rawScore) && result.rawScore >= 0 && result.rawScore <= 100);
      assert.ok(result.skillCoverage >= 0 && result.skillCoverage <= 1);
      assert.ok(result.experienceFit >= 0 && result.experienceFit <= 1);
      assert.deepEqual(scorePair(person, position), result);
      const forward = rankCandidates(position, fixture.candidates).find((row) => row.candidate.id === person.id);
      const reverse = rankJobs(person, fixture.jobs).find((row) => row.job.id === position.id);
      assert.deepEqual(forward?.match, result);
      assert.deepEqual(reverse?.match, result);
    }
  }
});

void test('documented complete rankings agree without requiring HTTP endpoints', () => {
  const candidates = rankCandidates(suppliedJob(1), [...fixture.candidates].reverse());
  assert.deepEqual(candidates.map((row) => row.candidate.id), [1, 9, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(candidates.map((row) => row.match.score), [100, 46.67, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20]);
  const jobs = rankJobs(suppliedCandidate(1), [...fixture.jobs].reverse());
  assert.deepEqual(jobs.map((row) => row.job.id), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(jobs.map((row) => row.match.score), [100, 20, 20, 20, 20, 20]);
});

void test('ranking uses ID after raw score/coverage, regardless of names or input order', () => {
  const people = [{ ...candidate(['a'], 4, 20), name: 'A' }, { ...candidate(['a'], 4, 10), name: 'Z' }];
  assert.deepEqual(rankCandidates(job(), people).map((row) => row.candidate.id), [10, 20]);
  assert.deepEqual(rankCandidates(job(), [...people].reverse()).map((row) => row.candidate.id), [10, 20]);
  const positions = [{ ...job(['a'], 2, 20), title: 'A' }, { ...job(['a'], 2, 10), title: 'Z' }];
  assert.deepEqual(rankJobs(candidate(), positions).map((row) => row.job.id), [10, 20]);
});

void test('empty counterparts return empty rankings; invalid subjects/counterparts fail wholly', () => {
  assert.deepEqual(rankCandidates(job(), []), []);
  assert.deepEqual(rankJobs(candidate(), []), []);
  assert.throws(() => rankJobs(candidate([' ']), []), MatchingInputError);
  assert.throws(() => rankCandidates(job([' ']), []), MatchingInputError);
  assert.throws(() => rankCandidates(job(), [candidate(), candidate([' '], 4, 2)]), MatchingInputError);
  assert.throws(() => rankJobs(candidate(), [job(), job([' '], 2, 2)]), MatchingInputError);
});

void test('ranking validates entity identity, labels, availability and counterpart lists', () => {
  for (const id of [0, -1, 1.5, 2147483648]) {
    assert.throws(() => rankCandidates(job(), [candidate(['a'], 4, id)]), MatchingInputError);
    assert.throws(() => rankJobs(candidate(), [job(['a'], 2, id)]), MatchingInputError);
  }
  assert.throws(() => rankCandidates(job(), [{ ...candidate(), name: ' ' }]), MatchingInputError);
  assert.throws(() => rankJobs(candidate(), [{ ...job(), title: ' ' }]), MatchingInputError);
  assert.throws(() => rankJobs({ ...candidate(), availability: 'Unknown' } as unknown as CandidateProfile, []), MatchingInputError);
  assert.throws(() => rankCandidates(job(), [candidate(), candidate()]), MatchingInputError);
  assert.throws(() => rankJobs(candidate(), [job(), job()]), MatchingInputError);
  for (const list of [null, undefined, 'list', [null], Array<unknown>(1)]) {
    assert.throws(() => rankCandidates(job(), list as unknown as CandidateProfile[]), MatchingInputError);
    assert.throws(() => rankJobs(candidate(), list as unknown as JobProfile[]), MatchingInputError);
  }
});

void test('scoring/ranking accept frozen inputs without changing profiles or list order', () => {
  const copy = structuredClone(fixture);
  const before = JSON.stringify(copy);
  for (const row of copy.candidates) { Object.freeze(row.skills); Object.freeze(row.traits); Object.freeze(row); }
  for (const row of copy.jobs) { Object.freeze(row.skills); Object.freeze(row.culture_keywords); Object.freeze(row); }
  Object.freeze(copy.candidates); Object.freeze(copy.jobs); Object.freeze(copy);
  rankCandidates(copy.jobs[0]!, copy.candidates);
  rankJobs(copy.candidates[0]!, copy.jobs);
  scorePair(copy.candidates[0]!, copy.jobs[0]!);
  assert.equal(JSON.stringify(copy), before);
  const duplicates = candidate([' A ', 'a']);
  const previous = [...duplicates.skills];
  scorePair(duplicates, job(['a', ' A ']));
  assert.deepEqual(duplicates.skills, previous);
});
