# Agent brief — saga-mcp, stage 12 (night shift): the verifier stops taking criteria from the verified

Continues `docs/factory-run/stage11/ARCHITECT-HANDOVER-DRAFT.md`. **All rules
from stages 2–11 still apply.** **Do not launch a factory run in this stage.**

Branch `saga4`.

---

## 0. The architect's verdict — read this before the tasks

The run completed. That is real and it is the first time. But the terminal label
`runnable-local` is false, and the three headline failures are **one principle
violated three times**:

> **The verifier took its criteria from the verified.**

| Where | The subject describes itself | The factory believed it |
|---|---|---|
| G3 (stages 7–8) | worker writes `integration_state='merged'` | a receipt over a merge that never happened |
| Certification | candidate writes its own `testCommand` | gate ran the declaration, exit 0, accepted |
| AC drift | author restates the order in his own words | docker / TypeScript / Chrome client vanish, no gate notices |

CONVEYOR guards **who decides** — "worker_done is not acceptance", "only a
GateDecision accepts". It never guarded **what the decision is measured
against**. That is the hole, and it is why the same defect keeps arriving in a
new costume.

The invariant this stage installs:

> **Acceptance criteria are derived from the order. Never from the candidate.**

Everything below serves that one sentence. If a task ever seems to conflict with
it, the task is wrong.

### Ratified decisions (do not re-open)

- **E1 — `trace_delete` stays.** Identical-content re-adds now resolve; genuine
  deletes fail closed by content name. Unlike `worker_merge_*`, there is no
  factory-owned alternative — authoring genuinely needs revision.
- **E3 — error boundary is cell-scoped.** Three cell-scoped paths were bypassed;
  that is a defect, not a design choice.
- **E7 / E8 — ratified**, in the rollout order their own design documents give.
- **E4 — closed, no action.**
- **E2 — approved in principle, but NOT in this stage** (see task 5).
- **E6 / E9 — deferred by the architect.** Do not start recycle-run design.

---

## TASK 1 — merge the ready trees, in this order

Thirteen trees are held. Merge in the order below, `npm run build` plus the
architecture suite after **each** merge, full regression once at the end.

**Wave A — infrastructure, lowest risk:**
1. `es1-loop-detector`
2. `provider-retry`
3. `repair/worker-names`
4. `repair/worker-disorientation`

**Wave B — blindsight repairs:**
5. `repair/blindsight-worker-prompt`
6. `repair/blindsight-gate-delivery`
7. `repair/blindsight-lifecycle`
8. `repair/blindsight-persistence`
9. `repair/blindsight-phantom-bridges`
10. `repair/blindsight-integration-verify`
11. `repair/blindsight-reconciliation`

**Wave C — the load-bearing one, last and alone:**
12. `repair/ac-drift-remedy`

**Hold, do not merge:** `snapshot-test-mvp` — see task 4.

If any merge goes red, **stop the wave**. Report which merge, the failure, and
whether it is the merge's own defect or an interaction. Do not repair forward
through a red tree; a green sequence you cannot explain is worse than a stopped
one.

`repair/blindsight-persistence` carries schema 99→100. It must be the only
schema move in this stage.

## TASK 2 — the anti-gaming core (the most important work of the night)

`docs/architecture/CERTIFICATION-GAMING-REMEDY.md` is ratified. Implement its
rollout order exactly — it is incremental on purpose, and each step is
independently useful if you run out of night:

1. **Additive coverage report** — the certification result records which tests
   the canonical set contains and which the declaration ran. Report only, no
   enforcement. This alone would have made the gaming visible.
2. **Monotonicity ratchet + declaration-diff escalation** — a candidate's
   declared verification surface may never shrink relative to the previous
   accepted revision. A shrink is not a failure; it is an **escalation** with the
   diff named.
3. **sourceCandidate-keyed receipt invariant** — a check receipt is bound to the
   candidate it was produced against; a receipt cannot travel to a different
   candidate.
4. **Derived-canonical `testCommand`** — the core. The command executed comes
   from the order-derived canonical set. The candidate's manifest becomes
   **additive only**: it may add checks, never remove or replace them.

