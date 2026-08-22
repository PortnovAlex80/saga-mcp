# Formalization Unified Conformance Closure — Local Validation Handoff

- Date: 2026-08-21
- Branch: `w0-waves`
- Status: implemented, NOT locally executed by the authoring agent
- Scope: Formalization workshop conformance only; Development is explicitly out of scope for this tranche
- Baseline before this tranche: `71631476dee0e09ab745bfb3d43c0a787e3d9975`

## 1. Purpose

This tranche applies the unified Saga conformance kernel to the second built-in workshop, Formalization, after Discovery established the first vertical slice.

The goal is not to copy Discovery tests. Formalization introduces materially different mechanisms:

```text
submission preflight validation
  + reviewed Production Cells
  + author Gate
  + reviewer CandidateSet + final Gate
  + same-Workplace review repair
  + post-acceptance effect
  + deterministic baseline-freeze kernel
  + deterministic settlement
  + Formalization -> Development handoff
```

The conformance pack still replaces cognition only. Factory authority remains production-owned.

## 2. Production topology covered

Current Formalization flow:

```text
define-product-contract          reviewed Production Cell
        |
model-use-cases                  reviewed Production Cell
        |
define-acceptance-contract       reviewed Production Cell
        |
reconcile-what                   reviewed Production Cell
        |
freeze-acceptance-baseline       kernel
        |
define-architecture-contract     reviewed Production Cell
        |
settle-formalization             kernel
        |
complete-formalized | complete-inconsistent | complete-failed
```

Every reviewed Cell has:

```text
author execution
 -> worker_done submission preflight
 -> author CandidateSet
 -> author Gate
 -> reviewer execution
 -> reviewer CandidateSet
 -> final Gate
 -> formalization.accept-exact-products.v1
 -> CellFinalAcceptance
```

All five Cells declare `maxAttempts=5`, `onExhausted='requeue'`.

## 3. Files added/changed

Common observer extension:

- `tests/factory-proof/trace-observer.mjs`
  - submission validation rejection rows;
  - artifact/hash/drift facts;
  - artifact traces;
  - exact Production Cell effect receipts;
  - effect attempts and repair issues.

Formalization pack:

- `tests/factory-proof/formalization-scenario-pack.mjs`
- `tests/factory-proof/formalization-resilience-pack.mjs`
- `tests/factory-proof/formalization-resilience-pack.test.mjs`
- `tests/factory-proof/formalization-scenario-drive.mjs`
- `tests/factory-proof/formalization-coverage-drive.mjs`
- `tests/factory-proof/formalization-restart-proof.mjs`
- `tests/factory-proof/formalization-retry-exhaustion-proof.mjs`

No production source file was intentionally modified by this tranche.

## 4. Scenario corpus

The closure corpus has 26 declared scenarios: 8 local/contract scenarios plus 18 resilience scenarios.

### Positive spine

`formalization/happy-formalized`

Expected proof:

- all five author checks pass;
- all five author Gates accept;
- all five reviewer/final Gates accept;
- all five `formalization.accept-exact-products.v1` effects produce exact Cell effect receipts;
- accepted artifact rows bind `accepted_hash === content_hash` and `drift_state=clean`;
- acceptance baseline freezes before architecture;
- settlement emits `formalized` and an immutable certificate;
- exact Formalization SolutionContract material is mapped into Development.

### Submission-preflight causal repairs

These faults occur before the author presentation can be accepted. The worker remains in the same execution, consumes the actionable rejection, repairs existing material, and retries `worker_done`:

- `formalization/product-missing-brief-lineage-repair`
- `formalization/use-cases-missing-fr-coverage-repair`
- `formalization/acceptance-missing-trace-repair`
- `formalization/acceptance-heading-mismatch-repair`
- `formalization/architecture-invalid-d2-repair`

These scenarios intentionally prove a different mechanism from Gate/recovery repair: `factory_submission_validation_rejections` is the durable causal evidence.

### Reconciliation report ratchet

`formalization/reconciliation-malformed-report-rejected`

This scenario is intentionally adversarial and MAY expose a production defect.

Current authoritative authoring resources define the reconciliation product as:

```json
{
  "schema": "factory.formalization-reconciliation-report.v1",
  "content": {
    "status": "reconciled",
    "repairs": [],
    "remaining_gaps": [],
    "rationale": "..."
  }
}
```

Evidence:

