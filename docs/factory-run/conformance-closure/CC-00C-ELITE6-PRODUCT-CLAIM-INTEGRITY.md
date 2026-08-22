# CC-00C — Elite-6 Product-Claim Integrity: Claim-to-Work Coverage, Deliverable-Aware Oracle, Verification Accounting, Substrate Classification, Role Projection (2026-08-22)

Package: `CC-00C` of `docs/plans/CONFORMANCE-CLOSURE-PLAN.md` (critical path:
`CC-00 -> CC-00B -> CC-00C -> CC-10A`). Owner: integration owner; gap owners
named per CC-GAP-6..10 below. This record is documentation only: **the
runtime is not fixed by it** (see the final section). It extends, and must be
read with, `CC-00B-ELITE6-TERMINAL-INTEGRITY.md` in this directory.

## Classification

- **Experiment complete and immutable.** The Elite-6 experiment is complete
  and immutable; it is not reopened, replayed, or "fixed" by this package.
  Product qualification failed.
- **Failed product outcome, truthful in durable records** (per CC-00B):
  lifecycle `terminal_status=failed`, Development
  `local_outcome=failed`/`processOutcome.code=failed`, and a `failed` final
  development-readiness gate verdict.
- **Observed readiness failure = substrate unavailability.** The final
  readiness manifest declared node:20-alpine Docker, and
  `factory.local-runnability.v1` failed before install/test/serve with
  `LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE`. It never exercised the product and
  therefore never proved or disproved browser runnability.
- **Separately proven latent product defect.** Code inspection proves the
  browser frontend is missing: client renderer/hud/effects modules exist, but
  there is no index.html, no DOM/canvas use, no static serving route, and no
  npm start; the server exposes only healthz and 404. This defect was not
  observed by the readiness gate; it is a latent product defect that a real
  browser run would have surfaced. It is distinct from the substrate
  readiness failure.
- **Product-claim integrity defects (CC-GAP-6..10).** The classification
  chain — whose deliverable-claim classification authority originates in
  Discovery and Formalization, with the Development planner only inheriting
  it — allowed an ordered browser-product claim to reach terminal without
  any item or oracle that could prove it, deferred verification to vanish
  from accounting, flattened substrate failure into product failure, and
  left role projections ambiguous.

Summary classification: **a complete and immutable experiment whose product
qualification failed; the observed readiness failure was substrate
unavailability (Docker unavailable, before install/test/serve), the missing
browser frontend is a separately proven latent product defect, and the
classification-to-verification chain (Discovery/Formalization authority,
planner inheritance, readiness execution) has product-claim integrity
defects in coverage, oracle, accounting, classification, and projection.**

Root-cause wording (corrected per independent review, 2026-08-22):

- AC-22 **existed** in the formalized acceptance-criteria set and was only
  **nominally attached** to `impl-galaxy-ship-foundation`. The missing
  browser frontend is therefore not explained by a missing or dropped
  criterion: it is explained by absent whole-product synthesis ownership and
  by the absence of a mechanical, upstream classification enforcement the
  planner could inherit and fail closed on (CC-GAP-6).
- Tasks 15-25 (author) and 26-36 (reviewer) are projections of the same 11
  Workplace refs in one sealed graph — **not duplicate implementations and
  not graph rematerialization** (CC-GAP-10 projection clarity only; no
  deduplication work is owed).

## Facts vs interpretation

Accepted facts (architect cross-check, 2026-08-22; this record adds no live
DB/log/process inspection and no hashing):

| # | Fact |
|---|---|
| F1 | The original lifecycle and Discovery faithfully required a rich Chrome canvas game, `npm install` plus `npm start`, browser smoke, and local run. |
| F2 | Formalization DID include AC-22 requiring install plus start leading to an accessible running game. |
| F3 | The planner attached AC-22 to `impl-galaxy-ship-foundation` with scopes `package.json` plus `data/domain/tests`, and created no dedicated bootstrap/static-page/whole-product integration item. |
| F4 | The product has client renderer/hud/effects modules but no index.html, no DOM/canvas use, no static serving route, and no npm start; the server exposes only healthz and 404. |
| F5 | The planner proposed 22 `verificationItems`; the process flow materializes them only after readiness; readiness failed first, so none ran. |
| F6 | Tasks 15-25 are the 11 implementation projections; tasks 26-36 are reviewer projections in the SAME 11 Workplace refs — not duplicate implementation and not graph rematerialization. |
| F7 | One sealed graph exists, and 11 integration commits exist. |
| F8 | The final readiness manifest declared node:20-alpine Docker, and local-runnability failed before install/test/serve with `LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE`. |
| F9 | The served oracle in current code proves only start plus loopback HTTP plus stop — not the correct browser/canvas claim. |
| F10 | The readiness failure produced a seam repair issue, but routing sent `domain.failed` directly to `complete-failed` and terminal; no repair round ran. |

