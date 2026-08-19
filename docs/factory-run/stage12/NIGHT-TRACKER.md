# NIGHT-12 TRACKER — authoritative live state of the stage-12 night shift

**Read this file FIRST.** Started 2026-08-20 ~00:30 local. The operator is
asleep and reads nothing until morning: all entries in English, all counts
verbatim, every phase update appended below with a timestamp. The governing
brief is `docs/handoff/STAGE-12-AGENT-BRIEF.md` including its TASK 6
OPERATOR OVERRIDE section. Standing directives: OPENCODE ONLY (shim at
`tools/agent-proxy/claude-shim.mjs`, claude CLI retired),
`~/.claude/settings.json` never touched by us (sha256 tripwire only).

## THE GOAL (one sentence)

Land the thirteen trees and the anti-gaming core, then prove the fixed
conveyor on a real from-scratch run on `glm-4.6`, and — only if that run is
honest and successful — implement and exercise the E9 recycle.

## Phase board

| # | Phase | State | Owner | Result |
|---|---|---|---|---|
| 0 | Directives recorded (AGENTS.md, brief TASK 6, this tracker); WIP `wip/documentation-workshop` preserved (a05bc223) | ✅ done | main | saga4 clean at 7b48ef2c + docs commit |
| 1 | TASK 1 Wave A merge: es1-loop-detector, provider-retry, worker-names, worker-disorientation | ✅ done 4/4 (main finished the wave) | wave-A agent + main | b8b50c04 clean; f3600d07 hand-resolved (shim ×2); 42f58586 hand-resolved (shim, 3-way); 2af953e6 clean. Final: build 0, arch 393/393, pm 1098/1098 (one unreproduced flake, see log) |
| 2 | TASK 1 Wave B merge: 7 blindsight trees | ✅ done 7/7 | agents + main | f6042bd9, a53eebad (agent, clean); ae2e634b, bf9f66a5, fb2ece90, f27b02aa, 62b9339e (main, hand-resolved). Final: build 0, arch 408/408, pm 1169/1169, infra 394 pass/0 fail/12 skip, schema 100 |
| 3 | TASK 1 Wave C merge: ac-drift-remedy alone + full regression + count reconciliation | ⏸ stopped after landing | wave-C agent | merge `2a0c21d7` clean, all critical checks PASS (schema 100 unchanged, E9 reserve intact, build 0, pm 1209/1209, arch 408/408); STOP per rule c — lifecycle/w9/golden-path red, all three proven PRE-EXISTING at 7ecedc6d (see 01:37 entry); NOT pushed, main decides |
| 4 | TASK 2 anti-gaming steps 1–4 (per CERTIFICATION-GAMING-REMEDY rollout) + RED gaming replay must FAIL | ⬚ pending | step agents | |
| 5 | TASK 3 bounded hygiene + TASK 4 snapshot-mvp answers + TASK 5 E2 migration note | ⬚ pending | agents | |
| 6 | LAUNCH: fresh run, `--model glm-4.6`, concurrency 2, guard env, docking-slice order; monitor to terminal | ⬚ pending | main | |
| 7 | Post-run: snapshot, harvest corpus, one-command product check (no fixes), findings list | ⬚ pending | subagent | |
| 8 | CONDITIONAL on run success within the night: E9 recycle implementation + recycle run | ⬚ pending | agents + main | |
| 9 | Morning report (this file, bottom) | ⬚ pending | main | |

Rules carried into the night: a red merge stops its wave and is reported, not
repaired; never report "green" without pasted counts; never start Phase 6
from a dirty tree; the run is never repaired mid-run — abort means snapshot
first; any E9-reserve code is escalate-never-delete.

## Pre-launch record (Phase 6 gate — fill at launch)

- [ ] HEAD SHA after phases 1–5, tree clean
- [ ] `npm run build` exit 0, `dist/index.js` mtime
- [ ] suite counts after the final HEAD (all six commands from the brief)
- [ ] `~/.claude/settings.json` sha256 at launch: `______` (tripwire anchor)
- [ ] guard env: SAGA_REAL_CLAUDE_PATH=shim, SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1, SAGA_FACTORY_CONCURRENCY=2
- [ ] DB `.factory-sandboxes/stage12-db/factory.sqlite`, sandbox `stage12`, logs `stage12-logs`, journal pinned
- [ ] order = stage-10 docking slice, verbatim

