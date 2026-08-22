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
  need append-only criterion-key accounting in which pending survives
  readiness failure and continuation, `executed(failed)` is not discharged,
  only a passed receipt or an operator-attributed waiver discharges, and
  entries carry stage/order visibility — CC-GAP-8.
- I4 (from F8/F10): a substrate failure (Docker unavailable) was classified
  and routed as terminal product failure, bypassing any in-factory
  substrate handling; the ADR-089 contract — bounded deterministic in-check
  substrate retry, then typed unknown and `human_required`
  blocked/resumable, never product-failed, with unknown receipts never
  poisoning a later pass — does not exist yet in routing, and
  product-failed vs oracle-insufficient vs substrate-unavailable are not
  preserved as distinct classes — CC-GAP-9.
- I5 (from F6/F7): author and reviewer projections share Workplace refs in
  one sealed graph and the durable projections are correct; the defect is
  rendering-only — board and detail surfaces that do not display role
  invite the false "duplicate work / rematerialized graph" reading —
  CC-GAP-10.

## Expected vs observed

| Surface / invariant | Expected | Observed | Verdict |
|---|---|---|---|
| Claim fidelity (order -> Discovery -> Formalization) | Rich Chrome canvas game, install + start, browser smoke, local run preserved end to end | Faithfully preserved; AC-22 requires install + start -> accessible running game | OK |
| Claim-to-work coverage | Mechanical: for a non-empty versioned Order Constraint Register, ids − union(coveredConstraintIds) − waived = ∅; SRS §2.2 manifest files inside frozen item scopes (a missing or file-less §2.2 is typed red, never a skip); execution-entrypoint files owned by items covering that same constraint (no wide decoy item); coveredConstraintIds kernel-derived, unforgeable from planner output; only registerless corpora grandfathered (ADR-088) | AC-22 nominally attached to `impl-galaxy-ship-foundation` (scopes `package.json` + `data/domain/tests`); no bootstrap/static-page/whole-product item; no inherited mechanical criterion to fail on | **CC-GAP-6** |
| Deliverable-aware end-to-end oracle | Warrant execution over `VerificationWarrantRef` through package-level oracle adapters; loopback health = oracle-insufficient (never pass, never product-failed) | Served oracle proves only start + loopback HTTP + stop; warrant phases unlanded (types/seam only) | **CC-GAP-7** |
| Verification reachability/accounting | Append-only criterion-key accounting: required obligations stay first-class pending entries (surviving readiness failure and continuation); `executed(failed)` is not discharged; only a passed receipt or an operator-attributed waiver discharges; stage/order visibility; no reuse of the transition obligation ledger | 22 proposed `verificationItems` materialize only after readiness; readiness failed first; none ran; none surfaced as pending | **CC-GAP-8** |
| Substrate failure classification | product-failed ≠ oracle-insufficient ≠ substrate-unavailable; substrate gets bounded deterministic in-check retry, then typed unknown and `human_required` blocked/resumable (`warrant-blocked-environment` per ADR-089) — never product-failed; unknown receipts never poison a later pass | `domain.failed` routed directly to `complete-failed` and terminal; no repair round; no typed substrate outcome (the provider encodes Docker-unavailable as `failed`) | **CC-GAP-9** |
| Role projection | Author vs reviewer role displayed on board and detail surfaces (durable projections correct; rendering-only) | Board/detail render tasks 26-36 (reviewer projections, same 11 Workplace refs) without role, misreadable as duplicate implementation | **CC-GAP-10** |
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
  the empty set, every §2.2 manifest-declared file lies inside some frozen
  item change scope, and every entrypoint file declared by an
  execution-class register entry lies inside the frozen change scopes of an
  item whose kernel-derived `coveredConstraintIds` include that same entry
  — a wide decoy item containing the file while covering no such
  constraint does not satisfy it. `coveredConstraintIds` is strictly
  kernel-derived from frozen criteria; planner proposals can neither carry
  nor forge it. Grandfathering is register-conditional (ADR-088): only a
  corpus with no constraint register is grandfathered (empty diff, typed
  legacy skip, gates stay green, monotone; frozen evidence is never
  rewritten); when a non-empty register exists, missing coverage and a
  missing or file-less §2.2 manifest are typed red, never a legacy skip.
  Blocking regression proofs: dropping whole-product synthesis ownership
  (an uncovered non-waived register line behind a nominally attached
  criterion) fails planning admission on the mechanical diff; a missing or
  file-less §2.2 manifest under a non-empty register is typed red; a wide
  decoy item fails entrypoint ownership; a forged planner
  `coveredConstraintIds` set cannot alter the kernel-derived relay.
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
  owner. Proposed required verification obligations may be deferred but
  never vanish from accounting: implement an append-only criterion-key
  accounting ledger — one first-class entry per required verification
  obligation keyed by criterion, transitions appended
  (`proposed -> pending -> executed(passed|failed) | unknown | waived`),
  entries never rewritten or deleted. Pending survives readiness failure
  and continuation and must execute after recovery. `executed(failed)` is
  not discharged — the obligation stays outstanding. Only a passed
  receipt or an operator-attributed waiver discharges. Every entry
  carries and displays its stage and order coordinates. Do not reuse the
  lifecycle transition obligation ledger for this role — verification
  accounting is a separate seam. Blocking regression proofs: rendering
  unexecuted deferred verification as discharged fails accounting;
  rendering `executed(failed)` as discharged fails accounting; dropping a
  pending entry across readiness failure or continuation fails
  accounting; discharging without a passed receipt or an
  operator-attributed waiver fails accounting; hiding stage/order
  coordinates fails accounting.
