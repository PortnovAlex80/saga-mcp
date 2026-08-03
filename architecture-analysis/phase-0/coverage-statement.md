# Phase Zero Coverage and Unresolved Regions Statement

Artifact ID: ART-PHASE0-COVERAGE-STATEMENT
Artifact Type: Coverage Statement
Phase: Phase Zero
Version: 1.0
Status: evidence-incomplete

---

## Coverage Summary

### Inventory Coverage: HIGH
- **1544 source units** inventoried in `file-manifest.jsonl`
- **1544/1544** files classified by path-based heuristics into structural roles
- Distribution: 476 .md, 351 .ts, 326 .mjs, 193 .json, 198 package-store data blobs, 300 tests

### Structural Coverage: HIGH
- All 5 runnable processes identified (MCP server, orchestrate-cli, tracker-view, docs-graph, worker)
- All 3 composition roots traced (createSaga2Application, createProductLifecycleRuntime, installProductionModules)
- All 4 process modules inventoried with definitions, handlers, product desks, settlement policies
- All persistence mechanisms catalogued (28+ table groups, filesystem store, external integrations)

### Executable Topology Coverage: HIGH
- Full path traced from MCP stdio entry → authority gateway → handler → SQLite
- Full path traced from orchestrate-cli → lifecycle orchestrator → generic-flow-executor → node executors → worker spawn → poll → close
- Full path traced from tracker-view HTTP → board runner → claude spawn → recovery

### Reachable-Path Coverage: MEDIUM
- Production paths traced at E3 (reachable from entry point) for all core components
- Worker spawn path at E4 (configured by env + composition) but ClaudeBoardRunner.launch uses `spawn` which is mocked in tests
- E5 (tested) for most critical paths: claim/release, authority gateway, settlement, node-durable-identity

### Scenario Coverage: NOT YET ASSESSED
- Phase 2 will produce scenario-to-component matrix
- Phase 0 identifies entry points and flows but does not enumerate business scenarios

### State Ownership Coverage: NOT YET ASSESSED
- Phase 2 will produce state ownership map
- Phase 0 catalogues persistence mechanisms but does not trace ownership/conflicts

### Data-Flow Coverage: NOT YET ASSESSED
- Phase 2 will produce data flow map
- Phase 0 identifies product desks (4 separate tables — the architectural gap from CONVEYOR-MENTAL-MODEL.md v2) but does not trace cross-desk flows

### Rule Extraction Coverage: NOT YET ASSESSED
- Phase 3 will extract the real core (rules, invariants, calculations)

### Cross-Cutting Constraint Coverage: NOT YET ASSESSED
- Phase 5.5 will profile constraints (authority, idempotency, consistency, transactions)

## What Was Only Inventoried (Not Semantically Understood)

1. **198 package-store data blobs** (`.saga/package-store/`) — content-addressed immutable snapshots. Inventoried as data, not analyzed for semantic content.
2. **300 test files** — inventoried by path, not inspected for coverage gaps or behavioral contracts. Phase 0 treats tests as E5 evidence only when they directly prove an invariant.
3. **147 docs/refactor-management files** — wave plans (W0-W13). Inventoried as documentation. Not traced against current code state.
4. **51 tool-scripts** (`tools/`) — includes `cgad-spec-lint.mjs`, `dep-graph-scanner.mjs`, `run-process-module-tests.mjs`. Inventoried; key tools (cgad-spec-lint, dep-graph-scanner) inspected.
5. **48 extension files** (`modules-ext/`, `scenarios-ext/`) — inventoried; not inspected for production reachability.

## What Was Inferred

1. **"One machine, one material" hypothesis** (from CONVEYOR-MENTAL-MODEL.md v2): the system is fundamentally an LLM text-generation pipeline where all products are text artifacts. This is a **hypothesis for Phase 1 to verify**, not an accepted premise. Evidence FOR: all 4 module outputs are JSON/Markdown text with schema+hash; `saga3_process_products` table exists as a universal store. Evidence AGAINST: 4 separate desks persist, each with its own submit tool and resolver.

2. **Four-desks architectural gap**: inferred from code inspection (4 tables, 4 submit tools, 4 resolvers) + CONVEYOR-MENTAL-MODEL.md v2's "historical record" section. This is Phase 4 (Seam Map) evidence, not a conclusion.

