# Phase 5 — Move Recovery Logic From Platform Orchestration Into Typed Module + Lifecycle Contracts

**Branch:** `saga4`
**Scope:** READ-ONLY investigation output. This document is the only artifact. No source is modified.
**Goal:** Move all recovery logic out of platform orchestration into typed module + lifecycle contracts. Replace the global `RECOVERY_TREE` with module-declared recovery policies. The infrastructure executes declared recovery; it does not invent domain repair logic.

---

## 0. Executive Summary

There are **three** recovery mechanisms in saga-mcp today. They are layered, partly duplicated, and unequally wired:

1. **`RECOVERY_TREE` (platform orchestration)** — `src/orchestrate.ts:99-311`. A global, in-memory, episode-stage-keyed lookup table of heal rules. It spawns `recovery.heal` tasks whose only instruction is "Load skill `autonomous-recovery` and run its 6-step loop." This is **platform-invented domain repair**. It is the mechanism this phase must DELETE. (Phase 3 already lists `orchestrate.ts` for full deletion; this phase specifies the recovery portion and where its responsibilities migrate.)

2. **Legacy `flow.recovery[]` arrays (`FlowRecoveryDefinition`)** — declared inside the Formalization and Development module *flows* (`formalization-process-module.ts:223`, `development-process-module.ts:239`). This IS consumed: `generic-flow-executor.ts` `reconcileRecoveryCheckpoint` reads `module.flow.recovery` to record issues via `RecoveryCaseRepository` and route feedback back to the producer node. **Durable and bounded** (`maxAttempts` enforced atomically by the repository). This is the live, correct module-declared recovery the platform tree must collapse into.

3. **New SPI `*_RECOVERY_POLICY_BINDINGS` (`RecoveryPolicyBinding`)** — one aggregate per module in `package/contributions/recovery-policies.ts`. This is the intended *target* vocabulary (Wave 1 SPI). **Declared and validated, but NOT WIRED.** `UniversalRecoveryEngine`, `routeRecoveryAction`, and all four `*_RECOVERY_POLICY_BINDINGS` aggregates have **zero production consumers** (verified by importer grep; only a comment in `recovery-policies.ts` mentions `recovery-engine.ts`). The per-execution-profile `retryPolicy` / `recoveryPolicy` fields on every module profile are likewise **never consumed by any executor**.

**Net migration target:** recovery policy must be **declared per module** (it already is, twice — via `flow.recovery[]` and via `RecoveryPolicyBinding`), **executed by the generic runtime** (`generic-flow-executor` + `RecoveryCaseRepository`, already wired to `flow.recovery[]`), and **routed to terminal outcomes by the lifecycle** (`product-delivery-lifecycle.ts` `outcomeRoutes`, already declarative). What must be **deleted** is the platform tree and its three spawners; what must be **AUDITED/completed** is the SPI binding layer (either fold it into `flow.recovery[]` or wire `UniversalRecoveryEngine` to consume it) plus the four-way gap that Discovery and Delivery have no durable repair loop at all.

---

## 1. The Global `RECOVERY_TREE` (Platform Orchestration) — DELETE

**File:** `src/orchestrate.ts`
**Lines:** type `RecoveryRule` (99-104); the const `RECOVERY_TREE` (106-311); `Saga2PumpState.healRetries` (76).

### 1.1 Structure

`RECOVERY_TREE` is `Record<string, RecoveryRule[]>` keyed by **episode stage name** (`formalization`, `planning`, `development`, `verification`, `integration`). Each rule:

```ts
interface RecoveryRule {
  match: RegExp;          // tested against the gate error string
  diagnosis: string;      // one-line root cause
  action_prompt: string;  // inline prompt for the recovery worker
  max_retries: number;    // platform-side budget before escalating to human
}
```

### 1.2 What it covers and spawns (per stage)

| Stage | # rules | What the gate error must match | Diagnosis / what it heals |
|---|---|---|---|
| `formalization` | 4 | `no AC artifacts`; `AC baseline is not accepted and clean`; `Traceability gate failed:`; `no PRD\|SRS\|UC artifacts` | Re-creates missing artifacts, refreshes stale hashes, re-accepts ACs, `trace_add`s missing lineage edges |
| `planning` | 1 | `no planning tasks exist` | `task_create`s a `planning.decomposition` task |
| `development` | 2 | `no development tasks exist`; `tasks not completed/integrated: #N,#M` | Re-runs planner; adjudicates merge conflicts |
| `verification` | 1 | `no passing.*evidence.*AC-NN` | Classifies each blocked AC; moves dev tasks back to `todo` for rework; re-spawns verifiers that never ran |
| `integration` | 1 | `no integration tasks exist` | `task_create`s an `integration.merge` task |

