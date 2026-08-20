# Agent brief — saga-mcp, stage 13: a frozen prediction is not an authority

Continues `docs/factory-run/stage12/ARCHITECT-NIGHT-REPORT.md`. **All rules from
stages 2–12 still apply.** **Do not launch a new factory run.** The stage-12 run
may continue to its own terminal — see §0.4.

Branch `saga4`.

---

## 0. The architect's verdict

### 0.1 What the night proved

The GDesign run reached `terminal_status = failed` **honestly**: 30/30 cards
across three workshops, then `factory.local-runnability.v1` ran the checks in a
sterile container and found a genuinely undeclared dependency. Compare stage 11,
which labelled a 0%-runnable artefact `runnable-local`.

**That is the first truthful verdict this factory has produced.** Keep it. Every
task below must leave that property intact.

### 0.2 The unifying defect — read this twice

Three failures this month look different and are one thing:

| What is frozen | Whose prediction | Made when |
|---|---|---|
| `changeScopes` | the planner: which files the work will touch | **before** the code is written |
| install declaration | the candidate: which packages the code needs | **before** the sterile run |
| `testCommand` | the candidate: which checks matter | **before** the check |

All three are **guesses made ahead of the fact, frozen, then enforced as
authority**. All three failures are the same sentence: the guess was wrong, and
the fence made correcting it impossible.

> **A frozen prediction is not an authority. Either derive it from fact, or make
> revising it a first-class transition.**

The factory currently does neither. There is no third option, and "predict
better" is not one — a better guess is still a guess, and the failure mode is
unchanged.

### 0.3 What this means for the scope fence specifically

Do not read the stage-12 deadlock as "the carve forgot a directory". The next
order will need something else entirely, and a fix shaped around what *this* run
needed is worthless.

The structural facts, in domain-free terms:

1. **Which paths implementing an acceptance criterion requires is not knowable
   before the implementation exists.** The planner is *obliged* to guess. A
   "joint satisfiability check" only checks the guess; it does not remove the
   guessing, so it does not remove the failure.

2. **The fence's real purpose is isolation between concurrent cards, not a
   completeness contract for one card.** "Is this path claimed by another live
   card?" is decidable. "Does this criterion require this path?" is not. Today
   the fence answers the second question and therefore breaks.

3. **Scope insufficiency is normal, not exceptional.** Honest work against an
   estimate discovers the estimate was short. Today that normal event is modelled
   as a check failure plus a recovery epoch — a category error that converts
   ordinary progress into a livelock.

The re-plan carve is the half-built correct answer: the instinct was right, it
was filed under *recovery* instead of *normal operation*, and it was never wired.

The invariants this stage installs:

> **Scope insufficiency is a lawful outcome of a cell, not a defect of its
> worker.**
>
> **A scope fence decides contention, never necessity.**

### 0.4 Decision on the live stage-12 run

**Let it reach its own terminal.** Evidence is captured, cost is tokens only, and
F6 has no other live test. "Does the factory terminate honestly without a human?"
is the final goal restated; killing it by hand destroys the only answer.

---

## TASK 1 — make scope insufficiency a lawful transition

The deliverable of this stage.

**RED first.** Reproduce the deadlock structurally, **without naming any concrete
path from the stage-12 run**: a cell whose acceptance criteria require writing
outside its frozen scope. The fixture must be domain-free — a fix that only works
for the paths this run needed is not a fix. Watch it livelock through epochs,
then fix.

Design what you build against these constraints:

- **A cell must be able to report "my scope is insufficient" as a typed,
  successful conclusion of an attempt** — not as a failed check, not as a
  recovery trigger. It names what it needs in terms the carve authority can act
  on.
- **The request goes to the authority that issued the carve**, never to the
  worker's own discretion. The worker states the need; it does not grant it.
- **The grant is decided on contention, not on necessity.** Granted when no other
  live cell holds the claim; refused with a named holder when one does. The
  authority must never be asked to judge whether the work "really needs" the
  path — that judgment is not available to it and pretending otherwise
  reintroduces the guess.
- **A grant re-freezes a wider scope as a new revision**, with the same
  monotonic/append-only discipline the rest of material authority already has. A
  widened scope is new authority, not a mutation of old authority.
- **Refusal must be terminal and honest**, carrying the contending holder. A cell
  that genuinely cannot proceed must fail closed with a reason a human can act
  on — not loop.

This is a conveyor-grammar change: a new lawful cell outcome and the transition
it routes to. Treat it as such — it belongs in the flow vocabulary, not as a
special case inside one check provider.

