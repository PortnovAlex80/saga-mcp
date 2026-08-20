# Agent brief — saga-mcp, stage 17: close the axes the matrix does not reach

Continues `STAGE-16-AGENT-BRIEF.md`. **All rules from stages 2–16 still apply.**
**Do not launch a factory run.**

Branch `saga4`.

Read `docs/architecture/FAILURE-AXES.md` before anything else. It derives eight
kinds of wrong this system can be, from the system's structure rather than its
bug history. Stage 16 covers three and half of a fourth. **This stage takes the
rest.**

| Axis | State entering this stage | This stage |
|---|---|---|
| 1 Decision | good | — |
| 2 Delivery | newly covered | — |
| 3 Reference | partial (space B) | — |
| **8 Liveness** | **no measure exists** | **TASK 1** |
| **7 World-model fidelity** | **unenumerated** | **TASK 2** |
| **4 Containment** | ratchet only | **TASK 3** |
| **5 Concurrency** | suites exist, not swept | **TASK 4** |
| **6 Durability** | suites exist, not swept | **TASK 4** |

**Scope warning, stated up front:** this is more than one night. Tasks are in
priority order. **Two done properly beat five started.** Task 1 alone would
justify the stage.

---

## TASK 1 — the liveness measure (the reason this stage exists)

### The analysis, so you do not have to derive it

A well-founded measure already exists in this system: **the attempt budget.**
`maxAttempts` per recovery epoch is finite and strictly decreasing. That is a
genuine descent.

**It is destroyed by epoch creation.** Epochs are unbounded, and a new epoch
grants a fresh budget — so every epoch resets the descent to its starting value.
Stage 12 created six and reset six times, walking from healthy state to healthy
state 106 times without terminating.

**F6 — merged during stage 12 — fixes this incorrectly.** It refuses a new epoch
when the same typed diagnostic repeats. That requires the diagnostic set to
**change**. Change is not descent: a cell cycling `A → B → A → B` satisfies F6
forever and stays lawfully alive.

> **A measure must decrease, not differ. F6 is a limit on one loop, not a
> guarantee of termination.**

### What to build

A **lexicographic measure**, ordered most significant first:

```
( |unsatisfied constraints| , epoch budget , attempt budget )
```

- **A new epoch may be created only if the unsatisfied-constraint set strictly
  shrank** since the previous epoch. The order-constraint register
  (`factory.order-constraint-register.v1`) already carries typed per-item
  dispositions — that is the set to measure.
- **The epoch budget is the outer guarantee**, for the honest case where the set
  genuinely cannot shrink (an unsatisfiable card). Bounded, decreasing, no reset.
- The attempt budget stays as it is — it already descends correctly *within* an
  epoch.

Lexicographic order over well-founded components is well-founded. That is the
whole proof, and it is why the structure matters more than the specific numbers.

#### TODO — Task 1

- [ ] T1.1. Locate every place an epoch is created. Read the code; there may be
      more than one.
- [ ] T1.2. Define the measure as a pure function of durable state. It must be
      computable from the database alone, with no in-memory context — otherwise
      it cannot be checked after a crash.
- [ ] T1.3. Write the RED first: a cell cycling between two diagnostics
      (`A → B → A → B`) that F6 permits forever. **Watch it run unbounded on
      current code.** Domain-free — no path or concept from any real run.
- [ ] T1.4. Assert the measure strictly decreases across every lawful transition
      that creates an epoch. A transition that does not decrease it must be
      refused, with a typed terminal naming which component failed to descend.
- [ ] T1.5. Assert the honest terminal: a cell that genuinely cannot shrink the
      set reaches a **named terminal**, not a loop and not a silent park.
- [ ] T1.6. Prove non-vacuity: disable the measure check, confirm the T1.3 RED
      runs unbounded again, restore, quote the RED message verbatim in the
      report.
- [ ] T1.7. **If you conclude no computable measure exists** — that is a real and
      valuable finding. Report it with what you tried and why each candidate
      failed. Do not invent one that does not descend.

**Do not delete F6.** It is a cheap early-exit that stays useful under the
measure. Report how the two interact.

---

## TASK 2 — world-model fidelity (axis 7)

**Question:** every belief the factory holds about something it does not own —
what proves it, and is the proof re-checked or cached?

This is where the worst defect lived: `integration_state = 'merged'` was believed
as proof that a merge happened. The fix made the repository the authority for
that one case. **The axis is unenumerated.**

#### TODO — Task 2

