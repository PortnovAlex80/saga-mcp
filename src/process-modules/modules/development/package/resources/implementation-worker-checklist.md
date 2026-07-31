# Development implementation worker checklist

Before `worker_done`:

- The task was claimed through `worker_next`; you did not self-hire.
- The change implements every AC listed in the task's `acceptanceCriterionIds`.
- The branch is task-scoped; commits are reviewable and minimal.
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

The settlement kernel reads the resulting tracker state to reconstruct the
implementation workset; it does not trust worker-reported summaries.
