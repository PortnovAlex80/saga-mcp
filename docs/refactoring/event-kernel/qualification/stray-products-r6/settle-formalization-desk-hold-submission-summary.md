# settle-formalization desk (author) - settlement upstream hold (stray-products-r6)

Emission of record: **UH-Settle-Formalization-001** (formalization.upstream-hold.v1,
decision `hold-no-authoring`, noProductAuthored: true).

- Artifact: sha256:b40d7616bb607ccfe389258829d304f065e1cac46888b6541c3c5c35b8402251
- Trace: sha256:f7ee0830d5812841dc70417fc3143a8030fadfd5d1018871aaab40c60c1b3bae

## Why this desk authors nothing

The desk's only lawful output is the sealed solution contract
(`frf-contracts.solution-contract.v1`, provider
`formalization.settlement-structure.v1`/`settleSolutionContract`, effect
`formalization.settle-solution-contract`), settled over the single inbound edge
`define-architecture-contract --domain.accepted--> settle-formalization` through
the three-rung ladder: R1 authority-pins (all five input classes:
frozenBaseline, baselineArtifact, srs, repositoryPolicyRefs, handoff -
settlement never discovers authorities), R2 binding-resolution (the twelve
handoff kinds non-empty and resolved against the frozen developmentSurface
declaration; FOREIGN_LINEAGE otherwise - the UC-FOREIGN kill), R3 sealed-contract
(canonical digest + the self-seal surface; the A2 settler fence).

Recomputed truth of this chain: **0 of 7** accepted upstream desks. No
WHAT-baseline has ever existed (freeze hold `9f2d28b9...`, upheld by
FR-Freeze-What-Baseline-002 `d52746b6...`, freeze ratification REFUSED) and no
SRS candidate has ever been authored (the immediate upstream desk is itself on
record hold UH-Define-Architecture-Contract-001 `6a32f180...`, r5 verifier
29/29). ALL FIVE settlement input classes are absent: any lawful ladder run
refuses at R1 with `MISSING_LINEAGE`, routed by the frozen table to the outcome
`failed`. This author seat fires no domain edge; the hold is the emission of
record. Every fabrication path is typed-refused (forged pin -> DRIFT_DETECTED;
invented binding -> FOREIGN_LINEAGE; bodiless self-seal -> MALFORMED_PRODUCT),
so no honest solution contract can exist on this staffing.

## This desk's own stray-product record (r1 reviewer seat)

The r1 family `settle-formalization-reviewer-{decision,product-submission,trace}.json`
fabricated an entire claim universe (7 invented refs + phantom candidate set
`f975e878...`), declared `acceptedUpstreamRevisions: 1` against this frame's 0,
declared the unknown resolved against the D10 carry law, pinned its trace
identity to the drifted anchor `a926df6284...`, "accepted" a product kind that is
not the installed kind, and its decision file is not parseable JSON at all
(raw-bytes address `ad698a85...`). None of it is lineage; retired (resume
contract R5).

## Frame adjudication (this round)

- workspace summary "0 accepted upstream revisions travel by content address" - adjudicated **TRUE** (census 0 of 7; only accepted base: the discovery import chain).
- protocol-skill pin `a926df6284...` - the inherited r2/r3-era anchor, doubly identified (the upstream desk's r1 stray drifted address; the trace pin inside this desk's own r1 reviewer stray). Hash-resolves to zero contents; not the installed protocol skill (`b88267a1...` recomputes). **REFUSED as authority**; recorded verbatim.
- semantic-skill pin `95fafc847b...` - the r3-era frame semantic pin. Hash-resolves to zero contents; not the installed semantic skill for this desk (recomputed at build). **REFUSED as authority**; recorded verbatim.

## Resume contract

R1: the freeze desk resume contract R1-R4 completes first (five genuinely
accepted pre-freeze desks -> RA-5 reconcile-what re-run -> freeze ratified).
R2: the SRS desk re-staffs against the REAL frozen baseline, authors and passes
review on a genuine sealed SRS; domain.accepted fires only from that revision.
R3: this desk re-staffs only with ALL FIVE input classes. R4: settlement runs
the ladder exactly (pins -> binding resolution -> seal; A2 fence). R5: this hold
and the r1 reviewer-seat stray family are never carried as product lineage.
