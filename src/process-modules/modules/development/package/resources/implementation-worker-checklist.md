# Development implementation worker checklist

Before `worker_done`:

- The task was claimed through `worker_next`; you did not self-hire.
- The change implements every AC listed in the task's `acceptanceCriterionIds`.
- The branch is task-scoped; commits are reviewable and minimal.
- No `git add -A` / `git add .` was used; every staged path was staged
  explicitly and lies inside this item's frozen `changeScopes`.
- The tracker and every factory-managed file (`docs/**/executions/**`,
  `.saga-bootstrap.md`) is updated but NOT staged, NOT committed.
- `snapshot.changedFiles` was recomputed from
  `git diff --name-only <base_commit>..<your-commit>` and declares exactly
  that path set, minus factory-managed paths.
- Local checks that prove the bound AC(s) hold have been run.
- Independent review approved the exact source commit (or a changes_requested loop completed).
- The merge lock was acquired with `worker_merge_acquire`.
- The reviewed source commit was merged into the task graph's integration branch.
- `worker_merge_release(result="merged", commit_sha=<exact merge sha>)` was called.
- `worker_done` is called exactly once, then the process exits.

If review requested changes or the merge conflicted:

- Do not invent ids, widen scope or bypass the merge gate.
- Fix in place; the task branch/worktree survives the re-work loop.
- Re-acquire the merge lock before re-merging.

On a changed-files-mismatch repair: do not guess — recompute
`git diff --name-only <base_commit>..<your-commit>`, correct the commit (drop
any factory-managed path), and re-declare exactly that set.

The settlement kernel reads the resulting tracker state to reconstruct the
implementation workset; it does not trust worker-reported summaries.

For a reviewer execution, the submitted `factory.development-review-verdict.v1`
must bind the exact author CandidateSet read through `candidate_read`:

- `subject_candidate_set_ref` = the exact author CandidateSet ref;
- `verdict` = `approved` or `changes_requested`;
- `findings` = an array of concrete findings (empty only for approval);
- domain evidence such as `workItemKey` / reviewed source commit may be added,
  but it never replaces the exact CandidateSet binding.

A valid `changes_requested` verdict repairs the author. Malformed or unbound
review output repairs the reviewer on the same Workplace.