Interpretation (judgment, owned and to be confirmed by the named gap work —
not facts):

- I1 (from F2/F3): AC-22 existed and was only nominally attached to an item
  whose scopes and semantics cannot own whole-product synthesis.
  Deliverable-claim classification authority originates in
  Discovery/Formalization (the Order Constraint Register and
  `coveredConstraintIds` coverage), not in the planner; nothing failed
  planning admission because no mechanical inherited criterion existed to
  fail on — CC-GAP-6.
- I2 (from F1/F4/F9): even had readiness passed, the served oracle would
  have proven only start + loopback HTTP + stop — oracle-insufficient for
  the browser/canvas claim, a distinct outcome from both product-failed and
  substrate-unavailable. The claim had no path to a truthful verdict because
  the `VerificationWarrantRef` warrant-execution network (AC-drift network
  3) is not landed — CC-GAP-7.
- I3 (from F5/F8): required verification obligations proposed by the planner
  vanished from accounting once readiness failed first; deferred obligations
  must remain pending and execute after recovery — CC-GAP-8.
- I4 (from F8/F10): a substrate failure (Docker unavailable) was classified
  and routed as terminal product failure, bypassing the repair round the
  seam repair issue was owed; the typed third outcome
  (`warrant-blocked-environment`) does not exist yet in routing, and
  product-failed vs oracle-insufficient vs substrate-unavailable are not
  preserved as distinct classes — CC-GAP-9.
- I5 (from F6/F7): author and reviewer projections share Workplace refs in
  one sealed graph; status UI that cannot distinguish roles invites the false
  "duplicate work / rematerialized graph" reading — CC-GAP-10.

## Expected vs observed

| Surface / invariant | Expected | Observed | Verdict |
|---|---|---|---|
| Claim fidelity (order -> Discovery -> Formalization) | Rich Chrome canvas game, install + start, browser smoke, local run preserved end to end | Faithfully preserved; AC-22 requires install + start -> accessible running game | OK |
| Claim-to-work coverage | Mechanical: for a non-empty versioned Order Constraint Register, ids − union(coveredConstraintIds) − waived = ∅; SRS §2.2 manifest files inside frozen item scopes; explicit whole-product synthesis ownership; legacy corpora grandfathered | AC-22 nominally attached to `impl-galaxy-ship-foundation` (scopes `package.json` + `data/domain/tests`); no bootstrap/static-page/whole-product item; no inherited mechanical criterion to fail on | **CC-GAP-6** |
| Deliverable-aware end-to-end oracle | Warrant execution over `VerificationWarrantRef` through package-level oracle adapters; loopback health = oracle-insufficient (never pass, never product-failed) | Served oracle proves only start + loopback HTTP + stop; warrant phases unlanded (types/seam only) | **CC-GAP-7** |
| Verification reachability/accounting | Required verification obligations stay pending until executed | 22 proposed `verificationItems` materialize only after readiness; readiness failed first; none ran; none surfaced as pending | **CC-GAP-8** |
| Substrate failure classification | product-failed ≠ oracle-insufficient ≠ substrate-unavailable; substrate routes to deterministic repair or `human_required` continuation (repair round; `warrant-blocked-environment` semantics) | `domain.failed` routed directly to `complete-failed` and terminal; no repair round; no typed substrate outcome | **CC-GAP-9** |
| Role projection | Author vs reviewer tasks distinguishable in status UI | Tasks 26-36 (reviewer projections, same 11 Workplace refs) can be misread as duplicate implementation | **CC-GAP-10** |
| Local-runnability semantics | A failed local-runnability check states what was and was not tested | Failed on Docker unavailability before install/test/serve; browser runnability neither proved nor disproved | Corrected in CC-00B; classification owned by CC-GAP-9 |
| Graph integrity | One sealed graph; integration commits match implementation projections | One sealed graph; 11 integration commits; no rematerialization | OK |

