// tests/infrastructure/cc-proof-hosting-manifest.mjs
//
// ADR-092 / CC-U1 — the CC closure PROOF-HOSTING manifest.
//
// SOLE AUTHORITY: this manifest is the only registry for the critical CC
// proof files currently in scope. It deliberately does NOT scan markers,
// source annotations, or the general test tree (ADR-092 rejects marker
// scanning as a primary registry). A file joins this scope ONLY by a
// reviewed manifest edit; the validator below/tools/cc-proof-hosting-registry.mjs
// proves the hosting truth in BOTH directions against the machine-readable
// acceptance-matrix export (tools/run-acceptance-matrix.mjs --list-json) and
// the CI group invocations (.github/workflows/ci.yml).
//
// SCOPE (narrow by ADR-092 — the smallest set covering the already
// identified CC critical proofs; NOT the whole tree):
//   - CC-GAP-8 terminal accounting (the two exact-file proofs hosted in the
//     blocking process-modules matrix group at 9301e8ff/814aacea lineage);
//   - CC-GAP-2 terminal projection (the three committed regression proofs;
//     two are ORPHANED — no blocking matrix group has ever run them — and
//     are registered as typed PENDING rows with tracker+reason, never
//     silently dropped and never pretending to be hosted);
//   - CC-U1: this proof-hosting registry itself (blocking, its own exact
//     matrix group cc-proof-registry — the group run-set and the manifest
//     rows pinned to it must stay in exact bijection).
//
// ROW TYPES:
//   blocking — the file is a critical CC proof AND is hosted: it MUST be in
//              the named acceptance-matrix group's run-set AND that group
//              MUST be invoked by CI. Group rename, run-set drop, quarantine
//              reclassification, or CI omission each fail closed.
//   pending  — the file is a critical CC proof that is NOT yet hosted.
//              Requires non-empty tracker + reason. A pending row can never
//              absorb a blocking proof: if the file IS hosted in any
//              CI-invoked matrix group, the row is a stale/ dishonest
//              pending and fails closed.
//
// This manifest does NOT touch tests/factory-proof/proof-claims.mjs: the
// K1-D proof-mode registry and its exact blocking-group bijection are
// preserved byte-for-byte (ADR-092 Option C exists precisely so the CC
// hosting surface never widens that contract).

export const CC_PROOF_HOSTING_MANIFEST = Object.freeze({
  schemaVersion: 1,
  decision: 'ADR-092',
  trackedAt: '2026-08-23',
  // The dedicated exact-file matrix group whose run-set must equal the
  // manifest blocking rows pinned to it (no silent widening or shrinking).
  registryGroup: 'cc-proof-registry',
  rows: Object.freeze([
    Object.freeze({
      file: 'tests/modules/development/development-terminal-exit-accounting.test.mjs',
      type: 'blocking',
      group: 'process-modules',
      origin: 'CC-GAP-8',
      proof: 'terminal-exit accounting structural oracle: every reachable Development terminal exit is settlement-accounted or provably pre-ledger; RED/GREEN on the rejected df7359fa edges (exact-file hosting landed at 9301e8ff, pinned by coverage G2g)',
    }),
    Object.freeze({
      file: 'tests/modules/development/verification-ledger.test.mjs',
      type: 'blocking',
      group: 'process-modules',
      origin: 'CC-GAP-8',
      proof: 'criterion-key verification ledger: explicit terminal-route facts, no unexplained pending rows, executed facts fail closed on a mismatched verificationItemKey, readonly read path never writes',
    }),
    Object.freeze({
      file: 'tests/process-modules/run-terminal-journal-projection.test.mjs',
      type: 'blocking',
      group: 'process-modules',
      origin: 'CC-GAP-2',
      proof: 'run.terminal journal projection carries terminal_status/stage_outcome/product_outcome/stage_outcome_authority next to the unchanged operational channels; exactly-once paused guard preserved',
    }),
    Object.freeze({
      file: 'tests/infrastructure/cc-proof-hosting.test.mjs',
      type: 'blocking',
      group: 'cc-proof-registry',
      origin: 'CC-U1',
      proof: 'this proof-hosting registry itself: bidirectional manifest<->matrix<->CI closure plus the fail-closed mutation battery (missing file, duplicate, group rename, quarantine reclassification, CI omission, stale pending, registry-group widening)',
    }),
    Object.freeze({
      file: 'tests/app/launch-terminal-settlement.test.mjs',
      type: 'pending',
      origin: 'CC-GAP-2',
      proof: 'one pure launch-terminal settlement projection: launch/order/exit-code mapping byte-identical to the legacy inline CLI logic (backward-compat pin) plus the separated verdict channels (terminal_status/product_outcome) every settle surface exposes',
      tracker: 'docs/plans/CONFORMANCE-CLOSURE-PLAN.md 7B/CC-U1 checklist: register every new blocking proof file bidirectionally — the GAP-2 orphan hosting follow-up converts these rows to blocking when a reviewed matrix group hosts them',
      reason: 'critical CC-GAP-2 terminal-projection proof (one settlement projection for launch/order/exit with the separated verdict channels, byte-identical legacy mapping pin) committed at cf14e364 as a BLOCKING regression, but ORPHANED: no acceptance-matrix GROUPS entry has ever matched tests/app, so no CI step executes it — green in isolation (13/13 across the two orphan GAP-2 suites re-verified 2026-08-23 on 906edf84), yet it proves nothing in CI. Hosting must be its own reviewed matrix change (group placement + green-in-group verification), not smuggled into this registry commit.',
    }),
    Object.freeze({
      file: 'tests/tracker-view/engine-status-launch-projection.test.mjs',
      type: 'pending',
      origin: 'CC-GAP-2',
      proof: 'tracker /api/factory/status last_launch joins the lifecycle run (COALESCE of launch/order pointer) and exposes the lifecycle verdict next to launch/order state; the board status line renders the verdict next to a settled-completed launch',
      tracker: 'docs/plans/CONFORMANCE-CLOSURE-PLAN.md 7B/CC-U1 checklist: register every new blocking proof file bidirectionally — the GAP-2 orphan hosting follow-up converts these rows to blocking when a reviewed matrix group hosts them',
      reason: 'critical CC-GAP-2 terminal-projection proof (/api/factory/status last_launch exposes the lifecycle verdict next to launch/order state; board renders it) committed at cf14e364 as a BLOCKING regression, but ORPHANED: no acceptance-matrix GROUPS entry has ever matched tests/tracker-view, so no CI step executes it. Same orphan class as the CC-GAP-8 terminal-exit accounting proof was before 9301e8ff; hosting owed as its own reviewed matrix change.',
    }),
  ]),
});
