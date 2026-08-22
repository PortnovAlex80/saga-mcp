# Discovery — Unified Kernel Pack Handoff

Date: 2026-08-21
Branch: `w0-waves`
Status: CANDIDATE IMPLEMENTATION — NOT EXECUTED IN THIS SESSION

## Purpose

This tranche turns Product Discovery into the first workshop-specific scenario pack on top of the shared Factory proof kernel.

The pack does not implement a Discovery runner, gate emulator, state machine, retry loop, or lifecycle router. It contributes only:

- declarative scenario definitions;
- cognition-only scripted stimuli built by wrapping the existing W9 happy handlers;
- independent mechanical oracles over the shared durable trace;
- a Phase-1 coverage universe and a larger honest full-conformance universe;
- isolated scenario and aggregate coverage entrypoints.

Every runtime case executes through `tests/factory-proof/scenario-runner.mjs` → canonical composition → production `driveFreshHarness` → production Factory runtime.

## Files

- `tests/factory-proof/discovery-scenario-pack.mjs`
- `tests/factory-proof/discovery-scenario-pack.test.mjs`
- `tests/factory-proof/discovery-scenario-drive.mjs`
- `tests/factory-proof/discovery-coverage-drive.mjs`
- `tests/factory-proof/trace-observer.mjs` (extended with StageRun / lifecycle transition / process certificate evidence)

## Phase-1 scenarios

1. `discovery/happy-go`
2. `discovery/happy-clarify`
3. `discovery/happy-reject`
4. `discovery/proposal-deleted-outcome`
5. `discovery/proposal-missing-required-field`
6. `discovery/readiness-wrong-proposal-hash`
7. `discovery/readiness-invented-source-ref`
8. `discovery/readiness-missing-dimension`

The negative cases mutate only the worker's `product_submit` payload. The production tool, CandidateSet sealing, CheckProvider, GateDecision, recovery machinery and lifecycle routing remain real.

## What Phase 1 is intended to prove

- Proposal contract accepts the lawful closed outcome vocabulary and rejects a deleted word / missing required field.
- Readiness binds the exact accepted Proposal content hash.
- Readiness rejects a foreign Proposal hash.
- Readiness source refs are grounded in the accepted Proposal surface.
- Readiness rejects invented evidence refs.
- Readiness contains the complete seven-dimension assessment surface.
- Proposal and Readiness Gates exercise both `accepted` and `repair_required` decisions.
- Positive Discovery executes `produce-proposal -> assess-readiness -> settle`.
- Settlement exercises `go`, `clarify`, and `reject` outputs.
- Every producible Discovery strength code routes to Formalization under the current permissive lifecycle policy.
- The Discovery -> Formalization handoff preserves exact outcome, certificate ref/hash, Proposal ref/hash and Proposal payload across the durable StageRun boundary.
- No scenario exits with a stranded active WorkerExecution.
- Every post-drain Workplace is classified by the shared progress oracle (no anonymous stall).

## Deliberately NOT claimed by Phase 1

`DISCOVERY_FULL_COVERAGE_UNIVERSE` keeps these gaps visible and therefore prevents the 8-scenario pack from being called full Discovery conformance:

- `produce-proposal -> complete-failed`
- `assess-readiness -> complete-failed`
- `settle -> complete-failed`
- exact-feedback repair causality for both cells
- absent/stale/corrupted feedback counterfactuals for both cells
- stale-execution fencing for both cells
- duplicate-submit idempotency for both cells
- bounded crash recovery for both cells

The strict feedback/counterfactual/fence/crash set belongs with the CanonicalSpawn / K4 fault-schedule tranche; it should not be faked inside CanonicalFast.

## Local checkpoint

Build once:

```bash
npm run build
```

Pure pack/coverage declaration check:

```bash
node --test tests/factory-proof/discovery-scenario-pack.test.mjs
```

One real canonical scenario:

```bash
node tests/factory-proof/discovery-scenario-drive.mjs discovery/happy-go
```

Run the entire Phase-1 Discovery pack and compute demonstrated coverage from PASS EvidenceBundles only:

```bash
node tests/factory-proof/discovery-coverage-drive.mjs > discovery-coverage.json
```

Expected successful report properties:

```text
planned.phase1.percent == 100
demonstrated.phase1.percent == 100
demonstrated.phase1.uncovered == []
every scenarios[*].verdict == "pass"
```

`demonstrated.full.percent` is expected to remain below 100 until the explicitly listed strict recovery/fault scenarios are implemented.

## Failure interpretation

- Proposal/Readiness CheckReceipt is `failed` but no `repair_required` GateDecision: inspect gate/reconciliation ownership, not the scripted worker.
- Positive Discovery certificate is correct but exact handoff oracle fails: inspect lifecycle output/input mapping or durable handoff projection.
- A negative case produces a Discovery certificate or Formalization StageRun: this is a fail-open Factory defect.
- A negative case ends as `ANONYMOUS-STALL`: this is a production recovery/progress defect, not a reason to add a test-side retry.
- Scenario exits with active WorkerExecutions: inspect finalization/fence release.

## Known normative-registry cleanup

The global `tests/factory-proof/obligation-contracts.mjs` still carries older descriptive Discovery constraint fields (`outcome`, `fileDeclarations`) from a previous Discovery shape. The new runtime pack targets the current production contracts (`recommended_outcome`, content-hash-bound Readiness v2 and seven grounded dimensions), but the global normative descriptions should be updated before treating the global obligation compiler as semantically current for Discovery. This is metadata/negative-generation debt; it must not be "fixed" by changing current production Discovery back to the old shape.

No production source file was modified by this Discovery tranche.
