# Pattern Applicability Matrix, Architecture Candidates, and Selected Target

Artifact ID: ART-PHASE6-TARGET-ARCHITECTURE
Artifact Type: Pattern Applicability Matrix + Candidate Screening + Selected Target Architecture + ADR Catalog
Phase: Phase Six
Version: 1.0
Status: recommended-pending-approval
Created From: All Phase 0-5.5 artifacts, full codebase context
Coverage: 3 architecture candidates evaluated against 8 material forces. 1 selected. 5 ADRs.
Confidence: High for evidence-based screening; Medium for target specification (migration feasibility untested)
Downstream Dependencies: Phase 7 (Adversarial Review), Phase 8 (Relocation)

---

## 17.1 Pattern Applicability Matrix

| # | Observed force | Evidence | Candidate patterns | Selected | Rejected | Why |
|---|---|---|---|---|---|---|
| PAT-001 | Gate mechanics dominate complexity (FINDING-002) | Phase 3: 18 rules, 12 pure | Policy object, Strategy, Rules engine | **Policy object (pure functions)** | Rules engine (overkill for 18 rules), Strategy (policies don't share an interface) | Each policy is a standalone pure function with unique signature. No runtime selection needed — the calling site is compile-time-known. |
| PAT-002 | Modules declare content, runtime executes physics (CONVEYOR-MENTAL-MODEL) | discovery/formalization/development/delivery ProcessModuleDefinitions | Plugin registry, Microkernel, Interpreter | **Plugin registry (data-driven)** | Microkernel (modules don't extend runtime API), Interpreter (Flow is data, not code to interpret) | GenericFlowExecutor IS an interpreter of Flow data. Modules register handlers. Adding a module should = registering a package. |
| PAT-003 | External LLM worker is the execution unit | lm-node-executor.ts, claude-runner.mjs | Adapter, Anti-corruption layer, Direct call | **Adapter (claude-runner as outbound adapter)** | ACL (no foreign model to translate), Direct call (too tightly coupled) | claude -p is an external binary with implicit contract (SEAM-014). Adapter isolates version changes. |
| PAT-004 | Four separate product desks should be one | FINDING-001, SEAM-001, FLOW-002 | Repository, Query object, Unified table | **Unified desk (expand existing saga3_process_products)** | Separate repos per module (preserves the problem), Query object (adds indirection without solving the split) | The universal desk EXISTS and is used by one module. Expanding it to all four is the natural path. |
| PAT-005 | Distributed modules across 2-4 directories | SEAM-002 | Module per directory (self-contained hexagon), Service locator, Flat namespace | **Self-contained hexagon per module** | Service locator (runtime resolution — anti-pattern), Flat (loses boundaries) | Each module should be ONE directory with domain/application/infrastructure/package subdirectories. |
| PAT-006 | God Object composition root (780 lines) | SEAM-016, FINDING-004 | Self-registration, Manual wiring, DI container | **Self-registration via register(deps)** | Manual wiring (current — doesn't scale), DI container (overkill for 4 modules) | Each module exports register(deps). Composition root calls 4 functions. ~80 lines. |
| PAT-007 | SQLite BEGIN IMMEDIATE as sole serialization | SEAM-011 | Optimistic locking, Pessimistic locking, Advisory lock | **Keep SQLite BEGIN IMMEDIATE** | Optimistic (retry storms under contention), Advisory (SQLite has no native advisory locks) | Workload is tiny (N<100). Performance is not a driver (Phase 5). Keep the simplest correct mechanism. |
| PAT-008 | Recovery preserves workplace identity (P18) | RULE-008, SCN-003 | State machine with durable identity, Event sourcing, Snapshot | **State machine with durable identity (current model)** | Event sourcing (overkill — audit log already exists), Snapshot (workplace IS the snapshot) | P18 model works. The recovery mechanic is an emergent success. Preserve it. |

---

## 17.2 Architecture Candidates

### Candidate A: Conservative Modularization

**Description:** Keep current directory structure. Fix the four desks. Consolidate duplicated interfaces. Clean Wave debt. Don't move directories.

**Screening:**
- Scenario flow: same as today (no improvement in cognitive load for agents)
- State ownership: no change (same writers)
- Data ownership: desks unified (good)
- Invariants: no change
- Migration cost: LOW (desk unification + cleanup only)
- Operational complexity: no change

**Verdict:** REJECTED. Preserves the distributed-module problem (SEAM-002) and God Object (SEAM-016). Agents still need 8-12 files across 4 directories. Doesn't address the glass ceiling.

### Candidate B: Execution-Model-Native (State Machine Engine)

**Description:** Reframe the system around its state-machine nature. Centralize the state machine definition. Make policies first-class named entities. Modules become state-machine fragments that plug into the engine.

**Screening:**
- Scenario flow: each scenario is a path through the state machine — good fit
- State ownership: centralize state definitions — but tasks/artifacts/executions are ALREADY well-owned. Centralization adds indirection without benefit.
- Data ownership: desks unified
- Invariants: policies extracted as named entities — already mostly done (12/18 pure)
- Migration cost: MEDIUM-HIGH (reframe everything as state machine fragments)
- Operational complexity: HIGHER (state machine framework overhead)

**Verdict:** REJECTED. The state-machine classification (Phase 5) is correct descriptively but prescriptively it adds framework overhead. The policies are already pure functions — wrapping them in a state-machine framework adds ceremony without solving the real problems (four desks, distributed modules, God Object).

### Candidate C: Gate-Centric Hexagonal with Self-Contained Module Hexagons

**Description:**
- Each module is a self-contained hexagonal directory (domain/application/infrastructure/package)
- The CORE of each module is its pure policies (the 18 rules from Phase 3, distributed by ownership)
- The SHELL is a thin generic runtime (GenericFlowExecutor + LifecycleOrchestrator)
- One unified desk (expand saga3_process_products)
- Modules self-register via register(deps)
- saga3/ directory is dismantled — its content distributed to modules (discovery gets settlement policy; shared/authority become cross-cutting)
- Composition root shrinks to ~80 lines
- Wave debt is moved to ADR documentation (code comments cleaned)

**Screening:**
- Scenario flow: each scenario stays within 1 module + thin shell = 4-6 files
- State ownership: preserved (single-writer invariant stays)
- Data ownership: unified desk + per-module managed-ledger for provenance
- Invariants: policies stay pure, now physically inside their owning module
- Migration cost: MEDIUM (physical relocation, not behavioral change)
- Operational complexity: LOWER (fewer indirections, smaller files)
- Testability: HIGHER (each module testable in isolation with fakes)
- LEGO contract: SATISFIED (adding a module = create directory + register call)

**Verdict:** SELECTED. This candidate addresses all 4 critical seams while preserving the emergent successes (pure policies, P18 recovery, single-writer invariant, ratchet tests).

---

## 17.3 Detailed Comparison: B vs C (Strongest Two)

| Dimension | B (State Machine Engine) | C (Gate-Centric Hexagonal) |
|---|---|---|
| Module boundaries | State-machine fragments (abstract) | Physical directories (concrete, navigable) |
| Policy location | Central state-machine registry | Inside owning module's domain/ |
| Cognitive load per module | 6-8 files (state machine framework + policies + handlers) | 4-6 files (domain + application + infrastructure + package) |
| Scenario traversal | Path through central state machine | Path through module Flow + thin shell |
| Ownership clarity | Policies owned by state-machine engine | Policies owned by their module |
| Testability | State machine tests (framework-dependent) | Module tests with fake ports (framework-free) |
| Migration cost | MEDIUM-HIGH (reframe + relocate) | MEDIUM (relocate only — no behavioral change) |
| Failure isolation | State-machine engine is a singleton (single failure point) | Each module is independent |
| LEGO contract | Adding a module = adding a state-machine fragment | Adding a module = creating a directory + register(deps) |
| Performance | No change | No change (Phase 5 proved performance is not a driver) |

**Decision: C wins.** Lower migration cost, better testability, physical module boundaries, LEGO contract satisfied. B is descriptively correct but prescriptively overengineered.

---

## Selected Target Architecture: Gate-Centric Hexagonal with Self-Contained Modules

### Target layering

```
┌────────────────────────────────────────────────────────────────┐
│ MCP API Surface (src/tools/)                                   │
│   Thin handlers → delegate to application use cases            │
│   Authority gateway stays here (cross-cutting)                 │
├────────────────────────────────────────────────────────────────┤
│ Conveyor Runtime (src/app/ + src/application/)                 │
│   GenericFlowExecutor (~600 lines, Wave debt removed)          │
│   LifecycleOrchestrator (unchanged)                            │
│   dispatch-loop, composition-root (~80 lines)                  │
│   WorkAssignmentPort, ProcessRunRepository (ports)             │
├────────────────────────────────────────────────────────────────┤
│ Module Hexagons (src/modules/{discovery,formalization,...}/)   │
│   Each:                                                        │
│     domain/       — pure policies, contracts, types            │
│     application/  — kernel handlers, ports                     │
│     infrastructure/ — SQLite adapters implementing ports       │
│     package/      — manifest, resources, skills, templates     │
│     index.ts      — register(deps): void  ← THE ONLY EXPORT   │
├────────────────────────────────────────────────────────────────┤
│ Work Dispatch (src/work-dispatch/)                             │
│   work-assignment-core, atomic-release, stuck-policy           │
│   (unchanged location — these are CONVEYOR physics, not module)│
├────────────────────────────────────────────────────────────────┤
│ Cross-Cutting (src/shared/)                                    │
│   canonical-json, authority, recovery contracts                │
│   (extracted from saga3/ — NOT owned by any single module)     │
├────────────────────────────────────────────────────────────────┤
│ Persistence (SQLite — unchanged)                               │
│   All tables stay. Desk unification is logical, not physical.  │
└────────────────────────────────────────────────────────────────┘
```

### Key decisions

1. **saga3/ is dismantled.** Its content is distributed:
   - Discovery domain (settlement policy, proposal types, certificate) → `modules/discovery/domain/`
   - Discovery application (settlement service) → `modules/discovery/application/`
   - Discovery persistence (SQLite runtime) → `modules/discovery/infrastructure/`
   - saga3/shared (canonical-json) → `shared/canonical-json.ts`
   - saga3/authority (authorize-saga-tool-call, execution-context) → `shared/authority/`

2. **Four desks are unified LOGICALLY (not physically).** All four submit tools write to the SAME logical abstraction (`WorkplaceProduct`) backed by `saga3_process_products`. The physical tables are kept as-is for backward compatibility — the unification is at the API and read level, not the storage level. This avoids a risky data migration.

3. **Module self-registration.** Each module exports `register(deps): void`. Composition root becomes:
   ```typescript
   const shared = createSharedDeps(db, workerFactory, workAssignment);
   const registry = new ProcessModuleInstallationRegistry(...);
   registerDiscovery(registry, shared);
   registerFormalization(registry, shared);
   registerDevelopment(registry, shared);
   registerDelivery(registry, shared);
   ```

4. **Wave debt → ADR.** All "Wave N will..." comments are extracted into `docs/architecture/WAVE-LOG.md`. Code comments document BEHAVIOR only, not migration history.

5. **tracker-view.mjs split.** Into: `http-server.mjs`, `kanban-api.mjs`, `artifact-render.mjs`, `board-runner-adapter.mjs`. Each <500 lines.

### Named contracts and ports

| PORT-001: WorkplaceProductPort | |
|---|---|
| Contract status: proposed-to-be | |
| Capability: Submit and read text products on the universal desk | |
| Current interaction: 4 separate submit tools + 4 separate read paths | |
| Input: `{ schema, content, executionRef }` → `{ productRef }` | |
| Output: `{ schema, ref, hash, provenance }` | |
| Failure: reject if schema mismatch, execution fence invalid, content hash collision | |
| Idempotency: content_hash UNIQUE — replay returns existing | |
| Current coupling: each module's installation file directly queries its own table | |
| Owning block: Conveyor Runtime (shared by all modules) | |
| Consumers: ALL 4 modules | |
| Migration adapter: thin wrapper over existing 4 tables, routing by schema | |

| PORT-002: ModuleRegistrationPort | |
|---|---|
| Contract status: proposed-to-be | |
| Capability: Register a module's handlers, profiles, and installation | |
| Current interaction: composition root imports and wires everything | |
| Input: `{ definition, handlers, humanInteractions, executorFactory }` | |
| Output: registered module in registry | |
| Current coupling: SEAM-016 (God Object) | |
| Owning block: Conveyor Runtime | |
| Consumers: composition root | |

| PORT-003: SharedDeps | |
|---|---|
| Contract status: proposed-to-be | |
| Capability: Bundle of shared infrastructure passed to module registration | |
| Contents: db, workerExecutorFactory, workAssignment, certificateRepo, recoveryCaseRepo, resolveNodeProducts | |
| Current coupling: each module's installation function takes a different deps shape | |
| Owning block: Conveyor Runtime | |

### ADR Catalog

| ADR | Decision | Status |
|---|---|---|
| **ADR-RECON-001** | Dismantle saga3/ — distribute its content to modules/discovery/ and shared/ | recommended-pending-approval |
| **ADR-RECON-002** | Unify four desks logically via WorkplaceProductPort over existing tables | recommended-pending-approval |
| **ADR-RECON-003** | Module self-registration via register(deps) — composition root shrinks to ~80 lines | recommended-pending-approval |
| **ADR-RECON-004** | Extract Wave history from code comments into docs/architecture/WAVE-LOG.md | recommended-pending-approval |
| **ADR-RECON-005** | Split tracker-view.mjs into 4 focused modules | recommended-pending-approval |
