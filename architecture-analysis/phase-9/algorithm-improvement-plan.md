# Algorithmic and Structural Improvement Plan

Artifact ID: ART-PHASE9-ALGORITHM-PLAN
Artifact Type: Algorithmic and Structural Improvement Plan
Phase: Phase Nine
Version: 1.0
Status: recommended-pending-approval
Created From: ART-PHASE5-WORKLOAD-PROFILE, ART-PHASE4-SEAM-MAP, ART-PHASE3-RULE-CATALOG
Coverage: 5 improvements identified. All are STRUCTURAL (not algorithmic — Phase 5 proved algorithms are already appropriate for workload).
Confidence: High (evidence-based)
Downstream Dependencies: Phase 10 (Migration Roadmap)

---

## ALG-IMP-001: Remove v1 legacy NodeRun path from GenericFlowExecutor

| Field | Value |
|---|---|
| Current location | generic-flow-executor.ts:651-659 (legacy `nodeRunRepo.start`) |
| ALG reference | ALG-003 (GenericFlowExecutor walk) |
| Workload evidence | Phase 5: production ALWAYS activates v2. Legacy path is fallback for in-memory test fakes only (DEAD-004) |
| Target | Single v2 path. ~400 lines removed from GenericFlowExecutor. |
| Expected benefit | GenericFlowExecutor: 1500 → ~1100 lines (before Wave debt removal) |
| Correctness risks | LOW — test fakes that don't implement NodeRunRepositoryV2 will fail. They must be updated. |
| Prerequisite | Update all in-memory test fakes to implement startV2/completeV2/readByExactCursor |
| Benchmark design | `npm run test:process-modules` green before and after |
| Rollback | git revert |
| Completion criteria | `grep -c "legacyRow" generic-flow-executor.ts` = 0 |

## ALG-IMP-002: Consolidate RULE-012 (duplicated formalization traceability)

| Field | Value |
|---|---|
| Current location | sqlite-formalization-kernel.ts:168 (SQL) + formalization-installation.ts:1237 (in-memory) |
| ALG reference | ALG-005 |
| Workload evidence | Phase 4 SEAM-010: two independent implementations can drift |
| Target | ONE pure function `checkTraceability(snapshot: ContractSnapshot): GapReport`. Both the SQL-backed and in-memory callers feed it the same shape. |
| Expected benefit | Single source of truth for traceability rules. No drift risk. |
| Correctness risks | MEDIUM — the two implementations may have subtle differences today (e.g., edge cases for NFR-only ACs). Need characterization test that proves both produce same output before consolidation. |
| Prerequisite | Write differential test: run both implementations on 10 representative artifact graphs, assert identical results |
| Rollback | git revert |
| Completion criteria | `grep -c "findFirstTraceabilityGap\|findContractGap" src/` = 1 (one canonical function) |

## ALG-IMP-003: Consolidate ManagedProductionLedger interface

| Field | Value |
|---|---|
| Current location | development-kernel-ports.ts (interface) + formalization-kernel-ports.ts (identical interface) |
| Workload evidence | Phase 0 QUESTION-006: two structural-identical declarations can drift silently |
| Target | `src/shared/managed-production.ts` — single canonical interface. Both modules import from here. |
| Expected benefit | Structural integrity. No silent drift between modules. |
| Correctness risks | LOW — TS structural typing means the concrete impl already satisfies both. Moving the declaration is mechanical. |
| Rollback | git revert |
| Completion criteria | `grep -rc "interface ManagedProductionLedger" src/` = 1 |

## ALG-IMP-004: Break ModuleCompletion ↔ ProcessModuleOutputEnvelope type cycle

| Field | Value |
|---|---|
| Current location | domain/spi/module-completion.ts + domain/spi/production-envelope.ts (mutual `import type`) |
| Workload evidence | HACK-003: `completion: null as unknown as ModuleCompletion` in 4 kernel files |
| Target | Split: `CompletionEnvelope` (outcome + terminal + certificateRef) separate from `ProcessModuleOutputEnvelope` (productions + outcome + optional completion ref). No cycle. |
| Expected benefit | No `null as unknown as` hacks. Serialization is natural. JSON.stringify works without cycle guard. |
| Correctness risks | MEDIUM — touches SPI types imported across the codebase. Need to verify all consumers compile. |
| Prerequisite | Full `npx tsc --noEmit` green after type change |
| Rollback | git revert |
| Completion criteria | `grep -rc "null as unknown as ModuleCompletion" src/` = 0 |

## ALG-IMP-005: Route markExecutionExited through releaseExecutionAtomically

| Field | Value |
|---|---|
| Current location | worker-executions.ts:190-219 (markExecutionExited) — HACK-001, fourth writer |
| Workload evidence | SEAM-004: breaks single-writer invariant cleanliness |
| Target | markExecutionExited calls releaseExecutionAtomically internally (or is replaced by it) |
| Expected benefit | Single-writer set = exactly 3 (no documented exception). Lint simplifies. |
| Correctness risks | MEDIUM — markExecutionExited is called from ClaudeBoardRunner close callback. Need to verify the timing: close callback must not be delayed by the atomic-release path. |
| Prerequisite | Characterization test: ClaudeBoardRunner close → markExecutionExited → task released (current behavior) must be identical post-change |
| Rollback | git revert |
| Completion criteria | `tasks-writer-invariant.test.mjs` allowlist contains exactly 3 entries (not 3 + 1 exception) |

---

## What is NOT proposed (and why)

| Rejected improvement | Why |
|---|---|
| Replace SQLite with PostgreSQL | No evidence of multi-host need. Workload is tiny (N<100). SQLite is overprovisioned. |
| Add query caching | Queries are already O(log N) with N<1000. Caching adds complexity for microseconds. |
| Replace BEGIN IMMEDIATE with advisory locks | No contention evidence at concurrency=3-4. |
| Batch writes | Write volume is low (1-50 writes per worker execution). Batching saves nothing. |
| Index optimization | All critical queries already have indexes. EXPLAIN QUERY PLAN not warranted at this scale. |
| Streaming product reads | Products are 1-50KB. No streaming needed. |
