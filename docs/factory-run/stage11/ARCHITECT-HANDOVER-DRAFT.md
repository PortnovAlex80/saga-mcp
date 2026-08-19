# HANDOVER TO THE ARCHITECT — stages 10 + 11 (DRAFT v1, 2026-08-19)

> **Status:** draft. Completion conditions: (1) the live stage-11 run reaches
> terminal; (2) the 8 dispatched repair agents return and their branches are
> reviewed+merged; (3) the 3 held branches merge post-terminal. Every ⏳ marker
> below is a slot that fills at those moments. Nothing in this document asks
> the architect to sign a new gate; it delivers the evidence the two briefs
> define, and lists the decisions the briefs reserved for you.

---

## 0. Summary

Stage 10 ran the factory against a real LLM for the first time. The run died
at 08:28:08Z in formalization — `REPLAY_CAPTURE_TRACE_NOT_FOUND: expected 12,
resolved 6` — and, per the brief, the dead run with its snapshot and post-mortem
is the stage's correct outcome. Stage 11 fixed the defect class (sealed material
pointing at mutable rows) and relaunched from scratch on the same order. The
relaunched run **passed the exact cell that killed stage 10**, reached
development for the first time in the factory's history, and is now at its last
card. After the relaunch, a repair campaign (blindsight census: ~37 findings,
5 layers) was run against the codebase; none of it is in the live run's binary.

**The run you are judging ran on code as of 12:37. Everything merged after
12:38 is listed in §4 and takes effect on the next run.**

---

## 1. Stage 10 — the first real run (per STAGE-10-AGENT-BRIEF report format)

### 1.1 Tasks 1–3: the observability built before the run

| What | Where | Proof |
|---|---|---|
| Correlated run journal (append-only JSONL, correlation keys on every record) | `.factory-sandboxes/stage10-db/factory-run-journal.jsonl` (241 events, 11 kinds) | observation-only ratchet: frozen kind-set test fails if anything reads the journal back (updated in stage-11 TASK 5, commit `52189f43`) |
| Snapshot harness | `tools/capture-run-snapshot.mjs` | SQLite backup API, safe on a live DB; used 5× this stage |
| Structured bug database | `docs/factory-run/stage10/BUG-DATABASE.json` | survives DB wipe; every record carries an exact evidence pointer |

Honest gap, found by the run itself: the stage-10 journal recorded **zero
failure events** — the death was diagnosed entirely from the DB (stage-11
TASK 5 closed this: `error.thrown`, `run.terminal`, `engine.exit`,
`supervision.reaped`, `obligation.deferred`).

### 1.2 Task 4: the order

`docs/factory-run/stage10/ORDER.md` — operator's voice, not a spec: Elite
docking slice, keyboard + Chrome, inertial feel, honest both-outcome contact,
≥1 automated docking test, one-command `docker compose up`, TypeScript backend.
Deliberately vague so Discovery was actually exercised.

### 1.3 Task 5: the run and its death

Run `board-1-10940-1787120334001`, spawned 06:18:54Z, engine log gap (B-002),
Discovery → Formalization (9 artifacts, 11 accepted tasks, 2 workshops), worker
death at exactly 20m00.1 with ~300ms factory self-recovery (B-001), card reopen
without recovery feedback (B-004 @ 08:13:12Z), terminal failure 08:28:08Z.
Abort conditions were checked every monitoring cycle; the
`~/.claude/settings.json` baseline held (one operator-authored change at
08:44Z, marked and excluded).

### 1.4 Task 6 report

**How far the run got, per stage, with accepted heads:**
- product-discovery: **completed**, accepted head ⏳ (fill from
  `factory-snapshots/stage10-engine-death-0828` DB: `factory_authority_head`
  at discovery completion)
- solution-formalization: **completed** (9 artifacts, 11 tasks), accepted head ⏳
  (same source)
- solution-development: never reached
- terminal: **failed** 08:28:08Z, error `REPLAY_CAPTURE_TRACE_NOT_FOUND`

**G1/G2 predictions vs reality:**
- G1 (heartbeat non-compliance): predicted, **did not occur** — reality disagreed
- G2 (exit without `worker_done`): predicted, **occurred ×2** — both recovered
  by the factory itself in <1s (assignment re-claim → reserve → spawn chain in
  the journal) — the self-recovery the run existed to test, observed twice

**Bug database (by severity):**
| ID | Severity | Class | Status |
|---|---|---|---|
| B-005 | run-killer | factory_defect | **fixed** in stage-11 (`3681f32a`), verified by relaunch passing the killer cell |
| B-004 | high | gap iii | **fixed** — widened into the 4-defect livelock cluster (`ccd862a0`) |
| B-002 | medium | factory_defect | **fixed** (`dd8dd91b`, engine spawn file-logged and durably bound) |
| B-003 | medium | factory_defect | **fixed** (`d88d8cae` endpoint freeze family) |
| B-001 | high | **unknown** | explained, externally caused — see "could not explain" |

