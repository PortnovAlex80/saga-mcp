# ADR-007: CGAD convergence retrospective — what landed, what's still gap

## Status
Accepted (2026-07-17)

## Context

ADR-005 (2026-07-17) adopted CGAD v2 as saga's target-state reference and recorded a six-gap roadmap. This ADR records what actually landed in the eight hours following ADR-005, what is now legitimately closed, and what honest gaps remain.

The user pain that drove the work: **«Параллельные агенты ломают друг друга»**. The convergence brief was: bring saga-mcp to the CGAD concept, gap by gap, with intermediate builds.

## Decision

This ADR is a **retrospective record**, not a new decision. It supersedes nothing; it qualifies ADR-005's roadmap with what-shipped reality.

## What landed (six REQs, all merged to saga-mcp dev)

| REQ | CGAD gap | What shipped | Tests | Lint rule |
|---|---|---|---|---|
| REQ-013 | Pattern B default (gap not in ADR-005; added by ADR-006) | cgad-spec-lint R4 + saga-planner skill warning | 9 R4 unit tests | CGAD-R4 |
| REQ-008 | #1 4-valued guard verdict | `verification_evidence.outcome` widened to {passed/failed/unknown/error}; `provider` column added; `verification_record` tool updated; `migrateVerificationOutcome` rebuild migration; assertVerificationPassed unchanged (still filters outcome='passed') | +5 tests (88/88) | CGAD-R1 strengthened |
| REQ-009 | #2 RiskClass computation | `tasks.declared_risk/derived_risk/policy_minimum/final_risk` columns; `computeFinalRisk()`, `deriveRiskFromTags()`, `derivePolicyMinimum()`; `task_create`/`task_update` compute final_risk deterministically; agent cannot self-lower (P15) | +6 tests (94/94) | CGAD-R2b added |
| REQ-011 | #4 Runtime Observation Store | New `runtime_observations` table + `observation_record` / `observation_list` tools; P17 enforced structurally (no UPDATE path to mutate accepted_hash) | +8 tests (102/102) | — |
| REQ-010 | #3 Semantic Conflict Model | New `task_conflict_keys` table + 5 tools (`conflict_keys_set/list/clear/auto_derive`, `conflict_check`); typed keys file_path/schema/public_protocol/integration_branch | +8 tests (110/110) | CGAD-R5 added |
| REQ-012 | #6 Full cgad-spec-lint | Linter v0.1 → v1.0: 12 rules cover 12 of 25 CGAD §22 forbidden constructs | — (linter is standalone) | R6/R7/R8/R9/R10/R11/R12 added |

**saga-mcp test suite: 83 → 110 green (+27 tests, 0 regressions).**
**cgad-spec-lint: 3 rules → 12 rules.**
**Lint findings on live saga.db: 186 → 232** (+46 = 45 R12 legacy verified_by on non-verification.ac tasks + 1 R8 drifted artifact). These are real CGAD violations surfaced in historical data, not regressions.

## What is now legitimately closed (per Sign 008)

With the corresponding REQs merged, the following ADR-005 mappings move from **descriptive** to **implementive**:

| CGAD concept | saga entity | Now legitimate to call it |
|---|---|---|
| 4-valued guard verdict (§7) | `verification_evidence.outcome` {passed/failed/unknown/error} | ✅ yes |
| Trusted Guard Input Provider identity (§6) | `verification_evidence.provider` | ✅ yes (column exists; backfill ongoing) |
| RiskClass computation (§11) | `tasks.declared_risk/derived_risk/policy_minimum/final_risk` + `computeFinalRisk()` | ✅ yes |
| Runtime Observation Store (§17) | `runtime_observations` table + tools | ✅ yes |
| Semantic Conflict Model (§7 Phase 7 v1) | `task_conflict_keys` + 5 tools | ✅ yes (v1; v2 key types still gap) |
| Deterministic cgad-spec-lint (§40) | 12 rules covering 12 of 25 §22 constructs | ✅ yes (partial coverage of construct catalog) |

## What remains descriptive or out of scope