- **CC-GAP-9 — substrate failure classification/recovery.** Owner:
  execution-kernel owner; lands before CC-GAP-7 warrant execution, per
  ADR-089. A missing environment precondition (for example Docker
  unavailable) gets bounded deterministic in-check substrate retry — a
  frozen attempt bound and schedule inside the check, no model, no
  WorkerExecution, no CandidateSet, no repair epoch, no worker repair
  budget consumed. On exhaustion the check emits the typed unknown
  outcome (`warrant-blocked-environment`) — never passed, never failed —
  and the scope routes to a `human_required` blocked/resumable
  continuation (a truthful typed wait with a wake source), never to
  terminal product failure. Product-failed, oracle-insufficient, and
  substrate-unavailable remain distinct typed classes. An earlier unknown
  receipt never prevents, fails, annotates, or counts against a later
  pass of the same criterion (no-poison; discharge requires a passed
  receipt or an operator-attributed waiver, CC-GAP-8). Legacy records are
  grandfathered, never reclassified. Blocking regression proofs: routing
  substrate failure to terminal product failure fails routing; collapsing
  the three outcome classes into one fails classification; skipping the
  bounded in-check retry straight to escalation or terminalization, or
  retrying unboundedly, fails routing; charging an exhausted retry to
  worker repair budget or CandidateSets fails isolation; an earlier
  unknown receipt blocking or failing a later passed receipt for the same
  criterion fails the no-poison rule.
- **CC-GAP-10 — role projection clarity.** Owner: trace/evidence owner.
  The defect is rendering-only: the durable author/reviewer projections
  are correct (tasks 15-25/26-36 are author and reviewer projections over
  the same 11 Workplace refs in one sealed graph — not duplicate
  implementation and not graph rematerialization). Board and task-detail
  surfaces must display the role (author vs reviewer) alongside the
  shared Workplace identity. No deduplication and no data rewrite: the
  durable projections and the sealed graph are untouched. Blocking
  regression proofs: rendering reviewer projections as duplicate
  implementation work or a second graph fails projection; a board or
  detail surface that omits or hides the role fails projection; a "fix"
  that deduplicates or rewrites the durable projections instead of the
  rendering fails projection.

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
  grandfathering are built in and, per ADR-088, strictly
  register-conditional: a proposal without `order_constraints` builds no
  register, every downstream diff is empty, and existing gates stay green
  (monotone, registerless corpora never break) — and this is the SOLE
  grandfather condition: a non-empty register makes missing coverage and a
  missing or file-less §2.2 manifest typed red.
- **coveredConstraintIds (existing, network-2 relay)** — kernel-derived per
  item from frozen criteria, card-pinned
  (`cell_input_item.coveredConstraintIds`), verification-lineage-echoed. The
  reverse diff — register ids minus covered minus waived = ∅ — is the
  mechanical exit criterion. This IS the semantic coverage mechanism;
  CC-GAP-6 finishes it (SRS/baseline coverage plus planning-admission
  fail-close) instead of inventing "coverage receipts". Per ADR-088 the
  derivation is strictly kernel-side: the planner proposal shape must not
  re-admit the field (today `DevelopmentTaskGraphProposalItem` re-adds it
  and `canonicalItems` lets a planner-supplied set survive when inherited
  coverage is empty), and decode/canonicalization must discard any
  planner-supplied value so the reverse diff can never be forged green.
