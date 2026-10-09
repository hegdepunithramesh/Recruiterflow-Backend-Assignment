# Recruiter Bot — Backend Assignment

This repository implements **Section B** of the Recruiterflow Backend Developer assignment:

- **Part 1 — Recruiter Bot:** a PostgreSQL-backed API that ranks candidates for a job and jobs for a candidate, with a score and explanation for every match. It preserves the assignment's 15 candidates, six jobs and descriptive metadata.
- **Part 2 — SQL Detective:** five handwritten SQL answers, including the bonus, against the supplied hiring dataset in a separate database. The original four-table schema and all 47 rows are loaded as supplied.

## Tech stack and layout

Node.js 22 or 24, npm 11, TypeScript, Express 5 and PostgreSQL with the `pg` driver. All database interaction uses handwritten SQL. Tests use Node's test runner; dependencies are pinned in the lockfile. The recorded execution environment was Windows PowerShell 5.1, Node.js 22.15.0, npm 11.18.0 and PostgreSQL 18.6.

```text
backend/
  README.md               Complete setup, API examples, SQL assumptions and tests
  .env.example            Local configuration placeholders
  package.json            Application, database and test commands
  data/                   Recruiter Bot fixture and independent Detective reference
  sql/migrations/         Recruiter Bot schema and runtime permissions
  sql/detective/setup.sql  Original SQL Detective schema and inserts
  sql_detective.sql       Five numbered Part 2 answers
  src/                    HTTP server, matching policy, repositories and offline tools
  tests/                  Unit and PostgreSQL integration tests
```

## Quick start

Prerequisites: Git, Node.js `^22.13.0 || ^24.0.0`, npm 11 and a running PostgreSQL server with an owner login. These examples use **PowerShell**. On other shells, use `npm` and `curl` in place of `npm.cmd` and `curl.exe`, and `cp` in place of `Copy-Item`.

1. Clone and install dependencies:

   ```powershell
   git clone https://github.com/hegdepunithramesh/Recruiterflow-Backend-Assignment.git
   cd Recruiterflow-Backend-Assignment/backend
   npm.cmd ci --ignore-scripts
   Copy-Item .env.example .env
   ```

   Copy the example only for a fresh setup; retain an existing local `.env`.

