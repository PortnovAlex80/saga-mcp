# Architecture Contract: Import-Discovery-Handoff Desk

**Contract ID:** AC-Import-Discovery-Handoff-001
**Contract Digest:** sha256:a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837
**Desk:** import-discovery-handoff
**Role:** author
**Status:** formalized

## Contract Statement

This architecture contract defines the material authority, transport mechanism, and structural boundaries for the import-discovery-handoff desk in accordance with factory architectural principles and the WP-11F handoff protocol.

## Core Principles

### 1. Protocol Version Authority (SC-1)
The import-discovery-handoff desk enforces strict protocol version compliance using `ek.discovery-handoff-capsule.ek8-wp11f.v1`. Any capsule with a stale protocol version is refused at ingress with a typed `STALE_PROTOCOL` refusal.

### 2. Content Integrity Verification (SC-2)
All capsule content undergoes cryptographic verification. Every sub-artifact digest is recomputed over its canonical content at ingress, and declared digests are never trusted. The capsule self-address must verify against its canonical facts.

### 3. Lineage Binding Enforcement (SC-3)
The desk maintains strict lineage binding between discovery and formalization workshops. The capsule must carry the correct lineage ID and parent lifecycle reference matching the expected binding for the target database.

### 4. Parent State Validation (CON-1)
The only legal producing parent state is `discovery-terminal`. Any capsule from a non-terminal Discovery parent state is refused with an `ILLEGAL_PARENT_STATE` refusal. This ensures the Discovery lifecycle has properly handed off before formalization begins.

## Architectural Structure

### Import Discovery Handoff Artifact
```typescript
interface ImportDiscoveryHandoffArtifact {
  contractId: string;
  contractDigest: string;         // Content-addressed contract identifier
  deskRef: string;               // Desk identifier: "import-discovery-handoff"
  sourceClaims: SourceClaim[];
  constraints: Constraint[];
  unknowns: Unknown[];
  terminalClaims: TerminalClaim[];
  traceRelationships: TraceRelationship[];
  sealedAt: ISO8601Timestamp;     // When contract was sealed
  protocolVersion: string;        // HANDOFF_PROTOCOL_VERSION
  productKind: string;            // "formalization.discovery-import.v1"
}
```

### Source Claims
```typescript
interface SourceClaim {
  claimId: string;
  digest: string;                // SHA256 of claim content
  statement: string;
  rationale: string;
  evidence: string[];
  dependencies: string[];
}
```

### Constraint
```typescript
interface Constraint {
  constraintId: string;
  digest: string;                // SHA256 of constraint content
  statement: string;
  requirements: string[];
  rationale: string;
  evidence: string[];
  dependencies: string[];
}
```

### Terminal Claim
```typescript
interface TerminalClaim {
  claimId: string;
  digest: string;                // SHA256 of claim content
  statement: string;
  derivation: DerivationChain;
  acceptanceCriteria: string[];
  evidence: string[];
}
```

## Desk Scope Definition (Resolution of UNK-1)

The import-discovery-handoff desk scope includes:
1. **Direct Artifacts**: All source claims (SC-1, SC-2, SC-3), constraints (CON-1), unknowns (UNK-1), and terminal claims (TC-1, TC-2)
2. **Trace Relationships**: All derivation, constraint, and resolution relationships between artifacts
3. **Protocol Enforcement**: WP-11F handoff protocol compliance and version control
4. **Content Verification**: Cryptographic verification of all capsule content and sub-artifacts
5. **Lineage Management**: Discovery-to-formalization lineage binding and parent state validation
6. **Product Generation**: formalization.discovery-import.v1 products with proper evidence references

## Transport Mechanism

1. **Capsule Ingestion**: Discovery handoff capsule received via `ingestDiscoveryHandoff` function
2. **Protocol Validation**: Verify schema version matches `HANDOFF_PROTOCOL_VERSION`
3. **Content Verification**: Recompute all SHA256 digests over canonical content
4. **Lineage Check**: Validate capsule lineage against expected binding
5. **Parent State Validation**: Ensure producing parent is `discovery-terminal`
6. **Fresh Run Verification**: Confirm no active attempts exist in target world
7. **Repository Import**: Apply `factoryRun.bootstrap` and `factoryRun.importCapsule` commands
8. **Product Generation**: Create formalization.discovery-import.v1 product with evidence refs
9. **Trace Recording**: Record all artifact relationships and derivations

## Acceptance Criteria

1. ✅ All desk artifacts are content-addressed with SHA256 digests
2. ✅ Capsule protocol version matches `HANDOFF_PROTOCOL_VERSION`
3. ✅ All sub-artifact digests are recomputed and verified
4. ✅ Lineage binding matches expected discovery-formalization connection
5. ✅ Parent state is exactly `discovery-terminal`
6. ✅ No active attempts exist in target database
7. ✅ Complete trace relationship coverage from source to terminal claims
8. ✅ Products of kind `formalization.discovery-import.v1` are generated
9. ✅ Evidence references include capsule and all sub-artifact refs
10. ✅ 0 accepted upstream revisions travel by content address

## Trace Relationships

### TC-1 Derivations
- **derived_from**: SC-1 (Protocol version authority foundation)
- **derived_from**: SC-2 (Content integrity verification principles)
- **derived_from**: SC-3 (Lineage binding enforcement)
- **constrained_by**: CON-1 (Parent state validation requirements)
- **resolves**: UNK-1 (Desk scope definition)

### TC-2 Derivations
- **derived_from**: CON-1 (Parent state validation implementation)
- **supports**: TC-1 (Enables secure discovery-to-formalization handoff)
- **enforces**: HANDOFF_PROTOCOL_VERSION (WP-11F compliance)
- **produces**: formalization.discovery-import.v1 products

## Compliance

This contract complies with:
- **Factory Principles**: Content address transport, artifact authority, immutable sealing
- **WP-11F Protocol**: Discovery handoff capsule specification and verification
- **ingress.ts Laws**: Stale protocol, bytes corrupt, bytes missing, foreign lineage, illegal parent state, active attempt refusals
- **Workspace Requirements**: 0 accepted upstream revisions, content address transport, desk artifacts only authority

## Verification

All artifacts must satisfy:
- Content digest matches expected SHA256
- Protocol version equals `HANDOFF_PROTOCOL_VERSION`
- Complete trace relationship coverage
- Immutable artifact sealing before QC boundaries
- Architectural compliance with factory principles
- Structured derivation from source to terminal claims
- Valid lineage binding and parent state verification

## Product Specification

The import-discovery-handoff desk produces products of kind `formalization.discovery-import.v1` with the following characteristics:
- **Product Kind**: `formalization.discovery-import.v1`
- **Effect ID**: `formalization.accept-products`
- **Evidence References**: Capsule ref, certificate ref, all source claim refs, all terminal claim refs
- **Desk Node ID**: `import-discovery-handoff`
- **Token**: `plan:discovery-handoff#item:import`
- **Item Instance ID**: `formalization-item:import-discovery-handoff`

---

**Contract Status**: Formalized and ready for gate submission
**Next Action**: Submit to architecture contract gate for review and acceptance