# W3-A6 — NodeRun v2 persistence (SQL OWNER)

**Wave:** 3 · **Lane:** A6 (SQL OWNER) · **Spec:** §9 · **Frozen input:** `a415939`
**Branch:** `refactor/w3-a6` · **Worktree:** `.worktrees/w3-a6`

## CRITICAL: Single SQL owner for `saga3_node_runs` this wave (C083). W3-A4 coordinates through you for any `saga3_process_products` index.

## Read first
1. `docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md` §9.
2. `src/process-modules/persistence/node-run.ts` (NodeRunRecord) + `sqlite-node-run-repository.ts` (schema, ensureSaga3NodeRunSchema).
3. Wave 1 SPI: `NodeProductionEnvelope`, `NodeRef`, `PackageRef` from `domain/spi/index.ts`.

## Own
- `src/process-modules/persistence/node-run-v2.ts` (NEW: v2 record types + port methods).
- EDIT `sqlite-node-run-repository.ts` (additive: 7 columns via idempotent ALTER inside `ensureSaga3NodeRunSchema`; add v2 write/read methods). Mirror the Wave 2 dual-placement pattern (ALTER in the ensure…Schema block for fresh-DB + guarded ALTER in db.ts for upgrade — coordinate with integrator if db.ts edit needed).
- `tests/installation/node-run-v2.test.mjs` (NEW).

## Build (spec §9)
ALTER `saga3_node_runs` (additive, nullable): `input_envelope_hash TEXT`, `node_ref TEXT` (JSON), `package_ref TEXT` (JSON), `predecessor_node_run_ids TEXT` (JSON array), `definition_digest TEXT`, `transition_cursor TEXT`, `production_envelope TEXT` (JSON).
- `NodeRunRecordV2` extends NodeRunRecord with the new fields (all optional for legacy compat).
- Port methods `startV2`, `completeV2` dual-write (legacy `output*` + new columns).
- `readByExactCursor(processRunId, nodeId, attempt)` — resume query.
- NO delete of legacy columns. NO NOT NULL.

## Verify
`npm run build && node --test tests/installation/node-run-v2.test.mjs && node --test tests/architecture/dependency-direction.test.mjs`

## Commit
`feat(execution): W3-A6 NodeRun v2 persistence (7 additive columns, dual-write, exact-cursor resume)`

## Return
Branch+sha, diff --stat, test tail+ratchet, exported symbols (A1/A4/A5/A8 consume), confirmation.