## Stable gaps and owners

- **CC-GAP-6 — semantic claim-to-work coverage.** Owner: planning owner
  (execution); classification authority originates in
  Discovery/Formalization, never in the planner. Reuse and finish the
  existing vocabulary — the versioned Order Constraint Register
  (`factory.order-constraint-register.v1`, stable `ord-c-NNN` ids, classes
  `execution|material|human`), the `coveredConstraintIds` relay
  (kernel-derived from frozen criteria, card-pinned, lineage-echoed), and
  SRS §2.2 module-manifest scope coverage — and invent no parallel
  deliverable-claim vocabulary. A buildable/integrator acceptance criterion
  cannot be discharged by nominal attachment to a semantically insufficient
  item; whole-product synthesis (install -> start -> accessible running
  product) requires explicit ownership (a bootstrap/static-page/serving
  integration item or a declared equivalent) or planning fails closed with a
  typed reason. Mechanical exit criterion: for a non-empty register,
  register ids minus union(coveredConstraintIds) minus typed waivers equals
  the empty set, and every §2.2 manifest-declared file lies inside some
  frozen item change scope. Legacy corpora are versioned and grandfathered
  (no register / no `coveredConstraintIds` / no §2.2 section -> empty diff
  or typed legacy skip, gates stay green, monotone); frozen evidence is
  never rewritten. Blocking regression proof: dropping whole-product
  synthesis ownership (an uncovered non-waived register line behind a
  nominally attached criterion) fails planning admission on the mechanical
  diff.
- **CC-GAP-7 — deliverable-aware end-to-end oracle.** Owner: verification
  owner; lands after CC-GAP-9 outcome/routing. Finish AC-drift network 3 on
  the existing seam: the readiness provider executes warrant phases over the
  existing `VerificationWarrantRef` (register + dispositions,
  digest-pinned) through package-level, workshop-declared oracle adapters —
  no new oracle, no re-reading of order prose; the certifier diffs its
  phases against the frozen register. A browser-product claim requires
  page/static/canvas/browser-smoke evidence; a generic loopback health
  oracle yields oracle-insufficient — never a pass and never a
  product-failed verdict. Blocking regression proof: substituting loopback
  health for the package-level browser oracle yields oracle-insufficient,
  and rendering that as pass or as product-failed both fail verification.
- **CC-GAP-8 — verification reachability/accounting.** Owner: coverage/report
  owner. Proposed required verification obligations may be deferred but must
  remain first-class pending entries, never appear discharged, and must
  execute after readiness recovery. Blocking regression proof: rendering
  deferred verification as discharged fails accounting.
- **CC-GAP-9 — substrate failure classification/recovery.** Owner:
  execution-kernel owner; lands before CC-GAP-7 warrant execution.
  Implement the typed `warrant-blocked-environment` outcome (AC-drift
  network 3) preserving the three distinct classes product-failed,
  oracle-insufficient, and substrate-unavailable; infrastructure
  unavailable (for example Docker unavailable) is distinct from product
  failure and must route to deterministic repair or `human_required`
  continuation — including a repair round for the seam repair issue — not
  terminal product failure. Legacy records are grandfathered, never
  reclassified. Blocking regression proof: routing substrate failure to
  terminal product failure fails routing, and collapsing the three outcome
  classes into one fails classification.
- **CC-GAP-10 — role projection clarity.** Owner: trace/evidence owner.
  Author and reviewer tasks must be distinguishable in status UI; tasks 26-36
  were reviewer projections in the same 11 Workplace refs, not duplicate
  implementation and not graph rematerialization. Blocking regression proof:
  rendering reviewer projections as duplicate implementation work fails
  projection.

## Remediation vocabulary (reuse-first, domain-free, no frontend hardcoding)

Corrected per independent review: CC-GAP-6/7/9 remediation invents no
parallel deliverable-claim vocabulary — no new "deliverable claim
descriptors", no new "semantic coverage receipts", no second oracle
registry. It reuses and finishes the existing AC-drift three-network design
(`docs/architecture/AC-DRIFT-REMEDY-DESIGN.md`):

