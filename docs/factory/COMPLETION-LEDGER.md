# Factory Completion — Execution Ledger (P0-01)

> Living document. The integrator updates one row per accepted step
> (status → `done`, commit SHA, evidence ref). Do **not** edit a row ahead of its card.
> Baseline & rules: see `COMPLETION-BASELINE.md`.

## Status legend

`pending` · `in_progress` · `done <sha>` · `dfx <sha>` (consumed a reserved slot) · `blocked <reason>` · `no-go`

## Phase P0 — pin baseline & contract

| ID | Outcome | Lane | Depends | Status | Commit | Evidence |
|---|---|---|---|---|---|---|
| P0-01 | Pin completion baseline and finish line | Integrator | — | done | docs(factory): pin completion baseline and finish line | docs/factory/COMPLETION-BASELINE.md, COMPLETION-LEDGER.md |
| P0-02 | Install the atomic task and evidence contract | Integrator | P0-01 | done | chore(factory): enforce atomic completion task evidence | docs/factory/COMPLETION-EVIDENCE-CONTRACT.md; tools/validate-completion-evidence.mjs |

## Phase C5 — exact task authority (carry-forward-safe)

| ID | Outcome | Lane | Depends | Status | Commit | Evidence |
|---|---|---|---|---|---|---|
| C5-01 | Persist task identity on accepted-authority head | Authority A | P0-02 | done | feat(factory): persist task identity on accepted authority head | schema factory_accepted_authority_head.accepted_author_task_id; sqlite-accepted-authority-head-repository; tests/infrastructure/accepted-authority-head.test.mjs (6) |
| C5-02 | Bind current workplace task at final author acceptance | Authority A | C5-01 | done | fix(factory): bind accepted authority to current workplace task | production-cell-coordinator.ts + node-executor.ts (resolveAcceptedAuthorTaskId via readExecutionReceipt, not submission.task_id); tests/process-modules/production-cell-{coordinator,node-executor}.test.mjs |
| C5-03 | Cut git integration over to material-authority task identity | Authority A | C5-02 | pending | fix(factory): select git integration task from accepted authority | — |
| C5-04 | Add the adversarial C5 regression matrix | Verification V | C5-03 | pending | test(factory): prove carry-forward-safe integration task binding | — |
| C5-05 | Ratchet and close C5 | Integrator | C5-04 | pending | test(adr-053): ratchet exact integration task authority | — |

## Phase C7 — monotonic lease fencing

| ID | Outcome | Lane | Depends | Status | Commit | Evidence |
|---|---|---|---|---|---|---|
| C7-01 | Separate causal source revision from lease fencing | Fencing B | P0-02 | done | refactor(factory): separate obligation revision from lease fence | domain transition-obligation.ts (CausalSourceRevision/LeaseFence brands); tests/infrastructure/transition-obligation-fence-separation.contract.test.mjs |
| C7-02 | Add durable monotonic lease-fence storage | Fencing B | C5-01, C7-01 | done | feat(factory): persist monotonic obligation lease fences | schema factory_transition_obligations.lease_fence (v7, additive); sqlite-transition-obligation-ledger.ts monotonic MAX(COALESCE); tests/infrastructure/transition-obligation-lease-fence-storage.test.mjs (7) |
| C7-03 | Allocate lease fences atomically in the ledger | Fencing B | C7-02 | pending | fix(factory): allocate obligation fences atomically | — |
| C7-04 | Require owner and fence for obligation completion | Fencing B | C7-03 | pending | fix(factory): fence obligation completion by lease token | — |
| C7-05 | Fence failure, expiry, and reclaim transitions | Fencing B | C7-04 | pending | fix(factory): fence obligation failure and reclaim | — |
| C7-06 | Cut reconciler and Production Cell over to real fences | Fencing B | C7-05 | pending | fix(factory): propagate real obligation fence authority | — |
| C7-07 | Prove temporal fencing and close C7 | Verification V | C7-06 | pending | test(adr-053): prove monotonic obligation fencing | — |

## Phase LR — local readiness (close W5)

