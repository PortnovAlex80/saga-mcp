# Agent brief — saga-mcp, stage 13: two factory obligations must be jointly satisfiable

Continues `docs/factory-run/stage12/ARCHITECT-NIGHT-REPORT.md`. **All rules from
stages 2–12 still apply.** **Do not launch a new factory run.** The stage-12 run
may continue to its own terminal — see §0.3.

Branch `saga4`.

---

## 0. The architect's verdict — verified from the three run databases directly

### 0.1 What the night proved (this is the good news, and it is real)

The GDesign run reached `terminal_status = failed` **honestly**: 30/30 cards done
across all three workshops, then `factory.local-runnability.v1` executed
`python -m pytest tests/` in a sterile `python:3.13` container and found
`ModuleNotFoundError: No module named 'yaml'` — 126 tests collected, 2 collection
errors, caused by a genuinely undeclared `pyyaml` dependency.

Compare stage 11, which labelled a 0%-runnable artefact `runnable-local`.

**That is the first time this factory told the truth about its own output.** The
sterile canonical environment revealed what the worker's polluted environment
hid. The anti-gaming work worked.

### 0.2 The new defect class — and it is the child of our own fix

The stage-12 run is deadlocked. Verified in
`.factory-sandboxes/stage12-db/factory.sqlite`: workplace revision **106**, **6
recovery epochs**, 7 review rounds, lifecycle paused at `implement-work-items`.

Two factory authorities give contradictory orders:

```
review-verdict.v1        → failed
  "CRITICAL: AC-14 violation — implementation provides only backend service,
   but AC-14 requires all required services (backend, frontend) …
   AC-16 requires the simulation displayed … no HTML page, no visualization."

implementation-scope.v1  → failed
  "path-outside-authority: Git paths [frontend/index.html, src/index.ts] are
   outside frozen changeScopes [.gitignore, Dockerfile, docker-compose.yml,
   package.json, src/modules/startup-runtime/, tests/, tsconfig.json]"
```

**`frontend/` is not in the scope. The AC requires a frontend.** The worker is
ordered to build one and forbidden from writing the files it consists of. Every
possible action is rejected. The worker is blameless.

The principle:

> **The factory issues obligations from two authorities and never checks that
> they are jointly satisfiable.**

This is the *inverse* of stage 12's invariant. That one said criteria must not
come from the candidate. This one says: **when the factory issues both the
criteria and the permissions, it owns the contradiction between them.**

And note the causality — **this deadlock is our AC-drift fix succeeding.** The
ACs now carry the order's docker/frontend/Chrome requirements; that was the
stage-11 repair. What the fix exposed is the next link: the carve is not obliged
to cover the ACs it is carving for. The planner's rule was "one item per AC"; it
creates a card per AC and derives the card's scope from somewhere else, and
nothing compares the two.

The invariant this stage installs:

> **A card whose acceptance criteria cannot be satisfied inside its own frozen
> scope is malformed. Reject it at carve time — not after seven review rounds.**

### 0.3 Decision on the live run

**Let it reach its own terminal.** Evidence is captured, cost is tokens only, and
F6 (merged last night) has no other live test. "Does the factory reach an honest
terminal by itself, without a human?" is the final goal restated. Killing it by
hand destroys the only answer we will get.

If it is still looping when you start, leave it. Record its terminal when it
comes.

---

## TASK 1 — the joint-satisfiability check at carve time

The deliverable of this stage. Everything else is smaller.

**RED first.** Reproduce the deadlock as a test: an AC requiring a path outside
the card's `changeScopes`. Watch it produce the same
`path-outside-authority` / review-`failed` pair. Only then fix.

The check: when the task graph is frozen, every card's acceptance criteria must
be satisfiable within that card's declared `changeScopes`. A card that fails this
is rejected at carve time with a typed diagnostic naming **which AC** and **which
path class** it needs that the scope does not grant.

Design constraints, and they decide whether this works:

- **Derive the required paths from the AC, do not ask the worker.** Anything
  else re-opens stage 12's invariant one level up.
- **Uncertainty must widen the scope, not narrow it.** If the required path set
  cannot be determined exactly, the honest response is a scope that covers the
  uncertainty, or a rejection — never a narrower guess. A too-narrow scope is
  exactly the failure being fixed.
- **The diagnostic must be actionable by the planner**, i.e. it names what to
  re-carve, not merely that something is wrong.

