# Migration Roadmap, Fitness Functions, First Tranche, Final Blueprint

Artifact ID: ART-PHASE10-MIGRATION-BLUEPRINT
Artifact Type: Evidence-Ordered Migration Roadmap + Fitness Functions + First Migration Tranche + Consolidated Blueprint
Phase: Phase Ten
Version: 1.0
Status: recommended-pending-approval
Created From: All Phase 0-9 artifacts, full codebase context
Coverage: Complete migration sequence (10 tranches), 8 fitness functions, detailed first tranche, consolidated blueprint
Confidence: High for structural mapping; Medium for behavioral equivalence (characterization tests must prove each tranche)
Downstream Dependencies: Human approval → execution

---

## 21.1 Migration Mechanism Selection

| Tranche | Mechanism | Why |
|---|---|---|
| T1: Discovery consolidation | Direct behavior-preserving extraction (file move + import update) | No behavioral change — pure relocation |
| T2: shared/ extraction | Direct extraction | saga3/shared → shared/ — 1 file, 3 re-export sites |
| T3: Authority extraction | Direct extraction | saga3/authority → shared/authority/ — 3 files |
| T4: Formalization consolidation | Branch by abstraction (extract interface, then move impl) | 2043-line file — split handlers into domain/application first |
| T5: Development consolidation | Direct extraction | Smallest module, fewest dependencies |
| T6: Delivery consolidation | Direct extraction | Kernel-only, no LM submit tool |
| T7: Composition root slim-down | Strangler fig (replace inline wiring call-by-call with register()) | 780 lines — replace one module wiring at a time |
| T8: WorkplaceProductPort | Expand-contract (add universal submit/read, migrate callers, remove old) | 4 existing submit tools stay as thin wrappers until all callers migrate |
| T9: Wave debt extraction | Direct extraction (comments → WAVE-LOG.md) | Documentation, not code change |
| T10: tracker-view split | Strangler fig (extract one endpoint group at a time) | 5605 lines — split by responsibility |
| ALG-IMP-002: Traceability consolidation | Branch by abstraction (differential test → extract common → remove duplicate) | Two implementations must converge first |
| ALG-IMP-004: Type cycle break | Direct refactor (split types, update all consumers) | Mechanical but touches many files |
| ALG-IMP-005: markExecutionExited | Branch by abstraction (wrap in releaseExecutionAtomically) | Close callback timing is critical |

---

## 21.2 Evidence-Ordered Migration Roadmap

### Ordering rationale

```
low-risk fossils (T9: Wave debt → safe, no behavior change)
→ cross-cutting extractions (T2, T3: shared/ + authority/ — enablers for T1)
→ boundary consolidation (T1: Discovery — proof of concept)
→ structural improvements (ALG-IMP-003: ledger interface; ALG-IMP-002: traceability)
→ remaining modules (T4, T5, T6)
→ composition slim-down (T7 — depends on T1,T4,T5,T6)
→ desk unification (T8 — depends on module boundaries being clean)
→ hack cleanup (ALG-IMP-004: type cycle; ALG-IMP-005: markExecutionExited)
→ tracker-view split (T10 — lowest priority)
```

### Migration dependency graph

```
T9 (Wave debt) ──────────────────────────────────────────────→ (independent)
T2 (shared/) ──→ T1 (Discovery) ──→ T4 (Formalization) ──┐
T3 (authority/) ──→ T1 ──────────────────────────────────┤
                                                          ├──→ T7 (Composition)
ALG-IMP-003 (Ledger) ──→ T4 ──→ T5 (Development) ──────┤
                                                          │
T5 ──→ T6 (Delivery) ────────────────────────────────────┤
                                                          │
T7 ──→ T8 (WorkplaceProductPort) ───────────────────────→ │
                                                          │
ALG-IMP-002 (Traceability) ──→ after T4 ─────────────────┤
ALG-IMP-004 (Type cycle) ──→ independent (can start early)┤
ALG-IMP-005 (markExecutionExited) ──→ independent ────────┤
                                                          │
ALG-IMP-001 (v1 NodeRun) ──→ independent ─────────────────┤
                                                          ↓
                                                       T10 (tracker-view split)
```

### Full roadmap

