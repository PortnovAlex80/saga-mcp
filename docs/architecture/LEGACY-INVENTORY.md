# Legacy Inventory and Temporary Ownership Map

- **Release:** K2 — Legacy Expansion Freeze (Saga Core Renewal)
- **Captured at:** K1.1 green baseline lineage (manifest SHA `9750531b`)
- **Enforcement:** `tests/architecture/legacy-expansion-freeze.test.mjs`
  consumes the machine-readable companion `docs/architecture/legacy-allowlist.json`
- **Rule:** from K2 on, the legacy surface may only SHRINK. The allowlist is
  count/file-decreasing; broadening it requires a new ADR. Every entry names
  the K-release that will physically delete it.

Counts are CODE references (comment-stripped scan via
`tools/legacy-freeze.mjs`). Raw greps see roughly three times more hits —
most legacy vocabulary survives only in comments that explain its
replacement; those are documentation, not callable surface, and leave with
their owning releases.

## Category A — legacy `escalate` recovery vocabulary (owner: K15): 7 files

The old flow-era recovery vocabulary (`escalate`) coexists with the
canonical cell-era vocabulary (`fail` / `pause` / `requeue`). K15 collapses
both into one typed DispatchOutcome/RecoveryAction model and deletes these
code references.

## Category B — recency selectors in authority persistence (owners: K7/K8): 9 files

`ORDER BY <time/id> DESC ... LIMIT 1` selection in persistence layers that
serve accepted-material, replay, adoption, and settlement reads. Chronology
is legal only in explicit observability projections; each file's cutover
(exact-ref lookup) lands in K7 (accepted reads) or K8 (replay capsule
selection), per the renewal plan. The exact per-file split lives in
`legacy-allowlist.json`.

## Category C — execution-scoped lookup functions: 0 code refs

`listArtifactsForExecution` / `listTracesForExecution` no longer appear in
code — only in comments. The freeze pins the count at zero: any
reappearance fails the suite. (The formalization settlement epic-scoped
READ cutover itself is K6/K7 scope, tracked by the ADR registry, not by
this symbol.)

## Category D — `latestCandidate` code references: 0

The ADR-053 Phase 7 cutover removed every code reference; the freeze pins
zero.

## Schema surface (owner: K17 deletes; snapshot from K2)

The clean schema snapshot digests 96 tables (table + sorted column names,
SHA-256; see `legacy-allowlist.json` → `schemaSnapshot`). Any schema change
— addition, removal, or column edit — changes the digest and fails the
suite until the snapshot is updated in the SAME commit, deliberately. The
K17 legacy-object deletion list grows out of this snapshot as cutover
waves identify dead objects; nothing appears or disappears silently in
the meantime.

## Burn-down

`npm run legacy:report` prints current category counts against the
allowlist. K20 requires every category at zero and the schema snapshot
reduced by the K17 deletion set.
