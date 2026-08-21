# Unified Test Kernel — Three-Step Refactor Handoff (2026-08-21)

Status: IMPLEMENTED ON `w0-waves`, NOT LOCALLY EXECUTED IN THIS SESSION.

This tranche intentionally does not change Factory transition, Gate, retry,
Workplace, CandidateSet, lifecycle-routing or effect semantics. It composes the
already-existing proof pieces into one test kernel.

## Step 1 — ScenarioEvidenceBundle

Files:
- `tests/factory-proof/scenario-evidence.mjs`
- `tests/factory-proof/scenario-evidence.test.mjs`
- `tests/factory-proof/trace-observer.mjs`

Decision:
Every live scenario produces the same immutable evidence contract. The bundle
binds the complete declarative scenario, proof modes, canonical composition
fingerprint, installation fingerprint, normalized durable trace, actor/fault
journals, independent oracle results, terminal observation and counterexample.

Observer hardening:
- `worker_executions` is read by `execution_id AS execution_ref` (production
  schema identity; the old observer queried `execution_ref`).
- only `no such table` is normalized to an empty evidence class;
- column/schema/query drift is now fail-closed instead of silently becoming `[]`.

## Step 2 — Generic ScenarioRunner

Files:
- `tests/factory-proof/scenario-runner.mjs`
- `tests/factory-proof/scenario-runner.test.mjs`
- `tests/factory-proof/unified-kernel-smoke-drive.mjs`

Execution chain:

`scenario -> canonical composition -> production drive -> readonly trace -> progress oracle -> independent scenario oracles -> ScenarioEvidenceBundle`

The runner accepts:
- the existing strict `CausalFaultScenario` unchanged; and
- a small `KernelScenario` envelope for positive/recovery paths.

It rejects dishonest proof-mode composition:
- in-process cognition must declare `CanonicalFast`;
- `workerSpawn` must declare `CanonicalSpawn`;
- one execution cannot claim both;
- `FaultSchedule` remains blocked until K4 actually lands.

Legacy drives are deliberately retained for evidence-parity comparison.

## Step 3 — Mathematical Coverage Kernel

Files:
- `tests/factory-proof/coverage-kernel.mjs`
- `tests/factory-proof/coverage-kernel.test.mjs`

The coverage universe is an open set of namespaced tokens. It can represent:
- normative obligations;
- Gate outcomes;
- allowed transitions;
- forbidden/negative transitions;
- transition pairs / bounded paths;
- fault classes and injection boundaries;
- detector coverage;
- repair owners;
- feedback counterfactuals.

For scenario set S and required item universe U, the matrix is

`M[i,j] = 1 iff scenario i covers required item j`.

Selection solves

`min sum(x_i)`

subject to

`for every u_j in U: sum(M[i,j] * x_i) >= 1`.

For small corpora the implementation uses deterministic exact branch-and-bound
set cover. Above the configured exact limit it switches to deterministic greedy
maximum-new-coverage selection.

Crucial distinction:
- `buildScenarioCoverageMatrix` is planning coverage from declarations;
- `buildEvidenceCoverageMatrix` is demonstrated coverage from executed bundles;
- by default failed/inconclusive bundles contribute ZERO demonstrated coverage.

This prevents a declared but broken negative scenario from making the matrix
look green.

## Local validation checkpoint

No build or tests were run during this refactor.

Recommended first local commands:

```bash
npm run build
node --test \
  tests/factory-proof/scenario-evidence.test.mjs \
  tests/factory-proof/scenario-runner.test.mjs \
  tests/factory-proof/coverage-kernel.test.mjs \
  tests/factory-proof/scenario-actor-observer.test.mjs
```

Then exercise the real new kernel:

```bash
node tests/factory-proof/unified-kernel-smoke-drive.mjs > unified-kernel-evidence.json
```

The process should exit 0 and the emitted bundle should have `verdict: "pass"`.

Then return to the open W1-2 recovery proof:

```bash
node tests/factory-proof/w1-2-factory-restart-drive.mjs
```

The decisive observation remains: after the deliberately invalid reviewer
capsule replay, the production finalizer must move the Workplace through normal
crash repair and allow a fresh execution. If that still stalls, diagnose the
production `repair_wait -> requeueForRepair` reconciliation; do not add another
test-side recovery branch.

## Admission rule

Do not add the three new `*.test.mjs` files to the blocking acceptance-matrix
group until the first local green run. After green, register them together with
proof claims in one ratchet commit.
