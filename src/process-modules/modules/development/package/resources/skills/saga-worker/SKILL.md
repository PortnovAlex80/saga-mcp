---
name: saga-worker
description: "Execute one assigned Development Production Cell desk, publish its exact typed product, complete the fenced task, and integrate approved repository work."
---

# Development Production Cell worker

One launch owns one pre-assigned task. Read it with `task_get`, work only inside
the machine-provisioned repository desk, complete the protocol, then stop. Never
create, pick or reassign tasks.

## Frozen desk contract

Read these task metadata fields before acting:

- `process_node_input` and `cell_input_item`: exact upstream products and work;
- `process_execution_profile_id`: author, reviewer or verifier role;
- `process_workspace`: tracker, checklist paths, and the repository desk binding;
- `trusted_provider_bindings`: exact provider identities allowed for evidence.

The factory has already prepared your git workspace. The prompt carries a
REPOSITORY DESK block with exact `execution_path`, `task_branch`, `base_commit`,
and `integration_branch`. You MUST NOT create worktrees, switch branches, or
choose a starting commit — all of that is done.

The declared output schema is mandatory. Before `worker_done`, call
`product_submit` exactly once with a complete JSON product matching that
schema. A prose completion message is not a product.

## Author desk

- **REPAIR ATTEMPT (read this first):** if the runner prompt shows a
  `⚠️ REPAIR ATTEMPT` block with `recovery_feedback=<path>`, this is a rework
  cycle — a previous submission of this task was REJECTED by the gate. Read that
  `recovery-feedback.json` file FIRST. Its `issue.findings[]` are
  machine-authored loop input naming the EXACT defects (files to add/change,
  assertions to satisfy, unmet ACs) and the required remediation. Address EVERY
  finding before resubmitting; do not repeat the rejected content.
- Work inside the machine-provisioned worktree (`execution_path` from the
  REPOSITORY DESK block). The task branch is already checked out for you.
- Respect the item AC coverage, dependency results and `changeScopes`.
- `snapshot.changedFiles` is an exact file manifest, never a directory summary:
  enumerate every added, modified, deleted, or renamed Git path exactly as the
  authoritative base-to-source diff reports it.
- Change only what is needed for one coherent, reviewable product increment.
- Run the strongest deterministic checks available and preserve their output.
- Product Build as a whole requires both `npm test` and `npm start`, but one
  scoped implementation item does not own the whole product. Create or change
  `package.json`, product-wide tests, and launch wiring only when those paths
  are inside this item's frozen `changeScopes`. Otherwise leave that work to
  its declared downstream owner. Never widen scope merely to make an
  intermediate candidate globally runnable.
- Commit your work on the task branch that is already checked out. Do NOT
  create a new branch, do NOT switch branches.
- Submit `factory.development-implementation-result.v1`. Its required fields
  are `workItemKey`, `terminalStatus`, `source`, `snapshot`, `repository`,
  `buildProducts`, and `reasonCodes`. `source.branch` must be the task branch
  from the REPOSITORY DESK; `source.commitSha` is your commit on that branch;
  `source.workItemKey` must equal the top-level `workItemKey`;
  `snapshot` binds that same `commitSha`, its `treeSha`, and the changed-file
  records; `repository` binds `projectRepositoryId`, `name`,
  `integrationBranch`, and `baseCommit`. `terminalStatus=complete` is valid
  only when the source commit exists at the declared task branch and its tree
  equals the snapshot.
- **Readiness declaration (LR-04)** — when THIS work item owns the product's
  build/test wiring (build files inside your frozen `changeScopes`), the result
  payload MUST also carry `readiness`:
  `{ "kind": "static" | "served", "commands": { "installCommand": <string|null>, "testCommand": <string> } }`
  plus, for `kind:"served"` only, `"serve": { "startCommand": <string> }`.
  `static` = runnability is proven by the test command alone (library, static
  site). `served` = a long-running service: state how it starts — the factory
  will run it on loopback, probe it, then stop it. **PORT CONTRACT (mandatory):**
  the readiness gate assigns a DETERMINISTIC port and passes it in the `PORT`
  environment variable (`HOST`=127.0.0.1) — a served product MUST read `PORT`
  from the environment and bind EXACTLY that port (fallback default allowed
  only when PORT is unset). A hardcoded port will never be probed and the
  readiness check will fail regardless of code quality. You are the AUTHORITY for
  how your artifact runs: the final local-runnability gate executes these
  commands verbatim and FAILS CLOSED when the profile is missing — it refuses
  to guess from build files, so without your declaration the product cannot
  pass acceptance regardless of code quality.
- **Containerized execution (environment.image)** — optionally state
  `"environment": { "image": "<docker-image-ref>" }` on either profile kind.
  When present, the readiness gate runs the product's install/test/serve
  commands INSIDE that Docker image instead of on the host. The image is the
  AUTHORITY for the execution environment (toolchain, runtime, system deps) —
  the gate does not install or infer tooling. A digest-pinned reference
  (`image@sha256:...`) is encouraged so the image itself is content-addressed
  and the readiness proof is reproducible; any valid docker image reference is
  accepted. When `environment.image` is declared the product runs in a linux
  container: the PORT is published to `127.0.0.1` on the host, and `HOST=0.0.0.0`
  is passed — a served product MUST bind `0.0.0.0` (all interfaces) inside the
  container, NOT loopback, or the host-side probe will never reach it. If the
  docker daemon is unavailable while an image is declared, the readiness check
  FAILS CLOSED (outcome `failed`, not retried) — it does not silently fall back
  to host. Set `SAGA_LOCAL_RUNNABILITY_EXEC=host` to force the host path for
  debugging.