- `package/resources/reconciliation-product-call-template.json` declares this shape;
- `package/resources/skills/saga-reconciler/SKILL.md` calls it one typed immutable reconciliation report and explains the semantics of the fields.

However, current production wiring does not pin a payload contract on the `reconcile-what` Cell, and `formalization.reconciliation.v1` validates the accepted WHAT graph rather than decoding the report payload itself.

Therefore a malformed report may currently survive `product_submit`/Gate if the graph itself is valid. If this scenario is red because malformed report was accepted, do NOT weaken the test. Treat it as a real contract-protection gap and repair production by adding an independent pinned reconciliation payload contract (or an equivalent declared protection) matching the current report contract.

There is also metadata drift in `tests/factory-proof/obligation-contracts.mjs`: the existing `frm.submission.reconciliation` text still refers to an obsolete `coverageDiff` projection. Update that independent obligation to the current `status/repairs/remaining_gaps/rationale` contract when the production protection is fixed. Do not preserve `coverageDiff` merely to make old metadata true.

### Reviewer authority

`formalization/reviewer-foreign-subject`

A reviewer product binds a foreign CandidateSet ref. The real `factory.review-verdict.v1` provider must refuse/indeterminate it and the final Gate must not advance the Cell.

### Reviewer feedback causality

Representative equivalence class on `formalization-product-contract`:

- `formalization/reviewer-feedback-exact`
- `formalization/reviewer-feedback-absent`
- `formalization/reviewer-feedback-stale`
- `formalization/reviewer-feedback-corrupted`

The reviewer decides from visible candidate material, not attempt number:

```text
same visible author material
  -> changes_requested

material digest changed by the requested repair
  -> approved
```

The author changes material only when its scripted actor sees the exact production RecoveryIssue. Absent/stale/corrupt feedback must not produce the same repair.

This is one representative causal class, not a Cartesian duplication across all five structurally equivalent reviewed Cells.

### Worker crash

One real author crash/recovery proof per reviewed Cell:

- product
- useCases
- acceptance
- reconciliation
- architecture

A lost WorkerExecution must be followed by production-owned repair/requeue and eventual final acceptance on a fresh execution.

### Retry exhaustion

One terminal exhaustion proof per reviewed Cell.

The reviewer returns a valid stable `changes_requested` diagnosis. The proof:

1. burns the real five-attempt local epoch;
2. requires a durable recovery epoch and `repair_wait`;
3. waits the real production epoch-1 backoff (`61_000ms` including margin);
4. redrives the same Factory launch;
5. requires repeated reason identity to end the Cell honestly as failed;
6. requires Formalization stage outcome `failed`, no final acceptance, no stranded execution.

No test clock, timestamp update, direct Workplace mutation or synthetic GateDecision is used.

These five scenarios make the full coverage drive intentionally slow.

### Tool/fence/idempotency

- `formalization/reconciliation-duplicate-submit`
  - duplicate identical `product_submit` must replay/refuse safely;
  - only one durable managed submission may exist for the attempt.

- `formalization/reconciliation-late-tool-call`
  - `product_submit` after accepted `worker_done` must be denied.

- `formalization/product-stale-execution-fence`
  - first author execution is deliberately lost;
  - a later execution temporarily attempts `artifact_create` under the stale execution id;
  - the production tool fence must deny it.

### Restart / replay

`formalization/restart-idempotency`

Three Factory Starts on one DB/project/epic:

```text
A: semantic input A -> cold
B: semantic input A -> capsule replay, zero scripted inference expected
C: incompatible semantic input B -> cold, no replay expected
```

The proof stops at the `formalized` stage boundary so Development behavior cannot contaminate the Formalization replay theorem.

## 5. W9 fixture authority correction

The historical shared W9 Formalization handlers still call `artifact_create(status:'accepted')`. Current production correctly forbids a managed worker with `artifactAcceptanceAuthority='kernel-gate'` from accepting its own artifacts.

The Formalization scenario drive therefore wraps ONLY Formalization author cognition and converts historical `status:'accepted'` requests to `status:'draft'` before invoking the real `artifact_create` handler.

This is not a Factory override. It corrects stale scripted cognition so the production sequence is:

```text
worker creates draft candidate
 -> CandidateSet
 -> Gates
 -> formalization.accept-exact-products.v1
 -> accepted_hash/status committed by Factory effect
```

Do not change production acceptance authority to accommodate the old W9 fixture.

## 6. Exact handoff proof

The positive scenario compares durable StageRun facts:

```text
Formalization mapped_output_snapshot
        ==
Development input_snapshot
```

for:

- formalization decision;
- certificate schema/ref/hash;
- SolutionContract schema/ref/hash;
- acceptanceBaselineHash;
- SRS ref/hash object;
- acceptanceCriteria payload.

The existence of a Development StageRun alone is not sufficient.

## 7. Workshop closure vs platform fault closure

The following are intentionally excluded from workshop closure and assigned to the common K4 named fault scheduler:

```text
transition:freeze-acceptance-baseline->complete-inconsistent
transition:freeze-acceptance-baseline->complete-failed
transition:settle-formalization->complete-inconsistent
transition:settle-formalization->complete-failed
effect-fault:formalization-accept-products:post-gate-pre-effect-drift
```

They require precise faults between accepted durable boundaries. Do not obtain them by writing authority tables directly from a Formalization scenario.

## 8. Local validation order

The authoring agent DID NOT run these commands.

First build and structural checks:

```bash
npm run build

node --test \
  tests/factory-proof/scenario-evidence.test.mjs \
  tests/factory-proof/scenario-runner.test.mjs \
  tests/factory-proof/coverage-kernel.test.mjs \
  tests/factory-proof/formalization-resilience-pack.test.mjs
```

Then the positive spine:

```bash
node tests/factory-proof/formalization-scenario-drive.mjs formalization/happy-formalized
```

Then high-value contract/preflight cases:

```bash
node tests/factory-proof/formalization-scenario-drive.mjs formalization/product-missing-brief-lineage-repair
node tests/factory-proof/formalization-scenario-drive.mjs formalization/acceptance-heading-mismatch-repair
node tests/factory-proof/formalization-scenario-drive.mjs formalization/architecture-invalid-d2-repair
node tests/factory-proof/formalization-scenario-drive.mjs formalization/reconciliation-malformed-report-rejected
node tests/factory-proof/formalization-scenario-drive.mjs formalization/reviewer-foreign-subject
```

Then feedback causality:

```bash
node tests/factory-proof/formalization-scenario-drive.mjs formalization/reviewer-feedback-exact
node tests/factory-proof/formalization-scenario-drive.mjs formalization/reviewer-feedback-absent
node tests/factory-proof/formalization-scenario-drive.mjs formalization/reviewer-feedback-stale
node tests/factory-proof/formalization-scenario-drive.mjs formalization/reviewer-feedback-corrupted
```

Then generic Factory physics bound to Formalization:

```bash
node tests/factory-proof/formalization-scenario-drive.mjs formalization/product-worker-crash
node tests/factory-proof/formalization-scenario-drive.mjs formalization/reconciliation-duplicate-submit
node tests/factory-proof/formalization-scenario-drive.mjs formalization/reconciliation-late-tool-call
node tests/factory-proof/formalization-scenario-drive.mjs formalization/product-stale-execution-fence
node tests/factory-proof/formalization-scenario-drive.mjs formalization/restart-idempotency
```

Slow real-backoff proof, first on ONE cell:

```bash
node tests/factory-proof/formalization-scenario-drive.mjs formalization/product-retry-exhaustion
```

Only after the above is understood, run the complete workshop report:

```bash
node tests/factory-proof/formalization-coverage-drive.mjs > formalization-coverage.json
```

The full drive contains five real-backoff exhaustion scenarios and therefore is intentionally much slower than Discovery.

## 9. Required closure result

After production/test defects exposed by the pack are resolved, the report must show:

```text
planned.closure.percent = 100
planned.closure.uncovered = []

demonstrated.closure.percent = 100
demonstrated.closure.uncovered = []

all scenarios.verdict = pass
```

The K4 platform fault list remains explicit and is not included in the workshop-closure denominator.

## 10. How to classify red results

### `reconciliation-malformed-report-rejected` red

Likely expected current production gap. Add a pinned reconciliation payload contract matching the official template/skill. Update the independent obligation away from obsolete `coverageDiff`. Do not weaken the scenario.

### Happy path fails on `ARTIFACT_ACCEPTANCE_AUTHORITY_VIOLATION`

The Formalization drive should already normalize stale W9 author stimuli to draft. If this still occurs, identify a missed Formalization author handler. Do not let a worker accept its own artifact.

### Submission repair scenario has no durable rejection

Check whether the current validator actually owns that invariant. If yes, inspect worker_done preflight wiring. If no, correct the independent obligation/scenario rather than inventing a detector.