| ID | Outcome | Lane | Depends | Status | Commit | Evidence |
|---|---|---|---|---|---|---|
| LR-01 | Resolve exact runnable product from sealed CandidateSet | Readiness C | C5-03 | pending | fix(factory): resolve local readiness from exact candidate set | — |
| LR-02 | Verify exact Git object and archive authority | Readiness C | LR-01 | pending | fix(factory): verify exact git object for local readiness | — |
| LR-03 | Make dependency install and tests deterministic | Readiness C | LR-02 | pending | fix(factory): make local readiness commands deterministic | — |
| LR-04 | Require explicit served or static readiness profiles | Readiness C | LR-03 | pending | feat(factory): make local readiness profile explicit | — |
| LR-05 | Isolate, observe, and terminate the local process reliably | Readiness C | LR-04 | pending | fix(factory): isolate and terminate local readiness processes | — |
| LR-06 | Make local-readiness evidence durable and replay-safe | Readiness C | C7-07, LR-05 | pending | fix(factory): make local readiness evidence durable | — |
| LR-07 | Bind Development settlement to exact local-ready proof; close W5 | Integrator | LR-06 | pending | test(factory): bind terminal state to exact local readiness proof | — |

## Phase CI — blocking acceptance gate

| ID | Outcome | Lane | Depends | Status | Commit | Evidence |
|---|---|---|---|---|---|---|
| CI-01 | Make lint clean and blocking | Quality Q | C5-05, C7-07, LR-07 | pending | ci(factory): make lint a blocking acceptance gate | — |
| CI-02 | Run the explicit Factory acceptance matrix in CI | Quality Q | CI-01 | pending | ci(factory): execute the full deterministic acceptance matrix | — |
| CI-03 | Capture a clean-checkout green baseline | Integrator | CI-02 | pending | test(factory): record clean deterministic acceptance baseline | — |

## Phase W9 — scripted E2E (fresh state, concurrency ≤ 2, no authority hacks)

| ID | Outcome | Lane | Depends | Status | Commit | Evidence |
|---|---|---|---|---|---|---|
| W9-01 | Create the fresh scripted E2E harness and run manifest | E2E E | LR-04 | pending | test(factory): add fresh scripted completion harness | — |
| W9-02 | Run the clean scripted happy path to runnable-local | E2E E | CI-03, W9-01, LR-07 | pending | test(factory): prove clean scripted product build to local ready | — |
| W9-03 | Run the adversarial scripted authority and recovery path | E2E E | W9-02 | pending | test(factory): prove authority and recovery under scripted e2e | — |
| W9-04 | Close W9 with a single evidence bundle | Integrator | W9-03 | pending | docs(factory): close clean scripted e2e evidence | — |

## Phase W10/W11 — real GLM-4.7 product build & inspection

| ID | Outcome | Lane | Depends | Status | Commit | Evidence |
|---|---|---|---|---|---|---|
| W10-01 | Freeze the clean GLM-4.7 run profile | Integrator | W9-04 | pending | chore(factory): freeze clean glm-4.7 acceptance run | — |
| W10-02 | Execute the clean real-model product build | Operator + Integrator | W10-01 | pending | test(factory): record clean glm-4.7 product build | — |
| W11-01 | Inspect the produced product and close W10/W11 | Verification V | W10-02 | pending | test(factory): verify real product and runtime acceptance evidence | — |

## Phase W12 — reconcile, runbook, final declaration

| ID | Outcome | Lane | Depends | Status | Commit | Evidence |
|---|---|---|---|---|---|---|
| W12-01 | Reconcile every source-of-truth status | Integrator | W11-01 | pending | docs(factory): reconcile completion sources of truth | — |
| W12-02 | Publish the operator runbook and bounded backlog | Integrator | W12-01 | pending | docs(factory): add completion runbook and bounded backlog | — |
| W12-03 | Make the final go/no-go declaration and tag | Integrator | W12-02 | pending | docs(factory): declare final factory completion result | — |

## DFX budget (reserved defect/split slots)

| Slot | Consumed by | Regression test | Fix | Status |
|---|---|---|---|---|
| DFX-1 | — | — | — | available |
| DFX-2 | — | — | — | available |
| DFX-3 | — | — | — | available |

> 4th live defect → W12-03 becomes a documented **no-go**. The plan is not expanded.
