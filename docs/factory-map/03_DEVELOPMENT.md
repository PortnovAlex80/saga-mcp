# 03 — Development (factory map, Development + Delivery series)

Hypothesis status: this document is a map of what the repository actually
declares and executes today, written from code read on branch
`map/development-delivery-2026-08-23`. Docs are hypotheses; code and CI are
evidence. Every claim below carries a `path:line` citation. Where a promise
exists only in prose, it is filed under DEAD/DECLARATIVE-ONLY STRATA or
CONTRADICTIONS, not described as live behavior.

---

## PURPOSE

Development is the third stage of the `product-delivery` lifecycle. It plans,
implements, reviews, integrates, freezes, run-certifies and independently
verifies exactly one release candidate, then settles to a local terminal
outcome. Its declared identity: `solution-development` v1.4.4
(`src/process-modules/lifecycles/product-delivery-module-contracts.ts:40-43`),
kind `development`, display name "Solution Development", description "Plans,
implements, reviews, integrates, freezes and verifies one exact release
candidate."
(`src/process-modules/modules/development/development-process-module.ts:227-234`).

Development owns no lifecycle routing: it emits only local outcomes
(`verified` / `blocked` / `failed`) and the lifecycle decides the next stage
(`src/process-modules/modules/development/development-process-module.ts:550`,
`src/process-modules/lifecycles/product-delivery-lifecycle.ts:428-432`).

---

## ENTRY CONTRACT

- Stage `solution-development` maps the frozen Formalization outputs into a
  `DevelopmentCase` (`factory.development-case.v1`): formalization certificate
  (decision `formalized`), content-addressed Solution Contract + whole frozen
  payload (`solutionContractPayload`, carried whole so the optional
  `constraintRegisterCoverage` block resolves lazily per ADR-088),
  `acceptanceBaselineHash`, `srs`, `acceptanceCriteria`, `repositories` and
  `policy` from `$.development.*`, plus runtime `projectId`/`epicId`/
  `initiatedBy`
  (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:379-416`).
- Entry conditions (declared): "Formalization outcome is formalized" and
  "Solution Contract and accepted baseline are content-addressed"
  (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:433-436`).
- The case schema itself: `formalizationCertificate` (with `decision:
  'formalized'`), `solutionContract`, optional `solutionContractPayload`,
  `acceptanceBaselineHash`, `srs`, `acceptanceCriteria`, `repositories`,
  `policy`, `initiatedBy`
  (`src/modules/development/domain/development-schemas.ts:313-336`).