- **Order Constraint Register (existing, shared register source)** —
  `factory.order-constraint-register.v1`, stable `ord-c-NNN` ids, classes
  `execution|material|human`, extracted at discovery settlement and
  digest-pinned (`src/shared/constraint-register.ts`). This counted
  register IS the deliverable-claim vocabulary; CC-GAP-6 consumes it and
  finishes its enforcement, it does not replace it. Versioning and
  grandfathering are built in: a proposal without `order_constraints`
  builds no register, every downstream diff is empty, and existing gates
  stay green (monotone, legacy corpora never break).
- **coveredConstraintIds (existing, network-2 relay)** — kernel-derived per
  item from frozen criteria, card-pinned
  (`cell_input_item.coveredConstraintIds`), verification-lineage-echoed. The
  reverse diff — register ids minus covered minus waived = ∅ — is the
  mechanical exit criterion. This IS the semantic coverage mechanism;
  CC-GAP-6 finishes it (SRS/baseline coverage plus planning-admission
  fail-close) instead of inventing "coverage receipts".
- **SRS §2.2 module-manifest scope coverage (existing)** — the task-graph
  gate already evaluates manifest-declared files against frozen item change
  scopes with typed legacy skips (`srs-module-manifest-skip`) and fail-closed
  gaps (`srs-module-uncovered`); CC-GAP-6 extends this seam, not a new scope
  vocabulary.
- **VerificationWarrantRef (existing seam, network 3)** — register +
  dispositions, digest-pinned, cited by the Formalization settlement into
  the settlement/formalization certificate
  (`formalization-production-cell-installation.ts`). The
  `DevelopmentReadinessManifest` carries a matching optional `warrantRef`
  (`development-schemas.ts`), but no code path populates it today;
  CC-GAP-7 lands that citation plus the warrant-execution phases in the
  readiness provider consuming exactly this shape — no new oracle, no
  re-reading of order prose; the certifier diffs its phases against the
  frozen register.
- **`warrant-blocked-environment` (designed typed outcome, network 3)** —
  CC-GAP-9's substrate-unavailable outcome, preserving the three distinct
  classes product-failed vs oracle-insufficient vs substrate-unavailable;
  routing to deterministic repair or `human_required` continuation with an
  operator waive channel, never a silent substitution and never terminal
  product failure for a machine fault.
- **Package-level oracle adapters (existing package model)** — oracle
  adapters are workshop-package declarations (LEGO principle — Conveyor
  Mental Model §3; no-workshop-branch rule — master plan §4). Browser,
  canvas, or any frontend specifics arrive exclusively
  through workshop-declared data — register lines and package-level oracle
  adapters — never through engine or test-engine branches on workshop name,
  `moduleRef`, or role profession.

All five gaps land universal scenario DSL facts. CC-GAP-6/7/9 add no
parallel deliverable-claim vocabulary — no claim descriptors, no coverage
receipts, no second oracle registry: their scenario DSL facts project the
existing register ids, `coveredConstraintIds`, and
`VerificationWarrantRef`. CC-GAP-8/10 add the accounting/role facts:
deferred verification accounting entries (proposed -> pending -> executed,
never silently discharged) and role-projection clarity (author vs reviewer
over shared Workplace refs).

## Blocking mutations

One per gap; each must make the blocking group red. Land and prove order:
CC-GAP-9 before CC-GAP-7 (warrant execution consumes the outcome/routing
the CC-GAP-9 mutation protects):

1. CC-GAP-6 mutation: drop the whole-product synthesis coverage (remove the
   covering `coveredConstraintIds`/register line) while keeping AC-22
   nominally attached — the mechanical reverse diff must fail planning
   admission with the typed reason.
2. CC-GAP-7 mutation (after CC-GAP-9): replace the package-level browser
   oracle adapter with the generic loopback health oracle for a
   browser-product claim — warrant execution must report
   oracle-insufficient; rendering it as pass or as product-failed must both
   fail.
3. CC-GAP-8 mutation: render unexecuted deferred verificationItems as
   discharged — accounting must fail.
