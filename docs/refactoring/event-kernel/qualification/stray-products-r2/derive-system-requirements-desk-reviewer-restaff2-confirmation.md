# derive-system-requirements desk (reviewer) — re-staffing confirmation (staffing #2)

Round: `stray-products-r2` factory testbed · re-staffed with a **byte-equivalent** desk task
envelope (9/9 projection refs, skill pins `bc8a4261`/`2cbcf850`, 1 upstream-accepted entry
`sha256:65fe9a22… :: accepted revision of derive-system-requirements`) · confirmed package of
record: **FR-Derive-System-Requirements-001** `sha256:d31b044c9530773ac05a25bd9b4cb503164bcf31b4694547011aba43c19816d0`
(verdict **repair**) over candidate SR-Derive-System-Requirements-001 `sha256:86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df`,
desk product submission of record **FS-Derive-System-Requirements-002** `sha256:f7e0e85c6992402209563516bd1b9de73a56bf1eaacf7a392dc910f65b17f9d0`
· this staffing mints **no second submission**.

## What happened

The reviewer seat was already served (files of record written 02:24–02:29; 80 recomputations,
77 pass / 3 fail, verdict **repair**). This staffing received the same envelope again. Desk law
on re-staffing with an identical envelope: the outcome is idempotent by content address —
re-emitting the package would mint new addresses for identical semantics (the exact contention
anti-pattern recorded as CR-Model-Use-Cases-002 and CR-001..003). So this staffing **verifies
and confirms**, emitting only its own restaff2-namespaced evidence (ADV-5: distinct seat
emissions never share filenames; zero existing files modified or deleted).

## Independent verification (28 recomputations, 28 pass / 0 fail)

Evidence: `derive-system-requirements-desk-reviewer-restaff2-verify.mjs` → receipt
`derive-system-requirements-desk-reviewer-restaff2-verify-out.json` · confirmation
RS-Derive-System-Requirements-001 `sha256:1c30d28e8222eaa225195bf33d87f378054b98a01bdf50710fd4900f5339a0a6`
· trace RT-Derive-System-Requirements-002 `sha256:7b6d96c5a16c7a611956e2ec78a5da36914664aab4186f2246548eb481fd177e` (8 edges).

- **Envelope identity (H1–H4):** this frame's 9 projection refs == the standing staffing's pins
  (VV `envelopePins`, bound through the self-addressed VV `d81d2347…`, not filenames); skill
  pins, workspace-summary line, upstream entry and write authority all equal.
- **Standing package recomputed (R1–R7), zero trust:** VV `d81d2347`, FR `d31b044c`
  (verdict repair; unsatisfied criteria exactly [6,10,11,12]; CRIT-1/CRIT-2 + MAJ-1;
  RA-1..RA-5), RT `e97b710f` (6 edges), FS `f7e0e85c` (binds FR+VV+RT; verdict repair;
  `formalization.accept-products`; `success`), author trio `86b00569` / `05e713ef` / `fd0b0b1f`.
- **No content delta (C1/R6):** the reviewed subject recomputes to the exact address the
  standing staffing reviewed — the author trio is unchanged.
- **Desk-state census (R8):** single author submission of record (FS-…-001); 0
  adjudication/settlement records; 0 model-use-cases reviewer artifacts; no predecessor
  re-staff emission for this seat (this is staffing #2).
- **REAL kernel re-run (K1–K8):** provider `formalization.requirements-structure.v1`; seam
  binder fail-closed self-test passes; both upstream folds re-derive through the REAL
  validators + REAL cell folds (prd `a30229a7…`, uc `184981e5…`); REAL WP03 validator re-seals
  the bundle to the standing address `sha256:60083eb4…`; author-stage gate re-runs to
  **accepted** (6 checks); kernel reviewer route (mechanical surface only) → **accept** — the
  DESK verdict of record stays **repair** by the M-layer acceptance-status authority, exactly
  consistent with the standing 77/80 whose only failures are M4/M5/M6; negative probe: foreign
  lineage → upstream-repair.
- **Verdict rationale re-derives (M4–M6, N1):** no accepted upstream revision exists in r2 —
  all intent reviewer emissions still carry verdict repair (contention open), the UC bundle has
  never passed a reviewer stage; SC-2 is still a bare claim and CERT-1 still subject-level
  (no scope-2 exclusion decision exists); the governing-contract anchor `a926df62…` is still
  unresolvable workspace-wide (232 files scanned, 0 hits in raw/canonical/.content bodies).
  RA-1..RA-5 all remain open.
- **Envelope projection adjudication (O1–O2):** upstream-accepted[0] `65fe9a22…` remains
  UNRESOLVABLE as content (verdict of record repair; the author desk has not reissued; the
  final gate never ran). Stale shell metadata, same family as `745cadc1…`; textual mentions are
  informational only. Author 0 upheld; this staffing's reviewer-side accepted-revision count is
  likewise 0.

## Desk outcome (re-affirmed, unchanged)

- Verdict **repair**; review of record **FR-Derive-System-Requirements-001**; desk product
  submission of record **FS-Derive-System-Requirements-002** (`formalization.review-complete.v1`).
- No downstream desk may consume the candidate until its lineage is accepted material under
  authority that exists: the author desk holds or reissues against genuinely accepted revisions
  (RA-1); the intent desk settles under driver/human adjudication and restores claim:scope-2
  (RA-2); the UC desk reconciles its hold and passes review (RA-3); the contract layer re-seals
  (RA-4); the driver enforces single-seat namespaces and refreshes envelope projections (RA-5).
- `constraint:retention-1` (`80739396…`) and `unknown:browser-matrix-1` (`38fc9cb1…`, carried
  never resolved, D10) travel forward; `claim:scope-2` (`cb291aa7…`) stays upstream-contested
  carried boundary material.
- Files of this emission: `derive-system-requirements-desk-reviewer-restaff2-verify.mjs`,
  `derive-system-requirements-desk-reviewer-restaff2-verify-out.json`,
  `derive-system-requirements-desk-reviewer-restaff2-confirmation.json` (RS-Derive-System-Requirements-001),
  `derive-system-requirements-desk-reviewer-restaff2-trace.json` (RT-Derive-System-Requirements-002),
  `derive-system-requirements-desk-reviewer-restaff2-build.mjs`, this record.
