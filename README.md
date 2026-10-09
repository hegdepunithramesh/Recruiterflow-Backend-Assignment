# Recruiter Bot and SQL Detective

Backend Developer assignment, **Section B: Recruiter Bot and SQL Detective**. Recruiter Bot ingests the supplied candidates/jobs and exposes ranked matches in both directions. SQL Detective is the separate handwritten SQL challenge in the same assignment.

**Current completion: Phase 07 bidirectional matching APIs are implemented and verified.** `GET /jobs/{id}/matches` returns candidates; `GET /candidates/{id}/matches` returns jobs. Both use the unchanged 80% skill / 20% experience policy, with scores, reasons, deterministic ordering and safe errors. PostgreSQL 18.6 stores the exact 15 candidates, six jobs, 27 skills and 66 skill relationships.

See [backend setup, API examples, algorithm and verification](backend/README.md) for self-contained instructions. Build, typecheck, lint and all 101 unit/infrastructure tests passed. Real PostgreSQL HTTP tests verified all 90 pairs in both directions; the storage suite passed with its fresh-database case explicitly skipped on rerun. Development curl checks returned HTTP 200 with 15 candidate matches and six job matches.

SQL Detective dataset/answers, finished-assignment clean-checkout reproduction and submission review remain pending, so the full Section B assignment is unfinished. Work stops at Phase 07.

AI assistance was used for requirements extraction, product/system/test documentation, backend scaffolding, handwritten schema/seed and matching implementation, tests, review and debugging. Human review and the remaining assignment verification are still required. Authentication, multi-tenancy, billing, deployment, QA and frontend assignments are outside the current scope.