4. CC-GAP-9 mutation (lands before CC-GAP-7): route
   `LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE`-class substrate failure directly
   to `complete-failed` terminal — routing must fail (repair or
   `human_required` continuation required), and collapsing product-failed,
   oracle-insufficient, and substrate-unavailable into one outcome must
   fail classification.
5. CC-GAP-10 mutation: render reviewer projections (tasks 26-36 shape) as
   duplicate implementation tasks or a second graph — projection must fail.

## Critical-path impact

- `CC-00 -> CC-00B -> CC-00C -> CC-10A` is the critical path. CC-10A code may
  remain landed, but the CC-10A exit checklist and its deferred heavy
  validation cannot close before CC-00B and CC-00C exit.
- Within CC-00C, CC-GAP-9 outcome/routing is serialized before CC-GAP-7
  warrant execution; CC-GAP-6 proceeds under the planning owner, serialized
  through the plan's single-writer `Constraint register and warrant seam` row
  where files overlap.
- K0, K2, K4, K5, and K8 exit evidence is incomplete while any CC-GAP-6..10
  is open (plan §2 stage table and §3.2 wiring).
- CC-80 cannot compose a complete qualification command with any CC-GAP-6..10
  open; CC-81 must record each open gap and stay RED; CC-82 cannot emit
  `QUALIFICATION_GREEN` with any of them open; the Qualification-ready
  definition of done requires CC-00C closed.

## Safe next actions

- Freeze the Elite-6 product-claim evidence copy-only (formalization
  acceptance-criteria set including AC-22; the planner task graph with tasks
  15-36, their roles, and the 11 shared Workplace refs; the one sealed graph
  and 11 integration commits; the 22 proposed verificationItems; the
  readiness manifest declaring node:20-alpine Docker; the
  `LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE` failure record), with recorded paths
  and digests; keep frozen sources immutable.
- Implement CC-GAP-6..10 remediation in isolated worktrees under the named
  owners, each with its blocking mutation. CC-GAP-9 outcome/routing lands
  before CC-GAP-7 warrant execution; CC-GAP-6/7/9 reuse the existing Order
  Constraint Register, `coveredConstraintIds`, SRS §2.2 module-manifest
  coverage, and `VerificationWarrantRef` seam — no parallel
  deliverable-claim vocabulary is created.
- Track the missing browser frontend as a separately owned latent product
  defect with its own remediation path (a new change request or
  continuation), not as the readiness failure and not inside CC-00C runtime
  scope.
- Extend the universal scenario DSL and blocking mutation set strictly per
  the reuse-first list above; verify zero universal engine/test-engine
  frontend branches.

## Unsafe next actions

- Do not reopen, replay, or re-open the terminal Elite-6 run to "fix"
  product-claim accounting or projections.
- Do not report the local-runnability failure as having tested the product:
  it failed on Docker unavailability before install/test/serve and neither
  proved nor disproved browser runnability.
- Do not conflate substrate unavailability with product failure, and do not
  present the missing frontend as the observed readiness failure; they are
  two distinct findings.
- Do not weaken, rename, re-scope, or silently drop AC-22 or any other
  acceptance criterion to make coverage close.
- Do not hardcode browser/canvas/frontend specifics into universal engine or
  test-engine files; deliverable semantics arrive only through
  workshop-declared package data — register lines and package-level oracle
  adapters.
- Do not treat tasks 26-36 as duplicate work to deduplicate or delete; they
  are reviewer projections over the same sealed graph.
- Do not invent parallel deliverable-claim vocabulary — no new claim
  descriptors, coverage receipts, or second oracle registry beside the
  existing Order Constraint Register, `coveredConstraintIds`, SRS §2.2
  module-manifest coverage, and `VerificationWarrantRef` seam.
- Do not land CC-GAP-7 warrant execution before CC-GAP-9 outcome/routing:
  warrant phases must never meet a substrate failure without the typed
  `warrant-blocked-environment` outcome and its repair/`human_required`
  routing already in place.

## The runtime is not fixed

This document records classification, facts, and gaps only. As of this
record, CC-GAP-6..10 are open: nothing in CC-00C documentation repairs the
runtime, builds the missing frontend, or reclassifies any durable Elite-6
state. The Elite-6 experiment is complete and immutable, and product
qualification failed. Remediation belongs to the named gap owners under the
plan's CC-00C checklists and exit criteria.