### Reviewer feedback exact does not repair

Inspect the real RecoveryIssue projection into the fresh author execution. Do not branch the actor on attempt number to make it pass.

### Counterfactual repairs anyway

Treat as test actor leakage unless production exposed equivalent exact feedback through another lawful channel. The actor must not know scenario identity or hidden attempt count.

### Crash leaves `running`, `leased`, or anonymous work

Treat as a Factory finalizer/recovery/projection defect. Do not add test-side recovery.

### Stale-fence artifact call succeeds

Treat as a production tool-authorization/fence defect. The stale execution must never mutate Formalization material.

### Restart same-input runs cognition

Inspect replay-key/capsule compatibility and accepted-material capture. Do not special-case Formalization replay in the test kernel.

### Exact handoff differs

Treat as lifecycle mapping or output-resolver drift. Do not make the oracle compare only fields that happen to match.

## 11. Stop condition before Development

After Discovery and Formalization are locally green:

1. compare their packs;
2. identify only patterns that actually repeated;
3. extract those into generic test helpers;
4. keep workshop semantic fixtures/oracles local;
5. only then begin Development.

Do not start Development by cloning either pack. Development adds fan-out/fan-in, dependencies, Git effects, readiness and continuation/replan mechanics and must consume a proven generic base rather than another layer of copied test code.

## Addendum 2026-08-21 (evening session): validation results and the remaining resilience-pack classification

The full validation-order run is complete. State after this session:

**Green (16/16 through the coverage drive, core Formalization pack):**
happy spine, all three trace-repair scenarios, heading repair, d2 repair,
reconciliation-malformed, reviewer-foreign-subject, plus Discovery spine and
the shared structural suites. Two production-side changes landed:

1. `a5e1d409` — reconciliation report payload contract pinned at the
   product_submit intake (canonical ProductPayloadContract mechanism, single
   manifest); obligation registry Wave F0 cleanup in the same commit.
2. `7a4a99ee` — pack actors repaired to real production boundaries
   (artifact_update repair path; foreign-subject oracle redirected to the
   stronger WorkIntent intake fence; observer schema fixes; explicit
   BOUNDARY-UNDRIVEN classification).

**Remaining reds (10, all in the resilience pack, never run by the original
authors) — classified, NOT yet fixed:**

- `reviewer-feedback-{exact,absent,stale,corrupted}` (4): after
  changes_requested the author repair loop never converges. Observed on
  `exact`: 213 author executions, actor repair fires every time, artifact
  upsert is legal (accepted→draft reopen), yet NO second author CandidateSet,
  NO new gate decisions, ZERO recovery epochs, review never re-arms,
  cycle-bound stop. This is the F-R1/F-R2 supervision family (see
  2026-08-21-w1-2-f-r2-candidate-fix.md): the repair_wait→author→new
  CandidateSet→reviewer re-arm path stalls in production. NOT a pack bug.
  Needs a dedicated session with DB retention to read per-execution
  finalize outcomes.
- `{product,useCases,acceptance,reconciliation,architecture}-retry-exhaustion`
  (5): not yet diagnosed individually; expected to collide with the same
  supervision family or with real-backoff timing (61s). Diagnose after the
  feedback quartet — same production territory.
- `restart-idempotency` (1): crashes at launch B with
  LIFECYCLE_SCOPE_ALREADY_ACTIVE — the proof stops lifecycle A at the
  'formalized' boundary (non-terminal) and immediately starts B on the same
  project+epic+lifecycle scope. The scope guard is a deliberate production
  protection. There is no lawful mid-flight lifecycle cancel exposed to the
  harness. Options: drive runs to natural terminal (collides with F-R1/F-R2
  for run B — full-lifecycle replay of review capsules is exactly the
  documented defect), or land F-R2 first, or add a lawful harness-level
  terminalization seam. Decide with the operator.

**Blocking next steps (order):**
1. F-R1/F-R2 production fix (review capsule content model + requeue
   supervision) — unblocks the feedback quartet, retry-exhaustion family,
   restart-idempotency AND the W1-2 B-run completion.
2. W1-4 option-1 rework (B gets genuinely different upstream material;
   guide §8.6: reuse/extend the W1-4 proof, do not replace it).
3. Only then Phase G registration and the w0-waves → saga4 merge.

## Addendum 2 (same evening): the UNIQUE-constraint root cause is FIXED

