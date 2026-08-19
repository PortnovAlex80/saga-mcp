# Agent brief — saga-mcp, stage 11: sealed material must not point at mutable rows

Continues `docs/handoff/STAGE-10-AGENT-BRIEF.md`. **All rules from stages 2–10
still apply.** Do not launch a factory run in this stage — the run already
happened and its evidence is what you work from.

Branch `saga4`.

---

## 0. What killed the run — established by the architect's own forensics

The stage-10 run reached `solution-formalization`, produced 9 artifacts and 11
accepted tasks across two workshops, and then died. It never reached
development.

```
factory_lifecycle_runs.status = failed
factory_lifecycle_runs.error  = REPLAY_CAPTURE_TRACE_NOT_FOUND: expected 12, resolved 6
completed_at                  = 2026-08-19 08:28:08
```

The forensic chain, from `.factory-sandboxes/stage10-db/factory.sqlite`:

| Time | Event |
|---|---|
| 07:33:46 | a worker adds 6 `derived_from` traces from artifact 9 → rows **11–16** |
| — | a WorkplaceProductionSnapshot is **sealed** holding those six `traceId` values |
| 07:54:05–07:55:08 | the worker calls `trace_delete` on all six — **rows 11–16 cease to exist** |
| 07:56:26 | the worker re-adds the same six links → new rows **17–22** |
| 08:28:08 | `record-final-acceptance` obligation claims; replay capture dereferences the sealed ids 11–16; six are gone; throws; the lifecycle run fails |

Proof the ids are truly gone: `artifact_traces` holds ids
`1..10, 17..22` — **11–16 are a hole** — while `sqlite_sequence` reads 22. Exactly
six missing, exactly matching `expected 12, resolved 6`.

The worker did nothing wrong. Revising a trace set is ordinary authoring.

## The defect class — this is what you are fixing

> **Sealed, immutable material holds pointers into a mutable table.**

`WorkplaceProductionSnapshot` records `trace.traceId` and
`artifact.artifactId` — SQLite AUTOINCREMENT rowids. The snapshot is sealed and
digest-verified; the rows it points at are not. Any later edit orphans the seal
permanently, and no amount of retrying can heal it.

CONVEYOR §9 requires the semantic replay key to exclude run-local identity. **A
rowid is run-local identity.** This is that invariant, violated in the one place
nothing checked.

**The same function already does it correctly for artifacts** and incorrectly for
traces. In `src/infrastructure/replay/sqlite-replay-capsule-repository.ts`
(~575–665): artifacts are converted to a content-addressed
`artifactSelector` (type / code / title / path / content_hash), while traces are
dereferenced by raw `WHERE id=?`. Two standards, forty lines apart.

**The content identity you need already exists.**
`factory_managed_trace_productions` carries a **`trace_hash`** column
(plus `source_id`, `target_type`, `target_id`, `link_type`) recorded at
production time. The capture reaches for `trace_id` while the hash sits in the
same row.

---

## TASK 1 — the regression test, first and failing

Before any fix. `tests/infrastructure/` is the right home.

Drive the exact sequence through the real seam — no hand-written rows:

1. a worker produces artifacts and traces;
2. the production snapshot is sealed;
3. the worker calls `trace_delete` on those traces;
4. the worker re-adds equivalent traces;
5. the replay capsule capture runs.

Assert it **succeeds**, resolving the traces by content rather than by rowid.
Watch it fail with the real `REPLAY_CAPTURE_TRACE_NOT_FOUND: expected N, resolved
M` first. If it passes before your fix, you have written the wrong test.

Add the artifact-side twin as a **pending or skipped** test naming the gap, per
task 3.

## TASK 2 — resolve traces by content identity

Make the capture resolve a sealed trace by its recorded content identity
(`trace_hash`, or the `(source, target_type, target_id, link_type)` tuple —
justify which and be consistent), falling back to nothing.

Two rules that decide the design:

- **A trace re-created with identical content is the same material.** The capsule
  must resolve it. That is the whole point.
