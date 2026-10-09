# Recruiter Bot backend

Section B backend through **Phase 07**: Express infrastructure, five PostgreSQL domain tables, handwritten migrations, repeatable fixture ingestion and both matching APIs. The shared pure engine, real SQL/HTTP behavior and runtime permissions are verified on PostgreSQL **18.6**. The separate SQL Detective dataset/answers remain pending.

## Observed verification — 9 October 2026

The user reported these results from the local backend:

| Check | Observed result |
| --- | --- |
| PostgreSQL | 18.6 installed and accepting connections at 127.0.0.1:5432 |
| Database / login | recruiter_bot and the restricted recruiter_bot_app login created |
| Backend startup | Started successfully |
| GET /health | HTTP 200 `{"status":"ok"}` |
| GET /ready | HTTP 200 `{"status":"ready"}` |

These earlier user observations verify startup and connectivity/target. Phase 07 agent verification separately confirmed schema/readiness and both matching endpoints against the development database. The disposable-database HTTP suite exercised all 90 fixture pairs, safe failures, actual connection loss, acquisition/statement timeouts and snapshot consistency. Shutdown after live requests closed the real pool; shutdown with active PostgreSQL work remains unverified.

## Prerequisites and installation

Tested with Node.js **22.15.0** and npm **11.18.0** on Windows PowerShell 5.1. Node 22 is a supported Maintenance LTS line; the recorded patch reproduces this machine, rather than asserting it is the newest security patch. Use a current supported Node 22 patch for ongoing work. Node 24 meets the declared engines but was not tested here. Dependencies are pinned in package.json and package-lock.json.

From the repository root in PowerShell:

```powershell
Set-Location backend
npm.cmd ci --ignore-scripts
Copy-Item -LiteralPath .env.example -Destination .env
```

Copy the example only on first setup; preserve an existing `.env`. Edit `.env` locally with the database role/password from the next section. Real environment files are ignored. On shells without PowerShell, use `cd backend`, `npm ci --ignore-scripts` and `cp .env.example .env` instead. Installation needs npm registry access.

## Native PostgreSQL 18 setup on Windows