| Tranche | Name | Prerequisite | Risk | Est. effort | Verification | Rollback |
|---|---|---|---|---|---|---|
| T9 | Wave debt → WAVE-LOG.md | None | LOW | 2h | tsc green + tests green | git revert |
| ALG-IMP-004 | Break type cycle | None | LOW-MED | 3h | tsc green | git revert |
| ALG-IMP-001 | Remove v1 NodeRun path | Update test fakes | MED | 4h | test:process-modules green | git revert |
| T2 | saga3/shared → shared/ | None | LOW | 1h | tsc green + tests green | git revert |
| T3 | saga3/authority → shared/authority/ | None | LOW-MED | 2h | tsc green + tests green | git revert |
| T1 | Discovery consolidation | T2, T3 | MED | 8h | full suite + architecture tests + ratchet updated | git revert |
| ALG-IMP-003 | Ledger interface → shared/ | T1 | LOW | 1h | tsc green | git revert |
| T5 | Development consolidation | ALG-IMP-003 | MED | 4h | full suite | git revert |
| T4 | Formalization consolidation | T1, ALG-IMP-003 | MED-HIGH | 12h | full suite + characterization | git revert |
| ALG-IMP-002 | Traceability consolidation | T4 | MED | 4h | differential test green | git revert |
| T6 | Delivery consolidation | T1 pattern | LOW-MED | 4h | full suite | git revert |
| T7 | Composition root slim-down | T1,T4,T5,T6 | HIGH | 8h | full e2e + characterization | git revert per module |
| T8 | WorkplaceProductPort | T7 | MED-HIGH | 8h | full suite + new fitness function | dual-read rollback |
| ALG-IMP-005 | markExecutionExited → release | None | MED | 4h | board-runner tests | git revert |
| T10 | tracker-view split | None (lowest priority) | LOW-MED | 8h | manual HTTP testing | git revert |

**Total estimated effort:** ~73 hours (sequential). Parallelizable to ~40h with 2 agents.

---

## 21.3 Fitness Functions

| FIT ID | Rule protected | Enforcement | Frequency | Failure behavior |
|---|---|---|---|---|
| FIT-001 | Module boundaries: each module is one directory under src/modules/ | Architecture test: scan src/modules/, assert each contains domain/application/infrastructure/package/index.ts | Every CI run | FAIL: module directory is incomplete |
| FIT-002 | LEGO contract: adding a module must not edit composition root beyond one register() call | Architecture test: composition root ≤ 100 lines; each module contributes exactly 1 register call | Every CI run | FAIL: composition root grew or register count mismatch |
| FIT-003 | No saga3/ directory remains | Test: `! exists('src/saga3/')` | Every CI run | FAIL: saga3/ directory exists |
| FIT-004 | Dependency direction: modules import only inward + shared/ | Extended ratchet: modules/<name>/domain/ imports only from domain/ + shared/; application/ imports domain/ + shared/; infrastructure/ imports application/ + shared/ | Every CI run | FAIL: new outward dependency detected |
| FIT-005 | GenericFlowExecutor stays under 700 lines | Test: `wc -l generic-flow-executor.ts ≤ 700` | Every CI run | FAIL: executor grew past budget |
| FIT-006 | Universal desk: all cross-module product reads go through WorkplaceProductPort | Architecture test: no module's kernel handler imports another module's product table directly | Every CI run | FAIL: cross-module table import |
| FIT-007 | Single-writer: exactly 3 writers of task owner columns | tasks-writer-invariant.test.mjs (EXISTING — keep and tighten: remove HACK-001 exception) | Every CI run | FAIL: 4th writer detected |
| FIT-008 | Type cycle ban: no `null as unknown as` in process-modules/ | Grep test: `grep -rn "null as unknown as" src/process-modules/ src/modules/` = 0 | Every CI run | FAIL: type-cycle hack reappeared |

---

## 21.4 First Migration Tranche (detailed)

### T1: Discovery Module Consolidation

**Why first:**
- Clearest domain boundary (saga3/ content maps 1:1 to Discovery)
- Fewest cross-module dependencies
- Most pure functions (lowest behavioral risk)
- Proves the pattern for T4/T5/T6

**Boundary established:** `src/modules/discovery/` as a self-contained hexagon. saga3/ content for Discovery moves here. Cross-cutting (canonical-json, authority) moves to shared/.

