# Recruiter Bot backend

This directory contains Section B's Recruiter Bot API and independent SQL Detective solution. For the project overview and matching trade-offs, see the [root README](../README.md).

## Prerequisites and installation

Use Node.js `^22.13.0 || ^24.0.0`, npm 11 and a running PostgreSQL server. You need an owner login for database creation and offline setup, plus a restricted login for HTTP requests. Recorded verification used Node.js 22.15.0, npm 11.18.0, PostgreSQL 18.6 and Windows PowerShell 5.1; Node.js 24 was not exercised.

Commands below run **from `backend/` in PowerShell**, unless stated otherwise. Use `npm`/`curl`/`cp` on other shells instead of `npm.cmd`/`curl.exe`/`Copy-Item`. PostgreSQL's `psql` must be available; the Windows examples use its installation path.

```powershell
# From the repository root:
cd backend
npm.cmd ci --ignore-scripts
Copy-Item .env.example .env
```

Copy the example only when creating a new local configuration. Dependencies are installed from [package-lock.json](package-lock.json); `--ignore-scripts` was used successfully in the recorded clean installation.

## Environment variables

Edit the local `.env` using the placeholder formats in [.env.example](.env.example). Replace `YOUR_DB_OWNER` with the actual owner login and `YOUR_URL_ENCODED_PASSWORD` with the appropriate password, percent-encoding special characters in credentials. The owner and runtime logins have separate passwords. Keep credentials local; `.env` is ignored.

| Variable | Purpose and accepted values |
| --- | --- |
| `DATABASE_URL` | Required for the API and Bot offline tools. A credentialed PostgreSQL URL for exactly `recruiter_bot_app` on `recruiter_bot`. This is the restricted runtime connection. |
| `ADMIN_DATABASE_URL` | Required for `db:migrate`, `db:seed` and `db:verify`. A separate owner login on `recruiter_bot`, using the same hostname and port as `DATABASE_URL`. The HTTP server does not use it. |
| `PORT` | Optional HTTP port, an integer from 1 to 65535 without leading zeros. Default: `3000`. The listener binds to `127.0.0.1`. |
| `NODE_ENV` | Optional: `development`, `test` or `production`. Default: `development`. |
| `TEST_ADMIN_DATABASE_URL` | Optional for Bot integration tests only. Owner login targeting exactly the disposable `recruiter_bot_phase05_test` database on the same hostname/port as `DATABASE_URL`. |
| `DETECTIVE_DATABASE_URL` | Required only for Part 2 commands/tests. Separate owner login targeting exactly `sql_detective`; the Bot runtime login is rejected. The HTTP server does not use it. |

The three database names are enforced by code. Bot tests derive their runtime URL from `DATABASE_URL` by replacing only the database name; the restricted login and its password stay the same. PostgreSQL roles belong to the server instance, so the test database uses the existing `recruiter_bot_app` role.

URLs accept `postgres://` or `postgresql://` with host, login and password. URL query parameters and fragments are rejected. Existing process environment values take precedence over `.env`; clear stale overrides if local edits appear ineffective. Unused test/Detective variables may be omitted until needed.

## Create the application database

Start PostgreSQL and connect as an owner capable of creating a database and login. The following assumes the local `postgres` owner and PostgreSQL 18 on `127.0.0.1:5432`; adjust the executable path, host, port and owner to your installation. `-W` prompts for the owner's password without putting it in the command.

```powershell
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
& "$pgBin\psql.exe" -h 127.0.0.1 -p 5432 -U postgres -d postgres -W
```

Inside psql, inspect existing names first:

```sql
SELECT rolname FROM pg_roles WHERE rolname = 'recruiter_bot_app';
SELECT datname FROM pg_database WHERE datname = 'recruiter_bot';
```

For a fresh setup, run the following. Execute each CREATE statement only if that object is absent; inspect existing objects and their permissions before reusing them.

```sql
CREATE ROLE recruiter_bot_app
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
\password recruiter_bot_app
CREATE DATABASE recruiter_bot;
REVOKE ALL ON DATABASE recruiter_bot FROM PUBLIC;
GRANT CONNECT ON DATABASE recruiter_bot TO recruiter_bot_app;
\connect recruiter_bot
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO recruiter_bot_app;
\quit
```