Retention-DB post-mortem (PROOF_KEEP_DIR) replaced speculation with data:
all 209 lost executions died on the artifact-ref bridge UNIQUE constraint
(`177a4666` — logical-key reprojection for lawful same-run repair).

- `reviewer-feedback-exact` now PASSES (43 cycles, full convergence).
- `reviewer-feedback-{absent,stale,corrupted}`: next, DIFFERENT layer —
  the exhausted review loop fails the process but leaves the workplace in
  review/queued with NO owner and NO park reason (ANONYMOUS-STALL). The
  fix is the exhausted-loop supervision park: record a park reason
  (recordWorkplaceParkReason) and move the workplace to a typed
  repair_wait/paused/terminal state when the review loop exhausts or the
  process fails underneath it. Start from the review-loop recovery
  exhaustion path in the production-cell executor.
- retry-exhaustion ×5 and restart-idempotency: re-run after the park fix —
  same supervision territory.

## Addendum 3: layers 1+2 of the supervision family are FIXED; exhaustion = layer 3

- `177a4666` — artifact-ref desk reprojection on lawful same-run repair (was:
  UNIQUE constraint killed every repair execution; 209 lost in one drive).
  reviewer-feedback-exact PASSES.
- `f6a79aa1` — REPAIR_ROUND_IDENTICAL_MATERIAL park: a repair round that
  seals byte-identical accepted material after a final repair_required
  verdict parks typed (task blocked + workplace park + durable evidence)
  instead of stalling review/queued. absent/stale/corrupted PASS.

**Remaining layer (retry-exhaustion ×5, all failing on
`*.retry-exhaustion.local-budget`: epochRecorded=false):** the ADR-075
budget machinery in production-cell-node-executor (attemptCount → epoch
rollover → total-cap terminal failed) NEVER SEES identical review rounds,
because the review round 2 does not re-materialize for a byte-identical
author candidate set (content addressing dedups it; the reviewer verdict
for those exact bytes already exists). The two scenario families share the
same causal input (author resubmits identical bytes; reviewer rejects) and
the CORRECT unified semantics per CONVEYOR §15 + ADR-075: on author
re-acceptance with a set byte-identical to the just-rejected one, the
round must be TAXED as a wasted attempt (finding-trajectory identity:
gate + findings), driving budget → epoch rollover → spin detection →
terminal failed — not a human park at round 2, and not a stall.

Implementation hint: replace the round-2 human park in dispatcher.ts
(REPAIR_ROUND_IDENTICAL_MATERIAL) with budget taxation — record the
identical re-seal as a rejected-set attempt for the author role, or
re-arm the review desk with the prior verdict as the round's outcome,
letting the existing executor budget take over. Then absent/stale/
corrupted end `terminal failed` (their typed-bounded oracle accepts
'terminal') and the exhaustion family gets its epochs + failed stage.
restart-idempotency still blocked by LIFECYCLE_SCOPE_ALREADY_ACTIVE
(scope guard; see Addendum 1 options).

Score after this session: core pack 16/16 + feedback quartet 4/4 = 20 of
26 scenario groups green; 6 red remain (exhaustion ×5 + restart), one
production layer away.

## Addendum 4 (night): layer 3 LANDED — identical re-seals are taxed, exhaustion ×5 GREEN

The round-2 human park (`REPAIR_ROUND_IDENTICAL_MATERIAL`, layer 2) is
REMOVED and replaced by production budget taxation, per the Addendum-3 hint
and CONVEYOR §15 ("budget must count spin, not work") + ADR-075:

- `production-cell-node-executor` (author verifying branch, reviewed cells):
  when the freshly sealed CandidateSet ref EQUALS the subject of the newest
  final `repair_required` decision (`readLatestFinalRepairRequiredSubjectSet`,
  ref equality = ADR-053 B-2 partition convergence), the prior verdict is
  re-applied as THIS round's outcome (`applyGateDecision(repair_required)`),
  the deterministic author gate is not re-run, and the round is taxed.
- `countRepairSpinResealsForAuthor`: the leading run of identical
  `validated_set_digest` receipts on the workplace's author task (append-only
  receipts are the durable per-round fact), minus the first round. NOT
  epoch-baselined by design: identical bytes across a rollover are
  cross-epoch spin; the F6 diagnosis-repeat deny ends the line terminally.
  A real repair changes the digest, breaks the run, stops the tax.
