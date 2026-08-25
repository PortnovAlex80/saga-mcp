// WP-13C / EK-9 — THE KERNEL MUTATION REGISTRY (the ONE declaration site).
//
// Consumed by tools/ek-mutation-coverage.mjs. Every entry names a RED/GREEN
// mutation demonstration a kernel suite documents in-test and makes it REAL:
// the harness applies the defect as a patch to the compiled kernel in a temp
// workspace and requires the named suite to flip RED.
//
// Why this file lives in tests/infrastructure/ (not beside the harness in
// tools/): the WP-08 structure oracle
// (tests/workflow-kernel/development/structure.test.mjs — "the vertical is
// reachable ONLY from focused tests: no production entrypoint imports it")
// textually forbids the literal vertical path inside ANY tools/*.mjs. The
// registry legitimately names kernel suite paths (that is its data), so it
// lives on the WP-13C test-infrastructure surface the oracle deliberately
// does not scan. The convention is still ONE central registry — suites and
// their owning packages never fragment it (see the harness header for the
// full convention text).
//
// Entry grammar (enforced by the harness):
//   id      unique 'suite/defect-name'
//   kills   the in-suite demonstration this makes real (name it)
//   suite   the *.test.mjs that MUST go red when the defect is applied
//   target  the compiled file (dist/workflow-kernel/...) to patch
//   find    an exact substring of the target — MUST match exactly once
//           (0 matches = registry rot, >1 = ambiguous anchor; both blocking)
//   replace the defective replacement
export const REGISTRY = [
  // ── domain model suite ──
  {
    id: 'model/drop-successor-obligations',
    kills: 'mutation a: "missing successor obligation is killed (durable-handoff grammar break)" — made real: the engine NEVER emits successor obligations',
    suite: 'tests/workflow-kernel/model/mutations.test.mjs',
    target: 'dist/workflow-kernel/domain/explorer.js',
    find: 'mutations?.dropSuccessorObligations ? [] : (rule.obligations ?? descriptor.createsObligations)',
    replace: 'true ? [] : (rule.obligations ?? descriptor.createsObligations)',
  },
  {
    id: 'model/disable-revision-fence',
    kills: 'mutation e: "a stale expected revision accepted is killed (fence disabled)" — made real: the CAS revision fence never refuses',
    suite: 'tests/workflow-kernel/model/mutations.test.mjs',
    target: 'dist/workflow-kernel/domain/explorer.js',
    find: 'if (!mutations?.disableRevisionFence && input.expectedRevision !== currentRevision) {',
    replace: 'if (false && !mutations?.disableRevisionFence && input.expectedRevision !== currentRevision) {',
  },
  {
    id: 'model/disable-dead-wake-conversion',
    kills: 'mutation g: "a dead predecessor leaving a dependant pending is killed (D7)" — made real: dead-wake conversion never runs',
    suite: 'tests/workflow-kernel/model/mutations.test.mjs',
    target: 'dist/workflow-kernel/domain/explorer.js',
    find: 'if (failureCommitted && !mutations?.disableDeadWakeConversion) {',
    replace: 'if (failureCommitted && false) {',
  },
  // ── application suite ──
  {
    id: 'app/waits-undeclared-wake-allowed',
    kills: 'waits.test.mjs: "A command that is not a declared wake source of this wait is refused" — made real: ANY command may wake a wait',
    suite: 'tests/workflow-kernel/application/waits.test.mjs',
    target: 'dist/workflow-kernel/application/waits.js',
    find: 'if (!wait.wakeCommands.includes(payload.command)) {',
    replace: 'if (false && !wait.wakeCommands.includes(payload.command)) {',
  },
  {
    id: 'app/completion-decoupled-from-target-event',
    kills: 'consumer.test.mjs #1: "obligations complete only in the transaction of their target result: completed_by_key binds one consume key to one event" — made real: the obligation completion is recorded against the PREVIOUS event sequence (durable completion no longer proves its target command)',
    suite: 'tests/workflow-kernel/application/consumer.test.mjs',
    target: 'dist/workflow-kernel/persistence/kernel-ledger.js',
    find: '.run(afterRecord.completionEvidenceRef ?? null, meta.idempotencyKey, meta.sequence, completionJson, before.obligationRowIds[index]);',
    replace: '.run(afterRecord.completionEvidenceRef ?? null, meta.idempotencyKey, Math.max(0, meta.sequence - 1), completionJson, before.obligationRowIds[index]);',
  },
  // NOTE (registry convention, documented non-entry): consumer.test.mjs's
  // "two consumers cannot both own one obligation" (CAS lease exclusivity)
  // is deliberately NOT a registry mutation: the kill is defense-in-depth —
  // the pure-engine fence (explorer) AND the repository SQL CAS backstop
  // each independently refuse the stale consumer, so no single-file source
  // mutation can flip it (verified empirically: disabling either layer alone
  // leaves the suite green). Single-layer mutations are the harness's unit.
  // ── development suite ──
  {
    id: 'dev/foreign-workintent-ref-accepted',
    kills: 'mutation: foreign-ref — "an attempt binding a foreign WorkIntent is refused" — made real: the foreign-ref guard passes any WorkIntent',
    suite: 'tests/workflow-kernel/development/mutations.test.mjs',
    target: 'dist/workflow-kernel/domain/reducers/activity-attempt.js',
    find: "return refuse('FOREIGN_EVIDENCE_REF', `WorkIntent ${input.workIntentRef} was not admitted by any Workplace transition`);",
    replace: 'return { requiredEvidenceKinds: [] };',
  },
];
