# Recruiter Bot and SQL Detective

Backend Developer assignment, **Section B: Recruiter Bot and SQL Detective**. Recruiter Bot ingests the supplied candidates/jobs and exposes ranked matches in both directions. SQL Detective is the separate handwritten SQL challenge in the same assignment.

**Current completion: Section B is implemented and verified locally through Phase 09; reviewer repository access remains unverified.** Both matching APIs use the documented 80% skill / 20% experience policy. The separate four-table/47-row Detective fixture and [five numbered SQL answers](backend/sql_detective.sql), including the window-function bonus, are verified independently of Bot tables.

See [backend setup, API examples, Detective commands and verification](backend/README.md) for self-contained instructions, decisions and limitations. A clean clone of committed main at 5e077a0 reproduced installation, build, fresh storage/seeding, permissions, all five SQL answers and matching demonstrations on a fresh isolated PostgreSQL 18.6 instance. No existing database was changed.

Final successful runs: **187 passes, zero failures, zero skips** — 116 unit/infrastructure, 32 storage, 15 API, 19 Detective and five shutdown tests (Node parent tests included). The 182 existing tests ran from committed main; the five new real-database shutdown tests passed against the Phase 09 working-tree additions. Active SELECT drain, refused new requests, pool closure and bounded failure passed. Windows signal handlers were exercised through IPC; native console signal delivery remains unverified.

[Source repository](https://github.com/hegdepunithramesh/Recruiterflow-Backend-Assignment): anonymous ref access requested authentication. Confirm public visibility or the intended reviewer's private access, then review/commit the Phase 09 changes before submitting. No commit, push or submission was performed.

AI assistance was used for requirements extraction, product/system/test documentation, backend scaffolding, handwritten schema/seed, matching and Detective implementation, tests, review, debugging and Phase 09 verification. Human review and an understanding of the decisions remain essential. Authentication, multi-tenancy, billing, deployment, QA and frontend assignments remain outside this Section B submission.
