# Terminal Claim 2: Content Address Acceptance Contract Transport

**Terminal Claim ID:** TC-2  
**Digest:** f3d0a6a4aea6909d35d8e5368425b21b38799b7f44444d926176083b532c011b

## Statement

The define-acceptance-contract desk implements content address transport for all acceptance contract material movement. Acceptance contract artifacts travel through the system by their SHA256 content digests, ensuring immutability, authority preservation, and cross-process consistency.

## Derivation

**From Source Claims:**
- SC-1 establishes Workplace as material authority requiring stable references
- SC-3 mandates immutable revision sealing with content-addressed members
- TC-1 defines WorkplaceProductionRevision structure with content digests

**From Constraints:**
- CON-1 explicitly requires content address transport as binding constraint

**Supporting TC-1:**
Content address transport enables TC-1's WorkplaceProductionRevision to maintain authority across process boundaries and execution attempts.

## Formal Specification

```typescript
interface ContentAddressTransport {
  acceptanceContractArtifactRefs: ContentAddressedReference[];
  transportProtocol: 'content-address-digest';
  authorityBinding: 'workplace-production-revision';
  integrityVerification: 'sha256-cryptographic';
}

interface ContentAddressedReference {
  contentDigest: string;           // SHA256 hash of artifact content
  artifactKind: string;            // 'source-claim', 'constraint', etc.
  semanticCode: string;            // SC-1, CON-1, etc.
  revisionRef: string;             // WorkplaceProductionRevision identifier
  verificationPath: string;        // Path to verify content digest
}
```

## Transport Mechanism

1. **Artifact Creation**: Worker produces content → SHA256 digest computed
2. **Reference Assignment**: Content digest becomes artifact identifier
3. **Revision Sealing**: WorkplaceProductionRevision records all content digests
4. **Transport Downstream**: Only content digests travel across boundaries
5. **Verification**: Recompute SHA256 on receipt to verify integrity
6. **Authority Resolution**: Resolve content digest to exact artifact state

## Acceptance Criteria

1. ✅ All acceptance contract artifacts identified by SHA256 digest
2. ✅ No mutable identifiers used for material transport
3. ✅ Content digest verification at each transport boundary
4. ✅ WorkplaceProductionRevision serves as content digest registry
5. ✅ 0 accepted upstream revisions travel by content address (as specified)

## Evidence

- Directly constrained by CON-1
- Supports TC-1's WorkplaceProductionRevision architecture
- Follows workspace summary specification
- Consistent with CONVEYOR-MENTAL-MODEL.md replay identity principles

## Status

Accepted as terminal claim establishing content address transport for acceptance contract material.