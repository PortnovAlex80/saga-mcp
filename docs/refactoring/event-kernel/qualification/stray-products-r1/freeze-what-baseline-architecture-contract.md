# Architecture Contract: Freeze-What-Baseline Desk

**Contract ID:** AC-Freeze-What-Baseline-001  
**Contract Digest:** sha256:pending  
**Desk:** freeze-what-baseline  
**Role:** author  
**Status:** formalized  

## Contract Statement

This architecture contract defines the material authority, transport mechanism, and structural boundaries for the freeze-what-baseline desk in accordance with ADR-053 and CONVEYOR-MENTAL-MODEL principles.

## Core Principles

### 1. Workplace Material Authority (SC-1)
The Workplace is the sole authoritative owner of all production material in the freeze-what-baseline desk. All material references derive their authority from the immutable Workplace production revision rather than from individual WorkerExecution instances.

### 2. Execution Provenance Separation (SC-2)
WorkerExecution serves only as provenance authority, not material authority. Execution references are used for audit trails, fence validation, and attempt accounting, but never for material retrieval or identity resolution.

### 3. Immutable Revision Sealing (SC-3)
Before any material crosses QC boundaries, the Workplace must seal an immutable WorkplaceProductionRevision. This revision captures the exact material state with content-addressed references and becomes the sole authority for all downstream consumers.

### 4. Content Address Transport (CON-1)
All material transport between freeze-what-baseline desk components uses content address referencing. Material identity is determined solely by cryptographic content digest (SHA256), never by mutable identifiers, execution IDs, or path references.

## Architectural Structure

### WorkplaceProductionRevision
```typescript
interface WorkplaceProductionRevision {
  revisionRef: string;              // Content-addressed revision identifier
  workplaceRef: string;             // Desk identifier: "freeze-what-baseline"
  parentRevisionRef?: string;       // Previous baseline revision (if any)
  materialMembers: MaterialMember[]; // All frozen artifacts
  contributingExecutionRefs: string[]; // Execution provenance only
  presenterRef: string;             // Who initiated the freeze
  materialDigest: string;           // Overall revision content digest
  semanticDigest: string;           // Semantic identity for replay
  sealedAt: ISO8601Timestamp;       // When revision was sealed
}
```

### MaterialMember
```typescript
interface MaterialMember {
  productRef: string;               // Content-addressed artifact reference
  role: 'source-claim' | 'constraint' | 'unknown' | 'terminal-claim';
  contentDigest: string;            // SHA256 of artifact content
  semanticCode: string;             // SC-1, CON-1, TC-1, etc.
}
```

## Baseline Scope Definition (Resolution of UNK-1)

The baseline freeze scope includes:
1. **Direct Artifacts**: All source claims (SC-1, SC-2, SC-3), constraints (CON-1), unknowns (UNK-1), and terminal claims (TC-1, TC-2)
2. **Immediate Dependencies**: Architectural decisions directly referenced (ADR-053) and mental model principles
3. **Trace Relationships**: All derivation, constraint, and resolution relationships between artifacts

## Transport Mechanism

1. **Artifact Creation**: Worker produces content → SHA256 digest computed
2. **Reference Assignment**: Content digest becomes artifact identifier
3. **Revision Sealing**: WorkplaceProductionRevision records all content digests
4. **Transport Downstream**: Only content digests travel across boundaries
5. **Verification**: Recompute SHA256 on receipt to verify integrity
6. **Authority Resolution**: Resolve content digest to exact artifact state

## Acceptance Criteria

1. ✅ All baseline artifacts are content-addressed with SHA256 digests
2. ✅ WorkplaceProductionRevision is immutable after sealing
3. ✅ No downstream component reads material by execution ID
4. ✅ Material transport uses content digests only
5. ✅ Provenance (execution refs) is separate from material authority
6. ✅ 0 accepted upstream revisions travel by content address

## Trace Relationships

### TC-1 Derivations
- **derived_from**: SC-1 (Workplace material authority foundation)
- **derived_from**: SC-2 (Execution provenance separation principles)
- **derived_from**: SC-3 (Immutable revision sealing requirement)
- **constrained_by**: CON-1 (Content address transport requirements)
- **resolves**: UNK-1 (Baseline scope definition)

### TC-2 Derivations
- **derived_from**: CON-1 (Content address transport implementation)
- **supports**: TC-1 (Enables WorkplaceProductionRevision authority across boundaries)

## Compliance

This contract complies with:
- **ADR-053**: Accepted material is a sealed Workplace production revision; WorkerExecution is provenance only
- **CONVEYOR-MENTAL-MODEL.md**: One logical desk, LEGO principle, Production Cell quality loop
- **Workspace Requirements**: 0 accepted upstream revisions, content address transport, desk artifacts only authority

## Verification

All artifacts must satisfy:
- Content digest matches expected SHA256
- No execution-scoped material authority
- Immutable revision sealing before QC boundaries
- Complete trace graph coverage
- Architectural compliance with ADR-053

---

**Contract Status**: Formalized and ready for gate submission  
**Next Action**: Submit to architecture contract gate for review and acceptance