## Log (append-only, newest last)

- **00:30** — Operator override received and recorded: OPENCODE ONLY
  everywhere; claude CLI retired; settings.json untouchable (tripwire only);
  English only; goal + this tracker as self-tracking; run on glm-4.6 after
  TASK 1+2; conditional E9 recycle. AGENTS.md updated; brief TASK 6 appended.
- **00:33** — Dormant parallel-session WIP (documentation workshop, last
  touched 20:53) preserved on `wip/documentation-workshop` (a05bc223, 33
  files, +3445). saga4 clean. NOTE: current settings.json hashes `1d0aac5e…`,
  differs from stage-11 baseline `e03e7bbc…` — post-run operator channel
  state, not a factory write; tripwire anchors at launch.
- **00:34** — glm-4.6 verified present in the checked-in catalog
  (`factory-model-profiles.ts`: limit 2, effort high, verified via /models
  2026-08-18) and in the shim map (`zai-coding-plan/glm-4.6`, 200K). No code
  change needed for the route.
- **00:31 machine clock** (wave-A agent; prior entries show later readings —
  clock skew between sessions) — PHASE 1 STOPPED after 1 of 4 merges. Verbatim
  record:
  - Baseline on saga4 @ `17eec614` (clean): `npm run build` exit 0;
    architecture suite `tests 329 / pass 329 / fail 0 / skipped 0`;
    process-modules suite `tests 1098 / pass 1098 / fail 0 / skipped 0`.
    (Brief ballpark said ~345 arch / ~1057 pm; actual saga4-head baselines
    are 329 / 1098 — recorded as the reconciliation baseline.)
  - Merge 1 `repair/es1-loop-detector` → merge commit `b8b50c04`
    (no-ff, no conflicts). Build exit 0. Architecture `tests 339 / pass 339 /
    fail 0 / skipped 0` (+10 from the new
    `tests/architecture/claude-shim-stream-json.test.mjs`). Process-modules
    `tests 1098 / pass 1098 / fail 0 / skipped 0` (unchanged). Pushed
    `origin/saga4` `17eec614..b8b50c04`.
  - Merge 2 `repair/provider-retry` → `CONFLICT (content): Merge conflict in
    tools/agent-proxy/claude-shim.mjs` (README auto-merged). `git merge
    --abort` executed; tree clean at `b8b50c04`. Wave STOPPED per TASK 1 rule
    (no conflict resolution, no repair forward). Read-only `git merge-tree`
    confirms the conflict is confined to `claude-shim.mjs`; both trees rewrote
    overlapping regions of that one file from common base `6578809f`
    (es1 +173/−13 lines stream-json translation; provider-retry +309/−15
    lines retry ladder). Judgment: interaction between the two trees (same
    file, overlapping hunks), not a build/test defect of either tree.
  - Merges 3 (`repair/worker-names`) and 4 (`repair/worker-disorientation`)
    NOT attempted — wave stopped.
  - Operator action needed at wake: decide how to sequence/rebase the two
    shim-touching trees (es1 + provider-retry) or hand-resolve the
    `claude-shim.mjs` overlap; after that, re-plan Wave A remainder.
- **00:37 (main)** — DECISION: the operator is asleep and full-stop contradicts
  the TASK 6 override ("run tonight"); a conflict is not a red tree (no
  verification failed — the branches textually overlap). Main hand-resolved
  the overlaps as semantic unions, verified, and completed the wave:
  - provider-retry `f3600d07`: retry ladder × es1 translator, per
    provider-retry's own base composition comment (capture → translate →
    forward; translator per attempt, so half-translated state never leaks
    across attempts; finish() tail written at each child close, never masking
    the exit code). Shim families green: stream-json 10/10, provider-retry
    44/44; arch 383/383, pm 1098/1098.
  - worker-disorientation `42f58586`: third overlap in the shim — `--dir`
    pin + env.PWD override + explicit spawn cwd composed over the ladder
    (childArgs/argsPrefix unification with the compound
    SAGA_PROXY_OPENCODE_PATH convention; entry guard keeps realpathSync
    hardening; dedup of the double parseArgv export). Shim families 62/62
    (stream-json 10 + provider-retry 44 + disorientation 8); arch 383/383,
    pm 1098/1098.
  - worker-names `2af953e6`: clean merge, amended message. Arch 393/393,
    pm 1097/1098 in the first post-merge run → **two consecutive full reruns
    1098/1098 fail 0** — unreproduced flake; the failing test name was NOT
    captured (my grep pattern missed the spec ✖ marker; noted for recurrence).
    Caveat: the push for 2af953e6 went out in the same chain before the flake
    was seen — origin briefly held the unverified state; both post-hoc reruns
    are green.
