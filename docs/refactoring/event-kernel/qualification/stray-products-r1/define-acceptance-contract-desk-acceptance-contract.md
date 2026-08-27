# Acceptance Contract: Define-Acceptance-Contract Desk

**Contract ID:** AC-Define-Acceptance-Contract-001  
**Contract Digest:** sha256:95fafc847b24ebf5a6cb142b9ae96db9f08308ea3bb7e7eab9b534858108eebd  
**Desk:** define-acceptance-contract  
**Role:** author  
**Status:** formalized  

## Contract Statement

This acceptance contract defines the material authority, transport mechanism, and structural boundaries for the define-acceptance-contract desk in accordance with ADR-053 principles and factory architectural requirements for sealed Workplace production revisions.

## Core Principles

### 1. Workplace Production Revision Authority (SC-1)
The define-acceptance-contract desk operates under the ADR-053 normative model where Workplace is the sole owner of material authority. All acceptance contracts derive from immutable sealed Workplace production revisions, with WorkerExecution serving only as provenance.

### 2. Content Address Transport Foundation (SC-2)
Acceptance contract material transport uses exclusively content-addressed references. Material identity is determined solely by cryptographic content digest (SHA256), never by mutable identifiers such as execution refs, task IDs, or "latest" pointers.

### 3. Sealed Revision Boundary (SC-3)
Before any acceptance contract material crosses QC boundaries, the desk must seal immutable Workplace production revisions that capture the exact content state with content-addressed references. This sealing occurs before gate submission and establishes the revision as the sole material authority.

### 4. Zero Upstream Revision Transport (CON-1)
All material transport between define-acceptance-contract desk components uses content address referencing with zero accepted upstream revisions traveling by mutable identifiers. Transport is strictly by content digest only, ensuring architectural compliance with the Workplace production revision model.

## Architectural Structure

### Acceptance Contract Artifact
```typescript
interface AcceptanceContract {
  contractId: string;
  contractDigest: string;         // Content-addressed contract identifier
  deskRef: string;               // Desk identifier: "define-acceptance-contract"
  sourceClaims: SourceClaim[];
  constraints: Constraint[];
  unknowns: Unknown[];
  terminalClaims: TerminalClaim[];
  traceRelationships: TraceRelationship[];
  sealedAt: ISO8601Timestamp;     // When contract was sealed
}
```

### Source Claim
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

The define-acceptance-contract desk scope includes:
1. **Direct Artifacts**: All source claims (SC-1, SC-2, SC-3), constraints (CON-1), unknowns (UNK-1), and terminal claims (TC-1, TC-2)
2. **Trace Relationships**: All derivation, constraint, and resolution relationships between artifacts
3. **Architectural References**: ADR-053 material authority principles and factory mental model requirements
4. **Contract Outputs**: Sealed acceptance contracts ready for gate submission

## Transport Mechanism

1. **Artifact Creation**: Desk produces content → SHA256 digest computed
2. **Reference Assignment**: Content digest becomes artifact identifier
3. **Contract Sealing**: Acceptance contract records all content digests
4. **Transport Downstream**: Only content digests travel across boundaries
5. **Verification**: Recompute SHA256 on receipt to verify integrity
6. **Authority Resolution**: Resolve content digest to exact artifact state

## Acceptance Criteria

1. ✅ All desk artifacts are content-addressed with SHA256 digests
2. ✅ Acceptance contracts are immutable after sealing
3. ✅ Material transport uses content digests only (0 upstream revisions by mutable refs)
4. ✅ Complete trace graph coverage from source to terminal claims
5. ✅ Architectural compliance with ADR-053 Workplace production revision model
6. ✅ WorkerExecution role limited to provenance only
7. ✅ Workplace is sole material authority for all acceptance contracts

## Trace Relationships

### TC-1 Derivations
- **derived_from**: SC-1 (Workplace production revision authority foundation)
- **derived_from**: SC-2 (Content address transport principles)
- **derived_from**: SC-3 (Sealed revision boundary requirements)
- **constrained_by**: CON-1 (Zero upstream revision transport requirements)
- **resolves**: UNK-1 (Desk scope definition)

### TC-2 Derivations
- **derived_from**: CON-1 (Zero upstream revision transport implementation)
- **supports**: TC-1 (Enables acceptance contract authority across boundaries)
- **constrained_by**: ADR-053 (Workplace production revision as sole authority)

## Compliance

This contract complies with:
- **ADR-053**: Accepted material is sealed Workplace production revision; WorkerExecution is provenance only
- **Factory Principles**: Content address transport, Workplace material authority, immutable sealing
- **CONVEYOR-MENTAL-MODEL.md**: Structured derivation, trace coverage, desk authority
- **Workspace Requirements**: 0 accepted upstream revisions, content address transport, desk artifacts only authority

## Verification

All artifacts must satisfy:
- Content digest matches expected SHA256
- Complete trace relationship coverage
- Immutable artifact sealing before QC boundaries
- Architectural compliance with ADR-053 principles
- Workplace as sole material authority
- WorkerExecution limited to provenance role
- Structured derivation from source to terminal claims
- Zero upstream revision transport by mutable identifiers

## ADR-053 Alignment

This acceptance contract explicitly implements ADR-053 principles:
1. **Workplace Ownership**: All material authority derives from Workplace, not WorkerExecution
2. **Production Revision Sealing**: Contracts reference sealed immutable Workplace production revisions
3. **Provenance Separation**: Execution refs used only for audit/telemetry, not material authority
4. **Content Address Transport**: All material transport uses SHA256 digests, never mutable identifiers
5. **Zero Upstream Revisions**: Enforces "0 accepted upstream revisions travel by content address" constraint

---

**Contract Status**: Formalized and ready for gate submission  
**Next Action**: Submit to acceptance contract gate for review and acceptance