Steps 1–3 are safe tonight. **Step 4 changes what "certified" means** — land it
behind the report from step 1 so the first run with it shows the delta, and say
plainly in the report if you did not reach it.

**The negative test that defines done:** replay the actual gaming — a manifest
whose `testCommand` enumerates 7 of 9 test files, excluding exactly
`tests/renderer.test.js` and `tests/websocket-server.test.js`, with zero code
change. The certification must not pass. Use the RED fixture already in the
golden corpus; it exists for this.

## TASK 3 — code hygiene, bounded

The architect's instruction: the codebase must not accumulate the noodle that a
nine-hour incident wave leaves behind. **Bounded, mechanical, no redesign:**

- delete every debug/scratch artefact the repair wave left (`_ke.ps1`,
  `_rec.ps1`, `_eng-stop.ps1`, `_kill-frozen.ps1` at the repo root and their
  siblings) — or, if any is genuinely operational, move it under `tools/` with a
  one-line header saying what it is for. A script nobody can name the purpose of
  is dead;
- reconcile `docs/factory-run/stage11/` — it accumulated many overlapping
  reports. One index naming which document is current and which is superseded.
  **Delete nothing**; the record of how this was found is worth keeping;
- any function the repair wave left above ~150 lines *that you touched*: name it
  in the report. Do not refactor it. Naming it is the deliverable.

**Do not "tidy" code you did not otherwise touch.** Opportunistic cleanup inside
a merge wave is how a regression hides.

## TASK 4 — make the snapshot re-run real

`snapshot-test-mvp` is held deliberately: a zero-token deterministic re-run of
the captured corpus is the single highest-leverage asset this project now owns,
and it must not land as a half-thing.

Before merging it, establish and report:
- does it replay the **captured** corpus, or a synthesised one?
- does it exercise gates and effects, or only the worker seam?
- would it have caught the certification gaming? Would it have caught AC drift?

If the answer to the last question is no for both, say so. That is not a failure
of the tool — it tells the architect what the tool is for.

## TASK 5 — E2 groundwork only (do not implement)

Content-addressed artifact resolution is approved in principle and **not for
tonight**: it changes capsule identity for every existing capsule, which needs an
explicit invalidation act, not a merge in a wave.

Produce the migration note: which capsules change identity, what the
invalidation ceremony is, and what breaks if it is done without one. One page.

---

## Verification baseline (paste real counts, never "green")

```bash
npm run build                                   # exit 0
node --test "tests/architecture/*.test.mjs"     # was 318 pass (345 on the ac-drift tree)
node --test "tests/lifecycle/*.test.mjs"        # was 114 pass
node --test "tests/process-modules/*.test.mjs"  # was 1057 pass (521 on the tree — reconcile)
node --test "tests/infrastructure/*.test.mjs"   # was 314 pass / 0 fail / 12 skip
node --test "tests/factory-e2e/w9-*.test.mjs"
node --test tests/factory-contract/golden-path.test.mjs
```

The tree reports quote different baselines than saga4 head. **Reconcile the
numbers and say which is which** — a count you cannot attribute to a base is not
evidence.

One commit per merge; one commit per anti-gaming step. Push to `origin saga4`.

---

## Escalate, do not decide

1. **Any tree that goes red on merge** — stop the wave, report.
2. **Anything touching the reserved principles**: LR-04 declaration authority,
   the verification warrant, profile monotonicity semantics. You implement what
   the ratified designs specify; you do not extend them.
3. **Step 4 of task 2** if the derived-canonical set turns out to be
   underspecified for a real order — that is a design gap, and inventing the
   derivation rule is the architect's act.
4. **Any second schema migration.**
5. **Starting a factory run**, for any reason.

## Report format

Task 1: the merge order as executed, counts after each, and any wave you stopped.
Task 2: which of the four steps landed, and the gaming replay's verbatim result.
Task 3: what you deleted, what you moved, and the list of oversized functions you
touched.
Task 4: the three answers, plainly.
Task 5: the migration note.

State what you did not finish. The night is finite and an honest stop is worth
more than a wave you pushed through red.

---

## TASK 6 — OPERATOR OVERRIDE (2026-08-20 ~00:30, night shift): a real run on GLM-4.6, then conditionally recycle