- **00:39 (main)** — Wave B agent dispatched (7 blindsight trees, same
  protocol: build + arch + pm per merge, conflict → abort + stop + report for
  main to hand-resolve, push per merge).
- **00:44 (wave-B agent)** — PHASE 2 STOPPED after 2 of 7 merges. Verbatim
  record:
  - Merge 1 `repair/blindsight-worker-prompt` → merge commit `f6042bd9`
    (no-ff, no conflicts, auto-merged `tracker-view/claude-runner.mjs`).
    Build exit 0. Architecture `tests 393 / pass 393 / fail 0 / skipped 0`.
    Process-modules `tests 1104 / pass 1104 / fail 0 / skipped 0` (+6 new
    from `tests/process-modules/feedback-history-materialization.test.mjs`).
    Pushed `c7033c79..f6042bd9`.
  - Merge 2 `repair/blindsight-gate-delivery` → merge commit `a53eebad`
    (no-ff, no conflicts, auto-merged `src/schema.ts` + executor). Build
    exit 0. Architecture `tests 393 / pass 393 / fail 0 / skipped 0`.
    Process-modules `tests 1117 / pass 1117 / fail 0 / skipped 0` (+13 new
    across final-acceptance-rejection-history, gate-run-driver-candidate-
    snapshot, review-finding-structural-codes, carry-forward tests).
    Pushed `f6042bd9..a53eebad`.
  - Merge 3 `repair/blindsight-lifecycle` → CONFLICT. Verbatim:
    ```
    Auto-merging src/app/product-lifecycle-runtime.ts
    Auto-merging src/process-modules/application/node-executors/production-cell-node-executor.ts
    Auto-merging tests/process-modules/production-cell-node-executor.test.mjs
    CONFLICT (content): Merge conflict in tests/process-modules/production-cell-node-executor.test.mjs
    Automatic merge failed; fix conflicts and then commit the result.
    ```
    `git merge --abort` executed; tree clean at `a53eebad` (only the
    never-touch untracked evidence files remain). Wave STOPPED per TASK 1
    rule (no conflict resolution, no repair forward). Read-only
    `git merge-tree` confirms the conflict is confined to that ONE file;
    both trees appended tests to the same test file from common base
    `dae42418` (saga4 side +81 lines via gate-delivery's candidate-snapshot
    tests; lifecycle side +218 lines of F3/F4/F5 executor behavior tests).
    The source file `production-cell-node-executor.ts` itself auto-merged
    cleanly. Judgment: textual overlap between the two trees in one test
    file, not a defect of either tree; hand-resolution is an append-union
    of two test blocks.
  - Merges 4 (`repair/blindsight-persistence`, schema 99→100), 5
    (`repair/blindsight-phantom-bridges`), 6
    (`repair/blindsight-integration-verify`), 7
    (`repair/blindsight-reconciliation`) NOT attempted — wave stopped.
    No flake observed: every suite run tonight was fail 0 on first pass.
  - Operator action needed at wake: hand-resolve the test-file overlap
    (append-union) and resume Wave B from merge 3; alternatively rebase
    `repair/blindsight-lifecycle` onto `a53eebad`. NOTE: merges 4–7 remain
    unmerged; `repair/blindsight-persistence` still carries schema 99→100
    (the only allowed schema move, untouched).
