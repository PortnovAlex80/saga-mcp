# Adversarial Architecture Review

Artifact ID: ART-PHASE7-ADVERSARIAL-REVIEW
Artifact Type: Adversarial Review + Revised Target Architecture
Phase: Phase Seven
Version: 1.0
Status: evidence-incomplete
Created From: ART-PHASE6-TARGET-ARCHITECTURE, all prior artifacts
Coverage: 10 attack vectors tested against the selected target architecture (Candidate C)
Confidence: High for structural weaknesses; Medium for mitigation effectiveness (untested)
Downstream Dependencies: Phase 8 (Relocation)

---

## Attack Vectors

### ATTACK-001: Scenarios traversing too many modules

**Test:** Does any scenario require crossing module boundaries through the new hexagonal layout?

**Result:** Cross-module handoff goes through LifecycleOrchestrator's declarative routing — NOT through direct module-to-module calls. The handoff data (certificate ref) crosses the boundary as a typed ProductRef, not as module-internal data. Each module's index.ts exposes only `register(deps)`. Cross-module traversal = 1 module + thin shell = 4-6 files.

**Verdict:** SAFE. No excessive traversal.

### ATTACK-002: Chatty interactions between modules

**Test:** After self-registration, do modules call each other frequently?

**Result:** Modules NEVER call each other. GenericFlowExecutor is the only component that dispatches to module handlers. LifecycleOrchestrator is the only component that routes between modules. Modules are isolated hexagons — zero module-to-module calls at runtime.

**Verdict:** SAFE. Zero chat between modules.

### ATTACK-003: Split transactions across module boundaries

**Test:** Does any business operation require atomic writes across two modules?

**Result:** No. Each module's settlement kernel writes to its OWN certificate and its OWN output — atomically within one ProcessRun. Cross-module handoff is mediated by LifecycleOrchestrator, which writes stage-run state (not module product state). The universal desk (WorkplaceProductPort) writes products for ONE module at a time — no cross-module product writes.

**Verdict:** SAFE. No split transactions.

### ATTACK-004: Lost invariants after relocation

**Test:** Does moving saga3/ content into modules/discovery/ break any invariant?

**Result:** The single-writer invariant (RULE-003) is enforced by source-level lint that matches on file paths. Moving files changes paths — the lint's regex patterns would need updating. This is a mechanical fix, not a semantic break.

**Risk:** If the lint is NOT updated during relocation, the ratchet would either (a) fail to detect real violations (false negative) or (b) flag legitimate code as violations (false positive). 

**Mitigation:** The ratchet test MUST be updated in the SAME migration tranche as the file relocation. This is a prerequisite, not an afterthought.

**Verdict:** MANAGEABLE. Requires coordinated lint update.

### ATTACK-005: Cyclic dependencies under new names

**Test:** After dismantling saga3/, do new import cycles appear?

**Result:** saga3/shared (canonical-json) moves to shared/canonical-json.ts — imported by ALL modules. saga3/authority moves to shared/authority/ — imported by MCP gateway (index.ts) and proposal_submit handler. These are acyclic: shared/ imports nothing from modules/. The dependency-direction ratchet (tests/architecture/dependency-direction.test.mjs) will catch any new cycle.

**Verdict:** SAFE. Ratchet enforces acyclicity.

### ATTACK-006: Desk unification creates performance regression

**Test:** If all products go through WorkplaceProductPort → saga3_process_products, does query performance degrade?

**Result:** Phase 5 proved performance is not a driver. The table is indexed by (processRunId, productKind). Current data volume: 10-30 products per ProcessRun. Even with 4 modules × 30 products = 120 rows per ProcessRun, the query is O(log 120) = O(7). Microseconds.

**Verdict:** SAFE. No performance regression.

### ATTACK-007: Desk unification breaks existing provenance

**Test:** If products are read from the universal desk instead of module-specific tables, is provenance lost?

**Result:** The universal desk (saga3_process_products) stores `{ schema, ref, hash, payload, provenance }`. The module-specific tables store richer provenance (managed-production-ledger has `operation`, `artifact_status`, `ledgerId`). A direct read from the universal desk would NOT have the full managed-ledger provenance.

