# TASK C — Pre-deletion verification dossier (legacy purge candidates)

Date: 2026-08-18. Branch: saga4. READ-ONLY audit; no code was modified.
Purge thesis under test: "pre-production, no backward compatibility promised → every legacy/compat/v1-fallback branch is pure debt".

Method: repo-wide grep (src, tests, tools, scripts; node_modules/dist/.factory-* excluded) + read of every hit + read-only probe of the operator's 17 on-disk factory DBs (user_version, v1 contexts, unbound executions).

---

## CANDIDATE 1: applyTestWarmStart / captureTestWarmStart — VERDICT: SAFE-TO-DELETE

Claim "documented no-ops": CONFIRMED.
- src/infrastructure/testing/test-warm-start.ts:1-9 — header says "RETIRED compatibility surface … intentionally remains as a no-op compatibility shim until those imports are removed in a later mechanical cleanup."
- :41-45 `applyTestWarmStart(request)` returns `request.processWorkspace` unchanged.
- :50-55 `captureTestWarmStart(...)` body is empty.

Call sites (complete list):
- src/infrastructure/workers/claude-worker-executor-factory.ts:46-49 (imports), :542 `resolvedWorkspace = applyTestWarmStart({...})` (assigns the identical object back), :647 `captureTestWarmStart(...)` inside `captureWorkspace` hook.
- src/process-modules/application/pinned-workspace-materializer.ts:76 — optional `testWarmStart?` field on `WorkplaceDesk`. No producer anywhere in src/tests/tools/scripts sets it; the only reader is claude-worker-executor-factory.ts:569 `test_warm_start: resolvedWorkspace.testWarmStart ?? null` (always writes null into task metadata `process_workspace`).

Tests referencing: NONE (grep over tests/ for applyTestWarmStart|captureTestWarmStart|testWarmStart|SAGA_TEST_WARM_START → zero hits).

