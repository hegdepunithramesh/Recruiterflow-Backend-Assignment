# Recruiter Bot and SQL Detective

Backend Developer assignment, **Section B: Recruiter Bot and SQL Detective**. Recruiter Bot will ingest the supplied candidates/jobs and rank matches in both directions. SQL Detective is the separate handwritten SQL challenge in the same assignment.

**Current completion: Phase 04 infrastructure is implemented and live database connectivity is verified.** On 9 October 2026, the user reported PostgreSQL 18.6 accepting connections on 127.0.0.1:5432, the recruiter_bot database and restricted recruiter_bot_app login created, successful backend startup, and HTTP 200 from both `/health` and `/ready`. The earlier connectivity blocker is resolved.

See [backend setup, commands and verification](backend/README.md) for installation, configuration and observed responses. The initial infrastructure checks passed build, typecheck, lint and 33 tests.

Connectivity does not verify domain storage or matching. Domain tables, migrations, seeds, scoring, both matching APIs and SQL Detective answers remain pending; the full Section B assignment is unfinished. Phase 05 has not started.

AI assistance was used for requirements extraction, product/system/test documentation, backend scaffolding, tests, review and debugging. Human review and the remaining assignment verification are still required. Authentication, multi-tenancy, billing, deployment, QA and frontend assignments are outside the current scope.
