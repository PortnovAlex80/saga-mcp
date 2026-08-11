# Development planning checklist

Before `product_submit`:

- Frozen AC and repository ids, branches and base commits are unchanged.
- Implementation work expresses coherent product increments, not AC cardinality.
- Shared foundations precede dependent work through `dependsOnKeys`.
- Every implementation item has one repository and non-empty AC coverage.
- Every implementation item has conservative non-empty `changeScopes`.
- Every repository assigns all `policy.requiredChangeScopes` to implementation work.
- Same-repository scope overlaps are ordered by a dependency path.
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
