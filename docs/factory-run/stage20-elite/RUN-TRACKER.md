# STAGE-20 RUN TRACKER — ELITE: full lifecycle on the post-merge factory

Protocol declared BEFORE launch (the stage-15/19 discipline).

## Purpose

First full product-build run (discovery → formalization → development →
runnable-local) on the tree that merged the parallel session's formalization
hardening (heading-resolution gate v1.2.0 3cf4819a, workshop rebind f8ffd759,
derived-evidence factory-owned e62a9e8a) plus the W0-1 canonical proof
composition and the actor-grammar repairs.

**Product (operator directive, 2026-08-20 night):** an Elite-style space
trading & combat game WITH a browser frontend — "с фронтом на хром браузере
с красивой графикой, то же задание, только про фронт не забыть". The frontend
is a first-class acceptance subject, not an afterthought.

**Model:** glm-4.6 (operator directive), **ratelimit 4** (operator directive;
the catalog profile limit is 2 — the controls row is raised to 4 immediately
after start, before the first claim; re-applied after any resume because the
resume path re-stamps the catalog limit).

## Pre-declared protocol

- Entry: `node scripts/factory.mjs start .factory-sandboxes/elite-db/factory.sqlite
  "<idea>" --model glm-4.6 --sandbox .factory-sandboxes/elite` — fresh sandbox,
  fresh DB, standard product-build lifecycle (delivery deferred).
- Idea text demands the Chrome frontend explicitly (canvas/WebGL visuals, HUD,
  market/dock screens, playable loop) and browser-smoke coverage.
- Executor: agent-proxy shim ONLY (`SAGA_REAL_CLAUDE_PATH`/`SAGA_CLAUDE_PATH` =
  `node <repo>/tools/agent-proxy/claude-shim.mjs`, map `zai-coding-plan/glm-4.6`);
  `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1`.
- `~/.claude/settings.json`: sha256 anchored at launch; NEVER touched.
- No mid-run repairs (escalate, never decide). NO builds while the run lives.
- Observation: `tools/run-watchdog.mjs` 60 s samples; **stop conditions**
  (pre-declared): 45 min fingerprint stagnation, engine-vanished, settings
  drift, or a natural terminal state. Snapshot before launch and before any
  stop.
- Abort: operator directive only.

## Success criteria (declared up front)

1. Natural terminal (`runnable-local`) with a truthful label — and this time
   the label must be EXTERNALLY true: the integrated product actually starts,
   serves the game in a browser, and its own test suite passes (the stage-19
   amendment lesson: internal truth ≠ external truth).
2. The frontend exists as accepted material: ACs covering the browser UI
   (starfield/HUD/market/dock/combat visuals) are in the frozen acceptance
   baseline, implemented, and verified — not silently narrowed away.
3. Stage-18 fixes exercised on a fresh run: R1 WRITE AUTHORITY delivery,
   R2 claim-surface monotonicity, R3 integration diagnostics.

## Pre-flight (filled at launch)

- [ ] HEAD SHA + full-suite counts (the post-repair baseline)
- [ ] build exit 0 (current dist)
- [ ] fresh `.factory-sandboxes/elite-db/`, `elite/`, `elite-logs/`
- [ ] controls: model glm-4.6, concurrency 4, model_concurrency_limit 4
- [ ] settings.json sha256 anchored
- [ ] pre-launch DB snapshot

## Log (append-only, newest last)

_(to be filled at launch)_
