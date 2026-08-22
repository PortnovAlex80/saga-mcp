# Conformance Closure Execution Plan

- Status: Ready for autonomous execution in isolated worktrees
- Date: 2026-08-22
- Historical draft base: `saga4@53cf7c81`
- Runtime base: capture the current `origin/saga4` SHA when CC-00 starts
- Scope end: full Saga Kernel Conformance Engine closure and an explicit,
  evidence-backed handoff to the structural plans

This plan is subordinate to
`docs/plans/SAGA-KERNEL-CONFORMANCE-ENGINE-PLAN.md`. ADR-084 is Accepted and is
the governing conformance decision. ADR-053 is a Proposed architectural
diagnosis. ADR-085 and ADR-086 are Proposed and remain blocked by the
Structural Refactor Qualification Gate. A green gate makes their implementation
eligible; it does not adopt or authorize either proposal by itself.

The structural cutover is not implemented by this plan. It remains owned by:

- `docs/plans/WORKSHOP-MODULARIZATION-REFACTORING-PLAN.md`;
- `docs/plans/PROJECT-STRUCTURAL-CLEANUP-PLAN.md`; and
- `docs/architecture/PROCESS-MODULE-ARCHITECTURAL-REFACTORING-GUIDE.md`.

All plans, task packets, evidence, trackers, and commits produced by this work
must be in English.

---

## 1. Outcome and milestone bridge

Milestone A proves K0 through K5 and every Structural Refactor Qualification
Gate item. It emits `QUALIFICATION_GREEN` only after clean-checkout
reproduction. That state is evidence, not permission to edit structural
runtime or workshop paths.

Milestone B completes the remaining workshop corpus, K6, K7, S, and all work
that can finish before the ADR-085 catalog exists. K8 final qualification has
an intentional bridge dependency: its synthetic-workshop proof runs against
the canonical closed catalog created by the separately authorized ADR-085
cutover.

```text
K0-K5 qualification packages
  -> QUALIFICATION_GREEN
  -> finish pre-cutover K6/K7/S/workshop proof packages
  -> record STRUCTURAL_IMPLEMENTATION_AUTHORIZED
  -> pause every conformance package that edits shared surfaces
  -> run the ADR-085/086 atomic structural train in isolation
  -> run K8 against the new closed catalog
  -> finish ADR-085 P4/P5 closure
```

The integration owner may record `STRUCTURAL_IMPLEMENTATION_AUTHORIZED` only
when all pre-cutover packages are complete, both Proposed ADRs have the
required adoption/authorization, and no proof package is still writing shared
surfaces. This prevents the proof kernel and structural refactor from becoming
parallel implementation tracks.

---

## 2. Verified starting facts

These facts are anchored to the historical draft base. CC-00 must refresh them
against its recorded runtime base.

- [x] `captureGitRecipe` cell identity was fixed by `1a6fc2a5`: accepted
  same-task predecessor material is not foreign merely because it came from a
  different WorkerExecution.
- [x] The committed note at
  `tests/factory-evidence/harvest-manifest.json:548` still describes the old
  race diagnosis and is stale.
- [x] `tools/run-acceptance-matrix.mjs` lists 11 blocking `factory-proof`
  files. CI invokes that explicit group and not blanket `npm test`.
- [x] Twelve additional `tests/factory-proof/*.test.mjs` files exist outside
  the blocking group and outside `PROOF_CLAIMS`.
- [x] `validateProofClaims()` checks group-to-registry completeness only. It
  does not reject a claimed file absent from the group, so it is not a
  one-to-one ratchet.
- [x] Nine restart/retry-exhaustion proofs use `specialDrive` instead of the
  unified `runScenario` execution path.
- [x] `delivery-restart-proof.mjs` is committed but not wired into a drive. It
  is a WIP seed for `restart:delivery:idempotent-settlement`, not proof that the
  token is complete and not a substitute for the upstream Development proof.
- [x] `scenario-runner.mjs` refuses `FaultSchedule` with
  `SCENARIO_RUNNER_FAULT_SCHEDULER_NOT_LANDED`.
- [x] The committed v1 report contains 68 PASS bundles, 176 declared tokens,
  19 pending tokens, and 8 current platform fault-edge tokens.
- [x] Discovery is 47/47 and Formalization is 70/70 demonstrated relative to
  their declared workshop universes.
- [x] Development is 18/35 and Delivery is 17/19 demonstrated.
- [x] The three uncovered recovery-dimension tokens are
  `restart:development:git-change-desk-replay`,
  `restart:development:idempotent-redrive`, and
  `restart:delivery:idempotent-settlement`.
- [x] `feedback:development:exact-repairs-and-absent-does-not` is required for
  Development closure but is not one of those recovery-dimension tokens.
- [x] Mutation data has a dedicated `mutationCoverage` evidence field. The
  report does not measure or aggregate it yet.
- [x] The report incorrectly describes mutation kills as K4-owned. Mutation
  identity and kill closure are K3 responsibilities; K4 owns fault schedules.
- [x] ADR-085 records at least 32 files importing across the two workshop
  trees. A current inventory may differ because it can count direct importers,
  edges, or a changed file population. Metrics must be named and reproduced;
  neither number silently replaces the other.
- [x] The main checkout contains unrelated and active user-owned changes,
  including temporal-test work. This plan owns none of them.

### Honest stage status

