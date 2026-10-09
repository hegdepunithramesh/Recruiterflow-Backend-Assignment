# Recruiter Bot and SQL Detective

Backend Developer assignment, **Section B: Recruiter Bot and SQL Detective**. Recruiter Bot ingests the supplied candidates/jobs and exposes ranked matches in both directions. SQL Detective is the separate handwritten SQL challenge in the same assignment.

**Current completion: Phase 08 SQL Detective implementation and live PostgreSQL verification are complete.** Recruiter Bot's two matching APIs remain verified, using the unchanged 80% skill / 20% experience policy. Part 2 provides the original four-table/47-row setup and [five numbered SQL answers](backend/sql_detective.sql), including the window-function bonus, independently of Bot tables.

See [backend setup, API examples, Detective commands and verification](backend/README.md) for self-contained instructions and assumptions. The Detective setup/reference matches every PDF definition/value. Build, typecheck, lint and all 116 unit/infrastructure tests passed. Read-only Bot verification and development curl rechecks still returned 15 candidate matches and six job matches. Historical Phase 07 PostgreSQL suites verified all 90 pairs and storage behavior.

The user reported **19 live PostgreSQL Detective tests passed, zero failures and zero skips**, verifying all five baseline results, the exact fixture, no-op loader rerun and transactional edge cases. The dedicated Detective connection/setup blocker is resolved. The backend README records each verified result. Finished-assignment clean-checkout reproduction and submission review remain pending. Work stops at Phase 08; Phase 09 has not started.

AI assistance was used for requirements extraction, product/system/test documentation, backend scaffolding, handwritten schema/seed, matching and Detective implementation, tests, review and debugging. Human review and the remaining assignment verification are still required. Authentication, multi-tenancy, billing, deployment, QA and frontend assignments are outside the current scope.
