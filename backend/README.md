# Backend skeleton

Phase 04 infrastructure: Express app, environment validation, `pg` pool, safe JSON logs, health/readiness and shutdown. **Live PostgreSQL connectivity is verified; the earlier connectivity blocker is resolved.** Domain tables, migrations, seeds, matching logic/routes and Detective SQL remain pending.

## Observed verification — 9 October 2026

The user reported these results from the local backend:

| Check | Observed result |
| --- | --- |
| PostgreSQL | 18.6 installed and accepting connections at 127.0.0.1:5432 |
| Database / login | recruiter_bot and the restricted recruiter_bot_app login created |
| Backend startup | Started successfully |
| GET /health | HTTP 200 `{"status":"ok"}` |
| GET /ready | HTTP 200 `{"status":"ready"}` |

These observations verify startup and database connectivity/target only. They do not establish domain schema, migration/seed behavior, matching correctness, a full database privilege audit, live timeout behavior or shutdown with active PostgreSQL clients. The documentation update did not rerun the service or read credentials.

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

The verified local environment already has this database/login; skip creation there. If the role/database exists on another machine, inspect it instead of dropping/resetting anything. These commands create no domain tables. Later offline migrations/seeds use separate owner privileges and must grant the runtime role its required SELECT permissions. The Detective database and its permission boundary are deferred to its phase. Successful connectivity alone is not a complete privilege-denial test.

Set `DATABASE_URL` in `.env` to the new role's connection URL, retaining `/recruiter_bot`. Percent-encode special characters in the username/password. The example contains placeholders only. Credentials are required; only `postgres:`/`postgresql:` URLs with the exact Bot database are accepted. URL query parameters/fragments are rejected to prevent connection-target or timeout overrides. `PORT` defaults to 3000 and accepts canonical integers 1–65535; `NODE_ENV` defaults to development and accepts development/test/production. Existing process environment takes precedence over `.env`.

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

Both requests returned the documented HTTP 200 bodies in the user-observed live run above. `/health` operates independently of the database. `/ready` requires `SELECT current_database() AS database_name` to succeed with `recruiter_bot`; a failed probe returns safe 503 `DATABASE_NOT_READY` with message `Database is not ready.` Readiness checks connectivity/target only. Migration readiness belongs to a later phase. Unknown routes return safe 404 `ROUTE_NOT_FOUND`, including the pending `/jobs/{id}/matches` and `/candidates/{id}/matches`. Errors use `{"error":{"code":"...","message":"...","requestId":"..."}}`; unexpected errors return safe 500 `INTERNAL_ERROR`. Responses have a generated `X-Request-Id` and `Cache-Control: no-store`.

Stop with Ctrl+C/SIGINT or SIGTERM. Shutdown stops accepting requests, drains in-flight work and closes the pool, with a ten-second deadline. The pool has at most five clients, a two-second connection/acquisition timeout, a two-second PostgreSQL statement timeout and a three-second client query timeout; there are no automatic retries. Logs omit raw paths/query strings, driver messages, SQL, connection URLs and stacks.

Build, typecheck, lint and all **33 infrastructure tests passed during the initial 8 October setup**; they were not rerun for this documentation update. The tests use Node's test runner through tsx, real local HTTP sockets, injected successful probes, and real `pg` connection refusal. The separate user-observed live run establishes PostgreSQL connectivity. Neither result establishes domain schema or matching correctness. Signal tests deliver events through child-process IPC because Windows force-terminates children on `process.kill`; they exercise the installed handlers and natural exit. Shutdown with active PostgreSQL clients and live server-side timeouts remain unverified.

The real `.env`, generated `dist/`, `node_modules/`, assignment PDF and internal planning files are ignored. Include the placeholder-only `.env.example` and package-lock.json in the reviewed submission. AI assisted planning, scaffolding, tests, documentation, review and debugging. Phase 05 has not started.
