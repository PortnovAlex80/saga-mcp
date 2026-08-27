# Source Claim 1: Product Intent Artifact Authority

**Claim ID:** SC-1  
**Digest:** fbe292e862ab174b29de15cbbf85b34e4211b3a0e508fd39245015c9ea12b180

## Statement

The define-product-intent desk operates as an authoritative source for product intent artifacts (brief and PRD containers). All product intent material must derive their authority from the immutable Workplace production revision rather than from individual WorkerExecution instances.

## Rationale

Per ADR-053, treating execution references as material authority is a systemic defect. Product intent definitions may span multiple authoring attempts (initial drafting, refinement, clarification). The Workplace must own the intent state across all attempts to ensure consistent product scope and requirements definition.

## Evidence

- ADR-053: Accepted material is a sealed Workplace production revision; WorkerExecution is provenance only
- CONVEYOR-MENTAL-MODEL.md section 2: "One logical desk"
- FORMATS-FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN.md: define-product-intent Cell produces brief and PRD containers

## Dependencies

- SC-2: Execution Provenance Separation
- SC-3: Immutable Intent Sealing
- CON-1: Content Address Transport

## Status

Accepted as foundational claim for define-product-intent desk architecture.

## Product Intent Context

Product intent artifacts include:
- Brief containers: High-level product vision and scope
- PRD containers: Detailed requirements with atomic intent members for system boundary, actors, outcomes, scope, constraints, and unknowns