2. Follow [database creation and permissions](backend/README.md#create-the-application-database) to create `recruiter_bot` and the restricted `recruiter_bot_app` login. Edit `backend/.env` locally: set `DATABASE_URL` to that login and `ADMIN_DATABASE_URL` to a separate owner of the same database. Replace the owner/password placeholders and percent-encode special characters in credentials. See [environment variables](backend/README.md#environment-variables). Tests and SQL Detective configuration are optional for running the API.

3. From `backend/`, create the schema, load the sample data, verify it and start the compiled server:

   ```powershell
   npm.cmd run db:migrate
   npm.cmd run db:seed
   npm.cmd run db:verify
   npm.cmd run build
   npm.cmd start
   ```

   The server listens on `http://127.0.0.1:3000` by default. Startup checks the database and permissions; it does not migrate or seed automatically.

4. In another terminal, check the running server:

   ```powershell
   curl.exe -i "http://127.0.0.1:3000/health"
   curl.exe -i "http://127.0.0.1:3000/ready"
   ```

   Both return HTTP 200 with `{"status":"ok"}` and `{"status":"ready"}`, respectively, when correctly configured.

## Matching API

```powershell
# Rank all candidates for Backend Detective, job 1.
curl.exe -i "http://127.0.0.1:3000/jobs/1/matches"

# Rank all jobs for Sherlock H., candidate 1.
curl.exe -i "http://127.0.0.1:3000/candidates/1/matches"
```

Both endpoints return `policyVersion`, `subject` and an ordered `matches` array. Each match includes its type, ID, label, availability, numeric score and reason. With the supplied fixture, job 1 returns 15 candidates: Sherlock H. leads with 100, followed by Sheldon C. with 46.67. Candidate 1 returns six jobs, led by Backend Detective with 100; the other five score 20.

IDs must be positive integers up to 2147483647, without leading zeros. Query parameters are rejected. Missing subjects return 404; an existing subject with no counterparts returns an empty array. See [complete responses and error behavior](backend/README.md#api-examples).

## Architecture and matching decisions

The HTTP layer validates requests and serializes responses; a service reads profiles through repositories; a pure TypeScript policy scores and orders them. Parameterized, handwritten SQL keeps queries and transaction boundaries visible without an ORM. The Recruiter Bot schema has five domain tables: candidates, jobs, skills and the two skill junction tables, with foreign keys and unique skill labels. Descriptive traits and culture keywords remain arrays on their parent records. A separate migration ledger records versions and checksums.

Matches are computed on each request rather than persisted. This avoids stale rankings after profile edits and is inexpensive for the supplied dataset, at the cost of reading and sorting every counterpart. Each successful request uses one client and a read-only `REPEATABLE READ` transaction for the subject and counterpart queries. Profiles are validated, then the transaction commits and the client is released before scoring. The restricted runtime login has SELECT access to the five domain tables, with no writes, DDL or migration-ledger access. Migration and seed commands use a separate owner login.

The score is `80 × skill coverage + 20 × experience fit`. Coverage is the fraction of distinct required skills the candidate has, using trimmed, lowercase exact labels. Experience fit is `min(candidate years / required years, 1)`; a zero-year requirement gives full experience credit. Skills carry most of the weight because they are the clearest supplied evidence of fit. Capping experience prevents surplus years from outweighing missing skills. Extra candidate skills are not penalized. These weights are an explicit heuristic, not a calibrated hiring probability; synonyms and semantic skill similarity are not modeled.

Both directions use the same pair score. Results sort by unrounded score descending, then skill coverage descending, then counterpart ID ascending. Display scores use decimal half-up rounding to two decimal places without affecting ordering and remain JSON numbers, so 100 is returned as `100`, not `"100.00"`. Availability, traits, quirks, culture keywords and taglines are preserved but do not alter scores or filter results: the assignment does not define their scoring semantics. Candidates marked `Not looking` and zero-score matches remain visible; candidate availability is returned and job availability is `null`.

## SQL Detective

The submitted answer file is **[backend/sql_detective.sql](backend/sql_detective.sql)**: one read-only query per question, each preceded by its question-number comment. The independent [setup SQL](backend/sql/detective/setup.sql) contains the original schema and seed statements. [Part 2 setup and commands](backend/README.md#sql-detective-setup-and-answers) create `sql_detective`, restrict Bot access, load the fixture and execute the answers without starting the API.

The queries keep posting IDs distinct even when titles repeat. Question 2 counts distinct applicant records reaching Final, including zero-count postings and all outcomes. Question 3 treats trimmed, lowercase email as a person-identity proxy and interviews as evidence of a posting link, without rewriting source data. Question 4 counts Final interview rows and returns a fractional conversion rate for recruiters with at least three such rows. The bonus uses `DENSE_RANK` to retain tied department winners. See [detailed assumptions and baseline results](backend/README.md#sql-detective-assumptions-and-results).

## Verification and limitations

Recorded clean-checkout verification of revision `5e077a0` passed dependency installation, typecheck, lint, build and **182 tests with zero failures or skips**: 116 unit/infrastructure, 32 storage, 15 matching API and 19 SQL Detective. Fresh migrations and reruns, exact seed values, runtime permissions, all 90 candidate/job pairs in both directions and all five Detective results were checked against PostgreSQL 18.6. Compiled startup, both probes, documented API responses and direct execution of the SQL answer file also succeeded.

Five additional active-database shutdown tests passed separately, bringing the recorded total to **187**. They cover draining active requests, refusing new connections, statement timeout and the ten-second shutdown deadline. They were not part of the earlier clean-checkout run. On Windows, tests invoke the installed SIGINT/SIGTERM handlers through IPC; **native Windows console signal delivery remains unverified**. Node.js 24 is accepted by the package configuration but was not exercised in the recorded run.

This documentation revision is checked against tracked paths, package scripts, configuration and response fixtures; installation, build and live database suites were not rerun for the README changes. [Test commands and prerequisites](backend/README.md#optional-tests) are included for reproduction. The API returns every counterpart without pagination and binds to loopback; the scoring and email-identity assumptions limit its use beyond this small assignment dataset.

## AI assistance

AI assistants contributed to requirements analysis, design, implementation, handwritten SQL, tests, documentation, debugging and automated verification. 