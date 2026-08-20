# STAGE-19 RUN TRACKER — the redevelopment run on the rebuilt factory

Protocol declared BEFORE launch (the stage-15 discipline).

## Purpose

Re-enter solution-development from the frozen workshops-1/2 capsule on the
REBUILT factory (stage-18 fixes R1/R2/R3 in their production path):

- **R1 exercised**: every staffing's prompt must carry the WRITE AUTHORITY
  section (watch for `authority.grant_delivered` journal events should any
  widening fire — the information asymmetry is closed).
- **R2 exercised**: any card that silently drops a previously-claimed file
  must fail typed `IMPLEMENTATION_CLAIM_NARROWED` (the stage-15 silent
  narrowings are now impossible without a disposition).
- **R3 exercised**: a commit-sha-stamped treeSha fails AT SUBMISSION with a
  repair recipe; integration mismatches name the failed arm.
- **Terminal truth** (stage-15 TASK 3 question 3): this run's success
  criterion includes reaching a NATURAL terminal state with a truthful label.

## Pre-declared protocol

- Entry: `factory redevelop .factory-sandboxes/stage15-db/factory.sqlite
  --from-lifecycle 1` — child run enters solution-development with the
  STANDARD module (solution-development@1.4.4), planner re-carves from the
  capsule (hash `c8cff0272f54…`), NO adoption/carry-forward.
- Product repo: tag `stage15-dev-final` preserves c700df8 (task 19's
  integrated work); `dev` reset to the formalization base 224dc22 — clean
  re-development of all 5 ACs.
- Model: **glm-5-turbo**, concurrency 4 (the operator's own pre-configuration
  of the epic controls at 15:10 local on 2026-08-20 — honored, not overridden).
- Executor: agent-proxy shim only (`SAGA_REAL_CLAUDE_PATH` = shim, map
  `zai-coding-plan/glm-5-turbo`); `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1`.
- `~/.claude/settings.json`: sha256 anchored at launch; NEVER touched.
- No mid-run repairs (escalate, never decide). No builds while the run lives.
- Observation: watchdog 60 s samples; **stop conditions** (pre-declared):
  45 min fingerprint stagnation, engine-vanished, settings drift, or a
  natural terminal state. Snapshot before launch and before any stop.
- Abort: operator directive only (as at stage 15).

## Pre-flight (filled at launch)

- [ ] HEAD SHA `cbdfe972` (redevelopment entry), tree clean (operator doc edits excepted)
- [ ] build exit 0 (current dist)
- [ ] baseline: full suite 4193/4164/0 at `aadba7de`; redevelopment suite 3/3 at `cbdfe972`
- [ ] DB backup by the redevelop command + pre-launch snapshot
- [ ] product repo: tag placed, dev reset verified
- [ ] capsule hash matches the dry-run (`c8cff0272f54…`)

## Log (append-only, newest last)

_(to be filled at launch)_
- **16:30:27Z (19:30 local) — LAUNCHED.** Pre-flight: HEAD `cbdfe972`, build
  exit 0, baseline 4193/4164/0 (`aadba7de`) + redevelopment suite 3/3; DB
  backup `pre-redevelopment-2026-08-20T16-30-27.235Z.sqlite` + pre-launch
  snapshot (5394432 bytes, integrity ok); product repo: tag
  `stage15-dev-final`=c700df8, `dev` reset to 224dc22, working tree clean
  (the round-7 worker's uncommitted in-flight edits were lost to a failed
  stash before the reset — the same work survives in branch
  `saga/task/18/execution/5ffc9d46…` commits 0008780/8896871 and the compiled
  dist copies preserved in `stage15-untracked-leftovers/`); settings sha
  anchored `2d6176e8…`. Capsule `c8cff0272f54…` matches the dry-run.
  Engine detached pid 51528, launch `launch-d8a850ba`, child lifecycle 2,
  log `saga-engine-1-2026-08-20T16-30-27.375Z.log`. Model glm-5-turbo,
  concurrency 4 (the operator's epic pre-configuration honored).
- **+45 s — stage entry verified.** Lifecycle 2 paused@solution-development
  (the production-cell in-flight state), stage attempt 1; the planner card
  (task 26, development-plan-task-graph) claimed and RUNNING — the fresh
  graph is being carved from the capsule. Watchdog live (60 s samples,
  45-min stagnation, 12-h max). No mid-run repairs; escalate, never decide.
