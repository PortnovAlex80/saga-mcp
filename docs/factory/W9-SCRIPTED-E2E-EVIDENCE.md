# W9 — Scripted E2E Evidence Bundle (W9-04, closes the scripted lane)

> Both scripted scenarios are GREEN and deterministic. The scripted Factory
> reaches durable runnable-local with no authority hacks. This bundle is the
> single evidence index for W9-01..W9-04 and the bounded stabilization backlog
> carried into W10/W11/W12.

## W9 lane result: CLOSED GREEN

| Card | Scenario | Result | Evidence |
|---|---|---|---|
| W9-01 | Fresh scripted harness + run manifest | done | src/factory-e2e/{fresh-harness,run-manifest}.ts; self-test 4/4×3 deterministic |
| W9-02 | Clean scripted happy path → runnable-local | **reached runnable-local** | tests/factory-e2e/w9-02-happy-path.test.mjs (3, 2 drives + determinism). Development `verified` + passed `factory.local-runnability.v1` receipt for the EXACT sealed candidate; fresh state; concurrency ≤2; AUTHORITY_TABLES guard green |
| W9-03 | Adversarial authority + recovery | **3/3 PASS** | tests/factory-e2e/w9-03-adversarial.test.mjs (6, 2× deterministic) |
| W9-04 | Evidence bundle + stabilization tracker | this file | — |

## Invariants proven (scripted, deterministic)

- **Carry-forward-safe task authority (C5):** integration tasks bind to the accepted-authority head (`readAuthorTaskId`), never `submission.task_id` or recency — proven under carry-forward (W9-03 #3: 2/2 integrated tasks match head).
- **Monotonic obligation fencing (C7):** crash → lost classification → repair on the SAME workplace → convergence, with partition invariance (candidate-set count stable, 0 stranded executions) — W9-03 #1.
- **Exact sealed subject across repair (C1/LR):** reviewer reject → repaired author CandidateSet (distinct ref) accepted; authority head points to the accepted set — W9-03 #2.
- **Exact local-ready proof (LR-07):** terminal `verified` requires a passed local-readiness receipt bound to the exact sealed candidate — W9-02.
- **No authority hacks:** the harness's `AUTHORITY_TABLES` no-write guard is green on every drive; all authority rows are created by the production runtime.

## Resolved wiring (was deferred from LR-01/LR-03/LR-04; resolved in W9-02, additive)

The integrated candidate is now (a) sealed into an author CandidateSet at freeze time, (b) carries an explicit readiness profile, (c) resolvable by the local-runnability provider's exact-member resolution, and (d) produces a persisted local-readiness receipt keyed for the LR-07 settlement binding. All additive (fallbacks + freeze-time seal); primary paths unchanged; acceptance matrix green.

## Bounded stabilization backlog (carried to W10/W11/W12 — NOT blockers for scripted W9)

1. **W9-02 happy-path reviewer handler** uses `candidate_read` (hash-order `sets[0]`) instead of the authority head. Latent — correct when there is exactly one author CandidateSet (no repair), wrong under a real-model repair cycle. The W9-03 adversarial handler already reads the head directly. **Action (W10/W11):** align the happy handler to read the head, or confirm real-model runs never hit multi-set repair.
2. **Flaky suites (CI-02 quarantine):** `golden-path`, `parallel-git-desk`, `factory-temporal/*` (orchestrate-cli replay), `local-runnability-check-provider` (real-execution cold-start). The fresh W9 harness is their deterministic successor; stabilize or remove the legacy ones in W12.
3. **Pre-existing-red tests (CI-02 quarantine):** `development-task-graph-diagnostics` (stale producerExecutionRef mock), `worker-done-completion-authority` (imports deleted module), `submission-validator-diagnostics` (assertion drift), `worktree-isolation` (C5-cutover seed). Clean up or delete in W12-01 reconciliation.
4. **Legacy lint debt (CI-01 ratchet):** 84 errors (eqeqeq/prefer-const/no-empty-object-type) across src/tools, src/validators, etc. — see docs/factory/CI-01-LEGACY-LINT-BACKLOG.md.
5. **C7-07 flagged hardening:** `complete()` staleness-read + UPDATE not in one transaction (NOT reachable via the reconciler — the lease CAS is the single-writer gate; no C7 invariant affected).
6. **DFX budget:** 0 of 3 slots consumed. 3 remain for W10/W11.

## Exit rule satisfied

Both scripted scenarios (W9-02, W9-03) are green and deterministic → W9 is closed. The real-model run (W10) does not start until this commit is pushed and the acceptance matrix is green (it is).