**Behavior preserved:** all 169+ tests stay green. No SQL change, no schema change, no behavioral change. Pure file relocation + import path update.

**Risk reduced:** SEAM-002 (distributed modules) resolved for Discovery. Agents can understand Discovery from 4-6 files in ONE directory.

**Later work unlocked:** T4 (Formalization follows same pattern), T7 (composition root can extract registerDiscovery()).

**Exact code involved:** 17 files relocated + 3 cross-cutting extracted + 2 new files (index.ts + ports.ts) + ratchet test update. See ART-PHASE8-RELOCATION for full symbol map.

**Tests required:**
1. `npm test` — all 169+ tests green (behavioral equivalence)
2. `npm run test:architecture` — ratchet holds at new paths
3. NEW: `test("Discovery module is self-contained")` — assert modules/discovery/ contains all discovery-specific code
4. NEW: `test("No saga3/ discovery imports")` — assert modules/discovery/ does not import from src/saga3/**

**Rollback:** `git revert` — single commit (or small series). No data migration.

**Completion:** `src/saga3/domain/discovery-*` and `src/saga3/application/discovery-*` no longer exist. All content lives in `src/modules/discovery/`. Cross-cutting lives in `src/shared/`.

**Mark:** `recommended-pending-approval`

---

## FINAL BLUEPRINT — Consolidated

### What the system currently is

A state-machine policy engine that governs external LLM workers through deterministic transition gates. Center of gravity: 18 pure policy functions. Four workshops each produce text artifacts, stored in four separate desks (architectural debt). saga3/ directory is a distributed monolith. Composition root is a God Object (780 lines). Performance is not a driver (99%+ latency from external LLM).

### How confidently that is known

E3-E5 (code-reachable + tested). No E6 (runtime telemetry). One production run (Autism-Buttons) provides behavioral evidence but not systematic metrics. 7 unresolved questions, all related to E6 gap or migration feasibility.

### Where current structure conflicts with behavior

- Four desks (SEAM-001): products are physically identical but stored separately
- Distributed modules (SEAM-002): understanding one module requires 8-12 files across 4 directories
- Git merge crash (SEAM-013): recovery mechanism declared but never built
- God Object (SEAM-016): adding a module requires editing composition root
- Duplicated traceability (SEAM-010): two implementations can drift

### What its real core is

18 pure policy functions governing transitions. Not a domain model. Not a pipeline. A contract-governed state machine.

### Who owns each state and invariant

See ART-PHASE2-STATE-OWNERSHIP (14 entities mapped). Clean ownership for 12/14. Split-brain artifacts (STATE-003+005). Unreached integration_intents (STATE-014).

### Which boundaries are accidental

Four desks. Distributed saga3/. God Object composition. Wave debt in comments. tracker-view.mjs monolith.

### Which patterns fit the observed forces

Policy object (pure functions). Plugin registry (data-driven modules). Adapter (claude CLI). Self-registration (register(deps)). SQLite BEGIN IMMEDIATE (keep — workload is tiny).

### Which target architecture was selected and why

Gate-centric hexagonal with self-contained modules. Selected over state-machine-engine (too much framework overhead) and conservative-modularization (doesn't solve cognitive load). Survived 10 adversarial attacks with one revision (desk scope narrowed).

### How every current responsibility moves

See ART-PHASE8-RELOCATION (10 clusters, 22 symbol-level moves for first tranche).

### How every migration step is verified and reversed

Each tranche: `npm test` green + `npm run test:architecture` green + characterization tests. Rollback = `git revert`. No data migrations.

### How the new architecture is protected from erosion

8 fitness functions (FIT-001 through FIT-008). Existing ratchet tests preserved and extended. New module-boundary tests added.

---

## COMPLETE TRACEABILITY (summary)

```
code evidence (1544 files)
  → executable topology (5 processes, 3 composition roots)
    → 8 scenarios traced
      → 14 state entities mapped
        → 18 rules catalogued
          → 16 seams identified
            → 4 critical seams
              → target architecture: gate-centric hexagonal
                → 10 relocation clusters
                  → 15-step migration roadmap
                    → 8 fitness functions
                      → first tranche: Discovery (17+3+2 files)
```

**Status: recommended-pending-approval**

All analysis complete. Code not modified. Awaiting human review of target architecture and first migration tranche approval.