- **00:52 (main)** — Wave B at 3/7. worker-prompt f6042bd9 (pm 1104/1104) and
  gate-delivery a53eebad (pm 1117/1117) merged clean by the agent; the agent
  stopped on blindsight-lifecycle's test-file append overlap
  (production-cell-node-executor.test.mjs, both trees appended blocks). Main
  resolved as append-union with restored dangling closers. LESSON recorded:
  these tests import from **dist/** — after resolving any merge, `npm run
  build` BEFORE judging suite results (three F6 "failures" were a stale
  artifact, not the resolution: file 30/30 after rebuild). Merged ae2e634b:
  arch 393/393, pm 1132/1132. Remainder re-dispatched: persistence (schema
  99→100 + infra suite), phantom-bridges, integration-verify, reconciliation.
- **00:49 machine clock (wave-B remainder agent; skew vs main's 00:52 above)**
  — PHASE 2 STOPPED at merge 4, `repair/blindsight-persistence`. No merges
  landed tonight by this agent; saga4 remains at `28e7b96f`, clean (only the
  never-touch untracked evidence files). Verbatim merge output:
  ```
  Auto-merging docs/architecture/legacy-allowlist.json
  CONFLICT (content): Merge conflict in docs/architecture/legacy-allowlist.json
  Auto-merging src/process-modules/application/node-executors/production-cell-node-executor.ts
  Auto-merging src/schema.ts
  Automatic merge failed; fix conflicts and then commit the result.
  ```
  `git merge --abort` executed; tree clean at `28e7b96f`. Read-only
  `git merge-tree` confirms the conflict is confined to that ONE file
  (`docs/architecture/legacy-allowlist.json`); `src/schema.ts` and the
  executor AUTO-MERGE cleanly. Characterization, both sides vs base
  `d010a089`:
  - persistence side (5c290c9e schema-freeze): `tableCount` 99→100, digest
    `55599618…`→`e25ae1b7…`, `capturedAtSha` → `c7a68ac8` (F6 drift-events
    table recorded in the legacy baseline).
  - saga4 side (40a79ac0 worker-names): `tableCount` stays 99, digest
    `55599618…`→`6ec6ea2b…` (schema content changed at constant table count).
  Judgment: semantic, not textual — a hand-resolution must pick
  `tableCount: 100` AND regenerate the digest from the merged `src/schema.ts`
  (neither side's digest is valid for the union schema). NOT a defect of
  either tree. Note: `src/schema.ts` itself auto-merges; only the frozen
  baseline JSON disagrees. Merges 5 (`repair/blindsight-phantom-bridges`), 6
  (`repair/blindsight-integration-verify`), 7
  (`repair/blindsight-reconciliation`) NOT attempted — batch stopped per
  TASK 1 rule. All four trees verified present with commits intact; the
  other three share base `dae42418` and were not pre-checked beyond
  existence. No build/test runs performed (no merge landed, nothing to
  verify); no push (HEAD unchanged at `28e7b96f`, already on origin).
  Operator action needed at wake: hand-resolve the
  `legacy-allowlist.json` snapshot (regenerate digest at tableCount 100),
  then resume merges 5–7 per the remainder protocol.
- **01:02 (main)** — blindsight-persistence merged `bf9f66a5`. The
  legacy-allowlist.json conflict resolved semantically: neither side's digest
  is valid for the union schema, so the allowlist was regenerated from the
  merged tree (`tools/legacy-freeze.mjs --snapshot`: **100 tables**, digest
  `f9143455ea65`, `--check` OK). Schema 99→100 is tonight's only schema move,
  as the brief demands. Verified: build 0, infra **372 pass / 0 fail /
  12 skip**, arch **403/403**, pm **1143/1143**. Final three trees
  (phantom-bridges, integration-verify, reconciliation) dispatched to the
  wave-B final agent.
- **00:54 machine clock (wave-B final agent; skewed vs main's 01:02 above)**
  — PHASE 2 STOPPED at merge 5, `repair/blindsight-phantom-bridges` (tip
  `743b5886`). No merges landed by this agent; saga4 remains at `0c32d06e`,
  clean (only the never-touch untracked evidence files). Verbatim merge
  output:
  ```
  Auto-merging src/lifecycle/work-assignment-core.ts
  Auto-merging tests/worker-prompt-assembly.test.mjs
  CONFLICT (content): Merge conflict in tests/worker-prompt-assembly.test.mjs
  Auto-merging tracker-view/claude-runner.mjs
  Automatic merge failed; fix conflicts and then commit the result.
  ```
  `git merge --abort` executed; tree clean at `0c32d06e`. Read-only
  `git merge-tree` (base `dae42418`) confirms the conflict is confined to
  that ONE file; `work-assignment-core.ts` and `claude-runner.mjs` (also
  changed in both) auto-merge cleanly. Characterization: known shape (i) —
  both trees appended test blocks at the same end-of-file anchor of
  `tests/worker-prompt-assembly.test.mjs`. saga4 side (worker-prompt merge
  `f6042bd9`) appended the "feedback delivered LOUDLY" + death-history
  blocks (+164 vs base); phantom-bridges side appended the "G1.6 —
  BLINDSIGHT X2: prior-attempt memory delivered LOUDLY" block (+51 vs
  base). One conflict hunk at the shared tail anchor (`@@ -222,6`); a
  hand-resolution is an append-union of both block sets. NOTE:
  `repair/blindsight-reconciliation` also appends to this same file (+91
  vs base) — when main hand-resolves, union all three appends or expect
  the same conflict again at merge 7. Merges 6
  (`repair/blindsight-integration-verify`, tip `d3b81c7f`) and 7
  (`repair/blindsight-reconciliation`, tip `e38ba18e`) NOT attempted —
  batch stopped per TASK 1 rule. No build/test runs (no merge landed);
  no push of code (HEAD unchanged at `0c32d06e`, already on origin).
  Operator action needed at wake: hand-resolve the test-file append
  union (phantom-bridges X2 block + saga4's existing blocks, and
  reconciliation's future +91), then resume merges 6–7 per protocol.
- **01:05 (main)** — phantom-bridges merged `fb2ece90` (append-union in
  worker-prompt-assembly.test.mjs: worker-prompt feedback/death-history
  blocks + X2 G1.6 block). Arch 408/408, pm 1143/1143.
- **01:06 (main)** — TASK 4 answered and committed `7cde1719`
  (SNAPSHOT-MVP-ANSWERS.md): captured-but-truncated corpus; production
  gates/settlement inside the replay boundary; NO on gaming, NO on AC-drift
  (the tape itself benignly games the readiness gate; the drift is frozen
  into the corpus as ground truth). Branch stays HELD for the architect.
- **01:10 (main)** — integration-verify merged `f27b02aa` after the deepest
  resolution of the night: the branch's local decodeFindingsForDecision was
  a pre-extraction duplicate (gate-delivery had moved it to
  sqlite-gate-finding-set-chain.ts), so the duplicate block was dropped and
  the branch's SEAM L2 seam-issue mapping PORTED into the shared decoder
  (diagnostics AND seam issues feed one findings array; fileHints on the
  interface); seam-repair-routing test import repointed to the shared
  module; ternary anchor refreshed 575→576. Arch 408/408, pm 1157/1157.
- **01:16 (main)** — reconciliation merged `62b9339e`: two interleaved append
  blocks in worker-prompt-assembly.test.mjs (12/12) + a validator union in
  pinned-workspace-materializer.ts. PROCESS SLIP recorded: a too-broad
  `git add -A` briefly staged evidence dirs (.factory-docker-runs etc.);
  the commit failed harmlessly (exit 128, no junk landed), index reset, the
  exact 12-file merge set re-added. **WAVE B COMPLETE 7/7**: build 0, arch
  408/408, pm 1169/1169, infra 394 pass/0 fail/12 skip, schema 100.
- **01:17 (main)** — Operator set a 10-minute self-hook: tracker check every
  10 min (this file vs git reality; one short English line per fire).
  Wave C (ac-drift-remedy alone) dispatching next. NOTE for wave C: the
  brief's "only schema move" was spent by Wave B (99→100); if the
  ac-drift-remedy tree carries its own schema change, that is escalation
  item 4 — STOP and report, do not decide.
- **01:21 (cron)** — ac-drift-remedy merge commit landed: `2a0c21d7` (wave C
  agent; full six-suite regression + reconciliation report still running).
- **01:37 (wave-C agent)** — WAVE C STOPPED AFTER LANDING (rule c: reproducible
  fails → stop, no push; every red proven PRE-EXISTING at pre-merge `7ecedc6d`,
  none caused by the merge). Verbatim record:
  - Pre-checks: saga4 clean at `7ecedc6d` (only never-touch untracked
    evidence). Branch tip `be0690e1` (20 commits from base `3384dfc3`). Tree
    diff vs base touches **no** schema.ts / legacy-allowlist.json / migrations.
  - Merge `repair/ac-drift-remedy` → `2a0c21d7` (no-ff, **zero conflicts**,
    'ort' strategy, 32 files +3101/−26).
  - **Critical checks PASS**: schema `tools/legacy-freeze.mjs --report` before
    AND after = `schema-snapshot: 100 tables, digest f9143455ea65`, `legacy
    freeze: OK` — no second schema move, escalation item 4 NOT triggered (the
    schema.ts delta branch↔saga4 is entirely Wave B's already-merged 99→100,
    one-sided, so the merge keeps saga4's schema). **E9 reserve intact**:
    `src/shared/constraint-register.ts` line 2 `[E9 RESERVE — DO NOT REMOVE]`.
    `npm run build` exit 0.
  - Six suites at merged HEAD, verbatim:
    - architecture: `tests 408 / pass 408 / fail 0 / skipped 0` (unchanged)
    - lifecycle (first run tonight): `tests 136 / pass 135 / fail 1 /
      skipped 0`
    - process-modules: `tests 1209 / pass 1209 / fail 0 / skipped 0`
      (+40 = the tree's five new constraint test files)
    - infrastructure: `tests 406 / pass 394 / fail 0 / skipped 12` (unchanged)
    - factory-e2e w9: `tests 18 / pass 1 / fail 17 / skipped 0`
    - factory-contract golden-path: `tests 1 / pass 0 / fail 1 / skipped 0`
    - extra (not among the six): `tests/discovery/order-constraint-register.test.mjs`
      `tests 12 / pass 12 / fail 0 / skipped 0`
  - **Count reconciliation**: the tree's own reports (arch 345/0, pm 521/0,
    "52/52 new unit tests") are stale branch-point numbers measured against
    pre-wave-A/B saga4 (base `3384dfc3`, when the counts were ~329 arch /
    ~1098 pm per the 00:31 wave-A baseline record). Merged reality: arch 408
    (tree adds NO architecture tests), pm 1169→1209 (+40). The "52" reconciles
    EXACTLY: 40 process-modules tests + 12 discovery-suite register tests.
  - **STOP cause, attributed in detached worktrees (read-only probes)**:
    - lifecycle fail `architecture: no direct lifecycle UPDATE outside
      sanctioned writers` — verbatim error: `direct lifecycle UPDATE forbidden
      outside sanctioned writers. Found: src/modules/development/application/
      replan-supersede.ts: matches /UPDATE\s+tasks\s+SET\s+status\s*=/`. The
      violating file was last touched by `e9ea5aa7` (08-19 20:49, stage-11
      replan-cycle), which IS an ancestor of wave-A baseline `17eec614` —
      **predates the entire night shift**. Fails identically at `7ecedc6d`.
    - w9 + golden-path (the drive-harness family): **GREEN at `17eec614`**
      (w9 18/18, golden 1/1), **RED by `5d01b711`** (w9 0/18) and red ever
      since, including at `7ecedc6d` (already on origin) and at the merged
      HEAD. One of the six merges `b8b50c04`/`f3600d07`/`42f58586`/`2af953e6`
      /`f6042bd9`/`a53eebad` broke the drive family; tonight's per-merge gate
      (arch+pm only) never saw it. Culprit NOT isolated (stop discipline;
      bisect is main's daylight act). Typical errors: w9 `AssertionError:
      drive-1: ≥10 scripted invocations` (w9-02-single-drive.mjs:182 — the
      drive stalls early); golden-path `AssertionError: Run A orchestrate-cli
      exited 1` (golden-path.test.mjs:324).
  - **HAZARD for the morning bisect**: running the w9 drive from a LINKED
    WORKTREE corrupted the shared repo config — `core.bare=true` appeared in
    `.git/config` (~01:23, during worktree probes; repo blocked for all
    worktree ops, incl. this tracker's cron loop). Restored to `false` at
    01:28; verified saga4 intact, zero tracked dirt, all 22 sibling worktrees
    intact, both probe worktrees removed. Bisect drives in the MAIN checkout
    or check `git config core.bare` after every step.
  - **NOT PUSHED** (no green, no push). origin/saga4 stays `7ecedc6d`; local
    saga4 = merge `2a0c21d7` + cron `4f46d6d5` + this entry. Main's morning
    decisions: (a) push wave C — it breaks nothing that wasn't already broken
    at `7ecedc6d` and adds pm 1169→1209; (b) bisect the drive-family break in
    the six-merge range above; (c) the lifecycle sanctioned-writer violation
    (`replan-supersede.ts`) — sanction or escalate, architect's act, not mine.

