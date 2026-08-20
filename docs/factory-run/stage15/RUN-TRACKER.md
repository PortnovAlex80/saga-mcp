# STAGE-15 RUN TRACKER — the run that tests the repairs

Governing brief: `docs/handoff/STAGE-15-AGENT-BRIEF.md`. Continues
`docs/factory-run/stage14/ARCHITECT-STAGE14-REPORT.md`. Order = the stage-12
order VERBATIM (extracted from the stage-12 DB's frozen lifecycle input
snapshot, not re-typed). This file is the pre-declared protocol + append-only
log; the final report is `ARCHITECT-STAGE15-REPORT.md`.

## The three questions (the whole stage)

1. Does the scope-widening transition work under load (a real LLM, not the
   domain-free fixture)?
2. Does the factory self-terminate? (Stage 12: engine exited
   `code=2 reason=paused` at 06:42:14Z after the last worker finished;
   nothing resumed it. F6 never fired.)
3. Is the terminal label true? (Stage 11's terminal lied; the independent
   check is part of the run this time.)

## PRE-DECLARED PROTOCOL (written before launch — and honoured)

**Watchdog** (`tools/run-watchdog.mjs`): samples every 60 s; every sample
written to `stage15-logs/watchdog.jsonl`. Sampled: lifecycle
status/terminal_status/current_stage, stage counts, workplace
ref/revision/loop_state, task counts, gate count, widening ledger counts,
journal growth, engine pid liveness + heartbeat age, `~/.claude/settings.json`
sha256.

**Stagnation threshold: 45 minutes.** The progress fingerprint (lifecycle
status, stage counts, workplace revisions+loop states, task counts, gate
count, journal line count — heartbeats deliberately EXCLUDED, a spinning
engine is not progress) unchanged ≥ 45 min ⇒ STAGNATION trip ⇒ snapshot,
stop observing, report. Rationale: stage-12's longest single honest cycle
(one worker turn) was ~17 min; 45 min is >2.5× that with ZERO aggregate
movement. Extending past it because it "might still finish" is escalation
item 5 — forbidden.

**Engine exit** (ENGINE_VANISHED trip): snapshot immediately. Then classify
from the journal's `engine.exit` line:
- `reason=paused` — a pause-exit. A PLAIN `node scripts/factory.mjs resume
  <db>` (no recovery options — it creates only a launch row, no authority
  edits) is permitted, **capped at 3 pause-exit resumes total**. Resume № 4
  never happens: the run's answer becomes "parks in operator-required pause,
  cannot self-terminate".
- Any resume requiring recovery OPTIONS (`--requeue-paused`,
  `--resume-worker-loss`, `--recover-*`): NEVER. That is operator
  intervention manufacturing state — the honest verdict is "cannot progress
  without operator recovery".
- Crash/other exit: the run's answer is the crash; snapshot + report.

**Settings drift** (SETTINGS_DRIFT trip): abort immediately per §0.3.
**Terminal** (TERMINAL outcome): stop, verify label truth, harvest.
**Hard wall: 12 h** (watchdog max-hours) — beyond it the stagnation rule has
long since spoken.

**Escalate, never decide**: factory defects are filed not fixed; no manual
DB edits; nothing touches the operator's interactive Claude channel; break 1
stays open (stage 16).

## Pre-flight (filled at launch)

