# Constraint 1: Content Address Transport

**Constraint ID:** CON-1  
**Digest:** d7ce453b9dbb1aa1cecda1d591779b92dc347220c9f4f19c6db86629f5a18c2b

## Statement

All material transport between define-product-intent desk components must use content address referencing. Product intent identity is determined solely by cryptographic content digest, never by mutable identifiers, execution IDs, or path references.

## Requirements

1. **Content Digest Primary**: Every intent artifact must be identified by SHA256 digest
2. **Immutable Reference**: Once assigned, a content digest never changes for the same intent state
3. **Zero Ambiguity**: Two different intent contents never produce the same digest
4. **Transport Protocol**: Intent material moves through the system by digest references, not file copies

## Rationale

Content addressing provides true intent immutability and authority. Product intent must remain stable across all downstream phases (use case modeling, requirements formalization, development). Execution IDs, paths, and database row IDs are mutable envelope fields that can drift. Content digests survive process crashes, database migrations, and ensure that all downstream work references the exact same accepted product vision.

## Evidence

- Workspace summary: "0 accepted upstream revisions travel by content address"
- CONVEYOR-MENTAL-MODEL.md section 9: Replay identity must be semantic and cross-run stable
- ADR-053: Material authority must be sealed revision, not execution

## Dependencies

- SC-1: Product Intent Artifact Authority
- SC-3: Immutable Intent Revision Sealing

## Status

Accepted as binding constraint for define-product-intent desk implementation.

## Product Intent Context

Content address transport applies to:
- Brief container artifacts
- PRD container artifacts
- Individual atomic intent members within PRD
- Intent trace relationships and dependencies
- All intent-related evidence and rationale