| Stage | Current status | Required correction |
|---|---|---|
| K0 | Partial evidence | Re-audit every exit item, clean-checkout reproduction, live trace baseline, and legacy-to-obligation mapping |
| K1 | Partial evidence | Remove special-drive bypasses and prove the truthful canonical entrypoint claim |
| K2 | Strict Formalization evidence exists | Add the gate-required strict full-lifecycle happy proof and re-audit strict repair evidence |
| K3 | Compiler and mutation algebra exist | Add required-mutant closure, harvest aggregation, reporting, and blocking floors |
| K4 | DSL, observer, runner, progress, and bundles exist | Add named fault scheduling, fault receipts, and deterministic minimization |
| K5 | Provisional blocking group exists | Add 12 files, exact bidirectional claim closure, K3/K4 ratchets, budgets, and non-vacuity |
| K6 | W1-1 and W1-4 are CanonicalFast only | Requalify W1-1/W1-4 through canonical spawn and add W1-2/W1-3 |
| K7 | Not implemented | Add bounded explorer and deterministic promoted replay |
| K8 | Four workshop packs use one kernel | Add post-catalog synthetic workshop, binding parity, L5 proofs, budgets, and canaries |
| S | Not implemented | Add finite satisfiability before claiming full master-plan closure |

No `[x]` above is an exit gate. It records observed evidence only.

---

## 3. Non-negotiable guardrails

- [ ] Read `AGENTS.md`, the four required Conveyor documents, applicable ADRs,
  and the current live-run tracker before each writable package.
- [ ] Never build in a checkout used by a live Factory engine; the engine lazily
  imports `dist/`.
- [ ] Use one isolated worktree per writable package. Never implement Closure
  work in the dirty main checkout.
- [ ] Preserve all pre-existing modified and untracked files. Do not delete
  `.tmp-*`, evidence, pitch-deck, temporal-test, or operator files.
- [ ] Add files by explicit path only. Never use `git add -A`.
- [ ] Use the opencode shim for every Factory worker or canary. Direct Claude
  CLI execution is forbidden.
- [ ] Set
  `SAGA_REAL_CLAUDE_PATH="node D:/Development/saga-mcp/tools/agent-proxy/claude-shim.mjs"`
  and keep `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1` for every Factory run.
- [ ] Never modify `~/.claude/settings.json`; hash drift is an abort-and-
  investigate condition.
- [ ] The scenario engine, observer, explorer, and minimizer perform no
  authoritative production writes.
- [ ] Scripted actors replace cognition only and receive production-visible
  inputs only.
- [ ] No universal engine branch may depend on workshop name, `moduleRef`, or
  role profession.
- [ ] Proof-mode claims match the exercised seam. Dependency-stub tests start
  as `Contract` unless stronger evidence is demonstrated.
- [ ] Coverage universes, required-mutant sets, scenario floors, and edge floors
  are monotonic. Tokens are never removed, renamed, or demoted for closure.
- [ ] Generated evidence changes through its generator and regeneration
  command. Do not hand-edit generated JSON.
- [ ] One package produces one atomic commit. A red merge or gate stops the
  wave; it is not repaired forward inside an unrelated package.
- [ ] Record exact commands, exit codes, test counts, wall time, candidate SHA,
  and evidence digests for every package.

---

## 4. Agent and worktree contract

### 4.1 Worktree naming

```text
branch:   cc/<package-id>-<slug>
worktree: D:/Development/saga-mcp-<package-id>
```

- [ ] Create each worktree from the integration owner's recorded base SHA.
- [ ] Record `git status --short`, base SHA, and branch before editing.
- [ ] Rebase or reconcile only after the package gate is green.
- [ ] The integration owner resolves shared-file conflicts and runs merged gates.

### 4.2 Required delegated task packet

```markdown
### <package-id> - <name>

- Owner role:
- Branch/worktree:
- Depends on:
- Editable files:
- Read-only files:
- Required source documents:
- Inputs:
- Deliverables:
- Explicit non-goals:
- Verification commands:
- Evidence artifacts:
- Merge order:

Checklist:

- [ ] ...

Exit checklist:

- [ ] Package-specific exit criteria pass.
- [ ] Exact commands, exit codes, counts, and wall time are recorded.
- [ ] No authority write, workshop-name branch, or proof inflation was added.
- [ ] One atomic commit was produced with explicit-path staging.

Return:

1. Result summary.
2. Files changed.
3. Tests and exact outcomes.
4. Evidence artifacts and digests.
5. Assumptions and unresolved risks.
6. Out-of-scope follow-up work.
```

### 4.3 Shared-file ownership

Only one integration owner at a time may edit a row in this table.

| Surface | Single-writer files |
|---|---|
| CI and claims | `tools/run-acceptance-matrix.mjs`, `proof-claims.mjs`, `proof-claims.test.mjs`, acceptance-matrix coverage tests |
| Execution kernel | `scenario-runner.mjs`, `scenario-evidence.mjs`, scenario DSL and observer contracts |
| Coverage and report | `coverage-kernel.mjs`, `factory-coverage-universe.mjs`, `conformance-engine.mjs`, report generators |
| Development pack | `development-scenario-pack.mjs`, its runtime-case switch, Development drive and inventory |
| Delivery pack | `delivery-scenario-pack.mjs`, Delivery drive, Delivery restart wiring |
| Structural comparator | normalized trace schema, differential command, semantic ignore list |

- [ ] Parallelize read-only audits, fixtures, actor programs, external-world
  journals, and independent mutant-family specifications.
