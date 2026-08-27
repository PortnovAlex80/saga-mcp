# Terminal Claim 1: Product Intent Production Revision Authority

**Terminal Claim ID:** TC-1  
**Digest:** c292f69407b0d7752008069ac095dc556522ed5df9f386b9e2ec5bf31909e8f0

## Statement

The define-product-intent desk establishes WorkplaceProductionRevision as the sole material authority for product intent artifacts. This immutable revision captures the exact state of brief and PRD containers with all atomic intent members at intent freeze time and serves as the authoritative source for all downstream operations (use case modeling, requirements formalization, development).

## Derivation

**From Source Claims:**
- SC-1 establishes Workplace as product intent material authority owner
- SC-2 separates execution provenance from intent material authority
- SC-3 mandates immutable intent revision sealing before QC boundaries

**From Constraints:**
- CON-1 requires content address transport for intent material movement

**Resolution of UNK-1:**
The product intent granularity uses hybrid approach: PRD container has overall content digest for atomic authority, while individual atomic intent members are also content-addressed for fine-grained reference and tracing. This balances atomic revision semantics with downstream reference needs.

## Formal Specification

```typescript
interface WorkplaceProductionRevision {
  revisionRef: string;              // Content-addressed revision identifier
  workplaceRef: string;             // Desk identifier: "define-product-intent"
  parentRevisionRef?: string;       // Previous intent revision (if any)
  materialMembers: MaterialMember[]; // All frozen intent artifacts
  contributingExecutionRefs: string[]; // Execution provenance only
  presenterRef: string;             // Who initiated the intent freeze
  materialDigest: string;           // Overall revision content digest
  semanticDigest: string;           // Semantic identity for replay
  sealedAt: ISO8601Timestamp;       // When revision was sealed
}

interface MaterialMember {
  productRef: string;               // Content-addressed artifact reference
  role: 'brief-container' | 'prd-container' | 'atomic-intent-member';
  contentDigest: string;            // SHA256 of artifact content
  semanticCode: string;             // INTENT-SYSTEM-BOUNDARY, INTENT-ACTOR, etc.
  containerRef?: string;            // For atomic members: reference to parent container
}

interface AtomicIntentMember {
  memberType: 'system-boundary' | 'actor' | 'outcome' | 'scope' | 'constraint' | 'unknown';
  content: string;                  // Intent member content
  contentDigest: string;            // Individual member SHA256
  dependencies: string[];           // References to other intent members
}
```

## Acceptance Criteria

1. ✅ All product intent artifacts are content-addressed
2. ✅ WorkplaceProductionRevision is immutable after sealing
3. ✅ No downstream component reads intent by execution ID
4. ✅ Intent material transport uses content digests only
5. ✅ Provenance (execution refs) is separate from intent material authority
6. ✅ Hybrid granularity: container-level authority + member-level references

## Evidence

- Derived from SC-1, SC-2, SC-3, CON-1
- Resolves UNK-1: hybrid granularity for container authority + member references
- Consistent with ADR-053 architecture
- Follows CONVEYOR-MENTAL-MODEL.md principles
- Supports downstream needs for model-use-cases and formalization

## Status

Accepted as terminal claim establishing product intent material authority architecture.

## Product Intent Context

This revision authority enables:
- Atomic intent freeze for brief and PRD containers
- Fine-grained reference to individual intent members by downstream cells
- Consistent product vision across all factory phases
- Traceable intent evolution through revision history
- Content-addressed transport of intent material across boundaries