`\password` prompts for the runtime password. The connected owner owns the new database. Configure `DATABASE_URL` with the runtime login and `ADMIN_DATABASE_URL` with that owner, both targeting `recruiter_bot`.

The runtime role must be a nonowner login without elevated role attributes or any role memberships. Migration SQL grants CONNECT, schema USAGE and SELECT on the five domain tables, and revokes writes, DDL, temporary-table access, sequence access and migration-ledger access. Do not use the owner login as `DATABASE_URL`.

## Migrate, seed and verify

From `backend/`, after configuring both Bot URLs:

```powershell
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run db:verify
```

[Handwritten migrations](sql/migrations/) create candidates, jobs, canonical skills, candidate/job skill junctions and a private migration ledger. Pending migrations run transactionally with an advisory lock. Versions and SHA-256 checksums make an unchanged rerun a no-op; changed or missing applied migration history is rejected. Keep applied migration files unchanged.

[assignment.json](data/assignment.json) preserves all sample profiles and metadata. Candidate IDs 1–15 and job IDs 1–6 follow the supplied order. Skill labels are trimmed, lowercased and deduplicated. A seed rerun restores fixture fields and relationships while retaining unrelated records; a conflicting name/title at a reserved fixture ID causes failure. Sequence reconciliation avoids collisions with existing larger IDs.

`db:verify` checks migration history, exact fixture fields/relationships and effective runtime permissions using both connections. Fresh totals are **15 candidates, six jobs, 27 skills, 50 candidate-skill links and 16 job-skill links**. Unrelated records can increase totals. Offline commands print a safe JSON result and exit nonzero on failure; the HTTP server never performs setup writes.

## Run the API

```powershell
npm.cmd run build
npm.cmd start
```

For development with source watching, use `npm.cmd run dev`. Startup validates configuration, actual database/login, required schema and effective privileges before opening the listener. It does not inspect the private migration ledger or certify fixture totals; use `db:verify` for those checks.

In another terminal:

```powershell
curl.exe -i "http://127.0.0.1:3000/health"
curl.exe -i "http://127.0.0.1:3000/ready"
```

Expected healthy responses are HTTP 200 with `{"status":"ok"}` and `{"status":"ready"}`, respectively. Readiness repeats the database/schema/permission checks and returns 503 if they fail. The server handles SIGINT/SIGTERM by stopping new connections, draining requests and closing the database pool, with a ten-second deadline. Native Windows console signal delivery has not been verified; see the test evidence below.

## API examples

Both routes are GET requests with no query parameters:

```powershell
curl.exe -i "http://127.0.0.1:3000/jobs/1/matches"
curl.exe -i "http://127.0.0.1:3000/candidates/1/matches"
```

Job 1 returns 15 matches. The following valid JSON is an **excerpt containing the first two**, with the remaining matches omitted:

```json
{
  "policyVersion": "v1",
  "subject": {
    "type": "job",
    "id": 1,
    "label": "Backend Detective",
    "availability": null
  },
  "matches": [
    {
      "type": "candidate",
      "id": 1,
      "label": "Sherlock H.",
      "availability": "Immediate",
      "score": 100,
      "reason": "Matched 3 of 3 required skills; 8 years experience meets the 3-year minimum."
    },
    {
      "type": "candidate",
      "id": 9,
      "label": "Sheldon C.",
      "availability": "Immediate",
      "score": 46.67,
      "reason": "Matched 1 of 3 required skills; 9 years experience meets the 3-year minimum."
    }
  ]
}
```

Candidate 1 returns this full response:

```json
{
  "policyVersion": "v1",
  "subject": {
    "type": "candidate",
    "id": 1,
    "label": "Sherlock H.",
    "availability": "Immediate"
  },
  "matches": [
    {"type":"job","id":1,"label":"Backend Detective","availability":null,"score":100,"reason":"Matched 3 of 3 required skills; 8 years experience meets the 3-year minimum."},
    {"type":"job","id":2,"label":"Rapid Prototyping Engineer","availability":null,"score":20,"reason":"Matched 0 of 2 required skills; 8 years experience meets the 2-year minimum."},
    {"type":"job","id":3,"label":"Developer Relations Lead","availability":null,"score":20,"reason":"Matched 0 of 2 required skills; 8 years experience meets the 2-year minimum."},
    {"type":"job","id":4,"label":"Engineering Manager, Chaos Team","availability":null,"score":20,"reason":"Matched 0 of 3 required skills; 8 years experience meets the 5-year minimum."},
    {"type":"job","id":5,"label":"Incident Commander","availability":null,"score":20,"reason":"Matched 0 of 3 required skills; 8 years experience meets the 4-year minimum."},
    {"type":"job","id":6,"label":"Sales Engineer","availability":null,"score":20,"reason":"Matched 0 of 3 required skills; 8 years experience meets the 3-year minimum."}
  ]
}
```