Every rule's `action_prompt` begins with the same line: **`'Load skill "autonomous-recovery" and run its 6-step recovery loop.'`**. The healer task is created with `task_kind:"recovery.heal"`, `role:recovery`, and the prompt embedded in `task.description` (`createRecoveryTask`, line 572).

### 1.3 Why this is platform-invented domain repair (the violation)

The plan states: *"Infrastructure executes declared recovery. It does not invent domain repair logic."* The `RECOVERY_TREE` violates this in three ways:

- **It encodes domain knowledge in the platform.** "If ACs are missing, write them using saga-analyst semantics (Given/When/Then, `derived_from` → UC + FR)" (`orchestrate.ts:133`) is product-domain repair logic living in the engine pump, not in any module contract.
- **It dispatches a generic healer with a free-form mandate.** The healer can `trace_add`, `artifact_update`, `artifact_save`, `task_update({_recovery_override:true, status:"todo"})`, `task_create` — i.e., it can rewrite any module's artifacts and rewind any producer task, with no module contract consulted. The module being healed has no say in what repair is allowed.
- **It has no durable contract.** The budget is in-memory (see §1.4). There is no `RecoveryPolicyBinding`, no `RecoveryCase`, no `recoveryIssue`. The repair is ad-hoc and invisible to the process-module recovery system.

### 1.4 Budget is volatile (not durable)

`state.healRetries: Map<string, number>` (`orchestrate.ts:76`) lives **only in the pump process**. The key is `${epicId}:${stage}:${diagnosis}` (line 561). On a crash or engine restart the entire retry budget resets to 0 — the same gate failure can be healed indefinitely across restarts. Only `lastHealError` / `lastHealAttempt` are persisted (to episode metadata, `writeEpisodeMeta`, line 427); the actual counts are not. This fails the "retry budget bounded & durable" requirement.

The budget is also reset on every *change* of the gate error string (`resetHealRetriesForEpic`, line 1120-1124), so a healer that mutates state and produces a *different* failure gets a fresh full budget — a latent loop risk.

---

## 2. The Three Platform Spawners — DELETE

All three live in `src/orchestrate.ts` and create `recovery.heal` tasks via `createRecoveryTask`. Phase 3 already marks `orchestrate.ts` for full deletion; these are called out because their *responsibilities* must migrate to module contracts, not just disappear.

### 2.1 `attemptHeal` (line 541)

Match the gate error against `RECOVERY_TREE[stage]`. If a rule matches and the (volatile) budget allows, spawn a `recovery.heal` task. Returns `applied:true` / `escalate:true`. Called from the pump loop at line 1125.

### 2.2 `spawnGenericRecoveryTask` (line 596)

The **catch-all** when no `RECOVERY_TREE` rule matches the gate error. Spawns a `recovery.heal` task with `generic:true` whose prompt is *"You are the catch-all … run the autonomous-recovery 6-step loop."* Budget: a separate volatile counter `${epicId}:${stage}:generic`, capped at 2 (line 1148). This is the most blatant platform-invented-recovery path: any unanticipated gate failure is handed to a free-form healer with no module contract at all.

### 2.3 `spawnPostTransitionRecovery` (line 651)

After a stage transition, any task with `workflow_stage=<old stage>` that is not `done` is invisible to workers (the stage filter blocks cross-stage claims). Instead of bookkeeping, the engine spawns a `recovery.heal` task with `post_transition_sweep:true` that runs autonomous-recovery to close/rewind each stranded task. Called from line 501.

**Migration note:** strand-resolution is genuinely platform bookkeeping, but it should be a deterministic sweep (close `summary.stage`/`recovery.heal`; rewind real work to the new stage), not a delegated decision loop. The lifecycle orchestrator's stage-transition path should own this deterministically, not spawn a healer.

---

## 3. The `autonomous-recovery` Skill — Platform-Level Domain-Repair Injection

**File:** `C:\Users\user\.zcode\skills\autonomous-recovery\SKILL.md`

### 3.1 What it is

A worker skill that runs a 6-step decision loop (Diagnose → Cynefin triage → 3 candidate options → MCDA scoring → apply + verify → record) to "FIX saga engine failures without escalating to a human." It is loaded **only** by `recovery.heal` tasks (every `RECOVERY_TREE` rule and both generic spawners prepend *"Load skill autonomous-recovery"*).

### 3.2 Does it violate "infrastructure executes declared recovery; it does not invent domain repair logic"?