- [ ] T2.1. Enumerate every external thing the factory holds a belief about: git
      refs and commits, container images, the filesystem/workspace, package
      registries, remote endpoints. Read the code; do not guess.
- [ ] T2.2. For each belief, record: where it is stored, what proves it, and
      whether the proof is **re-checked at use** or **cached from an earlier
      check**.
- [ ] T2.3. For every cached belief, write the divergence test: change the world
      behind the factory's back, then act on the belief. Assert the factory
      detects the divergence rather than acting on the stale belief.
- [ ] T2.4. Where it does not detect it, **record a finding** — file, line, and
      what the stale belief would authorise. Do not fix.
- [ ] T2.5. Report the table: belief → store → proof → re-checked or cached →
      divergence detected.

The template for a correct answer is the ancestry fix: *the repository is the
authority on whether a merge happened, not a column.* Judge each belief against
that shape.

---

## TASK 3 — containment (axis 4)

**Question:** can an actor act beyond the authority it was granted?

Distinct from delivery: delivery asks whether the actor *knows* its limits;
containment asks whether it *can exceed* them. The §27 ratchet covers one
instance (fenced-effect tools); nothing sweeps the space.

#### TODO — Task 3

- [ ] T3.1. Enumerate every authority granted to an actor: tool grants, change
      scopes, workspace paths, MCP surface, the effect surface.
- [ ] T3.2. For each, identify the mechanism that *enforces* the limit — not the
      one that declares it.
- [ ] T3.3. For each, write the exceed test: attempt the action beyond the grant.
      Assert it fails closed.
- [ ] T3.4. Assert the intersection property where it applies: effective
      capability is `profile ∩ runtime`, never a union.
- [ ] T3.5. Report the table: authority → enforcement mechanism → exceeding
      blocked.

---

## TASK 4 — sweep concurrency and durability (axes 5 and 6)

`tests/dispatcher-race/` and `tests/factory-temporal/` are real and were written
**one bug at a time** — the same posture the matrix exists to replace. Converting
them is cheaper than building new spaces, and that is the whole task.

#### TODO — Task 4

- [ ] T4.1. **Concurrency:** enumerate the dimensions — claimable subjects ×
      concurrent claimants × fence states. Map the existing scenarios onto the
      product and report which cells are covered, which are unreachable (with a
      reason), and which are simply untested.
- [ ] T4.2. **Durability:** enumerate the crash points along one full cell loop.
      Map the existing crash-injection scenarios onto them. Same three-way
      classification.
- [ ] T4.3. Add tests only for the highest-risk uncovered cells — the ones that
      would touch authority or material. **Do not fill the whole grid**; report
      the map and let the architect choose.
- [ ] T4.4. Report both coverage maps with counts.

---

## TASK 5 — close the loop on the axis map

- [ ] T5.1. Update the coverage table in `docs/architecture/FAILURE-AXES.md` with
      what this stage actually achieved. Honest partials, not optimistic ones.
- [ ] T5.2. State whether any defect you encountered fits **no** axis. Per §3.4
      of that document, such a defect means the axis derivation is wrong and the
      map gets corrected — the defect does not get squeezed into an existing box.

---

## Verification baseline (paste real counts, never "green")

```bash
npm run build
node --test "tests/matrix/*.test.mjs"
node --test "tests/architecture/*.test.mjs"
node --test "tests/lifecycle/*.test.mjs"
node --test "tests/process-modules/*.test.mjs"
node --test "tests/infrastructure/*.test.mjs"
node --test "tests/factory-e2e/w9-*.test.mjs"
node --test tests/factory-contract/golden-path.test.mjs
```

Task 1 changes epoch-creation behaviour and **will** break suites asserting the
old unbounded semantics. Update them in the same commit with the reason. Every
other task adds tests and changes no production code — if their counts move,
investigate before committing.

One commit per task. Push to `origin saga4`.

---

## Escalate, do not decide

1. **No computable liveness measure exists** (T1.7) — the most important thing
   you could report.
2. **Any cached world-model belief that authorises an effect** — that is the
   `integration_state` shape and it is an architect decision, not a repair.
3. **Any containment gap** — do not close it; a worker's capability boundary is
   material authority.
4. **Any defect fitting no axis.**
5. **Starting a factory run.**

## Report format

Task 1: the measure as implemented, the RED verbatim before and after, and how it
interacts with F6. Or the honest statement that no measure exists, with the
candidates you rejected and why.
Tasks 2–4: the tables, and the findings ordered by what each would authorise if
exploited.
Task 5: the updated coverage table.

State what you did not finish. Two axes closed properly are worth more than five
touched.