- Route in: Formalization outcome `formalized` routes to `solution-development`
  (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:372`).
- Flow entry node: `plan-task-graph`
  (`src/process-modules/modules/development/development-process-module.ts:245`).

**Planning is AC-keyed but not AC-only.** Task-graph items carry
`acceptanceCriterionKeys` — ATOMIC criterion identities, "criterionKeys, NOT
artifact ids" (`src/modules/development/domain/development-schemas.ts:349-350`)
— and the planner gate enforces AC coverage arithmetic
(`implementation-coverage-gap`, `verification-plan-coverage-gap`;
`src/modules/development/domain/development-settlement-policy.ts:459-540`).
But admission is additionally gated by, in the same validation:

1. **constraint register coverage** — when the frozen case carries a non-empty
   `constraintRegisterCoverage`, the reverse diff of register ids minus
   kernel-derived `coveredConstraintIds` minus typed waivers must be empty
   (`constraint-register-uncovered`), and every execution-class entrypoint file
   must lie inside the changeScopes of an item covering that same constraint
   (`constraint-entrypoint-unowned`)
   (`src/modules/development/domain/development-settlement-policy.ts:542-607`).
   The register — including the injected `synthesis` and `ordered-smoke`
   execution obligations of the `runnable-local` classification — is a counted
   deliverable claim of the order, not an AC projection
   (`src/process-modules/lifecycles/product-build-lifecycle.ts:64-83`,
   `src/shared/constraint-register.ts:124,164`).
2. **module manifest (SRS §2.2)** — the accepted plan must cover the SRS's
   declared module files; under a register-bearing corpus an unavailable SRS,
   absent §2.2, or a file-less manifest is a typed RED
   (`srs-module-manifest-missing` / `srs-module-uncovered`), never a skip
   (`src/modules/development/application/development-check-providers.ts:998-1099`).
3. **required scopes** — every scope in `policy.requiredChangeScopes` must be
   assigned to an implementation item of that repository
   (`task-graph-required-scope-missing`)
   (`src/modules/development/domain/development-settlement-policy.ts:382-396`).
4. **scope overlap ordering and verification shape** — same-repository
   overlapping items without a one-direction dependency path are rejected
   (`implementation-scope-overlap`,
   `src/modules/development/domain/development-settlement-policy.ts:398-419`);
   every verification item must be a required single-AC `read_only_evidence`
   `verification.ac` task bound to one case repository
   (`verification-plan-coverage-gap`,
   `src/modules/development/domain/development-settlement-policy.ts:420-436`);
   integration targets must exactly partition required implementation items
   (`integration-source-partition-invalid`,
   `src/modules/development/domain/development-settlement-policy.ts:438-457`).

So: AC keys are the identity spine of the graph, but AC coverage alone does
not admit a plan.

---

## PRODUCTION NODE / DESK CARDS

### 1. `plan-task-graph` — production cell (singleton)

- **id/kind:** `development-plan-task-graph`, singleton production cell, entry
  node (`src/process-modules/modules/development/development-process-module.ts:247-255`).
- **Roles:** author = planner (profile `development-task-graph-planner`,
  skill `saga-planner`, review skill `saga-planning-reviewer`;
  `src/process-modules/modules/development/development-process-module.ts:552-576`).
  The plan uses the final-phase gate only (no separate reviewer hire in the
  standard flow: `PLANNER_CHECK_PLAN` is the single final check plan,
  `src/process-modules/modules/development/development-process-module.ts:98-105`).
- **Input authority/cardinality:** node input schema
  `DEVELOPMENT_CASE_SCHEMA` (`factory.development-case.v1`); output
  `DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA`, cardinality `'1'`
  (`src/process-modules/modules/development/development-process-module.ts:253-264`).
  The proposal shape is planner-PROPOSED criterion keys only; the kernel stamps
  provenance (`sourceArtifactIds`) and the constraint relay
  (`coveredConstraintIds`) at canonicalization — "the planner can neither
  propose nor forge either field"
  (`src/modules/development/domain/development-schemas.ts:381-396`).
- **Tools/protocol:** allowed tools = common read set + `conflict_check`,
  `product_submit`, `worker_done`, `Write`, `Edit`, `Bash`; execution mode
  `tracker_only`; tracker/checklist/call-template resources under
  `src/process-modules/modules/development/package/resources/`
  (`src/process-modules/modules/development/development-process-module.ts:82-96,553-576`).
- **Output authority/schema:** typed worker product
  `development-task-graph-proposal` (authority `worker`,
  `src/process-modules/modules/development/development-process-module.ts:527`),
  payload contract `development.task-graph-payload` v1.0.0 with digest
  (`src/modules/development/application/development-check-providers.ts:171-180`).
- **Gates:** check plan `development.plan-task-graph.final` =
  `DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID` v1.2.0 (digest bound)
  (`src/process-modules/modules/development/development-process-module.ts:98-105`,
  `src/modules/development/application/development-check-providers.ts:62-64,541-546`).
  Provider run: resolves the submission by EXACT CandidateSet member
  `managed-node-submission:` ref (ADR-053 cutover — never by execution id),
  decodes, rebuilds the canonical graph, runs the policy validate + the SRS
  §2.2 manifest assessor
  (`src/modules/development/application/development-check-providers.ts:662-783`).
- **Repair/retry:** `maxAttempts: 3`, `onExhausted: 'requeue'`
  (`src/process-modules/modules/development/development-process-module.ts:265-266`);
  profile retry on `schema-rejected`, `lineage-gap`
  (`src/process-modules/modules/development/development-process-module.ts:574`).
  Rejection evidence carries the computed coverage/overlap diffs so a repair
  attempt receives the exact missing set
  (`src/modules/development/domain/development-settlement-policy.ts:480-496,405-418`).
- **State/effects:** accepted → `resolve-task-graph`; failed → `complete-failed`;
  human-required → `complete-blocked`
  (`src/process-modules/modules/development/development-process-module.ts:268-270`).
  No external effect.
- **Forward consumers:** `resolve-task-graph` kernel (canonicalization) and,
  via materialization, `implement-work-items` fan-out and
  `verify-acceptance` fan-out input selectors
  (`src/process-modules/modules/development/development-process-module.ts:291,411-413`).
- **Backward obligations:** DevelopmentCase must satisfy the case schema; the
  gate fail-closes (`error`) when the submission row does not match the exact
  CandidateSet member or the process run input schema
  (`src/modules/development/application/development-check-providers.ts:684-731`).
- **Scripted outside participant:** none at this node in the blocking suites;
  `development-task-graph-machine-fill(-e2e).test.mjs` script planner fills and
  the machine stamps the rest (filed under TEST COVERAGE).
- **Tests/CI:** see TEST COVERAGE; the gate's register-conditional coverage has
  a dedicated exact-file CI entry
  (`tools/run-acceptance-matrix.mjs:108-109`).
- **Uncovered:** the planner seam has no adversarial "planner that forges
  `coveredConstraintIds`" runtime test — protection is structural (decode
  trims the field), demonstrated only through schema-shape suites
  (`src/modules/development/domain/development-schemas.ts:386-396`).

### 2. `resolve-task-graph` — kernel (Freeze Task Graph)

- **id/kind:** kernel node, handler
  `development-resolve-task-graph`
  (`src/process-modules/modules/development/development-process-module.ts:273-282`;
  handler ids at `src/modules/development/domain/development-kernel-ports.ts:76-87`).
- **Roles:** none (deterministic kernel; module ports are declarative — "no
  executive ports: the module does not hire workers, does not merge and does
  not run tests", `src/modules/development/domain/development-kernel-ports.ts:8-12`).
- **Input authority/cardinality:** one gate-accepted proposal; the kernel
  canonicalizes and materializes "idempotently"
  (`src/process-modules/modules/development/development-process-module.ts:276-281`).
- **Tools/protocol:** kernel handler; port
  `DevelopmentTaskGraphPort.materializeValidatedTaskGraph` — implementations
  "have no access to the advisory proposal, so they cannot persist before
  authorization"
  (`src/modules/development/domain/development-kernel-ports.ts:138-151`).
- **Output authority/schema:** canonical `development-task-graph`
  (`factory.development-task-graph.v1`), authority `kernel`
  (`src/process-modules/modules/development/development-process-module.ts:528`).
  Persistence: write-once process product keyed by `processRunId` + product
  kind; replay asserts byte-equality
  (`src/modules/development/infrastructure/sqlite-development-settlement-state.ts:115-160`,
  `src/modules/development/application/development-installation.ts:355-395`).
- **Gates:** none (upstream cell gate already accepted the proposal; the
  resolver fails the node on materializer drift —
  `development task graph materializer changed the authorized graph`,
  `src/modules/development/application/development-installation.ts:370-377`).
- **Repair/retry:** idempotent replay of a stored graph returns the stored
  record (`src/modules/development/infrastructure/sqlite-development-settlement-state.ts:123-130`).
- **State/effects:** opens the append-only criterion-key verification ledger in
  the SAME transaction as the graph product (CC-GAP-8): every verification
  criterion key appended `proposed` → `pending`; triggers reject UPDATE/DELETE;
  replay never re-opens and never back-fills legacy graphs
  (`src/modules/development/infrastructure/sqlite-development-settlement-state.ts:142-152`,
  `src/modules/development/infrastructure/development-verification-ledger.ts:1-29,47,207`).
- **Forward consumers:** `implement-work-items` (items selector, dependency
  selector, provenance), `verify-acceptance` (`verificationItems`), freeze
  (graph product read), settlement (graph re-validation).
- **Backward obligations:** node transition `domain.valid`; failure goes to
  `settle-development`
  (`src/process-modules/modules/development/development-process-module.ts:478-479`).
- **Scripted outside participant:** none.
- **Tests/CI:** `tests/process-modules/development-task-graph-authorization.test.mjs`,
  `development-task-graph-machine-fill(.e2e).test.mjs` (glob-hosted);
  `development-task-graph-diagnostics.test.mjs` is quarantined
  PRE-EXISTING-RED (`tools/run-acceptance-matrix.mjs:186-188`).
- **Uncovered:** the "empty dependency table must never be accepted as the
  projection of a non-empty graph" invariant
  (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:829-832`) has its enforcement
  split between policy validation (closed `dependsOnKeys`,
  `src/modules/development/domain/development-settlement-policy.ts:344-350`)
  and executor sealing (unknown dependency → NodeExecutionError,
  `src/process-modules/application/node-executors/production-cell-node-executor.ts:697-706`);
  no suite named in the matrix drives the executor branch directly.