- **A trace that genuinely no longer exists must still fail closed** — with a
  message naming *which* trace by content, not by a number that means nothing to
  a reader. Do not turn this into a silent skip: a capsule missing material is a
  real error, and §15 says it fails closed.

Preserve the existing digest/content-hash semantics exactly. If your change moves
a capsule's identity, replay compatibility moves with it — **report that rather
than absorbing it**.

## TASK 3 — the artifact side has the same exposure; measure it, do not fix it blind

`artifactId` is dereferenced the same way. Artifacts have no worker-callable
delete tool today (`trace_delete` is the only one that reaches material —
`note_delete`, `subtask_delete`, `template_delete`, `project_delete` do not), so
the hole is not currently reachable.

Establish and report: is there **any** path — tool, kernel handler, migration,
repair, operator route — that deletes or renumbers an `artifacts` row after a
snapshot is sealed? If yes, it is the same defect and it is live. If no, it is a
latent one.

Write what you find. **Do not extend the fix to artifacts on your own
initiative** — a content-addressed artifact resolution changes capsule identity
for every existing capsule, which is a replay-compatibility decision, not a
refactor.

## TASK 4 — one unresolvable capsule must not kill the factory

The failure took down the whole lifecycle run. Four cells had already been
accepted and settled; the fifth's capture threw, and everything stopped with one
obligation left `pending`
(`effects-settled:…:record-final-acceptance`), 29 others completed.

Establish, from the code and the journal, **why the throw was fatal rather than
scoped to that cell**: is it unhandled, is it inside a transition-obligation
claim with no repair path, does the progress classifier see it at all?

Report the mechanism. **Do not redesign error handling in this stage** — that is
a design decision, and one unresolvable capsule taking down a factory is exactly
the kind of thing that must be fixed deliberately, not opportunistically.

## TASK 5 — the journal cannot see failures

Your stage-10 journal recorded 241 events across 11 kinds:
`assignment.claimed`, `execution.reserved`, `worker.spawn`, `worker.exit`,
`worker.done`, `obligation.claimed`, `obligation.settled`, `gate.created`,
`gate.state`, `gate.check_receipt`, `gate.decision`.

**Not one of them is an error, exception, or failure.** The journal ends mid-air
at `08:28:08.012 obligation.claimed` and says nothing about the death that
followed 
— the entire diagnosis above came from the database, not from the observability
you built for exactly this purpose.

Add failure event kinds — at minimum a typed error event carrying the exception
name, message, and the correlation keys already in use — and a terminal event so
a reader can tell "the run ended" from "the journal stopped".

The observation-only constraint still holds: nothing may read the journal back.

---

## Verification baseline (paste real counts, never "green")

```bash
npm run build                                   # exit 0
node --test "tests/architecture/*.test.mjs"     # was 318 pass
node --test "tests/lifecycle/*.test.mjs"        # was 114 pass
node --test "tests/process-modules/*.test.mjs"  # was 1057 pass
node --test "tests/infrastructure/*.test.mjs"   # was 314 pass / 0 fail / 12 skip
node --test "tests/factory-e2e/w9-*.test.mjs"
node --test tests/factory-contract/golden-path.test.mjs
```

Replay suites must move only in the direction your fix intends. If a replay
identity test changes, that is task 2's reported consequence, not a fixture to
update quietly.

One commit per task. Push to `origin saga4`.

---

## Escalate, do not decide

1. **Whether `trace_delete` should exist as a worker tool at all.** A worker
   holding a tool that orphans sealed material is the same shape as the
   `worker_merge_*` grant closed in stage 8 — but the answer is not obviously
   "remove", because authoring genuinely needs revision. Architect's call.
2. **Extending content-addressed resolution to artifacts** (task 3) — replay
   compatibility.
3. **Any change to error handling scope** (task 4).
4. Any capsule identity change your fix causes.

## Report format

Task 1: the failing message you saw before the fix, verbatim.
Task 2: which identity you chose and why.
Task 3: the answer — reachable or latent — with the paths you checked.
Task 4: the mechanism, in one paragraph.
Task 5: the new event kinds, and the journal excerpt around a deliberately
induced failure proving they fire.
