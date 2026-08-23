# STAGE-21 RUN TRACKER — ELITE-7: full lifecycle on the Conformance Closure build

Protocol declared BEFORE launch (the stage-15/19/20 discipline).

## Purpose

First full product-build run (discovery → formalization → development →
runnable-local) on the Conformance Closure integration stack — the tree that
closed the entire Elite-6 defect catalog (CC-GAP-1..6, 8, 9, 10), landed
ADR-087..092 (terminal drain, register-conditional coverage, substrate retry,
TOCTOU re-probe, idea-authority conservation IC-1/IC-2, proof-hosting
registry), the verification accounting ledger, K19 environment identity
fences (provider 1.14.0) and the K0 baseline digest repair.

This run is the LIVE TEST of everything the closure program built: the same
game brief Elite-6 lost requirements on must now be conserved end-to-end
(idea → register v2 → frozen contract → dispositions → accounting → honest
terminal projection).

## Product / idea

Verbatim `elite-idea.txt` (the Elite-3..6 lineage): Elite-style space
trading & combat game, browser frontend as a FIRST-CLASS acceptance subject
(canvas starfield, HUD, market, dock, arcade combat), 8+ systems with
per-system price variation, save/load, /healthz, browser smoke test.
The front and the ordered requirements are exactly what formalization lost
in Elite-6 — the v2 register must carry them through this time.

## Pre-declared protocol

- Build: dedicated worktree `D:/Development/saga-mcp-ELITE7`, branch
  `cc/elite7-run` at integration tip `905f5940` (launched from a DEDICATED
  worktree — the w02 lesson: never share a worktree whose dist a live
  engine lazily imports with anything that may rebuild).
- Executor: agent-proxy shim ONLY, env INLINE on the launch command (the
  Elite-6 incident lesson: the harness shell drops prefix assignments):
  `SAGA_REAL_CLAUDE_PATH="node D:/Development/saga-mcp-ELITE7/tools/agent-proxy/claude-shim.mjs"`
  + `SAGA_CLAUDE_PATH` same + `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1`.
- Model glm-4.6; **controls 8/8** (operator rate-limit-8 directive via the
  tracked saga4 channel `codexArchExecutorRateLimit`; catalog limit is 2 —
  re-apply after any resume/rerun, which re-stamps the catalog value).
- `~/.claude/settings.json` sha256 anchored:
  `2d6176e8d1382fe1a05791892840aa3a4f023ab87157ecaa13d1bc3a5545c6d0`
  (unchanged since stage-19). NEVER touched; drift = abort.
- No mid-run repairs (escalate, never decide). NO builds in this worktree
  while the engine lives.
- Observation: `tools/run-watchdog.mjs` 60 s samples / 45 min stagnation /
  12 h max / settings tripwire. Stop conditions: natural terminal (any
  truthful label), engine-vanished, settings drift, stagnation.
- Abort: operator directive only.

## Success criteria (declared up front)

1. Natural terminal with an EXTERNALLY true label: the integrated product
   starts, serves the game in a browser, its suite passes.
2. The frontend + ordered requirements survive formalization: register v2
   carries open-questions/mechanics/ordered-smoke/quality entries; the
   coverage reverse-diff never shows constraint-register-uncovered; no
   worker-authored "operator-waiver" ever subtracts (typed unavailable).
3. The new terminal machinery tells the truth: run.terminal exactly-once
   with terminal_status/stage_outcome separated; no phantom running
   executions at the terminal boundary (ADR-087 drain); substrate faults
   route to typed unknown (never product-failed) on the first retry cycle.

## Pre-flight (filled at launch)

- [x] HEAD `905f5940` (cc/CC-00B-terminal-integrity-integration tip)
- [x] build exit 0 (tsc clean, dist 14:49 local)
- [x] factory-proof group 112/112 green on the fresh dist (131 s)
- [x] fresh `elite7-db/` + `elite7/` + `elite7-logs/`
- [x] settings sha anchored (matches the stage-19 anchor)
- [x] controls raised 8/8 immediately after start (epic 1)

## Log (append-only, newest last)

- **11:50:03Z (14:50 local) — LAUNCHED.** Engine detached pid 18544, launch
  `launch-a59a68a3-ceb2-4caa-ab50-8962ed3a97d4`, log
  `saga-engine-1-2026-08-23T11-50-03.873Z.log`, model glm-4.6, worker
  backend agent-proxy/opencode (first worker opencode pid 28568; NO
  FACTORY_CLAUDE_BACKEND_FORBIDDEN — the inline-env lesson held).
  Controls were 2/2 at engine start, raised to 8/8 at +2 min (before the
  first gate; first claim may ride the start value — watch dispatch width
  when Development opens parallel cards). Task 1 assigned
  `worker-execution:7cf8c4d3…`, prompt-budget telemetry live
  (task=1 total=25363 bytes — F-A bound holds). Watchdog live
  (60 s / 45 min / 12 h, full settings sha).
