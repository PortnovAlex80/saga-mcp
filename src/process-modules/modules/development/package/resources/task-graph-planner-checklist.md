# Development planning checklist

Before `process_node_submit`:

- Frozen AC and repository ids, branches and base commits are unchanged.
- Implementation tasks express coherent product increments, not AC cardinality.
- Shared foundations precede dependent work through `dependsOnKeys`.
- Every implementation task has one repository and non-empty AC coverage.
- Every implementation task has conservative non-empty `changeScopes`.
- Same-repository scope overlaps are ordered by a dependency path.
- Parallel tasks are independent from the same frozen base.
- All dependencies are closed, acyclic and implementation-to-implementation.
- Required implementation work covers every implementation-required AC.
- Exactly one required verification item covers each accepted AC.
- Verification items have one AC, one frozen repository and empty `changeScopes`.
- Integration targets match frozen repositories exactly.
- Required implementation keys form an exact one-target partition.
- No placeholder remains; JSON parses; the declared schema is exact.
- No task, Git, CI or repository mutation was attempted.
- `process_node_submit` precedes the single `worker_done` call.
