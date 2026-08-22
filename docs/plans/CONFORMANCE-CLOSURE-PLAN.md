# Conformance Closure Execution Plan

- Status: Ready for autonomous execution in isolated worktrees
- Date: 2026-08-22
- Historical draft base: `saga4@53cf7c81`
- Runtime base: `origin/saga4` @ `6ddcb107` (recorded in
  `docs/factory-run/conformance-closure/CC-00-BASELINE.md`)
- Scope end: full Saga Kernel Conformance Engine closure and an explicit,
  evidence-backed handoff to the structural plans

This plan is subordinate to
`docs/plans/SAGA-KERNEL-CONFORMANCE-ENGINE-PLAN.md`. ADR-084 is Accepted and is
the governing conformance decision. ADR-088 is Accepted and governs the
CC-GAP-6 coverage contract (register-conditional grandfathering,
execution-entrypoint ownership, kernel-only `coveredConstraintIds`
derivation). ADR-089 is Accepted and governs the CC-GAP-9 substrate
contract (bounded deterministic in-check substrate retry, then typed
unknown `warrant-blocked-environment` and human_required blocked/resumable
continuation — never product-failed; unknown receipts never poison a later
pass). ADR-091 is Accepted and governs the CC-GAP-9 RESIDUAL
(readiness-substrate TOCTOU re-probe): on a mid-check executor/compose
failure the cached availability probe is invalidated and the daemon is
mechanically re-probed; only an OBSERVED unavailable/not-linux re-probe
routes into the existing ADR-089 bounded retry and typed unknown, while
an observed available+linux re-probe leaves a bad image/tag/config/product
product `failed`; classification never reads stderr text; compose `down`
stays best-effort and distinct from invalid config; the three outcome
classes never collapse; the provider pins `1.12.0` with the digest fence
and trust migration intact (obligation compiler pin:
`factory.local-runnability.v1` @ `1.12.0`); the residual closes BEFORE
any production factory run and BEFORE CC-GAP-7 warrant execution. ADR-090 is
Accepted and governs the Idea Authority Conservation
program (§7A): the single Order Constraint Register vocabulary is extended
at Discovery settlement — the closed class vocabulary
(`execution|material|human`) is preserved unchanged and an orthogonal kind
vocabulary (`scope|open-question|mechanics|synthesis|ordered-smoke|quality`)
is added, with typed measurability binding only qualitative/experience
entries, and deterministic `runnable-local` synthesis injection — with
one digest/ref, one disposition network, the existing ADR-088 coverage
relay and reverse diff (production direction: register minus waived ⊆
covered), existing RULE artifacts as the mechanics-spec
carrier, an advisory-only archaeologist, and proof tokens compiled into
the single ADR-084 AcceptanceObligationContract family; implementation is
the bounded serialized packets CC-IC-1..4, which start after the
CC-GAP-6 seam (landed in integration at commit `50824c6a`; the v1
read-back verifier SOURCE repair is landed there and is tested for
round-trip identity and digest tamper — the id-reorder and
snake_case-at-verify reds are NOT yet tested and remain explicit CC-IC-1
base-verification work, so prerequisite m0 is landed-in-source with a
residual verification obligation, never re-implemented) and are a
mandatory overall qualification dependency; the CC-IC v2 vocabulary work
itself remains open. The proof-contract subset direction repair
(`3be7393d`, landed on the same integration branch) already corrected the
`frm.submission.acceptance-contract` token (v2.1.0
`uncoveredConstraintResidue ⊆ empty` form) and the SRS §D2↔AC residues
(`unrepresentedFrozenAcResidue`/`foreignD2AcResidue` ⊆ empty) — for
CC-IC-4 those two corrections are VERIFY-ONLY, never redone, and only the
SRS register-coverage residue constraint remains to be added, always in
the landed uncovered-residue algebra, never a bare member/of flip.
ADR-053 is a Proposed architectural
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

CC-00 refreshed them at `6ddcb107`; see `CC-00-BASELINE.md` and
`CC-00-baseline-ledger.json`.

- [x] CC-00 recorded `CC-GAP-1`: a deterministic red baseline of six
  Development convergence acceptance/gate/repair E2E failures, bisected to
  the `303a482a` merge window. A dedicated CC-GAP-1 package owns
  adjudication; pre-cutover full-suite green and CC-82 require its closure.

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
| K0 | Partial evidence | Re-audit every exit item, clean-checkout reproduction, live trace baseline, and legacy-to-obligation mapping; CC-00B terminal-integrity closure required (no open CC-GAP-2..5); CC-00C product-claim-integrity closure required (no open CC-GAP-6..10) |
| K1 | Partial evidence | Remove special-drive bypasses and prove the truthful canonical entrypoint claim |
| K2 | Strict Formalization evidence exists | Add the gate-required strict full-lifecycle happy proof and re-audit strict repair evidence; CC-00B terminal-integrity closure required (no open CC-GAP-2..5); CC-00C product-claim-integrity closure required (no open CC-GAP-6..10) |
| K3 | Compiler and mutation algebra exist | Add required-mutant closure, harvest aggregation, reporting, and blocking floors |
| K4 | DSL, observer, runner, progress, and bundles exist | Add named fault scheduling, fault receipts, and deterministic minimization; CC-00B terminal-integrity closure required (no open CC-GAP-2..5); CC-00C product-claim-integrity closure required (no open CC-GAP-6..10) |
| K5 | Provisional blocking group exists | Add 12 files, exact bidirectional claim closure, K3/K4 ratchets, budgets, and non-vacuity; CC-00B terminal-integrity closure required (no open CC-GAP-2..5); CC-00C product-claim-integrity closure required (no open CC-GAP-6..10) |
| K6 | W1-1 and W1-4 are CanonicalFast only | Requalify W1-1/W1-4 through canonical spawn and add W1-2/W1-3 |
| K7 | Not implemented | Add bounded explorer and deterministic promoted replay |
| K8 | Four workshop packs use one kernel | Add post-catalog synthetic workshop, binding parity, L5 proofs, budgets, and canaries; CC-00C product-claim-integrity closure required (no open CC-GAP-6..10) |
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
- [ ] Obey the terminal-integrity guardrail (section 3.1) and the
      product-claim integrity guardrail (section 3.2) in every package and
      every status surface.

### 3.1 Terminal-integrity guardrail (normative)

These five facts are independent and must never be collapsed into one status:

1. operational completion — engine exit code, launch `completed`, clean
   process termination;
2. lifecycle terminal outcome — `terminal_status`;
3. stage/process local outcome — `local_outcome`, `processOutcome.code`;
4. final gate verdict — for example the final development-readiness gate;
5. product success.

Exit 0, a completed launch, or lifecycle `status=completed` never proves
product success. Every status surface — journal events, tracker, launch
projection, reports — must expose operational and product outcomes as separate
fields. A failed final gate verdict must never be presented as product
success. A run configured with `delivery.mode=deferred` ends at Development by
design; that early end must be labeled explicitly and misclassified as
neither product failure nor Delivery success. A terminal run leaves zero
`running` WorkerExecutions and at most one effective terminal journal event per
terminalized scope: the durable terminal claim is the authority, the journal
projection is honestly 0..1 under append failure, and exactly one is never
guaranteed. This guardrail is enforced by CC-00B and wired into K0, K2, K4, K5,
CC-81, and CC-82: with any CC-GAP-2..5 open, those gates cannot pass and
`QUALIFICATION_GREEN` cannot be emitted.

### 3.2 Product-claim integrity guardrail (normative)

These five facts are independent and must never be collapsed into one status:

1. ordered deliverable claim — what the product must be and how it must run
   (for example: install plus start leading to an accessible running
   browser-product);
2. semantic claim-to-work coverage — which accepted criteria are covered by
   which planned items and scopes, and which item explicitly owns
   whole-product synthesis;
3. verification accounting — which required verification obligations were
   proposed, deferred as pending, or actually executed, and through which
   oracle;
4. substrate versus product outcome — infrastructure availability (for
   example Docker) is not a product verdict;
5. product success.

Deliverable-claim classification authority originates in Discovery and
Formalization, never in the Development planner: Discovery counts the
order's requirements as the versioned Order Constraint Register
(`factory.order-constraint-register.v1`; stable `ord-c-NNN` ids; classes
`execution|material|human`), Formalization owns AC-to-constraint coverage
(`coveredConstraintIds` on frozen criteria and SRS sections, plus SRS §2.2
module-manifest scope coverage) and cites the register as the
`VerificationWarrantRef`, and the planner and readiness certifier only
inherit and execute that frozen classification. A nominal
criterion-to-item attachment is not coverage, and the exit criterion is
mechanical: for a non-empty register, register ids minus the union of
`coveredConstraintIds` minus typed waivers equals the empty set (the
AC-drift network-2 reverse diff), every §2.2 manifest-declared file lies
inside some item's frozen change scopes, every entrypoint file declared by
an execution-class register entry lies inside the frozen change scopes of
an item whose kernel-derived `coveredConstraintIds` include that same
entry — a wide item that merely contains the file while covering no such
constraint does not satisfy it — and a buildable/integrator
criterion with no item owning whole-product synthesis
(bootstrap/static-page/serving integration or a declared equivalent) fails
planning admission with a typed reason. `coveredConstraintIds` is
kernel-derived from frozen criteria; planner output can neither propose
nor forge it. Grandfathering is register-conditional (ADR-088): only a
corpus with no constraint register (proposal without `order_constraints`,
null register binding) is grandfathered — its diffs are empty, its skips
typed, its gates green, and frozen evidence is never rewritten; when a
non-empty register exists, missing coverage (a non-empty reverse diff) and
a missing or file-less SRS §2.2 manifest are typed red, never a legacy
skip. A generic loopback health oracle cannot discharge
a browser-product claim; the end-to-end oracle is warrant execution over
the `VerificationWarrantRef` through package-level, workshop-declared
oracle adapters, with no universal engine or test-engine branch on
workshop name, `moduleRef`, or role profession. Three outcomes stay
distinct and are never collapsed: product-failed (a check ran against the
product and failed), oracle-insufficient (the declared oracle cannot prove
the claim — an outstanding obligation, never a pass and never a product
verdict), and substrate-unavailable (a missing environment precondition:
bounded deterministic in-check substrate retry, then a typed unknown
outcome — the `warrant-blocked-environment` semantics — and a
human_required blocked/resumable continuation, per ADR-089 — never a
deterministic repair round for a machine fault, never unbounded silent
retry, and never a terminal product failure). An unknown receipt never
prevents, fails, annotates, or counts against a later pass of the same
criterion. CC-GAP-9 outcome/routing lands before
CC-GAP-7 warrant execution so warrant phases can never re-flatten a
substrate failure into product failure, and the CC-GAP-9 RESIDUAL
(ADR-091 TOCTOU re-probe) closes before ANY production factory run and before
CC-GAP-7: a mid-check executor/compose failure is classified by
invalidating the cached availability probe and mechanically re-probing
the daemon — only an observed unavailable/not-linux re-probe routes
into the ADR-089 bounded retry and typed unknown; an observed
available+linux re-probe leaves a bad image/tag/config/product product
`failed`; classification never reads stderr text; compose `down` stays
best-effort and distinct from invalid config; the three outcome classes
never collapse; the provider pins `1.12.0` with the digest fence and
trust migration intact (obligation compiler pin
`factory.local-runnability.v1` @ `1.12.0`). The substrate roles are split
and may not drift (ADR-083 boundary note): ADR-083/K19 owns the
declared/observed/authorized environment IDENTITY — the derived
`DerivedExecutionEnvironment`, `environmentDigest`, image/toolchain
implementation digests, and the floating-tag prohibition; CC-GAP-9 owns
environment AVAILABILITY only (whether the authorized environment can be
materialized: bounded in-check retry, typed unknown,
human_required blocked/resumable — never an identity decision); CC-GAP-7
warrant execution CONSUMES the `environmentDigest` and receipt-binds it
(the readiness receipt binds the digest it ran under) and never
authorizes environment identity. The K19 image/digest remainder
(per-package OCI image/dependency digest persistence and the ADR-077
keyed `toolchainDigests` component) is sequenced before CC-GAP-7
receipt-binding; if it has not landed when CC-GAP-7 starts, the honest
fallback applies — CC-GAP-7 binds the `environmentDigest` the stage-14
derivation core already produces and records honestly that image and
dependency digest persistence is not yet available; it must never
fabricate a digest, never defer to an unauthorized one, and never
authorize a floating tag. Verification accounting is an
append-only criterion-key ledger: every required verification obligation
is a first-class entry keyed by criterion, appending
`proposed -> pending -> executed(passed|failed) | unknown | waived`
transitions that are never rewritten or deleted; a pending entry survives
readiness failure and lifecycle continuation; `executed(failed)` does not
discharge (the obligation stays outstanding); the sole discharge paths are
a passed receipt or an operator-attributed waiver; every entry carries and
displays its stage and order coordinates; and the lifecycle transition
obligation ledger is not reused for this role — verification accounting is
a separate seam. Author and
reviewer projections of the same Workplace refs are correct in the durable
records; the CC-GAP-10 defect is rendering-only — board and task-detail
surfaces must display author versus reviewer role alongside the shared
Workplace identity, with no deduplication and no data rewrite. Reviewer
projections are not duplicate implementation work. Elite-6 root-cause
wording: AC-22 existed and was only nominally
attached — the defect is missing whole-product synthesis ownership and
missing mechanical classification enforcement upstream of the planner, not
a missing criterion — and tasks 15-25/26-36 were author and reviewer
projections of the same 11 Workplace refs, not duplicate implementations.

This guardrail is enforced by CC-00C and wired into K0, K2, K4, K5, K8,
CC-80, CC-81, and CC-82: with any CC-GAP-6..10 open, those gates cannot pass
and `QUALIFICATION_GREEN` cannot be emitted.

