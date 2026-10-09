import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { DetectiveError } from './support.js';

export const tableNames = ['applicants', 'interviews', 'job_postings', 'recruiters'];
const columns: Record<string, [string, string][]> = {
  applicants: [['id','integer'],['full_name','character varying(100)'],['email','character varying(100)'],
    ['source','character varying(50)'],['applied_date','date']],
  interviews: [['id','integer'],['applicant_id','integer'],['job_posting_id','integer'],
    ['stage','character varying(20)'],['scheduled_date','date'],['outcome','character varying(20)']],
  job_postings: [['id','integer'],['title','character varying(100)'],['recruiter_id','integer'],
    ['department','character varying(50)'],['opened_date','date'],['status','character varying(20)']],
  recruiters: [['id','integer'],['name','character varying(100)'],['region','character varying(50)']],
};

function mismatch(): never {
  throw new DetectiveError('FIXTURE_MISMATCH', 'Detective schema or rows differ from the supplied fixture. No reset, merge or cleanup is performed.');
}

export async function fixtureReference(): Promise<unknown> {
  return JSON.parse(await readFile(new URL('../../data/sql-detective.json', import.meta.url), 'utf8')) as unknown;
}

export async function publicObjects(client: PoolClient) {
  return (await client.query<{ name: string; kind: string; row_security: boolean; forced_row_security: boolean }>(
    `SELECT c.relname AS name, c.relkind AS kind, c.relrowsecurity AS row_security, c.relforcerowsecurity AS forced_row_security
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S') ORDER BY c.relname`,
  )).rows;
}

export async function fixtureSnapshot(client: PoolClient): Promise<unknown> {
  const result = await client.query<{ fixture: unknown }>(`SELECT jsonb_build_object(
    'recruiters', (SELECT COALESCE(jsonb_agg(jsonb_build_array(id,name,region) ORDER BY id), '[]'::jsonb) FROM public.recruiters),
    'job_postings', (SELECT COALESCE(jsonb_agg(jsonb_build_array(id,title,recruiter_id,department,opened_date,status) ORDER BY id), '[]'::jsonb) FROM public.job_postings),
    'applicants', (SELECT COALESCE(jsonb_agg(jsonb_build_array(id,full_name,email,source,applied_date) ORDER BY id), '[]'::jsonb) FROM public.applicants),
    'interviews', (SELECT COALESCE(jsonb_agg(jsonb_build_array(id,applicant_id,job_posting_id,stage,scheduled_date,outcome) ORDER BY id), '[]'::jsonb) FROM public.interviews)
  ) AS fixture`);
  return result.rows[0]?.fixture;
}

export async function verifyDetectiveFixture(client: PoolClient) {
  const objects = await publicObjects(client);
  if (!isDeepStrictEqual(objects, tableNames.map((name) => ({ name, kind: 'r', row_security: false, forced_row_security: false })))) mismatch();
  const attributes = await client.query<{ table_name: string; name: string; type: string; required: boolean;
    identity: string; generated: string; default_value: string | null }>(`SELECT c.relname AS table_name,
    a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS required,
    a.attidentity AS identity, a.attgenerated AS generated, pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relname = ANY($1::TEXT[]) AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`, [tableNames]);
  const expectedColumns = tableNames.flatMap((table_name) => columns[table_name]!.map(([name,type], i) =>
    ({ table_name, name, type, required: i === 0, identity: '', generated: '', default_value: null })));
  if (!isDeepStrictEqual(attributes.rows, expectedColumns)) mismatch();
  const constraints = await client.query(`SELECT c.relname AS table_name, k.contype AS type,
    k.conkey::INTEGER[] AS columns, k.convalidated AS validated FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY($1::TEXT[]) AND k.contype <> 'n'
    ORDER BY c.relname, k.contype, k.oid`, [tableNames]);
  if (!isDeepStrictEqual(constraints.rows, tableNames.map((table_name) => ({ table_name, type: 'p', columns: [1], validated: true })))) mismatch();
  const indexes = await client.query(`SELECT c.relname AS table_name, i.indisprimary AS primary_key,
    i.indisunique AS unique_key, i.indisvalid AS valid, i.indkey::INTEGER[] AS columns
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY($1::TEXT[]) ORDER BY c.relname, i.indexrelid`, [tableNames]);
  if (!isDeepStrictEqual(indexes.rows, tableNames.map((table_name) => ({ table_name, primary_key: true, unique_key: true, valid: true, columns: [1] })))) mismatch();
  const triggers = await client.query(`SELECT t.oid FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
    AND c.relname = ANY($1::TEXT[]) AND NOT t.tgisinternal`, [tableNames]);
  if (triggers.rows.length || !isDeepStrictEqual(await fixtureSnapshot(client), await fixtureReference())) mismatch();
  return { fixtureVerified: true, totals: { recruiters: 5, job_postings: 7, applicants: 11, interviews: 24 } };
}
