# tests/matrix — the defect-shape matrix

Stage 16. The thesis (`docs/handoff/STAGE-16-AGENT-BRIEF.md` §0.1):

> You cannot predict the *content* of the next defect. You **can** enumerate
> its *shape*. Every defect found in this project falls into four shapes:

| # | Shape | Real instance |
|---|---|---|
| S1 | Material re-identification — deleted and recreated with identical content after a seal referenced it | trace rows 11–16 → `REPLAY_CAPTURE_TRACE_NOT_FOUND` |
| S2 | Self-declaration narrowing — the candidate declares less than canonical | `testCommand` 7-of-9 files; install omitting an imported package |
| S3 | Cross-authority contradiction — two factory-issued constraints unsatisfiable on one card | AC requires an artefact class; scopes forbid its path |
| S4 | Constraint loss across restatement — upstream requirement absent downstream, no disposition | order constraints absent from every AC |
| S5 | Authority delivery failure — the factory computes a constraint correctly and never delivers it to the actor bound by it | the stage-15 widening grant: the fence, classifier and ledger all decided rightly; the re-staffed worker was never told (W-F1) |

**Two axes.** S1–S4 (spaces A–E) are the DECISION axis — does a gate decide
correctly? S5 (space F) is the DELIVERY axis — does the decided authority
reach the actor BEFORE the action? The stage-11 blindsight census named the
delivery axis verbatim ("the factory writes the right information and fails
to deliver it to the point of decision") and it still took a live defect to
carry it into the matrix.

Plus the progress space (CONVEYOR §23): is there any reachable state that
neither progresses nor fails closed?

One file per space:

- `a-progress-space.test.mjs` — the §23 classifier over its FULL input
  product (4536 cells, <100 ms), every behavior cell annotated reachable /
  reachable-defect / unreachable-defensive, every reachable unhealthy cell
  registered with owner.
- `b-material-reidentification.test.mjs` — shape S1: for every material
  kind a seal references (enumerated from the schema and the capsule
  certification chain), delete + identical re-creation must still resolve.
  Row-id kinds that break are FINDINGS (B-F1 artifacts, B-F2 trace task
  targets, B-F3 counts-only errors) — recorded, not fixed.
- `e-constraint-loss.test.mjs` — shape S4: a CONSTRAINT-ALPHA token placed
  upstream and dropped at each restatement boundary (order→proposal→PRD→
  AC→task graph→cards). Covered boundaries assert detection; the three
  HIGH findings (E-F1 ungated order extraction, E-F2 the reconciliation
  detector exists but no call site passes the flag, E-F3 no constraint
  echo on implementation cards) assert the honest gaps.
- `c-declaration-narrowing.test.mjs` — shape S2: all 20 candidate-declared
  surfaces enumerated from the check providers; the derived ones assert
  narrowing is blocked (declare less → fail) and additive stays legal; the
  six declared-taken surfaces are findings (F-C1 readiness.kind — serve
  verification removable by declaration; F-C2 compose opt-in; F-C3..F-C6)
  — recorded, not fixed.
- `d-authority-contradiction.test.mjs` — shape S3: the 26-pair matrix over
  the 14 constraints enforced on the development cards; every
  contradiction pair carries a satisfiability proof or a lawful
  transition, driven through the REAL fence/desk/ledger/review/ratchet
  providers (including the live widening round-trip: fence rejects →
  ledger grants rev 1 → the same byte-identical submission passes).
  Findings: d-1 (ADR-062 deferral reads the original carve, not the
  widened authority), d-3 (shared-path serialization — the stage-15 cost,
  by design), d-2 (desk workItemKey equality only at the gate).
- `widening-worker-visibility.test.mjs` — the stage-15 live case, closed
  loop: a coverage inventory pinning that the fence×2→grant→re-staff chain
  IS tested elsewhere, plus W-F1 (high): the grant never informs the
  re-staffed worker — the card keeps the original carve, the assignment
  seam never reads the ledger, and a self-limiting post-grant submission
  still passes containment. The silent-surrender door (E-F4) stays open
  THROUGH the widened grant. D7: no
  permanent refusal of a shared path — both release axes re-grant.
- (later spaces land one commit each)

Rules that govern every file here (brief §2): **findings, not fixes** — a
gap is recorded with file and line and left alone; **domain-free fixtures**
(real structure, arbitrary text, never a realistic product); **non-vacuity**
— every assertion has been seen RED (break mechanism → RED → restore →
GREEN; the RED message is quoted verbatim in the stage report); **no real
LLM**; **speed is a feature** — thousands of traversals per minute.

- `f-authority-delivery.test.mjs` — shape S5, the DELIVERY axis: for every
  authority the factory computes, does the actor bound by it receive it
  BEFORE acting? Delivered (the blindsight fixes): recovery memory,
  previous-attempt patch, runtime tool enforcement. Not delivered
  (findings): changeScopes VALUES (the checklist names the constraint and
  teaches the exit but prints no values — F-α1), effective scopes after a
  widening grant (F-α2 = W-F1), the check plan (hand-transcribed into the
  checklist — F-α3), the recovery budget (F-α4). The negative that
  anchors the space: a rejection message is not a delivery channel — if
  the only way to learn a constraint is to violate it, that is a finding
  regardless of whether the run converges.