Idea authority conservation (ADR-090) extends this guardrail upstream
without parallel vocabulary: no scope-clause ledger and no unknown ledger
beside the register; the register's closed class vocabulary
(`execution|material|human`) is preserved unchanged and an orthogonal
kind vocabulary (`scope|open-question|mechanics|synthesis|ordered-smoke|
quality`) is added, with `open-question` entries drafted 1:1 from proposal
unknowns at Discovery settlement; every
open-question entry reaches `resolved`, or `deferred` (reason, owner,
unblock criterion), or a `waived` with trusted operator attribution
(any author-attributed waiver — single or en masse — is red; no
undefined mass-waiver concept) through the existing disposition network;
qualitative/experience (kind `quality`) entries carry typed measurability
(measurable interpretation or
typed deferral); the frozen `runnable-local` lifecycle classification
deterministically injects the whole-product-synthesis and ordered-smoke
obligations — the engine never infers by rereading prose; existing RULE
artifacts are the mechanics-spec carrier, with the typed binding
established at disposition/binding time against the accepted RULE
artifact (a mechanics entry is created at Discovery with no ref); the
LM archaeologist is advisory only, produced solely by an
operator-commissioned advisory producer with a recorded owner — no
standing automatic producer, no gate, no authority path (promotion
produces a new register
revision/digest, never a gate or authority mutation); every waiver on a
new-v2 entry requires trusted operator attribution — any
author-attributed waiver, single or en masse, is a typed red, and no
separate "mass waiver" concept is defined beside the per-entry rule; and
FOUR new conservation proof tokens compile into the single ADR-084
AcceptanceObligationContract family, while epic-clause coverage is
realized on the two existing register-coverage tokens — the
`frm.submission.acceptance-contract` direction defect is ALREADY
corrected by the landed `3be7393d` (v2.1.0 uncovered-residue form;
verify-only), and the same landing repaired the SRS §D2↔AC residues of
`frm.submission.srs-contract`, leaving ONLY the SRS register-coverage
residue constraint
(`registerIds-minus-waived` minus union of §D2
`covered_constraint_ids` = ∅, as a residue-empty constraint)
to be added in CC-IC-4 — never a bare member/of flip. Null-binding
grandfathering
applies only to frozen legacy v1 data (ADR-088 sole grandfather
condition; frozen evidence never rewritten); every NEW v2 Factory Start
carries non-null typed authority — a built register, or an explicit typed
no-obligations attestation if the architecture truly permits an
obligation-free order — and an absent required binding on a new v2 start
is red; continuations inherit the original register ref and never
re-extract; any present register fails closed. The certificate-to-
Formalization handoff carries exactly ONE register binding (mapped from
the discovery certificate; the proposal-payload rebuild fallback is
frozen-legacy-v1-only, and a v2 case without a binding or typed
no-obligations attestation is red); the warrant CROSS-BINDS the
certificate/case digest it was issued against (register+dispositions
self-consistency alone is not identity); dispositions are digest-pinned to
the register they were authored against (positional `ord-c` dispositions
cannot be reused across register revisions), and `resolved`/`deferred`
are disposition states that never subtract from the required-coverage
arithmetic (only the loud per-entry operator-attributed waiver does); the
runnable-local injection rides a declared digest-pinned injection table
(owned by `src/process-modules/lifecycles/product-build-lifecycle.ts`,
consumed read-only by Discovery settlement; the classification reaches
settlement ONLY through the pinned per-run read —
`ctx.processRunId` → join `factory_stage_runs.process_run_id` →
`lifecycle_run_id` → read the pinned `factory_lifecycle_runs`
`definition_snapshot` + `definition_hash` through a typed
`readDefinitionByProcessRun` port/repository implemented in
`src/process-modules/persistence/sqlite-lifecycle-run-repository.ts`,
injected through `src/app/product-lifecycle-runtime.ts` /
`src/app/composition-root.ts` — Discovery settlement consumes the
pinned classification + `definitionHash` read-only; a missing row
fails closed with a typed error, never an ambient or default
`lifecycleDefinition` binding; and Discovery imports no lifecycle
internals (no lifecycle module import — the classification arrives
only through the injected pinned read; the dedicated host
`tests/discovery/d7-settlement-lifecycle-classification.test.mjs` proves
the wiring)) with a normative interleave
order (proposal-derived block first, injected
block appended in table order); and the recorded v1 read-back verifier
defect (`verifyOrderConstraintRegister` — camelCase entries validated
against the snake_case draft shape) is repaired IN SOURCE by the
integrated CC-GAP-6 landing (`50824c6a`), which tests round-trip
identity and digest tamper — the id-reorder
(`ORDER_CONSTRAINT_REGISTER_ID_MISMATCH`) and snake_case-at-verify
typed-rejection reds are NOT yet tested there and remain explicit
CC-IC-1 base-verification work; the CC-IC-1 prerequisite (m0) is
landed-in-source with that residual verification obligation, verified at
the packet base and never re-implemented. This extension is
implemented by the serialized CC-IC-1..4 packets (§7A), which are not
required for CC-00C exit (frozen CC-00C scope: CC-GAP-6..10) but ARE a
mandatory overall qualification dependency: until CC-IC is implemented
and proven, the CC-10B blocking group, the CC-80 qualification command,
and overall K qualification (CC-81/CC-82) remain RED — the unproven
CC-IC set is recorded as an open mandatory dependency, never skipped.

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
| Constraint register and warrant seam | `src/shared/constraint-register.ts`, `formalization-contract-analysis.ts` and SRS validators, `development-schemas.ts` (`VerificationWarrantRef`), readiness warrant phases in `local-runnability-check-provider.ts`, and the CC-IC-1 lifecycle-classification wiring sites for the same row: `src/process-modules/persistence/sqlite-lifecycle-run-repository.ts` (LIMITED to the typed `readDefinitionByProcessRun` join/read), `src/app/product-lifecycle-runtime.ts` and `src/app/composition-root.ts` (LIMITED to DI/composition of that typed port) — single-writer with the register seam, so no other row or packet may concurrently edit them |
| Structural comparator | normalized trace schema, differential command, semantic ignore list |

- [ ] Parallelize read-only audits, fixtures, actor programs, external-world
  journals, and independent mutant-family specifications.
- [ ] Serialize edits to the execution kernel, report schema, acceptance
  matrix, trace vocabulary, and monolithic workshop packs.
- [ ] Serialize CC-GAP-9 substrate outcome/routing edits (execution-kernel
  owner) before CC-GAP-7 warrant-execution edits (verification owner); both
  touch the readiness provider seam, and warrant phases must never meet a
  substrate failure without the ADR-089 outcome/routing (bounded in-check
  retry, typed unknown, human_required blocked/resumable) already in place.
- [ ] Serialize CC-IC-1..4 (ADR-090) after the CC-GAP-6 seam (integrated
      at `50824c6a`, its four blocking mutations proven there): no CC-IC
      packet edits the register or coverage seams before the four
      CC-GAP-6 blocking mutations (ADR-088) are green, no CC-IC packet
      re-implements the already source-repaired v1 read-back verifier
      (m0 is landed-in-source; CC-IC-1 adds only the missing id-reorder
      and snake_case-at-verify verification at its base), no CC-IC
      packet redoes the already-landed proof-subset token corrections
      (`3be7393d` acceptance-contract v2.1.0 residue repair and the SRS
      §D2↔AC residue repairs are verify-only; only the SRS
      register-coverage residue constraint is added, in the landed
      residue algebra — never a bare member/of flip), and every CC-IC
      packet rides the single-writer `Constraint register and warrant
      seam` row above.
- [ ] Never merge competing versions of a shared contract.

---

## 5. Critical path

```text
CC-00 -> CC-00B -> CC-00C -> CC-10A

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

CC-00 + CC-00C + CC-10B + CC-23 + CC-32 + CC-44 + CC-60 -> CC-80 -> CC-81 -> CC-82

CC-50..54 + CC-61..63 + CC-70 + CC-72 + CC-82
  -> STRUCTURAL_IMPLEMENTATION_AUTHORIZED
  -> isolated ADR-085/086 train
  -> CC-71 K8 final qualification
```

K3 and K4 do not land as parallel merge waves because they share report,
evidence, and runner surfaces. Read-only K4 design may begin earlier; K4
implementation consumes frozen K3 identities from CC-32.

CC-00B sits on the critical path between CC-00 and CC-00C. Existing CC-10A
code may land and remain after CC-00, but the CC-10A exit checklist and the
deferred heavy validation it owns (the deferred CC-00 harvest regeneration and
the CC-10A fresh-environment runs) cannot close before CC-00B and CC-00C
exit. With any CC-GAP-2..5 open, K0/K2/K4/K5 evidence is incomplete, CC-81
stays RED, and CC-82 cannot emit `QUALIFICATION_GREEN`.

CC-00C sits on the critical path between CC-00B and CC-10A. With any
CC-GAP-6..10 open, K0/K2/K4/K5/K8 evidence is incomplete, CC-80 cannot
compose a complete qualification command, CC-81 stays RED, and CC-82 cannot
emit `QUALIFICATION_GREEN`.

The Idea Authority Conservation packets CC-IC-1..4 (ADR-090, §7A) serialize
after the CC-GAP-6 exit through the single-writer `Constraint register and
warrant seam` row (the seam's register code is integrated at `50824c6a`;
that landing repairs the v1 read-back verifier IN SOURCE and tests
round-trip plus digest tamper — the CC-IC-1 prerequisite m0 is
landed-in-source with the id-reorder and snake_case-at-verify reds still
untested, an explicit CC-IC-1 base-verification obligation, never a
re-implementation — the proof-subset landing `3be7393d` on the same branch
already corrected the acceptance-contract and SRS §D2↔AC token directions
(verify-only for CC-IC-4), and the CC-IC v2 vocabulary work remains not
started):

```text
CC-GAP-6 exit -> CC-IC-1 -> CC-IC-2 -> CC-IC-3 -> CC-IC-4
```

They are not required for CC-00C exit (CC-GAP-6..10 scope is frozen), they
are bounded packets with an explicit finish condition rather than a
standing parallel implementation program — and they ARE a mandatory
overall qualification dependency: until CC-IC-1..4 are implemented and
proven, the CC-10B blocking group, the CC-80 qualification command, and
overall K qualification (CC-81/CC-82) remain RED, with the unproven CC-IC
set recorded as an open mandatory dependency (never skipped, never
recorded as PASS).

---

## 6. Milestone A packages - K0 through K5

### CC-00 - Immutable baseline and gate ledger

- Status: COMPLETE 2026-08-22 except deferred harvest regeneration (operator
  quiet-machine directive; released by CC-00B/CC-10A).
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

### CC-00B - Elite-6 terminal-integrity closure

- Status: EXECUTING 2026-08-22. Integration truth at `50824c6a` (HEAD of
  `cc/CC-00B-terminal-integrity-integration`): CC-GAP-2 (`97dbc635`),
  CC-GAP-3 (`9c2253e2` receipt-authoritative terminal drain, plus the
  `f460ae84` journal-payload strictness fix), CC-GAP-4 (`dd89b40c`),
  and CC-GAP-5 (`9205d9f5`) have all LANDED on that integration branch
  — as have CC-GAP-6 (`50824c6a`), CC-GAP-8 (`8819e360`), CC-GAP-10
  (`184b2c77`), and the proof-subset token-direction repair
  (`3be7393d`), which belong to CC-00C scope. CC-GAP-7 is open. The
  CC-GAP-9 repair exists on its own branch
  (`cc/CC-GAP-9-substrate-typed-unknown`: `736621af` + `d3026cbe`
  post-REJECT repair) and is NOT yet integrated. Landing is not closure:
  the CC-00B exit gate has not been re-audited, none of these commits is
  merged to `saga4`, and neither the incident records nor this plan is
  merged — landing status recorded here is branch truth only, never a
  claim that the packages exited.
- Owner role: integration owner; gap owners named below
- Depends on: CC-00
- Non-goals: reopening or replaying the terminal Elite-6 run, hand-editing
  generated evidence or durable state, classifying the clean engine
  termination as a crash or engine death, production scope widening beyond
  the four named gaps
- Incident record:
  `docs/factory-run/conformance-closure/CC-00B-ELITE6-TERMINAL-INTEGRITY.md`
  — a clean operational engine termination (exit 0 at 2026-08-22T14:19:30Z)
  with a failed product outcome and terminal-projection defects. The record
  documents; the runtime is not fixed by it.

Stable gaps and owners:

- CC-GAP-2 terminal projection false-green — trace/evidence owner.
- CC-GAP-3 stale `running` WorkerExecution / missing `worker.exit` —
  execution-kernel owner.
- CC-GAP-4 duplicate `run.terminal` event — trace/evidence owner.
- CC-GAP-5 external watchdog CLI drift — integration owner.

Checklist:

- [ ] Freeze the Elite-6 terminal evidence copy-only: both `run.terminal`
  journal events, lifecycle/stage/process rows with `terminal_status`,
  `local_outcome`, and `processOutcome.code`, the final development-readiness
  gate verdict and its `factory.local-runnability.v1` cause, the task 37
  WorkerExecution row, and the watchdog startup failure record. Record paths
  and digests; preserve the frozen sources immutable.
- [ ] Preserve the terminal Elite-6 run state exactly as terminalized:
  copy-only capture, no replay, restart, status rewrite, event deletion, or
  in-place deduplication.
- [x] CC-GAP-2: make journal `run.terminal` payloads and the tracker/launch
  projections carry `terminal_status`, stage/process local outcome, and the
  final gate verdict alongside operational completion, so a failed product
  outcome cannot render as bare `completed`.
