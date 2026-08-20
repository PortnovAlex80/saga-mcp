# The failure axes — what kinds of wrong this system can be

- **Date:** 2026-08-20
- **Purpose:** an axis map derived from the system's structure, not from its bug
  history, so that "a new defect class appeared" stops being a surprise.
- **Status:** analysis. The coverage column is the honest current state.

---

## 0. Why this exists

Five defect shapes were enumerated in `STAGE-16-AGENT-BRIEF.md`, and a sixth
appeared within the day. The enumeration was not unlucky — it was **methodically
incomplete**: it listed shapes along one axis while a second axis had already
been named a week earlier in the blindsight census and never carried across.

Enumerating shapes is bottom-up and will always lag. Enumerating **axes** is
top-down and derivable from what the system *is*. This document derives them.

The system, formally: untrusted actors produce material; deterministic
authorities judge it; durable state records the judgments; transitions move work
between stages; effects touch an outside world. Each of those clauses admits its
own kind of wrong.

---

## 1. The axes

### Axis 1 — Decision
**Is the judgment correct given its inputs?**

The gate returns the right verdict for the material it was handed. This is what
almost all of our testing is about, and it is the axis with the least remaining
risk.

*Instances found:* declaration narrowing (`testCommand`, install), cross-authority
contradiction (AC vs `changeScopes`).

### Axis 2 — Delivery
**Does the actor bound by an authority receive it, before acting, intact?**

An authority computed correctly and never delivered is indistinguishable, from
the actor's side, from no authority at all.

**Amended 2026-08-20 under §3.4.** The original wording asked only whether the
actor *receives* the authority. It did not cover an authority that arrives
**corrupted** — and stage 15 produced one: an integration diagnostic that
reported a comparison which had passed (`submitted X but branch is X`, identical
SHAs), because a three-predicate disjunction printed the values of the second
predicate whichever one fired. The repair loop received it and worked on the
wrong problem for a full round.

> **Corrupt delivery is worse than no delivery.** A missing authority makes the
> actor guess; a false one makes it confidently repair the wrong thing. A
> branching check must name the branch that fired.

*Instances found:* the worker is never told its `changeScopes` — original or
widened — and learns the fence only by violating it; order constraints not
reaching the criteria author.

*Named a week before it was carried into the matrix:* the blindsight census —
"the factory writes the right information and fails to deliver it to the point of
decision", 37 findings across 5 layers.

### Axis 3 — Reference
**Does a name still denote the same thing over time?**

Anything that names something else can drift: row ids, digests, aliases, paths,
package versions, capsule keys.

*Instance found:* a sealed snapshot holding `traceId` rowids; the rows were
deleted and recreated with identical content and the seal became permanently
unresolvable.

### Axis 4 — Containment
**Can an actor act beyond the authority it was granted?**

Distinct from Delivery: Delivery asks whether the actor *knows* its limits;
Containment asks whether it *can exceed* them.

*Instance found:* `worker_merge_acquire`/`worker_merge_release` granted to worker
profiles, letting a worker issue integration authority.

### Axis 5 — Concurrency
**Do simultaneous actors corrupt each other?**

Fences, leases, CAS, claim races, lost updates, stale writes, a lease expiring
while its holder is genuinely working.

### Axis 6 — Durability
**Does a crash at any point converge?**

Crash windows where a decision is half-applied; recovery that double-applies;
resume that adopts the wrong prefix.

### Axis 7 — World-model fidelity
**Does the factory's belief match external reality?**

The factory holds beliefs about things it does not own: git refs, container
images, the filesystem, remote state. Every such belief can diverge from the
world it describes.

*Instance found:* `integration_state = 'merged'` believed as proof that a merge
happened. Fixed for that one case by making ancestry the proof — the repository,
not a column. **The general axis is unenumerated.**

*Instance found (stage 15), the same shape a second time:* the implementation
result declares `snapshot.treeSha` — a fact about the repository — and the
author gate never asks the repository. It validates `commitSha` as 40-hex and
`changedFiles` as non-empty; `treeSha` is not mentioned at all. A worker wrote
the commit SHA into it twice in one run, and the belief detonated at the
integration effect.

Note what the tree comparison there is actually worth: `sourceTree` is derived
as `rev-parse ${commit}^{tree}` from the commit already checked equal to the
declared one, and a commit's tree is immutable. **The only variable in that
predicate is what the worker typed** — it has zero power to detect divergence in
the world. A world-model check whose two sides derive from the same immutable
object is not a world-model check; it is a typo detector placed at the most
expensive point in the loop. Judge candidate checks on this axis by asking what
could make them fail *other than the declaration itself*.

### Axis 8 — Liveness
**Is there a well-founded measure guaranteeing termination?**

The sharpest and least covered.

> **Safety ≠ liveness.** "No state is bad" and "the system must end" are different
> claims, and the second does not follow from the first.

In the stage-12 deadlock **every individual state was healthy** — a live owner, a
runnable command, a legitimate new epoch. The factory walked from healthy state
to healthy state 106 times and never terminated. A state-classification sweep
cannot catch this by construction.

Liveness needs a quantity that strictly decreases and cannot decrease forever.
**This system has none.** Revision rises. Epoch count rises. Attempt count rises.
Nothing descends.

---

## 2. Coverage — the honest current state

| Axis | Matrix space | Other coverage | Verdict |
|---|---|---|---|
| 1 Decision | A, C, D | provider suites, gate suites | **good** |
| 2 Delivery | E, F | 8 blindsight repair branches | **newly covered** |
| 3 Reference | B | trace fix (stage 11) | **partial** — one kind proven, rest unenumerated |
| 4 Containment | — | §27 ratchet, capability intersection | **untested systematically** |
| 5 Concurrency | — | `tests/dispatcher-race/` | **exists, not enumerated** |
| 6 Durability | — | `tests/factory-temporal/`, K9 crash matrix | **exists, not enumerated** |
| 7 World-model | — | ancestry fix (one case) | **unenumerated** |
| 8 Liveness | A is safety-only | F6 epoch limit | **no measure exists** |

Three axes have systematic coverage. Two have real coverage that was written
scenario-by-scenario rather than swept. Three have essentially none.

---

## 3. What follows

**3.1 Liveness needs a measure, not a limit.** F6 (refuse a new epoch when the
same typed diagnostic repeats) is a *limit* — it stops one specific loop. A
measure is a general guarantee. Candidates worth evaluating: unresolved-obligation
count, distance-to-terminal in the lifecycle graph, or the size of the
still-contested constraint set. Each must be proven to strictly decrease across
every lawful transition, which is exactly the kind of thing a matrix space can
check mechanically.

**3.2 World-model fidelity is enumerable the same way the others are.** List every
external thing the factory holds a belief about; for each, name what proves the
belief and whether the proof is re-checked or cached. The `integration_state` fix
is the template: the repository is the authority, not a column.

**3.3 Concurrency and durability need sweeping, not more scenarios.** The suites
exist and were written one-bug-at-a-time — the same posture the matrix exists to
replace. Converting them is cheaper than building new spaces.

**3.4 The axis list itself must be falsifiable.** It is derived from a
five-clause description of the system, so it is only as complete as that
description. If a defect appears that fits no axis here, the derivation was
wrong and this document is what gets corrected — not the defect that gets
squeezed into an existing box.

---

## 4. The rule this produces

> **Enumerate axes top-down before enumerating shapes bottom-up.** A shape list
> is a record of what has already hurt. An axis list is a prediction of what can.