3. **Wave debt estimate (~40% accidental complexity)**: inferred from comment-to-code ratio in key files (generic-flow-executor.ts ~50% comments, formalization-installation.ts ~30% comments). This is a hypothesis for Phase 5/9 to quantify.

## Unresolved Questions

### QUESTION-001: Runtime production behavior (E6 gap)
**Question:** Are all 4 product desks actively written to in production lifecycle runs?
**Why it matters:** If one desk is never used (e.g., development submissions go through a different path), the "four desks" problem is smaller than feared.
**Evidence available:** E2-E5 (code paths exist and are tested). E6 (runtime telemetry) unavailable.
**Phase dependency:** Phase 1 (Operational Purpose) and Phase 4 (Seam Map) need this.

### QUESTION-002: saga3/ directory — bounded context or distributed monolith?
**Question:** Is `src/saga3/` a coherent bounded context, or is it scattered infrastructure that should be redistributed?
**Why it matters:** If saga3/ is a monolith, modularization requires redistribution. If it's coherent, it can stay.
**Evidence available:** saga3/ has domain/application/persistence/authority layers, BUT discovery module imports from it via dynamic import (createLegacySettlementBridge), and authority (authorizeSagaToolCall) is cross-cutting.
**Phase dependency:** Phase 3 (Real Core) and Phase 6 (Target Architecture).

### QUESTION-003: `as any` in composition root — how widespread?
**Question:** Beyond `installationRegistry.register(inst as any)` at product-lifecycle-runtime.ts:601, how many other type-safety bypasses exist?
**Why it matters:** Each bypass is a potential seam where the type system cannot catch drift.
**Evidence available:** E0 (declaration). Needs grep across src/.
**Phase dependency:** Phase 4 (Seam Map).

### QUESTION-004: tracker-view.mjs (5605 lines) — what responsibilities are mixed?
**Question:** Beyond HTTP serving, how many domain/persistence/dispatch responsibilities live in tracker-view.mjs?
**Why it matters:** If tracker-view makes domain decisions, it's not just a UI adapter.
**Evidence available:** E3 (reachable). Partially inspected (first 400 lines + endpoint list). NOT fully analyzed.
**Phase dependency:** Phase 2 (Scenario-Component Matrix) and Phase 4 (Seam Map).

### QUESTION-005: Dynamic imports as ratchet blind spots
**Question:** How many dynamic `import()` calls exist under src/, and do they hide dependencies the ratchet cannot see?
**Why it matters:** The dependency-direction ratchet scans static imports only. Dynamic imports are legitimate (createLegacySettlementBridge) but undermine ratchet trust.
**Evidence available:** At least 1 confirmed (discovery-installation.ts:165). Needs systematic scan.
**Phase dependency:** Phase 4 (Seam Map) and Phase 5.5 (Cross-Cutting Constraints).

### QUESTION-006: ManagedProductionLedger interface duplication
**Question:** The `ManagedProductionLedger` interface is declared in both development-kernel-ports.ts and formalization-kernel-ports.ts. Are there other duplicated interfaces?
**Why it matters:** Duplicated interfaces can drift silently (TS structural typing won't catch it).
**Evidence available:** 2 confirmed duplicates. Needs systematic interface comparison.
**Phase dependency:** Phase 3 (Real Core) and Phase 4 (Seam Map).

### QUESTION-007: "Glass ceiling" hypothesis
**Question:** Is the system's cognitive complexity (for an LLM agent) dominated by accidental complexity (Wave debt, 4 desks, distributed modules) or essential complexity (CGAD governance, conveyor model)?
**Why it matters:** Determines whether architectural cleanup alone can lower the context ceiling, or whether the domain is inherently complex.
**Evidence available:** Hypothesis from user-provided framing. Needs Phase 1-5 evidence to test.
**Phase dependency:** Phase 5 (Workload Profile) and Phase 9 (Algorithmic Improvement).

## Contradictions Discovered

### CONTRADICTION-001: CONVEYOR-MENTAL-MODEL.md v2 vs code reality
- **Document claims:** "one machine, one material, one desk" is the target; four desks are "the largest remaining architectural debt"
- **Code shows:** four separate desks are ACTIVELY USED (4 tables, 4 submit tools, 4 resolvers, all E2-E5)
- **Classification:** Not a contradiction of the code — the document explicitly marks this as a gap. But it IS a contradiction between the stated mental model and the operational reality.
- **Resolution:** Phase 1 will establish the operational reality; Phase 4 will map the seam; Phase 6 will determine if desk unification is the right target.
