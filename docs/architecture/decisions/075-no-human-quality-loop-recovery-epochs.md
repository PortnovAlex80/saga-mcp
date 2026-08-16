# ADR-075: No human in the quality loop — recovery epochs instead of human parks

- **Status:** Accepted (operator product decision, 2026-08-16)
- **Date:** 2026-08-16
- **Supersedes:** the quality-cell usage of `onExhausted: 'pause'` (the park mechanism itself remains for Delivery/infra boundaries)
- **Reviewed by:** three independent deep-analysis agents (normative model review, implementation-seam analysis, adversarial failure-mode review) prior to implementation

---

## Context

The operator's product decision:

> There must be no "needs a human" status in the quality loop. A human is
> needed ONLY at the Delivery stage (physical infrastructure). LLMs can
> generate text and code without practical limits — a human has no role in
> author/reviewer/repair cycles.

Live motivation (project 1, "stopwatch", 2026-08-16): the development
implementation author failed a deterministic AC-9 gate 3 times with exact
feedback; the line parked with `RECOVERY_BUDGET_EXHAUSTED`, the engine stopped
in `paused` ("require explicit resume"), and NO sanctioned resolution path
existed — no `human_requests` row, no board affordance, no general CLI verb.
A fail-closed boundary without a resolution organ is a scheduled death for an
unattended factory.

## Normative analysis (summary)

`human_required → paused` is a LEGAL transition in the gate grammar
(CONVEYOR-MENTAL-MODEL §4), but nothing in the normative model REQUIRES
quality cells to emit it: "who emits human_required and when" is package
policy, and the model itself forbids anonymous infinite waits/loops
("their absence must become a truthful typed wait or bounded escalation,
never an infinite anonymous pause"). `failed → terminal(failed)` is a legal
gate outcome; terminal monotonicity is preserved (continuation happens via
append-only continuation runs, never by mutating terminals).

## Decision

1. **`CellRecoveryPolicy.onExhausted` gains `'requeue'`** alongside
   `'fail' | 'pause'`. Policy stays declarative in cell definitions (the
   runtime must not branch on module names).
2. **All quality cells (discovery ×2, formalization ×5 via one factory point,
   development ×4) declare `'requeue'`.** `'pause'` remains legal and in use
   for Delivery approval and infrastructure/effect boundaries
   (`ACCEPTANCE_EFFECT_BLOCKED`, `WORKER_SPAWN_FAILED`, gate indeterminacy).
3. **Budget rollover is a durable audit fact, never a deletion.** The three
   attempt counters (rejected CandidateSets, terminal worker executions,
   failed acceptance-effect repairs) are all-time and immutable; each
   rollover appends one row to the new append-only
   `factory_workplace_recovery_epochs` table snapshotting the counter
   baselines. Attempts-in-epoch = counter − baseline. Idempotent by
   UNIQUE (workplace_ref, role, epoch); immutable by triggers.
4. **Non-human circuit breakers (mandatory, from the adversarial review):**
   - **Inter-epoch backoff** — exponential 1/2/4/8… min cap 15 min, derived
     from the epoch row's `created_at`, holding the line in `repair_wait`
     during the window (damps identical-failure attractors and spawn storms).
   - **Total-attempt cap** (`recovery.totalAttempts`, default
     `DEFAULT_RECOVERY_TOTAL_ATTEMPTS = 30`) — on breach the line fails
     terminally (`failed`, isFinal) with the accumulated diagnosis logged:
     autonomy is bounded by an honest terminal outcome, never an anonymous
     infinite loop.
   - **Checkpoint retention** — the checkpoint store keeps the newest 10
     manifests per (project, epic) and garbage-collects unreferenced objects;
     full-DB checkpoint objects are never deduplicated by content addressing,
     so without retention an autonomous run fills the disk.
5. **Observability:** every rollover logs
     `[recovery-budget] ROLLOVER cell=… workplace=… role=… epoch=… total=N/CAP
     backoffMs=… :: diagnosis`, and the cap logs
     `[recovery-budget] TOTAL-CAP … — terminal failed`.

## Consequences

- The engine no longer stops at quality-budget exhaustion; an unattended
  factory keeps driving until lines accept or fail honestly.
- `humanPausedCount`-based engine exit now fires only for genuine
  Delivery/infra parks.
- Continuation after a total-cap failure is an explicit new Factory Start /
  continuation run over the accepted prefix (terminal monotonicity intact).
- Schema bumped to v12 (additive table only).

## Follow-ups (second queue, seams verified live)

- Model escalation at claim-time on identical candidate digests
  (glm-4.7 → glm-5-turbo → glm-5.2; one UPDATE of the durable model route).
- Attempt variability in the workspace materializer (rotate strategic
  directives, include ALL past diagnoses, not only the last).
- Remaining non-quality human boundaries (gate indeterminacy, effect-blocked,
  spawn-failed) need explicit autonomous policies — separate decisions.