### 3. `implement-work-items` — production cell (fan-out)

- **id/kind:** `development-implementation`, fan-out production cell over
  `resolve-task-graph.items`
  (`src/process-modules/modules/development/development-process-module.ts:283-298`).
- **Roles:** author (profile `development-implementation-worker`, skill
  `saga-worker`, execution mode `git_change`) and reviewer (profile
  `development-implementation-reviewer`, skill
  `saga-development-code-reviewer`, mode `tracker_only`)
  (`src/process-modules/modules/development/development-process-module.ts:299-335,577-616`).
- **Input authority/cardinality:** one Workplace per work item; materialization
  binds `sourceBinding: 'resolve-task-graph'`, `workKeySelector: 'items'`,
  `dependencySelector: 'dependsOnKeys'`, `completionPolicy: 'all'`, task
  provenance `sourceArtifactIds`
  (`src/process-modules/modules/development/development-process-module.ts:290-298`).
  The executor materializes the complete set, seals the workplace graph
  (dependencies resolve to exact task/workplace edges; unknown dependency
  fails), then reconciles per item; a dependent is pending until every
  dependency is terminal-accepted and failed otherwise
  (`src/process-modules/application/node-executors/production-cell-node-executor.ts:468-534,695-712`).
- **Tools/protocol:** authors get `COMMON_WRITE_TOOLS` (read tools +
  `worker_done`, `verification_record`, `product_submit`, `Write`, `Edit`,
  `Bash`); reviewers the same list
  (`src/process-modules/modules/development/development-process-module.ts:82-96,588,608`).
  Merge tools are deliberately absent — "no worker-selected merge authority";
  the fenced git-integration post-acceptance effect owns integration
  (`src/process-modules/modules/development/development-process-module.ts:86-90`,
  enforced by `tests/architecture/no-worker-fenced-effect-grants.test.mjs`
  per that comment).
- **Output authority/schema:** one `implementationResult` product per author,
  schema `DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA`, cardinality `'1'`, payload
  contract `development.implementation-payload` v1.3.0
  (`src/process-modules/modules/development/development-process-module.ts:303-313`;
  contract at `src/modules/development/application/development-check-providers.ts:207-226`).
  Reviewer verdict schema `DEVELOPMENT_REVIEW_VERDICT_SCHEMA` with payload
  contract v1.1.0 (`subject_candidate_set_ref` must be an exact
  `candidate-set/` ref, verdict `approved|changes_requested`, findings
  string[]) (`src/modules/development/application/development-check-providers.ts:610-653`).
- **Gates:** author plan `development.implementation.author.v3` =
  implementation-scope provider v2.1.0 (git-diff equals submitted files, stays
  within frozen scopes — read through the CURRENT write authority: latest
  granted widening revision or the original carve) + claim-monotonicity
  provider v1.0.0 (a card may not silently narrow its claimed file surface;
  lawful exit is an explicit `snapshot.droppedFiles` disposition)
  (`src/process-modules/modules/development/development-process-module.ts:106-135`,
  `src/modules/development/index.ts:132-147`,
  `src/modules/development/application/development-check-providers.ts:548-565,1553-1556`).
  Final plan `development.implementation.final` = review-verdict provider
  (verdictSchemaRef = review verdict schema; repair on failure → author, on
  indeterminate → reviewer)
  (`src/process-modules/modules/development/development-process-module.ts:136-148`).
- **Repair/retry:** `recovery: { maxAttempts: 3, onExhausted: 'requeue' }`
  (`src/process-modules/modules/development/development-process-module.ts:336`).
  Repair maps to the same Workplace/desk (CONVEYOR §19); the budget is
  reason-aware in the executor through the finding-set chain (waive converging
  chains, charge spin; terminal executions and effect repairs are never
  waived)
  (`src/process-modules/application/node-executors/production-cell-node-executor.ts:2339-2389`).
- **State/effects:** accepted → `freeze-integrated-candidate`; the cell
  declares `postAcceptanceEffect: 'git-integration'`
  (`src/process-modules/modules/development/development-process-module.ts:337-339`).
  The git-integration effect (`GIT_INTEGRATION_EFFECT_ID = 'git-integration'`
  v1.0.0) asserts the accepted authority, drives the external-effect ledger,
  integrates the accepted workplace with CAS/lease semantics, observes before
  retry, and turns same-error stasis into a typed human-required outcome
  (`src/infrastructure/workplace/git-integration-effect.ts:11-27,57-182`).
  Failed → `settle-development` (CC-GAP-8: the ledger is open, so only the
  settlement seam may terminalize; settles
  `blocked/implementation-incomplete`)
  (`src/process-modules/modules/development/development-process-module.ts:341-349,489`).
- **Git integration effect details (desk bases):** the stage lineage anchor
  `expectedBaseCommit` is NOT every author's base; before spawn the Factory
  freezes an immutable effective desk-base receipt
  (`factory_effective_desk_base_receipts`, immutable by trigger; dependent
  items base on the observed integration head after prerequisites settle)
  (`src/schema.ts:1486-1523`).
- **Forward consumers:** freeze kernel reads accepted cell products and their
  git-integration receipts
  (`src/modules/development/infrastructure/sqlite-development-settlement-state.ts:246-273`).
- **Backward obligations:** exact-member resolution of the implementation
  result (mis-keyed `workItemKey` fails the scope check closed — v2.1.0 fix
  with a repair recipe, `src/modules/development/application/development-check-providers.ts:554-560`).
- **Scripted outside participant:** mock-claude composition/dispatcher
  fixtures drive author/reviewer roles in orchestrate suites
  (`tests/mock-claude/composition.mjs`, `tests/mock-claude/dispatcher.mjs`);
  those suites are largely quarantined (see TEST COVERAGE).
