# ADR-030: Development cell output source — typed schema'd products

- Status: Accepted
- Date: 2026-08-04
- Decider: ZCode agent (autonomous-decision skill, dictatorial pick)
- Supersedes: none (refines ADR-029 Slice 4)
- Related: ADR-029 (Production Cell runtime cutover)

## Context

ADR-029 mandates cutting the Development module over to declarative Production
Cells, preserving the settlement POLICY (`development-settlement-policy.ts`)
unchanged. The open question this ADR resolves: **where do the structured
fields the settlement policy consumes live after the cutover?** Today they are
reconstructed from five SQL tracker tables (`tasks`, `worker_executions`,
`integration_intents`, `verification_evidence`, `factory_development_task_projections`).
Production Cells seal CandidateSets of `ProductRef`s — which carry only
`{schemaId, ref, digest}`. The policy hard-requires structured lineage that a
bare ProductRef does not carry: `reviewedSourceCommit`, per-repo `treeHash`,
`integratedCommit`, `acceptanceCriterionId`, `acceptedCriterionHash`,
`candidateHash`, and a `trusted_providers`-resolved provider binding.

## Decision Drivers

- ADR-029 Red Team rejection: no "two authorities" (`tasks` AND Workplace).
- ADR-029 architecture ratchet: no Development vocabulary in the generic
  engine (`production-cell-node-executor.ts` must stay module-agnostic).
- Settlement policy determinism: the policy is FROZEN; only its INPUT SOURCE
  changes.
- Reversibility: the `DevelopmentSettlementStatePort` is a natural seam.

## Considered Options

### A. Typed schema'd products (CHOSEN)

Cell workers publish TYPED products whose payloads carry the exact structured
fields the settlement reader needs:
- `factory.development-implementation-result.v1` —
  `{workItemKey, reviewedSourceCommit, reviewedSourceCommitTreeHash,
    integratedCommit, targetBranch, projectRepositoryId, taskGraphHash}`.
- `factory.candidate-verification-evidence.v1` —
  `{verificationItemKey, acceptanceCriterionId, acceptedCriterionHash,
    candidateHash, provider, outcome, evidenceRef}`.

The new settlement reader resolves each accepted ProductRef to its typed body
and maps the bindings directly into `ImplementationWorkItemResult` /
`CandidateVerificationEvidence`. The CandidateSet stays generic
(`ProductRef[]`); Development semantics live in the product payloads.

### B. Keep worker DB writes, drop only the task-projection bridge

REJECTED — preserves `integration_intents` + `verification_evidence` as a
parallel DB authority alongside Workplace. This is exactly the "two
authorities" symptom ADR-029's Red Team forbids.

### C. Read from CandidateSets + GateDecisions + CheckReceipts directly

REJECTED after Red Team review — three fatal flaws:

1. **`observedCandidateHash` drift check is incompatible.** The policy
   (`development-settlement-policy.ts:657-664`) re-observes live git state at
   settlement time via `observeCandidate` and compares against the frozen
   candidate hash. CandidateSets are immutable sealed snapshots by design;
   they cannot re-observe. Retiring the SQL reconstruction removes the only
   producer of `observedCandidateHash`. Option C is internally inconsistent
   with a frozen policy.

2. **CheckReceipt is NOT a superset of CandidateVerificationEvidence.** It
   lacks `acceptanceCriterionId`, `acceptedCriterionHash`, `candidateHash`
   (it carries `subjectCandidateSetRef`, a different object), and its
   `CheckRef.providerId` is a string (`'tsc'`) incompatible with the policy's
   `trusted_providers` registry trust predicate (which needs
   `{providerId:number, category:'deterministic_evidence', trusted:boolean}`).

3. **Merge-branch attestation has no home.** The Workplace domain has zero
   concept of "merge to integration branch"; `integrationIntentRefs` (which
   encode `integratedCommit` + `targetBranch`) would be silently dropped.

Honest costing of C's "small extension" = re-derive Option A with a polluted
universal type. C is strictly more work AND violates the ratchet.

## MCDA Matrix (Weighted Sum)

Criteria descended from CONVEYOR-MENTAL-MODEL quality attributes + ADR-029
mandates. Scores 1–5.