Every response has a generated `X-Request-Id` and `Cache-Control: no-store`. Errors have this envelope; the UUID here is illustrative and changes per request:

```json
{
  "error": {
    "code": "INVALID_ID",
    "message": "id must be a positive integer between 1 and 2147483647 without leading zeros.",
    "requestId": "88b1589b-c428-421d-93de-030a472ded31"
  }
}
```

```powershell
curl.exe -i "http://127.0.0.1:3000/jobs/01/matches"
curl.exe -i "http://127.0.0.1:3000/candidates/2147483647/matches"
curl.exe -i "http://127.0.0.1:3000/jobs/1/matches?limit=1"
```

These return 400 `INVALID_ID`, 404 `CANDIDATE_NOT_FOUND` and 400 `INVALID_QUERY` on the supplied fixture. IDs are ASCII positive integers from 1 to 2147483647 without leading zeros; ID validation precedes query validation and database access.

| HTTP status | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_ID` / `INVALID_QUERY` | Invalid ID or unsupported query parameters. |
| 404 | `JOB_NOT_FOUND` / `CANDIDATE_NOT_FOUND` | Valid ID with no matching subject. |
| 404 | `ROUTE_NOT_FOUND` | Unknown route. |
| 503 | `DATABASE_NOT_READY` | Readiness check failed. |
| 503 | `DATABASE_UNAVAILABLE` | Matching connection, acquisition or statement timeout, or database shutdown. |
| 500 | `INTERNAL_ERROR` | Unexpected failure, including invalid loaded profiles. |

An existing subject with no counterparts returns 200 and `matches: []`. Failures produce no partial ranking and are not retried automatically. Response and application-log errors omit credentials, SQL and raw driver details. Ranking behavior and trade-offs are described in the [root README](../README.md#architecture-and-matching-decisions).

## SQL Detective setup and answers

The answer file is [sql_detective.sql](sql_detective.sql). It contains five numbered, read-only queries, including the bonus. [sql/detective/setup.sql](sql/detective/setup.sql) is separate: it preserves the supplied four tables, 20 columns and **47 rows** (five recruiters, seven postings, 11 applicants, 24 interviews). Only the supplied primary keys are added; other columns retain their original nullability. [sql-detective.json](data/sql-detective.json) is an independent verification reference, not a SQL generator.

After creating the Bot role, reconnect as the owner to `postgres`:

```powershell
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
& "$pgBin\psql.exe" -h 127.0.0.1 -p 5432 -U postgres -d postgres -W
```

Inside psql:

```sql
SELECT datname FROM pg_database WHERE datname = 'sql_detective';
-- Execute CREATE only if absent; inspect any existing database before reuse.
CREATE DATABASE sql_detective;
REVOKE ALL ON DATABASE sql_detective FROM PUBLIC, recruiter_bot_app;
\connect sql_detective
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM recruiter_bot_app;
\quit
```

Use the actual owner if it differs from `postgres`. Set `DETECTIVE_DATABASE_URL` locally to that owner on exactly `sql_detective`. Keep the runtime connection on `recruiter_bot_app/recruiter_bot`. The Detective guard checks the actual database/login and requires the Bot role to have no effective CONNECT privilege; the HTTP server never uses this connection.

From `backend/`:

```powershell
npm.cmd run detective:load
npm.cmd run detective:verify
npm.cmd run detective:answers
```

The loader initializes an empty public schema in one transaction. An exact existing fixture returns `already_loaded` without data writes. Partial or altered fixtures are rejected without reset, cleanup or merge. Verification checks the exact schema and every original value, including case differences and NULLs. Verification and answer execution use read-only snapshots.

No HTTP server is required. To execute the answer file directly after loading and verification:

```powershell
& "$pgBin\psql.exe" -h 127.0.0.1 -p 5432 -U postgres -d sql_detective -W -X -v ON_ERROR_STOP=1 -f .\sql_detective.sql
```

After `npm.cmd run build`, the compiled CLI also works:

```powershell
node --env-file-if-exists=.env dist/detective/cli.js answers
```

Keep the versioned SQL and data directories alongside the build; compiled tools resolve those same assets.

## SQL Detective assumptions and results

1. **Open postings:** stored `status = 'open'` is authoritative. Duplicate titles remain distinct posting IDs, joined to their owning recruiter.
2. **Applicants reaching Final:** count distinct applicant records per posting across all Final outcomes. Repeated interviews count once for that applicant/posting; a left join retains zero-count postings.
3. **People linked to multiple postings:** trimmed, lowercase email is an identity proxy. Interviews at any stage/outcome evidence a posting link because there is no separate application junction. Count distinct posting IDs, select the smallest applicant ID's name and include all applicant IDs for that identity, even unlinked records. NULL/blank emails remain separate identities keyed by applicant ID; names do not merge people. Source data stays unchanged.
4. **Recruiter conversion:** count Final interview rows, including repeated, failed, no-show or pending outcomes in the denominator and the inclusive minimum of three. Only passed Finals enter the numerator. Cast to NUMERIC before division and return an unrounded fraction; `pg` represents NUMERIC values as strings. The fixture's pending interview is Technical and does not enter this calculation.
5. **Department winners:** count passed Final interview rows per department/recruiter. `DENSE_RANK` returns all tied winners; recruiter IDs only order presentation. Departments with no successes are omitted; a NULL department remains its own group.

Questions 2–5 include closed/on-hold postings. Question 2 counts applicant records; Question 3 groups email identities; Questions 4–5 count interview rows. Email is a practical proxy and cannot establish real-world identity reliably.

These five baseline results were verified against the supplied dataset:

| Question | Baseline result |
| --- | --- |
| 1 | Posting 1: Backend Engineer I / Priya Shah; 2: Backend Engineer I / Daniel Ortiz; 4: Backend Engineer II / Priya Shah; 5: DevOps Engineer / Wei Zhang. |
| 2 | Posting IDs 1–7: Final applicant counts **2, 2, 1, 2, 0, 0, 2**. |
| 3 | `ananya.rao@mail.com` / Ananya Rao: applicant IDs [1, 2], posting IDs [1, 4]; `ben.turner@mail.com` / Ben Turner: [3], [1, 3]; `elena.popescu@mail.com` / Elena Popescu: [6], [2, 7]. Each has job count 2. |
| 4 | Priya Shah: 3 passed / 4 Final interviews = **0.75**; Daniel Ortiz: 2 / 4 = **0.5**. Other recruiters are below the minimum. |
| 5 | Data: Fatima Al-Sayed, **1** successful placement; Engineering: Priya Shah, **3**. Infrastructure has no winner. |

## Optional tests

Running the application does not require a test database or Detective configuration. Static checks and unit/infrastructure tests need installed dependencies but no live PostgreSQL:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd test
```

