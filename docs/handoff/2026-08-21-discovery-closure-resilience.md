# Discovery unified-kernel closure checkpoint

Date: 2026-08-21
Branch: `w0-waves`
Validation status: NOT RUN by operator request. No build, tests, CI or GitLab CI were executed in this tranche.

## Goal

Close workshop 1 (Product Discovery) over the unified Factory conformance kernel before migrating Formalization. The closure must replace model cognition only and prove the real production Factory behavior for:

- exact feedback repair;
- absent feedback;
- stale feedback;
- corrupted feedback;
- worker crash;
- retry exhaustion;
- duplicate submit;
- late tool call;
- restart;
- stale execution fencing;
- idempotency.

## Architecture preserved

The closure adds no Discovery-specific runtime, reducer, Gate, retry engine or lifecycle router.

Every normal case remains:

`declarative scenario -> runScenario -> canonical proof composition -> production Factory -> readonly durable trace -> independent oracles -> ScenarioEvidenceBundle -> coverage kernel`.

Special multi-pass cases (restart and terminal retry exhaustion) still use `driveCanonicalProof` over the same production fresh harness and finish by building the same ScenarioEvidenceBundle. Their special orchestration exists only because one proof spans multiple Factory starts / a real recovery-backoff boundary; no production transition is synthesized.

## New closure surface

`tests/factory-proof/discovery-resilience-pack.mjs`

Adds 19 resilience scenarios on top of the 8 Phase-1 scenarios, for 27 Discovery workshop scenarios total.

Per Proposal and Readiness cell:

- feedback exact;
- feedback absent;
- feedback stale;
- feedback corrupted;
- first worker crash;
- terminal retry exhaustion;
- duplicate product_submit;
- post-worker_done late product_submit;
- stale-execution product_submit after a crash/retry.

Plus one workshop-level restart/idempotency scenario.

## Feedback causality

The scripted actor is deliberately non-omniscient. It receives only a projection of the real recovery feedback present in the next task metadata/desk input.

The actor repairs only when the feedback is exact and contains the expected defect coordinate:

- Proposal: the diagnostic identifies the missing/invalid `rationale` surface;
- Readiness: the diagnostic identifies `proposal_content_hash`.

For `absent`, `stale`, and `corrupted` projections the actor repeats invalid production. The Factory must not magically converge.

This proves causality rather than merely observing a later green Gate.

## Worker crash

The existing canonical scripted executor crash seam fires before the selected handler:

- Proposal: first scripted invocation;
- Readiness: second scripted invocation (after a valid Proposal).

The production `finalizeManagedWorkerProcess` must produce a lost execution, request normal Workplace crash repair, release the fence, allow the Production Cell to requeue, and later accept a fresh execution.

No crash recovery is implemented in the scenario pack.

## Retry exhaustion

Discovery cells declare `maxAttempts=2`, `onExhausted=requeue`.

Production semantics are important: the first local budget exhaustion does NOT immediately fail the cell. It writes an immutable recovery epoch and enters the domain backoff. Epoch 1 backoff is 60 seconds.

`tests/factory-proof/discovery-retry-exhaustion-proof.mjs` therefore performs a real two-phase proof:

1. run persistent invalid cognition until local 2-attempt exhaustion;
2. prove `repair_required`, a durable recovery epoch, and `repair_wait`;
3. cross the real one-minute backoff without mutating clocks/timestamps/authority state;
4. resume the SAME Factory launch;
5. persistent identical diagnosis must terminate the cell honestly as failed;
6. Discovery stage must record `failed`; no target Gate may ever have accepted the invalid material; no execution may remain stranded.

These two scenarios are intentionally slow. They are closure tests, not the fast inner loop.

This proves the real failed routes:

- `produce-proposal -> complete-failed`;
- `assess-readiness -> complete-failed`.

## Duplicate submit / idempotency

A worker calls `product_submit` twice with the byte-identical typed product before `worker_done`.

The second call may be an explicit idempotent replay or a typed denial, but it may not mint a second durable managed submission. The readonly trace observer now includes `factory_managed_node_submissions`, and the independent oracle requires exactly one durable submission for the target node/schema.

## Late tool call

After the normal handler has successfully called `worker_done`, the same execution attempts another `product_submit`.

The probe requires denial. This is intentionally adversarial: if production still allows the execution to mutate its desk after semantic completion, the local test should turn red rather than accepting replay as harmless.

## Stale execution fence

Attempt 1 deliberately dies before producing the target product. After production finalization/requeue, attempt 2 temporarily presents attempt 1's stale `SAGA_EXECUTION_ID` to `product_submit`.

The stale call must be denied by the production execution/task fence. The current attempt then restores its own execution identity and completes normally.

This proves the fence itself, not merely successful eventual recovery.

## Restart / semantic replay

`tests/factory-proof/discovery-restart-proof.mjs` scopes W1-2-style restart evidence to Discovery only and stops after Discovery has emitted `go`.

Three Factory starts share one DB/project/epic:

- A: cold input A;
- B: same semantic input A;
- C: incompatible semantic input B.

