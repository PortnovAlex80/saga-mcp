# Relocation Map, Fossil Register, Load-Bearing Hacks, Emergent Successes

Artifact ID: ART-PHASE8-RELOCATION
Artifact Type: Responsibility-Cluster Relocation Map + First-Tranche Symbol Map + Fossil/Hack/Success Registers
Phase: Phase Eight
Version: 1.0
Status: recommended-pending-approval
Created From: ART-PHASE6-TARGET-ARCHITECTURE, ART-PHASE7-ADVERSARIAL-REVIEW, all prior artifacts
Coverage: All production source units mapped to target blocks. First tranche specified at symbol level.
Confidence: High for current location; Medium for target feasibility (untested)
Downstream Dependencies: Phase 9, Phase 10 (Migration Plan)

---

## Relocation Map (Responsibility Clusters)

### MOVE-001: Discovery domain → modules/discovery/domain/
| Current | Target | Affected scenarios | Mechanism | Risk |
|---|---|---|---|---|
| src/saga3/domain/discovery-settlement-policy.ts | modules/discovery/domain/settlement-policy.ts | SCN-001 | Direct move + update imports | LOW — pure module, no I/O deps |
| src/saga3/domain/discovery-settlement-input.ts | modules/discovery/domain/settlement-input.ts | SCN-001 | Direct move | LOW |
| src/saga3/domain/discovery-proposal.ts | modules/discovery/domain/proposal.ts | SCN-001 | Direct move | LOW |
| src/saga3/domain/discovery-outcome-certificate.ts | modules/discovery/domain/outcome-certificate.ts | SCN-001 | Direct move | LOW |
| src/saga3/domain/discovery-readiness-assessment.ts | modules/discovery/domain/readiness-assessment.ts | SCN-001 | Direct move | LOW |
| src/saga3/domain/work-intent.ts | shared/work-intent.ts | ALL | Direct move — cross-cutting, not discovery-specific | LOW |

### MOVE-002: Discovery application → modules/discovery/application/
| Current | Target | Mechanism | Risk |
|---|---|---|---|
| src/saga3/application/discovery-settlement-service.ts | modules/discovery/application/settlement-service.ts | Direct move + replace saga3/ imports with domain/ | LOW |
| src/saga3/application/discovery-certificate-bundle.ts | modules/discovery/application/certificate-bundle.ts | Direct move | LOW |

### MOVE-003: Discovery persistence → modules/discovery/infrastructure/
| Current | Target | Mechanism | Risk |
|---|---|---|---|
| src/saga3/persistence/sqlite-saga3-discovery-runtime.ts | modules/discovery/infrastructure/sqlite-discovery-runtime.ts | Direct move + update imports | MEDIUM — large file, many imports |

### MOVE-004: saga3/shared → shared/
| Current | Target | Mechanism | Risk |
|---|---|---|---|
| src/saga3/shared/discovery-canonical.ts | src/shared/canonical-json.ts | Direct move + update all re-exports | LOW — already re-exported from 3 locations |

### MOVE-005: saga3/authority → shared/authority/
| Current | Target | Mechanism | Risk |
|---|---|---|---|
| src/saga3/authority/authorize-saga-tool-call.ts | src/shared/authority/authorize-tool-call.ts | Direct move | MEDIUM — referenced by index.ts, proposal_submit, many tests |
| src/saga3/authority/build-execution-context.ts | src/shared/authority/build-execution-context.ts | Direct move | LOW |
| src/saga3/domain/execution-context.ts | src/shared/authority/execution-context.ts | Direct move | LOW |

### MOVE-006: Formalization infrastructure → modules/formalization/infrastructure/
| Current | Target | Mechanism | Risk |
|---|---|---|---|
| src/infrastructure/process-modules/formalization/sqlite-formalization-kernel.ts | modules/formalization/infrastructure/sqlite-kernel.ts | Direct move | MEDIUM — duplicate traceability impl (SEAM-010) needs consolidation first |
| src/infrastructure/process-modules/formalization/formalization-persistence.ts | modules/formalization/infrastructure/persistence.ts | Direct move | LOW |

### MOVE-007: Development infrastructure → modules/development/infrastructure/
| Current | Target | Mechanism | Risk |
|---|---|---|---|
| src/infrastructure/process-modules/development/ | modules/development/infrastructure/ | Direct move (whole directory) | LOW |

### MOVE-008: Delivery infrastructure → modules/delivery/infrastructure/
| Current | Target | Mechanism | Risk |
|---|---|---|---|
| src/infrastructure/process-modules/delivery/ | modules/delivery/infrastructure/ | Direct move (whole directory) | LOW |