**Snapshot paths:** `factory-snapshots/stage10-early`,
`factory-snapshots/stage10-engine-death-0828`; harvested golden corpus
`tests/fixtures/golden-corpus/stage10-docking` (24 products, in git).

**What we could not explain (kept honest, per the brief):**
- **B-001**: a worker dying at exactly 20m00.1 with stdout frozen 16 min earlier
  while workspace edits continued. Measured from this run's own artifacts only.
  No 20-minute constant exists in `src/`, `tracker-view/`, or the shim (lease
  TTL 5 min renewed; loop detector is call-count based, limit 12). The wall is
  external — consistent with a ~20-min transport session ceiling in
  opencode/z.ai — but the external side cannot be inspected from this repo.
  Classification stays `unknown`. Mitigation is shim-side (provider-retry
  branch, §4.2) and supervision reaping (proven adequate: 2 reaps, both clean).

---

## 2. Stage 11 — the fix (per STAGE-11-AGENT-BRIEF report format)

Full report: `docs/factory-run/stage11/REPORT.md`. Condensed to the brief's
five required answers:

1. **Task 1** — failing message before the fix, verbatim:
   `REPLAY_CAPTURE_TRACE_NOT_FOUND: expected 2, resolved 0` (real seam:
   managed-provenance handlers, real worker_done freeze, real seal).
2. **Task 2** — identity chosen: the content tuple
   (`sourceId/targetType/targetId/linkType`) carried as its canonical digest
   (`traceHash`); one identity in two encodings, deduped by hash, resolved
   against the UNIQUE tuple key, falling back to nothing. Genuinely missing
   material still fails closed, now named by content.
3. **Task 3** — artifact side: deletion **latent** (no worker path; two
   operator routes exist: `saga-reset-stage.mjs:582`, `project_delete` cascade
   — which passes on PAUSED runs — plus `reset-saga-db.mjs` renumbering);
   mutation **live and sharper**: `artifact_update` and author re-upsert seal
   drifted selector values silently → capsule identity changes silently →
   replay exact-match fails later. Skipped twin test marks the spot.
4. **Task 4** — mechanism (one paragraph, from REPORT.md): the throw crossed
   three frames with no typed conversion, was widened by
   GenericFlowExecutor by design, and the lifecycle orchestrator converted it
   into a typed non-throwing terminal scoped to the ENTIRE LifecycleRun; the
   obligation handler never saw an exception, re-read its postcondition, and
   correctly DEFERRED — so `obligation.failed` never fired. **Fatality is
   structural: the only failure boundary between a post-acceptance effect and
   the CLI is the whole LifecycleRun.**
5. **Task 5** — new journal kinds: `error.thrown`, `run.terminal`,
   `engine.exit`, `supervision.reaped`, `obligation.deferred` (+`appendFenced`
   for `obligation.created`, `workplace_ref` enrichment). Proof test induces
   the stage-10 corruption deliberately and asserts the journal excerpt.
   Observation-only ratchet updated in the same commit.

---

## 3. The relaunch (stage-11 TASK 6) — the fixed conveyor under load

Pre-flight per brief: fresh DB/sandbox/logs, clean build 12:37, HEAD pinned,
guard env held (`SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1`, concurrency 2,
shim route), both observer fronts, settings hash baselined and checked every
cycle.

**Success criterion: PASSED.** The exact cell that killed stage 10
(formalization acceptance-contract: CellFinalAcceptance + replay capture over
revised traces) completed; the run reached development — first time ever.
Current: 30+/32 cards, 15 final acceptances, 42 terminal gates, last card
#15 (automated test) in flight.

Incident during the run, disclosed: a repair agent (C-145 branch, RED phase)
briefly wrote the real `~/.claude/settings.json` before isolation was
completed; restored immediately; root-caused (homeDir injection missing);
snapshot `factory-snapshots/stage11-incident-settings-hijack`; the run itself
was never touched.

⏳ **Terminal result** (completed/failed + final counts + snapshot
`factory-snapshots/stage11-terminal-*` + harvest) — fills when the run ends.
⏳ Endgame evidence for ADR-032 watch items (iii) freeze negatives and
(vi) verification lineage — the live run's freeze/verification phases produce
it; see §4.4.

---

## 4. Change map — what the live run does NOT contain

The live engine runs `dist` built 12:37. Everything below postdates it.

### 4.1 Merged to saga4, effective next run

| Merge | What it fixes |
|---|---|
| `ccd862a0` B-004 livelock cluster | reason-identity valve (defer/fail loop), one effects-settled predicate, C8 FinalAcceptance with REAL receipts, carry-forward replay-certifiable |
| `ad202db6` E-P1/A6 | engine spawn detached + file-logged + durably bound; soft-stop brake reads launch-row pids |
| `8c56d632` X-6/9/5 | sibling merge no longer kills continuation; sealed branch restore; transient git ≠ conflict |
| `7280884b` C-1/4/5 | endpoint contract frozen into execution context; FROZEN route limits enforced; cross-process settings guard |
| `8f367b2a` R+S | replay robustness (certification sweep sees failures), recovery-tool hygiene |
| `19e6002b` trajectory | convergence-aware repair budget (§15: cycle ≠ spinning) |
| `6578809f` pause | graceful-drain ⏸ + ▶ unpark (B-006 button truth included) |
| replan-cycle | scope-impossible → second planning cycle with integrated repo state (19 tests) |