- [x] CC-GAP-3: terminalize the exact WorkerExecution when `worker_done` is
  accepted and the OS pid is dead, emitting `worker.exit`; align with the
  normative synchronization edge "OS worker exits -> terminalize the exact
  WorkerExecution".
- [x] CC-GAP-4: make terminal-event emission idempotent and unique per
  terminalized scope; duplicate emission must be impossible or collapse to
  one effective event. The durable terminal claim is the authority; a
  zero-event journal after a failed append is an honest projection, never a
  defect.
- [x] CC-GAP-5: correct the external watchdog launch flags (`--interval-seconds`,
  not `--interval`) and keep the built-in tracker supervisor explicitly
  classified in coverage records.
- [ ] Add blocking regression proofs, one per gap: failed final gate cannot
  present product success (CC-GAP-2); terminal run leaves zero `running`
  WorkerExecutions (CC-GAP-3); no more than one effective terminal event per
  terminalized scope, with an honest zero-event projection under append
  failure (CC-GAP-4); watchdog starts against the real CLI (CC-GAP-5).
- [ ] Label `delivery.mode=deferred` as the expected early end in every
  status surface; it is neither product failure nor Delivery success.
- [ ] Release the deferred CC-00 harvest regeneration and the deferred CC-10A
  heavy validation runs only after every CC-GAP-2..5 exit criterion passes.

Exit checklist:

- [ ] Status surfaces expose operational and product outcomes as separate
  fields; no surface renders operational completion as product success.
- [ ] A failed final gate verdict cannot present product success anywhere;
  the CC-GAP-2 blocking regression proof is green.
- [ ] The terminal run leaves zero `running` WorkerExecutions and no more than
  one effective terminal event per terminalized scope, with an honest
  zero-event projection under append failure; the CC-GAP-3 and CC-GAP-4
  blocking regression proofs are green.
- [ ] The external watchdog launch is smoke-tested against the real CLI and
  starts; supervisor coverage is recorded with the CC-GAP-5 proof green.
- [ ] Delivery `deferred` is explicitly labeled and not misclassified.
- [ ] Elite-6 terminal evidence is frozen copy-only with recorded paths and
  digests; frozen sources are untouched.
- [ ] The deferred CC-00 harvest and CC-10A runs are released and their
  results recorded.

Gate wiring: K0, K2, K4, and K5 exit evidence is incomplete while any
CC-GAP-2..5 is open. CC-81 must record those gaps and stay RED, and CC-82
must not emit `QUALIFICATION_GREEN`, until this exit checklist is fully
green.

### CC-00C - Elite-6 product-claim integrity closure

- Status: incident record landed 2026-08-22. Integration truth at
  `50824c6a` (HEAD of `cc/CC-00B-terminal-integrity-integration`):
  CC-GAP-6 (`50824c6a`, ADR-088 blocking mutations (a)-(d) proven
  bidirectionally), CC-GAP-8 (`8819e360`, append-only criterion-key
  ledger with blocking mutations (a)-(e)), and CC-GAP-10 (`184b2c77`,
  rendering-only) have LANDED on that integration branch. CC-GAP-7 is
  open (no warrant-execution landing). The CC-GAP-9 repair exists on its
  own branch (`cc/CC-GAP-9-substrate-typed-unknown`: `736621af` +
  `d3026cbe` post-REJECT repair) and is NOT yet integrated. Landing is
  not closure: the CC-00C exit gate has not been re-audited, none of
  these commits is merged to `saga4`, and neither the incident records
  nor this plan is merged — this status line records branch truth only,
  never a claim that CC-00C exited.
- Owner role: integration owner; gap owners named below
- Depends on: CC-00B
- Internal serialization: CC-GAP-9 substrate outcome/routing lands before
  CC-GAP-7 warrant execution — warrant phases must never meet a substrate
  failure without the typed outcome and routing (ADR-089: bounded
  in-check substrate retry, then typed unknown and human_required
  blocked/resumable) already in place — and the CC-GAP-9 RESIDUAL
  (ADR-091 readiness-substrate TOCTOU re-probe) closes before ANY
  production factory run and likewise before CC-GAP-7: a mid-check
  executor/compose failure is classified only by invalidating the cached
  availability probe and mechanically re-probing the daemon (observed
  unavailable/not-linux → the existing ADR-089 bounded retry/typed
  unknown; observed available+linux → a bad image/tag/config/product
  stays product `failed`; no stderr text guessing; compose `down` vs
  invalid config distinct; collapse guard; provider `1.12.0` with digest
  fence and trust migration; obligation compiler pin
  `factory.local-runnability.v1` @ `1.12.0`). Substrate role split
  (ADR-083 boundary note, normative): ADR-083/K19 owns declared/observed/
  authorized environment IDENTITY (`DerivedExecutionEnvironment`,
  `environmentDigest`, image/toolchain implementation digests, and the
  floating-tag prohibition); CC-GAP-9 owns environment AVAILABILITY only
  (bounded in-check retry, typed unknown, human_required
  blocked/resumable — never an identity or authorization decision);
  CC-GAP-7 warrant execution CONSUMES the `environmentDigest` and
  receipt-binds it (the readiness receipt binds the digest it ran
  under), never authorizes environment identity. The K19 image/digest
  remainder (per-package OCI image/dependency digest persistence and the
  ADR-077 keyed `toolchainDigests` component) is sequenced before
  CC-GAP-7 receipt-binding; if it has not landed when CC-GAP-7 starts,
  the honest fallback applies — CC-GAP-7 binds the `environmentDigest`
  the stage-14 derivation core already produces and records honestly
  that image and dependency digest persistence is not yet available;
  never a fabricated digest, never an unauthorized one, never a floating
  tag.
- Objective (SMART): by CC-00C exit, every non-empty versioned Order
  Constraint Register from a new Factory Start is mechanically closed —
  register ids minus union(coveredConstraintIds) minus typed waivers is
  empty, SRS §2.2 module-manifest scope coverage holds
  (register-conditional grandfathering, execution-entrypoint ownership,
  and kernel-only `coveredConstraintIds` derivation per ADR-088), warrant
  execution over `VerificationWarrantRef` classifies substrate failures
  per ADR-089 (bounded deterministic in-check substrate retry, then typed
  unknown `warrant-blocked-environment` and human_required
  blocked/resumable continuation — never product-failed; unknown receipts
  never poison a later pass), deferred verification obligations live in
  an append-only criterion-key accounting ledger (pending survives
  readiness failure and continuation; `executed(failed)` is not
  discharged; only a passed receipt or an operator-attributed waiver
  discharges; stage/order visibility) until executed after readiness
  recovery, and author/reviewer role projections display role on board
  and task-detail surfaces (durable projections untouched)
  (Specific); measured by the per-gap blocking
  regression proofs and mutations, never by prose (Measurable); achieved by
  finishing the landed AC-drift networks 1-2 and the existing
  `VerificationWarrantRef` seam, adding only network-3 warrant phases and
  substrate routing (Achievable); it closes CC-GAP-6..10 by reuse, with no
  parallel deliverable-claim vocabulary (Relevant); bounded by the CC-00C
  exit checklist before CC-10A heavy validation is released (Time-bound).
- Non-goals: reopening or replaying the terminal Elite-6 run; building the
  missing browser frontend inside this package; hardcoding browser, canvas,
  or any frontend specifics into universal engine or test-engine files;
  reclassifying the missing frontend as the observed readiness failure;
  weakening, renaming, or re-scoping acceptance criteria (including AC-22) to
  close gaps; inventing parallel deliverable-claim vocabulary (new claim
  descriptors, new coverage receipts, or a second oracle registry beside the
  existing Order Constraint Register, `coveredConstraintIds`, SRS §2.2
  module-manifest coverage, and `VerificationWarrantRef` seam)
- Incident record:
  `docs/factory-run/conformance-closure/CC-00C-ELITE6-PRODUCT-CLAIM-INTEGRITY.md`
  — the Elite-6 experiment is complete and immutable and product
  qualification failed; the observed readiness failure was substrate
  unavailability (`LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE`, before
  install/test/serve), and the missing browser frontend is a separately
  proven latent product defect. The record documents; the runtime is not
  fixed by it.

Stable gaps and owners:

- CC-GAP-6 semantic claim-to-work coverage — planning owner (execution);
  classification authority originates in Discovery/Formalization. Reuse and
  finish the existing vocabulary — the versioned Order Constraint Register,
  the `coveredConstraintIds` relay, and SRS §2.2 module-manifest scope
  coverage — never a parallel deliverable-claim vocabulary. A
  buildable/integrator acceptance criterion cannot be discharged by nominal
  attachment to a semantically insufficient item; whole-product synthesis
  (install -> start -> accessible running product) requires explicit
  ownership by a bootstrap/static-page/serving integration item or a declared
  equivalent, or planning fails closed with a typed reason. Mechanical exit
  criterion: for a non-empty register, register ids minus
  union(coveredConstraintIds) minus typed waivers equals the empty set, every
  §2.2 manifest-declared file lies inside some frozen item change scope, and
  every entrypoint file declared by an execution-class register entry lies
  inside the frozen change scopes of an item whose kernel-derived
  `coveredConstraintIds` include that same entry — a wide decoy item
  containing the file while covering no such constraint does not satisfy it.
  `coveredConstraintIds` is kernel-derived from frozen criteria; planner
  proposals can neither carry nor forge it. Grandfathering is
  register-conditional (ADR-088): only a corpus with no constraint register
  is grandfathered (empty diff, typed legacy skip, gates green; frozen
  evidence untouched); when a non-empty register exists, missing coverage
  and a missing or file-less SRS §2.2 manifest are typed red, never a
  legacy skip.
- CC-GAP-7 deliverable-aware end-to-end oracle — verification owner; lands
  after CC-GAP-9 outcome/routing. Finish AC-drift network 3 on the existing
  seam: the readiness provider executes warrant phases over the
  `VerificationWarrantRef` (register + dispositions, digest-pinned) through
  package-level, workshop-declared oracle adapters — no new oracle, no
  re-reading of order prose; the certifier diffs its phases against the
  frozen register. A browser-product claim requires
  page/static/canvas/browser-smoke evidence; a generic loopback health
  oracle yields oracle-insufficient — never a pass and never a
  product-failed verdict.
- CC-GAP-8 verification reachability/accounting — coverage/report owner.
  Proposed required verification obligations may be deferred but never
  vanish from accounting: implement an append-only criterion-key
  accounting ledger — one first-class entry per required verification
  obligation keyed by criterion, transitions appended
  (`proposed -> pending -> executed(passed|failed) | unknown | waived`),
  entries never rewritten or deleted. A pending entry survives readiness
  failure and lifecycle continuation and must execute after recovery.
  `executed(failed)` is not discharged — the obligation stays outstanding.
  The sole discharge paths are a passed receipt or an operator-attributed
  waiver. Every entry carries and displays its stage and order
  coordinates. Do not reuse the lifecycle transition obligation ledger for
  this role — verification accounting is a separate seam.
- CC-GAP-9 substrate failure classification/recovery — execution-kernel
  owner; lands before CC-GAP-7 warrant execution. Implement the
  `warrant-blocked-environment` contract per ADR-089: a missing
  environment precondition (for example Docker unavailable) gets bounded
  deterministic in-check substrate retry (frozen attempt bound and
  schedule; no model, no WorkerExecution, no CandidateSet, no repair
  epoch, no worker repair budget consumed); when the bound is exhausted,
  the check emits a typed unknown outcome (`warrant-blocked-environment`)
  — never passed, never failed — and the scope routes to a human_required
  blocked/resumable continuation (a truthful typed wait with a wake
  source). A substrate condition alone never produces terminal product
  failure; product-failed, oracle-insufficient, and substrate-unavailable
  remain distinct typed classes; an earlier unknown receipt never
  prevents, fails, annotates, or counts against a later pass of the same
  criterion. Legacy records are grandfathered, never reclassified.
  RESIDUAL (ADR-091, closes before any production factory run and before
  CC-GAP-7): the mid-check TOCTOU window — on executor/compose failure,
  invalidate the cached availability probe and mechanically re-probe;
  only an observed unavailable/not-linux re-probe routes into the
  ADR-089 bounded retry/typed unknown, an observed available+linux
  re-probe leaves a bad image/tag/config/product product `failed`, no
  stderr text guessing, compose `down` vs invalid config distinct,
  collapse guard, provider `1.12.0` with digest fence and trust
  migration, obligation compiler pin `factory.local-runnability.v1` @
  `1.12.0`.
- CC-GAP-10 role projection clarity — trace/evidence owner. The defect is
  rendering-only: the durable author/reviewer projections are correct
  (tasks 15-25/26-36 are author and reviewer projections over the same 11
  Workplace refs in one sealed graph — not duplicate implementations and
  not rematerialization). Board and task-detail surfaces must display the
  role (author vs reviewer) alongside the shared Workplace identity, so
  reviewer projections cannot be misread as duplicate work. No
  deduplication and no data rewrite: the durable projections and the
  sealed graph are untouched.

Checklist:

- [ ] Freeze the Elite-6 product-claim evidence copy-only: the formalized
  acceptance-criteria set including AC-22, the planner task graph (tasks
  15-25 implementation projections and tasks 26-36 reviewer projections over
  the same 11 Workplace refs; one sealed graph; 11 integration commits), the
  22 proposed verificationItems, the readiness manifest declaring
  node:20-alpine Docker, and the `LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE`
  failure record. Record paths and digests; preserve the frozen sources
  immutable.
