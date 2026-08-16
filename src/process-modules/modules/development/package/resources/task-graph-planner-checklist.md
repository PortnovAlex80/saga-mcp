# Development planning checklist

Before `product_submit`:

- Frozen AC and repository ids, branches and base commits are unchanged.
- `acceptanceCriterionIds` contains the exact integer atomic criterion ids from the
  machine-filled call; never substitute criterion hashes or document artifact ids.
- On a resubmit, every verification item's ids were RESTORED VERBATIM from the
  machine-prefilled call file — no hand-retyped, substituted, or foreign-project
  ids (brief/PRD artifact ids are not criterion ids).
- Every module declared in the accepted SRS decomposition still has its
  implementation item; nothing was deleted, merged, or shrunk to make a check pass.
- Every repair edit is a minimal targeted operation named by the findings:
  restore/drop one id, add the missing dependency edge, or use the exact
  required directory scope (`tests/`, not `tests/foo.test.js`).
- Implementation work expresses coherent product increments, not AC cardinality.
- Shared foundations precede dependent work through `dependsOnKeys`.
- Every implementation item has one repository and non-empty AC coverage.
- Every implementation item has conservative non-empty `changeScopes`.
- Every repository assigns all `policy.requiredChangeScopes` to implementation work.
- Same-repository scope overlaps are ordered by a dependency path.
- After every repair, recompute every pairwise same-repository scope overlap;
  do not stop after fixing only the overlaps named in an earlier candidate.
- Parallel items are independent from the same frozen base.
- All dependencies are closed, acyclic and implementation-to-implementation.
- Required implementation work covers every implementation-required AC.
- Exactly one required verification item covers each accepted AC.
- Verification items have one AC, one frozen repository and empty `changeScopes`.
- Integration targets match frozen repositories exactly.
- Required implementation keys form an exact one-target partition.
- Product schema is exactly `factory.development-task-graph-proposal.v1`.
- No placeholder remains; JSON parses; content schemaVersion is exact.
- No task, Git, CI or repository mutation was attempted.
- `product_submit` precedes the single `worker_done` call.
- If `product_submit` rejects the payload, correct the reported field paths and retry
  `product_submit` in the same execution. Call `worker_done` only after acceptance.
