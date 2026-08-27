# Source Claim 2: Execution Provenance Separation

**Claim ID:** SC-2  
**Digest:** c9bfe922c5891e8bfeaaf07864a75d3beaa5239dd455d6bb889f1eef4b3dd0fc

## Statement

WorkerExecution serves only as provenance authority, not material authority. Execution references may be used for audit trails, fence validation, and attempt accounting, but never for material retrieval or identity resolution.

## Rationale

Execution-scoped material lookups create the "Run 011 problem" where accepted material spans multiple executions but consumers only read the latest execution. A correct system separates concerns: execution = who made contributions; workplace = what the final material state is.

## Evidence

- ADR-053: "WorkerExecution is provenance only"
- CONVEYOR-MENTAL-MODEL.md section 5: CandidateSet authority identity never includes execution provenance
- Historical fix chain: reviewer authority, Git/write authority, SRS and acceptance criteria

## Dependencies

- SC-1: Workplace Material Authority
- CON-1: Content Address Transport

## Status

Accepted as foundational claim for proper provenance/material separation.