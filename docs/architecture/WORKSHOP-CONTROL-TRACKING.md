# Workshop control tracking — backward derivation of the acceptance chain

- **Date:** 2026-08-20
- **Method:** backward chaining (weakest-precondition style) from the factory's
  terminal acceptance criterion down the influence graph, through every workshop
  and across every workshop boundary.
- **Question:** for the terminal criterion to be *achievable*, what must hold one
  level below? And below that? Where does the chain break?
- **Status:** analysis. Normative consequences are proposed, not ratified.

---

## 0. Why this exists

Four times this month the same defect arrived in a new costume, and each time we
found it by autopsy after a run died. Forward reasoning ("does this gate work?")
has never predicted a single one of them.

Backward reasoning asks a different question: **not "is this check correct?" but
"is there any world in which all of them can be satisfied at once?"**

That question has an answer, it is computable, and nobody in this system has ever
asked it.

---

## 1. The chain, walked backward

Notation: `L0` is the terminal criterion; `Ln+1` is what must hold for `Ln` to be
achievable. `⊢` reads "requires".

### L0 — Factory terminal: `runnable-local`

The lifecycle terminal that means "we built something that runs".
Decided by `factory.local-runnability.v1` in a sterile container.

```
L0 ⊢ (a) the integrated candidate CONTAINS every file the run needs
   ⊢ (b) the execution environment CONTAINS every package the code imports
   ⊢ (c) the executed check set COVERS the order's criteria
```

### L1 — Development readiness certification cell

Gate `development.readiness-certification.final.v2` =
{ `factory.local-runnability.v1`, `factory.product-contract.v1`,
`development.readiness-profile-monotonicity.v1` }

```
L1 ⊢ (a) every implementation card was accepted, and their union covers the order
   ⊢ (b) the environment is DERIVED from the artefact          ← BREAK 2
   ⊢ (c) the check set is DERIVED from the order               ← partially closed
```

- **(b)** is not derived. The candidate declares an install command. Verified
  live: the GDesign run declared `pip install numpy PyMuPDF openpyxl pytest`, the
  code imported `yaml`, the sterile container had no `pyyaml`, the run failed.
  Owner: **K19**.
- **(c)** was not derived either — the stage-11 gaming narrowed `testCommand`
  from 9 files to 7. Anti-gaming step 1 (additive coverage report) landed and
  makes the narrowing *visible*; step 4 (derived-canonical set) has not landed,
  so the derivation still does not exist.

### L2 — Implementation cells (fan-out over cards)

Author gate `development.implementation.author.v2` includes
`development.implementation-scope.v1`.
Review gate `factory.review-verdict.v1`.

```
L2 ⊢ for EACH card: there exists a worker action satisfying BOTH
      implementation-scope AND review-verdict
```

**This precondition is never computed.** It is the deadlock:

```
review-verdict.v1       → failed : the criteria require an artefact class
                                   the card has not produced
implementation-scope.v1 → failed : the paths that artefact class lives in are
                                   outside the card's frozen changeScopes
```

Formally the card requires `paths(AC) ⊆ changeScopes(card)`, and nothing anywhere
evaluates that expression — because `paths(AC)` **does not exist as a computable
object**.

### L3 — Task graph / the carve

Gate `development.task-graph-contract.v1` — validates lineage, coverage, DAG.

```
L3 ⊢ the carve produces cards whose scopes are sufficient for their criteria
```

What "coverage" means today: *every criterion has a card*. What it does **not**
mean: *every card can satisfy the criterion it was made for*. The planner
therefore assigns each card a scope by **prediction**, before any implementation
exists.

### L4 — Formalization: acceptance contract

Gate `formalization.acceptance-contract.v1`. Produces the acceptance criteria.

```
L4 ⊢ criteria are expressed so that the artefact classes they imply are DERIVABLE
```

Nothing imposes this. Criteria are prose obligations. A criterion may be perfectly
clear to a human, perfectly checkable at review time, and carry **no machine-
readable statement of what must exist** for it to be satisfiable.

**This is BREAK 1.**

### L5 — Formalization: product contract, use cases, SRS, reconciliation

`formalization.product-contract.v1`, `formalization.use-cases.v1`,
`formalization.srs-contract.v1`, `formalization.srs-structural.v1`,
`formalization.reconciliation.v1`

```
L5 ⊢ the order's constraints reach the criterion author, and their consumption
     is obligatory
```

Historically broken (AC drift: the order's docker/language/client constraints
never reached any criterion). Closed by the AC-drift remedy — the register
`factory.order-constraint-register.v1` plus its reaction networks. **This link is
now the healthiest in the chain**, and it matters below.

### L6 — Discovery

`discovery.proposal-contract.v1`, `discovery.readiness-contract.v1`

```
L6 ⊢ the order's constraints are captured at all
```

Verified sound in the stage-11 forensics: discovery held all three lost
requirements; the loss happened at L5, not here.

---

## 2. The result — the chain breaks in exactly two places, and they are the same break

| Break | Between | The missing derivation |
|---|---|---|
| **1** | L4 criteria → L3 carve | criterion ⟶ **artefact classes it requires** |
| **2** | L1 candidate → L0 environment/checks | artefact ⟶ **environment and checks it requires** |

Every other link in the chain is well-formed and machine-checked. Ten links hold.
Two break. And both breaks sit **exactly where the chain crosses between two
representations**:

```
        WHAT MUST BE TRUE                    WHAT MUST EXIST
        (criteria, obligations)              (artefacts, paths, packages)

L6 → L5 → L4  ────── BREAK 1 ──────►  L3 → L2 → L1  ────── BREAK 2 ──────►  L0
```