### Bot integration tests

Use a dedicated, initially empty **disposable** database. Connect as the owner to `postgres`, inspect its existence and create it only if absent:

```sql
SELECT datname FROM pg_database WHERE datname = 'recruiter_bot_phase05_test';
CREATE DATABASE recruiter_bot_phase05_test;
```

Configure `TEST_ADMIN_DATABASE_URL` for the owner of that exact database on the same hostname/port as `DATABASE_URL`. The Bot role must already exist. Run sequentially from `backend/`:

```powershell
npm.cmd run test:db
npm.cmd run test:api
npm.cmd run test:shutdown
```

Storage and API suites check the actual target before writes and accept an empty database or the expected existing six-table baseline. They never reset the application database. Storage variants roll back; API variants temporarily commit changes in the disposable database so the runtime can observe them, then restore data/permissions and verify the fixture in cleanup. Run these suites only on that disposable database and allow cleanup to finish.

`test:db` covers migrations, seeds, constraints, rollback, checksums, sequences and runtime privilege denial. Its fresh-database case runs once; an already-migrated rerun explicitly skips that case. `test:api` covers HTTP contracts, all 90 pairs in both directions, deterministic ordering, snapshot isolation and real database failure/recovery.

`test:shutdown` requires the baseline prepared by the preceding suites. It does not migrate, seed or edit records; owner locks roll back and fixture checks run before/after. It exercises real in-flight database work and pool closure for both installed signal handlers, timeout during drain and the shutdown deadline. Windows tests invoke handlers via IPC; they do not verify native console signal delivery.