- [ ] Serialize edits to the execution kernel, report schema, acceptance
  matrix, trace vocabulary, and monolithic workshop packs.
- [ ] Never merge competing versions of a shared contract.

---

## 5. Critical path

```text
CC-00 -> CC-10A

CC-10A -> CC-20 -> CC-21
CC-10A -> CC-30 -> CC-31 -> CC-32
CC-21 + CC-32 -> CC-22 -> CC-23
CC-22 -> CC-24
CC-22 + CC-24 + CC-32 -> CC-40 -> CC-41 -> CC-42 -> CC-43 -> CC-44
CC-32 + CC-44 -> CC-10B

CC-22 -> CC-50 -> CC-51
CC-22 -> CC-52A/B/C/D -> CC-53 -> CC-54
CC-43 -> CC-51 and Delivery 19/19

CC-10B + CC-22 + CC-24 + CC-32 + CC-44 -> CC-60 -> CC-61/CC-62/CC-63
CC-32 + CC-42 -> CC-70
CC-32 + CC-44 -> CC-72

CC-00 + CC-10B + CC-23 + CC-32 + CC-44 + CC-60 -> CC-80 -> CC-81 -> CC-82

CC-50..54 + CC-61..63 + CC-70 + CC-72 + CC-82
  -> STRUCTURAL_IMPLEMENTATION_AUTHORIZED
  -> isolated ADR-085/086 train
  -> CC-71 K8 final qualification
```

K3 and K4 do not land as parallel merge waves because they share report,
evidence, and runner surfaces. Read-only K4 design may begin earlier; K4
implementation consumes frozen K3 identities from CC-32.

---

## 6. Milestone A packages - K0 through K5

### CC-00 - Immutable baseline and gate ledger

- Owner role: integration owner
- Depends on: none
- Non-goals: production fixes, evidence cleanup, structural edits

Checklist:

- [ ] Read live trackers and identify every checkout attached to a live engine.
- [ ] Fetch `origin/saga4`, select the actual base SHA, and create an isolated
  baseline worktree.
- [ ] Record every worktree and preserve every unrelated dirty file.
- [ ] Run `npm test` on the isolated base and record pass/fail/skip counts.
- [ ] Run the `factory-proof` and `matrix-coverage` acceptance groups.
- [ ] Run `npm run conformance:v1` and `npm run coverage:factory`; record report
  digest and semantic diff from the committed snapshot.
- [ ] Create a machine-readable K0-K5 ledger containing criterion ID, status,
  blocker, proof mode, evidence path, command, and digest.
- [ ] Map every existing proof claim to an owner and replacement destination.
- [ ] Verify the semantic ignore list contains only generated IDs, timestamps,
  absolute paths, and database row IDs.
- [ ] Record direct importer-file count and directed import-edge count with a
  reproducible command for each.
- [ ] Move the stale harvest diagnosis to its generator/source metadata and
  regenerate evidence; do not hand-edit JSON.

Exit checklist:

- [ ] Exact base SHA and baseline counts reproduce from an isolated worktree.
- [ ] Every K0-K5 criterion has a ledger row and evidence owner.
- [ ] Any red baseline is classified and reproduced before implementation; no
  package hides it.

### CC-10A - Provisional v1 CI ratchet

- Owner role: CI and claims owner
- Depends on: CC-00
- Non-goals: claiming K5 complete, FaultSchedule claims, runtime changes

Checklist:

- [ ] Add the current 12 non-blocking v1 files to the explicit group, producing
  the current 23-file floor.
- [ ] Add an honest claim for each. Start dependency-stub, pack-shape,
  inventory, coverage, and report tests as `Contract`.
- [ ] Make group-file and claim-file sorted sets exactly equal both ways.
- [ ] Prove an extra registry entry absent from the group fails.
- [ ] Prove a group file without a claim fails.
- [ ] Run the complete group, not selected files, in three fresh environments
  using the exact CI command.
- [ ] If shared SQLite/process behavior is nondeterministic, set group
  concurrency to one and rerun. Do not weaken timeouts or remove tests.
- [ ] Record wall time and establish a provisional runtime budget.

Exit checklist:

- [ ] The current 23-file floor is blocking and non-empty.
- [ ] Claim/group closure is bidirectional and exact.
- [ ] Three complete runs pass with identical semantic results.
- [ ] Integration-branch CI is green.
- [ ] Final K5 remains explicitly open until CC-10B.

### CC-20 - Multi-phase execution contract

- Owner role: execution-kernel owner
- Depends on: CC-10A
- Non-goals: fault injection, production transitions, workshop branches

Checklist:

- [ ] Define one descriptive contract for restart, abandon, retry exhaustion,
  redrive, and fair drain.
- [ ] Limit phase commands to production/test host ports.
- [ ] Define stable driver identity and phase receipts in the evidence bundle.
- [ ] Reject GateDecision, repair-owner, reducer-event, and authority-write
  instructions.
- [ ] Freeze the schema with negative tests before migrating proofs.

Exit checklist:

- [ ] The contract describes all nine special proofs without workshop branches.
- [ ] It describes the Delivery WIP without claiming it passes.
- [ ] It introduces no second runtime or authority writer.

### CC-21 - Base trace characterization

- Owner role: trace/evidence owner
- Depends on: CC-20

Checklist:

- [ ] Capture normalized traces and evidence digests for all nine passing
  special proofs on the base SHA.
- [ ] Capture the Delivery WIP's typed failure separately.
- [ ] Freeze approved semantic-ignore fields.
- [ ] Add non-vacuity mutations for each normalized evidence class.

