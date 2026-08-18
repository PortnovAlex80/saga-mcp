# Canary run playbook — first local-model factory run

- **Date:** 2026-08-18. Branch `saga4`.
- **Task:** stage-6 G5 (`docs/handoff/STAGE-6-AGENT-BRIEF.md`). Pre-flight
  checklist only — the OPERATOR executes the canary; this document is what they
  follow. Nothing here was executed beyond read-only probes.
- **Companion documents:** `docs/testing/G4-LEASE-ARITHMETIC.md` (lease/silence
  margins), `CLAUDE.md` (model matrix, flip procedure, patch procedure),
  `docs/research/2026-08-18-real-run-gap-analysis.md` (why the canary kept
  failing before).

---

## 0. Machine status as probed on 2026-08-18 (read-only)

| Check | Status |
|---|---|
| Named canary model `qwen/qwen3.6-27b` | **NOT DOWNLOADED** — absent from `~/.lmstudio/hub/models/` (publishers present: google, microsoft, mistralai, openai, prism-ml, qwen with 3.5-9b / 2.5-coder-14b / 3-4b only) |
| The only local 27B | `prism-ml/bonsai-27b` (arch qwen35, 4.73 GB on disk) — **not loaded** |
| Jinja `System message must be at the beginning` bug string | **zero matches** anywhere under `~/.lmstudio/hub/models/` and user-concrete overrides (absent models ⇒ nothing to match; qwen3-4b-2507 override is already tolerant; qwen3.5-9b has NO template override — its template is GGUF-embedded) |
| `lms show` | **does not exist** as a command (`lms ls` / `lms ps` are the real surface) |
| LM Studio server (127.0.0.1:1234) | UP, **0 models loaded** |
| Tracker | port 4321 LISTENING (live); observer on 4323 |

**Verdict per the checklist rules:**

> **CANARY BLOCKED: model not present.** The CLAUDE.md-named canary models
> (qwen3.6-27b / qwen3.6-35b-a3b) are not downloaded. Download one, or decide
> `prism-ml/bonsai-27b` as the canary target.
>
> **CANARY BLOCKED: missing infrastructure** (model not loaded) — resolves at
> step 2 below.
>
> **CANARY AT RISK: context length** — unmeasurable until a model is loaded;
> LM Studio context is set at load time (`-c`), the runner pins
> `CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144` for lmstudio routes. Load with
> `-c 120000` minimum (CLAUDE.md's own guidance).

## 1. Prerequisites (all must hold before step 3)

1. **Model present and template-patched.** After download/load: if the worker
   log shows `api_retry … 500` bursts then exit 1, the mid-conversation
   system-message Jinja bug is live — patch per CLAUDE.md (model.yaml or the
   user-concrete override JSON), `lms unload` / `lms load -c <ctx>`, then
   verify with `claude -p --model "<id>" --no-session-persistence "Say hello"`.
   For GGUF-embedded templates (qwen3.5-9b, likely bonsai-27b) the patch site
   is the user-override JSON; verification by probe is the ONLY reliable check.
2. **Context length** loaded ≥ 120K (`lms load "<model>" -c 120000 -y`).
3. **Tracker running** (`node dist/index.js tracker …`; port 4321) and **LM
   Studio server up with the model LOADED** (verify `curl -s
   http://127.0.0.1:1234/v1/models` lists it — an empty list means not loaded).
4. **Flip-timing understood** (step 4 below) — the first-claim race is the
   known paid-cloud trap.

## 2. Model loading

```
lms load "<publisher/model>" -c 120000 -y
curl -s http://127.0.0.1:1234/v1/models     # must list the model
```

## 3. Factory start

Start the factory through ONE of the start paths (`scripts/factory.mjs start`
or the tracker gateway `/api/factory/start`). Both write the cloud model
profile into `lifecycle_execution_controls` and spawn the engine IMMEDIATELY
(checked-in cloud catalog; glm-4.7 capped at 2 concurrent) — the first claim
can freeze on the paid cloud model before the local flip lands. That is why
the flip comes next, fast.

## 4. The flip (immediately after start)

```
# warm probe first (wakes the LM Studio service if idle):
curl -s http://127.0.0.1:4321/api/lmstudio/models
# then flip:
curl -X POST http://127.0.0.1:4321/api/model/set \
  -H 'Content-Type: application/json' \
  -d '{"model":"<publisher/model>","epic_id":<N>}'
```

`/api/model/set` two-states `~/.claude/settings.json` from the permanent
cloud/lmstudio templates, stamps all four model slots, and upserts
`lifecycle_execution_controls` — the route is read AT CLAIM and frozen into
`worker_executions.execution_context`. Verify the win: the next worker process
must be `claude -p --bare --model <local-model>` with **no `--effort`**.

**Verified in code (G5.5):** the runner omits `--effort` for lmstudio routes
(`claude-runner.mjs`: `effortArg` is null when `isLmstudio`; `--effort` is
spliced only when the arg is truthy). Cloud default when no route is set is
the `opus` alias with effort `high` — i.e. the PAID path; the race is real.

## 5. Success criteria (one green run)

- One lifecycle run from `initial-discovery` through `delivery-release` with
  terminal `completed`.
- **0 manual DB edits.**
- **0 stalled workplaces** (no workplace stuck non-terminal at the end; watch
  the observer panel on 4323).
- Accepted head advanced through all 4 stages (discovery → formalization →
  development → delivery certificates issued).
- No `REAPED … action=lost` storm in the supervision log (a few losts on a
  local model are recoverable; a repeating reap-per-claim pattern is the
  G4 silence/thrash signature — see the abort conditions).

## 6. Abort conditions

Abort (stop the run, collect logs, do not "fix" mid-run) when:

- **Lease/silence thrashing**: `REAPED … action=lost` repeating for the SAME
  task across consecutive sweeps — the G4 arithmetic says the 10-min silence
  ladder or the 15-min dispatch wait is too tight for this model's cadence.
- **Worker stall**: no `progress_at` movement and no stream output for >10 min
  while the process is alive.
- **Heartbeat missing at claim**: the model ignored rule 0 AND the run cannot
  be reasoned about from the observer panel (the heartbeat is observability —
  its absence with a progressing run is NOT an abort by itself).
- **Any `failed` transition that is NOT understood** — read the
  settlement/gate reason codes before continuing; do not retry blind.

## 7. Recovery — first claim froze on the paid cloud model

The known trap (CLAUDE.md:30-39). Recovery:

1. Kill the cloud worker process (`claude … --bare`) and the
   `orchestrate-cli` process.
2. Run a **plain** `node scripts/factory.mjs resume` (no model args — resume
   reaps the frozen execution via supervision `action=lost` and the card
   re-claims).
3. Verify the new worker process is `claude -p --bare --model <local-model>`
   with no `--effort`.
4. If the flip itself never landed (settings still cloud), redo step 4 BEFORE
   resuming.

## 8. Post-run (informational, no action)

- The G2 disobedience scenarios (w9-05) prove the factory survives silent,
  non-completing and file-faking workers mechanically — a misbehaving local
  model produces lost executions + repair, not corruption.
- The G3 dossier records the merge-grant question; until the architect
  decides, a local model that follows tracker step 8 (merge instructions)
  instead of the skill prohibition is exercising interleaving A of G3 §7 —
  collect any such occurrence as evidence for that decision.