If deriving required paths from an AC turns out to be undecidable in general —
that is a real finding. Say so, and deliver the weaker check that is decidable
(for example: the union of all cards' scopes must cover every path class any AC
mentions). **A weaker check that holds beats a stronger one that guesses.**

## TASK 2 — reconnect the re-plan carve to the dispatcher

The escape hatch already exists: the factory created a new workplace with
recomputed scopes and **the dispatcher never picked it up** — reported idle at
revision 0.

A designed remedy that is not wired is worse than no remedy: it makes the system
look recoverable when it is not. Find why the dispatcher does not claim it, fix
the connection, and prove it with a test that drives the full path — deadlock
detected → re-plan carve → dispatcher claims → work proceeds.

If the re-plan carve would still produce the same insufficient scope, **say so** —
then task 1 is its precondition and this task is blocked on it. That is a
legitimate outcome; report it rather than forcing a green.

## TASK 3 — `installCommand` is `testCommand`'s unguarded twin

The GDesign failure was a real product defect, correctly caught. But the
mechanism that let it exist is stage 12's invariant one line higher: **the
candidate declares its own environment.**

We fixed *what* the candidate runs. We did not fix *what it runs in*.

Apply the same additive-canonical treatment to the environment declaration: the
declared install must be **sufficient for the canonical check set**, and a
shortfall is reported with the missing package named. Follow the rollout
discipline that worked: **report-only first**, enforcement after.

The long-term owner is **K19 — Readiness and Toolchain Package Identity**, whose
objective is literally binding environment preparation and post-integration
certification to one immutable runtime package model. This task is the cheap
interim, not a substitute. Say in your report which parts K19 must still do.

## TASK 4 — finish what stage 12 left

- **`repair/blindsight-reconciliation` is not merged.** Twelve of thirteen trees
  landed; this one did not, and the stage-12 report presents task 1 as complete.
  Either merge it under the wave-B discipline (build + architecture suite after)
  or state plainly why it must not land.
- **`repair/snapshot-test-mvp`** — still held pending the three answers from
  stage 12 task 4. If those answers are now in, report them and recommend.

## TASK 5 — put both invariants in the mental model

`docs/architecture/CONVEYOR-MENTAL-MODEL.md` is the arbiter, and it is missing
the two rules that this month's failures were all instances of. Add them as
numbered invariants, in the document's own voice, each with the concrete failure
that produced it:

1. **Acceptance criteria are derived from the order, never from the candidate.**
   (worker-attested `integration_state`; candidate-declared `testCommand`;
   candidate-declared install environment.)
2. **Obligations the factory issues from different authorities must be jointly
   satisfiable, and the factory owns proving it before hiring a worker.**
   (AC requiring `frontend/` against a `changeScope` forbidding it.)

Write them so a reader who never saw these runs can apply them. An invariant that
only makes sense to someone who was there is a diary entry, not a rule.

---

## Verification baseline (paste real counts, never "green")

```bash
npm run build
node --test "tests/architecture/*.test.mjs"
node --test "tests/lifecycle/*.test.mjs"
node --test "tests/process-modules/*.test.mjs"
node --test "tests/infrastructure/*.test.mjs"
node --test "tests/factory-e2e/w9-*.test.mjs"
node --test tests/factory-contract/golden-path.test.mjs
```

Quote the base you measured against. The stage-12 report and the tree reports
quote different baselines; a count you cannot attribute to a base is not
evidence.

One commit per task. Push to `origin saga4`.

---

## Escalate, do not decide

1. **If AC→path derivation is undecidable** — deliver the weaker decidable check
   and escalate the design question.
2. **Any change to changeScope freezing semantics.** Scope is material authority;
   widening it at the wrong moment reopens the scope fence entirely.
3. **Enforcement (not report) on the install declaration** — that changes what
   "certified" means, same as `testCommand` step 4.
4. **Starting a new factory run.**

## Report format

Task 1: the RED reproduction verbatim, the check you built, and — if you fell
back — which weaker check and why.
Task 2: why the dispatcher ignored the re-plan carve, and whether task 1 blocks
it.
Task 3: the shortfall report format, and what you are leaving to K19.
Task 4: merged or refused, with the reason.
Task 5: the two invariants as written.

Plus: the stage-12 run's terminal, if it reached one while you worked.

State what you did not finish.