PostgreSQL **18.6** is installed and accepting connections on the verified local environment. The setup major is pinned to **18**. For another machine, use the [official Windows download route](https://www.postgresql.org/download/windows/) for PostgreSQL 18.x. This project uses native PostgreSQL; no Compose file is included. The commands below describe setup and verification without requiring machine PATH changes.

For the standard installation path, check the server/tools using absolute paths, without changing machine PATH or services:

```powershell
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'
& "$pgBin\psql.exe" --version
& "$pgBin\pg_isready.exe" -h 127.0.0.1 -p 5432
& "$pgBin\psql.exe" -h 127.0.0.1 -p 5432 -U postgres -d postgres -W
```

In that interactive psql session, on a fresh local instance only, create the empty Bot database and a restricted runtime login. `\password` prompts without placing a password in SQL or shell history:

```sql
CREATE ROLE recruiter_bot_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
\password recruiter_bot_app
CREATE DATABASE recruiter_bot;
REVOKE ALL ON DATABASE recruiter_bot FROM PUBLIC;
GRANT CONNECT ON DATABASE recruiter_bot TO recruiter_bot_app;
\connect recruiter_bot
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO recruiter_bot_app;
SHOW server_version;
\quit
```

The verified local environment already has this database/login; skip creation there. If the role/database exists on another machine, inspect it instead of dropping/resetting anything. These commands create no domain tables. Offline migrations/seeds use a separate database/schema owner login and grant the runtime role domain SELECT permissions. The runtime login must not own the database/schema or inherit other roles. The Detective database and its permission boundary are deferred to its phase.

Set `DATABASE_URL` in `.env` to **recruiter_bot_app** targeting `/recruiter_bot`. Set `ADMIN_DATABASE_URL` to a separate privileged database/schema owner login targeting that same database. Only offline migrate/seed/verify commands read the owner connection; HTTP startup does not. Never replace the runtime login with an owner or paste/commit credentials.

Percent-encode special characters in credentials. The example contains placeholders only. Credentialed `postgres:`/`postgresql:` URLs with the exact database name are required; URL query parameters/fragments are rejected. Offline owner/runtime URLs must use the same hostname and port. `PORT` defaults to 3000 and accepts canonical integers 1–65535; `NODE_ENV` defaults to development and accepts development/test/production. Existing process environment takes precedence over `.env`.

## Migrate, seed and verify

From `backend/`, with both connections configured:

```powershell
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run db:verify
```

`db:migrate` applies ordered handwritten SQL and records SHA-256 checksums in a private `schema_migrations` ledger. All pending migrations and ledger writes share one transaction. Matching history makes reruns a no-op; changed, missing or unknown applied versions fail. Keep applied files immutable and add a new numbered file for changes. `.gitattributes` preserves LF migration bytes across checkouts. Conflicting existing domain tables fail rather than being silently accepted. There is no automatic down/reset command.

The schema contains candidates, jobs, canonical skills and two association tables. Availability, traits, quirks, culture keywords and taglines are retained. Constraints enforce positive IDs, nonnegative integer years, nonblank required text, availability values, canonical unique skills, unique associations and foreign keys. Metadata arrays are descriptive lists; ingestion validates their shape and rejects empty job skills. Five primary-key indexes and the unique skill-name index suffice for this fixture. The pure engine computes matches from pairs without storing results.

`db:seed` validates the complete fixture before writing, then ingests it transactionally. Candidate IDs **1–15** and job IDs **1–6** follow PDF order and are reserved for those fixtures. A different name/title at a reserved ID aborts. Reruns restore fixture-owned fields and replace only their skill links; unrelated owners/links and unused skills survive. Skills are trimmed, lowercased and deduplicated. The identity sequence advances past existing explicit IDs and never rewinds. PostgreSQL sequence changes can leave gaps after rollback; table changes still roll back. Migration/seed writers serialize through the same advisory lock.

`db:verify` checks migration history through the owner connection, then compares every fixture field and skill set through the actual runtime login in a read-only snapshot. It checks effective permissions too. Fresh-database totals are:

```json
{"candidates":15,"jobs":6,"skills":27,"candidate_skills":50,"job_skills":16}
```

Unrelated data may increase totals without invalidating the fixture. Commands emit safe status/counts and exit nonzero on failure, without printing connection URLs or raw driver details.

Migration permissions grant runtime database CONNECT, public-schema USAGE and SELECT on the five domain tables. Ledger access, sequence access, writes, schema creation and temporary-table creation are denied, including inherited PUBLIC grants on this dedicated database. Commands do not elevate or alter global role attributes.

## Matching algorithm v1

The pure engine in `src/modules/matching/policy.ts` uses **score = 80 × S + 20 × E**, where S is the fraction of distinct required job skills covered by the candidate, and E is `min(candidate years / minimum years, 1)`. A zero-year minimum gives E = 1. For example, Sheldon C. covers one of Backend Detective's three skills and has nine years against a three-year minimum: `80 × 1/3 + 20 × 1 = 46.666…`, displayed as **46.67**. His explanation is `Matched 1 of 3 required skills; 9 years experience meets the 3-year minimum.` Both ranking directions use this same pair scorer and reason.

Rank by unrounded score descending, then skill coverage descending, then counterpart ID ascending. Only the final displayed score uses decimal half-up rounding to hundredths; names and rounded values never determine order. Skills are trimmed, lowercased and deduplicated, preserving internal spaces/hyphens without synonyms. Invalid skills/experience and empty job requirements fail with a domain error; empty candidate skills are valid. Ranking validates subjects even when there are no counterparts and never returns a partial ranking after invalid input.

The 80/20 weights are an explainable heuristic, not a calibrated hiring probability. Extra candidate skills do not penalize fit; experience above the minimum earns no further bonus. All counterparts remain eligible, including zero-score and `Not looking` candidates. Availability is preserved; traits, culture, quirks and taglines add no subjective weights. This can rank unavailable candidates highly. The module uses type-only views of existing fixture types and has no runtime imports, database, environment or network access. HTTP routes and SQL repositories are not part of Phase 06.

## Run and check

From `backend/`:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
npm.cmd start
```

Use `npm.cmd run dev` for TypeScript watch mode. The service listens on **127.0.0.1**. Startup requires the configured/connected recruiter_bot database and recruiter_bot_app login, restricted effective permissions, and all columns used by the repositories. Missing/invalid configuration, an unavailable database or missing schema/read grants exits with code 1 and a safe JSON diagnostic. Schema/permission failures use the `database_schema` category; port conflicts use `listener`. Startup performs only reads. Run offline migrate/seed/verify beforehand: the runtime cannot inspect migration-ledger contents/checksums.

After successful startup, from another terminal:

```powershell
curl.exe -i http://127.0.0.1:3000/health
curl.exe -i http://127.0.0.1:3000/ready
```

Both probes returned the documented HTTP 200 bodies in Phase 07 live checks. `/health` operates independently of the database. `/ready` now repeats startup's connected-target, runtime-role, effective-permission and required-column checks. A failed probe returns 503 `DATABASE_NOT_READY` with message `Database is not ready.` It inspects privilege metadata without reading private ledger rows. Offline `db:verify` remains the migration-history/fixture check; readiness permits valid empty counterpart tables and does not certify fixture loading. All responses have a generated `X-Request-Id` and `Cache-Control: no-store`.

Stop with Ctrl+C/SIGINT or SIGTERM. Shutdown stops accepting requests, drains in-flight work and closes the pool, with a ten-second deadline. The pool has at most five clients, a two-second connection/acquisition timeout, a two-second PostgreSQL statement timeout and a three-second client query timeout; there are no automatic retries. Logs omit raw paths/query strings, driver messages, SQL, connection URLs and stacks.

Build, typecheck, lint and all **101 unit/infrastructure tests passed on 9 October**, with zero failures/skips. This includes the 50 unchanged policy tests, four service failure/transaction tests and updated configuration/readiness checks. Signal tests use child-process IPC for Windows compatibility. Database-backed tests run separately below.

## Matching API demonstration

After startup, run these from another terminal (replace 3000 if PORT was changed):

```powershell
curl.exe -sS -i http://127.0.0.1:3000/jobs/1/matches
curl.exe -sS -i http://127.0.0.1:3000/candidates/1/matches
curl.exe -sS -i http://127.0.0.1:3000/jobs/2/matches
curl.exe -sS -i http://127.0.0.1:3000/jobs/01/matches
curl.exe -sS -i http://127.0.0.1:3000/candidates/2147483647/matches
curl.exe -sS -i "http://127.0.0.1:3000/jobs/1/matches?limit=1"
```

All six requests were executed with curl against recruiter_bot on an owned ephemeral port **50395**, using the compiled backend and actual recruiter_bot_app login. The first two returned 200 with all 15 candidates and six jobs; their complete bodies matched the agreed examples. Development db:verify passed before and after; no migrations/seeds or other writes were needed. The owned service was stopped and its pool closed.

Job 1 returns candidate IDs **1,9,2,3,4,5,6,7,8,10,11,12,13,14,15**: Sherlock scores 100, Sheldon 46.67, the rest 20. This excerpt shows the first two of the 15 matches:

```json
{
  "policyVersion": "v1",
  "subject": {"type":"job","id":1,"label":"Backend Detective","availability":null},
  "matches": [
    {"type":"candidate","id":1,"label":"Sherlock H.","availability":"Immediate","score":100,"reason":"Matched 3 of 3 required skills; 8 years experience meets the 3-year minimum."},
    {"type":"candidate","id":9,"label":"Sheldon C.","availability":"Immediate","score":46.67,"reason":"Matched 1 of 3 required skills; 9 years experience meets the 3-year minimum."}
  ]
}
```

Candidate 1 returns this complete body:

```json
{
  "policyVersion": "v1",
  "subject": {"type":"candidate","id":1,"label":"Sherlock H.","availability":"Immediate"},
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

Job 2 includes all candidates; its top tied IDs are **3,6,8**, each at 100. Tony's availability remains `Not looking`. There is no threshold, filtering, top-k or pagination. Scores/reasons are identical for each pair in both directions; ranks depend on the subject. Scores are JSON numbers rounded to two decimal places at most, rather than fixed-width strings. A valid subject with no counterparts returns 200 with `matches: []`.

IDs must be decoded ASCII positive integers 1–2147483647 without leading zeros; ID validation runs before query validation or SQL. Any matching-route query parameter is rejected. Error responses use:

```json
{"error":{"code":"INVALID_ID","message":"id must be a positive integer between 1 and 2147483647 without leading zeros.","requestId":"88b1589b-c428-421d-93de-030a472ded31"}}
```

The UUID above is illustrative; each error's requestId equals its generated X-Request-Id header and log correlation ID. Incoming request IDs are not adopted.

| HTTP | Code | Message / trigger |
| --- | --- | --- |
| 400 | INVALID_ID | id must be a positive integer between 1 and 2147483647 without leading zeros. |
| 400 | INVALID_QUERY | Query parameters are not supported. |
| 404 | JOB_NOT_FOUND | Job not found. |
| 404 | CANDIDATE_NOT_FOUND | Candidate not found. |
| 404 | ROUTE_NOT_FOUND | Route not found. (including missing path segments) |
| 503 | DATABASE_UNAVAILABLE | Matching is temporarily unavailable. Please try again later. (known connection loss/refusal, acquisition/statement timeout or shutdown) |
| 500 | INTERNAL_ERROR | An unexpected error occurred. (unexpected SQL/programming failure or invalid loaded profiles) |

The last three curl examples returned 400 INVALID_ID, 404 CANDIDATE_NOT_FOUND and 400 INVALID_QUERY. Neither database failures nor missing subjects become empty success. No partial ranking is returned after any failure, and there are no automatic retries. Errors/logs omit SQL, driver details and credentials.

For `/jobs/1/matches`, the controller validates the HTTP input, then the service checks out one client and begins a read-only REPEATABLE READ transaction. A parameterized subject SELECT and one aggregate SELECT for all candidate skills use left joins, retaining zero-skill candidates. Full profile validation runs before commit/release. The unchanged pure ranker scores each pair once and orders by raw score, coverage and ID; the controller emits only the contract fields. The reverse route follows the same flow. Each successful request uses two data SELECTs plus transaction control, a missing subject one, and invalid input zero. This snapshot costs transaction round trips but prevents mixing concurrent commits; computed matches avoid stale stored results.

## Disposable database checks

For real failure/constraint tests, create a separate **empty, explicitly disposable** database as the owner through interactive psql connected to postgres:

```sql
CREATE DATABASE recruiter_bot_phase05_test;
```

Set `TEST_ADMIN_DATABASE_URL` locally to the owner connection for that exact database, on the same hostname/port as the runtime instance. Then run:

```powershell
npm.cmd run test:db
npm.cmd run test:api
```

Run these suites sequentially because they share the disposable database. Both guard the actual target before writes and derive the test runtime connection from DATABASE_URL by replacing only the database name. They accept an empty database or its existing six-table baseline and never drop/reset a database. Storage failure variants roll back; HTTP variants commit test-only changes visible to the runtime, then restore affected tables/permissions and reseed/verify the baseline in finally blocks. Do not interrupt tests mid-variant. Missing/unsafe configuration fails visibly. On rerun, the storage fresh-database case is explicitly skipped because migrations already exist.

Real PostgreSQL checks covered fresh migration, migration/seed reruns, exact fields/relationships, checksum mismatch rejection, constraints, rollback after partial migration/seed writes, unrelated-row preservation, sequence reconciliation, concurrent seeds and actual runtime denial of ledger reads/writes/DDL/sequence access. The initial run passed fresh migration/rollback but found one test expecting the older foreign-key error code for RESTRICT; corrected to PostgreSQL 18's `23001`. The subsequent suite passed **30 database subtests**, with the already-executed fresh case skipped (Node reports 31 passes including the parent test, one skip, zero failures).

Phase 07 reran test:db: **30 subtests passed**, plus the parent (31 passes), one fresh-case skip, zero failures. Test:api passed **14 subtests**, plus the parent (15 passes), zero failures/skips. It executes real HTTP/SQL for all 90 pairs in both directions, complete literal rankings, reasons/details, repeat ordering, validation before reads, absent/empty subjects, zero-skill candidates, rounded-score ties and two-client snapshot isolation. Real termination, exhaustion of all five clients, blocked-SELECT statement timeout, missing table and read-permission loss produce safe failures and recovery. A scorer exception is deliberately injected after real reads to verify generic 500 and release before scoring.

The first HTTP suite run exposed an unhandled checked-out client connection error. Capturing client error events during snapshots/readiness and discarding damaged clients fixed it; the expanded suite passed afterward. Runtime startup/readiness changes required no new migration or ledger privileges. Applied SQL and the assignment fixture/policy remain unchanged. Finished-assignment clean-checkout reproduction, Detective access isolation, shutdown with active PostgreSQL work and final submission review remain unverified.

The real `.env`, generated `dist/`, `node_modules/`, assignment PDF and internal planning files are ignored. Include the placeholder-only `.env.example` and package-lock.json in the reviewed submission. AI assisted planning, scaffolding, handwritten schema/seed/repositories and matching/API implementation, tests, documentation, review and debugging. Phase 08 has not started; SQL Detective remains pending.