Exit checklist:

- [ ] Nine immutable trace fixtures replay deterministically.
- [ ] Delivery WIP remains non-pass and contributes no coverage.
- [ ] A changed semantic landmark changes the digest.

### CC-30 - Required mutant taxonomy and stable IDs

- Owner role: obligation/mutation owner
- Depends on: CC-10A
- Non-goals: scenario tokens as mutation accounting

Checklist:

- [ ] Define required P0 mutant ledger independently of scenario coverage.
- [ ] Give every mutant stable ID, obligation, operator, installed protection,
  detector, and causal representative class.
- [ ] Include required authority, representation, cardinality, temporal,
  feedback, tool, hook, and S families.
- [ ] Reject missing obligation, operator, protection, or representative.
- [ ] Keep `mutationCoverage` dedicated; do not add `mutation:*` tokens merely
  to inflate the workshop universe.

Exit checklist:

- [ ] Every P0 obligation has a required mutant family.
- [ ] Compiler output and IDs are deterministic.
- [ ] Registry self-mutations make closure red.

### CC-31 - Kill-matrix harvest and report integration

- Owner role: coverage/report owner
- Depends on: CC-30
- Non-goals: fault scheduling

Checklist:

- [ ] Wire `compileObligationMutants` and `runKillMatrix` into harvest.
- [ ] Store killed, survived, excluded, and not-run IDs with reasons.
- [ ] Aggregate numerator, denominator, required-P0 closure, and global rate.
- [ ] Correct report text: mutation closure is K3-owned, not K4-owned.
- [ ] Prove failed/non-pass bundles contribute no mutation coverage.

Exit checklist:

- [ ] `mutationKillRate.measured` is true only for a non-empty executed set.
- [ ] Report exposes exact IDs and exclusions, not only a percentage.
- [ ] Fixed registry reruns produce identical mutation semantics.

### CC-32 - Blocking mutation closure and floors

- Owner role: mutation owner plus CI owner
- Depends on: CC-31

Checklist:

- [ ] Require zero surviving required P0 mutants and 100 percent P0 kill rate.
- [ ] Freeze first passing required-ID set, killed-ID set, and global rate as
  non-decreasing floors.
- [ ] Make removal of obligation, operator, protection, or representative fail.
- [ ] Publish deterministic compiler and kill summaries.

Exit checklist:

- [ ] All K3 exit criteria pass.
- [ ] Required P0 survivors are zero.
- [ ] Lower rate, missing ID, or previously killed survivor makes CI red.

### CC-22 - Unified execution-driver migration

- Owner role: execution-kernel owner
- Depends on: CC-21 and CC-32

Checklist:

- [ ] Implement the frozen multi-phase contract in the unified kernel.
- [ ] Migrate all nine passing proofs off `specialDrive`.
- [ ] Emit one canonical driver identity in every bundle.
- [ ] Add a source ratchet rejecting new `specialDrive` bypasses.
- [ ] Compare every migrated trace with its CC-21 fixture.
- [ ] Remove `specialMultiPhaseProofs` disclosure only when genuinely empty.

Exit checklist:

- [ ] Every deterministic v1 scenario uses the unified driver.
- [ ] Strict spawn, Product, Canary, and explorer adapters remain honestly
  classified where applicable.
- [ ] All nine semantic digests match or an intentional difference has a
  separately reviewed obligation and evidence change.
- [ ] No `specialDrive` source path remains.

### CC-23 - Isolated base/candidate differential command

- Owner role: structural comparator owner
- Depends on: CC-22

Checklist:

- [ ] Accept immutable base and candidate SHAs.
- [ ] Execute each SHA with separate worktree, DB, workspace, cache, logs, and
  build output.
- [ ] Compare normalized products, revisions, CandidateSets, receipts,
  decisions, effects, settlement, routes, reason sequence, and outcome.
- [ ] Ignore only frozen K0 fields.
- [ ] Demonstrate one known semantic mutant produces a non-zero diff.

Exit checklist:

- [ ] Equal revisions produce zero semantic diff.
- [ ] Known mutant is detected.
- [ ] Missing fixtures, empty traces, or shared environment fail closed.

### CC-24 - K2 strict spawned-seam audit

- Owner role: strict actor owner
- Depends on: CC-22
- Non-goals: requiring every workshop to be strict or claiming full-lifecycle
  qualification

Checklist:

- [ ] Audit the current spawned happy and exact-feedback repair proofs against
  every K2 master-plan checklist and exit item.
- [ ] Confirm the child uses real `workerSpawn`, production-visible inputs,
  actual MCP tools, normal completion, and the production spawn envelope.
- [ ] Confirm absent, stale, corrupt, and exact-feedback variants cannot infer
  repair behavior from attempt number or hidden state.
- [ ] Confirm removing MCP configuration or tool permission fails before the
  handler is invoked.
- [ ] Add only the missing K2 regression needed to make the exit evidence
  complete; do not broaden into Development/Delivery here.

Exit checklist:

- [ ] Every K2 exit criterion has blocking evidence.
- [ ] The exact strict seam and its limitations are recorded in the gate ledger.
- [ ] Full-lifecycle strict qualification remains explicitly owned by CC-60.

### CC-40 - Fault-boundary registry and receipts

- Owner role: fault-kernel owner
- Depends on: CC-22, CC-24, and CC-32

Checklist:

