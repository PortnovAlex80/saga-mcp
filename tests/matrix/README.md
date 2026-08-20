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

Plus the progress space (CONVEYOR §23): is there any reachable state that
neither progresses nor fails closed?

One file per space:

- `a-progress-space.test.mjs` — the §23 classifier over its FULL input
  product (4536 cells, <100 ms), every behavior cell annotated reachable /
  reachable-defect / unreachable-defensive, every reachable unhealthy cell
  registered with owner.
- (later spaces land one commit each)

Rules that govern every file here (brief §2): **findings, not fixes** — a
gap is recorded with file and line and left alone; **domain-free fixtures**
(real structure, arbitrary text, never a realistic product); **non-vacuity**
— every assertion has been seen RED (break mechanism → RED → restore →
GREEN; the RED message is quoted verbatim in the stage report); **no real
LLM**; **speed is a feature** — thousands of traversals per minute.
