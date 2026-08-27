# Source Claim 2: Intent Authoring Provenance Separation

**Claim ID:** SC-2  
**Digest:** c9bfe922c5891e8bfeaaf07864a75d3beaa5239dd455d6bb889f1eef4b3dd0fc

## Statement

WorkerExecution serves only as provenance authority for product intent authoring, not material authority. Execution references may be used for audit trails of who contributed to brief/PRD development, but never for retrieving the final accepted intent state.

## Rationale

Product intent evolves through multiple authoring iterations. Initial drafts may be refined, stakeholders may provide feedback, and requirements may be clarified. Execution-scoped intent lookups create the "latest execution wins" problem where earlier valid intent contributions are lost. The correct system separates: execution = who contributed to intent evolution; workplace = what the final accepted intent state is.

## Evidence

- ADR-053: "WorkerExecution is provenance only"
- CONVEYOR-MENTAL-MODEL.md section 5: CandidateSet authority identity never includes execution provenance
- Historical pattern: execution-scoped authority failures in other desks

## Dependencies

- SC-1: Product Intent Artifact Authority
- CON-1: Content Address Transport

## Status

Accepted as foundational claim for proper intent authoring provenance/material separation.

## Product Intent Context

Intent authoring provenance tracks:
- Initial brief drafting
- PRD structure development
- Atomic intent member refinement (system boundary, actors, outcomes, etc.)
- Stakeholder feedback incorporation
- Intent clarification iterations