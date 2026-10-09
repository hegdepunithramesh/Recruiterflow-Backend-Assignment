import { readFile } from 'node:fs/promises';
import { StorageError } from './support.js';

export interface CandidateFixture {
  id: number; name: string; skills: string[]; experience_years: number;
  availability: 'Immediate' | '2 weeks' | 'Not looking'; traits: string[]; quirk: string;
}
export interface JobFixture {
  id: number; title: string; skills: string[]; min_experience_years: number;
  culture_keywords: string[]; tagline: string;
}
export interface Fixture { candidates: CandidateFixture[]; jobs: JobFixture[] }

function invalid(): never { throw new StorageError('INVALID_FIXTURE', 'Fixture data failed validation; no ingestion was performed.'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) invalid();
  return value;
}
function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > 2147483647) invalid();
  return value;
}
function list(value: unknown, skills = false, required = false): string[] {
  if (!Array.isArray(value)) invalid();
  const strings = (value as unknown[]).map(text);
  if (required && !strings.length) invalid();
  return skills ? [...new Set(strings.map((entry) => entry.trim().toLowerCase()))] : strings;
}

// Ingestion validation/normalization only; no scoring or eligibility policy is implemented.
export function validateFixture(value: unknown): Fixture {
  const input = record(value);
  if (!Array.isArray(input.candidates) || !Array.isArray(input.jobs)) invalid();
  const candidates = (input.candidates as unknown[]).map((value): CandidateFixture => {
    const row = record(value);
    const availability = text(row.availability);
    if (availability !== 'Immediate' && availability !== '2 weeks' && availability !== 'Not looking') invalid();
    return { id: integer(row.id, 1), name: text(row.name), skills: list(row.skills, true),
      experience_years: integer(row.experience_years, 0), availability,
      traits: list(row.traits), quirk: text(row.quirk) };
  });
  const jobs = (input.jobs as unknown[]).map((value) => {
    const row = record(value);
    return { id: integer(row.id, 1), title: text(row.title), skills: list(row.skills, true, true),
      min_experience_years: integer(row.min_experience_years, 0),
      culture_keywords: list(row.culture_keywords), tagline: text(row.tagline) };
  });
  if (new Set(candidates.map((row) => row.id)).size !== candidates.length ||
    new Set(jobs.map((row) => row.id)).size !== jobs.length) invalid();
  return { candidates, jobs };
}

export async function assignmentFixture(): Promise<Fixture> {
  const raw: unknown = JSON.parse(await readFile(new URL('../../data/assignment.json', import.meta.url), 'utf8'));
  const fixture = validateFixture(raw);
  if (fixture.candidates.length !== 15 || fixture.jobs.length !== 6 ||
    fixture.candidates.some((row, i) => row.id !== i + 1) || fixture.jobs.some((row, i) => row.id !== i + 1)) invalid();
  return fixture;
}
