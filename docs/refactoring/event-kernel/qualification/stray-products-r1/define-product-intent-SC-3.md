# Source Claim 3: Immutable Intent Revision Sealing

**Claim ID:** SC-3  
**Digest:** 423be112883976126a9b2718226aa68628fbe5d60253e0c0c849d66925062035

## Statement

Before any product intent material crosses QC boundaries (gate, effect, downstream handoff), the Workplace must seal an immutable WorkplaceProductionRevision for intent artifacts. This revision captures the exact state of brief and PRD containers with all atomic intent members and becomes the sole authority for downstream requirements definition.

## Rationale

The mutable Workplace desk cannot serve as cross-machine authority for product intent. Without an explicit sealed revision, different downstream components (model-use-cases, formalization cells) may read inconsistent intent states. The revision provides a stable, content-addressed snapshot of what the product is intended to do, ensuring all downstream work proceeds from the same accepted intent.

## Evidence

- ADR-053: WorkplaceProductionRevision as missing explicit entity
- CONVEYOR-MENTAL-MODEL.md section 5: CandidateSet binds immutable Workplace production revision
- FORMATS-FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN.md: define-product-intent produces brief and PRD only

## Dependencies

- SC-1: Product Intent Artifact Authority
- SC-2: Intent Authoring Provenance Separation
- CON-1: Content Address Transport

## Status

Accepted as foundational claim for product intent freezing mechanics.

## Product Intent Context

Intent revision sealing captures:
- Complete brief container with product vision
- PRD container with all atomic intent members:
  - System boundary definition
  - Actors and affected stakeholders
  - Stakeholder, user, operator, or mission outcomes
  - Scope and exclusions
  - Lifecycle terminal claims
  - Constraints
  - Assumptions and unknowns
  - Required dispositions