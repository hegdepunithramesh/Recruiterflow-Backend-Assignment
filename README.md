# Recruiter Bot and SQL Detective

Backend Developer assignment, **Section B: Recruiter Bot and SQL Detective**. Recruiter Bot ingests the supplied candidates/jobs; ranking matches in both directions remains to be implemented. SQL Detective is the separate handwritten SQL challenge in the same assignment.

**Current completion: Phase 05 schema, migrations and exact assignment seed are implemented and verified on PostgreSQL 18.6.** The five domain tables contain 15 candidates, six jobs, 27 skills and 66 skill relationships. Migration/seed reruns, constraints, rollback and runtime read-only permissions were checked against real PostgreSQL. The earlier connectivity blocker remains resolved.

See [backend setup, commands and verification](backend/README.md) for self-contained installation, migration, seed, runtime and test instructions. Build, typecheck, lint and all 46 unit/infrastructure tests passed. The database suite passed after correcting a PostgreSQL 18 error-code expectation; its fresh-migration case passed on the initial run and was skipped on rerun.

Scoring, both matching APIs and SQL Detective dataset/answers remain pending; the full Section B assignment is unfinished. Phase 06 has not started.

AI assistance was used for requirements extraction, product/system/test documentation, backend scaffolding, handwritten schema/seed implementation, tests, review and debugging. Human review and the remaining assignment verification are still required. Authentication, multi-tenancy, billing, deployment, QA and frontend assignments are outside the current scope.
