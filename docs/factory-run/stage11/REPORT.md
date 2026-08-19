# STAGE-11 REPORT — sealed material must not point at mutable rows

Branch `saga4`. Evidence base: the architect's forensics plus five parallel
read-only investigations (data forensics, §9 code census, failure-propagation
mechanics, artifact-exposure audit, journal-events design). Everything below
carries file:line receipts in the investigation transcripts; this report is
the integration.

---

## TASK 1 — the regression test, first and failing ✅ (commit 9c3c9f38)

The failing message seen BEFORE the fix, verbatim:

```
REPLAY_CAPTURE_TRACE_NOT_FOUND: expected 2, resolved 0
```

(`tests/infrastructure/replay-capture-trace-revision.test.mjs` — the stage-10
chain driven through the real seam: managed-provenance handlers for
artifact_create/trace_add/trace_delete under the runner's env contract, real
worker_done freeze, real sealed-material seal, given-world candidate set
pointing at the real sealed product.) After the fix: GREEN — capture succeeds
and both trace identities resolve by content.

The artifact-side twin is present as a SKIPPED test naming the gap (see TASK 3).

## TASK 2 — identity choice ✅ (commit 3681f32a)

**Chosen identity: the content tuple, carried as its canonical digest.** The
sealed snapshot already freezes, per trace, BOTH the tuple
(`sourceId/targetType/targetId/linkType`) AND `traceHash` — which the
production ledger computes as exactly `sha256Hex` of that tuple (no rowid, no
timestamps; verified byte-for-byte across the stage-10 deleted rows 11–16 and
their re-created twins 17–22: six-for-six identical). `artifact_traces` itself
declares the tuple UNIQUE. So "trace_hash vs tuple" is one identity in two
encodings; the fix dedupes by `traceHash` (tuple as stable fallback) and
resolves against the UNIQUE tuple key — falling back to nothing. Expected
counts are DISTINCT IDENTITIES, not rowids (a re-seal embedding both
generations collapses 12 rowids to 6 identities — counting rowids would throw
the same error a second way).

Identity consequence: NONE for capsule payloads — they were already content
selectors (zero traceIds in all six stage-10 capsules, verified). The only
observable change is the fail-closed message, which now names the missing
material by content. Fail-closed preserved: a genuinely missing trace throws
`REPLAY_CAPTURE_TRACE_NOT_FOUND: expected N, resolved M; missing by content:
source=S linkType=L targetType:T:id (traceHash=H)`.

## TASK 3 — the artifact side: latent deletion, LIVE mutation

**Deletion is LATENT (no worker-reachable path), with two live operator
routes.** Exhaustive audit (`DELETE FROM artifacts` / `UPDATE artifacts SET id`
/ cascades / kernel-repair paths):

- No `artifact_delete` tool exists; `note_/subtask_/template_delete` never
  touch artifacts; epics soft-cancel only. No renumbering vector anywhere
  (AUTOINCREMENT never reuses ids; snapshot restore is id-preserving).
- Operator routes that CAN delete artifacts rows: `tools/saga-reset-stage.mjs:582`
  (FKs OFF, no sealed-material consult), `project_delete` MCP tool
  (`src/tools/projects.ts:317`, cascades via `schema.ts:330-331` — and its
  guard blocks only created/running lifecycles, so a PAUSED run passes: a
  paused-window gap), tracker purge routes (block created/running/paused), and
  `reset-saga-db.mjs` which wipes+RENUMBERS artifact ids while leaving every
  `factory_*` table — sealed snapshots included — intact to point at reused
  ids.
- **Mutation is REACHABLE TODAY and is the sharper edge:** `artifact_update`
  changes `code`/`title`/`path`/`content_hash` with no sealed-snapshot
  awareness (`artifacts.ts:494,526-539`); a re-dispatched author's
  `artifact_create` upserts the same `(epic,type,code)` row with new selector
  values (the exact stage-10 pattern); even `artifact_get` re-stamps
  `content_hash` from disk. Capture does NOT fail on mutation — it re-reads
  the live row and silently seals the drifted values (capsule identity
  changes silently); replay-time exact-match then fails on parent/external
  selectors (`capsule-replay-executor.ts:150-154,202,212`) — the stage-10
  failure shape without any deletion. The lazy certification sweep
  (`replay-claim-binder.ts:112-185`) extends the exposure window past run end.

**Not fixed, per the brief.** Content-addressing artifact resolution changes
capsule identity for every existing capsule — an architect decision, recorded
here, with the skipped twin test marking the spot.

## TASK 4 — why one unresolvable capsule killed the factory (mechanism)

The throw was never an unhandled exception at the top — it was absorbed and
widened at the first boundary it met. A plain `Error` crossed three frames
with no catch and no typed conversion (the fail-closed wrapper's try starts
after the capture call; the effect registry invokes `effect.run()` bare; the
node executor likewise), then GenericFlowExecutor widened it by design
(NodeRun failed → rethrow → ProcessRun failed → rethrow), and the lifecycle
orchestrator converted it into a typed, non-throwing terminal result scoped to
the ENTIRE LifecycleRun — one transaction failing both the StageRun and the
run. The obligation handler therefore never saw an exception: it re-read its
postcondition, found no FinalAcceptance, and correctly DEFERRED (the durable
row shows `state=pending, last_error='DEFERRED: FinalAcceptance…', attempt=1`)
— which is why `obligation.failed` (wired to `fail()`) never fired. The CLI
treats any non-paused reason as terminal: break, launch failed, exit 1.
**Fatality is structural: the only failure boundary between a post-acceptance
effect and the CLI is the whole LifecycleRun.** Three cell-scoped paths exist
and all were bypassed: the typed effect outcome vocabulary
(`repair_required`/`human_required` — handled cell-scoped — but the
replay-capture effect throws raw and the registry does not translate), the
ledger `fail()` (nothing threw at that boundary), and boot-time burial
`abandon()` (no boot ran). Error-handling redesign is explicitly out of scope
here — this paragraph is the input for that deliberate decision. (`cycles: 2`
= stageRuns count, not retries; the progress classifier cannot see the death —
it selects only non-terminal workplaces, and the dead cell was
`terminal/accepted`.)

## TASK 5 — journal failure events

Implemented in the TASK 5 commit: `error.thrown` (effect boundary, deepest
correlation keys in scope), `run.terminal` (engine-adapter result boundary,
after commit), `engine.exit` (the exit hook, exactly once per process),
`supervision.reaped` (per reaped projection, never per sweep), the
`obligation.deferred` gap-filler (the disguise the stage-10 last event wore),
plus the `appendFenced` wiring for `obligation.created` (production path never
journalled it) and `workplace_ref` enrichment for `obligation.claimed`.
Observation-only ratchet frozen-set updated in the same commit; the proof test
induces the stage-10 corruption deliberately and asserts the journal excerpt.

## TASK 6 — relaunch from scratch

Per the operator override: clean logs, fresh DB/sandbox, same docking order,
same guard env, both fronts; success = the acceptance-contract cell that
killed stage 10 completes (CellFinalAcceptance recorded, capture survives
trace revision) and the run reaches development. Result recorded below when
terminal.