- [x] CC-GAP-6: finish semantic claim-to-work coverage on the existing
  vocabulary, inventing no parallel deliverable-claim terms: classification
  authority originates in Discovery/Formalization — the versioned Order
  Constraint Register plus `coveredConstraintIds` coverage plus SRS §2.2
  module-manifest scope coverage — and the planner only inherits the frozen
  classification and fails closed. Mechanical exit criterion: for a
  non-empty register, register ids minus union(coveredConstraintIds) minus
  typed waivers equals the empty set, every §2.2 manifest-declared file
  lies inside some frozen item change scope, and every entrypoint file
  declared by an execution-class register entry lies inside the frozen
  change scopes of an item whose kernel-derived `coveredConstraintIds`
  include that same entry — a wide decoy item containing the file while
  covering no such constraint must not satisfy it; a buildable/integrator
  criterion with no whole-product synthesis owner
  (bootstrap/static-page/serving entrypoint or declared equivalent) fails
  planning admission with a typed reason. Enforce register-conditional
  grandfathering (ADR-088): only a corpus with no constraint register is
  grandfathered (empty diff, typed legacy skip, gates green); when a
  non-empty register exists, missing coverage (a non-empty reverse diff)
  and a missing or file-less §2.2 manifest are typed red, never a legacy
  skip. Make `coveredConstraintIds` strictly kernel-derived from frozen
  criteria so planner output can neither propose nor forge it; frozen
  evidence is untouched. (LANDED on the integration branch at `50824c6a`
  — reverse diff, register-conditional §2.2 red, entrypoint-ownership
  conjunction, kernel-only relay, and blocking mutations (a)-(d) proven
  bidirectionally; landing is not exit.)
- [ ] CC-GAP-9 (before CC-GAP-7 warrant execution, per ADR-089): a
  substrate-unavailable readiness failure first gets bounded deterministic
  in-check substrate retry (frozen attempt bound and schedule; no model,
  no WorkerExecution, no CandidateSet, no repair epoch, no worker repair
  budget consumed); on exhaustion the check emits the typed unknown
  `warrant-blocked-environment` outcome — never passed, never failed —
  and the scope routes to a human_required blocked/resumable continuation
  (a truthful typed wait with a wake source), never directly to
  `complete-failed` terminal product failure; product-failed,
  oracle-insufficient, and substrate-unavailable remain distinct typed
  classes; an earlier unknown receipt never poisons a later pass of the
  same criterion; legacy records are grandfathered, not reclassified.
  Scope boundary (ADR-083 split): CC-GAP-9 owns environment AVAILABILITY
  only; environment identity stays with ADR-083/K19. (Implementation
  EXISTS at `736621af` + `d3026cbe` post-REJECT repair on
  `cc/CC-GAP-9-substrate-typed-unknown` — NOT yet integrated; integration
  plus re-audit remains open.)
- [ ] CC-GAP-9 residual (ADR-091 readiness-substrate TOCTOU re-probe;
  closes BEFORE any production factory run and BEFORE CC-GAP-7 warrant
  execution): on a mid-check executor/compose failure, invalidate the
  cached docker availability cache and mechanically re-probe the daemon
  with the existing bounded probe; classification rides ONLY the observed
  re-probe result — observed unavailable (probe failure observes
  unavailable) or not-linux routes into the EXISTING ADR-089 bounded
  in-check substrate retry and, on exhaustion, the typed unknown
  `warrant-blocked-environment` outcome plus human_required
  blocked/resumable continuation (never product-failed); observed
  available+linux leaves a bad image/tag (`LOCAL_RUNNABILITY_DOCKER_PULL_FAILED`),
  an invalid compose config, or a failing product install/test/serve
  command product `failed` (never re-routed to unknown, never retried as
  substrate, never engine-waived). NO stderr text guessing: the failed
  command's stderr is recorded as human-facing detail only and no
  implementation may classify — in whole or in part — by matching,
  regexing, or interpreting stderr text. Compose truth: `down` is
  best-effort with no outcome (a failed `down` after a passed `up`
  leaves the pass green; a failed `down` after a failed `up` never masks
  the up failure or its class); an invalid `compose config` with the CLI
  present and the daemon observed healthy is product `failed`; ENOENT
  CLI-missing stays `LOCAL_RUNNABILITY_COMPOSE_UNAVAILABLE`. Collapse
  guard: product-failed, oracle-insufficient, and substrate-unavailable
  stay distinct typed classes on every surface and route. Provider pin:
  the local-runnability check provider version pins `1.12.0` (this
  branch `1.10.0`; the unintegrated CC-GAP-9 landing `1.11.0`; this
  residual lands as `1.12.0` on top), the `trusted_providers` row
  migrates with the trustworthy baseline extended (`1.11.0` before
  `1.12.0`) and trust basis `built-in:<provider digest>` intact, the
  receipt digest fence (provider id + provider digest) stands, and the
  obligation compiler pins `factory.local-runnability` at `1.12.0`
  (protection `factory.local-runnability.v1` @ `1.12.0`). Blocking
  mutations (ADR-091 exit tests, wired into CC-10B/CC-80): (a)
  daemon-death-mid-check + observed-unavailable re-probe yields the
  ADR-089 path — routing it to product `failed` is red; (b) the same
  failing step with an observed available+linux re-probe stays product
  `failed` — routing it to unknown/substrate is red; (c) daemon-shaped
  stderr paired with an observed available+linux re-probe classifies
  product `failed`, and clean stderr paired with an observed unavailable
  re-probe classifies substrate — any stderr-sensitive routing is red;
  (d) routing every executor/compose failure to unknown (or all to
  `failed`) fails classification (collapse guard); (e) the compose
  down/config truths above; (f) the version/digest fence at `1.12.0`
  (a receipt from a foreign provider digest or an unmigrated trust row
  is rejected).
- [ ] CC-GAP-7 (after CC-GAP-9 outcome/routing): land warrant execution over
  the existing `VerificationWarrantRef` seam in the readiness provider
  through package-level, workshop-declared oracle adapters — no new oracle,
  no re-reading of order prose, no universal engine or test-engine frontend
  branches: a browser-product claim requires
  page/static/canvas/browser-smoke evidence, and a generic loopback health
  oracle must yield oracle-insufficient for it — never a pass and never a
  product-failed verdict. Receipt-binding duty (ADR-083 split): warrant
  execution CONSUMES the `environmentDigest` and receipt-binds it (the
  readiness receipt binds the digest it ran under); it never authorizes
  environment identity. The K19 image/digest remainder is sequenced before
  this receipt-binding, with the honest fallback recorded in the internal
  serialization above if it has not landed. (OPEN — no warrant-execution
  landing.)
- [x] CC-GAP-8: implement append-only criterion-key verification
  accounting: proposed but unmaterialized verification obligations become
  first-class ledger entries keyed by criterion, with owner and unblock
  condition, visible as pending; entries survive readiness failure and
  lifecycle continuation; transitions append
  `proposed -> pending -> executed(passed|failed) | unknown | waived`;
  `executed(failed)` does not discharge; only a passed receipt or an
  operator-attributed waiver discharges; every entry displays its stage
  and order coordinates; the lifecycle transition obligation ledger is
  not reused for this role. (LANDED on the integration branch at
  `8819e360` — module-local criterion-key ledger, trigger-enforced
  append-only, integrity guard, blocking mutations (a)-(e); landing is
  not exit.)
- [x] CC-GAP-10: make role projections distinguishable — the defect is
  rendering-only (the durable author/reviewer projections are correct):
  board and task-detail surfaces expose author versus reviewer role for
  tasks sharing one Workplace ref, so reviewer projections are not misread
  as duplicate implementation work or graph rematerialization; no
  deduplication and no data rewrite of the durable projections or the
  sealed graph. (LANDED on the integration branch at `184b2c77` —
  rendering-only; landing is not exit.)
- [ ] Add universal scenario DSL vocabulary without workshop-specific
  frontend hardcoding, reusing existing terms instead of inventing parallel
  deliverable-claim vocabulary: order-constraint register coverage facts
  (register ids, `coveredConstraintIds`, typed waivers); warrant-execution
  facts over `VerificationWarrantRef` (executed line, outstanding human
  line, waived line with provenance); the three distinct outcome classes
  product-failed, oracle-insufficient, and substrate-unavailable (ADR-089
  routing facts: bounded in-check substrate retry, typed unknown
  `warrant-blocked-environment` on exhaustion, human_required
  blocked/resumable continuation, unknown receipts never poisoning a
  later pass); append-only criterion-key verification accounting entries
  (proposed -> pending -> executed(passed|failed) | unknown | waived;
  `executed(failed)` not discharged; discharge only by passed receipt or
  operator-attributed waiver; stage/order visibility); role-projection
  facts (author vs reviewer over shared Workplace refs). Browser/canvas
  specifics arrive only
  through workshop-declared package data (register lines and package-level
  oracle adapters), never engine branches.
- [ ] Add blocking regression proofs, one per gap: dropping whole-product
  synthesis ownership — an uncovered non-waived register line behind a
  nominally attached criterion — fails planning admission on the mechanical
  diff; with a non-empty register, a missing or file-less §2.2 manifest is
  typed red (never a legacy skip), a wide decoy item containing an
  execution entrypoint file without covering that constraint fails
  ownership, and a planner proposal carrying `coveredConstraintIds` cannot
  alter the kernel-derived relay (CC-GAP-6, per ADR-088); routing
  substrate failure to terminal product failure,
  collapsing product-failed/oracle-insufficient/substrate-unavailable
  into one outcome, skipping the bounded in-check retry straight to
  escalation or terminalization, charging an exhausted retry to worker
  repair budget or CandidateSets, or letting an earlier unknown receipt
  prevent or fail a later passed receipt for the same criterion (poison)
  fails routing/classification (CC-GAP-9, per ADR-089, proven before
  CC-GAP-7); substituting loopback health for the package-level browser
  oracle yields
  oracle-insufficient, and rendering it as pass or as product-failed fails
  verification (CC-GAP-7, after CC-GAP-9); rendering deferred verification
  as discharged, rendering `executed(failed)` as discharged, dropping a
  pending entry across readiness failure or continuation, discharging
  without a passed receipt or an operator-attributed waiver, or hiding
  stage/order coordinates fails accounting (CC-GAP-8); rendering reviewer
  projections as duplicate implementation, or a board/detail surface that
  omits the role, fails projection (CC-GAP-10).
- [ ] Record the missing browser frontend (client renderer/hud/effects
  modules exist, but no index.html, no DOM/canvas use, no static serving
  route, no npm start; the server exposes only healthz and 404) as a
  separately proven latent product defect with its own remediation path (a
  new change request or continuation), distinct from the substrate readiness
  failure.
- [ ] Record the Elite-6 dynamic-pricing latent defect as BOTH
  idea-conservation and product behavior evidence (sixth-pass correction,
  ADR-090 Context): the exact pricing algorithm was UNKNOWN at Discovery
  (a genuine proposal unknown that died unconsumed —
  `DiscoveryProposalPayload.unknowns` opacity), and the shipped frozen
  product carried `basePrice` constants with argument-level tests that did
  NOT prove per-system pricing variation — a latent product behavior
  defect of the same shape. It is recorded as evidence only: NO new
  runtime token is created for it (it is covered by the ADR-090
  open-question and mechanics obligations,
  `formalization.unknowns-owned` and
  `formalization.mechanics-spec-required`), the frozen Elite-6 product is
  NOT rewritten, and its remediation path is a new change request or
  continuation, never a CC-00C runtime scope item.

Exit checklist:

- [ ] For every non-empty versioned Order Constraint Register, the
  mechanical reverse diff (register ids minus union(coveredConstraintIds)
  minus typed waivers) is empty, SRS §2.2 module-manifest scope coverage
  holds — a missing or file-less §2.2 manifest is typed red, never a
  legacy skip — every execution-class entrypoint file is owned by an item
  whose kernel-derived `coveredConstraintIds` include that same constraint
  (no wide decoy item satisfies it), and whole-product synthesis ownership
  is explicit where a criterion requires it; only registerless corpora are
  grandfathered with typed skips, planner output cannot forge
  `coveredConstraintIds`, and frozen evidence is untouched; the CC-GAP-6
  blocking proof is green.
- [ ] Substrate unavailability gets bounded deterministic in-check retry,
  then the typed unknown `warrant-blocked-environment` outcome and a
  human_required blocked/resumable continuation — never a deterministic
  repair round, never unbounded silent retry, never terminal product
  failure (ADR-089); product-failed, oracle-insufficient, and
  substrate-unavailable remain distinct typed outcomes; an exhausted
  retry consumes no worker repair budget and creates no CandidateSet; an
  earlier unknown receipt never poisons a later pass of the same
  criterion; legacy records are grandfathered, and the CC-GAP-9 blocking
  proof is green and landed before CC-GAP-7 warrant execution.
- [ ] The CC-GAP-9 residual (ADR-091) is closed BEFORE any production factory run
  and before CC-GAP-7 warrant execution: a mid-check executor/compose
  failure is classified by a mechanical re-probe of the invalidated
  availability cache (observed unavailable/not-linux → the existing
  ADR-089 bounded retry/typed unknown path; observed available+linux → a
  bad image/tag/config/product stays product `failed`); no
  classification reads stderr text; compose `down` stays best-effort and
  distinct from invalid config; the three outcome classes never collapse;
  the provider pins `1.12.0` with the digest fence and trust migration
  intact and the obligation compiler pins
  `factory.local-runnability.v1` @ `1.12.0`; the ADR-091 blocking
  mutations (a)-(f) are green and wired into CC-10B/CC-80.
- [ ] Warrant execution consumes the `VerificationWarrantRef` through
  package-level oracle adapters only; a generic loopback health oracle
  yields oracle-insufficient for a browser-product claim — never a pass and
  never a product-failed verdict — and CC-GAP-9 outcome/routing landed
  first; the CC-GAP-7 blocking proof is green.
