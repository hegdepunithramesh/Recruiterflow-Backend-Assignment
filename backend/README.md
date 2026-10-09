# Recruiter Bot backend

Section B backend through **Phase 05**: Express infrastructure, five PostgreSQL domain tables, handwritten migrations and repeatable ingestion of the exact assignment fixture. Storage and runtime permissions are verified on PostgreSQL **18.6**. Scoring, both matching APIs and the separate SQL Detective dataset/answers remain pending.

## Observed verification — 9 October 2026

The user reported these results from the local backend:

| Check | Observed result |
| --- | --- |
| PostgreSQL | 18.6 installed and accepting connections at 127.0.0.1:5432 |
| Database / login | recruiter_bot and the restricted recruiter_bot_app login created |
| Backend startup | Started successfully |
| GET /health | HTTP 200 `{"status":"ok"}` |
| GET /ready | HTTP 200 `{"status":"ready"}` |

These user observations verify startup and connectivity/target. The separate Phase 05 agent checks below verify domain storage and runtime permissions against real PostgreSQL. Matching behavior, live service timeout execution and shutdown with active PostgreSQL clients remain unverified.

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

The schema contains candidates, jobs, canonical skills and two association tables. Availability, traits, quirks, culture keywords and taglines are retained. Constraints enforce positive IDs, nonnegative integer years, nonblank required text, availability values, canonical unique skills, unique associations and foreign keys. Metadata arrays are descriptive lists; ingestion validates their shape and rejects empty job skills. Five primary-key indexes and the unique skill-name index suffice for this fixture. Matches will be computed from pairs rather than stored.

`db:seed` validates the complete fixture before writing, then ingests it transactionally. Candidate IDs **1–15** and job IDs **1–6** follow PDF order and are reserved for those fixtures. A different name/title at a reserved ID aborts. Reruns restore fixture-owned fields and replace only their skill links; unrelated owners/links and unused skills survive. Skills are trimmed, lowercased and deduplicated. The identity sequence advances past existing explicit IDs and never rewinds. PostgreSQL sequence changes can leave gaps after rollback; table changes still roll back. Migration/seed writers serialize through the same advisory lock.

`db:verify` checks migration history through the owner connection, then compares every fixture field and skill set through the actual runtime login in a read-only snapshot. It checks effective permissions too. Fresh-database totals are:

```json
{"candidates":15,"jobs":6,"skills":27,"candidate_skills":50,"job_skills":16}
```

Unrelated data may increase totals without invalidating the fixture. Commands emit safe status/counts and exit nonzero on failure, without printing connection URLs or raw driver details.

Migration permissions grant runtime database CONNECT, public-schema USAGE and SELECT on the five domain tables. Ledger access, sequence access, writes, schema creation and temporary-table creation are denied, including inherited PUBLIC grants on this dedicated database. Commands do not elevate or alter global role attributes.

## Run and check

From `backend/`:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
npm.cmd start
```

Use `npm.cmd run dev` for TypeScript watch mode. The service listens on **127.0.0.1**, not all network interfaces. Startup validates configuration and confirms the connected database with a read-only probe before opening the port. Missing/invalid configuration, an unavailable database or wrong connected target exits with code 1 and a safe JSON diagnostic. No schema/fixture writes run during startup. Port conflicts log the `listener` category.

After successful startup, from another terminal:

```powershell
curl.exe -i http://127.0.0.1:3000/health
curl.exe -i http://127.0.0.1:3000/ready
```

Both requests returned the documented HTTP 200 bodies in the user-observed live run above. `/health` operates independently of the database. `/ready` requires `SELECT current_database() AS database_name` to succeed with `recruiter_bot`; a failed probe returns safe 503 `DATABASE_NOT_READY` with message `Database is not ready.` Readiness checks connectivity/target only and does not consult the private migration ledger. Matching-specific readiness belongs to a later phase. Unknown routes return safe 404 `ROUTE_NOT_FOUND`, including the pending `/jobs/{id}/matches` and `/candidates/{id}/matches`. Errors use `{"error":{"code":"...","message":"...","requestId":"..."}}`; unexpected errors return safe 500 `INTERNAL_ERROR`. Responses have a generated `X-Request-Id` and `Cache-Control: no-store`.

Stop with Ctrl+C/SIGINT or SIGTERM. Shutdown stops accepting requests, drains in-flight work and closes the pool, with a ten-second deadline. The pool has at most five clients, a two-second connection/acquisition timeout, a two-second PostgreSQL statement timeout and a three-second client query timeout; there are no automatic retries. Logs omit raw paths/query strings, driver messages, SQL, connection URLs and stacks.

Build, typecheck, lint and all **46 unit/infrastructure tests passed on 9 October**, with zero failures/skips. Node's test runner through tsx covers infrastructure HTTP/configuration/shutdown behavior plus fixture/config/history unit checks. Signal tests use child-process IPC for Windows compatibility. These tests run separately from actual database checks.

## Disposable database checks

For real failure/constraint tests, create a separate **empty, explicitly disposable** database as the owner through interactive psql connected to postgres:

```sql
CREATE DATABASE recruiter_bot_phase05_test;
```

Set `TEST_ADMIN_DATABASE_URL` locally to the owner connection for that exact database, on the same hostname/port as the runtime instance. Then run:

```powershell
npm.cmd run test:db
```

The suite guards its actual target before writes and derives a test runtime connection from `DATABASE_URL` by replacing only the database name. It accepts an empty database or its existing six-table baseline and never drops/resets a database. Failure variants use transactions and leave the fixture baseline intact. Missing/unsafe configuration fails visibly. On rerun, the fresh-database case is explicitly skipped because migrations already exist.

Real PostgreSQL checks covered fresh migration, migration/seed reruns, exact fields/relationships, checksum mismatch rejection, constraints, rollback after partial migration/seed writes, unrelated-row preservation, sequence reconciliation, concurrent seeds and actual runtime denial of ledger reads/writes/DDL/sequence access. The initial run passed fresh migration/rollback but found one test expecting the older foreign-key error code for RESTRICT; corrected to PostgreSQL 18's `23001`. The subsequent suite passed **30 database subtests**, with the already-executed fresh case skipped (Node reports 31 passes including the parent test, one skip, zero failures).

Development migration applied versions 1/2; its second run was a no-op. Both development seed runs succeeded, and verification returned the exact totals above with `fixtureVerified` and `runtimeReadOnly` true. Clean-checkout reproduction of the finished assignment, matching behavior, Detective access isolation, live service timeout execution and shutdown with active PostgreSQL clients remain unverified.

The real `.env`, generated `dist/`, `node_modules/`, assignment PDF and internal planning files are ignored. Include the placeholder-only `.env.example` and package-lock.json in the reviewed submission. AI assisted planning, scaffolding, handwritten schema/seed implementation, tests, documentation, review and debugging. Phase 06 has not started.
