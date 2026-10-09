-- All identifiers are handwritten and fixed, including the disposable test target.
DO $permissions$
BEGIN
    IF current_database() = 'recruiter_bot' THEN
        REVOKE ALL ON DATABASE recruiter_bot FROM PUBLIC, recruiter_bot_app;
        GRANT CONNECT ON DATABASE recruiter_bot TO recruiter_bot_app;
    ELSIF current_database() = 'recruiter_bot_phase05_test' THEN
        REVOKE ALL ON DATABASE recruiter_bot_phase05_test FROM PUBLIC, recruiter_bot_app;
        GRANT CONNECT ON DATABASE recruiter_bot_phase05_test TO recruiter_bot_app;
    ELSE
        RAISE EXCEPTION 'Unsupported database target';
    END IF;
END;
$permissions$;

REVOKE ALL ON SCHEMA public FROM PUBLIC, recruiter_bot_app;
GRANT USAGE ON SCHEMA public TO recruiter_bot_app;

REVOKE ALL ON TABLE public.candidates, public.jobs, public.skills,
    public.candidate_skills, public.job_skills, public.schema_migrations
    FROM PUBLIC, recruiter_bot_app;
GRANT SELECT ON TABLE public.candidates, public.jobs, public.skills,
    public.candidate_skills, public.job_skills TO recruiter_bot_app;
REVOKE ALL ON SEQUENCE public.skills_id_seq FROM PUBLIC, recruiter_bot_app;

-- No ledger SELECT, sequence usage, writes, DDL or temporary-table privilege.