- **SRS §2.2 module-manifest scope coverage (existing)** — the task-graph
  gate already evaluates manifest-declared files against frozen item change
  scopes with typed legacy skips (`srs-module-manifest-skip`) and fail-closed
  gaps (`srs-module-uncovered`); CC-GAP-6 extends this seam, not a new scope
  vocabulary. Per ADR-088 the skip becomes register-conditional: with a
  non-empty register, an absent §2.2 section, a file-less manifest, or an
  unavailable SRS is typed red (`srs-module-manifest-missing`), and the
  legacy skip survives only for registerless corpora. Execution-class
  entrypoint ownership rides the same seam: each declared entrypoint file
  must lie inside the change scopes of an item whose kernel-derived
  `coveredConstraintIds` include that same constraint (typed reason
  `constraint-entrypoint-unowned`; a wide decoy item must not satisfy it).
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
- **`warrant-blocked-environment` (designed typed outcome, network 3,
  ADR-089)** — CC-GAP-9's substrate-unavailable contract, preserving the
  three distinct classes product-failed vs oracle-insufficient vs
  substrate-unavailable: bounded deterministic in-check substrate retry
  first (frozen bound and schedule; no model, no WorkerExecution, no
  CandidateSet, no repair epoch, no repair budget), then the typed
  unknown outcome on exhaustion and a `human_required` blocked/resumable
  continuation with an operator waive channel — never a silent
  substitution, never a deterministic repair round for a machine fault,
  never unbounded silent retry, and never terminal product failure.
  Unknown receipts never poison a later pass of the same criterion;
  discharge requires a passed receipt or an operator-attributed waiver.
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
append-only criterion-key verification accounting entries (proposed ->
pending -> executed(passed|failed) | unknown | waived; `executed(failed)`
not discharged; discharge only by a passed receipt or an
operator-attributed waiver; stage/order visibility; never silently
discharged; no reuse of the lifecycle transition obligation ledger) and
role-projection clarity (rendering-only: author vs reviewer displayed
over the shared Workplace refs on board and detail surfaces; durable
projections untouched — no deduplication, no data rewrite).

## Blocking mutations

At least one per gap (CC-GAP-6 carries the four ADR-088 variants;
CC-GAP-9 carries the ADR-089 variants); each must make the blocking group
red. Land and prove order: CC-GAP-9 before CC-GAP-7 (warrant execution
consumes the outcome/routing the CC-GAP-9 mutations protect — bounded
in-check retry, typed unknown, human_required blocked/resumable, and
no-poison accounting must already be in place):

1. CC-GAP-6 mutations (ADR-088):
   a. drop the whole-product synthesis coverage (remove the covering
      `coveredConstraintIds`/register line) while keeping AC-22 nominally
      attached — the mechanical reverse diff must fail planning admission
      with the typed reason;
   b. under a non-empty register, remove the SRS §2.2 manifest (or make it
      file-less) — the gate must go typed red, never
      `srs-module-manifest-skip`;
   c. attach a wide decoy item whose change scopes contain an
      execution-class entrypoint file while covering no such constraint —
      entrypoint ownership must fail with the typed reason;
   d. inject a planner-proposed `coveredConstraintIds` set — the
      kernel-derived relay must be unchanged (the forged set cannot reach
      the frozen item or the reverse diff).
2. CC-GAP-7 mutation (after CC-GAP-9): replace the package-level browser
   oracle adapter with the generic loopback health oracle for a
   browser-product claim — warrant execution must report
   oracle-insufficient; rendering it as pass or as product-failed must both
   fail.
3. CC-GAP-8 mutations (append-only criterion-key accounting):
   a. render unexecuted deferred verificationItems as discharged —
      accounting must fail;
   b. render `executed(failed)` as discharged — accounting must fail;
   c. drop a pending entry across readiness failure or lifecycle
      continuation — accounting must fail;
   d. discharge an obligation without a passed receipt or an
      operator-attributed waiver — accounting must fail;
   e. hide an entry's stage/order coordinates from its status projection —
      accounting must fail.
4. CC-GAP-9 mutations (ADR-089; lands before CC-GAP-7):
   a. route `LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE`-class substrate failure
      directly to `complete-failed` terminal — routing must fail (typed
      unknown plus `human_required` blocked/resumable continuation
      required);
   b. collapse product-failed, oracle-insufficient, and
      substrate-unavailable into one outcome — classification must fail;
   c. skip the bounded deterministic in-check retry (escalate or
      terminalize on first substrate miss) or retry unboundedly/silently —
      routing must fail;
   d. charge an exhausted in-check retry to worker repair budget or let it
      produce a CandidateSet/repair epoch — isolation must fail;
   e. let an earlier unknown receipt prevent, fail, or annotate a later
      passed receipt for the same criterion (poison) — accounting/routing
      must fail.
