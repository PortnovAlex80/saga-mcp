# G4 — Lease vs realistic completion time: the arithmetic

- **Date:** 2026-08-18. Branch `saga4`.
- **Task:** stage-6 G4 (`docs/handoff/STAGE-6-AGENT-BRIEF.md`). Read-only; no
  code changed. The operator decides any TTL change.
- **Method:** every constant below was read from the code; every duration below
  was measured from real factory databases (read-only queries); every local-model
  number is an ESTIMATE and is labeled as such. No model was launched.

---

## 1. The constants (MEASURED from code)

| Constant | Value | Where |
|---|---|---|
| Worker lease TTL | **5 min** | `WORKER_LEASE_TTL_MS` (`src/lifecycle/work-assignment-core.ts:24`), set at claim (`:601-620`); supervision default matches (`worker-supervision-service.ts:120`) |
| Supervision sweep interval | **30 s** | `DEFAULT_INTERVAL_MS` (`worker-supervision-service.ts:118`); plus an on-demand sweep on every empty dispatch (`orchestrate-cli.ts:480-482`) |
| Lease renewal | **every sweep**, for local rows in `reserved/running/cancel_requested` | `renewLeases` (`sqlite-factory-runtime-repositories.ts:378-431`) — touches ONLY `lease_expires_at` + `heartbeat_at`, never `progress_at` |
| Stuck-silence threshold | **10 min** (vs `progress_at`) | `STUCK_SILENCE_MS` (`src/lifecycle/stuck-policy.ts:70-122`) |
| Cancel grace after suspected_stuck | **5 min** | same |
| Kill grace after cancel_requested | **1 min** | `CANCEL_GRACE_MS` |
| Worst-case stuck-kill ladder | **16 min** (10+5+1); +10 min PID-reuse = **26 min** | same |
| Dispatch wait bound | 60 polls / **15 min** | `dispatch-loop.ts:205-206` (env-overridable) |
| Heartbeat (operator log) | **observability only** — nothing reads it for liveness | `node-worker-host-runtime.ts:78-93`; the lease is renewed by the supervisor, not by the worker |
| Configurability | none via env; `intervalMs`/`leaseTtlMs` are programmatic options only, and the sole production caller passes neither | `worker-supervision-service.ts:70-76`, `orchestrate-cli.ts:274-278` |

**The mechanical fact that reframes the brief's premise:** while the supervisor
is alive and the worker PID is alive-and-ours, the 5-minute lease is re-armed
every 30 s — a slow-but-live local worker is NOT lease-reaped. The lease only
expires when the supervisor stops renewing (host gone) or the PID is dead or
foreign. The BINDING constraints for a slow live local model are therefore:

1. the **10-minute progress silence** ladder (`progress_at` is written by the
   real runner from stream events — a model that is generating emits events and
   stays fresh; a model silent >10 min between events is escalated, and killed
   at ~16 min);
2. the **15-minute dispatch wait bound**;
3. an alive local row with an expired lease is TERMINATED, not released
   (stuck-policy step 6) — but that state requires renewal to have stopped.

## 2. Real durations (MEASURED from factory DBs — cloud models)

`.factory-sandboxes/opencode-val-db/factory.sqlite` (2026-08-18, glm-4.7/high, 22 executions):

- Completed (`exited`, exit 0) turn durations: **160–953 s**; **7 of 15 exceed
  the 300 s nominal lease TTL** — and none was reaped (renewal held).
- The recorded thrash incident on this DB was NOT lease expiry: task 5 burned
  **7 executions / ~111 minutes** through the lost-repair cycle with
  `last_error="Task 5 Claude process exited with code 0 before terminal worker_done"`
  — the exact F4/G2.2 failure mode, on the CLOUD model.
- Lease renewal cadence confirmed on live rows: `lease_expires_at − heartbeat_at`
  = exactly 5 min, re-armed per sweep.
- Rule-0 heartbeat obedience latency (from `worker-heartbeat.log`, 2.1 MB):
  ~20–21 s after STARTED.

`.factory-sandboxes/mars-venus-r9/factory.sqlite` (glm-5-turbo/high, 44 executions):
49–513 s, typical 60–300 s; 2 lost (re-ran successfully).

## 3. Local 27B model (ESTIMATES — nothing measured exists in the repo)

- No tokens/sec number exists anywhere in CLAUDE.md or the repo; no sandbox run
  ever used a local model (both sampled DBs ran zai cloud routes). The named
  canary model `qwen/qwen3.6-27b` is not even downloaded on this machine (see
  the G5 playbook).
- Input volume per full task (golden corpus, `accessible-counter`): documents
  63,414 bytes + products 83,020 bytes ≈ 36.7 K tokens (bytes/4 heuristic).
- Generation per task: ~3–8 K tokens (typical golden-run artifact sizes).
- Desktop 27B throughput assumption: ~10–25 tok/s generation; prefill
  ~100–2000 tok/s (batched). Then:
  - prefill of ~37 K tokens ≈ 20–370 s;
  - generation of 8 K tokens ≈ **320–800 s**;
  - multi-turn overhead (tool calls, retries) → total turn estimate
    **≈ 300–1200 s (5–20 min)**, i.e. 1–2× the slowest measured cloud turn.

## 4. The margin

The brief's nominal formula:

```
margin = lease_ttl − (expected_turn + reap_interval + safety_buffer)
       = 300 − (300…1200 + 30 + 30)  =  −60 … −960 s   → NEGATIVE
```

Per the brief's own criterion this reads: **"lease is tight for local models;
thrashing is likely before the worker completes."** — but that verdict applies
to the NOMINAL TTL only. Per the machinery (§1), a live, event-emitting local
worker under an alive supervisor does not lose its lease; the honest margin is
against the silence ladder:

```
silence_margin = STUCK_SILENCE_MS − worst_inter_event_gap
               = 600 s − (prefill 20–370 s)              = +230 … +580 s   → POSITIVE
dispatch_margin = WAIT_POLL_MAX_MS − worst_turn
               = 900 s − 1200 s (slowest estimate)        = −300 s         → TIGHT
```

The genuinely tight window is the **15-minute dispatch wait** against the
slowest estimated local turn (~20 min) — and the unknown is the real inter-event
gap, which no one has measured.

## 5. Recommendation (arithmetic only; the decision is the operator's)

1. **Do not touch the 5-minute lease TTL** — it is renewed, not binding for
   live workers, and it correctly orphans dead ones.
2. **Measure one real probe before the canary** (single `claude -p --model
   <local> "Say hello"`-class call, zero factory cost): record time-to-first-
   event and event cadence. If the cadence can exceed 10 min (huge prefill on a
   slow GPU), raise `STUCK_SILENCE_MS` (code change — no env knob exists
   today; `worker-supervision-service.ts` accepts options only programmatically).
   A 2× margin against a 10-min worst gap ⇒ silence threshold ≥ 20 min.
3. **Watch the 15-minute dispatch wait bound** for the slowest turns;
   `SAGA_WAIT_POLL_MAX_MS` IS env-overridable if the canary needs 30 min.
4. The 111-minute incident in the operator's own DB is the F4 exit-without-done
   mode (now mechanically negative-tested by G2.2/G2.3), not a TTL problem —
   fixing it is prompt-rule + obedience work, not lease work.
