# settle-formalization desk (reviewer) - refusal emission (stray-products-r7)

Emission of record: **FR-Settle-Formalization-Reviewer-001** (verdict
`hold-upheld`; frame upstream-accepted claim REFUSED; no solution-contract
product verdict minted; `effectFired: false`).

- Review: sha256:82af3f8ffeb77f560649e59d99d98722411060889695c3683ac6b5665a6c6941
- Verification: sha256:6dad7278358bcc9d94c87941a74866fcb2922aa3e73a265b8bc61429abd882b5
- Trace: sha256:789d1cd803eee78f035ddb4d0084c0732a581164a2b6deb1b01dbc1f24649d22
- Submission: sha256:ceb9f8a0d9403a42ae5fe723536659f9e698b4085b57acf14fa5e2485293001c
- Independent verifier: 30/30 green (`-verify-out.json`, self-digested
  `4210e677...`)

## Why the reviewer seat holds and refuses

The reviewed candidate of record is the r6 author-seat settlement upstream hold
**UH-Settle-Formalization-001** (`b40d7616...` / trace `f7ee0830...`,
`hold-no-authoring`, `noProductAuthored: true`, census 0 of 7, verifier 48/48):
it re-derives byte-stable and is **upheld**. NO solution-contract candidate
exists at this desk - none was ever lawfully authorable - so the
accepted/rejected verdict vocabulary stays uncomputed over the absent sealed
subject (the installed reviewer route binds its verdict to the exact sealed
artifact + canonical digest), exactly as the desk's first reviewer-stage record
(the testbed **UH-Settle-Formalization-002**, `792b6ce0...`, hold-no-review,
typedWait external-availability, verifier 34/34) required. This package is
minted because NEW adjudication content exists since that record: (a) the r6
qualification-round author hold re-emission (census 0 of 7, verifier 48/48);
(b) the immediate upstream gate now carries a REVIEWER refusal of record -
FR-Define-Architecture-Contract-001 (`d813908b...`, verifier 53/53), which the
prior record could not see; (c) the frame address now HAS textual mentions -
exactly its own prior adjudication set - while still resolving to zero
contents; (d) the testbed round's second consecutive author hold
UH-Settle-Formalization-003 (`7ce5eb48...`, envelope byte-equal to hold #1:
ZERO upstream-accepted entries, verifier 28/28).

## The frame's authority claim: REFUSED (desk-own-revision phantom)

The frame projects `upstream-accepted[0] sha256:d751f194... :: "accepted
revision of settle-formalization"` with the line *"workspace: 1 accepted
upstream revisions travel by content address"* - adjudicated **FALSE** on
three independent grounds:

1. **Content-unresolved** - a workspace-wide three-body scan (raw bytes,
   whole-JSON canonical, `.content` canonical; 2829 files, this round
   excluded) hash-resolves the address to ZERO contents. Its 6 textual
   mentions live only in this desk's own phantom-adjudication families (the
   testbed settle reviewer-hold set; the testbed second author hold's
   verifier, whose F1 check names it the settle-own-revision phantom). At
   the address's debut staffing it had ZERO mentions of any kind.
2. **Process-impossible** - the desk of record authors no product: all four
   author emissions are `hold-no-authoring` with `product_submit` unused; no
   settle gate has ever returned outcome `formalized`; no intake receipt, no
   sealed contract, no reviewer verdict exists anywhere for this desk.
3. **Wrong-referent** - the entry names THIS desk's own revision, while
   settlement consumes the frozen whole-WHAT baseline + the accepted SRS
   revision + the authored desk inputs (twelve-kind handoff,
   post-freeze repository/policy refs) over the single inbound edge
   `define-architecture-contract --domain.accepted--> settle-formalization`,
   which has never lawfully fired. A desk-own projection supplies no
   reviewable subject.

The count delta from the author frames (0 -> 1) is stage-relative shell
projection, not kernel supply: the lawful recomputed supply remains **0 of 7**
accepted upstream desks. Family: the desk-own-revision phantom class (r2
ADV-4) now spans four desks - requirements `65fe9a22...`, acceptance
`32892970...`, architecture `b7f34c48...`, settlement `d751f194...` - each
variant debuting at that desk's reviewer staffing with a per-stage regenerated
address.

## Verified alongside (all recomputed, nothing trusted)

- Envelope 8/8 re-derives from the accepted discovery-import capsule (9/9 with
  CERT-1) - still the only accepted base.
- Frame skill pins (`bc8a4261...`/`2cbcf850...` - the reviewer drift pair,
  byte-equal at both settle reviewer staffings) resolve to zero contents;
  installed manifest pins recompute (`b88267a1...`/`b130ee25...`) and differ -
  provenance, never ratified. The author-frame anchor `a926df6284...` remains
  unresolvable (inherited debt; NOT pinned by this frame).
- The freeze gate recomputes: ratification REFUSED by
  FR-Freeze-What-Baseline-002 (`d52746b6...`, effect never fired), standing
  hold `9f2d28b9...` with AS/RC confirmations, the no-accept prohibition of
  FR-Reconcile-What-001 (`39a94a29...`) undischarged.
- The r1 reviewer-seat stray family of this desk recomputes at the raw-bytes
  layer exactly as retired (decision unparseable `ad698a85...`, label
  pseudo-addresses, phantom candidate set `f975e878...` + 7 invented refs) -
  never lineage.
- The installed desk contract re-derives from source: kernel node,
  `frf-contracts.solution-contract.v1`,
  `formalization.settlement-structure.v1`/`settleSolutionContract`, the R1/R2
  settlement ladder with MISSING_LINEAGE -> failed routing, and the reviewer
  route law ("the reviewer never produces the baseline/contract itself; the
  verdict is the reviewer's only product").

## Resume contract

R1-R5 of the r6 author hold unchanged: the freeze desk R1-R4 completes first
(five genuinely accepted pre-freeze desks -> RA-5 reconcile-what re-run ->
freeze ratified); the SRS desk re-staffs against the REAL frozen baseline and
passes a completed reviewer stage (`d813908b...` is the current gate state);
this desk re-staffs only with ALL FIVE settlement input classes; settlement
runs the ladder exactly (pins -> binding resolution -> seal; A2 fence); the
holds, the prior reviewer hold and this refusal are never carried as product
lineage, and the r1 reviewer-seat stray family stays retired.