- [ ] Verification accounting is an append-only criterion-key ledger:
  deferred obligations remain first-class pending until executed after
  readiness recovery, pending survives readiness failure and continuation,
  `executed(failed)` is not discharged, nothing is discharged without a
  passed receipt or an operator-attributed waiver, entries carry
  stage/order visibility, and the lifecycle transition obligation ledger
  is not reused; the CC-GAP-8 blocking proof is green.
- [ ] Author/reviewer role is displayed on board and task-detail surfaces
  for tasks sharing one Workplace ref; the durable projections and the
  sealed graph are untouched — no deduplication, no data rewrite
  (rendering-only, CC-GAP-10); the CC-GAP-10 blocking proof is green.
- [ ] Elite-6 product-claim evidence is frozen copy-only with recorded paths
  and digests; frozen sources are untouched.
- [ ] The Elite-6 experiment remains complete and immutable, product
  qualification is recorded as failed, and the two causes (substrate
  readiness failure; latent missing-frontend defect) are kept distinct in
  every record.

Gate wiring: K0, K2, K4, K5, and K8 exit evidence is incomplete while any
CC-GAP-6..10 is open. CC-80 cannot compose a complete qualification command,
CC-81 must record those gaps and stay RED, and CC-82 must not emit
`QUALIFICATION_GREEN`, until this exit checklist is fully green.

### CC-10A - Provisional v1 CI ratchet

- Owner role: CI and claims owner
- Depends on: CC-00, CC-00B, and CC-00C (code may land after CC-00 and
  remain; exit requires CC-00B and CC-00C)
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
- [ ] CC-00B is closed; the deferred heavy validation it releases (the CC-00
  harvest regeneration and the three fresh-environment runs above) is
  complete.
- [ ] CC-00C is closed; no CC-GAP-6..10 remains open, and its product-claim
  blocking proofs are green.

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
- [ ] Include the CC-00C product-claim-integrity blocking mutations in the
  blocking group: constraint-register coverage (coveredConstraintIds reverse
  diff plus SRS §2.2 module-manifest scope coverage, register-conditional
  grandfathering, execution-entrypoint ownership, and kernel-only
  coveredConstraintIds derivation per ADR-088), warrant execution over
  `VerificationWarrantRef` through package-level oracle adapters,
  append-only criterion-key verification accounting (pending survival,
  executed(failed)-not-discharged, passed-receipt-or-waiver discharge,
  stage/order visibility), substrate outcome/routing per ADR-089 (bounded
  in-check substrate retry; typed unknown `warrant-blocked-environment`
  on exhaustion; human_required blocked/resumable; no-poison of later
  passes; never product-failed), the CC-GAP-9 RESIDUAL substrate TOCTOU
  re-probe per ADR-091 with its blocking mutations (a)-(f) — (a) observed
  unavailable re-probe routes into the ADR-089 path (never product
  `failed`); (b) observed available+linux re-probe keeps a bad
  image/tag/config/product product `failed` (never unknown); (c) no
  stderr-sensitive classification; (d) collapse guard; (e) compose
  `down`/invalid-config truths; (f) the provider `1.12.0` pin with the
  digest fence and trust migration (obligation compiler pin
  `factory.local-runnability.v1` @ `1.12.0`) — RED in this group until
  the ADR-091 residual lands, and role projection (board/detail role
  display, rendering-only) (CC-GAP-6..10
  wiring).
- [ ] The idea-authority-conservation blocking mutations are a MANDATORY
      part of this group (ADR-090):
      open-question count integrity (every proposal unknown is a register
      entry), open-question disposition closure (resolved; deferred with
      reason, owner, and unblock criterion; or waived with trusted
      operator attribution — any author-attributed waiver, single or en
      masse, is red; no undefined mass-waiver concept), RULE
      mechanics binding (established at disposition time against the
      accepted RULE artifact), deterministic runnable-local synthesis/smoke
      injection, typed measurability on qualitative/experience entries,
      new-v2-start non-null typed authority (never a silent null
      register; continuations inherit the original ref), and the
      advisory-archaeologist
      non-authority mutation. Until CC-IC-1..4 are implemented and these
      mutations are proven green, this group cannot pass: record the
      unproven CC-IC set as an open mandatory dependency (RED), never as
      satisfied or skipped (CC-IC-1..4 wiring).
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

## 7A. Idea Authority Conservation packets (ADR-090)

Program: Idea Authority Conservation, governed by ADR-090 and correcting
the proposed A–G package of the external Elite-6 idea-traceability
post-mortem (produced in the Elite-6 product repository; not a repository
artifact here and never a citation — the durable in-repo evidence is
CC-00B/CC-00C plus production source/tests, and ADR-090 records the A–G
proposal in substance). The ADR carries the corrected diagnosis: the full
Discovery payload rides into Formalization, FR-9/SRS retained
browser/canvas/smoke, and AC-22 existed as a normative acceptance
criterion (install -> start -> accessible running game) — what was
under-typed is whole-product synthesis ownership, task binding, anchors,
and the end-to-end oracle around that existing criterion, and the
proposal unknowns are opaque, unconsumed `string[]` (the Elite-6
dynamic-pricing unknown is recorded as BOTH idea-conservation and
product behavior evidence: the exact pricing algorithm was unknown at
Discovery, and the shipped frozen product's `basePrice` constants with
argument-level tests did not prove per-system variation — a latent
product defect covered by the open-question and mechanics obligations
only; no new runtime token; the frozen product is not rewritten). This
is a
bounded packet set with an explicit finish condition — not a standing
parallel implementation program.

- Status: ADR-090 Accepted 2026-08-22; CC-IC-1..4 not started
  (documentation only); the CC-GAP-6 seam is integrated (`50824c6a`) and
  repairs the v1 read-back verifier IN SOURCE, tested there for
  round-trip identity and digest tamper — the id-reorder
  (`ORDER_CONSTRAINT_REGISTER_ID_MISMATCH`) and snake_case-at-verify
  typed-rejection reds are NOT yet tested, so the CC-IC-1 prerequisite
  (m0) is landed-in-source with an explicit residual base-verification
  obligation, not work to duplicate or re-implement; the proof-subset
  landing `3be7393d` (same integration branch) already corrected the
  `frm.submission.acceptance-contract` direction (v2.1.0
  uncovered-residue form) and the SRS §D2↔AC residues — verify-only for
  CC-IC-4, which adds only the SRS register-coverage residue constraint;
  the v2 vocabulary work remains open
- Owner roles: named per packet below; all packets ride the single-writer
  `Constraint register and warrant seam` row (section 4.3)
- Depends on: CC-GAP-6 exit (the four ADR-088 blocking mutations green;
  the seam's register code integrated at `50824c6a`); CC-IC-1 additionally
  contained a PREREQUISITE repair stage (the v1 read-back verifier
  `verifyOrderConstraintRegister`) whose SOURCE repair is already landed
  by that integrated landing, with round-trip and digest-tamper tests
  green in `tests/discovery/order-constraint-register.test.mjs` — CC-IC-1
  verifies its presence at the base, ADDS the missing id-reorder and
  snake_case-at-verify verification (its residual base-verification
  obligation), and builds any v2 field on the repaired
  verifier; CC-IC-2 and CC-IC-3
  depend on CC-IC-1; CC-IC-4 depends on CC-IC-1..3
- Objective (SMART, ADR-090): by CC-IC exit, for every new Factory Start
  under the v2 vocabulary (each carrying non-null typed authority — a
  built register, or an explicit typed no-obligations attestation if the
  architecture truly permits an obligation-free order; never a silent
  null), each of five blocking
  mutations — (m1) a proposal unknown absent from the register's
  open-question entries; (m2) an open-question entry without a
  resolved-or-deferred disposition (reason, owner, and unblock criterion)
  or a loud per-entry operator-attributed waiver; (m3) a mechanics-bearing
  constraint whose RULE binding is removed or
  untrace-bound; (m4) a runnable-local lifecycle
  classification without the injected whole-product-synthesis and
  ordered-smoke obligations; (m5) a qualitative/experience entry without
  a measurable interpretation or typed deferral — turns the blocking
  group red when reversed, and a frozen legacy registerless (v1) corpus
  stays green. Measured solely
  by the compiled obligation-contract mutants and the blocking acceptance
  group, never by prose. This goal explicitly does not promise semantic
  perfection: extraction quality remains the Discovery assessor's boundary
  and the archaeologist is advisory (ADR-084 honest proof boundary —
  conservation of the counted typed set, not semantic completeness of
  free-text extraction or truthfulness of tagging).
- Non-goals: any parallel scope-clause or unknown ledger; any new
  mechanics-spec product family beside RULE/SPEC; any gating or
  authority-mutating LM archaeologist; any second obligation registry
  beside the ADR-084 AcceptanceObligationContract family; editing frozen
  Elite-6 evidence; changing the registerless grandfather behavior for
  frozen legacy v1 corpora (ADR-088 sole grandfather condition), or
  widening null-binding grandfathering to new v2 starts; requiring an
  at-Discovery `mechanicsRef` (the RULE artifact does not exist yet)

### CC-IC-1 - Register v2 vocabulary at Discovery settlement

- Owner role: discovery settlement owner (execution-kernel seam, serialized
  through the single-writer row)
- Depends on: CC-GAP-6 exit (seam integrated at `50824c6a`); the v1
  read-back verifier repair below is a PREREQUISITE stage of this packet
  whose SOURCE repair is ALREADY LANDED by that integrated landing
  (round-trip and digest-tamper tests green in
  `tests/discovery/order-constraint-register.test.mjs`; the id-reorder
  and snake_case-at-verify reds remain the packet's explicit
  base-verification work) — this packet
  VERIFIES the repaired verifier is present at its base and CLOSES that
  residual verification, never duplicates
  or re-implements it, before
  any v2 schema field is added to `src/shared/constraint-register.ts`
- Editable files: `src/shared/constraint-register.ts`;
  `src/modules/discovery/domain/discovery-proposal.ts` LIMITED to the
  worker-facing v2 draft carrier/validator (the closed `kind` vocabulary
  check at the Discovery submission boundary, beside the existing
  fail-closed `class`/`text`/`evidence_ref`/`entrypoint_files` checks in
  `validateDiscoveryProposal` — no other proposal-shape change);
  `src/modules/discovery/application/discovery-production-cell-installation.ts`
  (open-question lifting from the payload `unknowns` and read-only
  injection-table consumption at the existing settlement register site);
   `src/process-modules/lifecycles/product-build-lifecycle.ts` LIMITED to
   the declared, digest-pinned injection table beside the frozen
   `runnable-local` terminal classification (data declaration only — no
   engine inference, no workshop-name branch);
   `src/process-modules/persistence/sqlite-lifecycle-run-repository.ts`
   LIMITED to the typed `readDefinitionByProcessRun` join/read ONLY (the
   `ctx.processRunId` → `factory_stage_runs.process_run_id` →
   `lifecycle_run_id` → pinned `factory_lifecycle_runs`
   `definition_snapshot` + `definition_hash` read the wiring path below
   prescribes — no other repository surface changes);
   `src/app/product-lifecycle-runtime.ts` and
   `src/app/composition-root.ts` LIMITED to DI/composition of that ONE
   typed port (injecting the pinned-read repository into Discovery
   settlement; no other composition or registration change — same
   single-writer row, section 4.3); register binding
   pass-through in
  `src/modules/formalization/domain/formalization-schemas.ts`;
  `src/modules/formalization/application/formalization-production-cell-installation.ts`
  (settlement-side consumption of the case register binding and construction
  of the cross-bound `warrantRef`); `src/modules/development/domain/development-schemas.ts`
  LIMITED to adding cross-bind fields on `VerificationWarrantRef` (same
  single-writer row; the ADR-088 relay semantics carried by that file stay
   unchanged); the NAMED mutation-host suites (the mutations do NOT all
   live in one host): `tests/discovery/order-constraint-register.test.mjs`
   (m0 residual verification; m1 with `tests/matrix/e-constraint-loss.test.mjs`;
   m4a; m5), `tests/matrix/e-constraint-loss.test.mjs` (m1, m6b), the new
   `tests/discovery/d7-settlement-lifecycle-classification.test.mjs` (m4,
   m4a, m6), `tests/architecture/product-build-lifecycle.test.mjs` (m4,
   m4a), `tests/discovery/d4-settlement-recovery.test.mjs` (m6a), and
   `tests/process-modules/formalization-warrant-ref.test.mjs` (m7), plus
   the `tests/process-modules/*constraint*` fixtures touched by v2
- Read-only files: planner schemas (relay semantics already frozen by
  ADR-088); all frozen Elite-6 evidence
- Explicit non-goals: no change to networks 1-3 enforcement semantics; no
  planner-side vocabulary; no LM call inside settlement

Prerequisite repair — v1 read-back verification (SOURCE repair landed by
the integrated CC-GAP-6 landing `50824c6a`; CC-IC-1 verifies and closes
the residual id-reorder/snake_case-at-verify verification, never
re-implements):

- [x] `verifyOrderConstraintRegister` in
       `src/shared/constraint-register.ts` is REPAIRED IN SOURCE by the
       integrated CC-GAP-6 commit `50824c6a` (source repair landed —
       do NOT duplicate or re-implement it in any CC-IC packet; see the
       next item for the residual verification obligation). Recorded
       production defect, now closed in source: the
       function fed a PERSISTED register (canonical camelCase
       `OrderConstraintEntry[]` — `evidenceRef`) into
       `buildOrderConstraintRegister`, which validates the worker-facing
       snake_case DRAFT shape (`evidence_ref`), so verifying any genuine
       persisted v1 register threw `ORDER_CONSTRAINT_EVIDENCE_REF_REQUIRED`;
       it was dead code (no production caller) with no test. The integrated
       repair validates the canonical entry shape
       (id/class/text/evidenceRef, plus execution-class entrypointFiles)
       directly in the verifier and re-pins the digest and the positional
       `ord-c-NNN` ids. TEST TRUTH at `50824c6a`
       (`tests/discovery/order-constraint-register.test.mjs`, sixth-pass
       verification): build -> verify round-trip identity and digest
       tamper -> `ORDER_CONSTRAINT_REGISTER_DIGEST_MISMATCH` are GREEN;
       the id-reorder red (`ORDER_CONSTRAINT_REGISTER_ID_MISMATCH`,
       which the repaired source already throws) and the
       snake_case-draft-row-at-verify typed rejection are NOT yet tested
       there. Every "v1 registers verify (unchanged / in CI /
       round-trip)" statement in ADR-090 and this plan leans on that
       repaired path and on the CC-IC-1 base-verification item below.