- [ ] Register all ten master-plan fault boundaries.
- [ ] Define crash-before, crash-after, restart, fair drain, expected landmarks,
  and typed outcomes for each.
- [ ] Map current eight platform tokens without claiming they equal the
  ten-by-two matrix.
- [ ] Give unsupported boundaries a typed reason and owner. Structural-cutover
  boundaries may not remain unsupported at qualification.
- [ ] Define immutable injection and restart receipts.

Exit checklist:

- [ ] Registry and coverage identity are deterministic.
- [ ] Every structural-cutover boundary has before and after schedules.
- [ ] No action can write decisions, receipts, repair ownership, or routing.

### CC-41 - Deterministic fault scheduler

- Owner role: fault-kernel owner
- Depends on: CC-40

Checklist:

- [ ] Replace FaultSchedule refusal with execution behind the fail-closed mode
  boundary.
- [ ] Inject only through named observe-and-terminate failpoints or declared
  external process controls.
- [ ] Restart the same durable store and redrive through production commands.
- [ ] Enforce bounded unfair prefix followed by explicit fair drain.
- [ ] Record injection, termination, restart, and drain receipts.
- [ ] Keep fault claims refused until a complete blocking package is green.

Exit checklist:

- [ ] Same seed and schedule produce the same semantic trace.
- [ ] Duplicate accepted material and non-idempotent effects are rejected.
- [ ] Observer and scheduler remain non-authoritative.

### CC-42 - Counterexample minimizer

- Owner role: minimizer owner
- Depends on: CC-41

Checklist:

- [ ] Minimize phases, commands, faults, and irrelevant fixture data.
- [ ] Preserve failed invariant, detector, reason, and subject.
- [ ] Serialize fixtures without UUIDs, timestamps, absolute paths, or local IDs.
- [ ] Replay minimized failures repeatedly.

Exit checklist:

- [ ] A known failure produces a smaller deterministic replay.
- [ ] Minimized replay preserves causal failure identity.
- [ ] Passing scenarios never emit counterexamples.

### CC-43 - Ten-boundary crash matrix

- Owner role: fault scenario owner, serialized through fault-kernel owner
- Depends on: CC-42

Checklist:

- [ ] Demonstrate crash-before and crash-after for every supported boundary.
- [ ] Restart and fair-drain every case.
- [ ] Make every structural-cutover boundary blocking.
- [ ] Land `K4:crash-after-effect-before-receipt` for Delivery.
- [ ] Require terminal outcome, typed wait, or bounded incident.
- [ ] Publish exact registry coverage and evidence digests.

Exit checklist:

- [ ] Ten-by-two matrix is complete or every non-structural unsupported cell has
  typed exclusion and owner.
- [ ] All structural-cutover cells are demonstrated and blocking.
- [ ] Delivery crash token is PASS-covered.

### CC-44 - K4 observer, causality, and progress closure

- Owner role: observer/assertion owner
- Depends on: CC-43

Checklist:

- [ ] Add static ratchet: observer imports no reducer or writer.
- [ ] Deny write capabilities at runtime and prove denial.
- [ ] Prove DSL cannot prescribe decision, repair owner, or transition.
- [ ] Prove exact feedback differs causally from absent/stale/corrupt feedback.
- [ ] Require live owner, runnable command, typed wait, transition due, or
  explicit stall/inconsistent classification for every nonterminal snapshot.
- [ ] Verify deterministic minimized replay.

Exit checklist:

- [ ] All K4 exit criteria pass.
- [ ] Every fault bundle has progress, fault, and evidence provenance.
- [ ] Fault scheduler refusal is removed only after this gate is green.

### CC-10B - Final K5 blocking gate

- Owner role: CI and claims owner
- Depends on: CC-32 and CC-44

Checklist:

- [ ] Make strict happy and feedback repair evidence blocking.
- [ ] Make obligation/mutant closure, progress, counterfactual, fault, and
  minimizer self-tests blocking.
- [ ] Enforce time, host-cycle, scenario-count, and concurrency budgets.
- [ ] Add vacuous empty-pack mutant that makes the group red.
- [ ] Add self-mutations for composition removal, lifecycle bypass, missing
  fence/receipt/effect, and route omission.
- [ ] Repeat complete group three times in fresh environments.

Exit checklist:

- [ ] Every K5 exit criterion passes.
- [ ] Every required kernel self-mutation makes the group red.
- [ ] Vacuous pack makes the group red.
- [ ] Exact claim closure and budgets remain blocking.

---

## 7. Pre-cutover full-closure packages

### CC-50 - Development restart and feedback proofs

- Owner role: Development pack owner
- Depends on: CC-22 and CC-44

Checklist:

- [ ] Demonstrate `restart:development:git-change-desk-replay` through the
  unified driver after `1a6fc2a5`.
- [ ] Demonstrate `restart:development:idempotent-redrive`.
- [ ] Demonstrate `feedback:development:exact-repairs-and-absent-does-not` with
  exact/absent/stale/corrupt counterfactuals.
- [ ] Keep restart tokens in recovery and feedback in declared non-recovery
  dimensions.

Exit checklist:

- [ ] Both restart tokens are PASS-covered.
- [ ] Exact feedback is causally necessary.
- [ ] No direct SQL seed or authority write is used.

### CC-51 - Delivery restart settlement

- Owner role: Delivery pack owner
- Depends on: CC-50 and CC-43

Checklist:

