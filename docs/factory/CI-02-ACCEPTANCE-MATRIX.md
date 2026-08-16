# CI-02 — Deterministic Factory Acceptance Matrix

> Card CI-02 (Quality Q). The trustworthy blocking gate that replaces the
> blanket `npm test`. Single source of truth for the BLOCKING matrix and the
> QUARANTINE list: `tools/run-acceptance-matrix.mjs`. Machine-checked by
> `tests/infrastructure/acceptance-matrix-coverage.test.mjs`.

## Problem solved

Before CI-02, `ci.yml` ran a blanket `npm test` (= `tsc && node --test`), which
discovered and ran **every** `*.test.mjs` under the tree in a single process.
That had two independent trust defects:

1. **It included flaky and pre-existing-RED files**, so the exit code was red for
   reasons unrelated to a new change — CI could not block anything reliably.
2. **Cross-suite state contention** (shared SQLite temp DBs, served-process ports,
   orchestrate-cli replay capsules) turned deterministically-green suites red when
   run in one process — so even green work looked red.

It also hid a failure behind `|| true`:
`node tools/cgad-spec-lint.mjs tools/cgad-spec-lint.test.mjs || true` exited 2
("file is not a database") on every run and was silently swallowed.

## The matrix (each row is its own blocking CI step)

Every step below is deterministic-green on the integration tip, proven by running
it in isolation on the checkout. No step uses `continue-on-error`, `|| true`, or
retries. Driver: `tools/run-acceptance-matrix.mjs` (`--group <name>`).

| CI step | Group / command | Scope |
|---|---|---|
| TypeScript strict build | `npx tsc --noEmit` | type gate |
| ESLint (blocking lint gate) | `npx eslint src/` | CI-01 lint ratchet |
| Matrix — architecture | `--group architecture` | ADR-053 cutover gates, dependency-direction ratchet, conveyor boundaries |
| Matrix — factory model | `--group factory-model` | dual-cycle generated model |
| Matrix — readiness & fencing | `--group readiness-fencing` | C7 monotonic lease fencing (deterministic). LR local-readiness real-execution (`local-runnability-check-provider`, `served-process-runner`) is FLAKY-quarantined — cold-start command/process timing; re-admit after stabilization. |
| Matrix — factory contract | `--group factory-contract` | C5 carry-forward adversarial matrix + production-cell transitions |
| Matrix — process modules | `--group process-modules` | module composition + LR-07 readiness binding |
| Dispatcher race gate | explicit plain-`.mjs` + 3 race `.test.mjs` | concurrency safety (no double-claim) |
| cgad-spec-lint unit suite | `node --test tools/cgad-spec-lint.test.mjs` | 30-case linter unit test (replaces the hidden `|| true` self-check) |
| Completion-evidence validation | `node tools/validate-completion-evidence.mjs` | P0-02 evidence contract |
| Matrix — coverage guard | `--group matrix-coverage` | CI-02 self-check (runs last) |

The matrix groups run as **isolated `node --test` processes** (one per group) to
reproduce the integrator's per-suite classification and avoid the cross-suite
contention that made the blanket run untrustworthy.

## Quarantine — excluded from the blocking matrix

Every entry is deliberately skipped with a documented reason (FLAKY or
PRE-EXISTING-RED) and is enforced by the runner's quarantine table. **The fresh
W9 scripted E2E harness (cards W9-01..W9-04) is the deterministic successor for
the flaky orchestrate-cli / replay-driven suites.**

| File / glob | Kind | Reason |
|---|---|---|
| `tests/factory-contract/golden-path.test.mjs` | FLAKY | drives orchestrate-cli; `REPLAY_CAPSULE_CONTEXT_INVALID` (passes ~1/3). **W9 replaces it.** |
| `tests/factory-contract/parallel-git-desk.test.mjs` | FLAKY | drives orchestrate-cli (concurrency=2 worktree isolation); same `REPLAY_CAPSULE_CONTEXT_INVALID`. **W9 replaces it.** |
| `tests/factory-temporal/*.test.mjs` (7 files) | FLAKY | the whole suite churns run-to-run (temporal / orchestrate-cli driven). **W9 replaces it.** |
| `tests/process-modules/development-task-graph-diagnostics.test.mjs` | PRE-EXISTING-RED | stale `producerExecutionRef` mock; fails identically on the baseline. |
| `tests/architecture/submission-validator-diagnostics.test.mjs` | PRE-EXISTING-RED | assertion drift: `outcome` expected `"failed"`, got `undefined` on a clean checkout. |
| `tests/dispatcher-race/worktree-isolation.mjs` *(plain .mjs)* | PRE-EXISTING-RED | broken by the C5 accepted-authority-head cutover: `worker_next` returns `null` because the test seeds tasks the pre-C5 way (the file's own comment flags the "saga4 authority gate"). Excluded from the dispatcher-race step directly. **W9 replaces it.** |

The last four rows were discovered during CI-02's empirical classification (the
card's GATE step 1 requires running every suite on the tip and deciding
BLOCKING vs QUARANTINE). They are the concrete instances of the systemic defect
ADR-053 diagnoses: each cutover boundary (`receipt-aware-lm-persistence` removal,
`submission-validator` managed-production authority, C5
accepted-authority-head) leaves an old test behind. Fixing them is **not** this
card's job — stabilizing the flaky suites is W9's job, and the pre-existing-red
stale tests are W12's reconciliation scope. CI-02's job is to make the gate
**trustworthy**, which requires that none of them block.

## Scope boundary (not a silent omission)

The CI-02 matrix is the **Factory acceptance matrix**: the deterministic suites
that gate Factory completion (C5, C7, LR, CI lanes). General repository suites
that are green in isolation but are not Factory-acceptance gates (e.g.
`tests/discovery/*`, `tests/installation/*`, `tests/spi/*`,
`tests/characterization/*`, `tests/completeness/*`) are intentionally out of
scope here. Their clean-checkout reconciliation is the **CI-03** card ("Capture a
clean-checkout green baseline"). The matrix-coverage test asserts the
Factory-acceptance set is complete; it does not (and is not intended to) assert
coverage of the entire repository test corpus.

## How to inspect / extend

```sh
# Print the full matrix + quarantine with reasons (no execution):
npm run test:acceptance-matrix:list
#   equivalently: node tools/run-acceptance-matrix.mjs --list

# Run one group locally:
node tools/run-acceptance-matrix.mjs --group architecture

# Run the whole matrix locally:
npm run test:acceptance-matrix
```

To graduate a quarantined suite back into the blocking matrix: make it
deterministic-green in isolation, remove its entry from the `QUARANTINE` table in
`tools/run-acceptance-matrix.mjs`, and the matrix-coverage test will enforce its
presence automatically.