5. CC-GAP-10 mutations (rendering-only): render reviewer projections
   (tasks 26-36 shape) as duplicate implementation tasks or a second
   graph — projection must fail; render the board or the task-detail
   surface without the author/reviewer role for tasks sharing one
   Workplace ref — projection must fail; "fix" the defect by
   deduplicating or rewriting the durable projections instead of the
   rendering — projection must fail (the durable projections and the
   sealed graph are untouched).

## Critical-path impact

- `CC-00 -> CC-00B -> CC-00C -> CC-10A` is the critical path. CC-10A code may
  remain landed, but the CC-10A exit checklist and its deferred heavy
  validation cannot close before CC-00B and CC-00C exit.
- Within CC-00C, CC-GAP-9 outcome/routing is serialized before CC-GAP-7
  warrant execution (ADR-089); CC-GAP-6 proceeds under the planning owner,
  serialized
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
  owners, each with its blocking mutation set (CC-GAP-6 follows the
  register-conditional contract of ADR-088; CC-GAP-9 follows the bounded
  in-check retry / typed unknown / human_required blocked-resumable /
  no-poison contract of ADR-089; CC-GAP-8 lands the append-only
  criterion-key ledger without reusing the transition obligation ledger;
  CC-GAP-10 is rendering-only — board/detail role display, no
  deduplication, no data rewrite). CC-GAP-9 outcome/routing lands
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
  are reviewer projections over the same sealed graph, and the durable
  projections are correct — CC-GAP-10 fixes rendering only (board/detail
  role display), never the data.
- Do not invent parallel deliverable-claim vocabulary — no new claim
  descriptors, coverage receipts, or second oracle registry beside the
  existing Order Constraint Register, `coveredConstraintIds`, SRS §2.2
  module-manifest coverage, and `VerificationWarrantRef` seam.
- Do not reuse the lifecycle transition obligation ledger for verification
  accounting: CC-GAP-8's criterion-key ledger is a separate seam.
- Do not render an unknown (`warrant-blocked-environment`) receipt as
  `passed` or as `failed` on any surface, and never let an earlier unknown
  block or fail a later pass of the same criterion (ADR-089 no-poison).
- Do not land CC-GAP-7 warrant execution before CC-GAP-9 outcome/routing:
  warrant phases must never meet a substrate failure without the ADR-089
  contract — bounded in-check substrate retry, the typed
  `warrant-blocked-environment` unknown outcome, and its
  `human_required` blocked/resumable routing — already in place.

## The runtime is not fixed by this record

This document records classification, facts, and gaps only; remediation
ownership belongs to the named gap owners under the plan's CC-00C
checklists and exit criteria. The Elite-6 experiment is complete and
immutable, and product qualification failed.

### Integration status (2026-08-22, sixth-pass update — branch truth, not closure)

Remediation commits on the integration branch
`cc/CC-00B-terminal-integrity-integration` (HEAD `50824c6a`):

| Gap | Landing |
|---|---|
| CC-GAP-6 (semantic claim-to-work coverage) | `50824c6a` — ADR-088 contract: reverse diff `constraint-register-uncovered`, register-conditional `srs-module-manifest-missing`, entrypoint-ownership conjunction `constraint-entrypoint-unowned`, kernel-only `coveredConstraintIds` relay; blocking mutations (a)-(d) proven bidirectionally |
| CC-GAP-8 (verification accounting) | `8819e360` — append-only criterion-key ledger with trigger-enforced UPDATE/DELETE rejection, integrity guard, blocking mutations (a)-(e) |
| CC-GAP-10 (role projection) | `184b2c77` — rendering-only board/detail author/reviewer role display |
| Proof-token direction repairs (shared seam) | `3be7393d` — acceptance-contract v2.1.0 uncovered-residue repair + SRS §D2↔AC residues (see ADR-090) |
| CC-GAP-9 (substrate classification/recovery) | implementation EXISTS at `736621af` + `d3026cbe` (post-REJECT repair: start-of-check docker cache invalidation, obligation pin 1.11.0) on `cc/CC-GAP-9-substrate-typed-unknown` — NOT integrated |
| CC-GAP-9 residual (ADR-091 TOCTOU re-probe) | OPEN — NOT implemented, documentation only: ADR-091 (accepted 2026-08-22) prescribes the provider `1.12.0` mechanical re-probe (on mid-check executor/compose failure, invalidate the cached availability probe and re-probe; only the OBSERVED re-probe routes — never stderr guessing; blocking mutations (a)-(f) wired into CC-10B/CC-80). No ADR-091 landing commit exists on any branch. Owed BEFORE any production factory run and BEFORE CC-GAP-7 warrant execution |
| CC-GAP-7 (deliverable-aware oracle) | OPEN — no warrant-execution landing |