**The factory is rigorous inside each representation and has no bridge between
them.** Where a bridge is required, something guesses:

- at break 1 the **planner** guesses which paths a criterion needs;
- at break 2 the **candidate** guesses which packages and checks its artefact
  needs.

Both guesses are then **frozen and enforced as authority** — which is the
"frozen prediction" defect named in the stage-13 brief. The backward walk shows
it is not a coincidence that it appeared twice: **there are exactly two
representation crossings, and both are unbridged, so both must guess.**

That is the whole disease, located.

---

## 3. Why the test suite cannot catch this

The honest answer, and it is not "we forgot a test".

**3.1 Every test lives inside one representation.** Provider tests assert a
provider's verdict on a fixture. Contract tests assert a payload's shape. There
is no test *between* representations, because there is no code between them.
A missing bridge has no unit to test.

**3.2 Fixtures are internally consistent by construction.** A test that builds a
card builds its criteria and its scope from the same hand, so they cannot
contradict. The contradiction requires **two independent derivations of the same
order** — planner and reviewer, each reading the order separately. Only a real
run produces that.

**3.3 The corpus is made of survivors.** The golden corpus replays material that
was accepted. A deadlocked run produces no accepted material, so a deadlock can
never appear in a corpus harvested from success. The corpus is structurally
incapable of containing this class.

**3.4 Every gate is individually correct.** `review-verdict` was right. 
`implementation-scope` was right. Both verdicts are defensible in isolation, and
each has passing tests. The defect exists **only in their conjunction**, and
conjunction is nobody's unit.

**3.5 The missing test class, named:** *satisfiability*. Not "does this check
return the right verdict?" but **"does there exist a state satisfying all
simultaneously enforced constraints?"** That is a different question, answered by
a different technique, and the L0–L5 ladder in §23 does not contain a rung for
it.

> **A conveyor of independently-correct gates can still admit no possible world.
> Nothing currently tests for that.**

---

## 4. What the backward walk implies (proposed, not ratified)

**4.1 The bridges are the deliverable, not more checks.** Adding a
joint-satisfiability check at break 1 only *checks the guess*; the guess remains.
The chain is fixed by making the two crossings derivable:

- **Break 1:** a criterion must carry a machine-readable statement of the
  artefact classes it requires. Then `paths(AC)` exists, the carve is *computed*
  rather than predicted, and L2's precondition becomes evaluable at carve time.
- **Break 2:** the environment and the check set must be derived from the
  artefact and the order respectively. That is K19 and anti-gaming step 4 — both
  already scheduled, both now shown to be **the same break**.

**4.2 Where a bridge cannot be total, the fence must change question.** If
`paths(AC)` is only partially derivable, the residue must not be forced into a
frozen guess. Then the scope fence stops deciding *necessity* (underivable) and
decides *contention* (always decidable) — the stage-13 design.

The two responses are complementary, not alternatives: derive what is derivable,
and make the undecidable residue a lawful transition instead of a wall.

**4.3 The bridge at break 1 has already started.**
`factory.order-constraint-register.v1` — built by the AC-drift remedy — is a
machine-readable register of order constraints with typed per-item dispositions.
It bridges L5→L4. **The same shape extended one level down bridges L4→L3.** The
mechanism exists; it has not been carried across the second crossing.

**4.4 The satisfiability rung belongs in the testing ladder.** §23's L0–L5 names
levels by *scope of execution*. It needs a rung named by *kind of question*:
given the check plans a lifecycle installs, does a satisfying assignment exist?
For the deadlock this is decidable and cheap — the contradiction was a set
containment that failed.

---

## 5. Chain status, one table

| Link | Bridge exists? | Status |
|---|---|---|
| L6 → L5 order constraints captured | yes | sound (verified stage-11 forensics) |
| L5 → L4 constraints reach criteria | **yes — constraint register** | closed by AC-drift remedy |
| **L4 → L3 criteria ⟶ artefact classes** | **NO** | **BREAK 1 — planner guesses** |
| L3 → L2 carve ⟶ cards | yes | sound |
| L2 cards accepted | conditional on break 1 | **livelocks when the guess is short** |
| L2 → L1 union covers order | partial | AC-drift remedy addresses coverage |
| **L1 → L0 artefact ⟶ environment** | **NO** | **BREAK 2a — candidate declares (K19)** |
| **L1 → L0 order ⟶ check set** | **partial** | **BREAK 2b — report only; step 4 pending** |
| L0 terminal honesty | yes | **proven working** (GDesign failed truthfully) |

Ten links. Two and a half breaks. All of them at a representation crossing.

---

## 6. What this predicts (the point of doing it forward-looking)

If the analysis is right, these follow without needing another dead run:

1. **Any new workshop producing artefacts will hit break 1** the moment its
   criteria imply artefacts its carve did not predict. Nothing about this is
   specific to software, paths, or frontends.
2. **Break 2 will recur for every environment dimension not yet named** — not
   only packages: runtime versions, locales, filesystem layout, network access.
   Each is a thing the candidate currently declares.
3. **A criterion that is checkable but not derivable is the dangerous kind.** It
   passes review, survives formalization, and detonates at the carve. Any
   criterion vocabulary added later should be judged on derivability, not only on
   checkability.

Prediction 3 is the cheapest test of this whole document: if a future deadlock
happens at a criterion that a human could check but a machine could not map to
artefacts, the model held.
