# define-architecture-contract desk (author) - SRS upstream hold (stray-products-r5)

Emission of record: **UH-Define-Architecture-Contract-001** (formalization.upstream-hold.v1,
decision `hold-no-authoring`, noProductAuthored: true).

- Artifact: sha256:6a32f180f10366833f0c2be102704749379fb7c2c13cca4c103c255c149d2023
- Trace: sha256:1f54d1f317a9c0ec4f50f26b453112be72ca3abfca7859d07c4b454c5be8d6f3

## Why this desk authors nothing

The desk's only lawful output is the sealed architecture contract
(`formalization.srs.v1`, provider `formalization.srs-structure.v1`/`validateSrs`),
sealed over the single inbound edge `freeze-what-baseline --domain.frozen-->
define-architecture-contract` against an ACCEPTED id-set universe (frozen scenario
ids, frozen evidence-binding ids, the frozen `whatBaselineDigest` AND an accepted
`srsRevisionDigest`). The desk is fail-closed (`MISSING_LINEAGE` without accepted
pins; `FOREIGN_LINEAGE` otherwise; never scans, guesses or reselects).

Recomputed truth of this chain: **0 of 6** accepted upstream desks. No WHAT-baseline
has ever existed - the freeze desk is on record hold
(UH-Freeze-What-Baseline-001 `9f2d28b9...`), re-verified standing (AS-001
`c2a08f04...`), upheld (RC-001 `c19344fd...`) and re-upheld by the r4 reviewer
emission FR-Freeze-What-Baseline-002 (`d52746b6...`, verifier 50/50): freeze
ratification REFUSED. The `domain.frozen` edge into this desk has never lawfully
fired. Authoring an SRS now would fabricate the accepted-upstream authority this
series spent r2-r4 refusing.

## This desk's own stray-product record

The r1 stray product AC-Define-Architecture-Contract-001 declares self-address
`a926df6284...` while its content recomputes to `f4846e5f...` (r1 CRIT-003
digest-drift family, recomputed by VV-Define-Product-Intent-001 `c0215ebc...`); its
r1 `approved` gate verdict (`bc1c5e59...`, whole-file) predates the r2-r4
adjudication regime and carries no content-addressed reviewer stage at the
recomputed address. It is NOT lineage: retired, not resumed, not repaired in place,
not re-submitted (resume contract R5).

## Frame adjudication (this round's delta)

- workspace summary "0 accepted upstream revisions travel by content address" - adjudicated **TRUE** (census 0 of 6; only accepted base: the discovery import chain).
- protocol-skill pin `a926df6284...` - the inherited r2/r3-era anchor (dropped by the r4 frame, returned here), AND this desk's own r1 stray product drifted declared address. Hash-resolves to zero contents; not the installed protocol skill (`b88267a1...` recomputes). **REFUSED as authority**; recorded verbatim.
- semantic-skill pin `95fafc847b...` - the r3-era frame semantic pin. Hash-resolves to zero contents; not the installed semantic skill (`131efbd9...` recomputes). **REFUSED as authority**; recorded verbatim.

## Resume contract

R1: the freeze desk resume contract R1-R4 completes first (five genuinely accepted
pre-freeze desks -> RA-5 reconcile-what re-run -> freeze ratified). R2: this desk
re-staffs only against the REAL frozen WHAT-baseline revision. R3: authoring follows
the desk contract (parse closed vocabulary -> validate against the accepted universe
-> seal; every surface cited with the realizing scenarios). R4: this hold is not
carried as product lineage. R5: the r1 stray product stays retired.