**If you conclude the contention model cannot express something real** (for
example two cells that legitimately must write the same path in sequence),
**escalate with the case.** That is a design question, not something to work
around.

## TASK 2 — wire the re-plan carve

The escape hatch exists and the dispatcher never claims it — reported idle at
revision 0. A designed remedy that is not wired is worse than none: it makes the
system look recoverable when it is not.

Establish why the dispatcher does not claim it, fix the connection, and prove the
whole path end to end: insufficiency declared → carve authority re-carves →
dispatcher claims → work proceeds.

Task 1 may subsume this: if scope widening becomes a lawful transition, re-plan
carve may be the mechanism that serves it rather than a parallel recovery path.
**Report which it is.** Two mechanisms for one event is the shape §27 forbids —
if you end with both, say so and stop.

## TASK 3 — environment identity, derived (this is K19, not a patch)

**No interim.** The architect's instruction is explicit: the environment
declaration is the same frozen prediction as the scope fence, and patching it
with a "sufficiency report" would install exactly the pattern this stage exists
to remove.

Do the principled thing: **the environment in which a candidate is certified must
be one immutable identity, derived from the artefact itself, shared by
preparation and certification.** The candidate's declaration becomes additive —
it may add to the derived environment, never define it.

This is K19 — *Readiness and Toolchain Package Identity*, objective verbatim:
"bind execution environment preparation and post-integration certification to the
same immutable runtime package model" (`docs/vision/SAGA-CORE-RENEWAL-PLAN.md`
§K19). Read the card; it is the specification. Its commit train already names the
pieces: capability/readiness fingerprint contract, ephemeral isolated
environments with no shared mutable state, one exact environment per pinned
package with persisted image and dependency digests.

**Scope discipline applies:** K19 is a release, not a task. If it does not fit
this stage, execute its commit train in order and stop at a clean boundary,
reporting exactly where. **Do not deliver a fraction disguised as the whole**, and
do not substitute a report-only shortcut for the derivation.

The release-discipline budget (plan §3) applies: ≤ 25 production files, ≤ 6 per
commit, ≤ 1 schema migration family.

## TASK 4 — the invariants go into the mental model

`docs/architecture/CONVEYOR-MENTAL-MODEL.md` is the arbiter of every design
argument, and it contains none of the rules this month's failures were all
instances of. Until they are in it, the same defect returns in a new costume —
it has done so four times.

Add, as numbered invariants in the document's own voice:

1. **A frozen prediction is not an authority.** Anything the factory freezes and
   then enforces must be derived from fact, or revising it must be a first-class
   transition. Cite the three instances: change scope, environment declaration,
   check declaration.
2. **Acceptance criteria are derived from the order, never from the candidate.**
3. **Obligations the factory issues from different authorities must be jointly
   satisfiable, and the factory owns proving it — or owns a lawful path out of
   the contradiction.**
4. **A fence decides contention, never necessity.**

Write them so a reader who never saw these runs can apply them to a domain that
has nothing to do with software. An invariant that only makes sense to someone
who was there is a diary entry, not a rule.

## TASK 5 — close stage 12's open end

**`repair/blindsight-reconciliation` is not merged.** Twelve of thirteen trees
landed; the stage-12 report presents task 1 as complete. Merge it under wave-B
discipline, or state plainly why it must not land. Either is acceptable; silence
is not.

`repair/snapshot-test-mvp` stays held until the three stage-12 task-4 answers
exist.

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

Quote the base you measured against — the stage-12 and per-tree reports quote
different baselines, and a count you cannot attribute to a base is not evidence.

One commit per task; K19 by its own commit train. Push to `origin saga4`.

---

## Escalate, do not decide

1. **Any case the contention model cannot express.**
2. **Any change to how material authority freezes or widens** beyond what task 1
   specifies — scope is material authority.
3. **Ending with two mechanisms for scope widening.**
4. **K19 scope overflow** — stop at a boundary and report; never a fraction
   presented as the whole.
5. **Starting a new factory run.**

## Report format

Task 1: the domain-free RED reproduction, the outcome/transition you added, and
the contention rule as implemented.
Task 2: why the dispatcher ignored the carve, and whether task 1 subsumed it.
Task 3: which K19 commits landed, where you stopped, what remains.
Task 4: the invariants as written.
Task 5: merged or refused, with the reason.

Plus the stage-12 run's terminal, if it reached one while you worked.

State what you did not finish.
