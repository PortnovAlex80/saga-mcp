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
| 1 | TASK 1 Wave A merge: es1-loop-detector, provider-retry, worker-names, worker-disorientation | ⬚ pending | wave-A agent | |
| 2 | TASK 1 Wave B merge: 7 blindsight trees | ⬚ pending | wave-B agent | |
| 3 | TASK 1 Wave C merge: ac-drift-remedy (schema 99→100 — the only schema move) + full regression + count reconciliation | ⬚ pending | wave-C agent | |
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
