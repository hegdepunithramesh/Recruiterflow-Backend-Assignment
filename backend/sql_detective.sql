-- Question 1: currently open postings and their owning recruiter.
-- Status is authoritative. Keep duplicate titles as separate posting IDs.
SELECT j.id AS job_posting_id, j.title, r.id AS recruiter_id, r.name AS recruiter_name
FROM public.job_postings j
JOIN public.recruiters r ON r.id = j.recruiter_id
WHERE j.status = 'open'
ORDER BY j.id;

-- Question 2: distinct applicant records reaching Final for every posting.
-- Repeated Finals for the same applicant/posting count once. All outcomes count.
-- Filtering in the LEFT JOIN preserves zero-count postings. This counts records,
-- not the normalized people used in Question 3. No open-status filter applies.
SELECT j.id AS job_posting_id, j.title,
       COUNT(DISTINCT i.applicant_id)::INTEGER AS final_applicant_count
FROM public.job_postings j
LEFT JOIN public.interviews i ON i.job_posting_id = j.id AND i.stage = 'Final'
GROUP BY j.id, j.title
ORDER BY j.id;

-- Question 3: people linked to more than one distinct posting through interviews.
-- Email is an identity proxy only: trim/lowercase at query time, never rewrite data.
-- NULL/blank emails fall back to applicant ID in a separate key column, avoiding
-- accidental merging or collisions with real email identities. Names are labels.
-- Include all identity records in applicant_ids, even records without interviews.
WITH normalized AS (
  SELECT id, full_name, NULLIF(lower(trim(email)), '') AS canonical_email
  FROM public.applicants
), identities AS (
  SELECT canonical_email,
         CASE WHEN canonical_email IS NULL THEN id END AS fallback_id,
         MIN(id) AS representative_id,
         array_agg(id ORDER BY id) AS applicant_ids
  FROM normalized
  GROUP BY canonical_email, CASE WHEN canonical_email IS NULL THEN id END
), applications AS (
  SELECT n.canonical_email,
         CASE WHEN n.canonical_email IS NULL THEN n.id END AS fallback_id,
         array_agg(DISTINCT i.job_posting_id ORDER BY i.job_posting_id) AS job_posting_ids,
         COUNT(DISTINCT i.job_posting_id)::INTEGER AS job_count
  FROM normalized n
  JOIN public.interviews i ON i.applicant_id = n.id
  WHERE i.job_posting_id IS NOT NULL
  GROUP BY n.canonical_email, CASE WHEN n.canonical_email IS NULL THEN n.id END
  HAVING COUNT(DISTINCT i.job_posting_id) > 1
)
SELECT a.canonical_email, n.full_name AS representative_name, p.applicant_ids,
       a.job_posting_ids, a.job_count
FROM applications a
JOIN identities p ON p.canonical_email IS NOT DISTINCT FROM a.canonical_email
                 AND p.fallback_id IS NOT DISTINCT FROM a.fallback_id
JOIN normalized n ON n.id = p.representative_id
ORDER BY p.representative_id;

-- Question 4: passed Final interviews / all Final interviews, at least three total.
-- Count interview rows, including repeated Finals and failed/no_show/NULL outcomes
-- in the denominator and threshold. The supplied NULL outcome is Technical.
-- Cast before division to return an unrounded NUMERIC fraction, not integer division
-- or a percentage. Closed/on-hold postings remain eligible.
SELECT r.id AS recruiter_id, r.name AS recruiter_name,
       (COUNT(*) FILTER (WHERE i.outcome = 'passed'))::INTEGER AS passed_final_interviews,
       COUNT(*)::INTEGER AS total_final_interviews,
       (COUNT(*) FILTER (WHERE i.outcome = 'passed'))::NUMERIC / COUNT(*) AS conversion_rate
FROM public.recruiters r
JOIN public.job_postings j ON j.recruiter_id = r.id
JOIN public.interviews i ON i.job_posting_id = j.id AND i.stage = 'Final'
GROUP BY r.id, r.name
HAVING COUNT(*) >= 3
ORDER BY r.id;

-- Question 5 (Bonus): most passed-at-Final interview rows per department.
-- DENSE_RANK returns all tied winners. Only success count belongs in the window
-- ordering, so recruiter IDs cannot break ties. Zero-success departments are absent.
-- Count interview rows, not people/titles. Preserve NULL departments as their own group.
WITH placements AS (
  SELECT j.department, j.recruiter_id, COUNT(*)::INTEGER AS successful_placements
  FROM public.job_postings j
  JOIN public.interviews i ON i.job_posting_id = j.id
  WHERE i.stage = 'Final' AND i.outcome = 'passed'
  GROUP BY j.department, j.recruiter_id
), ranked AS (
  SELECT department, recruiter_id, successful_placements,
         DENSE_RANK() OVER (PARTITION BY department ORDER BY successful_placements DESC) AS placement_rank
  FROM placements
)
SELECT w.department, r.id AS recruiter_id, r.name AS recruiter_name, w.successful_placements
FROM ranked w
JOIN public.recruiters r ON r.id = w.recruiter_id
WHERE w.placement_rank = 1
ORDER BY w.department ASC NULLS LAST, r.id;
