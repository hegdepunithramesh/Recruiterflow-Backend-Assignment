# Recruiter Bot and SQL Detective

Backend Developer assignment, **Section B: Recruiter Bot and SQL Detective**. Recruiter Bot ingests the supplied candidates/jobs and has a pure engine for ranking matches in both directions. SQL Detective is the separate handwritten SQL challenge in the same assignment.

**Current completion: Phase 06 pure matching engine is implemented and unit-verified.** It combines 80% required-skill coverage with 20% capped experience fit, using the same scorer in both directions. Phase 05 storage remains verified on PostgreSQL 18.6: 15 candidates, six jobs, 27 skills and 66 skill relationships. The earlier connectivity blocker remains resolved.

See [backend setup, algorithm, commands and verification](backend/README.md) for self-contained instructions and trade-offs. Build, typecheck, lint and all 96 unit/infrastructure tests passed, including 50 matching tests covering all 90 fixture pairs. Phase 05 database evidence is recorded separately; no live database operations ran in Phase 06.

Both HTTP matching APIs, their SQL repositories and SQL Detective dataset/answers remain pending; the full Section B assignment is unfinished. Phase 07 has not started.

AI assistance was used for requirements extraction, product/system/test documentation, backend scaffolding, handwritten schema/seed and matching implementation, tests, review and debugging. Human review and the remaining assignment verification are still required. Authentication, multi-tenancy, billing, deployment, QA and frontend assignments are outside the current scope.
