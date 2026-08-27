# Reconcile-What Desk Formalization Summary

**Task:** reconcile-what desk (author)  
**Desk:** define-acceptance-contract  
**Date:** 2026-08-27T00:00:00Z  
**Status:** Complete

## Overview

This formalization reconciles the material scope ("what") for the define-acceptance-contract desk by integrating source claims, constraints, unknowns, and terminal claims into a coherent WorkplaceProductionRevision structure.

## Input Material

### Source Claims (3)
1. **SC-1** (`fbe292e862ab174b29de15cbbf85b34e4211b3a0e508fd39245015c9ea12b180`): Workplace Material Authority
2. **SC-2** (`c9bfe922c5891e8bfeaaf07864a75d3beaa5239dd455d6bb889f1eef4b3dd0fc`): Execution Provenance Separation  
3. **SC-3** (`423be112883976126a9b2718226aa68628fbe5d60253e0c0c849d66925062035`): Immutable Revision Sealing

### Constraints (1)
1. **CON-1** (`d7ce453b9dbb1aa1cecda1d591779b92dc347220c9f4f19c6db86629f5a18c2b`): Content Address Transport

### Unknowns (1)
1. **UNK-1** (`f7acf9d19953686e3042a10755a867a8f80a7fdb3963bd8e78e725962c792276`): Acceptance Contract Scope

### Terminal Claims (2)
1. **TC-1** (`c292f69407b0d7752008069ac095dc556522ed5df9f386b9e2ec5bf31909e8f0`): Workplace Production Revision Authority
2. **TC-2** (`f3d0a6a4aea6909d35d8e5368425b21b38799b7f44444d926176083b532c011b`): Content Address Acceptance Contract Transport

## Reconciliation Process

### Step 1: Analyze Source Claims
- **SC-1** establishes Workplace as sole material authority owner
- **SC-2** separates execution provenance from material authority
- **SC-3** mandates immutable revision sealing before QC boundaries

### Step 2: Apply Constraints
- **CON-1** requires all material transport to use content address referencing (SHA256 digests)

### Step 3: Resolve Unknown
- **UNK-1** questioned whether acceptance contract scope should include only direct artifacts or also transitive dependencies
- **TC-1** provides resolution: acceptance contract freeze scope includes direct artifacts plus immediate dependencies as captured in WorkplaceProductionRevision
- External references (ADR-053, CONVEYOR-MENTAL-MODEL.md) serve as evidence but are not frozen as acceptance contract material

### Step 4: Derive Terminal Claims
- **TC-1** defines WorkplaceProductionRevision structure with content-addressed material members
- **TC-2** implements content address transport protocol for all acceptance contract material movement

## Formalization Output

### WorkplaceProductionRevision Structure
```typescript
{
  revision_ref: string;              // Content-addressed revision identifier
  workplace_ref: string;             // Desk identifier  
  parent_revision_ref?: string;       // Previous revision (none for initial)
  material_members: MaterialMember[]; // All frozen artifacts
  contributing_execution_refs: string[]; // Provenance only
  presenter_ref: string;             // Author who initiated freeze
  material_digest: string;           // Overall revision content digest
  semantic_digest: string;           // Replay identity digest
  sealed_at: ISO8601Timestamp;       // Sealing timestamp
}
```

### Material Members (7 artifacts)
All artifacts are content-addressed by SHA256 digest:

1. **SC-1** - Workplace Material Authority (source-claim)
2. **SC-2** - Execution Provenance Separation (source-claim)
3. **SC-3** - Immutable Revision Sealing (source-claim)  
4. **CON-1** - Content Address Transport (constraint)
5. **UNK-1** - Acceptance Contract Scope (unknown - resolved)
6. **TC-1** - Workplace Production Revision Authority (terminal-claim)
7. **TC-2** - Content Address Acceptance Contract Transport (terminal-claim)

### Dependency Scope Resolution
**Scope Type:** Minimal-Complete

- ✅ **Direct Artifacts:** All 7 claims/constraints/unknowns/terminal claims
- ❌ **Transitive Dependencies:** External references not frozen (ADR-053, mental models serve as evidence only)
- ❌ **External References:** Not part of acceptance contract material
- ❌ **Workspace State:** Not included in frozen revision

**Rationale:** TC-1 establishes that WorkplaceProductionRevision captures the minimal complete set needed for acceptance contract authority - direct artifacts plus their immediate structural dependencies.

## Architectural Compliance

### ADR-053 Compliance
- ✅ WorkplaceProductionRevision as sole material authority
- ✅ WorkerExecution as provenance only (no material authority)
- ✅ Content address material referencing throughout

### CONVEYOR-MENTAL-MODEL.md Compliance  
- ✅ One logical desk principle
- ✅ Immutable revision sealing before QC boundaries
- ✅ Content address transport for material movement
- ✅ Execution provenance separation from material identity

### Workspace Requirement Compliance
- ✅ 0 accepted upstream revisions travel by content address
- ✅ All acceptance contract artifacts content-addressed
- ✅ No mutable identifiers for material transport

## Content Address Transport Implementation

### Protocol
- **Algorithm:** SHA256 cryptographic digest
- **Reference Format:** `sha256:<64-character-hex-digest>`
- **Verification:** Recompute digest on receipt, verify exact match

### Transport Flow
1. Artifact creation → SHA256 digest computation
2. Content digest becomes artifact identifier  
3. WorkplaceProductionRevision records all digests
4. Only content digests travel across process boundaries
5. Recipients verify integrity by recomputing SHA256
6. Authority resolution via exact content digest lookup

## Acceptance Criteria Status

All acceptance criteria from TC-1 and TC-2 are satisfied:

1. ✅ All acceptance contract artifacts are content-addressed
2. ✅ WorkplaceProductionRevision is immutable after sealing  
3. ✅ No downstream component reads material by execution ID
4. ✅ Material transport uses content digests only
5. ✅ Provenance (execution refs) is separate from material authority
6. ✅ Content digest verification at each transport boundary
7. ✅ WorkplaceProductionRevision serves as content digest registry
8. ✅ 0 accepted upstream revisions travel by content address

## Deliverables

1. **reconcile-what-desk-formalization.json** - Complete WorkplaceProductionRevision with material members
2. **reconcile-what-desk-formalization-trace.json** - Derivation trace and dependency graph
3. **reconcile-what-desk-formalization-summary.md** - This reconciliation summary

## Conclusion

The reconcile-what task has successfully formalized the define-acceptance-contract desk material scope. The reconciliation establishes WorkplaceProductionRevision as the sole material authority with 7 content-addressed artifacts, implements content address transport per CON-1, resolves UNK-1 through TC-1/TC-2 derivation, and maintains full compliance with ADR-053 and CONVEYOR-MENTAL-MODEL.md architectural requirements.

The formalization provides a complete, immutable, and content-addressed baseline for acceptance contract authority that can travel across process boundaries while maintaining material integrity and provenance separation.