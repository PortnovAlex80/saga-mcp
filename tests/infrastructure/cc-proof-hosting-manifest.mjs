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
      file: 'tests/infrastructure/cc-proof-hosting.test.mjs',
      type: 'blocking',
      group: 'cc-proof-registry',
      origin: 'CC-U1',
      proof: 'this proof-hosting registry itself: bidirectional manifest<->matrix<->CI closure plus the fail-closed mutation battery (missing file, duplicate, group rename, quarantine reclassification, CI omission, stale pending, registry-group widening)',
    }),
  ]),
});// EK-8 cutover (WP-12, 2026-08-26): the four old-runtime CC proof rows died
// with their suites and matrix groups (LEGACY-DELETION-MANIFEST secE). Their
// invariant content is owned by the kernel settlement/terminal-proof suites
// (workflow-kernel group) and the 20-project corpus. The registry row itself
// (CC-U1) stays blocking in its own group - the closure proof must survive
// the tree it guards.