- [ ] Characterize orphaned `runDeliveryRestartProof` before activation.
- [ ] Migrate it to the unified driver.
- [ ] Run three starts only after Development desk replay is PASS-covered.
- [ ] Prove no duplicate effect, settlement, release, or observation.
- [ ] Preserve blocked relation until the proof passes.

Exit checklist:

- [ ] `restart:delivery:idempotent-settlement` is PASS-covered.
- [ ] Delivery reaches 19/19 only after this and the CC-43 crash token pass.

### CC-52A through CC-52D - Development domain clusters

- Owner role: one Development pack owner; fixture agents may work in parallel
- Depends on: CC-22
- Merge rule: serialize `development-scenario-pack.mjs` edits

Checklist:

- [ ] CC-52A: sibling isolation, claim monotonicity, same-Workplace review return.
- [ ] CC-52B: Git integration only after final acceptance and idempotent redrive.
- [ ] CC-52C: frozen candidate, source mismatch, stale readiness, exact
  verification candidate hash.
- [ ] CC-52D: settlement outcomes, upstream-defect routing, managed-source
  continuation, superseded-task exclusion.
- [ ] Every token has a negative case and exact evidence mapping.
- [ ] Every scenario is registered in declaration ledger and runtime builder.

Exit checklist:

- [ ] All cluster tokens are PASS-covered; declaration alone is insufficient.
- [ ] No oracle was weakened to close a token.

### CC-53 - Deterministic strong concurrency-cap proof

- Owner role: Development pack owner plus scheduler fixture owner
- Depends on: CC-52A through CC-52D

Checklist:

- [ ] Preserve token
  `D2:fanout-scheduling:concurrency-cap-limits-parallel-runnable` unchanged.
- [ ] Hold at least `cap` independent runnable Workplaces at a deterministic
  barrier.
- [ ] Prove `peak <= cap` under all schedules.
- [ ] Prove `peak == cap` when at least `cap` items are admitted.
- [ ] Measure with receipts/barriers, not wall-clock timing.

Exit checklist:

- [ ] Existing strong token is PASS-covered without rename, split, or demotion.
- [ ] Lower and higher cap variants pass deterministically.

### CC-54 - Transition and workshop closure

- Owner role: workshop coverage owner
- Depends on: CC-50, CC-51, CC-52A-D, CC-53

Checklist:

- [ ] Cover all five currently uncovered transitions.
- [ ] Require Development and Delivery pending sets to be empty.
- [ ] Require PASS evidence for every required workshop token.
- [ ] Require recovery 17/17 and transitions 33/33.
- [ ] Regenerate evidence through canonical harvest.

Exit checklist:

- [ ] Development is declaration-closed and 35/35 PASS-demonstrated.
- [ ] Delivery is declaration-closed and 19/19 PASS-demonstrated.
- [ ] Recovery is 17/17 and transitions are 33/33.
- [ ] Universe, token, scenario, and edge floors did not decrease.

### CC-60 - Strict full-lifecycle and repair qualification

- Owner role: strict actor owner
- Depends on: CC-10B, CC-22, CC-24, CC-32, and CC-44

Checklist:

- [ ] Consume the completed K2 exit evidence from CC-24 without redefining its
  strict actor contract.
- [ ] Add one strict `workerSpawn` full-lifecycle happy proof through Delivery.
- [ ] Preserve assignment, desk, MCP, permissions, hooks, heartbeat,
  finalization, gates, effects, settlement, and routing.
- [ ] Add or requalify one strict exact-feedback same-Workplace repair proof.
- [ ] Prove missing MCP config or tool permission fails before handler call.
- [ ] Extend strict Development and Delivery without workshop kernel branches.

Exit checklist:

- [ ] Every K2 exit criterion passes.
- [ ] Blocking group contains strict full-lifecycle happy proof.
- [ ] Blocking group contains strict same-Workplace repair proof.

### CC-61 - W1-1 and W1-4 strict requalification

- Owner role: causal vertical owner
- Depends on: CC-60

Checklist:

- [ ] Run W1-1 and W1-4 through canonical spawn composition.
- [ ] Give each independent obligation, mutant family, causal representative,
  and normalized trace.
- [ ] Preserve feedback counterfactuals where applicable.

Exit checklist:

- [ ] Neither proof relies on CanonicalFast as its highest level.
- [ ] Both are blocking with mutation witnesses and causal traces.

### CC-62 - W1-2 Factory Start A to B to C

- Owner role: replay/restart vertical owner
- Depends on: CC-60

Checklist:

- [ ] Create real starts A, B, and C for one Project through production paths.
- [ ] Prove new run, lifecycle, Workplace, and execution identities.
- [ ] Prove semantic-compatible hits and typed incompatible misses.
- [ ] Use no cross-DB copy, reset, or private lifecycle harness.
- [ ] Add obligation, mutant family, causal trace, and blocking claim.

Exit checklist:

- [ ] W1-2 passes through canonical spawn and is blocking.
- [ ] Current gates, effects, settlement, and routing run on A/B/C.

### CC-63 - W1-3 authorized Delivery release

- Owner role: Delivery causal vertical owner
- Depends on: CC-60 and CC-51

Checklist:

- [ ] Formalize authorized Delivery-to-`released` as W1-3.
- [ ] Use append-only sandbox journal outside Factory SQLite as independent
  external marker.
- [ ] Bind internal receipts and marker to the same desired state.
- [ ] Prove non-empty effect ledger and no unproved repetition.
- [ ] Add obligation, mutant family, causal trace, and blocking claim.

Exit checklist:

- [ ] W1-3 passes through canonical spawn.
- [ ] Independent external observation confirms release.
- [ ] All K6 exit criteria pass for W1-1 through W1-4.

### CC-70 - K7 bounded explorer

- Owner role: explorer owner
- Depends on: CC-32 and CC-42

Checklist:

- [ ] Model Workplace/material, execution/engine, and lifecycle/pipeline as
  orthogonal bounded machines.
- [ ] Use production reducers/repositories with independent expectation ledger.
- [ ] Generate legal/adversarial commands and exact/stale/foreign/missing/newer refs.
- [ ] Bound Workplaces, executions, revisions, attempts, and topology.
- [ ] Use BFS, seeded walks, proven partial-order reduction, and minimization.
- [ ] Promote selected traces through L2/L3/L4 adapters.
- [ ] Label explorer-only claims L1/L2.

Exit checklist:

- [ ] Closed event vocabulary is generated or explicitly excluded.
- [ ] Known authority, fence, and replan mutants are discovered.
- [ ] Promoted minimized traces replay deterministically.
- [ ] Explorer decisions never become production authority.

### CC-72 - S satisfiability corpus

- Owner role: satisfiability owner
- Depends on: CC-32 and CC-44

Checklist:

- [ ] Implement S as conjunction decision over installed obligations.
- [ ] Cover scope/artifact, tool, schema, provider trust, routing, and
  contradictory acceptance obligations.
- [ ] Decide mechanically decidable instances with named procedures.
- [ ] Return `open` or `unknown` for semantic-open instances.
- [ ] Add zero-edge and vacuously terminal negatives.

Exit checklist:

- [ ] Every installed check is classified or fails closed.
- [ ] Contradictions have proof, lawful exit, or honest open state.
- [ ] Deterministic S claims are blocking.

---

## 8. Qualification audit and handoff

### CC-80 - Complete qualification command

- Owner role: integration owner
- Depends on: CC-00, CC-10B, CC-23, CC-32, CC-44, and CC-60

Checklist:

- [ ] Compose one command for every K0-K5 exit and Structural Qualification item.
- [ ] Include strict happy/repair, cutover faults/mutants, differential compare,
  and zero-authority-write ratchets.
- [ ] Fail on missing fixtures, empty scans, zero tests, or skipped groups.

Exit checklist:

- [ ] Command is documented, non-vacuous, and deterministic.
- [ ] One known mutation in each required class makes it red.

### CC-81 - Read-only qualification audit

- Owner role: reviewer/integration owner
- Depends on: CC-80
- Non-goals: implementing fixes inside the audit

Checklist:

- [ ] Evaluate every master-plan Structural Qualification checkbox.
- [ ] Evaluate every cleanup-plan prerequisite without trusting stale prose marks.
- [ ] Attach command, SHA, path, digest, and proof mode to every PASS.
- [ ] Create named `CC-GAP-N` for every failure and return to implementation.

Exit checklist:

- [ ] Every item is evidenced PASS or audit remains RED.
- [ ] `QUALIFICATION_GREEN` emits only with no open gap.

### CC-82 - Clean-clone reproduction and evidence freeze

- Owner role: integration owner
- Depends on: CC-81

Checklist:

- [ ] Use fresh isolated checkout at exact candidate SHA.
- [ ] Install/build without borrowed `dist`, DB, cache, or workspace.
- [ ] Run complete CC-80 command.
- [ ] Record commands, exits, counts, time, SHA, report and diff digests.
- [ ] Freeze scenario, token, edge, required/killed mutant, and runtime floors.
- [ ] Capture pre-cutover normalized evidence.

Exit checklist:

- [ ] Complete gate passes from fresh checkout.
- [ ] Pre-cutover evidence/floors are frozen.
- [ ] Result states `QUALIFICATION_GREEN` and
  `STRUCTURAL_IMPLEMENTATION_AUTHORIZED = false`.

### Authorization transition

After CC-82, complete CC-50 through CC-54, CC-61 through CC-63, CC-70, and CC-72.

- [ ] ADR-085 and ADR-086 have required adoption and authorization.
- [ ] All pre-cutover packages are merged; full suite is green.
- [ ] No conformance package is writing shared proof/runtime surfaces.
- [ ] Exact structural-train base SHA is frozen.
- [ ] Record `STRUCTURAL_IMPLEMENTATION_AUTHORIZED = true` with evidence.
- [ ] Pause all conformance implementation during atomic structural train.
- [ ] Hand execution to structural plans; do not implement R2-R5/R9/R10 here.

---

## 9. Post-catalog K8 package

### CC-71 - K8 universality and steady-state closure

- Owner role: universality owner
- Depends on: CC-10B, CC-54, CC-61, CC-62, CC-63, and canonical closed ADR-085 catalog

Checklist:

- [ ] Bind fresh bootstrap to caller-supplied admitted installation/lifecycle.
- [ ] Run generic corpus for all four workshops.
- [ ] Add synthetic workshop using only package, lifecycle, fixtures, actors,
  external providers, and semantic predicates.
- [ ] Enforce file allowlist proving zero universal engine/runtime edits.
- [ ] Verify catalog removal disables workshop for every host.
- [ ] Verify equal binding receipts for orchestrator, worker MCP, scripted actor.
- [ ] Verify descriptor-based module-owned scenario discovery.
- [ ] Run fresh scripted happy and repair L5 scenarios.
- [ ] Establish coverage, runtime, and flake budgets.
- [ ] Map legacy suites before retirement.
- [ ] Run monitored happy and repair canaries through opencode in isolated state.

