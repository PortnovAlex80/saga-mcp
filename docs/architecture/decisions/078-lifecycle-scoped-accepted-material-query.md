# ADR-078: Lifecycle-scoped accepted material query

- **Status:** Accepted
- **Date:** 2026-08-17
- **Supersedes:** epic-scoped accumulation as an accepted-read basis (the pattern flagged by ADR-053 and the 2026-08-16 audits)
- **Program:** Saga Core Renewal, release K6 (see `docs/vision/SAGA-CORE-RENEWAL-PLAN.md`)

---

## Context

The Formalization settlement vertical still reads accepted material by EPIC
accumulation:

```sql
SELECT id, type FROM artifacts WHERE epic_id=? AND status='accepted'
SELECT id, status, accepted_hash, content_hash, drift_state
  FROM artifacts WHERE epic_id=? AND type='AC'
```

(`sqlite-formalization-kernel.ts` — `readAcceptedArtifacts`,
`readAcceptanceBaselineHash`.) An epic accumulates workplace rows and
artifacts across ALL of its lifecycle runs. A settlement of lifecycle N can
therefore certify material produced by lifecycle N-1 or N-2 — cross-run
contamination, the exact class ADR-053 was written against. The task-side
gate (`areTasksReady`) was already lifecycle-scoped by TB-11 using the
authoritative ownership chain `factory_stage_runs.lifecycle_run_id`; the
material side was not.

## Decision

### 1. The exact accepted material query contract

Every accepted-material read on a settlement path MUST be scoped by the
CURRENT lifecycle run:

```
AcceptedMaterialQuery {
  epicId            // retained for diagnostic context only — never a filter
  lifecycleRunId    // authoritative scope (factory_stage_runs)
}
```

Material joins the lifecycle through the workplace ownership chain — the
same chain TB-11 established:

```
artifacts → tasks (producing task) → factory_workplaces.process_run_id
          → factory_stage_runs.lifecycle_run_id = :lifecycleRunId
```

A material row with no producing-task linkage to the CURRENT lifecycle run
is NOT part of this settlement's input. It is not an error — it simply
belongs to another run.

### 2. Fail-closed rules

- Missing exact authority (no lifecycle binding resolvable) is an ERROR, not
  a request to choose the latest rows.
- A settlement that finds zero lifecycle-scoped accepted material fails
  closed (`No formalization material for this lifecycle run`), mirroring the
  task-gate's empty semantics — never a silent fallback to epic scope.
- One consumer never has two accepted-material query paths: after cutover,
  the epic-scoped readers on the settlement path are DELETED, not retained
  as fallback (ADR-053: "старые execution-scoped material lookups удаляются,
  а не сохраняются как постоянный fallback" — same rule for epic-scoped).

### 3. Scope of this decision

- Covers: Formalization settlement completeness reads (`readAcceptedArtifacts`)
  and the acceptance-baseline hash read (`readAcceptanceBaselineHash`).
- Does NOT cover (later releases): the replay capsule binder (K8 — its own
  exact semantic key), effects re-selection (K11 — authority-only effects),
  CandidateSet execution ownership (K10).

## Consequences

- The two-lifecycle contamination theorem becomes statable and testable:
  two lifecycles under one epic, accepted material in each — a settlement
  of run N sees ONLY run N's material.
- Historical runs' material stays readable for audit (immutable rows), it
  just stops feeding a foreign settlement.
- Traceability reads outside settlement (K7) follow this contract as the
  second vertical.