| Criterion (weight) | A | B | C |
|---|---|---|---|
| ADR-029 single-authority match (0.25) | 5 | 2 | 5 |
| Engine isolation / ratchet (0.15) | 4 | 3 | 5 |
| Policy determinism preserved (0.20) | 5 | 5 | 5 |
| Reversibility (0.15) | 3 | 5 | 4 |
| Implementation cost (0.15) | 3 | 4 | 3 |
| Testability (0.10) | 4 | 4 | 3 |
| **Weighted sum** | **4.15** | **3.70** | **4.35** |

C narrowly led the raw matrix. The Red Team review (below) reversed the pick:
C's matrix score was an accounting fiction that treated a ratchet-violating
type extension + drift-check removal as "small".

## Pre-mortem (on the leading option C, before reversal)

Assume C shipped and failed 6 months later. Failure modes:

1. A repository force-push between candidate freeze and settlement is no
   longer detected — `observedCandidateHash` has no producer. Verified
   bundles ship against drifted code. **Severe.**
2. A reviewer cannot bind evidence to a specific acceptance criterion —
   CheckReceipt has no AC id. Verification lineage is unverifiable.
3. Workers self-attest `integratedCommit` without independent merge proof;
   unmerged code reaches the candidate.

All three are safety-critical invariants the policy exists to enforce.

## Red Team reversal

The Red Team proved with `file:line` evidence that:
- `sealCandidateSet` (`production-cell-node-executor.ts:1029-1048`) seals only
  `{ProductRef, origin, sourceCandidateSetRef}` — no structured lineage.
- The policy (`development-settlement-policy.ts:586,674-687,694-707,796-827`)
  hard-requires the fields C claims are redundant.
- `CheckReceipt` (`gate.ts:191-206`) lacks the AC binding + trust model.
- The Workplace domain (`src/process-modules/domain/workplace/`) has zero
  concept of merge-to-integration-branch.

The Red Team's recommendation — Option A gated on four deliverables — is
adopted verbatim as the Decision below.

## Decision

**Adopt Option A.** Cell workers publish typed schema'd products; the
settlement reader maps product bindings → `DevelopmentSettlementInput`. The
CandidateSet stays generic. Four deliverables:

1. Define `factory.development-implementation-result.v1` carrying
   `{workItemKey, reviewedSourceCommit, reviewedSourceCommitTreeHash,
     integratedCommit, targetBranch, projectRepositoryId, taskGraphHash,
     implementationWorksetHash}`. The implementation author gate fails closed
   if absent.
2. Define `factory.candidate-verification-evidence.v1` carrying
   `{verificationItemKey, acceptanceCriterionId, acceptedCriterionHash,
     candidateHash, provider, outcome}`. The verifier gate fails closed if
   absent. The existing `resolveVerificationProvider` trust check is reused
   unchanged.
3. **Keep `observedCandidateHash` and the live-git `observeCandidate` re-read
   exactly as implemented today** (`sqlite-development-settlement-state.ts:822-864`).
   It is orthogonal to the cutover and is a safety-critical invariant.
4. Keep the merge-attestation path — as the `integratedCommit` /
   `targetBranch` fields of the implementation-result product (Option A
   purist) — do NOT drop it.

## Consequences

- The new settlement reader depends on a product-PAYLOAD reader (resolves
  `ProductRef.ref` → typed body), not just the ref triple. This port must be
  added; the gate and the reader MUST read the same bytes (same store).
- `factory_development_task_projections` is retired (no writers after
  cutover); the table stays for legacy audit.
- The `DevelopmentTaskGraphPort.materializeValidatedTaskGraph` shrinks to a
  pure graph-product persist (no task projection).
- Reversibility: MEDIUM — code-level revert is a wiring swap; data-level
  revert is one-way per run (cell runs produce CandidateSets + typed products,
  not `integration_intents` rows).

## Decision Journal

- **Ex ante expectations (30/90 days):**
  - 30d: the new reader's unit tests assert that every accepted implementation
    product maps to an `ImplementationWorkItemResult` with non-null
    `reviewedSourceCommit`; every accepted verification product maps to a
    `CandidateVerificationEvidence` with a `trusted_providers`-resolved
    provider.
  - 90d: a mock factory run reaches terminal-verified with the cell path, and
    resume-after-crash re-emits identical product digests.
- **Check trigger:** Slice 5 mock run (ADR-029).
