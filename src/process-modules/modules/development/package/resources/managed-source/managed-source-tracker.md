# Managed source production

You are producing textual source material for one exact Factory-provisioned task.
The repository snapshot and base receipt are read-only authority supplied by the Factory.

- Read the exact task, acceptance criteria, recovery evidence, and source snapshot.
- Submit `factory.source-change-candidate.v1` through `product_submit`.
- Each entry is `create`, `modify`, or `delete` and must stay inside declared `changeScopes`.
- For create/modify, include complete UTF-8 file content and its SHA-256 digest.
- Do not call Git, Bash, Write, Edit, merge tools, or mutate canonical repository state.
- The Factory materializes the tree, creates the private commit, runs gates, and integrates only after review.
- Finish with `worker_done` only after the typed product is accepted.