- [ ] CC-IC-1 BASE VERIFICATION (explicit packet work, not a
       re-implementation): at packet start, verify the integrated source
       repair is present at the CC-IC-1 base (rebase point at or after
       `50824c6a`) and the round-trip and digest-tamper tests are green
       there; then ADD the two missing verification cases to
       `tests/discovery/order-constraint-register.test.mjs` (the named
       CC-IC-1 test host for the verifier): (a) id reorder ->
       `ORDER_CONSTRAINT_REGISTER_ID_MISMATCH`, and (b) a snake_case
       draft row arriving at the verify boundary is a typed rejection,
       never a silent reinterpretation. Record the exact base SHA. No
       CC-IC commit re-implements, rewrites, or re-derives the v1
       verifier; this item only closes its residual verification
       obligation.

Checklist:

- [ ] Extend the register schema additively to
      `factory.order-constraint-register.v2`: PRESERVE the closed
      source-class vocabulary unchanged (`execution|material|human` —
      `open-question` is NOT a class and the class vocabulary is not
      overloaded) and add the orthogonal per-entry `kind` vocabulary
      (`scope|open-question|mechanics|synthesis|ordered-smoke|quality`);
      add typed `measurability` binding ONLY qualitative/experience
      (kind `quality`) entries (`measurable` + interpretationRef, or
      `deferred` + reason); add per-entry
      `lifecycleSynthesis` declarations consumed only from the
      frozen lifecycle classification.
- [ ] Kind carrier/validator and the default/legacy boundary: the
      worker-facing draft carrier is `src/modules/discovery/domain/discovery-proposal.ts`
      (`validateDiscoveryProposal`) — a draft row carrying a `kind` MUST
      carry one of the six closed values, and anything else is a typed
      submission error at the same boundary that already checks
      `class`/`text`/`evidence_ref`/`entrypoint_files` fail-closed; the
      register builder (`src/shared/constraint-register.ts`) repeats the
      check fail-closed. A kind-less v1-shaped draft row under a NEW v2
      settlement is defaulted deterministically to kind `scope`
      (kernel-side assignment, no guessing, no prose rereading); the
      specialization kinds are explicit declarations or kernel drafts
      (open-question from payload `unknowns`, synthesis/ordered-smoke from
      the declared injection table). LEGACY BOUNDARY: frozen legacy v1
      drafts and registers carry no `kind`, verify unchanged under the v1
      schema (absence of `kind` on v1 data is not a defect), and the
      deterministic default applies only to new v2 settlements.
- [ ] Draft kind `open-question` entries 1:1 and positionally from
      `DiscoveryProposalPayload.unknowns` (declared in
      `src/modules/discovery/domain/discovery-domain-contracts.ts`,
      mirrored in the worker-facing shape in
      `src/modules/discovery/domain/discovery-proposal.ts`) — the lifting
      owner is the settlement register site in
      `src/modules/discovery/application/discovery-production-cell-installation.ts`,
      which already reads the same `payload_snapshot` to call
      `buildOrderConstraintRegister` on `order_constraints`; the drafted
      rows enter through `buildOrderConstraintRegister`
      (`src/shared/constraint-register.ts`) — kernel-side, deterministic,
      no guessing, no prose rereading (the builder's existing no-guess
      rule). (text = the unknown string;
      evidenceRef = the payload field.)
- [ ] `runnable-local` is the frozen lifecycle classification
       (`product-build-lifecycle.ts` verified terminal): the injection is
       realized by a DECLARED, DIGEST-PINNED injection table OWNED BY
       `src/process-modules/lifecycles/product-build-lifecycle.ts` — an
       immutable, versioned, content-addressed data declaration declared
       beside the frozen classification (the lifecycle that freezes the
       classification owns its injection declaration — data, not engine
       inference), mapping the frozen
       classification to the exact injected entry payloads (kind `synthesis`
       and kind `ordered-smoke`), consumed READ-ONLY by Discovery settlement
       (`src/modules/discovery/application/discovery-production-cell-installation.ts`),
        cited by digest from the settlement record.
        LIFECYCLE-CLASSIFICATION WIRING PATH (sixth-pass correction): the
        classification reaches Discovery settlement ONLY through the pinned
        per-run read — `ctx.processRunId` → join
        `factory_stage_runs.process_run_id` → `lifecycle_run_id` → read
        the pinned `factory_lifecycle_runs` `definition_snapshot` +
        `definition_hash` through a typed `readDefinitionByProcessRun`
        port/repository implemented in
        `src/process-modules/persistence/sqlite-lifecycle-run-repository.ts`,
        injected through `src/app/product-lifecycle-runtime.ts` /
        `src/app/composition-root.ts` (the ambient
        `options.lifecycleDefinition ?? productBuildLifecycle` default is
        NOT the normative wiring and is never a substitute for the pinned
        read). Discovery settlement consumes the pinned classification +
        `definitionHash` read-only; a missing row fails closed with a
        typed error — never a default `lifecycleDefinition`, never an
        ambient fallback; and Discovery imports no lifecycle internals
        (no lifecycle module import: the classification arrives only
        through the injected pinned read, so no engine or settlement
        code re-derives the classification from prose, workshop
        identity, or a default binding); the dedicated test host
        `tests/discovery/d7-settlement-lifecycle-classification.test.mjs`
        proves the wiring (new suite);
        the register never carries browser/canvas/frontend specifics that did
       not arrive through workshop-declared data (Conveyor Mental Model §3;
       master plan §4 no-workshop-branch rule). NORMATIVE INTERLEAVE ORDER:
       proposal-derived entries occupy `ord-c-001..NNN` in payload order,
       injected entries are APPENDED AFTER them in the declared table order
       (whole-product-synthesis first, then ordered-smoke) — never interleaved
       among proposal-derived rows — so proposal-derived positional ids stay
       stable when the injection table revision changes, and any reordering
       changes the registerDigest (an honest revision, never an in-place
       shuffle). Ad-hoc table reconstruction or a different interleave order
       is a digest change and fails the m4a mutation below.
- [ ] Digest semantics: v2 typed fields are entry content — adding them
       produces a new registerDigest (an honest revision, never an in-place
       mutation); v1 registers verify unchanged under their schema version
       THROUGH THE REPAIRED read-back verifier of the prerequisite stage
       (source repair integrated at `50824c6a` with round-trip and
       digest-tamper tests green; the recorded broken dead-code path above
       is closed history; the id-reorder and snake_case-at-verify reds are
       added by the CC-IC-1 base-verification item, and every v2 claim
       leans on that repaired, fully verified baseline).
- [ ] New v2 starts never silently build a null register: null-binding
      grandfathering applies only to frozen legacy v1 corpora (their
      behavior is exactly as today — no `order_constraints` builds no
      register: null binding, empty diffs, gates green; frozen evidence
      never rewritten). Every NEW Factory Start under the v2 vocabulary
      carries non-null typed authority from Discovery settlement — a
      built register, or an explicit typed no-obligations attestation if
      (and only if) the architecture truly permits an obligation-free
      order; an absent required register binding on a new v2 start is a
      typed red, never green. Continuations inherit the original register
      ref and never re-extract at continuation settlement.
- [ ] ONE register binding on the certificate-to-Formalization handoff: the
      discovery certificate payload already carries the built
      `constraintRegister`
      (`discovery-production-cell-installation.ts`), and every NEW v2
      FormalizationCase carries exactly that ONE binding
      (`FormalizationConstraintRegisterBinding`) mapped from the certificate
      — the v2 source of truth is the certificate binding, NEVER a rebuild
      from proposal text/payload. The existing deterministic rebuild fallback
      in `resolveFormalizationCaseConstraintRegister`
      (`formalization-schemas.ts`) is frozen-legacy-v1-only (it is
      bit-identical for v1 data, so legacy cases stay green); for a v2 case
      the fallback must not be the supplying path. A v2 case whose register
      binding is missing — with no explicit typed no-obligations attestation
      carried from settlement — is a typed red at case admission, never a
      silent null/rebuild.
- [ ] The warrant CROSS-BINDS the certificate/case it belongs to: the
      `warrantRef` constructed at Formalization settlement
      (`formalization-production-cell-installation.ts`) carries, besides the
      register and dispositions digests, the `discoveryCertificateHash` (and
      the case identity) it was issued against, and consumers verify the
      cross-bind. Register+dispositions self-consistency alone is not
      identity: a warrant silently re-targeted at a different
      certificate/case digest is the m7 typed red below.

Blocking mutations, with their NAMED TEST HOSTS (sixth-pass correction —
a mutation without a host is not executable work):

- m0 (the prerequisite stage — source repair landed by the integrated
  CC-GAP-6 landing `50824c6a`; round-trip and digest-tamper are green in
  its host `tests/discovery/order-constraint-register.test.mjs`; the
  id-reorder and snake_case-at-verify reds are ADDED to that same host by
  the CC-IC-1 base-verification item above — never re-implemented):
  host `tests/discovery/order-constraint-register.test.mjs`.
- m1 (drop a proposal unknown from the open-question entries —
  settlement red): hosts `tests/discovery/order-constraint-register.test.mjs`
  (settlement lifting through `buildOrderConstraintRegister`) and
  `tests/matrix/e-constraint-loss.test.mjs` (the constraint-loss matrix
  proves the unknown survives every settlement path).
- m4 (runnable-local declared without the injected synthesis/smoke
  entries — settlement red) and m4a (injection performed from an
  undeclared/ad-hoc table, or injected entries interleaved among
  proposal-derived rows instead of appended in the declared order — the
  registerDigest and the settlement record disagree or the positional
  block layout is violated — red): hosts
  `tests/architecture/product-build-lifecycle.test.mjs` (the declared,
  digest-pinned injection table beside the frozen classification) and the
  new `tests/discovery/d7-settlement-lifecycle-classification.test.mjs`
  (the pinned classification wiring and the settlement consumption);
  m4a additionally rides
  `tests/discovery/order-constraint-register.test.mjs` (the appended
  block layout in the built register digest).
- m5 (a qualitative/experience (kind `quality`) entry carrying neither a
  measurable interpretation nor a typed deferral — red): host
  `tests/discovery/order-constraint-register.test.mjs`.
- m6 (a new v2 Factory Start whose settlement produces a silent null
  register — red; a no-obligation order must carry the explicit typed
  no-obligations attestation): host the new
  `tests/discovery/d7-settlement-lifecycle-classification.test.mjs`
  (settlement boundary under the pinned classification wiring).
- m6a (a continuation that re-extracts a register instead of inheriting
  the original ref — red): host
  `tests/discovery/d4-settlement-recovery.test.mjs` (the settlement
  recovery/continuation suite).
- m6b (a v2 FormalizationCase whose register binding is supplied by the
  proposal-payload rebuild fallback instead of the one certificate
  binding — red; a v2 case with no binding and no typed no-obligations
  attestation — red): host `tests/matrix/e-constraint-loss.test.mjs`
  (the constraint-loss matrix across the certificate-to-case handoff).
- m7 (a warrant re-targeted at a different certificate/case digest than
  the one it was issued against — cross-bind red): host
  `tests/process-modules/formalization-warrant-ref.test.mjs` (the
  existing `warrantRef` suite, already extended by the integrated
  CC-GAP-6 landing).
