# ADR-012: Multi-track pipeline

## Status

Accepted (2026-07-18)

> **Note (2026-07-20, ADR-014):** The `go` track's formalization sequence has
> been reshaped. After ADR-014, formalization splits into Part 1
> (`PRD(+FR/NFR/RULE) → UC → AC → Reconcile`) and Part 2 (`SRS(+§D DECOMP)`
> written AFTER AC). The `track` column, the 4-way switch on `decision`, and
> the `fast-track` / `clarify` / `reject` branches of this ADR are unchanged.
> See [014-pipeline-reorder-srs-after-ac.md](014-pipeline-reorder-srs-after-ac.md)
> for the updated formalization order inside the `go` track.

## Context

Saga-mcp's discovery phase ends with a brief artifact carrying one of four
`decision` values: `go`, `fast-track`, `clarify`, `reject`
(`src/validators/brief.ts:44`). Each decision implies a different downstream
route through the pipeline:

| Decision | Expected route |
|---|---|
| `go` | discovery → formalization → planning → development → verification → integration → completed |
| `fast-track` | discovery → development → verification → integration → completed (skips formalization+planning; ACs created directly by `routeFastTrack`) |
| `clarify` | halt with `needs-human`; do not transition out of discovery |
| `reject` | `episode_transition(cancelled)` |

Until this ADR only **one** of these routes actually worked. `workflow.ts` had
a single decision guard at line 119:

```ts
if (decision !== 'go') {
  return [];  // ← all three non-go decisions collapsed to the same no-op
}
```