### MOVE-009: Module registration functions → modules/<name>/index.ts
| Current | Target | Mechanism | Risk |
|---|---|---|---|
| createDiscoveryKernelHandlers (discovery-installation.ts) | modules/discovery/index.ts:registerDiscovery() | Extract + wrap in register function | MEDIUM |
| createFormalizationKernelHandlers (formalization-installation.ts) | modules/formalization/index.ts:registerFormalization() | Extract + wrap | MEDIUM (2043-line file) |
| createDevelopmentKernelHandlers (development-installation.ts) | modules/development/index.ts:registerDevelopment() | Extract + wrap | LOW |
| createDeliveryKernelHandlers (delivery-installation.ts) | modules/delivery/index.ts:registerDelivery() | Extract + wrap | LOW |

### MOVE-010: Composition root slim-down
| Current | Target | Mechanism | Risk |
|---|---|---|---|
| product-lifecycle-runtime.ts (780 lines) | product-lifecycle-runtime.ts (~80 lines) | Replace inline wiring with 4 register*() calls | MEDIUM — behavioral equivalence must be proven by characterization tests |

---

## First-Tranche Symbol Map

The first tranche establishes ONE module boundary as a proof of concept. Selection rationale: **Discovery** — it has the clearest domain boundary (saga3/ → modules/discovery/), the fewest cross-module dependencies, and the most pure functions.

### Tranche 1: Discovery module consolidation

**Objective:** Move all discovery-specific code into modules/discovery/ and create registerDiscovery(deps).

**Symbols to relocate (17 files):**

1. `src/saga3/domain/discovery-settlement-policy.ts` → `modules/discovery/domain/settlement-policy.ts`
2. `src/saga3/domain/discovery-settlement-input.ts` → `modules/discovery/domain/settlement-input.ts`
3. `src/saga3/domain/discovery-settlement-records.ts` → `modules/discovery/domain/settlement-records.ts`
4. `src/saga3/domain/discovery-proposal.ts` → `modules/discovery/domain/proposal.ts`
5. `src/saga3/domain/discovery-normalization.ts` → `modules/discovery/domain/normalization.ts`
6. `src/saga3/domain/discovery-readiness-assessment.ts` → `modules/discovery/domain/readiness-assessment.ts`
7. `src/saga3/domain/discovery-readiness-records.ts` → `modules/discovery/domain/readiness-records.ts`
8. `src/saga3/domain/discovery-outcome-certificate.ts` → `modules/discovery/domain/outcome-certificate.ts`
9. `src/saga3/application/discovery-settlement-service.ts` → `modules/discovery/application/settlement-service.ts`
10. `src/saga3/application/discovery-certificate-bundle.ts` → `modules/discovery/application/certificate-bundle.ts`
11. `src/saga3/persistence/saga3-settlement-repository.ts` → `modules/discovery/infrastructure/settlement-repository.ts`
12. `src/saga3/persistence/sqlite-saga3-discovery-runtime.ts` → `modules/discovery/infrastructure/sqlite-discovery-runtime.ts`
13. `src/saga3/persistence/saga3-discovery-runtime-port.ts` → `modules/discovery/application/ports/discovery-runtime-port.ts`
14. `src/process-modules/modules/discovery/discovery-installation.ts` → `modules/discovery/application/handlers.ts`
15. `src/process-modules/modules/discovery/discovery-domain-contracts.ts` → `modules/discovery/domain/contracts.ts`
16. `src/process-modules/modules/discovery/discovery-process-module.ts` → `modules/discovery/package/manifest.ts`
17. `src/process-modules/modules/discovery/package/` → `modules/discovery/package/` (already in place — just update path)

**Cross-cutting extractions (3 files):**
18. `src/saga3/shared/discovery-canonical.ts` → `src/shared/canonical-json.ts`
19. `src/saga3/domain/execution-context.ts` → `src/shared/authority/execution-context.ts`
20. `src/saga3/authority/authorize-saga-tool-call.ts` → `src/shared/authority/authorize-tool-call.ts`

**New files (2):**
21. `modules/discovery/index.ts` — `registerDiscovery(registry, sharedDeps): void`
22. `modules/discovery/application/ports/discovery-ports.ts` — DiscoveryBriefProvisioningPort, DiscoverySettlementPort, DiscoveryRuntimePersistencePort

**Prerequisite:**
- Update dependency-direction ratchet classifiers (tests/architecture/dependency-direction.test.mjs) to recognize new paths
- Update `cutover-architecture-checks.test.mjs` if NEW_CORE patterns change
- Run full test suite (`npm test`) before and after — characterization tests must stay green

**Verification:**
- `npm test` green (all 169+ tests)
- `npm run test:architecture` green (ratchet holds at new paths)
- `modules/discovery/` directory contains ALL discovery-specific code
- `src/saga3/` is EMPTY or contains only truly cross-cutting remnants
- Composition root can register discovery via ONE function call

