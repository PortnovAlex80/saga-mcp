# Terminal Claim 2: Content Address Product Intent Transport

**Terminal Claim ID:** TC-2  
**Digest:** f3d0a6a4aea6909d35d8e5368425b21b38799b7f44444d926176083b532c011b

## Statement

The define-product-intent desk implements content address transport for all product intent material movement. Brief and PRD artifacts travel through the system by their SHA256 content digests, ensuring immutability, authority preservation, and cross-process consistency for product vision and requirements definition.

## Derivation

**From Source Claims:**
- SC-1 establishes Workplace as intent material authority requiring stable references
- SC-3 mandates immutable intent revision sealing with content-addressed members
- TC-1 defines WorkplaceProductionRevision structure with content digests

**From Constraints:**
- CON-1 explicitly requires content address transport as binding constraint

**Supporting TC-1:**
Content address transport enables TC-1's WorkplaceProductionRevision to maintain intent authority across process boundaries and execution attempts, ensuring all downstream work references the exact same accepted product vision.

## Formal Specification

```typescript
interface ContentAddressTransport {
  intentArtifactRefs: ContentAddressedReference[];
  transportProtocol: 'content-address-digest';
  authorityBinding: 'workplace-production-revision';
  integrityVerification: 'sha256-cryptographic';
}

interface ContentAddressedReference {
  contentDigest: string;           // SHA256 hash of intent artifact content
  artifactKind: string;            // 'brief-container', 'prd-container', 'atomic-intent-member'
  semanticCode: string;            // INTENT-SYSTEM-BOUNDARY, INTENT-ACTOR, etc.
  revisionRef: string;             // WorkplaceProductionRevision identifier
  containerRef?: string;           // For atomic members: parent container reference
  verificationPath: string;        // Path to verify content digest
}
```

## Transport Mechanism

1. **Intent Artifact Creation**: Author produces brief/PRD content → SHA256 digest computed
2. **Reference Assignment**: Content digest becomes artifact identifier
3. **Member-Level Addressing**: Individual atomic intent members get their own digests
4. **Container-Level Addressing**: PRD container gets overall digest encompassing all members
5. **Revision Sealing**: WorkplaceProductionRevision records all content digests (container + members)
6. **Transport Downstream**: Only content digests travel across boundaries
7. **Verification**: Recompute SHA256 on receipt to verify intent integrity
8. **Authority Resolution**: Resolve content digest to exact intent artifact state

## Acceptance Criteria

1. ✅ All product intent artifacts identified by SHA256 digest
2. ✅ No mutable identifiers used for intent material transport
3. ✅ Content digest verification at each transport boundary
4. ✅ WorkplaceProductionRevision serves as content digest registry
5. ✅ 0 accepted upstream revisions travel by content address (as specified)
6. ✅ Hybrid granularity: container and member digests both transportable

## Evidence

- Directly constrained by CON-1
- Supports TC-1's WorkplaceProductionRevision architecture
- Follows workspace summary specification
- Consistent with CONVEYOR-MENTAL-MODEL.md replay identity principles
- Enables downstream model-use-cases Cell to reference specific intent members

## Status

Accepted as terminal claim establishing content address transport for product intent material.

## Product Intent Context

This transport mechanism enables:
- Stable product vision transport from define-product-intent to model-use-cases
- Precise actor definition referencing for use case modeling
- Constraint and unknown propagation to formalization phases
- Intent traceability across entire factory lifecycle
- Verification that all downstream work uses identical accepted product intent