### 4.2 Held until run terminal (merge immediately after)

| Branch | What |
|---|---|
| `es1-loop-detector` | shim-side REPEATED_TOOL_LOOP detection |
| `provider-retry` | shim-side progressive retry on 429/5xx — the B-001 mitigation |
| `snapshot-test-mvp` | zero-token deterministic re-run of the captured corpus + error-scenario suite |

### 4.3 In flight — 8 dispatched agents (blindsight closure)

Census: 5 layers, ~37 findings; systemic shape = "the factory writes the right
information and fails to deliver it to the point of decision". Registry:
`docs/factory-run/stage11/AGENT-REGISTRY.md`.

| # | Branch | Scope | Report |
|---|---|---|---|
| 1 | repair/blindsight-worker-prompt | review-feedback loud block, feedback history >1 round, card death history | ⏳ |
| 2 | repair/blindsight-gate-delivery | candidateSnapshot filled, trajectory label to author, reviewer round/verdicts, acceptance history, carry-forward code | ⏳ |
| 3 | repair/blindsight-lifecycle | obligation redrive by reason, budget seed on resume, failed NodeRuns on resume, epoch diagnosis, burial reason | ⏳ |
| 4 | repair/blindsight-persistence | effect-attempt pattern detector, minimal-work detector at worker_done, capsule reason routing, drift append-only, dead tables | ⏳ |
| 5 | repair/blindsight-phantom-bridges | RECOVERY: parser, metadata.previous_failures/attempt_history delivery, skill-contract canary | ⏳ |
| 6 | repair/blindsight-integration-verify | SEAM layer 2: full integration verification, typed repair-issues routed to producing tasks | ⏳ |
| 7 | repair/worker-names | display_name claim-time stamping, 4 workshop pools, prompt/heartbeat/board | ⏳ |
| 8 | repair/blindsight-reconciliation | SEAM layer 3: previous-attempt.{json,patch} on desk + reconciliation desk | ⏳ |

None of the 8 touches the decisions reserved for you (§5 E2/E3).

### 4.4 ADR-032 watch items — where the evidence landed

- **(iii) freeze-kernel negatives** — fired in stage 10 exactly as the brief
  predicted ("if a freeze fails, you are in untested code"): B-004/B-005 both
  carry `gap: iii`. C8-receipt fix (`7b206635`) is in §4.1. ⏳ live-run freeze
  phase adds endgame evidence.
- **(vi) verification-lineage-mismatch** — not yet fired anywhere. ⏳ live-run
  verification phase is its first real exercise.
- **(vii) planner domain-neutrality** — material ready: the planner carved the
  docking order into 32 cards (renderer, websocket, automated-test…). The
  brief's warning applies precisely: the skill's UI vocabulary may *fit* a game
  order and hide a §3 LEGO violation. Task graph is in the run DB; judgment is
  yours.

---

## 5. Decisions requested from the architect

| # | Decision | Input ready? |
|---|---|---|
| E1 | Should `trace_delete` exist as a worker tool at all? (Risk profile changed: identical-content re-adds now resolve; genuine deletes fail closed by content name.) | yes — §2, REPORT.md §0 |
| E2 | Extend content-addressed resolution to artifacts? (Deletion latent + operator routes incl. a paused-window gap; **mutation live**: silent capsule drift.) Replay-compatibility consequence. | yes — REPORT.md TASK 3 |
| E3 | Error-boundary redesign: cell-scoped failure for post-acceptance effects vs whole-LifecycleRun fatality. Three existing cell-scoped paths were bypassed. | yes — REPORT.md TASK 4 |
| E4 | Capsule identity change from the trace fix | **closed, no action**: zero traceIds in all stage-10 capsule payloads; only the fail-closed message changed |
| E5 | Ratification of the §4 merge campaign (12+ merges across run-terminal + agent waves) | ⏳ final map at handover |
| E6 | Watch-item judgments (iii/vi/vii) | ⏳ endgame evidence |

---

## 6. Appendix — artifacts and receipts

- Briefs: `docs/handoff/STAGE-10-AGENT-BRIEF.md`, `STAGE-11-AGENT-BRIEF.md`
- Stage-10: `ORDER.md`, `BUG-DATABASE.json`, snapshots (early, engine-death-0828),
  golden corpus (24 products)
- Stage-11: `REPORT.md` (tasks 1–5), `PREVENTIVE-HUNT.md` (census),
  `AGENT-REGISTRY.md` (dispatch), snapshots (replay-fitness,
  incident-settings-hijack, ⏳ terminal)
- Live run: `.factory-sandboxes/stage11-db/factory.sqlite` +
  `factory-run-journal.jsonl` (failure-event-capable since `52189f43`)
- Commit timeline: see git log 2026-08-19 08:22 → terminal
