# Terminal Claim 1: Workplace Production Revision Authority

**Terminal Claim ID:** TC-1  
**Digest:** c292f69407b0d7752008069ac095dc556522ed5df9f386b9e2ec5bf31909e8f0

## Statement

The define-acceptance-contract desk establishes WorkplaceProductionRevision as the sole material authority for acceptance contract artifacts. This immutable revision captures the exact state of all desk material at acceptance contract freeze time and serves as the authoritative source for all downstream operations.

## Derivation

**From Source Claims:**
- SC-1 establishes Workplace as material authority owner
- SC-2 separates execution provenance from material authority  
- SC-3 mandates immutable revision sealing before QC boundaries

**From Constraints:**
- CON-1 requires content address transport for material movement

**Resolution of UNK-1:**
The acceptance contract freeze scope includes all direct desk artifacts (claims, constraints, unknowns, terminal claims) and their immediate dependencies. The WorkplaceProductionRevision captures this minimal complete set needed for acceptance contract authority.

## Formal Specification

```typescript
interface WorkplaceProductionRevision {
  revisionRef: string;              // Content-addressed revision identifier
  workplaceRef: string;             // Desk identifier
  parentRevisionRef?: string;       // Previous acceptance contract revision (if any)
  materialMembers: MaterialMember[]; // All frozen artifacts
  contributingExecutionRefs: string[]; // Execution provenance only
  presenterRef: string;             // Who initiated the freeze
  materialDigest: string;           // Overall revision content digest
  semanticDigest: string;           // Semantic identity for replay
  sealedAt: ISO8601Timestamp;       // When revision was sealed
}

interface MaterialMember {
  productRef: string;               // Content-addressed artifact reference
  role: 'source-claim' | 'constraint' | 'unknown' | 'terminal-claim';
  contentDigest: string;            // SHA256 of artifact content
  semanticCode: string;             // SC-1, CON-1, etc.
}
```

## Acceptance Criteria

1. ✅ All acceptance contract artifacts are content-addressed
2. ✅ WorkplaceProductionRevision is immutable after sealing
3. ✅ No downstream component reads material by execution ID
4. ✅ Material transport uses content digests only
5. ✅ Provenance (execution refs) is separate from material authority

## Evidence

- Derived from SC-1, SC-2, SC-3, CON-1
- Resolves UNK-1: acceptance contract scope = direct artifacts + immediate dependencies
- Consistent with ADR-053 architecture
- Follows CONVEYOR-MENTAL-MODEL.md principles

## Status

Accepted as terminal claim establishing acceptance contract material authority architecture.