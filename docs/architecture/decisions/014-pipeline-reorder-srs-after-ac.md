# ADR-014: Pipeline Reorder — SRS after AC + Complexity Gate + DECOMP

**Status:** Accepted
**Date:** 2026-07-20
**Supersedes:** Part of ADR-008 (sibling() rationale between SRS and UC)

## Context

The original saga pipeline placed SRS (Architecture step) BEFORE AC (Acceptance
Criteria). This created five observed problems on the Cannon REQ-001 episode:

1. **Over-engineering.** For an M-size web calculator, saga-architect chose
   Hexagonal/Ports with 5 modules — wildly oversized for the problem.
2. **Blind planner.** saga-planner copied AC descriptions verbatim into tasks,
   ignoring SRS Port Registry. Workers spent 7+ Read calls exploring structure.
3. **SRS↔scaffold drift.** SRS §2b named `src/physics/orbital.ts`; scaffold
   created `src/physics-engine/orbital.ts`. Two sources of truth.
4. **NFR-as-dev-tasks.** Planner created 7 development.code tasks for NFR-ACs
   that should be verification tasks or merge_with parent UI tasks.
5. **Empty conflict keys.** All 15 dev tasks had only `integration_branch=dev`
   — file_path/schema/public_protocol were never set, so parallel work was
   unprotected.

## Root cause

Step 5 (Architecture/SRS) was out of order. SRS was written BEFORE the project's
acceptance criteria were frozen. The architect worked blind.

The fundamental development flow is:
```
IDEA → WHY → WHAT → HOW USERS USE → HOW TO VERIFY → HOW TO BUILD → COMPONENTS → WORK → CODE → CHECK → PROD
BRIEF  PRD    UC          AC              SRS          DECOMP      Planning    Dev     Verify  Integrate
```

Each step takes input from the previous. "HOW TO BUILD" is impossible until
"HOW TO VERIFY" is defined — you cannot choose architecture without knowing
what to build and at what complexity.

## Decision

Move SRS from its original position (parallel with UC, before AC) to AFTER AC:

```
BRIEF → PRD(+FR/NFR/RULE) → UC → AC → Reconcile → SRS(+DECOMP) → Planning → Dev → Verify → Integrate
                                                     ↑
                                                     architect now sees frozen ACs + brief complexity
```

Three coupled changes:

### 1. New workflow transitions (workflow.ts)

| task_kind | transition | creates |
|---|---|---|
| discovery.kickstart | brief_accepted | formalization.prd |
| formalization.prd | prd_accepted | ONLY formalization.uc (not SRS+UC) |
| formalization.uc | uc_accepted | formalization.ac (no SRS wait) |
| formalization.ac | ac_accepted | formalization.reconciliation |
| formalization.reconciliation | baseline_accepted | formalization.srs (NEW) |
| formalization.srs | srs_accepted (NEW) | planning.decomposition |

### 2. Complexity Gate linked to architect

The brief payload already contains `complexity.tshirt`, `topology_hint`,
`shared_mutation_risk` (validators/brief.ts:36-65). Previously these were
computed but unused by the architect. Now the architect MUST read the brief
and select architecture strictly by this table:

| complexity.tshirt | topology_hint | shared_mutation_risk | Architectural Style |
|---|---|---|---|
| XS | sequence | false | KISS (single file) |
| S | sequence | false | KISS / Module |
| M | sequence | false | Modular Monolith |
| M | scaffold-then-parallel | true | Modular Monolith + Ports |
| L/XL | scaffold-then-parallel | true | Hexagonal / Ports |
| L/XL | sequence | false | Layered / Pipeline |
| research | any | any | Spike-first |

### 3. DECOMP §D section in SRS

A new YAML section in SRS that maps each accepted AC to its implementation:
files, functions, types, public_protocol, conflict_keys, invariants,
pattern, ac_kind. The planner becomes a dumb copier: it reads §D2 and
creates one task per entry, copying all fields into task.metadata.

## Consequences

**Positive:**
- Architect cannot over-engineer: complexity gate mandates style.
- Planner cannot drift: §D1 file tree is canonical, scaffold must follow.
- Workers get target_file/schema in task.metadata on first Read.
- NFR-ACs become verification or merge_with tasks (not dev.code).
- conflict_keys_auto_derive picks up file_path/schema/public_protocol.

**Negative:**
- Cannon REQ-001 and other existing episodes are not migrated. New episodes
  use the new pipeline; old episodes keep the old one.
- ADR-008's sibling() rationale between SRS and UC is invalidated (see addendum
  in [008-brief-accepted-prd-only.md](008-brief-accepted-prd-only.md)).
- 3 test files (~700-800 LoC) need rewriting (formalization-mechanics,
  traceability-gate, product-workflow).
- 11 skills need updating, 12 docs.

## References

- Full plan: `docs/plans/PIPELINE-REORDER-SRS-AC.md`
- Subagent decomposition: `docs/plans/PIPELINE-REORDER-SRS-AC-SUBAGENTS.md`
- Cannon REQ-001 (observation episode): epic_id=1 in saga.db
