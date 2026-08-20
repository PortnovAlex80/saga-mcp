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
- **Scope insufficiency is a lawful exit, not a failure to hide.** If the
  acceptance criteria genuinely require a path the frozen `changeScopes`
  do not contain, do NOT write it undeclared and do NOT silently skip the
  criterion: conclude the attempt with
  `worker_done({ outcome: 'scope-insufficient', requested_scopes: [<the honestly needed paths/dirs>] })`
  and stop. The carve authority decides the widening on contention; you
  state the need, you never grant it to yourself.
- Local checks that prove the bound AC(s) hold have been run.
- Independent review approved the exact source commit (or a changes_requested loop completed).
- The reviewed source commit is committed on the task branch and left for the factory's git-integration effect to merge — no worker-side merge was performed (stage-8: the merge tools are not granted to workers).
- `worker_done` is called exactly once, then the process exits.

If review requested changes or the integration conflicted:

- Do not invent ids, widen scope or bypass the gates.
- Fix in place; the task branch/worktree survives the re-work loop.
- A factory-integration conflict arrives as repair feedback — fix the source; the factory re-integrates.

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
