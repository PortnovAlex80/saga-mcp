# Source Claim 1: Workplace Material Authority

**Claim ID:** SC-1  
**Digest:** fbe292e862ab174b29de15cbbf85b34e4211b3a0e508fd39245015c9ea12b180

## Statement

The Workplace is the sole authoritative owner of all production material in the freeze-what-baseline desk. All material references, including baseline artifacts, must derive their authority from the immutable Workplace production revision rather than from individual WorkerExecution instances.

## Rationale

Per ADR-053, treating execution references as material authority is a systemic defect. When material is produced across multiple executions (recovery, carry-forward, repair), any system that reads only the latest execution loses parts of the accepted material. The Workplace must own the material state across all execution attempts.

## Evidence

- ADR-053: Accepted material is a sealed Workplace production revision; WorkerExecution is provenance only
- Run 011 stabilization chain demonstrated execution-scoped material authority failures
- CONVEYOR-MENTAL-MODEL.md section 2: "One logical desk"

## Dependencies

- SC-2: Execution Provenance Separation
- SC-3: Immutable Revision Sealing
- CON-1: Content Address Transport

## Status

Accepted as foundational claim for freeze-what-baseline desk architecture.