**Rollback:**
- `git revert` — the tranche is a single commit (or small commit series)
- No data migration, no schema change, no behavioral change — pure file relocation

---

## Fossil Candidate Register

| FOSSIL | Location | Evidence | Safe to remove? | Action |
|---|---|---|---|---|
| FOSSIL-001: Discovery diagnosis handlers | src/tools/saga3-diagnosis.ts + discovery-process-module.ts:297-313 (profile) | SEAM-009: flow node removed, tools still registered | NO — diagnosis is advisory, may be reactivated. Characterize first. | Keep behind feature flag; add test proving no Flow path activates |
| FOSSIL-002: episode_status / episode_transition tools | src/tools/lifecycle.ts | Already removed (only verification_record survives) | YES — already gone | None needed |
| FOSSIL-003: Legacy saga2 engine branches | composition-root.ts | Already removed (only product lifecycle remains) | YES — already gone | None needed |
| FOSSIL-004: integration_intents table | schema.ts | STATE-014: declared, no E3 writer found | NO — ADR-010 designed it for SEAM-013 fix. It's a declared-but-unbuilt solution, not a fossil. | Keep schema; implement writer (ADR-RECON-006) or document as limitation |
| FOSSIL-005: v1 NodeRun path in GenericFlowExecutor | generic-flow-executor.ts:651-659 | DEAD-004: fallback for in-memory test fakes | CONDITIONAL — safe in production (v2 always active), load-bearing in tests. | Characterize with tests; remove after test fakes are updated to v2 |

## Load-Bearing Hack Register

| HACK | Location | Why load-bearing | Replacement plan |
|---|---|---|---|
| HACK-001: markExecutionExited fourth writer | worker-executions.ts:204 | Called from ClaudeBoardRunner close callback — different code path than releaseExecutionAtomically | Route through releaseExecutionAtomically; add birth-token check. (FU-D planned) |
| HACK-002: `as any` in composition root | product-lifecycle-runtime.ts:601 | installationRegistry.register() type mismatch — ProcessModuleDefinition vs registration shape | Fix type or add intermediate type; remove in MOVE-010 |
| HACK-003: `completion: null as unknown as ModuleCompletion` | delivery-installation.ts:517, development-installation.ts:454, formalization-installation.ts:1701, discovery-installation.ts:931 | Type cycle ModuleCompletion ↔ ProcessModuleOutputEnvelope. Serialization constraint. | Break cycle: separate CompletionEnvelope from OutputEnvelope. (ADR-RECON-007) |
| HACK-004: dynamic import for settlement bridge | discovery-installation.ts:165 | createLegacySettlementBridge — dynamic import to avoid static saga3/ edge in module graph | Eliminated by MOVE-001 (settlement service moves into module) |
| HACK-005: ManagedProductionLedger interface duplication | development-kernel-ports.ts + formalization-kernel-ports.ts | TS structural typing hides drift between two identical interface declarations | Extract to shared/managed-production.ts (ADR-RECON-008) |

## Emergent Success Register

| SUCCESS | Location | Why it works | Preserve in target? |
|---|---|---|---|
| SUCCESS-001: Pure policy/mechanism split | stuck-policy.ts vs worker-executions.ts | Uncle Bob Wave 2: pure decideStuckAction + mechanism dispatch. Fully tested without mocks. | YES — preserve. The pattern should be replicated for any new policy. |
| SUCCESS-002: P18 node-durable identity | saga-board-adapter-data-builder.ts:153 | Recovery reuses same card + desk. Hash stability across attempts. | YES — preserve. This is the system's key recovery invariant. |
| SUCCESS-003: Ratchet enforcement | dependency-direction.test.mjs + no-execution-scoped-lookup.test.mjs | Progressive tightening. Stale detection. Zero violations. | YES — preserve AND extend. New module boundaries need new ratchet tests. |
| SUCCESS-004: Content-addressed certificates | discovery-settlement-service.ts + process-outcome-certificate-repository.ts | Write-once, hash-unique, replay-safe. Co-tamper rejection. | YES — preserve. The cleanest state entity in the system. |
| SUCCESS-005: Authority frozen at claim | work-assignment-core.ts:341-358 → authorize-saga-tool-call.ts:156 | Single source of truth for tool permissions. Defense-in-depth (list filter + call gate). | YES — preserve. Move to shared/authority/ as cross-cutting. |
| SUCCESS-006: Single-writer invariant | 3 modules + lint test | Only 3+1 writers for task owner columns. 8-way race tested. | YES — preserve. Consolidate the +1 (HACK-001) into the canonical 3. |
| SUCCESS-007: exactCandidateAcceptance as universal gate | sqlite-exact-candidate-acceptance.ts | All 4 desks funnel through one acceptance CAS. The convergence point. | YES — preserve. This IS the universal gate that proves desk unification is safe. |