Deletion scope: test-warm-start.ts (whole file); imports/lines 542-557 (the `if (processNodeId)` apply block), 569 (`test_warm_start:` key), 647-652 (captureWorkspace hook body — check whether the hook itself must stay for the runner contract); the `testWarmStart?` field in pinned-workspace-materializer.ts:76-99.
Risk: LOW. Removing the `test_warm_start: null` key changes the stored metadata shape (old tasks have the key, new don't) — no reader of that key exists. `captureWorkspace` may be part of the runner interface — keep the hook, drop only the no-op call.

## CANDIDATE 2: readFrozenProductionIngressIfBound "unbound" branch — VERDICT: NOT-ACTUALLY-LEGACY

Claim (branch is legacy, authority === null && work_intent_id === null): branch EXISTS at src/process-modules/application/production-ingress-contract.ts:35-37 (`if (authority === null && strict.snapshot.work_intent_id === null) return null;`), but it is NOT dead-old-data-only — it is a LIVE product path for tracker-only tasks.

Evidence the branch is live:
- src/lifecycle/work-assignment-core.ts:571-599 — on claim with reservation, `workIntent = readWorkIntentForTaskClaim(db, task)`; :288 `if (intentId === null) return null;` → `buildExecutionContext` (src/shared/authority/build-execution-context.ts:55-63) produces exactly `authority: null, work_intent_id: null` for any task without a WorkIntent. `tracker_only` is a current, schema-checked execution_mode (src/schema.ts:153) and even the DEFAULT in src/infrastructure/workplace/sqlite-production-cell-projection-persistence.ts:462.
- src/tools/dispatcher.ts:2067-2071 — consumer comment: "Compatibility tracker cards freeze an explicitly null WorkIntent. This is the only lawful bypass" → `if (!ingress) return;`.
- src/infrastructure/workplace/sqlite-managed-completion-product.ts:32-34 — `if (!ingress) return null;` (same bypass).
- Fixture tests/lifecycle/fixtures/managed-execution.mjs:49-96 `seedUnboundExecution` seeds exactly this shape (policy v2, authority null).

Call sites of readFrozenProductionIngressIfBound: production-ingress-contract.ts:23 (strict wrapper readFrozenProductionIngress — used by src/app/product-lifecycle-runtime.ts:665, src/infrastructure/workplace/sqlite-final-presentation-commitment.ts:48), sqlite-managed-completion-product.ts:32, src/tools/dispatcher.ts:2067.

Tests: tests/lifecycle/application-service.test.mjs:123 (uses seedUnboundExecution for a `tracker_only` worker_done — proves the path is the lawful fence for plain tracker usage); tests/architecture/work-intent-contract-immutability.test.mjs:125,130 (bound mode only).
Live data: 0 unbound execution rows across all 17 operator DBs (probe) — so no EXISTING rows depend on it, but any future tracker-only claim recreates them.

RISK of deletion: worker_done for every tracker-only (non-WorkIntent) task starts throwing `PRODUCTION_INGRESS_EXECUTION_AUTHORITY_INCONSISTENT`. Purging this branch requires a design decision first (refuse fencing for WorkIntent-less tasks, or give them a synthetic intent). Do not delete as "mechanical cleanup".

## CANDIDATE 3: FactoryPostAcceptanceEffectRegistry.run fabricated receipt — VERDICT: NOT-ACTUALLY-LEGACY

Branch: src/process-modules/application/post-acceptance-effects.ts:261-269 — if `effect.run(input)` returns undefined, fabricates `{outcome:'succeeded', receiptRef: 'effect-receipt:<effectId>:<candidateSetRef>', receiptDigest: receiptRef}`. Comment: "Legacy idempotent adapters are represented as a successful provider receipt until migrated to the external-effect ledger."

The branch is LOAD-BEARING today — two LIVE effects return void:
- src/modules/formalization/application/formalization-accept-products-effect.ts:151 — `return undefined;` at the end of run().
- src/infrastructure/replay/replay-capture-effect.ts:44-119 — run() body ends after the capture loop with NO return statement (void).
- Only src/infrastructure/workplace/git-integration-effect.ts returns explicit results on every path.
Registrations: src/app/product-lifecycle-runtime.ts:344 (git-integration), :350 (replay-capture); src/modules/formalization/index.ts:67 (formalization-accept-products).

Consumer assumes a result: src/process-modules/application/node-executors/production-cell-node-executor.ts:979-988 — `const result = this.opts.postAcceptanceEffects.run(...)` then `result.outcome` unconditionally (recordEffectAttempt, pending/repair routing). If the branch is removed without migrating the two effects, every formalization acceptance and replay-capture settles with a TypeError instead of a receipt.

Tests: no unit test pins the fabrication directly; it is implicitly required by every e2e/golden run where formalization-accept-products or replay-capture settles (EffectAttempt rows carry receiptRef `effect-receipt:...`). tests/architecture/effect-input-exact-refs.test.mjs:177+ scans run() source for assertAuthorityBound-before-effect.run ordering (deletion must keep that order visible). tests/process-modules/post-acceptance-authority-validation.test.mjs covers assertAuthorityBound only.

RISK: HIGH if deleted as-is. Correct purge = first migrate both effects to return explicit `succeeded` receipts (real digest, e.g. over the acceptance they just persisted), THEN delete the fallback. This is a migration task, not a deletion.

## CANDIDATE 4: 'factory.execution.v1' in ACCEPTED_POLICY_VERSIONS — VERDICT: SAFE-TO-DELETE

Location: src/shared/authority/authorize-tool-call.ts:22-26 — set contains `EXECUTION_CONTEXT_POLICY_VERSION` (= 'factory.execution.v2', src/shared/authority/execution-context.ts:18) and 'factory.execution.v1'. After removal the set is exactly {'factory.execution.v2'}.
Coupled v1 branch: :99-102 `parseExecutorKind` — v1 accepts `raw === undefined` as 'claude-cli'; v2 requires explicit 'claude-cli'. Removing v1 from the set makes the branch unreachable → delete both together.
Producers: the sole context builder src/shared/authority/build-execution-context.ts:60 stamps v2 only. 'factory.execution.v1' appears nowhere else in src/tools/scripts.
Live data: 0 v1 execution rows across all 17 operator DBs (probe).

Tests to touch (fixtures use v1 and would fail with 'unsupported policy_version'):
- tests/claude-runner.test.mjs:86 (assignment.executionContext.policy_version: 'factory.execution.v1').
- tests/discovery/d1-1-authority.test.mjs:88 (fixture), :150 (asserts details.policy_version === 'factory.execution.v1').
- tests/execution/hardening-security.test.mjs:466 (fixture).
Fix = bump fixtures to 'factory.execution.v2' (+ add explicit executor_kind where the fixture relies on the v1 undefined-default).

RISK: LOW. Only effect beyond fixtures: an old/archived DB with v1 rows would be rejected at the gateway (`AUTHORITY_CONTEXT_INVALID: unsupported policy_version`). None exist on this machine.

## CANDIDATE 5: db.ts supportedVersions + migration ladder — VERDICT: DELETE-WITH-CARE (highest risk)

Constants/behavior today (src/db.ts):
- :94 `SCHEMA_VERSION = 14`; fresh init creates current shape via `db.exec(SCHEMA_SQL)` (:137) then stamps 14 (:244-258).
- :119 `supportedVersions = new Set([0, 3..13, 14])`; :120-126 unknown version → db.close() + THROW `FACTORY_SCHEMA_MIGRATION_UNSUPPORTED` (fail closed).
- :127-134 old-but-supported version → WARN, open as-is, run the ladder, stamp 14 at exit.
Helpers (all defined src/schema.ts, all probe-guarded, all no-ops on fresh/current DBs): migrateFactorySchemaV3ToV4 :3493 (user_version gate), rebuildFactoryOrdersWithoutColumnUniques :3291 (sqlite_master shape probe), rebuildLaunchIdempotencyIndex :3368, migrateSyntheticBriefsToDbNative :3133 (table/column probe; data repair, not version-gated), relaxFactoryLaunchStateForPaused :3411, ensureArtifactStorageKindColumn :2791, ensureWorkerExecutionSoftStopColumns :2815, ensureFactoryLaunchEngineMarkerColumns :2842, widenLifecycleControlsEngineStateForWatchdog :2872, ensureLifecycleControlsLastErrorColumn :2949, ensureAcceptedAuthorityHeadTaskIdColumn :2977, ensureGatePresentationReplayBindingColumns :2989 (already gated `existingVersion > 0 && < 10` at db.ts:166), ensureTransitionObligationLeaseFenceColumn :3063, ensureCellEffectRepairIssueColumns :3088.

Do fresh runs hit the ladder? The helpers are CALLED unconditionally at open, but each is a guarded no-op on a fresh DB (verified per-function probes above). Deleting the calls changes NOTHING for fresh DBs.

Non-db.ts callers (production-adjacent!):
- scripts/factory.mjs (canonical Factory Start/Resume/stop CLI): :279-281 `continue` → migrateFactorySchemaV3ToV4; :500-502 `stop/unpark` → ensureWorkerExecutionSoftStopColumns; :923-952 `start --sandbox` → rebuildFactoryOrdersWithoutColumnUniques + rebuildLaunchIdempotencyIndex. Deleting exports without touching these breaks the operator CLI at dynamic-import time.
- scripts/factory-bootstrap-c1.mjs:50-58 → rebuild* pair.
- No other production runtime callers (grep src/ for all 14 names → only db.ts + schema.ts defs).

Tests covering migration paths (delete or rewrite setup):
- tests/infrastructure/factory-schema-v4-migration.test.mjs (whole file: V3→V4) — DELETE.
- tests/infrastructure/factory-schema-v5-migration.test.mjs (relaxFactoryLaunchStateForPaused, ensureGatePresentationReplayBindingColumns) — DELETE.
- tests/infrastructure/cell-effect-repair-issue-columns.test.mjs — DELETE.
- tests/infrastructure/accepted-authority-head.test.mjs:149-181 (C5 additive-migration cases) — delete those cases, keep the rest.
- tests/infrastructure/transition-obligation-lease-fence-storage.test.mjs — setup uses the helper; rewrite to SCHEMA_SQL-only or delete.
- tests/infrastructure/development-verification-continuation-live.test.mjs:32 — setup call; rewrite.
- tests/factory/factory-recovery-fixes.test.mjs:24, tests/factory/managed-production-node-scoped-reader.test.mjs:44, tests/replay/conveyor-v4.3-focused-invariants.test.mjs:35 — setup calls to rebuildLaunchIdempotencyIndex; rewrite setup (SCHEMA_SQL alone now yields the full-UNIQUE index).

THE decisive risk (measured, not hypothetical): ALL 17 operator DBs on this machine are at user_version 7 or 10 (.factory-docker-runs/* = 10, .factory-sandboxes/mars-venus-r8 and mars-venus-ts-r1 = 7, others = 10). NONE is at 14. Today, opening any of them warns + migrates + stamps 14. After the purge (supportedVersions narrowed to {0,14}), every one of them FAILS CLOSED at db.ts:120-126 — the engine, worker_next, checkpoint CLI, everything refuses the DB. Also note versions 1-2 already fail closed today, and the end-of-open stamp list (db.ts:245-257, enumerating 4..13) must be purged in lockstep.
Safe purge protocol: (1) open each operator DB once with CURRENT code to migrate them to 14 (or explicitly abandon them); (2) update scripts/factory.mjs + factory-bootstrap-c1.mjs; (3) then delete ladder + narrow set to {0, 14} — after which an old DB fails closed with a clear error (acceptable per purge thesis, but it IS the behavior change).

## CANDIDATE 6: node-run v1/v2 duality — VERDICT: DELETE-WITH-CARE (mixed: half legacy, half live)

One table (`factory_node_runs`), two row shapes; v2 = same row + nullable Wave-3 columns (src/process-modules/persistence/node-run-v2.ts:67-114; discriminant `inputEnvelopeHash`).
Canonical NOW: v2 writes/resume (startV2/completeV2/readByExactCursor/readLastCompletedV2/listV2), enforced by generic-flow-executor.ts:953-961 (throws if repo lacks startV2/completeV2). Definitions: port v1 src/process-modules/persistence/node-run.ts:80-115; port v2 node-run-v2.ts:180-212; impls both in src/process-modules/persistence/sqlite-node-run-repository.ts (v1 start:368, complete:383, fail:413, readLastCompleted:430, list:443; v2 startV2:449, completeV2:527, readLastCompletedV2:599, listV2:608).

Per-method disposition (call sites, complete):
- v1 `start`/`complete`: ZERO production callers. Only tests/execution/recovery-conformance.test.mjs:258/263, 536/541, 663/668, 771/776, 883/888 (5 test scenarios). → Delete together with rewriting those tests to startV2/completeV2.
- v1 `readLastCompleted`: 2 production call sites, both as fallback `v2.repo.readLastCompletedV2(...) ?? nodeRunRepo.readLastCompleted(...)` — generic-flow-executor.ts:487-488, :663-664 (comment: "covers a row written before the v2 cutover"). KEY FACT: readLastCompletedV2 (:599-606) uses BYTE-IDENTICAL SQL and the same table as v1 (:430-437) — only the row mapper differs (rowToRecordV2 ⊇ rowToRecord). The fallback can therefore never return a row the v2 read missed; it is redundant duplicate code, not even an old-data shim. → Safe to delete both `??` fallbacks.
- v1 `fail`: LIVE — generic-flow-executor.ts:727, 768, 786 (all failure paths). There is no failV2. → NOT legacy; keep.
- v1 `list` (:443): ZERO callers anywhere (src/tests/tools/scripts); listV2 is the used surface (:468, :1223). → Dead; delete (also from the port node-run.ts:113-114).
Tests to touch: recovery-conformance.test.mjs (start/complete pairs); tests/execution/no-fallback-reconstruction.test.mjs:88 stubs readLastCompleted — check stub still compiles after port change; tests/architecture/conveyor-completeness-ratchets.test.mjs:140 and authority-recency-classification.test.mjs:89 pin v2 vocabulary in source scans (should keep passing).
RISK: MEDIUM — mostly test churn; keep `fail`; the only subtle part is confirming no test relies on v1 rows being invisible to readLastCompletedV2 (they are not — same SQL).

## SWEEP: additional finds matching "exists only to serve old data or an old format" (in the same files)

1. src/shared/authority/authorize-tool-call.ts:144-153 — parseReplayKeyMaterial accepts legacy field names `nodeInputHash` (renamed → semanticInputDigest in v4.3) and `subjectCandidateDigest` (→ subjectProductionDigest) "for in-flight executions frozen before the rename". Pure old-format compat; same purge class as C4.
2. src/process-modules/persistence/sqlite-node-run-repository.ts:55-96 — ensureFactoryNodeRunSchema carries its OWN embedded ALTER-ladder (12+ guarded ADD COLUMNs: output_bindings, execution_receipt, output_schema, recovery_issue, acceptance_receipt, 7 Wave-3 columns) serving only pre-existing DBs; runs at db.ts:231 open AND at repo construction. Same sediment pattern as C5, missed by the enumeration.
3. src/process-modules/persistence/sqlite-node-run-repository.ts:443 — v1 `list` with zero callers (see C6).
4. src/checkpoints/factory-checkpoint-service.ts:411-427 `createWarmStartFixture` + `warmStartNodes` (:65, :251) — the checkpoint-based warm-start fixture surface (`factory.test-warm-start-fixture.v1`, mode 'verify-and-submit-existing-draft'), sibling of the retired test-warm-start sidecar; still reachable via src/checkpoint-cli.ts:74. Deletion = CLI subcommand removal too; verify no scenario/golden run invokes it first.

(Reported 4, not 5 — nothing else in these files met the bar without padding.)

## Execution order recommendation (safest first)

1. CANDIDATE 1 (test-warm-start shims) — true no-ops, zero tests, mechanical.
2. CANDIDATE 4 ('factory.execution.v1') — zero live v1 rows; 3 test fixtures to bump; take sweep-find #1 (nodeInputHash fallback) in the same commit — same file, same class.
3. CANDIDATE 6, decomposed — delete dead `list`, redundant readLastCompleted fallbacks, and v1 start/complete (+ rewrite recovery-conformance tests). KEEP `fail`.
4. CANDIDATE 5 (db.ts ladder) — only AFTER the operator migrates/archives the 17 v7/v10 DBs and scripts/factory.mjs + factory-bootstrap-c1.mjs are updated; then supportedVersions → {0, 14}, ladder + stamp list go, 9 test files touched. Take sweep-find #2 (embedded node-run ALTER-ladder) in the same wave.
5. CANDIDATE 3 (fabricated receipt) — NOT a deletion: first teach formalization-accept-products and replay-capture to return explicit succeeded receipts, then remove the fallback. Until then the branch is load-bearing.
6. CANDIDATE 2 (unbound ingress branch) — NOT legacy: it is the lawful fence for tracker_only tasks created by today's tools. Requires a design decision (fence policy for WorkIntent-less tasks) before any purge; deleting it now breaks worker_done for plain tracker usage.

Global note: purge thesis holds for C1/C4 and mostly for C5/C6, but is FACTUALLY WRONG for C2 and C3 — those two branches serve current-shape traffic, not old data.