- **Tests/CI:** `tests/process-modules/development-implementation-scope-check.test.mjs`,
  `implementation-claim-monotonicity.test.mjs`, `capability-enforcement.test.mjs`
  (glob-hosted in the `process-modules` CI group,
  `tools/run-acceptance-matrix.mjs:83-116`); the companion suites
  `tests/modules/development/implementation-scope-ancestry.test.mjs`,
  `implementation-scope-workitemkey.test.mjs`,
  `implementation-workset-item-key.test.mjs` are FILED ORPHANS — no group
  hosts them (hosting evidence: the exact-file list at
  `tools/run-acceptance-matrix.mjs:83-163` does not include them).
- **Uncovered:** see the task-shadow seam below and UNCOVERED CONDITIONS.

### 4. `freeze-integrated-candidate` — kernel

- **id/kind:** kernel, handler `development-freeze-integrated-candidate`
  (`src/process-modules/modules/development/development-process-module.ts:352-361`).
- **Roles:** none.
- **Input authority/cardinality:** all accepted implementation results (via the
  sealed cell products); expects exactly one git-integration effect receipt per
  accepted product (`receipts.length !== 1 → null →
  implementation-integration-not-merged`)
  (`src/modules/development/infrastructure/sqlite-development-settlement-state.ts:246-273`).
- **Tools/protocol:** read-only `GitPort` shell-out (rev-parse, merge-base
  ancestor check) — the module "speaks only read-only git queries"
  (`src/modules/development/domain/development-kernel-ports.ts:275-287`;
  use at `src/modules/development/infrastructure/sqlite-development-settlement-state.ts:281-290`).
- **Output authority/schema:** `integrated-source-candidate`
  (`INTEGRATED_SOURCE_CANDIDATE_SCHEMA`), authority `kernel`, content-addressed
  `sourceHash`, `frozen: true`, repositories sorted, build products
  `source-tree` refs, `integrationIntentRefs` from effect receipts
  (`src/modules/development/infrastructure/sqlite-development-settlement-state.ts:298-328`;
  artifact row `src/process-modules/modules/development/development-process-module.ts:531`).
- **Gates:** lineage validation only (integration branch contains
  `expectedBaseCommit`; failure → `candidate-freeze-lineage-invalid`)
  (`src/modules/development/infrastructure/sqlite-development-settlement-state.ts:274-286,338-340`).
- **Repair/retry:** idempotent product read on replay; corrupt stored hash →
  `frozen-candidate-corrupt` failed
  (`src/modules/development/infrastructure/sqlite-development-settlement-state.ts:223-236`).
- **State/effects:** no external effect; freeze = kernel seal ("Seals merged
  repository heads before verification", policy
  `development-candidate-freeze`,
  `src/process-modules/modules/development/development-process-module.ts:540`).
- **Forward consumers:** `certify-product-readiness` (input schema
  `INTEGRATED_SOURCE_CANDIDATE_SCHEMA`),
  `src/process-modules/modules/development/development-process-module.ts:367`.
- **Backward obligations:** complete implementation workset required
  (`implementation-products-incomplete` otherwise)
  (`src/modules/development/infrastructure/sqlite-development-settlement-state.ts:242-245`).
- **Scripted outside participant:** none.
- **Tests/CI:** covered via `tests/process-modules/development-read-switch.test.mjs`,
  `development-settlement-failed-evidence.test.mjs` and factory-contract
  suites (glob-hosted).
- **Uncovered:** no dedicated CI suite for concurrent freeze attempts from two
  hosts (single-host assumption; see CONVEYOR §22 caveat,
  `docs/architecture/CONVEYOR-MENTAL-MODEL.md:1054-1057`).

### 5. `certify-product-readiness` — production cell (singleton)

- **id/kind:** `development-readiness-certification`, singleton production
  cell (`src/process-modules/modules/development/development-process-module.ts:362-393`).
- **Roles:** author = readiness certifier (profile
  `development-readiness-certifier`, skill `saga-readiness-certifier`, mode
  `tracker_only`, `src/process-modules/modules/development/development-process-module.ts:617-636`).
- **Input authority/cardinality:** input schema
  `INTEGRATED_SOURCE_CANDIDATE_SCHEMA`; output
  `DEVELOPMENT_READINESS_MANIFEST_SCHEMA`, cardinality `'1'`, payload contract
  `development.readiness-manifest-payload` v1.1.0
  (`src/process-modules/modules/development/development-process-module.ts:367-377`;
  contract `src/modules/development/application/development-check-providers.ts:416-425`).
- **Tools/protocol:** `COMMON_WRITE_TOOLS`; readiness checklist resource
  (`src/process-modules/modules/development/development-process-module.ts:79-80,629-632`).
- **Output authority/schema:** `development-readiness-manifest`, authority
  `worker` — "Candidate-wide run contract checked against the exact source"
  (`src/process-modules/modules/development/development-process-module.ts:532`).
- **Gates:** plan `development.readiness-certification.final.v3` =
  readiness-monotonicity provider v1.0.0 (a narrowed/changed declaration on
  the same sourceCandidate is an ESCALATION: `indeterminateDisposition:
  'human-required'`) + local-runnability provider v1.14.0 (subject resolves to
  the FROZEN integrated candidate, not the verifier's own probe;
  `failureOwnership: 'upstream'` so a failed runnability check routes the
  defect to the producing workshop instead of repair-looping the certifier;
  indeterminate typed unknown `warrant-blocked-environment` → human-required
  complete-blocked, resumable)
  (`src/process-modules/modules/development/development-process-module.ts:158-225`;
  provider ids `src/modules/development/application/candidate-check-contracts.ts:21,92`).
- **Repair/retry:** `maxAttempts: 3`, `onExhausted: 'requeue'`
  (`src/process-modules/modules/development/development-process-module.ts:379-380`).