- Call `worker_done` and stop. The runtime-owned post-acceptance provider merges
  the exact reviewed source commit; an LM must not mutate the integration branch
  or manufacture an integration receipt.

When scope recovery feedback names paths outside authority, remove those paths
from the task commit even if they seem useful as lint, documentation, lockfile,
or bootstrap configuration. Do not defend or retain unauthorized convenience
files. If the product needs them, a graph item whose frozen scopes own them must
create them later.

## Staging & Commit Discipline

- NEVER `git add -A` and NEVER `git add .`. Stage ONLY your in-scope paths,
  explicitly, one `git add <path>` per file or directory inside this item's
  frozen `changeScopes`.
- NEVER stage or commit factory-managed files: the tracker, anything under
  `docs/**/executions/**`, and `.saga-bootstrap.md`. Update the tracker exactly
  as instructed, but LEAVE IT UNCOMMITTED — it is factory bookkeeping, not
  product source, and it is outside your change authority even when it sits in
  your working tree.
- Before `worker_done`, recompute `git diff --name-only <base_commit>..<your-commit>`
  and declare EXACTLY that path set in `snapshot.changedFiles`, minus the
  factory-managed paths above. The gate compares your declaration against the
  authoritative diff; a tracker or execution-doc path inside the diff is a
  failed submission no matter how good the code is.
- On a changed-files-mismatch repair: do not guess and do not retype the list
  from memory. Recompute the diff, remove any factory-managed path from the
  commit, and re-declare exactly what the corrected diff reports.

## Reviewer desk

- The factory has provisioned a read-only detached checkout at the frozen
  CandidateSet source commit. Work inside `execution_path` from the REPOSITORY
  DESK block. Do NOT commit or push — this is a read-only desk.
- Review the exact author CandidateSet and source commit, not the moving branch.
- Check declared scope, AC coverage, deterministic checks and unintended
  regressions independently.
- A blocking finding must be repairable inside this work item's frozen
  `changeScopes` and owned ACs. Missing product-wide files or commands that are
  explicitly owned by a future task-graph item are deferred work, not a defect
  in the current candidate. They may be recorded as a non-blocking limitation,
  but MUST NOT produce `changes_requested`. A regression to a command or file
  already present at the effective base remains blocking when this candidate
  caused it.
- Submit one `factory.development-review-verdict.v1` with required `verdict`,
  `workItemKey`, and `reviewedCandidate.sourceCommit/sourceTree`, all bound to
  the author product. Then call `worker_done` with the same verdict.
- Do not edit or integrate repository content.

## Verification desk

- Verify only the frozen integrated candidate supplied in upstream input. The
  factory provisions a read-only detached checkout at the integrated commit.
- Bind evidence to the item AC id, its accepted hash and the exact
  `candidateHash`; never reconstruct or substitute another branch.
- Record only observed evidence. Use `unknown` when the required environment or
  measurement is unavailable and `error` when the verification mechanism
  fails; neither is a pass.
- Submit exactly one `factory.candidate-verification-evidence-product.v2`.
  The executable Factory contract rejects aliases, missing fields and extra
  top-level fields before `worker_done`:

  ```json
  {
    "schemaVersion": "factory.candidate-verification-evidence-product.v2",
    "verificationItemKey": "<exact cell_input_item.key>",
    "acceptanceCriterionId": 123,
    "acceptedCriterionHash": "<exact accepted AC SHA-256>",
    "candidateHash": "<exact frozen candidate SHA-256>",
    "coveredConstraintIds": ["ord-c-001"],
    "outcome": "passed|failed|unknown|error",
    "evidence": {
      "summary": "<what was actually established>",
      "observations": ["<specific observation/check and result>"],
      "limitations": []
    }
  }
  ```

  When your task's `cell_input_item` carries `coveredConstraintIds` (the
  order-constraint register IDs pinned to this card), echo that EXACT array
  verbatim in `coveredConstraintIds` — the lineage check pins it together
  with `acceptanceCriterionId`; a missing or divergent set is rejected as a
  lineage mismatch. Omit the field entirely when the card pins none.

  The enclosing immutable product is the content-addressed evidence reference;
  do not invent a nested reference. Provider trust is injected from the
  Factory-frozen WorkIntent and must not be claimed in worker JSON.
- Call `worker_done` and stop. Verification never mutates or merges code.

## Hard invariants

- The live task/execution fence must match every write.
- `product_submit` precedes `worker_done`.
- Repository work is complete only after approved integration is recorded.
- Do not continue after the terminal tool response.
- `worker_ask_need` is terminal for the launch: its `stop: true` response means
  preserve the question and exit immediately.
- Never weaken, fabricate or silently omit evidence to make a gate pass.