The header of this brief says "Do not launch a factory run in this stage", and
escalation item 5 forbids starting one. **The operator overrides both for
tonight** (same override pattern as stage-11 TASK 6). The conditions below are
binding; outside them the original prohibitions stand.

### Standing directives issued with the override

1. **OPENCODE ONLY.** Every worker runs through the agent-proxy shim
   (`tools/agent-proxy/claude-shim.mjs`, provider `zai-coding-plan`). The
   claude CLI is retired; `SAGA_REAL_CLAUDE_PATH` is always set to the shim.
   See AGENTS.md.
2. **`~/.claude/settings.json` is never touched** by us — not rewritten, not
   restored, not re-pinned. Its sha256 is a tripwire only: any change during
   the run is an ABORT condition — investigate, never edit it back. Baseline
   recorded at launch in the night tracker (note: at override time it hashed
   `1d0aac5e…`, not the stage-11 baseline `e03e7bbc…` — post-run state, not a
   factory touch; the tripwire anchors to the launch-time value).
3. **English only.** The operator sleeps through the night. All reasoning,
   reports, commit messages, tracker entries and agent briefs are in English.
4. **Self-tracking.** The night's authoritative state is
   `docs/factory-run/stage12/NIGHT-TRACKER.md`. Any agent — including a fresh
   session after context compression — reads it FIRST and updates it as
   phases complete.

### Order of operations

The run launches ONLY after TASK 1 (all merge waves) and TASK 2 (anti-gaming
steps 1–3; step 4 if reached) are green, plus `npm run build` on the final
HEAD. Never launch from a dirty tree. Launch parameters:

- fresh dirs: DB `.factory-sandboxes/stage12-db/factory.sqlite` (outside the
  sandbox root), sandbox `.factory-sandboxes/stage12`, logs
  `.factory-sandboxes/stage12-logs`;
- `--model glm-4.6` (checked-in catalog: limit 2, effort high —
  `src/runtime/factory-model-profiles.ts`; shim map verified);
- `SAGA_FACTORY_CONCURRENCY=2`;
- guard env: `SAGA_REAL_CLAUDE_PATH` → shim,
  `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1`, `SAGA_RUN_JOURNAL` +
  `SAGA_ORCHESTRATION_LOG` pinned to the run dirs;
- order text: the same docking slice as stage-10/11
  (`docs/factory-run/stage10/ORDER.md`) — comparability is the point;
- pre-flight pasted into the tracker before `factory.mjs start`: build exit 0,
  `dist` mtime, HEAD SHA, clean tree, settings sha256 baseline.

Monitoring (the operator's protocol): poll status; ABORT on — lifecycle
terminal failed; the same refusal reason 3+ times on one node; no progress
from an active worker >20 min with a live process; settings.json sha256 drift
from the launch baseline. On abort: `node tools/capture-run-snapshot.mjs
--db .factory-sandboxes/stage12-db/factory.sqlite --out
factory-snapshots/stage12-<reason>` + a detailed English report in the
tracker. Never repair mid-run, never touch processes beyond documented
recovery, never edit the DB by hand.

**Success definition for tonight (all three, else it is not "successful"):**
1. `lifecycle_run.status=completed`, terminal `runnable-local`;
2. certification honest: the step-1 coverage report shows the canonical set
   fully run (no unexplained shrink), and the gaming replay stays RED;
3. one-command product check: a subagent runs the product, fixes nothing,
   reports verbatim what happens.

### Conditional phase — the recycle (E9)

**Only if the run is successful within the night.** Then: implement the
recycle per `docs/architecture/RECYCLE-RUN-DESIGN.md` (front-door
change-request hook, ChangeRequestAppendix, capsule MISS/HIT, SVN-style
`factory_product_revisions`), one commit per mechanism, build + architecture
suite green, and launch the recycle run against the fresh product's findings.
The E9 reserve (`docs/architecture/E9-RESERVE.md`) is protected: named
reserve code escalates, never deletes.

If the night runs out before the recycle lands, STOP — record the durable
handoff state in the tracker. An honest stop beats a pushed-through wave.
