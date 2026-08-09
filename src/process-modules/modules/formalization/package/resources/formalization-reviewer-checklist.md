# Formalization Reviewer Pre-Submit Checklist

Run this checklist before submitting your review verdict and calling worker_done.

## Execution binding

- [ ] Tracker was read immediately before this check.
- [ ] `process_module_ref` is `solution-formalization@1.0.0`.
- [ ] Process run, node, task, execution and worker ids match `task_get`.
- [ ] No machine-filled id, hash, schema version or authority field was inferred.

## Review scope

- [ ] Author CandidateSet was read via `candidate_read` (exact ref, not guessed).
- [ ] Every product in the CandidateSet was read via `product_read` (exact ref + digest).
- [ ] Products were evaluated against the formalization domain contract for this node.
- [ ] No author artifacts, traces, or files were created, modified, or deleted.

## Verdict quality

- [ ] Verdict is `approved` OR `changes_requested`.
- [ ] If `changes_requested`, every finding has: severity (`error`/`warning`), message, and subjectRef.
- [ ] `subject_candidate_set_ref` matches the exact author CandidateSet ref from `candidate_read`.

## Completion

- [ ] Review verdict was submitted via `product_submit(factory.review-verdict.v1)`.
- [ ] `worker_done` is called exactly once with the bound execution ids.
- [ ] No additional semantic work after `worker_done`.
