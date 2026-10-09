import type { CandidateFixture, JobFixture } from '../../storage/fixture.js';

export const policyVersion = 'v1';

export type CandidateProfile = Readonly<Pick<CandidateFixture, 'id' | 'name' | 'experience_years' | 'availability'>> & {
  readonly skills: readonly string[];
};
export type JobProfile = Readonly<Pick<JobFixture, 'id' | 'title' | 'min_experience_years'>> & {
  readonly skills: readonly string[];
};
type CandidateFit = Pick<CandidateProfile, 'skills' | 'experience_years'>;
type JobFit = Pick<JobProfile, 'skills' | 'min_experience_years'>;

// Internal policy results; HTTP serialization will expose only score and reason.
export interface PairScore {
  readonly rawScore: number;
  readonly skillCoverage: number;
  readonly experienceFit: number;
  readonly matchedSkillCount: number;
  readonly requiredSkillCount: number;
  readonly score: number;
  readonly reason: string;
}
export interface RankedCandidate { readonly candidate: CandidateProfile; readonly match: PairScore }
export interface RankedJob { readonly job: JobProfile; readonly match: PairScore }

export class MatchingInputError extends Error {
  constructor() {
    super('Invalid matching domain input.');
    this.name = 'MatchingInputError';
  }
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MatchingInputError();
}
function assertList(value: unknown): void {
  if (!Array.isArray(value)) throw new MatchingInputError();
}
function assertInteger(value: unknown, minimum = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > 2147483647) {
    throw new MatchingInputError();
  }
}
function assertText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new MatchingInputError();
}
function normalizedSkills(value: unknown): Set<string> {
  if (!Array.isArray(value)) throw new MatchingInputError();
  const skills = new Set<string>();
  for (const entry of value as unknown[]) {
    assertText(entry);
    skills.add(entry.trim().toLowerCase());
  }
  return skills;
}
function candidateSkills(candidate: CandidateFit): Set<string> {
  assertRecord(candidate);
  assertInteger(candidate.experience_years);
  return normalizedSkills(candidate.skills);
}
function jobSkills(job: JobFit): Set<string> {
  assertRecord(job);
  assertInteger(job.min_experience_years);
  const skills = normalizedSkills(job.skills);
  if (!skills.size) throw new MatchingInputError();
  return skills;
}
function validateCandidate(candidate: CandidateProfile) {
  candidateSkills(candidate);
  assertInteger(candidate.id, 1);
  assertText(candidate.name);
  if (!['Immediate', '2 weeks', 'Not looking'].includes(candidate.availability)) throw new MatchingInputError();
}
function validateJob(job: JobProfile) {
  jobSkills(job);
  assertInteger(job.id, 1);
  assertText(job.title);
}

/** Decimal half-up on the number's decimal representation, without an epsilon. */
export function displayScore(rawScore: number): number {
  if (!Number.isFinite(rawScore) || rawScore < 0 || rawScore > 100) throw new MatchingInputError();
  const [decimal = '', exponent = '0'] = rawScore.toString().split('e');
  const [whole = '', fraction = ''] = decimal.split('.');
  const coefficient = BigInt(whole + fraction);
  const shift = Number(exponent) - fraction.length + 2;
  let cents: bigint;
  if (shift >= 0) cents = coefficient * 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    cents = (coefficient + divisor / 2n) / divisor;
  }
  return Number(cents) / 100;
}

export function scorePair(candidate: CandidateFit, job: JobFit): PairScore {
  const available = candidateSkills(candidate);
  const required = jobSkills(job);
  let matchedSkillCount = 0;
  for (const skill of required) if (available.has(skill)) matchedSkillCount++;
  const requiredSkillCount = required.size;
  const skillCoverage = matchedSkillCount / requiredSkillCount;
  const experienceFit = job.min_experience_years === 0 ? 1
    : Math.min(candidate.experience_years / job.min_experience_years, 1);
  // Algebraically 100 * (0.8 * S + 0.2 * E); components remain unrounded.
  const rawScore = 80 * skillCoverage + 20 * experienceFit;
  const years = candidate.experience_years === 1 ? 'year' : 'years';
  const clause = candidate.experience_years >= job.min_experience_years ? 'meets' : 'is below';
  const reason = `Matched ${matchedSkillCount} of ${requiredSkillCount} required skills; ` +
    `${candidate.experience_years} ${years} experience ${clause} the ${job.min_experience_years}-year minimum.`;
  return { rawScore, skillCoverage, experienceFit, matchedSkillCount, requiredSkillCount,
    score: displayScore(rawScore), reason };
}

function compare(left: PairScore, right: PairScore, leftId: number, rightId: number) {
  return right.rawScore - left.rawScore || right.skillCoverage - left.skillCoverage || leftId - rightId;
}

export function rankCandidates(job: JobProfile, candidates: readonly CandidateProfile[]): RankedCandidate[] {
  validateJob(job); // Invalid subjects must fail even when there are no counterparts.
  assertList(candidates);
  const ranked = Array.from(candidates, (candidate) => {
    validateCandidate(candidate);
    return { candidate, match: scorePair(candidate, job) };
  });
  if (new Set(ranked.map((row) => row.candidate.id)).size !== ranked.length) throw new MatchingInputError();
  return ranked.sort((left, right) => compare(left.match, right.match, left.candidate.id, right.candidate.id));
}

export function rankJobs(candidate: CandidateProfile, jobs: readonly JobProfile[]): RankedJob[] {
  validateCandidate(candidate);
  assertList(jobs);
  const ranked = Array.from(jobs, (job) => {
    validateJob(job);
    return { job, match: scorePair(candidate, job) };
  });
  if (new Set(ranked.map((row) => row.job.id)).size !== ranked.length) throw new MatchingInputError();
  return ranked.sort((left, right) => compare(left.match, right.match, left.job.id, right.job.id));
}