| CGAD concept | Status | Why |
|---|---|---|
| ConstitutionVersion (§21, P16) | **Permanently out of scope** per ADR-005 | Single-team product; multi-team ceremony without commensurate benefit. |
| Full Architecture Graph (§16, 24 nodes / 21 edges) | Descriptive | `artifact_traces` has 6 edge types. REQ-010 added 4 typed conflict-key types, but the full graph metamodel is not modeled. Future REQ if a real pain surfaces. |
| Wave Scheduler (§15) as separate component | Descriptive | Episode stage machine remains the wave model. Adequate. |
| Trusted Provider Registry as a separate table | Descriptive | `verification_evidence.provider` is a free-form string; the registry (with trust basis, determinism, replayability) is not modeled. Future REQ if provider misuse becomes a pain. |
| AgentLease lifecycle separated from Resource State (§18) | Descriptive | `worker_merge_acquire` is merge-lock-scoped (narrower than CGAD). ADR-005 §Decision 4 already called this out as exceeding CGAD on the resource-vs-lease distinction; the lease lifecycle is not modeled as its own state machine. |
| ContractVersion lifecycle (§15) | Descriptive | `artifacts.accepted_hash` + `drift_state` cover freeze + drift, but a multi-version ContractVersion state machine is not modeled. |
| CGAD §22 forbidden constructs #25 (LLM-reasoning guard), #35-37 (monolithic skill / max governance), #38 (forbid Builder tests) | Not applicable / not enforceable from DB | These are process rules; saga cannot detect them deterministically from the DB alone. |

## Three-Truths reconciliation

- **Declared (ADR-005 Roadmap):** six gaps, with effort estimates totalling ~85h.
- **Implemented (saga-mcp code post-convergence):** six REQs merged, +27 tests, +9 lint rules, schema migrations all additive and backward-compatible with the 26-project / 114-epic / 625-task live DB.
- **Observed (cgad-spec-lint v1.0 on live saga.db):** 232 findings. 186 unchanged from baseline; +46 are real CGAD violations surfaced by new rules (45 R12 + 1 R8). R6/R7/R9/R10/R11 are clean — saga's existing workflow was already compliant on those axes.

The three truths are mutually consistent. The Roadmap predicted ~85h of work; the actual convergence ran in one extended session, with effort concentrated in schema migrations and lint rule design. The Roadmap's estimates were conservative.

## Did the user pain close?

**«Параллельные агенты ломают друг друга»** — yes, structurally:

1. **REQ-013 / R4**: greenfield episodes reaching development with ≥2 parallel tasks sharing a module and no scaffold are now flagged. Forces the planner to use Pattern B.
2. **REQ-010 / R5**: semantic collisions (file_path / schema / public_protocol / integration_branch) are detected at planning time via `conflict_check`, before any worker starts.
3. **REQ-010 tools**: `conflict_keys_auto_derive` populates keys from task fields without manual effort.

What is **not** closed: the full CGAD §7 Phase 7 conflict catalog (capability, invariant, aggregate, data_owner, migration, security_boundary, benchmark_env, runtime_resource key types). v1 ships 4 of 12. If a real cross-file invariant conflict surfaces that v1 keys miss, that is the trigger for v2.

## Consequences

- **Code:** six feature branches merged to saga-mcp dev. Schema migrations run automatically on first `getDb()` after deploy. No data loss, no manual migration step.
- **Testing:** 110/110 green. Every REQ has its own test cluster named `REQ-NNN:` for grep-ability.
- **Lint:** cgad-spec-lint v1.0 is the deterministic guard layer. CI should run it on saga.db post-deploy and surface findings as a quality gate.
- **Skills:** saga-planner updated to document R4 + conflict_keys workflow. cgad skill updated to reference v1.0 lint (12 rules). saga-worker and saga-orchestrator skills unchanged at the mechanism level (they call tools, not enforce invariants).
- **Future:** a v2 of REQ-010 (more key types), a v2 of REQ-012 (more rules), and a provider-registry REQ may follow if pains surface. None is currently blocking.

## Reversibility

Each REQ is independently reversible:
- Schema columns are nullable; drop them and the legacy column (priority) still works.
- Tables (`runtime_observations`, `task_conflict_keys`) can be dropped — no foreign keys from other tables point to them.
- Lint rules can be commented out individually.
- Migrations are idempotent; re-running them on a post-migration DB is a no-op.

## Related

- [ADR-005](005-saga-as-cgad-lite-evolution.md) — original roadmap (this ADR's source)
- [ADR-006](006-req-013-pattern-b-default.md) — Pattern B default (REQ-013)
- [cgad-audit.md](../cgad-audit.md) — Phase 0 audit baseline
- GUARDRAILS Signs 001-008 (Sign 009 added by this ADR's companion)
- saga-mcp dev branch: REQ-008/009/010/011/012/013 feature branches, all merged