- **State/effects:** accepted → `bind-runnable-candidate`; human-required →
  `complete-blocked`; failed → `settle-development` (X3 seam: settlement
  reads the FAILED local-runnability receipt run-wide and settles
  `blocked/candidate-missing/local-readiness-failed` with decoded producer
  defect text — "the durable certificate the continuation reads to re-route
  the defect to the producing workshop")
  (`src/process-modules/modules/development/development-process-module.ts:381-391,493-500`).
- **Forward consumers:** bind kernel (manifest + receipt).
- **Backward obligations:** exact frozen candidate lineage.
- **Scripted outside participant:** the runnability provider executes real
  commands (npm/node/docker/compose) against a temp materialization
  (`src/infrastructure/verification/local-runnability-check-provider.ts:1-90`).
- **Tests/CI:** `tests/process-modules/development-readiness-profile-contract.test.mjs`,
  `readiness-profile-monotonicity.test.mjs`, `development-local-readiness-binding.test.mjs`
  (glob-hosted); substrate suites are exact-file hosted
  (`tools/run-acceptance-matrix.mjs:110-113`);
  `tests/modules/development/readiness-test-surface.test.mjs` is a FILED
  ORPHAN (no group hosts it); the real-process provider file
  `tests/infrastructure/local-runnability-check-provider.test.mjs` is
  quarantined FLAKY (`tools/run-acceptance-matrix.mjs:192-194`).
- **Uncovered:** readiness substrate timing on the real seam is the audit's
  #2 predicted next death (quarantined, see TEST COVERAGE).

### 6. `bind-runnable-candidate` — kernel

- **id/kind:** kernel, handler `development-bind-runnable-candidate`
  (`src/process-modules/modules/development/development-process-module.ts:394-402`).
- **Roles:** none.
- **Input authority/cardinality:** the exact accepted readiness manifest and
  its deterministic receipt ("Bind the exact accepted readiness manifest and
  deterministic receipt to the frozen source",
  `src/process-modules/modules/development/development-process-module.ts:397-398`).
- **Tools/protocol:** settlement-state port `bindRunnableCandidate` returning
  `bound | waiting | failed` with reason codes
  (`src/modules/development/domain/development-kernel-ports.ts:172-178`).
- **Output authority/schema:** `integrated-release-candidate`
  (`INTEGRATED_CANDIDATE_SCHEMA`), authority `kernel` — "Frozen integrated
  repository/build target"
  (`src/process-modules/modules/development/development-process-module.ts:530`;
  binding at `src/modules/development/infrastructure/sqlite-development-settlement-state.ts:343-345`:
  reads the exact readiness receipt; a missing receipt for this exact manifest
  is a producer verdict, not a bind).
- **Gates:** receipt binding validation (LR-06 durable store
  `factory_check_receipts`; the receipt is keyed by the verification author's
  accepted presentation, ref and digest,
  `src/modules/development/infrastructure/sqlite-development-settlement-state.ts:566-591`).
- **Repair/retry:** typed `waiting`/`failed` reason codes; no worker budget.
- **State/effects:** none external.
- **Forward consumers:** `verify-acceptance` input selector
  `bind-runnable-candidate.candidate`
  (`src/process-modules/modules/development/development-process-module.ts:411-414`).
- **Backward obligations:** `domain.bound`; failure → `settle-development`
  (`src/process-modules/modules/development/development-process-module.ts:501-502`).
- **Scripted outside participant:** none.
- **Tests/CI:** `development-local-readiness-binding.test.mjs` (LR-07),
  glob-hosted.
- **Uncovered:** none specific beyond the seam-wide gaps below.

### 7. `verify-acceptance` — production cell (fan-out)

- **id/kind:** `development-verification`, fan-out over
  `resolve-task-graph.verificationItems` + `bind-runnable-candidate.candidate`
  (`src/process-modules/modules/development/development-process-module.ts:403-423`).
- **Roles:** author = verification worker (profile
  `development-verification-worker`, skill `saga-worker`, mode
  `tracker_only`, task kind `verification.ac`,
  `src/process-modules/modules/development/development-process-module.ts:637-656`).
- **Input authority/cardinality:** exactly one criterion per item (policy
  enforces `acceptanceCriterionKeys.length === 1`,
  `src/modules/development/domain/development-settlement-policy.ts:420-428`);
  materialization carries `verificationTargetArtifactIdSelector` (planning
  provenance: one accepted `verification_target_artifact_id` per task —
  GUARDRAILS Sign 011's ownership-before-evidence rule, `GUARDRAILS.md:100-105`,
  `src/process-modules/modules/development/development-process-module.ts:418-423`).
- **Tools/protocol:** `COMMON_WRITE_TOOLS` (includes `verification_record`);
  output schema `DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA`
  (`src/process-modules/modules/development/development-process-module.ts:647-653`).
- **Output authority/schema:** one `verificationEvidence` product per item,
  cardinality `'1'`, payload contract `development.verification-evidence-payload`
  v2.0.0 (required: verificationItemKey, acceptanceCriterionKey,
  acceptedCriterionHash, candidateHash, four-valued outcome
  passed|failed|unknown|error, evidence summary/observations/limitations,
  lowercase-sha256 hashes)
  (`src/modules/development/application/development-check-providers.ts:576-596`).
- **Gates:** author/final plan `development.verification.final.v4` =
  verification provider v2.0.0 (`development.verification-product-contract.v2`);
  **the default provider returns `unknown` for LM-authored assessments by
  design** — an LM "passed" cannot become Factory acceptance without an
  independent candidate-check receipt (the registration file documents the
  test-only override hook,
  `src/modules/development/index.ts:72-84,157-165`;
  provider digest `src/modules/development/application/development-check-providers.ts:567-574`).
- **Repair/retry:** `recovery: { maxAttempts: 2, onExhausted: 'requeue' }`
  (`src/process-modules/modules/development/development-process-module.ts:444`).
- **State/effects:** accepted → `settle-development`; failed →
  `settle-development` (upstream-defect escalation: a failed verification
  verdict refuted the FROZEN candidate; settlement issues the explicit
  completion and a continuation-acceptable terminal outcome — blocked on
  missing verification evidence)
  (`src/process-modules/modules/development/development-process-module.ts:445-452,503-513`).
- **Forward consumers:** settlement builds the acceptance-verification
  workset from sealed CandidateSets (INNER data of the settlement input; "no
  epic-wide 'latest' lookup is allowed",
  `src/modules/development/domain/development-kernel-ports.ts:180-192`).
- **Backward obligations:** evidence must pin `acceptedCriterionHash` (the AC
  hash) and the frozen `candidateHash`; settlement re-verifies lineage
  (`src/modules/development/domain/development-settlement-policy.ts:1212-1231`).
- **Scripted outside participant:** trusted-receipt reader admits only exact
  trusted receipts; provider trust rows are fail-closed against digest drift
  at registration (`DEVELOPMENT_VERIFICATION_PROVIDER_TRUST_DRIFT`,
  `src/modules/development/index.ts:166-191`).
- **Tests/CI:** `tests/modules/development/development-verification-check-provider.test.mjs`
  is a FILED ORPHAN (no group hosts it); `verification-ledger.test.mjs` is
  exact-file hosted (`tools/run-acceptance-matrix.mjs:86-89`);
  `tests/process-modules/development-review-jurisdiction.test.mjs` and
  `development-coherent-coverage.test.mjs` are glob-hosted.
- **Uncovered:** "AC coverage ≠ AC satisfaction" remains a documented risk
  class (GUARDRAILS Signs 006/008, `GUARDRAILS.md:65-71,79-84`); the
  substantive AC-vs-assertion check is carried by the independent receipt
  requirement, not by a semantic comparator.

### 8. `settle-development` — kernel (Settlement)

- **id/kind:** kernel, handler `development-settlement-policy`
  (`src/process-modules/modules/development/development-process-module.ts:455-464`).
- **Roles:** none; `ReferenceDevelopmentSettlementPolicy` is pure — "no I/O
  and no LM decisions"
  (`src/modules/development/domain/development-settlement-policy.ts:1-7`).
- **Input authority/cardinality:** `buildSettlementInput` re-reads the
  validated task graph and accepted cell products by exact refs/hashes and
  observes the candidate again — the ONLY input to settlement
  (`src/modules/development/domain/development-kernel-ports.ts:180-192`).
- **Output authority/schema:** `development-certificate`
  (`DEVELOPMENT_CERTIFICATE_SCHEMA`), authority `kernel`, "Immutable
  Development settlement decision"
  (`src/process-modules/modules/development/development-process-module.ts:535,539`).
  On `verified` it also persists the `verified-integration-bundle`
  (`VERIFIED_INTEGRATION_BUNDLE_SCHEMA`) through the write-once output
  repository (`src/modules/development/domain/development-kernel-ports.ts:213-238`;
  bundle construction `src/modules/development/domain/development-settlement-policy.ts:1356-1381`).
- **Gates (decision table, all typed with reason codes):** invalid
  input/graph → `failed`; missing/incomplete implementation → `blocked`
  (implementation-incomplete / implementation-blocked); integrity violations →
  `failed` (hash/lineage mismatch classes); candidate not frozen / drifted /
  missing → `blocked`; verification workset missing / incomplete / untrusted /
  inconclusive / failed-AC → `blocked` (failed AC names WHICH AC failed with
  WHICH evidence ref); open human gates → `blocked`; local-readiness receipt
  must be present, passed, and bound to the exact frozen candidate (LR-07:
  missing → `blocked/local-readiness-missing`, failed →
  `blocked/local-readiness-failed` with decoded failure text)
  (`src/modules/development/domain/development-settlement-policy.ts:843-1336`).
- **Terminal accounting (CC-GAP-8):** when the module completion is terminal
  with unexecuted criterion obligations, settlement appends terminal-route
  facts (`terminal-unknown` / `terminal-blocked` / `terminal-human-required`)
  with certificate provenance — "never a discharge; never poisons a later
  executed/waived append"
  (`src/modules/development/domain/development-kernel-ports.ts:194-209`;
  ledger semantics
  `src/modules/development/infrastructure/development-verification-ledger.ts:19-25`).
- **State/effects:** none external; certificate issuance through
  `certificateRepository` (the kernel authors its own certificate and emits an
  explicit ModuleCompletion,
  `src/modules/development/domain/development-kernel-ports.ts:312-323`).
- **Forward consumers:** lifecycle `outputMapping` (decision, certificate,
  verifiedBundle) and the Delivery stage input mapping.
- **Scripted outside participant:** none.
- **Tests/CI:** `tests/modules/development/development-terminal-exit-accounting.test.mjs`
  (exact-file hosted, `tools/run-acceptance-matrix.mjs:90-97`);
  `tests/process-modules/development-settlement-failed-evidence.test.mjs`
  (glob-hosted); `tests/modules/development/settlement-placeholder-verdict.test.mjs`
  is a FILED ORPHAN (no group hosts it).
- **Uncovered:** see UNCOVERED CONDITIONS.

### 9. `complete-verified` / `complete-blocked` / `complete-failed` — kernel emitters

- Generated outcome emitters, handler `process-outcome-emitter`, one per
  outcome (`src/process-modules/modules/development/development-process-module.ts:465-473,514-519`).
  They emit the LOCAL outcome; lifecycle routing is external (invariant
  `development.module-does-not-route`, enforcement `static`,
  `src/process-modules/modules/development/development-process-module.ts:550`).

### The confirmed task-shadow binding seam (P0, cross-cutting)

The crash-attempt accounting port `readTaskForWorkplace` is implemented as
`SELECT id AS taskId FROM tasks WHERE workplace_ref=? ORDER BY id DESC LIMIT 1`
(`src/app/product-lifecycle-runtime.ts:585-593`). In a singleton workplace
holding multiple task rows (author + reviewer projections), the NEWEST row —
the reviewer's — shadows the author's. Consumers:

1. `rawAttemptCounters` — the recovery-budget terminal-execution counter reads
   only that one task's executions
   (`src/process-modules/application/node-executors/production-cell-node-executor.ts:2317-2337`);
2. `resolveScopeWidening` — scope-widening requests bind to that task id
   (`src/process-modules/application/node-executors/production-cell-node-executor.ts:2424-2463`).

Confirmed P0 diagnosis (stage-21 Elite-7 red team): "the newest (reviewer)
task shadows the author task in the same singleton-workplace; the epoch counter
read the CLEAN executions of task 9 and never saw the 15 deaths → the budget
never engaged ONCE (rollover table empty). Every unit test stubs this port;
integration coverage of a real multi-task singleton-Workplace is absent (R3)."
(`docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md:80-86`, remedy R3 at
`:139-140`). This is a live seam, not a fixed one — the map records it as a
confirmed defect class with no CI counterexample.

---

## WORKSHOP EXIT CONTRACT

- Terminal outcomes (all terminal): `verified` (all required implementation
  and acceptance evidence binds to the unchanged frozen candidate), `blocked`
  (required work, trusted evidence, integration state or a human decision is
  unavailable), `failed` (infrastructure or immutable lineage validation
  failed) (`src/process-modules/modules/development/development-process-module.ts:237-241`).
- Output contract: `VERIFIED_INTEGRATION_BUNDLE_SCHEMA`
  (`src/process-modules/modules/development/development-process-module.ts:236`);
  persisted only on `verified` through the write-once repository with
  re-checked content hash
  (`src/modules/development/domain/development-kernel-ports.ts:222-238`).
- Certificate payload hashes every lineage coordinate (formalization
  certificate, solution contract, baseline, task graph, workset, candidate,
  verification, bundle) —
  `src/modules/development/domain/development-settlement-policy.ts:1429-1451`.
- Declared invariants (module list): planner-cell gates graph semantics;
  review-before-integration; integrate-before-verification;
  evidence-pins-candidate; no-post-verification-mutation; unknown-denies;
  exact-lineage; module-does-not-route
  (`src/process-modules/modules/development/development-process-module.ts:542-551`).

---

## DOWNSTREAM CONTRACT (producer → bridge → consumer)

- Producer: Development settlement emits outcome + certificate + verified
  bundle (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:417-427`).
- Bridge: lifecycle stage `solution-development` `outputMapping` copies the
  process outcome's decision/authority/certificate and the
  `verifiedBundle.schema/ref/hash/payload` into the order state
  (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:417-427`);
  outcome routes: `verified` → stage `delivery-release`; `blocked` → terminal
  `development-blocked`; `failed` → terminal `failed`
  (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:428-432`).
- Consumer: Delivery's input mapping binds the Development certificate
  (decision `verified`), the verified bundle refs, and the
  `integratedCandidate` from the bundle payload
  (`src/process-modules/lifecycles/product-delivery-lifecycle.ts:443-461`;
  full card in `04_DELIVERY.md`).
- Alternative consumer (product-build lifecycle): in `product-build`, the
  `delivery-release` stage is filtered out and `verified` terminates as
  `runnable-local`; exit conditions add the loopback start probe
  (`src/process-modules/lifecycles/product-build-lifecycle.ts:30-44`). The
  `runnable-local` classification owns the digest-pinned obligation injection
  table whose `synthesis` and `ordered-smoke` entries gate Development
  planning through the constraint register
  (`src/process-modules/lifecycles/product-build-lifecycle.ts:47-83`).
- No-hiding rule: ordinary product construction "creates no Delivery
  StageRun, approval request, ReleaseRecord, or deployment effect"
  (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1535-1562`).

---

## SIDE-CAR / CONTINUATION FLOWS

1. **Managed continuation** (`solution-development-managed` v1.1.0): recovery
   package that removes `plan-task-graph`, resolves ONE deterministic
   continuation work item from the exact continuation/adoption receipts
   (`development-resolve-continuation-task-graph`), swaps implementation
   workers to managed-text authors/reviewers (no Bash/Git mutation; textual
   `SourceChangeCandidate` materialized into a private commit by the Factory),
   and keeps Factory-owned Git effects
   (`src/process-modules/modules/development/development-continuation-process-module.ts:19-22,64-196`;
   skill resources under
   `src/process-modules/modules/development/package/resources/managed-source/`).
   Continuation handler fail-closed codes: exactly one adoption required,
   adoption drift, baseline head mismatch, change scopes required
   (`src/modules/development/infrastructure/development-continuation-installation.ts:20-65`).
2. **Re-plan continuation** (`solution-development-managed` v1.2.0): cycle-2
   variant entering through a `replan-task-graph` planner cell (standard
   task-graph provider + replan-graph provider: parallelism anti-pattern +
   shared-surface extraction); the resolver supersede-wraps the standard
   handler — remaining cycle-1 tasks are superseded
   (`metadata.$.superseded_by`, cancelled cards, drained projections) in the
   SAME kernel step that materializes the cycle-2 graph, so zero cycle-1
   workers wake beside cycle 2
   (`src/process-modules/modules/development/development-continuation-process-module.ts:25-38,198-291`;
   registration `src/modules/development/index.ts:348-401`;
   `supersedeRemainingCycleTasks` at
   `src/modules/development/application/replan-supersede.ts:38`).
3. **Verification continuation**
   (`solution-development-verification-continuation` v1.0.0): incident-
   independent suffix that adopts an exactly authorized task graph/workset/
   candidate as the immutable verification subject (`adopt-verification-baseline`
   kernel), re-runs the INHERITED verification gate plan (deliberately: the
   hand-rebuilt plan that dropped local-runnability blocked settlement
   forever on `local-readiness-missing`), and settles through the
   continuation settlement handler. "The suffix may observe an adopted
   candidate but cannot plan, author, review, freeze or integrate source
   production" (`src/process-modules/modules/development/development-verification-continuation-process-module.ts:9-12,20-113`).
4. **Verification ledger as side-car accounting:** append-only criterion-key
   ledger opened at graph materialization; execution facts append from the
   settlement-state seam; terminal-route facts append at settlement; never a
   discharge (`src/modules/development/infrastructure/development-verification-ledger.ts:1-29`).

---

## DEAD / DECLARATIVE-ONLY STRATA

- The module descriptor's `flow.recovery` policies are filtered/rebuilt by the
  continuation variants and dropped entirely in the verification continuation
  (`src/process-modules/modules/development/development-verification-continuation-process-module.ts:95-98`);
  recovery semantics that actually run are the cell-level
  `recovery.maxAttempts/onExhausted` and the executor's epoch/budget machine,
  not a flow-level policy table.
- `conflict_check` remains in the planner's allowed tools
  (`src/process-modules/modules/development/development-process-module.ts:566`)
  as a legacy surface; nothing in the gate chain consumes its output (the
  overlap rule is enforced by the policy,
  `src/modules/development/domain/development-settlement-policy.ts:398-419`).
- The versioned (ADR-073-era) kernel handler installation
  (`createVersionedDevelopmentKernelHandlers` in
  `src/modules/development/application/development-installation.ts`) exists
  alongside the primary installation; both are wired in
  `src/modules/development/index.ts:242-285` — a strangleler pattern with both
  paths alive (compare ADR-053's diagnosis of exactly this migration shape,
  `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md:195-209`).
- `'clarification-required'` settlement edges were deleted; the branches now
  return `failed` with comments marking them unreachable-through-production
  (`src/modules/development/domain/development-settlement-policy.ts:858-883`).
- The declared invariants with `enforcement: 'policy'`/`'test'` (e.g.
  `development.evidence-pins-candidate`, `development.no-post-verification-mutation`)
  are enforced at settlement re-validation and by suites, not by a dedicated
  runtime guard at the product boundary
  (`src/process-modules/modules/development/development-process-module.ts:542-551`).

---

## TEST COVERAGE

Blocking CI (acceptance matrix; each group an isolated `node --test` step in
`.github/workflows/ci.yml:65-120`, groups defined in
`tools/run-acceptance-matrix.mjs:64-163`):

- `process-modules` group (glob `tests/process-modules/*.test.mjs`, plus
  exact files): includes `development-implementation-scope-check`,
  `development-task-graph-authorization`, `development-managed-continuation`,
  `development-constraint-relay`, `development-review-jurisdiction`,
  `development-coherent-coverage`, `development-readiness-profile-contract`,
  `development-local-readiness-binding`, `replan-supersede`,
  `replan-case-builder`, `replan-graph-checks`, `replan-cap-ratchet`,
  `deferred-delivery`, `delivery-approval-inbox`, `delivery-package-*`,
  `product-delivery-lifecycle-e2e`, cell/gate/finality/authority suites
  (`tools/run-acceptance-matrix.mjs:83-116`).
- Exact-file hosted module proofs: `verification-ledger.test.mjs` (CC-GAP-8),
  `development-terminal-exit-accounting.test.mjs` (structural oracle),
  `task-graph-register-conditional-coverage.test.mjs`,
  `task-graph-gate-srs-manifest.test.mjs`, plus the readiness substrate exact
  files (`tools/run-acceptance-matrix.mjs:86-113`). NOTE: the
  `tests/modules/development/` directory (14 files) is NOT glob-hosted — the
  ten files not named above (including `development-verification-check-provider`,
  `readiness-test-surface`, `implementation-scope-ancestry/workitemkey`,
  `implementation-workset-item-key`, `settlement-placeholder-verdict`,
  `srs-module-manifest`, `text-set-manifest`, `srs-derived-change-scopes`,
  `factory-managed-repository-paths`) are filed orphans outside CI.
- `factory-proof` group hosts `development-scenario-pack.test.mjs` and
  `delivery-kernel-unification.test.mjs` as blocking scenario proofs
  (`tools/run-acceptance-matrix.mjs:131-161`).
- Quarantined (excluded from blocking CI, documented):
  `development-task-graph-diagnostics.test.mjs` PRE-EXISTING-RED (stale
  producerExecutionRef mock); `local-runnability-check-provider.test.mjs`
  FLAKY (real-process timing); `golden-path`, `parallel-git-desk`,
  `factory-temporal/*` FLAKY (orchestrate-cli/replay driven)
  (`tools/run-acceptance-matrix.mjs:176-195`).
- Known matrix gap (declared by audit, not by the runner): 234/503 test files
  (47%) are outside CI — 219 unmanaged orphans + 15 quarantined; hosting is
  file-by-file with no omnibus every-file-[run|quarantine] invariant
  (`docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md:95-115`, remedy R1).

---

## UNCOVERED CONDITIONS

- **Task-shadow binding (confirmed P0):** no integration test drives
  `readTaskForWorkplace` on a REAL multi-task singleton workplace; every unit
  stubs the port (R3 open,
  `docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md:80-86,139-140`;
  implementation `src/app/product-lifecycle-runtime.ts:587-593`).
- **Per-file removal guards:** six exact-file hosted entries (incl. both
  task-graph planner-desk suites and the four readiness substrate suites)
  have NO per-file removal pin; only `terminal-exit-accounting` is pinned
  (G2g) — deleting any of the six does not redden the matrix
  (`docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md:106-115`).
- **Win32-invisible CI:** CI is ubuntu-only; windows-only runner arms
  (taskkill fallback, 5s exit-without-close) have no direct coverage; a win32
  daemon makes every readiness check UNKNOWN (`docker-requires-linux`)
  (`docs/factory-run/stage21-elite7/RED-TEAM-AUDIT.md:70-76` and team-7/9
  sections `:78-123`).
- **Real-model E2E:** scripted suites replace model cognition through the
  spawn seam; a clean real-model canary over the full Development flow is not
  a blocking CI fact (ADR-053 criteria 10 remain the governing ask,
  `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md:962-981`).
- **ADR-053 residuals:** epic-scoped material accumulation (not
  lifecycle-scoped), newest-wins capsule binder, resume compatibility without
  implementation digests — all declared divergent as of 2026-08-16
  (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:1599-1620`).

---

## CONTRADICTIONS

1. **Descriptor vs executor on review budget semantics:** the flow comment
   says review budget counts rounds reason-blind
   (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:635-657`), while the executor
   implements the finding-trajectory waiver/charge split
   (`src/process-modules/application/node-executors/production-cell-node-executor.ts:2339-2389`).
   The mental model's own conformance section still lists the budget as
   reason-blind in places — the code is ahead of the doc; treat §15's
   separation mechanism as PARTIALLY landed, not normative-complete.
2. **`tracker_only` planner with `Write/Edit/Bash` tools:** the planner
   profile declares execution mode `tracker_only` yet carries mutable host
   tools (`src/process-modules/modules/development/development-process-module.ts:564-568`).
   CONVEYOR §18 requires the runner to auto-allow exactly declared tools and
   deny the rest (`docs/architecture/CONVEYOR-MENTAL-MODEL.md:905-911`); the
   map records the coexistence without a cited enforcement test for the
   planner profile specifically.
3. **Docs-as-hypothesis vs gates-as-fact:** module `invariants` entries carry
   enforcement kinds `runtime/policy/static/test`
   (`src/process-modules/modules/development/development-process-module.ts:542-551`);
   several (`policy`) have no mechanical CI oracle distinct from settlement
   re-validation, so their "enforcement" is the settlement code path plus
   review, not an independent gate.
4. **Continuation module versioning:** plain continuation and re-plan
   continuation share the module NAME `solution-development-managed` with
   versions 1.1.0 / 1.2.0
   (`src/process-modules/modules/development/development-continuation-process-module.ts:19-38`)
   — workplace identity keys on moduleRef, so the map treats them as distinct
   installations; any doc that names "the managed continuation" without a
   version is ambiguous by construction.