- dispatcher: the identical-ACCEPTED-material park branch deleted
  (`readAcceptedRepairStasis` removed with it); worker_done completes
  normally and the workplace proceeds to verifying, where the executor
  detects the re-seal.

Drive infrastructure fix (blocker for EVERY two-phase proof): each finished
drive settles its launch (`finishFactoryLaunch('paused')` — terminal for the
LaunchRequest), so phase B on the SAME launchRef was impossible
(`FACTORY_LAUNCH_NOT_CLAIMABLE`; the two-phase exhaustion pattern had never
actually passed end-to-end). Phase B now creates a lawful RESUME launch
(production pattern from engine-administration: fresh launch under the same
order, `mode='resume'`, bound to the phase-A lifecycle run), and
`driveFreshHarness` became resume-aware (`ticket.mode==='resume'` → no
lifecycleInput re-submission, `resumePaused` from the first cycle, runEpisode
receives the ORIGINAL run's idempotency key so the pinned input snapshot
resolves).

Validation (this session, clean build):
- `product|useCases|acceptance|reconciliation|architecture-retry-exhaustion`
  ×5 — ALL PASS (epoch ≥1 recorded, real 61s backoff crossed, terminal
  failed, never final-accepted, zero stranded).
- `reviewer-feedback-{exact,absent,stale,corrupted}` ×4 — ALL PASS (absent/
  stale/corrupted now end `terminal failed` through the honest budget path,
  as Addendum 3 predicted; exact still converges by real repair).
- Regressions green: happy-formalized, product-missing-brief-lineage-repair,
  architecture-invalid-d2-repair; contract packs 9/9.

Score: **25/26** (from 20/26). The one remaining red,
`restart-idempotency`, is the separate `LIFECYCLE_SCOPE_ALREADY_ACTIVE`
scope-guard decision (Addendum 1) — operator decision required, unchanged.

Known separate defect (NOT this tranche): Discovery `proposal/readiness
-retry-exhaustion` still fails phase A (`epochRecorded=false`) at w0-waves
HEAD and at 7aece87a — its identical-REJECTED-bytes loop (unreviewed author
gate path, submission rejection stasis) never feeds the budget. Same §15
family, different seam; needs its own session.

## Addendum 5 (same night): the Discovery exhaustion seam is FIXED too

The "separate defect" from Addendum 4 turned out to be three small production
gaps, all closed in the same §15 frame:

1. **The spin counter only saw receipts.** Reviewed (payload-contract) cells
   leave validation receipts per round; UNREVIEWED discovery cells leave none
   — but the author gate runs every round and REPEATS a rejecting decision
   for the same immutable subject ref (empirical: 40 decisions, 1 distinct
   set, 0 receipts, 0 epochs). `countRepairSpinResealsForAuthor` now counts
   BOTH durable facts: the leading identical-receipt run AND rejecting
   decision repeats beyond the first per distinct subject.
2. **The Discovery output resolver demanded proposal bindings on a failed
   run** (`missing terminal binding 'proposalSchema'`), turning the honest
   §15 terminal into an exception. It now returns null for non-
   go/clarify/reject outcomes, exactly as the Formalization resolver does.
3. **The lifecycle forwarded discovery `failed` → solution-formalization**,
   whose entry conditions require a Discovery certificate that a failed
   Discovery cannot have — the handoff mapping exploded with
   `LIFECYCLE_MAPPING_SOURCE_MISSING: '$.processOutcome.outputPayload'`.
   The route is now `terminal failed` (runtime-only outcome, same shape as
   Formalization's own failed route). Routing-lock and receipt tests updated
   to the corrected expectation; the frozen payload-contract ratchet updated
   7→8 (the reconciliation-report admission from `a5e1d409` landed without
   its ratchet bump — pre-existing red, now fixed).

Also: `discovery-scenario-drive.mjs` gained PROOF_KEEP_DIR retention (the
formalization drive already had it).

Validation: `discovery/proposal-retry-exhaustion` and
`discovery/readiness-retry-exhaustion` BOTH PASS (epoch, real 61s backoff,
terminal failed, never accepted, zero stranded). Regressions green:
discovery happy-go, proposal-feedback-absent, formalization happy +
product-retry-exhaustion; lifecycle-adjacent suites 71/71; contract packs
9/9. Known still-red (pre-existing, verified against baseline):
`discovery/proposal-feedback-exact` — the repair is accepted at the workplace
but the settlement never fires (stage outcome 'go' never recorded, run fails
at 9 cycles). Same supervision family, next session's first candidate.