Exit checklist:

- [ ] Every K8 exit criterion passes.
- [ ] Synthetic workshop required zero universal edits.
- [ ] All W0 and P0 W1 proofs remain blocking and green.
- [ ] Canaries remain monitored evidence, not deterministic gates.
- [ ] ADR-085 P4/P5 may consume synthetic-workshop evidence.

---

## 10. Definitions of Done

### Qualification-ready

- [ ] K0-K5 exit gates are evidenced and blocking.
- [ ] Blocking file and proof-claim sets are equal.
- [ ] Required P0 mutants have zero survivors and monotonic floors.
- [ ] Cutover fault schedules and minimization are blocking.
- [ ] Strict full-lifecycle happy and repair proofs are blocking.
- [ ] Isolated comparison detects semantic change.
- [ ] Complete gate passes from fresh checkout.
- [ ] `QUALIFICATION_GREEN` is recorded with frozen evidence.

### Pre-cutover full closure

- [ ] Development 35/35 and Delivery 19/19 by PASS evidence.
- [ ] Recovery 17/17 and transitions 33/33.
- [ ] W1-1 through W1-4 pass canonical spawn with mutants and traces.
- [ ] K7 exit passes.
- [ ] S deterministic claims block; semantic-open claims are honest.
- [ ] Full suite and matrix are green on frozen structural base.
- [ ] Structural authorization follows ADR adoption and no-parallel-writers check.

### Final conformance-engine closure

- [ ] ADR-085 closed catalog exists and structural train is not parallel with
  conformance implementation.
- [ ] K8 passes with synthetic workshop and zero engine edits.
- [ ] Fresh scripted happy/repair L5 runs pass.
- [ ] Happy/repair opencode canaries pass as monitored evidence.
- [ ] L0-L5/S claims are explicit and honestly scoped.
- [ ] Legacy suites retire only after blocking obligation mapping.
- [ ] New defects extend existing obligations, mutants, or scenarios instead of
  creating another harness.

---

## 11. Per-package verification checklist

- [ ] Re-read applicable stage and ADR.
- [ ] Confirm isolated worktree, base SHA, and unrelated-file preservation.
- [ ] Run narrowest test first.
- [ ] Run build/type checks for TypeScript changes.
- [ ] Run import, claim-set, coverage, and non-vacuity ratchets.
- [ ] Run relevant acceptance group.
- [ ] Run mutation self-tests for oracle/obligation changes.
- [ ] Repeat process/fault tests enough to prove determinism.
- [ ] Run full suite before integration from isolated worktree.
- [ ] Record commands, exits, counts, time, and digests.
- [ ] Confirm no authority write, workshop branch, hidden retry, proof
  inflation, or legacy composition import.
- [ ] Stage only owned files by explicit path.

---

## 12. Resolved planning decisions

These are binding and must not reopen as operator questions.

- [x] Add 12 v1 tests after CC-00, but call K5 provisional until CC-10B.
- [x] Keep mutation accounting separate from scenario-token coverage.
- [x] Require 100 percent kill for required P0 mutants and exact ID floors.
- [x] Preserve and deterministically prove the strong concurrency token.
- [x] Implement S before claiming full master-plan closure.
- [x] Use isolated worktrees; the main checkout is never required.
- [x] Stop qualification at evidence; structural plans own implementation.
- [x] Pause proof work during the authorized structural train, then run K8.

### Decision record

| Option | Correctness (30) | Autonomous execution (25) | Evidence honesty (20) | Reversibility/scope (15) | Readability/cost (10) | Total / 500 |
|---|---:|---:|---:|---:|---:|---:|
| Minimal factual patch | 3 | 2 | 3 | 5 | 4 | 315 |
| Two coarse milestones | 5 | 4 | 5 | 5 | 4 | 465 |
| Bounded package graph | 5 | 5 | 5 | 4 | 2 | 455 |

The top options were within 10 percent. The bounded package graph was selected
because it is more reversible package-by-package and removes the authorization
race between qualification, K8's catalog dependency, and atomic cutover. Its
documentation cost is controlled by stable IDs, the critical path, single-
writer ownership, and the task template.

Pre-mortem controls:

- [ ] Qualification and structural authorization are recorded separately.
- [ ] Provisional CI runs fully three times before landing and at final K5.
- [ ] Audit failures create `CC-GAP-N`; audit does not implement hidden fixes.
- [ ] Pre-cutover work finishes, structural train runs alone, K8 consumes its
  catalog afterward.
- [ ] Every package declares dependencies, non-goals, ownership, and merge order.

---

## 13. Principal risks

- [ ] K4 is the largest remaining kernel change. Keep refusal until the full
  deterministic matrix is green.
- [ ] Nine-proof migration can change semantics. Trace equality is mandatory.
- [ ] Percentage-only mutation reporting can hide untested mutants. Required
  ID closure and zero P0 survivors are primary.
- [ ] Workshop closure will find production defects. Each gets typed fix,
  regression, and unchanged pending token until demonstrated.
- [ ] Delivery restart WIP may not fit the driver. Characterize first.
- [ ] Fault failpoints may observe and terminate, never fabricate authority.
- [ ] Canaries can collide with live state. Re-read tracker, isolate state, and
  use opencode shim.
- [ ] Green qualification can trigger premature moves. Structural edits remain
  forbidden until explicit authorization transition.