**Revision needed:** WorkplaceProductPort must provide TWO reads:
1. `readProduct(ref)` — returns payload + hash (for cross-module handoff)
2. `readProductProvenance(ref)` — returns full provenance (for kernel handlers that need it)

This is a REVISION of PORT-001. The desk unification is at the SUBMIT + cross-module READ level. Module-internal kernel handlers continue to read the managed-production-ledger for rich provenance. The universal desk is the LINGUA FRANCA for cross-module handoff, not a replacement for all module-internal reads.

**Verdict:** REVISED. PORT-001 updated: universal desk for cross-module handoff + module-internal provenance reads preserved.

### ATTACK-008: Artificial abstractions (ports without seams)

**Test:** Are any proposed ports unnecessary?

**Result:** 
- PORT-001 (WorkplaceProductPort): JUSTIFIED — resolves SEAM-001 (four desks)
- PORT-002 (ModuleRegistrationPort): JUSTIFIED — resolves SEAM-016 (God Object)
- PORT-003 (SharedDeps): BORDERLINE — it's a parameter bundle, not a true port. But it standardizes what composition passes to modules. Keep as a type alias, not an interface.

**Verdict:** SAFE. No artificial abstractions. SharedDeps is a type, not a port.

### ATTACK-009: Module tests cannot run without infrastructure

**Test:** After relocation, can each module's tests run with fake ports only?

**Result:** YES — this is the PRIMARY BENEFIT of the hexagonal layout. Each module's domain/ layer is pure (no imports outside domain/ + shared/). Each module's application/ layer takes ports as parameters. Tests inject fakes. No SQLite, no MCP, no claude CLI needed for module-level tests.

Current state: this is ALREADY true for the pure policies (12/18 are pure). The relocation makes it true for the HANDLERS too — they move from formalization-installation.ts (which imports infrastructure adapters) to modules/formalization/application/ (which imports only ports).

**Verdict:** SAFE. Improved testability is confirmed.

### ATTACK-010: Self-registration hides ordering dependencies

**Test:** Do modules have ordering dependencies in registration?

**Result:** YES — the process-outcome-emitter handler must be registered BEFORE module handlers (because modules reference it by id). Also, the KernelHandlerRegistry must exist before any module registers handlers. And the HumanInteractionRegistry must exist before Delivery registers its approval interaction.

**Risk:** If registerDiscovery() is called before the registry exists, it throws. If registerDelivery() is called before HumanInteractionRegistry, it throws. The ordering is: (1) create registries, (2) register process-outcome-emitter, (3) register modules in any order, (4) create LifecycleOrchestrator.

**Mitigation:** The composition root enforces this order explicitly (it's ~10 lines of sequential calls). Self-registration does NOT mean "automatic discovery" — it means "one function call per module." The order is deterministic and visible.

**Verdict:** MANAGEABLE. Ordering is explicit in composition root.

---

## Revised Target Architecture

### Changes from Phase 6

1. **PORT-001 revised:** WorkplaceProductPort provides TWO reads:
   - `submitWork({ schema, content, executionRef })` → unified write to saga3_process_products
   - `readWorkplaceOutput(processRunId, nodeId)` → unified read for cross-module handoff
   - Module-internal provenance reads (managed-production-ledger) are PRESERVED — not replaced

2. **Desk unification scope narrowed:** The universal desk is the cross-module HANDOFF mechanism. Module-internal kernel handlers continue to read their own provenance tables. This avoids the "lost provenance" risk (ATTACK-007) and reduces migration scope.

3. **Registration ordering:** Made explicit. Composition root is NOT "discovery and let it figure out" — it's a deterministic sequence.

### Revised ADR

| ADR | Change |
|---|---|
| ADR-RECON-002 | REVISED: Desk unification is at the cross-module handoff level, not a full replacement of module-internal tables. Universal desk for handoff + module tables for provenance. |

### Summary of adversarial review

- 10 attacks tested
- 6 SAFE (no weakness found)
- 3 MANAGEABLE (weakness found, mitigation defined)
- 1 REVISED (PORT-001 scope narrowed)

The target architecture survives adversarial review with one meaningful revision: desk unification is scoped to cross-module handoff, not full table replacement. This is LESS ambitious than the original Phase 6 proposal but MORE safe — it preserves rich provenance while still solving the LEGO contract (modules don't need to know about other modules' tables).