**Yes, in its current form.** The skill is explicitly the inventor of domain repair:

- Its own description says it "FIX[es] saga engine failures" and "Can move tasks backwards (`status=todo`) to force rework" based on its own judgment.
- Step 2 (Cynefin triage) and Step 3 (option generation) instruct the agent to **decide** the correct repair: "find the RIGHT UC (or determine that AC-5 is NFR-only and the gate should exempt it)" is a product-domain determination.
- Its "powers" list (§Step 5) grants `trace_add`, `artifact_update`, `artifact_save`, `task_update` backwards, and `task_create` — domain repair actions taken on the agent's own authority, guided only by an MCDA matrix, not by any module-declared policy.
- The skill's anti-pattern section explicitly endorses the agent deciding engineering trade-offs ("which library?", "standalone or backend?") instead of asking a human.

This is precisely the "infrastructure invents domain repair logic" the plan forbids. The skill *embeds repair policy in a prompt rather than in the engine*, but it is still platform-orchestration recovery: it is dispatched by the engine (`recovery.heal`), given an arbitrary mandate, and consults no `RecoveryPolicyBinding`.

### 3.3 Verdict and disposition

- **DELETE the loading of this skill from all platform spawners.** When the `RECOVERY_TREE` and the three spawners go (Phase 3 / §1-2), the `autonomous-recovery` skill loses its only callers. Nothing else in the codebase loads it (confirmed: only `orchestrate.ts` references it).
- **The skill file itself** (`SKILL.md`) is out of repo scope (it lives in `C:\Users\user\.zcode\skills\`). It becomes dead on disk once its callers are removed; removing the skill file is a separate, out-of-repo cleanup. Do not migrate its prompt into any module contract — the whole point of the cutover is that repair *policy* (which node routes back to which producer, how many attempts) is declared as data (`RecoveryPolicyBinding` / `flow.recovery[]`), not encoded in a heuristic prompt.
- **What survives:** the *shape* of a recovery decision (diagnose → bounded options → apply → record) is sound and is already embodied structurally by `UniversalRecoveryEngine.recordAndRoute` + `generic-flow-executor.reconcileRecoveryCheckpoint` + the `RecoveryFeedback` envelope. The skill's MCDA heuristics do not survive as infrastructure; the module's declared policy is the only authority.

---

## 4. Module-Declared Recovery — What Each Module CURRENTLY Declares

Two parallel declaration surfaces exist per module:

- **A. Legacy `flow.recovery[]`** (`FlowRecoveryDefinition`): `{ id, verifyNodeId, repairNodeId, triggerEvents, resolvedEvents, maxAttempts, onExhausted }`. Lives inside the module's `flow`. **Consumed** by `generic-flow-executor.reconcileRecoveryCheckpoint`.
- **B. New SPI `*_RECOVERY_POLICY_BINDINGS`** (`RecoveryPolicyBinding`): `{ nodeId, actionMap: { reasonCode → RecoveryAction } }`. Lives in `package/contributions/recovery-policies.ts`. **NOT consumed** (dead code, but declared and validated).

`RecoveryAction` union (`src/process-modules/domain/spi/recovery-definitions.ts:107`): `'retry-current-node' | 'return-to-producer' | 'enter-recovery-node' | 'request-human' | 'pause-external' | 'escalate' | 'terminate'`.

Per-execution-profile fields (every LM profile in all four modules) are also **declared but not consumed**: `retryPolicy: { maxAttempts, retryOn[], backoff }` and `recoveryPolicy: { resumeFromCheckpoint, reuseWorkIntent, reuseAcceptedOutput, onExhausted }`.

### 4.1 Discovery (`src/process-modules/modules/discovery/discovery-process-module.ts`)

- **`flow.recovery[]`:** NONE. The flow has no `recovery` array. Repair routing is expressed only via the `transitions` graph (e.g. `resolve-proposal-submission → prepare-normalization on domain.normalization-required`; `→ complete-failed on domain.invalid-json/failed`).
- **`*_RECOVERY_POLICY_BINDINGS`:** `DISCOVERY_RECOVERY_POLICY_BINDINGS` (5 bindings): proposal-submission, normalized-proposal, readiness, settlement, diagnosis-advisor. Covers `domain.normalization-required → enter-recovery-node`, `domain.repair-required → return-to-producer`, `domain.missing/failed → escalate`, `domain.paused → pause-external`, `domain.go/clarify/reject/defer/inconclusive → terminate`.
- **Profile retry/recovery:** all four profiles (`discovery-proposal-worker`, `discovery-normalizer`, `discovery-readiness-advisor`, `discovery-diagnosis-advisor`) declare `retryPolicy.maxAttempts:2` and `recoveryPolicy.onExhausted: 'fail'|'pause'`.
- **Outcomes:** `go, clarify, reject, defer, inconclusive, failed` (all terminal).
- **Active durable repair loop:** NONE. Normalization-required is a happy-path transition, not a bounded repair loop; there is no `RecoveryCase` for discovery.

### 4.2 Formalization (`src/process-modules/modules/formalization/formalization-process-module.ts`)

- **`flow.recovery[]`:** 5 entries (lines 223-269) — **the richest durable repair surface in the system**:

  | id | verify | repair | triggers | maxAttempts | onExhausted |
  |---|---|---|---|---|---|
  | `repair-product-contract` | `resolve-product-contract` | `define-product-contract` | `repair-required`, `acceptance-blocked` | 2 | `pause` |
  | `repair-use-case-contract` | `resolve-use-cases` | `model-use-cases` | `repair-required`, `acceptance-blocked` | 2 | `pause` |
  | `repair-acceptance-contract` | `resolve-acceptance-contract` | `define-acceptance-contract` | `repair-required`, `acceptance-blocked` | 2 | `pause` |
  | `repair-reconciliation` | `resolve-reconciliation` | `reconcile-what` | `repair-required` | 2 | `escalate` |
  | `repair-architecture-contract` | `resolve-architecture-contract` | `define-architecture-contract` | `repair-required`, `acceptance-blocked` | 2 | `escalate` |

- **`*_RECOVERY_POLICY_BINDINGS`:** `FORMALIZATION_RECOVERY_POLICY_BINDINGS` (7): product, use-cases, acceptance, reconciliation, baseline-freezer, architecture, settlement. Mirrors `flow.recovery[]` plus the two kernel-only nodes (baseline freezer, settlement) the legacy array omits. Adds `clarification-required → request-human`, `drift-detected → terminate`, `infeasible → terminate`, `inconsistent → escalate/terminate`.
- **Profile retry/recovery:** all five profiles declare `retryPolicy.maxAttempts:2`, `recoveryPolicy.onExhausted: 'pause'|'escalate'`.
- **Outcomes:** `formalized, clarification-required, inconsistent, infeasible, failed` (all terminal).
- **Active durable repair loop:** YES — `generic-flow-executor.reconcileRecoveryCheckpoint` records each verifier issue via `RecoveryCaseRepository.recordIssue`, enforces `maxAttempts` atomically, and on exhaustion throws `RecoveryExhaustedError` (`onExhausted:'fail'`) or `ProcessRunPausedError`. This is the model the other modules should follow.

### 4.3 Development (`src/process-modules/modules/development/development-process-module.ts`)

- **`flow.recovery[]`:** 1 entry (lines 239-249): `repair-development-task-graph` — verify `resolve-task-graph` → repair `plan-task-graph`, trigger `domain.repair-required`, `maxAttempts:2`, `onExhausted:pause`. **This is the only declared repair loop**; the comment in `recovery-policies.ts` confirms the deliberate narrowness.
- **`*_RECOVERY_POLICY_BINDINGS`:** `DEVELOPMENT_RECOVERY_POLICY_BINDINGS` (5): resolve-task-graph, execute-implementation-workset, integrate-release-candidate, verify-acceptance-workset, settlement. Beyond the planner loop it maps everything else to terminal/escalate (rework-required, blocked, candidate-drifted, verification-denied → `escalate`/`terminate`; runtime failures → `retry-current-node`). Rationale (per the file): the candidate is immutable after freeze, so post-freeze failures are not repairable within the run.
- **Profile retry/recovery:** the single LM profile (`development-planner`) declares `retryPolicy.maxAttempts:2`, `recoveryPolicy.onExhausted:pause` (lines 415-420).
- **Outcomes:** `verified, rework-required, clarification-required, blocked, failed` (all terminal).
- **Active durable repair loop:** YES, but only for the planner task-graph gap. All other verifier/external failures route directly to settlement's terminal outcomes (no `RecoveryCase`, no repair).

### 4.4 Delivery (`src/process-modules/modules/delivery/delivery-process-module.ts`)

- **`flow.recovery[]`:** NONE. No `recovery` array. (Delivery's nodes are deterministic kernel/external/human adapters, not LM producers that re-author on feedback.)
- **`*_RECOVERY_POLICY_BINDINGS`:** `DELIVERY_RECOVERY_POLICY_BINDINGS` (5): preflight, approval, publication, observation, settlement. Maps `preflight-check-missing/receipt-missing/observation-mismatched → return-to-producer` (re-read), `action-uncertain → pause-external` (the idempotency-driven path, invariant `delivery.observe-before-retry`), `approval-required → request-human`, terminal outcomes → `terminate`.
- **Profile retry/recovery:** delivery has no LM execution profiles (all kernel/external/human), so the per-profile `retryPolicy`/`recoveryPolicy` surface is empty.
- **Outcomes:** `released, approval-required, blocked, failed` (all terminal).
- **Active durable repair loop:** NONE. Repairable issues route back to the producing adapter for a re-read (observe-before-retry), but there is no bounded `RecoveryCase`/`maxAttempts` loop; uncertain external action pauses (`pause-external`) and waits.

---

## 5. Bounded Retry Budgets — Where Enforced

| Budget | Location | Bounded? | Durable? |
|---|---|---|---|
| Platform `healRetries` | `orchestrate.ts:76` (in-memory `Map`), per `RECOVERY_TREE` rule `max_retries` + generic cap of 2 | Yes (capped) | **NO** — lost on pump crash/restart; also reset on gate-error change |
| Module `flow.recovery[].maxAttempts` | `generic-flow-executor.reconcileRecoveryCheckpoint:875-884` via `RecoveryCaseRepository.recordIssue` | Yes | **YES** — enforced atomically by the SQLite recovery-case repository; `exhausted` is a persisted case status |
| Profile `retryPolicy.maxAttempts` | declared on every LM profile | Declared | **NOT ENFORCED** — no executor reads `retryPolicy` or `recoveryPolicy` (importer grep: zero consumers) |
| Module `maxAttempts` in SPI comments | `recovery-policies.ts` docstrings reference "maxAttempts 2" | — | **NOT WIRED** — `*_RECOVERY_POLICY_BINDINGS` have no consumers |

**Conclusion:** the only bounded-and-durable retry budget in the system is `flow.recovery[].maxAttempts`, and it covers only Formalization (5 loops) and Development (1 loop). Discovery and Delivery have no durable repair budget. The profile-level `retryPolicy`/`recoveryPolicy` is dead config. `managedReviewBudget`, `review budget`, and `BoundedAttempts` as named symbols do not exist in `src/`.

---

## 6. Lifecycle Routing of Typed Outcomes

The lifecycle layer routes a module's **terminal local outcome** (the code the settlement kernel emits) to the next stage or to a terminal run status. This is the *post-recovery* layer: recovery either resolves inside the module (loop back to producer) or the module settles a terminal outcome, which the lifecycle then routes.

**Router:** `src/process-modules/application/lifecycle-router.ts:22` — `routeProcessOutcome(stage, outcome)` is a pure lookup into `stage.outcomeRoutes[outcome]`. The orchestrator calls it at `lifecycle-orchestrator.ts:319`. If an outcome has no route, `validateLifecycleDefinition` (`lifecycle-router.ts:71-73`) fails validation, so every declared module outcome MUST have a route.

**Outcome → route mapping** (`src/process-modules/lifecycles/product-delivery-lifecycle.ts`):

| Stage (module) | Outcome | Route |
|---|---|---|
| **initial-discovery** (discovery) | `go` | → stage `solution-formalization` |
| | `clarify` | → stage `solution-formalization` |
| | `reject` | → stage `solution-formalization` |
| | `defer` | → stage `solution-formalization` |
| | `inconclusive` | → stage `solution-formalization` |
| | `failed` | → stage `solution-formalization` |
| **solution-formalization** (formalization) | `formalized` | → stage `solution-development` |
| | `clarification-required` | → terminal `clarification-required` |
| | `inconsistent` | → terminal `formalization-inconsistent` |
| | `infeasible` | → terminal `infeasible` |
| | `failed` | → terminal `failed` |
| **solution-development** (development) | `verified` | → stage `delivery-release` |
| | `rework-required` | → terminal `development-rework-required` |
| | `clarification-required` | → terminal `clarification-required` |
| | `blocked` | → terminal `development-blocked` |
| | `failed` | → terminal `failed` |
| **delivery-release** (delivery) | `released` | → terminal `released` |
| | `approval-required` | → terminal `approval-required` |
| | `blocked` | → terminal `delivery-blocked` |
| | `failed` | → terminal `failed` |

**Lifecycle handles all declared outcomes?** YES — validation enforces that every module outcome has a route and that no route targets an undeclared outcome. The only non-terminal "route to next stage" outcomes are Discovery's six (all forward to formalization regardless of decision) and the two happy-path outcomes `formalized` and `verified`. Every recovery-flavored outcome (`clarify`/`clarification-required`, `reject`, `rework-required`, `blocked`, `inconsistent`, `infeasible`, `failed`) routes to a **terminal** run status. The lifecycle does NOT loop backwards between stages — backward repair lives entirely inside the module (via `flow.recovery[]`), which is correct.

---

## 7. Return-to-Producer Transitions

The only structured "return work to the producing node with feedback" mechanism is the `flow.recovery[]` loop in `generic-flow-executor`:

- `reconcileRecoveryCheckpoint` (`generic-flow-executor.ts:828`) finds the matching `FlowRecoveryDefinition` by `issue.policyId`, asserts the route (`assertRecoveryRoute`), records the issue via `RecoveryCaseRepository.recordIssue` (which returns a `RecoveryFeedback` envelope carrying `repairNodeId`, `attempt`, `maxAttempts`, the immutable issue, and the source production), and writes `activeIssue` onto the ProcessRun.
- The returned `feedbackProduction` (`recoveryFeedbackProduction`, line 910) is the durable, content-addressed envelope handed to the repair worker — this IS the structured feedback to the producer node.
- `resolveSuccessfulRecovery` (line 917) closes the case when the verifier emits a `resolvedEvents` event, clearing `activeIssue`.

This is the canonical return-to-producer path and it is durable. The `RecoveryPolicyBinding` surface expresses the same intent declaratively (`return-to-producer` action) but is not wired to produce this envelope.

---

## 8. Per-Module GAP Tables

Criteria:
- **Recovery policy declared?** — a per-node repair/terminal decision exists for verifier nodes (either `flow.recovery[]` entry or `RecoveryPolicyBinding`).
- **Retry budget bounded & durable?** — `maxAttempts` enforced and survives crash/restart (only `flow.recovery[]` via `RecoveryCaseRepository` qualifies).
- **Rejection produces structured feedback?** — a `RecoveryFeedback` envelope with reason, target producer, and attempt count reaches the repair worker (only `flow.recovery[]` qualifies).
- **Settlement emits typed outcome?** — settlement kernel emits a `code` from the module's declared `outcomes[]` (terminal).
- **Lifecycle handles all declared outcomes?** — `outcomeRoutes` covers every `outcomes[].code` (enforced by `validateLifecycleDefinition`).

### 8.1 Discovery

| Criterion | Status | Evidence |
|---|---|---|
| Recovery policy declared? | **Y** (SPI only) | `DISCOVERY_RECOVERY_POLICY_BINDINGS`, 5 bindings — but NOT consumed |
| Retry budget bounded & durable? | **N** | No `flow.recovery[]`; SPI bindings unwired; profile `retryPolicy` unconsumed |
| Rejection produces structured feedback? | **N** | No `RecoveryCase`; normalization/repair routing is happy-path transitions, not feedback envelopes |
| Settlement emits typed outcome? | **Y** | `settle` → `complete-{go,clarify,reject,defer,inconclusive,failed}` |
| Lifecycle handles all declared outcomes? | **Y** | All 6 outcomes route to `solution-formalization` |

### 8.2 Formalization

| Criterion | Status | Evidence |
|---|---|---|
| Recovery policy declared? | **Y** (both surfaces) | `flow.recovery[]` 5 entries + `FORMALIZATION_RECOVERY_POLICY_BINDINGS` 7 bindings |
| Retry budget bounded & durable? | **Y** | `flow.recovery[].maxAttempts:2` enforced atomically by `RecoveryCaseRepository` |
| Rejection produces structured feedback? | **Y** | `reconcileRecoveryCheckpoint` → `RecoveryFeedback` to `repairNodeId` |
| Settlement emits typed outcome? | **Y** | `settle-formalization` → `complete-{formalized,clarification-required,inconsistent,infeasible,failed}` |
| Lifecycle handles all declared outcomes? | **Y** | All 5 outcomes have routes |

### 8.3 Development

| Criterion | Status | Evidence |
|---|---|---|
| Recovery policy declared? | **Partial** | `flow.recovery[]` covers ONLY `resolve-task-graph`. SPI bindings cover 5 nodes but are unwired. All other verifier failures (rework-required, blocked, verification-denied, candidate-drifted) route straight to terminal — no repair attempted |
| Retry budget bounded & durable? | **Partial** | Durable only for the planner loop; nothing else has a budget |
| Rejection produces structured feedback? | **Partial** | Structured feedback exists only for `repair-development-task-graph` |
| Settlement emits typed outcome? | **Y** | `settle-development` → `complete-{verified,rework-required,clarification-required,blocked,failed}` |
| Lifecycle handles all declared outcomes? | **Y** | All 5 outcomes have routes |

### 8.4 Delivery

| Criterion | Status | Evidence |
|---|---|---|
| Recovery policy declared? | **Y** (SPI only) | `DELIVERY_RECOVERY_POLICY_BINDINGS`, 5 bindings — but NOT consumed. By design: deterministic adapters, no LM re-author loop |
| Retry budget bounded & durable? | **N** | No `flow.recovery[]`; `pause-external` (action-uncertain) is an indefinite wait, not a bounded retry |
| Rejection produces structured feedback? | **N** | `return-to-producer` re-reads have no `RecoveryCase`/feedback envelope |
| Settlement emits typed outcome? | **Y** | `settle-delivery` → `complete-{released,approval-required,blocked,failed}` |
| Lifecycle handles all declared outcomes? | **Y** | All 4 outcomes have routes |

---

## 9. DELETE / ADD / AUDIT Manifest

### 9.1 Platform-orchestration recovery to DELETE (all in `src/orchestrate.ts`)

(Phase 3 already lists `orchestrate.ts` for full deletion; these are the recovery-specific items whose responsibilities must migrate, not evaporate.)

- `RecoveryRule` interface (99-104)
- `RECOVERY_TREE` const (106-311) — the 9 rules across 5 stages
- `attemptHeal` (541-581)
- `spawnGenericRecoveryTask` (596-630)
- `spawnPostTransitionRecovery` (651-694)
- `Saga2PumpState.healRetries` field (76) and its reset logic (`resetHealRetriesForEpic`, 436)
- The gate-failure recovery block in the pump loop (1100-1174): the `attemptHeal` call, the generic-heal fallback, and the escalate-to-human path
- The post-transition stranded-task sweep call (499-501)

**Migration of responsibilities:**
- "Missing artifact / missing task" heals (`no AC artifacts`, `no planning tasks exist`, etc.) → these are **producer-task generation failures**, not recovery. They belong to the module's producer-node flow and the lifecycle's stage-entry conditions, not a healer. The producer should be re-driven (or the planning/generation step re-run), deterministically.
- "Stale hash / missing trace / draft not accepted" heals → mechanical fixes the producer's own verifier (`resolve-*` kernel node) should detect as a `repair-required` issue and route back via `flow.recovery[]`, not a platform healer.
- "Merge conflict / integration stuck" heals → already owned by Development/Delivery verifier nodes (`candidate-drifted`, `receipt-missing`) and the worker merge protocol (`worker_merge_release`); no platform healer needed.
- "Stranded task sweep" → deterministic stage-transition bookkeeping owned by the lifecycle orchestrator, not a delegated healer.

### 9.2 `autonomous-recovery` skill loading to DELETE

- Remove the `'Load skill "autonomous-recovery" ...'` line from every `RECOVERY_TREE` rule prompt, the generic spawner, and the post-transition spawner. (These prompts are deleted with §9.1, so this is implicit — but call it out so no successor code re-introduces a skill-loaded healer.)
- The skill file at `C:\Users\user\.zcode\skills\autonomous-recovery\SKILL.md` is **out of repo scope**; it becomes dead once its callers are gone and should be removed in a separate skills cleanup. **Do not** port its MCDA/prompt content into any module contract.

### 9.3 Module-level recovery to ADD (close the durable-budget gaps)

- **Discovery:** add a `flow.recovery[]` entry (or wire the SPI binding) so that a `domain.repair-required` issue from `resolve-normalized-proposal` / `resolve-readiness` opens a durable `RecoveryCase` with a bounded `maxAttempts` and routes a `RecoveryFeedback` back to `normalize-semantic` / `assess-readiness`. Today these route via happy-path transitions only — there is no bounded repair loop, so a persistently-failing normalizer has no exhaustion terminal.
- **Delivery:** decide explicitly whether the `return-to-producer` re-reads (preflight-check-missing, receipt-missing, observation-mismatched) need a bounded `maxAttempts` or whether `pause-external` (the current design) is sufficient. If external providers can flap indefinitely, a bounded retry budget prevents a live-lock; document the decision in the module. At minimum, wire the declared `DELIVERY_RECOVERY_POLICY_BINDINGS` so the `pause-external` / `request-human` actions are actually executed rather than merely declared.
- **Development:** the four verifier nodes beyond `resolve-task-graph` (`execute-implementation-workset`, `integrate-release-candidate`, `verify-acceptance-workset`, settlement) currently route every non-trivial issue straight to a terminal outcome. Audit whether `rework-required` and `blocked` should be terminal-by-design (current) or should have a bounded return-to-producer loop; the SPI bindings already declare the intent, they are just unwired.

### 9.4 Module-level recovery to AUDIT (reconcile the two declaration surfaces)

There are two ways to express the same recovery policy (`flow.recovery[]` vs `RecoveryPolicyBinding`). Pick one as canonical and make the other either derived-or-deleted:

- **Option A (recommended):** make `RecoveryPolicyBinding` the canonical surface and have `UniversalRecoveryEngine.recordAndRoute` the single executor. `flow.recovery[]` becomes derived (or is removed once the engine is wired). This unifies Discovery/Delivery (which only have SPI bindings) with Formalization/Development (which have both). Requires wiring `UniversalRecoveryEngine` + the four `*_RECOVERY_POLICY_BINDINGS` aggregates into `generic-flow-executor` / the process-module runtime, and folding `maxAttempts`/`onExhausted` (currently only on `flow.recovery[]`) into the SPI.
- **Option B:** keep `flow.recovery[]` canonical (it is the only wired, durable surface) and **delete the dead `*_RECOVERY_POLICY_BINDINGS` aggregates and `UniversalRecoveryEngine`** to remove the false promise of a second surface. Add `flow.recovery[]` entries to Discovery and Delivery where repair loops are wanted.

Either way, the per-profile `retryPolicy` / `recoveryPolicy` fields are currently **dead config** (no executor consumes them). Either wire them into the node executor's retry path or remove them to avoid implying a retry guarantee that does not exist.

### 9.5 What is already correct (KEEP)

- `generic-flow-executor.reconcileRecoveryCheckpoint` + `resolveSuccessfulRecovery` — the durable, bounded, feedback-producing repair loop. Canonical return-to-producer path.
- `RecoveryCaseRepository` (SQLite) — atomic `maxAttempts` enforcement and `exhausted` persistence.
- `RecoveryFeedback` envelope — the structured rejection feedback handed to the repair worker.
- `lifecycle-router.routeProcessOutcome` + `validateLifecycleDefinition` — declarative outcome routing with full coverage enforcement.
- `product-delivery-lifecycle.ts` `outcomeRoutes` — every recovery-flavored outcome routes to a terminal status; no inter-stage backward looping (correct).
- Formalization's 5-entry `flow.recovery[]` and Development's planner loop — the model repair surfaces.

---

## 10. Key File References

- Platform recovery (DELETE): `src/orchestrate.ts` (RECOVERY_TREE 106-311; `attemptHeal` 541; `spawnGenericRecoveryTask` 596; `spawnPostTransitionRecovery` 651; pump recovery block 1100-1174; `Saga2PumpState.healRetries` 76).
- Platform-recovery skill (DELETE loading): `C:\Users\user\.zcode\skills\autonomous-recovery\SKILL.md`.
- Legacy wired repair (KEEP/model): `src/process-modules/application/generic-flow-executor.ts` (`reconcileRecoveryCheckpoint` 828; `resolveSuccessfulRecovery` 917).
- Repair-case durability (KEEP): `src/process-modules/persistence/recovery-case-repository.ts` (port), SQLite adapter.
- New SPI recovery (AUDIT — declared, unwired): `src/process-modules/application/recovery-engine.ts` (`UniversalRecoveryEngine`, `routeRecoveryAction`, `routeRecoveryActionOnExhaustion`); `src/process-modules/domain/spi/recovery-definitions.ts` (`RecoveryAction`, `RecoveryPolicyBinding`).
- Per-module declarations:
  - Discovery: `src/process-modules/modules/discovery/discovery-process-module.ts` (no `flow.recovery[]`); `package/contributions/recovery-policies.ts` (5 bindings, unwired).
  - Formalization: `src/process-modules/modules/formalization/formalization-process-module.ts` (`flow.recovery[]` 223-269); `package/contributions/recovery-policies.ts` (7 bindings, unwired).
  - Development: `src/process-modules/modules/development/development-process-module.ts` (`flow.recovery[]` 239-249); `package/contributions/recovery-policies.ts` (5 bindings, unwired).
  - Delivery: `src/process-modules/modules/delivery/delivery-process-module.ts` (no `flow.recovery[]`); `package/contributions/recovery-policies.ts` (5 bindings, unwired).
- Lifecycle outcome routing (KEEP): `src/process-modules/application/lifecycle-router.ts`; `src/process-modules/application/lifecycle-orchestrator.ts:319`; `src/process-modules/lifecycles/product-delivery-lifecycle.ts` (outcomeRoutes 230, 269, 320, 371).
