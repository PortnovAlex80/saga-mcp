# Constraint 1: Content Address Transport

**Constraint ID:** CON-1  
**Digest:** d7ce453b9dbb1aa1cecda1d591779b92dc347220c9f4f19c6db86629f5a18c2b

## Statement

All material transport between freeze-what-baseline desk components must use content address referencing. Material identity is determined solely by cryptographic content digest, never by mutable identifiers, execution IDs, or path references.

## Requirements

1. **Content Digest Primary**: Every artifact must be identified by SHA256 digest
2. **Immutable Reference**: Once assigned, a content digest never changes for the same material
3. **Zero Ambiguity**: Two different contents never produce the same digest
4. **Transport Protocol**: Material moves through the system by digest references, not file copies

## Rationale

Content addressing provides true material immutability and authority. Execution IDs, paths, and database row IDs are mutable envelope fields that can drift. Content digests survive process crashes, database migrations, and repository reorganizations.

## Evidence

- Workspace summary: "0 accepted upstream revisions travel by content address"
- CONVEYOR-MENTAL-MODEL.md section 9: Replay identity must be semantic and cross-run stable
- ADR-053: Material authority must be sealed revision, not execution

## Dependencies

- SC-1: Workplace Material Authority
- SC-3: Immutable Revision Sealing

## Status

Accepted as binding constraint for freeze-what-baseline desk implementation.