- [ ] HEAD SHA, tree clean (operator's own doc edits excepted, named, untouched)
- [ ] `npm run build` exit 0, `dist/index.js` mtime
- [ ] six-suite baseline pasted (in the report)
- [ ] fresh `.factory-sandboxes/stage15-db/`, `stage15/`, `stage15-logs/`
- [ ] order = stage-12 order verbatim from the stage-12 DB input snapshot
- [ ] `--model glm-4.6`, concurrency 2 (canonical profile limit 2)
- [ ] `SAGA_REAL_CLAUDE_PATH` → agent-proxy shim (absolute), shim map
      `zai-coding-plan/glm-4.6`
- [ ] `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1`
- [ ] `~/.claude/settings.json` sha256 baseline: anchored at launch, watchdog
      re-checks every cycle
- [ ] pre-run snapshot of the fresh DB taken before engine start

## Log (append-only, newest last)

- **09:26:50Z (12:26 local) — LAUNCHED.** Pre-flight all green: HEAD
  `b4fc54b1`, build exit 0 (dist 12:18:53), six-suite baseline pasted in the
  report-to-come; fresh `stage15-db/`+`stage15/`+`stage15-logs/`; order =
  stage-12 order VERBATIM from the stage-12 DB input snapshot (1354 bytes,
  sha256 `d25fb79a…`); `--model glm-4.6`, concurrency 2; settings baseline
  `bb2465ca…` anchored. Engine detached pid 58644, launch
  `launch-96e8eb04`, log
  `saga-engine-1-2026-08-20T09-26-50.946Z.log`. Pre-run snapshot
  `factory-snapshots/stage15-db-2026-08-20T09-26-56-790Z` (integrity ok).
  Watchdog live (60 s samples, 45-min stagnation). Route confirmed in
  production logs at +75 s: worker-backend marker `agent-proxy`; runner
  spawn `claudePath="node …/tools/agent-proxy/claude-shim.mjs"` with PWD
  pin to the sandbox product repo; first worker `B…` on task 1
  (discovery-proposal). Engine cycle: initial-discovery, 1 durable
  execution active. Cron safety net every 15 min (automation-c48e36a6).
- **10:47Z — REPAIR SPIRAL CONVERGED (acceptance-contract).** 3 repair
  rounds on AC-9/AC-10 FR/UC trace findings (round 1: both missing; round
  2: UC added, FR missing — the verdict named the partial resolution;
  round 3: FR added via saga_trace_add + AC doc edits) → reviewer verdict
  `approved` 10:46:41Z, task 10. Cell r16→r24, next round running. Notable
  vs stage-12: that run crossed formalization 12 gates / 12 accepted /
  ZERO repairs; this run exercises the repair arc in formalization — same
  order, same model, different artifact quality. Operator asked mid-loop
  "нет обратной связи?"; in-session analysis showed all three feedback
  channels working. Widening so far: ZERO (development not entered yet).
- **11:23Z — STAGE CROSSING: solution-development** (2 stages completed,
  all 6 formalization cells terminal; development-plan-task-graph r2
  running, task 16). The stage where widening can actually fire begins.
- **11:26–11:28Z — SETTINGS_DRIFT TRIP, classified OPERATOR-OWNED, run
  CONTINUES.** Watchdog: `bb2465ca…` → `fedfcd1a…` (11:26:54Z, trip fired)
  → `e03e7bbc…` (11:27:54Z) — two writes in 60 s. Classification evidence:
  final hash IS the documented stage-11 operator-channel baseline
  (stage-12 tracker 00:33 entry names `e03e7bbc…` as exactly that state);
  engine log has ZERO model-set/settings mentions; no tracker-view/panel
  process exists in this run (the /api/model/set vector cannot fire);
  launch env carried `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1` + the shim
  refuses model switch for agent-proxy launches; the operator was active
  in-session at the drift minute. Precedent: stage-12 00:33 (same shape,
  same resolution). Snapshot FIRST:
  `factory-snapshots/stage15-db-2026-08-20T11-30-53-858Z` (integrity ok).
  Watchdog re-anchored at `e03e7bbc…` (restart exec_23961d93); any FURTHER
  movement off the new anchor aborts per §0.3.
- **11:44Z — DEVELOPMENT CARVE: 5 implementation cells** (4 idle at r0 =
  carved cards awaiting staff, 1 running r2 = task 19 executing; 16 done /
  1 in_progress / 4 todo, 20 gates). The critical window opens: in stage-12
  this topology produced the path-outside-authority deadlock at revision
  93 with a never-adopted re-carve. Watching for scope_widening.* events.
- **12:24–12:29Z — THE FENCE, REACHED (cell 64892151, task 18).** Round 1:
  `changed-files-mismatch` (worker's declared list vs sealed manifest —
  bookkeeping). Round 2 (12:28:15): mismatch GONE, the real finding
  surfaced — `path-outside-authority: [src/physics/index.ts,
  tsconfig.json] outside frozen changeScopes [package.json, src/collision/,
  src/physics/StationPhysics.ts, tests/]` **carrying the stage-13 teaching
  suffix** (conclude with worker_done scope-insufficient). Findings MOVING
  (mismatch → fence) = converging spiral, not a stage-12 grind. First
  path-outside-authority finding of the run: if the next rejection returns
  the same surviving keys → trajectory scope-impossible → cell widening
  request (or the worker declares). THE moment stage-15 exists for.
  Watch: scope_widening.* journal events.
- **13:0xZ — ARCHITECT'S CORRECTION ACCEPTED: the third door (E7/E-F4).**
  My 11:44Z entry framed card 45b9646b's r12 terminal as a win (r12 vs
  stage-12's r93). The architect read the diff of required vs produced:
  11:44:26 fence hit [jest.config.js, tsconfig.json] → 12:01:07 author
  ACCEPTED on a candidate that no longer touched those paths → 12:04:58
  final accepted; widening ledger 0 rows the whole run. SILENT SURRENDER —
  the requirement vanished between repair rounds, gate and reviewer both
  accepted. Reproduced domain-free and committed as stage-16 E-F4
  (9bea1194): the lawful exits work; nothing checks what was NOT
  presented. Stage-15's question 1 answer so far: the widening transition
  has NEVER fired in this run — the cheap third exit beat it twice.
- **12:50:54Z — THE WIDENING FIRED (first in project history).** Cell
  64892151 (task 18), source **cell-trajectory** (the classifier read the
  same surviving keys — src/physics/index.ts, tsconfig.json — across two
  consecutive finding sets; the worker never used worker_done), role
  author, contention check found NO live holder → **grant, revision 1**:
  original carve ∪ requested = [package.json, src/collision/,
  src/physics/StationPhysics.ts, **src/physics/index.ts**, tests/,
  **tsconfig.json**]. The workplace re-staffed (r14 running) with the
  widened frozen authority; the byte-identical work that was rejected at
  12:28 is now lawful. Journal event carries request_id, revision and the
  granted set — the stage-15 TASK 1 instrumentation answering question 1
  in the same minute. NOTE the D7 thread: tsconfig.json is the SHARED
  path (two cards blocked on it an hour apart) — card 1 (45b9646b) took
  the silent-surrender exit (E-F4), card 2 took the lawful grant after
  card 1 went terminal. Both doors observed, in one run, on one path.
- **13:05:09Z — THE WIDENING LOOP CLOSED END-TO-END.** Round 4 (the
  re-staffed author, grant rev 1 in force) → author gate **accepted**
  (13:05:09); cell r17, review in progress. The live sequence, complete:
  fence ×2 (12:28, 12:50:54) → trajectory scope-impossible → grant same
  second → re-staff 12:51:29 → the previously-rejected work ACCEPTED
  13:05:09. Question 1 of the stage (does the widening transition work
  under load): YES — observed in production, both halves (the trigger and
  the release). Caveat found while verifying coverage (matrix W-F1,
  a54639ec): the worker is never INFORMED of the grant — this round
  passed because the worker happened to redo the natural work it had been
  taught by the rejection suffix; a self-limiting worker would also have
  passed (E-F4 through the widened door).
- **13:2xZ — FORENSIC CHAIN (operator asked for the cold deep look):** all
  submissions of both cards read from the DB. Card 2 round 4 (sub 20,
  accepted 13:05:05) DROPPED tsconfig.json + src/physics/index.ts despite
  the grant — W-F1 self-limit, author gate accepted (E-F4), reviewer
  caught it at 13:12:41 by running the build ("npm run build cannot
  function without tsconfig.json") → round 5 writes it lawfully. Card 1
  (sub 15, 12:01:03) made the SAME surrender (tsconfig + jest.config
  dropped) and went TERMINAL 12:04:58 — its reviewer never built. One
  defect class, two cards: accepted silently on one, caught by reviewer
  diligence on the other. D7 + W-F1 + E-F4 converged on one file across
  three hours of factory time; one delivered line of authority would have
  prevented all of it.
- **14:1xZ — THE ZOMBIE WORKER (live diagnosis, no repair).** Task 18's
  round-6 worker (pid 57532, spawned 13:50:57) is ALIVE with a FRESH
  heartbeat (renewed every cycle — leases_renewed=1) but CPU 0.14s TOTAL
  over 22 minutes; its stream froze at 13:58; the journal last moved at
  13:51:46. The engine cycles correctly and waits on this "durable
  execution still active" indefinitely: the heartbeat proves the PROCESS
  EXISTS, not that the worker WORKS — a liveness probe measuring the wrong
  thing (the B-002 freeze class, resurrected as a hung provider
  connection). No mid-run repair: the pre-declared 45-min stagnation
  threshold (fingerprint quiet since ~13:52) trips ~14:37Z → snapshot →
  stop → report. This is a live data point for question 2: the factory
  does NOT self-terminate — it parks indefinitely on a fresh-heartbeat
  zombie.