- Legacy-green control (PINNED FIXTURES, sixth-pass correction): the
  frozen legacy registerless and v1 corpora stay green, and v1 cases
  keep the deterministic rebuild fallback, pinned to the NAMED
  retro-compat fixtures that must stay green unchanged:
  `tests/discovery/order-constraint-register.test.mjs`
  ("register is null when no order_constraints are carried
  (retro-compat)"; "proposal without order_constraints still validates
  (retro-compat monotonicity)"),
  `tests/process-modules/formalization-constraint-disposition.test.mjs`
  ("no register in the case accepts (retro-compat: empty diff is
  green)"; "missing task metadata / missing process_node_input accepts
  (retro-compat)"),
  `tests/process-modules/formalization-constraint-coverage.test.mjs`
  ("acceptance validator without a register stays green (retro-compat)";
  "no coverage requirement -> no constraint gap (retro-compat in the
  pure diff)"; "baseline payload omits coveredConstraints when no AC
  carries any (retro-compat)"),
  `tests/process-modules/srs-constraint-coverage.test.mjs`
  ("SRS validator stays green without a register (retro-compat)";
  "parseD2CoveredConstraintIdsByAc is empty without the field
  (retro-compat)"), and
  `tests/process-modules/formalization-warrant-ref.test.mjs`
  ("settlement certificate carries no warrantRef without a register
  (retro-compat)"; "readiness manifest without warrantRef still
  validates (retro-compat)").

Exit checklist:

- [ ] All mutations above make their named test hosts' blocking group red
      when reversed (m0's source repair is already landed; its residual
      id-reorder and snake_case-at-verify verification is closed by the
      base-verification item — it is not re-implemented here); the pinned
      legacy-green fixtures above stay green, byte-for-byte in
      expectation.
- [ ] A v2 register is digest-pinned, positionally stable (proposal-derived
      block, then the declared injected block in table order), and
      verifiable through the repaired read-back path; v1 registers
      round-trip unchanged through that same repaired path.
- [ ] No universal engine or settlement branch depends on workshop name,
      `moduleRef`, or role profession.

### CC-IC-2 - Open-question disposition closure

- Owner role: formalization contract owner
- Depends on: CC-IC-1
- Editable files:
  `src/modules/formalization/application/formalization-contract-validator.ts`;
  the brief skill/template metadata contract under
  `src/process-modules/modules/formalization/package/` (disposition
  guidance only);
  `src/modules/formalization/application/formalization-production-cell-installation.ts`
  LIMITED to the baseline-payload disposition freeze and its `warrantRef`
  projection (the existing one-source-three-projections site — brief
  dispositions, frozen map, warrantRef; no other settlement change);
  `src/modules/formalization/domain/formalization-schemas.ts` LIMITED to
  the disposition-freeze schema fields the freeze rides (including the
  `registerDigest` pin the m2d mutation proves — the
  `FormalizationConstraintRegisterBinding` binding/rebuild-fallback
  semantics stay owned by CC-IC-1);
  `tests/process-modules/formalization-constraint-disposition.test.mjs`
- Explicit non-goals: no new ledger beside `constraint_dispositions`; no
  change to the accepted/waived grammar for non-open-question entries

Checklist:

- [ ] Extend the disposition grammar for kind `open-question` entries on
       the existing network: `resolved` (evidenceRef required), or
       `deferred` (non-empty reason + owner + unblockCriterion), or
       `waived` — every waiver on a new-v2 entry requires TRUSTED
       OPERATOR ATTRIBUTION (a recorded operator identity on the
       per-entry waiver; an author or model may at most propose one, and
       ANY author-attributed waiver — a single entry or many entries in
       one act — is a typed red; no separate "mass waiver" category is
       defined beside the per-entry rule, so an attempted multi-entry
       author waiver is simply a set of red per-entry waivers); per-ID
       gate guidance in the `FORMALIZATION_CONSTRAINT_UNDISPOSED`
       message shape.
- [ ] Dispositions freeze into the baseline payload and ride the
      `warrantRef` projection (one source, three projections — no new
      carrier): the freeze is authored at the existing projection site in
      `formalization-production-cell-installation.ts`, and the freeze
      schema fields it rides (including the `registerDigest` pin) live in
      `formalization-schemas.ts` — both under the LIMITED ownership
      recorded in this packet's editable files.
- [ ] Dispositions are digest-pinned to the register they were authored
      against: the disposition freeze carries the `registerDigest` it
      disposes, and a disposition set authored against register digest X
      applied to a register with digest Y ≠ X is a typed red. Recorded
      production gap this closes: today `constraint_dispositions` is keyed
      by POSITIONAL `ord-c-NNN` ids with no register-digest binding
      (`formalization-contract-validator.ts` reads
      `dispositions[entry.id]`), so a changed register digest would silently
      re-apply old positional dispositions to DIFFERENT entries. Positional
      `ord-c` dispositions must never be reused across register revisions.
- [ ] Honest required-coverage arithmetic: `resolved` and `deferred` are
      disposition STATES, not coverage discharges. Only the loud per-entry
      operator-attributed typed waiver subtracts an entry from the required
      set; a resolved or deferred open-question entry REMAINS in the
      production coverage requirement (register ids minus typed waivers
      ⊆ covered) — resolution/deferral never becomes a silent waiver, and
      the reverse diff stays non-empty honestly until the entry is covered
      or loudly waived.
- [ ] Keep registerless and v1-register corpora green: the extension binds
      only entries whose kind is `open-question`.

Blocking mutations: m2 (an undisposed open-question entry —
`FORMALIZATION_CONSTRAINT_UNDISPOSED` with per-ID guidance); m2a (a
deferral without owner or unblockCriterion — red); m2b (a `resolved`
without evidenceRef — red); m2c (ANY waiver authored by the
worker/author instead of a trusted operator — a single author-attributed
entry waiver is red, and an author waiving many or all open questions in
one act is simply that same red repeated per entry (no undefined
"mass-waiver" concept is needed or defined); waivers are loud, per-entry,
trusted-operator-attributed only); m2d (a disposition
set carried across a `registerDigest` change — positional `ord-c` reuse
across register revisions — red).

Exit checklist:

- [ ] Every open-question entry of every register-bearing corpus is
      resolved, deferred (reason, owner, unblock criterion), or waived by
      a loud per-entry operator attribution — or the gate is typed red.
- [ ] Frozen legacy registerless corpora keep exactly the current green
      behavior.

### CC-IC-3 - RULE mechanics-spec typed binding and coverage

- Owner role: formalization coverage owner
- Depends on: CC-IC-1
- Editable files:
  `src/modules/formalization/application/formalization-contract-analysis.ts`
  (`findContractGap` coverage of mechanics-bearing entries);
  `src/modules/formalization/application/acceptance-contract-validator.ts`;
  SRS §D2 coverage in the SRS validators;
  `tests/process-modules/formalization-constraint-coverage.test.mjs`;
  `tests/process-modules/srs-constraint-coverage.test.mjs`
- Explicit non-goals: no new artifact type or product family; no changes to
  the `implements_spec`/`verified_by` trace vocabulary itself (consumption
  only)

Checklist:

- [ ] A mechanics-bearing register entry is CREATED at Discovery
      settlement as kind `mechanics` with NO `mechanicsRef` — the RULE
      artifact does not exist yet, and an impossible at-Discovery
      `mechanicsRef` must never be required. The typed `mechanicsRef`
      binding is established later, at disposition/binding time,
      referencing the accepted RULE artifact.
- [ ] Covering such an entry requires the referenced RULE artifact to be
      accepted and trace-bound (`implements_spec`/`verified_by`) to the
      covering AC/SPEC within the current lifecycle; the entry joins the
      same ADR-088 reverse diff (register ids minus union of kernel-derived
      `coveredConstraintIds` minus typed waivers = empty set; production
      direction: register minus typed waivers ⊆ covered — never the
      converse).
- [ ] Keep the SRS §D2 and §2.2 seams unchanged in semantics: v2 entries
      are ordinary register lines to them.

Blocking mutations: m3 (remove the RULE binding from a mechanics-bearing
constraint at/after binding time — coverage red); m3a (a bound
`mechanicsRef` pointing at a missing or unaccepted RULE artifact — red);
m3b (RULE present but not trace-bound to the
covering AC/SPEC — red).

Exit checklist:

- [ ] Every mechanics-bearing entry of every register-bearing corpus is
      covered by a trace-bound RULE artifact or typed-waived.
- [ ] No new product family exists (artifact-type vocabulary untouched).

### CC-IC-4 - Proof-token compilation and advisory archaeologist

- Owner role: obligation/mutation owner with the CI owner for group wiring
- Depends on: CC-IC-1, CC-IC-2, CC-IC-3
- Editable files: `tests/factory-proof/obligation-contracts.mjs` (FOUR new
   tokens in the single ADR-084 family, plus the ONE remaining correction
   of the existing `frm.submission.srs-contract` token — the
   `frm.submission.acceptance-contract` correction and the SRS §D2↔AC
   residues are ALREADY landed at `3be7393d` and are verify-only); the
   installed-protection reader
   manifest keys; blocking-group registry via the CC-10B wiring;
   `src/modules/discovery/domain/discovery-settlement-records.ts` LIMITED
   to the advisory archaeologist report record — an append-only,
   content-addressed ADVISORY record keyed to the exact proposal/register
   digest it read, stored beside the settlement lineage it informs (report
   artifact carrier only, following that file's existing record pattern;
   no gate wiring, no authority consumer)
- Explicit non-goals: no second obligation registry; no new
  mutation-algebra kinds (reuse the existing constraint kinds); no
  archaeologist output on any gate, register, relay, or authority path

Checklist:

- [ ] Add only FOUR new tokens to the single AcceptanceObligationContract
      family, kebab-case obligationIds citing ADR-090 and the reconciled
      post-mortem item as `sourceRefs`:
      `formalization.unknowns-owned`,
      `formalization.mechanics-spec-required`,
      `formalization.integration-ac-for-runnable-lifecycle`,
      `formalization.qualitative-quantified`.
      The fifth A–G obligation — epic-clause coverage — is realized by the
      EXISTING `frm.submission.acceptance-contract` token, which — after
      the LANDED `3be7393d` v2.1.0 correction — already carries the
      register-coverage constraint in the landed uncovered-residue form
      (`subset(uncoveredConstraintResidue, of empty)` over the protection
      `factory.submission-validator.formalization.
      acceptance-contract.v1`). Do NOT compile a fifth token for it: two
      obligations claiming the same `check-provider::<logicalId>` protection
      key make `assertProtectionSetEquality` throw
      `PROTECTION_OWNER_AMBIGUOUS` (`tests/factory-proof/
      installed-protection-reader.mjs` — the S4 self-mutation landed by
      `3be7393d` already proves this fail-closed for a future
      ADR-090-shaped token), and inventing a second parallel
      protection for the same enforced property violates the
      no-parallel-vocabulary rule (ADR-090 non-goals).
- [x] Acceptance-contract token direction repair — LANDED at `3be7393d`
      (v2.1.0, verify-only for CC-IC-4; never redone, never re-derived):
      the formerly inverted declaration (`coveredConstraintIds` ⊆
      `registerIds-minus-waived`) is corrected to the UNCOVERED-RESIDUE
      form the production validator actually enforces
      (      `{ kind: 'subset', member: 'uncoveredConstraintResidue', of:
      'empty' }` — register ids minus union of covered minus validly
      waived = ∅, the `constraintCoverageGapIdList` /
      `FORMALIZATION_CONSTRAINT_UNCOVERED` reverse diff), with
      its inert member binding dropped from the grammar constraint and a
      rewritten honest T7 adapter (residue mutants must die with
      `FORMALIZATION_CONSTRAINT_UNCOVERED`). CC-IC-4 VERIFIES this
      landed state (the v2.1.0 declaration, its kill matrix, and the S4
      self-mutation are green at the packet base) and adds nothing to
      this token. PRESCRIPTION BAN (normative): never prescribe or apply
      a bare member/of flip for this class of defect — the landed repair
      keeps the mutated member on the worker-authored coverage side; a
      bare flip would only swap which side a mutant rewrites (and for
      the SRS token would mutate the frozen baseline, the authority side
      a worker cannot author).
- [x] SRS §D2↔AC residue repair — LANDED at `3be7393d` (v2.1.0,
      verify-only for CC-IC-4): the `frm.submission.srs-contract` token
      now declares BOTH D2↔AC directions the validator kills
      (`{ kind: 'subset', member: 'unrepresentedFrozenAcResidue', of:
      'empty' }` and `{ kind: 'subset', member: 'foreignD2AcResidue',
      of: 'empty' }`, with the T7b real-validator kill matrix 4/4
      KILLED_TYPED). CC-IC-4 VERIFIES this landed state and adds nothing
      to these two constraints.
- [ ] Own the ONE REMAINING srs-contract residue — the REGISTER-COVERAGE
      residue: the landed v2.1.0 token still declares no constraint for
      the register dimension, while the production validator
      `srs-contract-validator.ts` enforces the production direction
      (register − waived ⊆ union of §D2 `covered_constraint_ids`). This
      is the same under-representation defect class, and CC-IC-4 closes
      it by adding the uncovered-residue constraint in the LANDED
      residue algebra (an
      `uncoveredRegisterResidue`-style member with `of: 'empty'`, never
      a bare member/of flip and never a member bound to the frozen
      authority side), with the same mutation-killable acceptance: the
      residue mutant must die through the real SRS validator
      (`FORMALIZATION_SRS_*` typed gaps), proven in the T7b-style kill
      matrix, never by a symmetric-witness set-equality alone.
- [ ] Set equality both directions with the installed protections from
      CC-IC-1..3; mutant families from the existing algebra; wire the
      blocking group per CC-10B.
- [ ] The LM archaeologist is advisory only, and its PRODUCER TRUTH is
      explicit (sixth-pass correction): a report exists ONLY when the
      operator commissions an advisory producer run for a specific
      proposal/register digest — an operator-commissioned advisory
      producer with a recorded owner (the commissioning record names the
      producer and the digest it may read); there is NO standing or
      automatic producer, settlement never spawns or invokes it, the
      absence of a report is never a red, and the presence of a report is
      never a pass. Its reports are ordinary
      evidence artifacts carried as append-only advisory records in
      `src/modules/discovery/domain/discovery-settlement-records.ts`
      (content-addressed, keyed to the exact proposal/register digest they
      read; no gate, register, relay, or authority consumer); the sole
      promotion path is a new register
      revision with a new digest through Discovery settlement
      (append-only); nothing consumes archaeologist output on a gate
      path. No unowned automatic pass is promised anywhere.
- [ ] Add the archaeologist non-authority mutation: an archaeologist report
      cannot alter the register, digest, relay, reverse diff, or any gate
      outcome.

Blocking mutations: token-set equality both directions (a missing or extra
protection is red; a second obligation over an already-claimed protection
key — the `PROTECTION_OWNER_AMBIGUOUS` shape — is red); token-removal
self-mutation red; the residue-direction mutants of the srs-contract
register-coverage constraint (deleting it, or reverting it to a
non-residue member/of shape that mutates the frozen authority side) red —
the acceptance-contract and SRS §D2↔AC direction-flip mutants are ALREADY
proven by the landed `3be7393d` kill matrices (verify-only); the
archaeologist-authority mutation red; the five
m1..m5 mutants from CC-IC-1..3 all killed by their assigned gates.

Exit checklist:

- [ ] The four new tokens are set-equal with installed protections, their
      mutants are killed, the landed `3be7393d` acceptance-contract and
      SRS §D2↔AC residue repairs verify green at the base (never redone),
      the one added srs-contract register-coverage residue constraint
      kills its residue mutants, and the blocking group includes all of
      them.
- [ ] No parallel scope-clause ledger, unknown ledger, mechanics-spec
      product family, or second obligation registry exists anywhere in the
      diff.
- [ ] Program finish condition reached: with CC-IC-1..4 exit checklists
      green (the CC-IC-1 prerequisite v1-verifier SOURCE repair — landed
      by the integrated `50824c6a` — verified at the CC-IC-1 base
      together with its residual id-reorder and snake_case-at-verify
      verification, not re-implemented) and the
      four new tokens plus the landed-and-extended existing tokens
      blocking, the
      Idea Authority Conservation program is closed. Later defects are
      fixes; new fault classes extend the same register/contract
      vocabulary; there is no standing parallel implementation track.

### A-G reconciliation (item by item, normative per ADR-090)

| Item | As proposed | Disposition in this program |
|---|---|---|
| A. Epic-as-authority trace gate | new scope-clause coverage gate | Reused: register ids + kernel-derived `coveredConstraintIds` + SRS §D2/§2.2 reverse diff (ADR-088); v2 entries join the same diff; no parallel scope-clause ledger |
| B. Requirements archaeologist | gating second model | Advisory only, operator-commissioned: a report exists only when the operator commissions an advisory producer with a recorded owner; no standing/automatic producer, no gate, no authority path; promotion produces a new register revision/digest via Discovery settlement; cannot gate or mutate authority (CC-IC-4) |
| C. Unknowns are obligations | new OPEN ledger | kind `open-question` register entries (class vocabulary `execution|material|human` unchanged) drafted 1:1 from proposal unknowns (CC-IC-1); `resolved`, or `deferred` (reason, owner, unblock criterion), or `waived` with trusted operator attribution — any author-attributed waiver, single or en masse, is red (no undefined mass-waiver concept) — on the existing disposition network (CC-IC-2) |
| D. Mechanics first-class | new mechanics-spec family | Existing RULE artifacts are the carrier; the kind `mechanics` entry is created at Discovery with NO ref and the typed `mechanicsRef` binding is established at disposition/binding time against the accepted RULE artifact, trace-bound via `implements_spec`/`verified_by` (CC-IC-3) |
| E. Runnable lifecycle auto-requires integration + ordered smoke | inferred at Formalization | Frozen `runnable-local` classification; deterministic injection at Discovery settlement; engine never infers by rereading prose (CC-IC-1) |
| F. Qualitative quantified | new translation requirement | Typed measurability on qualitative/experience (kind `quality`) entries ONLY: measurable interpretation or typed deferral (CC-IC-1) |
| G. Five conformance obligations | new obligation family | FOUR new tokens in the single ADR-084 AcceptanceObligationContract (unknowns-owned, mechanics-spec-required, integration-ac, qualitative-quantified); the fifth (epic-clause coverage) rides the EXISTING tokens — the acceptance-contract direction repair and the SRS §D2↔AC residues are LANDED at `3be7393d` (v2.1.0 uncovered-residue algebra; verify-only), and CC-IC-4 adds only the srs-contract register-coverage residue constraint (no fifth token — the protection key is already claimed; `PROTECTION_OWNER_AMBIGUOUS`, already self-mutation-proven by `3be7393d`); never a bare member/of flip; existing mutation algebra; blocking via CC-10B/CC-80 floors (CC-IC-4) |

---

## 8. Qualification audit and handoff

### CC-80 - Complete qualification command

- Owner role: integration owner
- Depends on: CC-00, CC-00C, CC-10B, CC-23, CC-32, CC-44, and CC-60

Checklist:

- [ ] Compose one command for every K0-K5 exit and Structural Qualification item.
- [ ] Include strict happy/repair, cutover faults/mutants, differential compare,
  and zero-authority-write ratchets.
- [ ] Include the CC-00C product-claim-integrity checks: the mechanical
  constraint-register coverage diff (register ids minus
  union(coveredConstraintIds) minus typed waivers; register-conditional
  grandfathering, execution-entrypoint ownership, and kernel-only relay
  derivation per ADR-088), warrant execution over
  `VerificationWarrantRef` with package-level oracle adapters,
  append-only criterion-key verification accounting, substrate outcome
  classification and routing per ADR-089 (bounded in-check substrate
  retry; typed unknown `warrant-blocked-environment`; human_required
  blocked/resumable; no-poison; never product-failed), the CC-GAP-9
  RESIDUAL substrate TOCTOU re-probe per ADR-091 with its blocking
  mutations (a)-(f) ((a)/(b) observed-classification routing in both
  directions; (c) no stderr guessing; (d) collapse guard; (e) compose
  `down` vs invalid config; (f) provider `1.12.0` with digest fence,
  trust migration, and obligation compiler pin
  `factory.local-runnability.v1` @ `1.12.0`), and
  role-projection clarity,
  with their blocking mutations.
- [ ] The idea-authority-conservation checks are a MANDATORY dependency of
      this command (ADR-090): the register-v2 conservation diff (every
      proposal unknown present as an open-question entry; injected
      synthesis/smoke obligations under a runnable-local classification;
      typed measurability on every qualitative/experience entry; new v2
      starts carry non-null typed authority), open-question disposition
      closure, and RULE mechanics binding, with their blocking mutations.
      Until CC-IC-1..4 are implemented and proven, this command is
      incomplete and its result is RED: the unproven CC-IC set is an open
      mandatory dependency, never a skip.
- [ ] Fail on missing fixtures, empty scans, zero tests, or skipped groups.

Exit checklist:

- [ ] Command is documented, non-vacuous, and deterministic.
- [ ] One known mutation in each required class makes it red.
- [ ] No CC-GAP-6..10 is open; the CC-00C product-claim blocking proofs are
      included and green.
- [ ] No CC-IC packet (ADR-090) is unimplemented or unproven: the CC-IC
      mandatory qualification dependency is closed and its blocking
      mutations are green.

### CC-81 - Read-only qualification audit

- Owner role: reviewer/integration owner
- Depends on: CC-80
- Non-goals: implementing fixes inside the audit

Checklist:

- [ ] Evaluate every master-plan Structural Qualification checkbox.
- [ ] Evaluate every cleanup-plan prerequisite without trusting stale prose marks.
- [ ] Attach command, SHA, path, digest, and proof mode to every PASS.
- [ ] Create named `CC-GAP-N` for every failure and return to implementation.
- [ ] Verify the CC-00B exit checklist explicitly: record PASS or an open gap
  for each of CC-GAP-2..5. Any open CC-GAP-2..5 keeps this audit RED.
- [ ] Verify the CC-00C exit checklist explicitly: record PASS or an open gap
  for each of CC-GAP-6..10. Any open CC-GAP-6..10 keeps this audit RED.
- [ ] Record the state of every CC-IC packet (ADR-090), landed or not:
      any packet not implemented-and-proven — including every not-started
      packet — keeps this audit RED (CC-IC is a mandatory overall
      qualification dependency, while the frozen CC-00C scope stays
      CC-GAP-6..10); unlanded packets are recorded as not started, never
      as PASS.

Exit checklist:

- [ ] Every item is evidenced PASS or audit remains RED.
- [ ] `QUALIFICATION_GREEN` emits only with no open gap, including no open
      CC-GAP-2..5, no open CC-GAP-6..10, and no unimplemented or unproven
      CC-IC packet (ADR-090).

### CC-82 - Clean-clone reproduction and evidence freeze

- Owner role: integration owner
- Depends on: CC-81

Checklist:

- [ ] Use fresh isolated checkout at exact candidate SHA.
- [ ] Install/build without borrowed `dist`, DB, cache, or workspace.
- [ ] Run complete CC-80 command.
- [ ] Record commands, exits, counts, time, SHA, report and diff digests.
- [ ] Freeze scenario, token, edge, required/killed mutant, and runtime floors.
- [ ] Include the CC-00B terminal-integrity evidence in the frozen set; do not
  emit `QUALIFICATION_GREEN` with any CC-GAP-2..5 open.
- [ ] Include the CC-00C product-claim-integrity evidence in the frozen set;
      do not emit `QUALIFICATION_GREEN` with any CC-GAP-6..10 open.
- [ ] Include the CC-IC idea-authority-conservation evidence in the frozen
      set; do not emit `QUALIFICATION_GREEN` with any CC-IC packet
      (ADR-090) unimplemented or unproven.
- [ ] Capture pre-cutover normalized evidence.

Exit checklist:

- [ ] Complete gate passes from fresh checkout.
- [ ] Pre-cutover evidence/floors are frozen.
- [ ] CC-00B evidence is frozen and every CC-GAP-2..5 is closed.
- [ ] CC-00C evidence is frozen and every CC-GAP-6..10 is closed.
- [ ] CC-IC evidence is frozen and every CC-IC packet is implemented and
      proven (ADR-090 mandatory qualification dependency closed).
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
- [ ] Prove warrant consumption and package-level oracle adapters are
  workshop-package declarations requiring zero universal engine edits
  (CC-GAP-7 wiring; semantics ride the existing Order Constraint Register
  and `VerificationWarrantRef` seam; no frontend hardcoding in engine or
  test-engine files).
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
- [ ] CC-00B terminal-integrity exit criteria pass; no CC-GAP-2..5 is open.
- [ ] CC-00C product-claim-integrity exit criteria pass; no CC-GAP-6..10 is
  open.
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
- [ ] Report operational completion (engine exit code, launch status, tracker
  status) separately from product outcome; never report operational
  completion as a successful full factory run.
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
- [ ] Terminal projections can render a failed product outcome as bare
  `completed`. CC-00B blocks the critical path until status surfaces separate
  operational and product outcomes; no CC-GAP-2..5 may stay open at
  qualification.
- [ ] Nominal criterion attachment can masquerade as coverage: a
  buildable/integrator AC attached to a semantically insufficient item passes
  planning while no item owns whole-product synthesis, a register-bearing
  corpus can dodge the coverage diff by omitting §2.2 or coverage metadata,
  a wide decoy item can contain declared files without owning their
  constraint, planner output can forge the `coveredConstraintIds` relay, a
  generic loopback oracle cannot prove a browser-product claim, deferred
  verification can silently vanish from accounting, substrate unavailability
  can be flattened into product failure, and reviewer projections can read
  as duplicate work. CC-00C blocks the critical path until all five are
  enforced; no CC-GAP-6..10 may stay open at qualification. The remedy
  reuses the existing Order Constraint Register, `coveredConstraintIds`,
  SRS §2.2 module-manifest coverage, and `VerificationWarrantRef` seam —
  it invents no parallel deliverable-claim vocabulary — makes
  grandfathering strictly register-conditional with entrypoint ownership
  and kernel-only relay derivation (ADR-088), makes verification
  accounting append-only and criterion-keyed (pending survives readiness
  failure and continuation; `executed(failed)` is not discharged; only a
  passed receipt or an operator-attributed waiver discharges;
  stage/order visibility; no reuse of the transition obligation ledger),
  keeps product-failed, oracle-insufficient, and substrate-unavailable
  distinct with bounded in-check substrate retry, typed unknown, and
  human_required blocked/resumable (ADR-089; unknown receipts never poison
  a later pass), treats role projection as rendering-only (board/detail
  display role; no deduplication, no data rewrite), keeps environment
  identity with ADR-083/K19 (CC-GAP-9 owns availability only; CC-GAP-7
  consumes and receipt-binds `environmentDigest`, never authorizes it),
  and serializes
  CC-GAP-9 outcome/routing before CC-GAP-7 warrant execution (and the
  K19 image/digest remainder before CC-GAP-7 receipt-binding, with the
  honest fallback recorded in §3.2 if it has not landed). The CC-GAP-9
  residual has its own drift risk: a mid-check executor/compose failure
  in the TOCTOU window between the availability probe and the substrate
  steps can be flattened back into product failure or "classified" by
  stderr text guessing — ADR-091 closes it with a mechanical re-probe
  (only observed unavailable/not-linux routes into the ADR-089 bounded
  retry/typed unknown; a bad image/tag/config/product stays product
  `failed`; compose down vs invalid config distinct; collapse guard;
  provider `1.12.0` with digest fence and trust migration, obligation
  compiler pin `1.12.0`) before ANY production factory run and before CC-GAP-7,
  with blocking mutations (a)-(f) wired into CC-10B/CC-80.
- [ ] Idea-authority conservation can drift into a parallel vocabulary or a
      standing program: parallel scope-clause or unknown ledgers, a new
      mechanics-spec product family, a gating LM archaeologist, or a second
      obligation registry are all prohibited (ADR-090). CC-IC-1..4 are
      bounded packets serialized after the CC-GAP-6 seam through the
      single-writer `Constraint register and warrant seam` row, and a
      mandatory overall qualification dependency (until implemented and
      proven, CC-10B/CC-80 and overall K qualification stay RED); their
      proof tokens join the single ADR-084 contract family (the
      acceptance-contract and SRS §D2↔AC direction repairs are already
      landed at `3be7393d` — verify-only; only the SRS register-coverage
      residue is added, in the landed residue algebra, never a bare
      member/of flip); the program
      closes when its exit checklists are green; and order unknowns become
      owned obligations on the register (resolved; deferred with reason,
      owner, and unblock criterion; or waived with trusted operator
      attribution — any author-attributed waiver, single or en masse, is
      red, and no undefined mass-waiver concept exists), never opaque
      strings.
      Null-binding grandfathering stays frozen-legacy-v1-only: a new v2
      Factory Start that silently builds a null register and passes green
      is itself the drift this item guards against.
