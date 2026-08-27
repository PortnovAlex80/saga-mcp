# Source Claim 3: Immutable Revision Sealing

**Claim ID:** SC-3  
**Digest:** 423be112883976126a9b2718226aa68628fbe5d60253e0c0c849d66925062035

## Statement

Before any material crosses QC boundaries (gate, effect, downstream handoff), the Workplace must seal an immutable WorkplaceProductionRevision. This revision captures the exact material state with content-addressed references and becomes the sole authority for all downstream consumers.

## Rationale

The mutable Workplace desk cannot serve as cross-machine authority. Without an explicit sealed revision, different components may read inconsistent states or reconstruct material differently. The revision provides a stable, content-addressed snapshot that travels through content address transport.

## Evidence

- ADR-053: WorkplaceProductionRevision as missing explicit entity
- CONVEYOR-MENTAL-MODEL.md section 5: CandidateSet binds immutable Workplace production revision
- Historical pattern: recovery returned problem to Workplace authority

## Dependencies

- SC-1: Workplace Material Authority
- SC-2: Execution Provenance Separation
- CON-1: Content Address Transport

## Status

Accepted as foundational claim for acceptance contract freezing mechanics.