The engine then saw `created:0`, fell through to `tryAdvanceStage`, transitioned
`discovery → formalization`, and hit a gate failure because no formalization
tasks existed. Recovery (#759 on epic 127, Water-connon) created ACs by hand
and the episode eventually moved on — but only because a recovery rule
matched the symptom, not because the decision was honoured.

The `routeFastTrack` function (`src/planner/fast-track.ts:109`) was fully
implemented and unit-tested in isolation (`tests/fast-track/fast-track.test.mjs`)
but never invoked from the production path. The comment at `workflow.ts:121`
("routeFastTrack handles fast-track") was an unfulfilled promise.

This is a Complicated decision under the Cynefin triage: the fix touches
schema, workflow generation, the engine's main loop, and tests — but the
failure modes are reproducible and the design space is well-bounded.

## Decision drivers

- Each of the four decisions must reach its intended terminal state.
- The `track` of an episode must be observable after the fact (for queries,
  UI, audits) — not just an inferred side-effect of the brief artifact.
- Recovery must not be the primary mechanism for routing — it is a fallback.
- Tests must cover all four tracks deterministically and quickly (mock-claude).
- No regression to the working `go` path (covered by `product-workflow.test.mjs`
  and `e2e-pipeline.test.mjs`).

## Considered options

### A. Call `routeFastTrack` from `workflow.ts` only

Add one branch in `brief_accepted` for `fast-track` that calls
`routeFastTrack`. Leave `clarify` and `reject` as `return []`.

- Pro: smallest delta; unblocks the most visible failure (epic 127).
- Con: `clarify` and `reject` still silently fall through to formalization
  and trigger recovery. Half-measure; same architecture, more patches.

### B. Four-way switch in `workflow.ts` + engine control flow

Replace the `decision !== 'go'` guard with a `switch (decision)`. The four
branches each take their own action:
- `go` — return the formalization.prd spec (current code).
- `fast-track` — call `routeFastTrack`, mark `track='fast-track'`, return `[]`.
- `clarify` — return `[]`; engine handles the pause.
- `reject` — return `[]`; engine handles the cancel.

Engine's main loop grows a brief-decision inspection step between
`generateNextIfReady` and `tryAdvanceStage`. When `created:0` and stage is
still `discovery`, the engine reads the latest brief decision and either
fast-track-continues, pause-and-alerts, or transitions to cancelled.

- Pro: each decision is explicit and testable; engine keeps its tool-purity
  invariant (workflow.ts stays a pure DB op, control flow stays in the loop).
- Con: two files must agree on the decision enum.

### C. Track as a separate stage machine

Generalise `NEXT_STAGE` into a per-track stage graph, gate assertions per
track, etc. A bigger redesign that subsumes B.

- Pro: maximally clean; fast-track becomes a first-class stage machine.
- Con: high implementation risk, and `routeFastTrack` already does a SQL
  jump to `stage='development'` so the engine's `NEXT_STAGE` does not need
  to know about fast-track for the rest of the pipeline. The clean target
  adds little real value over B.

## MCDA

Scores 1–5; weighted totals out of 500.

| Criterion | Weight | A: routeFastTrack only | B: switch + engine flow | C: per-track stage machine |
|---|---:|---:|---:|---:|
| Correctness (all 4 decisions) | 30 | 2 | 5 | 5 |
| Observability (track column) | 20 | 1 | 5 | 5 |
| Implementation risk | 20 | 5 | 4 | 2 |
| Testability | 15 | 3 | 5 | 4 |
| Reversibility | 15 | 5 | 5 | 3 |
| **Weighted total** | **100** | **300** | **465** | **390** |

## Red Team

The strongest objection to option B: "introducing a `track` column and a
switch is more moving parts than calling `routeFastTrack` directly". The
objection is partially accepted — for `fast-track` alone, option A would
suffice. But `clarify` and `reject` also need explicit handling; without a
central place for the engine to inspect the decision, they would have to
be encoded as silent side-effects inside a tool handler, breaking the
"tools are pure DB ops" invariant. The switch + engine-flow split keeps
side-effect-free handlers and a single decision point in the loop.

A second objection: "what if `routeFastTrack` is later removed or refactored?"
Mitigation: the `brief_accepted` branch imports it explicitly; removing it
becomes a compile error.

## Decision

Adopt option B.

1. **`episode_workflows.track TEXT NOT NULL DEFAULT 'formal' CHECK (track IN ('formal','fast-track'))`**
   — added by `migrateEpisodeTrack` in `src/db.ts`. Idempotent. Backfills
   `'fast-track'` from the legacy `metadata.fast_track=1` flag written by
   `routeFastTrack`.

2. **`workflow.ts:brief_accepted`** becomes a 4-way switch on `decision`:
   - `go` returns the formalization.prd spec (unchanged).
   - `fast-track` calls `routeFastTrack`, marks `track='fast-track'`, returns `[]`.
   - `clarify` returns `[]` (engine handles pause).
   - `reject` returns `[]` (engine handles cancel).

3. **`orchestrate.ts` main loop** gains a brief-decision inspection step
   between `generateNextIfReady` and `tryAdvanceStage`, scoped to
   `stage === 'discovery'`:
   - `fast-track` → continue (routeFastTrack already wrote `stage='development'`).
   - `clarify` → `pauseAndAlert` + `waitForResume`.
   - `reject` → `episode_transition({ to_stage: 'cancelled' })`.
   - `go` or undefined → fall through to `tryAdvanceStage`.

4. **`NEXT_STAGE` is unchanged.** `routeFastTrack` writes `stage='development'`
   directly via SQL, bypassing `episode_transition`. The remainder of the
   pipeline (`development → verification → integration → completed`) is
   identical for both tracks.

5. **`lifecycle.ts:NEXT` is unchanged.** It only enforces the linear order
   for non-`cancelled` transitions, and `cancelled` is already a bypass.

## Pre-mortem

1. **`routeFastTrack` throws on an ineligible brief.** A fast-track brief
   that fails `canFastTrack` would surface as a `created:0` from
   `generateNextIfReady`, then the engine would read decision='fast-track'
   and continue, but `stage` would not have advanced. Mitigation: the
   engine's fast-track branch logs `FAST_TRACK` but does not assert
   advancement; the next cycle re-enters the same code and eventually
   times out via `MAX_EMPTY_CYCLES`. A future iteration could fall back to
   `pauseAndAlert` here.

2. **`clarify` waits 24h before timeout.** The pause is cooperative; in
   production the user clears `needs-human` via the resume endpoint.
   Tests use `sleep: (ms) => Promise.resolve()` to short-circuit the poll
   loop, but `MAX_PAUSE_MIN` is hard-coded. Mitigation for tests: rely on
   wall-clock timeout + DB state assertions; production is fine.

3. **The engine inspects the latest brief unconditionally.** If a brief is
   re-registered after the episode has advanced (rare), the decision branch
   could fire again. Mitigation: the `if (stage === 'discovery')` guard
   restricts the inspection to the discovery stage only.

4. **An episode can be cancelled from any stage.** `episode_transition`
   already permits `to_stage='cancelled'` from any current stage. The
   engine's reject path calls it only from discovery, but manual calls
   remain possible.

5. **Mock-claude's kickstart branch always emits a brief.** A real
   kickstart worker may emit nothing (e.g. on internal failure). The mock
   does not cover that path — it always registers a brief and always
   worker_dones the task. Future fixtures should simulate kickstart failure.

## Consequences

Positive:

- all four discovery decisions reach their intended state deterministically;
- `episode_workflows.track` makes the routing observable and queryable;
- mock-claude's `SAGA_MOCK_DECISION` env var lets each track be tested in
  seconds rather than the ~30 minutes a real claude cycle would take;
- the working `go` path is untouched and still covered by `e2e-pipeline.test.mjs`.

Negative:

- two files (`workflow.ts`, `orchestrate.ts`) must agree on the decision enum;
- `clarify` test is slow (10s wall-clock cap on the engine's `waitForResume`);
- mock-claude's kickstart branch is fixture-driven by env var; failure-mode
  fixtures (changes_requested, kickstart crash) remain on the roadmap.

## Rollback

Revert the commit. The `track` column is additive and can remain unused.
Do not drop the column — existing rows are valid under either schema.

## Verification

- `npm test`: 174/174 pass (170 existing + 4 new track tests).
- `tests/track-pipeline.test.mjs` covers all four decisions end-to-end
  via mock-claude + the real `orchestrate()` engine:
  - `track(go)` asserts formalization.prd task exists + episode advanced.
  - `track(fast-track)` asserts `track='fast-track'`, no formalization tasks,
    a `[fast-track]`-titled dev task exists.
  - `track(clarify)` asserts `needs-human=true`, stage remains `discovery`.
  - `track(reject)` asserts `stage='cancelled'`, engine returns `reason='completed'`.