Landing is not closure, and this update marks nothing merged: none of
these commits is merged to `saga4`, the CC-00C exit checklist (evidence
freeze, GAP-9 integration and re-audit, the ADR-091 residual landing and
its blocking proofs, GAP-7 landing and its blocking proofs) has not
passed, and neither this record, CC-00B, nor the plan is merged.
CC-80/CC-81/CC-82 must still verify every exit item; with
CC-GAP-7 open, CC-GAP-9 unintegrated, and the CC-GAP-9 residual
(ADR-091) not implemented, CC-00C is NOT closed.

### CC-GAP-9 residual — ADR-091 TOCTOU re-probe (OPEN, seventh-pass note)

ADR-091 (`docs/architecture/decisions/091-readiness-substrate-toctou-reprobe.md`,
accepted 2026-08-22) is ACCEPTED BUT NOT IMPLEMENTED — it is a
documentation landing only. The residual it names is OPEN on this record:

- **What is owed:** on a mid-check executor/compose failure, invalidate
  the cached docker availability probe and mechanically re-probe the
  daemon; classification rides ONLY the observed re-probe (observed
  unavailable/not-linux → the existing ADR-089 bounded retry/typed
  unknown `warrant-blocked-environment` + human_required
  blocked/resumable; observed available+linux → a bad
  image/tag/config/product stays product `failed`); no stderr text
  guessing; compose `down` best-effort and distinct from invalid config;
  collapse guard; provider pin `1.12.0` with the digest fence and trust
  migration (this branch pins `1.10.0`; the unintegrated CC-GAP-9
  landing pins `1.11.0`; the residual lands as `1.12.0` on top;
  obligation compiler pin `factory.local-runnability.v1` @ `1.12.0` — a
  TARGET after implementation, not a present-tense fact).
- **When it must land:** BEFORE any production factory run and BEFORE
  CC-GAP-7 warrant execution (normative sequencing; blocking mutations
  (a)-(f) are wired into CC-10B/CC-80 and stay RED until it lands).
- **Truth:** no implementation commit exists on any branch as of this
  update; nothing here implies a landing or an integration.

### Substrate role split (ADR-083 boundary note, sixth pass)

Environment identity and environment availability are different owners
and must not drift: ADR-083/K19 owns declared/observed/authorized
environment identity (`DerivedExecutionEnvironment`,
`environmentDigest`, image/toolchain implementation digests, and the
floating-tag prohibition); CC-GAP-9 owns AVAILABILITY only (bounded
in-check retry, typed unknown `warrant-blocked-environment`,
human_required blocked/resumable — never an identity decision); CC-GAP-7
warrant execution CONSUMES the `environmentDigest` and receipt-binds it
(the readiness receipt binds the digest it ran under) and never
authorizes environment identity. The K19 image/digest remainder is
sequenced before CC-GAP-7 receipt-binding, with an honest fallback if it
has not landed (bind the derivation-core `environmentDigest` and record
honestly that image/dependency digest persistence is not yet available;
never a fabricated digest; never a floating tag).

### Latent product defects recorded for conservation mapping (sixth pass)

Two latent product defects are recorded as evidence — both outside
CC-00C runtime scope, with their own remediation paths (new change
request or continuation), and the frozen Elite-6 product is NOT
rewritten:

1. The missing browser frontend (client renderer/hud/effects modules
   exist, but no index.html, no DOM/canvas use, no static serving route,
   no npm start; the server exposes only healthz and 404).
2. The dynamic-pricing latent defect — recorded as BOTH
   idea-conservation and product behavior evidence (ADR-090 Context):
   the exact pricing algorithm was UNKNOWN at Discovery (a genuine
   proposal unknown that died unconsumed), and the shipped frozen
   product carried `basePrice` constants with argument-level tests that
   did NOT prove per-system pricing variation. No new runtime token is
   created for it: it is covered by the ADR-090 open-question and
   mechanics obligations (`formalization.unknowns-owned`,
   `formalization.mechanics-spec-required`).