### SQL Detective integration tests

After the separate Part 2 database and owner URL are configured:

```powershell
npm.cmd run test:detective
```

Use only the dedicated `sql_detective` assignment database. The suite loads/verifies the original fixture and introduces transactional edge cases, including schema/data variations, then rolls them back and rechecks the baseline. It checks all five answers, repeated interviews, identity normalization, zeros, conversion thresholds and tied winners. Missing or unsafe live-test configuration fails visibly.

## Recorded verification

A clean tracked checkout of revision `5e077a0`, with fresh dependencies and a fresh isolated PostgreSQL 18.6 instance, passed installation, typecheck, lint and build. Application migration/seed/verification, unchanged reruns, compiled startup, API examples, all five Detective answers, compiled Detective execution and direct psql execution also succeeded. The original Detective definitions and values were compared with the assignment; an actual Bot login connection to its database was denied.

| Suite | Passes | Failures | Skips |
| --- | --- | --- | --- |
| Unit/infrastructure | 116 | 0 | 0 |
| Storage on a fresh disposable database | 32 | 0 | 0 |
| Matching API | 15 | 0 | 0 |
| SQL Detective | 19 | 0 | 0 |
| Additional active-database shutdown tests | 5 | 0 | 0 |
| Recorded total | **187** | **0** | **0** |

Counts include Node parent tests. The first four suites (**182 tests**) ran in that clean checkout. The five shutdown tests and their typecheck/lint checks ran separately against the additional test code; they are not evidence of a new clean-checkout run of the current revision. The deadline test intentionally prolongs test-only database work and expects a child exit of 1 with `shutdown_failed`.

For this README revision, paths, links, commands, configuration and example responses are checked against tracked source and fixtures. Installation, build and live database suites were not rerun for documentation-only changes. Native Windows signal delivery and Node.js 24 execution remain unverified. The API's unpaginated full ranking and heuristic matching policy are suitable for the supplied small fixture; it listens only on loopback.

## Troubleshooting

| Symptom | Check or action |
| --- | --- |
| `CONFIGURATION` or startup `invalidFields` | Replace all used placeholders, percent-encode credentials, check exact database/login names and remove URL query parameters/fragments. Check for process environment overrides. |
| Connection refused or database unavailable | Start PostgreSQL; confirm host/port, password and database existence. Owner and runtime Bot URLs must use the same hostname/port. |
| `UNSAFE_RUNTIME_ROLE` or runtime permission failure | Ensure `recruiter_bot_app` is a nonowner without elevated attributes or memberships. Apply the permission migration through the actual owner and run `db:verify`. |
| Missing schema or failed readiness | Run `db:migrate`, `db:seed` and `db:verify` with owner/runtime URLs before starting. Readiness does not certify fixture contents. |
| Migration-history/checksum mismatch | Restore the original applied migration from the repository; do not edit its checksum or remove ledger entries to bypass the check. |
| Fixture conflict or Detective `FIXTURE_MISMATCH` | Inspect existing contents. Use the expected fixture or an empty dedicated database for initial setup; tools do not reset altered data. |
| `BOT_DATABASE_ISOLATION` | As the Detective owner, revoke database privileges from PUBLIC and `recruiter_bot_app`; check effective CONNECT, including inherited access. |
| Integration-test target/configuration failure | Configure the exact disposable Bot database and separate Detective database. Run Bot suites sequentially; prepare the baseline before shutdown tests. |
| `dist/server.js` missing | Run `npm.cmd run build` from `backend/` before `npm.cmd start`. |
| Listener unavailable / address in use | Stop the process occupying the configured port or choose another valid `PORT`; update curl URLs accordingly. |
| PowerShell invokes an unexpected npm/curl command | Use `npm.cmd` and `curl.exe` explicitly. Adjust `$pgBin` if PostgreSQL is installed elsewhere. |

## AI assistance

AI assistants contributed to analysis, design, code, handwritten SQL, tests, documentation, debugging and automated verification. Independent human review is not documented.