Expected:

- three distinct lifecycle starts reach Discovery `go`;
- B performs zero scripted inference and at least two capsule replays (Proposal + Readiness);
- C performs zero replay and at least two scripted inferences;
- no execution is stranded.

This keeps the workshop-1 restart proof independent of Formalization or the old W1-2 reviewer path.

## Coverage closure

`tests/factory-proof/discovery-coverage-drive.mjs` now runs all 27 scenarios in isolated child processes and counts only PASS ScenarioEvidenceBundles as demonstrated coverage.

Success requires:

- every closure scenario produced PASS evidence;
- planned workshop closure = 100%;
- demonstrated workshop closure = 100%;
- no required workshop coverage token remains uncovered.

One Flow edge is deliberately NOT claimed by workshop closure:

`transition:settle->complete-failed`

That edge is an internal deterministic-settlement kernel exception after both cognitive cells have already passed their Gates. It cannot be honestly produced by admitted Discovery worker material. It belongs to the shared K4 kernel fault scheduler; the Discovery pack does not obtain it by DB/timestamp/authority mutation.

The coverage report surfaces it explicitly as `platformFaultEdges`; it is not hidden or counted as covered.

## Local validation order

First build once:

```bash
npm run build
```

Fast contract/kernel checks:

```bash
node --test \
  tests/factory-proof/scenario-evidence.test.mjs \
  tests/factory-proof/scenario-runner.test.mjs \
  tests/factory-proof/coverage-kernel.test.mjs \
  tests/factory-proof/discovery-scenario-pack.test.mjs \
  tests/factory-proof/discovery-resilience-pack.test.mjs
```

Recommended targeted runtime probes before the full matrix:

```bash
node tests/factory-proof/discovery-scenario-drive.mjs discovery/proposal-feedback-exact
node tests/factory-proof/discovery-scenario-drive.mjs discovery/proposal-feedback-absent
node tests/factory-proof/discovery-scenario-drive.mjs discovery/readiness-feedback-exact
node tests/factory-proof/discovery-scenario-drive.mjs discovery/proposal-worker-crash
node tests/factory-proof/discovery-scenario-drive.mjs discovery/proposal-duplicate-submit
node tests/factory-proof/discovery-scenario-drive.mjs discovery/proposal-late-tool-call
node tests/factory-proof/discovery-scenario-drive.mjs discovery/proposal-stale-execution-fence
node tests/factory-proof/discovery-scenario-drive.mjs discovery/restart-idempotency
```

Slow real-backoff proofs:

```bash
node tests/factory-proof/discovery-scenario-drive.mjs discovery/proposal-retry-exhaustion
node tests/factory-proof/discovery-scenario-drive.mjs discovery/readiness-retry-exhaustion
```

Full closure:

```bash
node tests/factory-proof/discovery-coverage-drive.mjs > discovery-closure.json
```

Expected final report properties:

- `schemaVersion = factory.proof.discovery-coverage-report.v2`
- every `scenarios[*].verdict = pass`
- `planned.closure.percent = 100`
- `planned.closure.uncovered = []`
- `demonstrated.closure.percent = 100`
- `demonstrated.closure.uncovered = []`
- `closureDefinition.platformFaultEdges = ["transition:settle->complete-failed"]`

## How to interpret a red

Do not weaken the scenario first.

- exact feedback does not repair -> inspect production recovery feedback materialization/projection;
- absent/stale/corrupted feedback repairs -> hidden signal / actor isolation defect;
- worker crash does not create a fresh accepted execution -> finalizer or `repair_wait -> requeue` defect;
- duplicate submit produces >1 durable row -> managed submission idempotency defect;
- late call is accepted -> semantic-completion tool-fence defect;
- stale execution call is accepted -> execution/task fencing defect;
- local retry exhaustion does not write an epoch -> Production Cell recovery-budget defect;
- post-backoff retry never terminates on repeated diagnosis -> recovery epoch/reason-identity defect;
- restart B performs inference -> replay eligibility/capture defect;
- restart C replays -> semantic replay-key scope defect;
- any `ANONYMOUS-STALL` -> real progress/reconciliation defect, not a scenario expectation problem.

## Remaining normative metadata cleanup

The older central `tests/factory-proof/obligation-contracts.mjs` still has stale descriptive constraint fields for the two Discovery obligations (`outcome` / legacy `fileDeclarations`) even though its provider ids and versions are correct and the new runtime closure uses the current production schemas (`recommended_outcome`, Readiness v2 exact hash/dimensions/source grounding).

Do not derive new Discovery mutations from those stale descriptive fields. Before promoting Discovery closure into the final blocking acceptance group / using the registry as the source for Formalization migration, align those two central normative descriptors with the current schemas. This is test metadata debt, not a production runtime defect, and it was intentionally not patched via a wholesale replacement of the large central registry without local validation.

## Merge boundary

Do not merge `w0-waves` into `saga4` until local closure evidence is green (or a red has been classified and fixed). Production source was not modified in this tranche.
