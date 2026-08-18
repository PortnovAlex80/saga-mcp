# 07 — Gate and Check Provider System Design

> **Cutover note:** deleted compatibility acceptance and pre-ADR-067 physical
> source descriptions below are historical only. Current Gates consume exact
> WorkplaceProductionRevision/CandidateSet authority and source-blind ProductRefs.

The deterministic validation layer that decides whether a worker's production
is accepted. After a worker produces a candidate, the **Gate** runs
deterministic checks (`GateDecision`) over an immutable `CandidateSet`
snapshot and emits a closed verdict that alone may advance the cell.

This document maps every gate, every check provider, every validation rule,
and every failure mode. It is intended for engineers writing scripted factory
tests who need their scripted workers to PASS the gate deterministically.

---

## 1. The three layers of a universal quality gate

The factory (per `FACTORY-DOMAIN-ACCEPTANCE-REGISTRY` REG-13..18 and the
Conveyor v4 mental model) separates "worker finished" from "product accepted"
through three independent layers. The separation is load-bearing — a
`worker_done` never flips an artifact to accepted; only a GateDecision does.

```
            ┌─────────────────────────────────────────────────────────┐
            │  WORKER EXECUTION (LM)                                  │
            │  produces artifacts + traces via MCP tools              │
            │  → worker_done seals CandidateSet, does NOT accept      │
            └────────────────────────┬────────────────────────────────┘
                                     │ immutable CandidateSet snapshot
                                     ▼
            ┌─────────────────────────────────────────────────────────┐
            │  LAYER 1 — CORE INTEGRITY GATE (conveyor itself)        │
            │  exact refs, hashes, contract identity, cardinality,    │
            │  lineage, producer provenance                           │
            └────────────────────────┬────────────────────────────────┘
                                     │
                                     ▼
            ┌─────────────────────────────────────────────────────────┐
            │  LAYER 2 — DECLARED CHECKPLAN                           │
            │  versioned refs to schema/policy/lint/build/test        │
            │  checks, each running through a CheckProvider plugin     │
            │  (the plan CANNOT run candidate-supplied arbitrary      │
            │  shell — REG-14-AC-01)                                  │
            └────────────────────────┬────────────────────────────────┘
                                     │ emits one CheckReceipt per entry
                                     ▼
            ┌─────────────────────────────────────────────────────────┐
            │  LAYER 3 — DECISION POLICY (deterministic reducer)      │
            │  reduces receipts → ONE closed verdict                  │
            │  accepted | repair_required | human_required | failed   │
            │  (only the GateDecision may advance the Kanban)         │
            └─────────────────────────────────────────────────────────┘
```

Source: `src/process-modules/domain/workplace/gate.ts` lines 33-52.

---

## 2. Core domain types (the contract)

All gate types live in `src/process-modules/domain/workplace/gate.ts` and are
**pure domain** (no SQLite, no MCP, no clock).

### 2.1 CheckOutcome (4-valued)

```ts
export type CheckOutcome = 'passed' | 'failed' | 'unknown' | 'error';
```

Source: `gate.ts:74`.

The four values mirror CGAD's guard verdict:

| Outcome | Meaning | Gate treatment |
|---|---|---|
| `passed` | deterministic evidence confirmed the claim | contributes to `accepted` |
| `failed` | deterministic evidence refuted the claim | forces `repair_required` |
| `unknown` | inputs insufficient — deny-by-default (CGAD P14) | `repair_required` (fail-closed plan) |
| `error` | provider crashed | `repair_required` AND incident (fail-closed plan) |

REG-14-AC-03 forbids promoting `unknown`/`error` to `accepted` without an
explicit safe policy.

### 2.2 CheckRef / CheckPlan / CheckPlanEntry

A `CheckRef` names ONE installed `CheckProvider` (id + version + digest):

```ts
export interface CheckRef {
  readonly providerId: string;       // e.g. 'formalization.srs-structural.v1'
  readonly version: string;          // e.g. '1.0.0'
  readonly providerDigest: string;   // digest over the installed provider
}
```

A `CheckPlanEntry` binds a `CheckRef` to the **pinned** parameters the
provider will run with (REG-14-AC-01: the plan MUST NOT contain
candidate-supplied arbitrary shell):

```ts
export interface CheckPlanEntry {
  readonly check: CheckRef;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly repairTargetRoleOnFailure?: 'author' | 'reviewer';
  readonly repairTargetRoleOnIndeterminate?: 'author' | 'reviewer';
  readonly indeterminateDisposition?: 'repair' | 'human-required';
  readonly environmentRef: string | null;
}
```

A `CheckPlan` is a versioned, content-addressed declaration of what to check
and how to decide (REG-14):

```ts
export interface CheckPlan {
  readonly checkPlanId: string;        // e.g. 'formalization.architecture-check-plan.v1'
  readonly version: string;
  readonly checkPlanDigest: string;    // sha256 over id+version+entries+policy
  readonly entries: readonly CheckPlanEntry[];
  readonly decisionPolicyRef: string;
  readonly decisionPolicyDigest: string;
  readonly unknownErrorPolicy: 'fail-closed' | 'fail-open-safe';
}
```

Source: `gate.ts:82-145`.

### 2.3 CheckProvider plugin contract

```ts
export interface CheckProvider {
  readonly providerId: string;
  readonly version: string;
  run(input: {
    readonly subjectCandidateSetRef: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly environmentRef: string | null;
    readonly candidateSnapshot: Readonly<Record<string, unknown>>;
  }): Promise<CheckProviderResult> | CheckProviderResult;
}
```

Source: `gate.ts:166-191`.

Hard constraints on providers:
- Read-only w.r.t. authoritative state, or fully sandbox-contained (REG-16).
- CANNOT move the Workplace/Flow (REG-16-AC-02).
- Cannot write a GateDecision (REG-18 reserved to the coordinator).
- Cannot launch a hidden worker/human (REG-16-AC-03).

### 2.4 CheckReceipt (REG-17)

Immutable evidence that one check ran. The driver creates it from a
`CheckProviderResult`:

```ts
export interface CheckReceipt {
  readonly checkReceiptRef: string;
  readonly checkRunRef: string;                  // GateRun ref
  readonly subjectCandidateSetRef: string;
  readonly assessmentCandidateSetRefs: readonly string[];
  readonly check: CheckRef;
  readonly environmentRef: string | null;
  readonly outcome: CheckOutcome;
  readonly evidenceRefs: readonly string[];
  readonly receiptDigest: string;                // sha256 over body
}
```

Source: `gate.ts:207-222`. Cannot be rebound (REG-17-AC-01); a change of
provider/version/environment creates a NEW receipt (REG-17-AC-02).

### 2.5 GateRun (REG-15)

One authorized inspection of one exact CandidateSet:

```ts
export interface GateRun {
  readonly gateRunRef: string;
  readonly workplaceRef: WorkplaceRef;
  readonly gatePhase: 'author' | 'final';
  readonly subjectCandidateSetRef: string;
  readonly assessmentCandidateSetRefs: readonly string[];
  readonly checkPlanRef: string;
  readonly checkPlanDigest: string;
  readonly expectedWorkplaceRevision: number;    // CAS must match this
  readonly gateLeaseRef: string;
  readonly state: 'claimed' | 'checking' | 'decided' | 'terminal';
}
```

Source: `gate.ts:247-261`. One-shot: claim → checking → decided → terminal.
Has its own lease and authority — a live worker fence is NOT required at
check time, because the GateRun reads immutable submit/seal receipts that
prove the worker's authority at commit time (REG-15-AC-02).

### 2.6 GateDecision (REG-18) — THE heart of OTK

The closed verdict:

```ts
export type GateVerdict = 'accepted' | 'repair_required' | 'human_required' | 'failed';
```

Source: `gate.ts:284-288`. Additive-only.

| Verdict | When | Effect |
|---|---|---|
| `accepted` | All receipts `passed` | Cell advances; **author-gate** leaves `acceptedOutputBindings` empty (REG-18-AC-02), only **final-gate** accepted publishes output (REG-18-AC-03) |
| `repair_required` | ≥1 receipt `failed` or `unknown`/`error` (fail-closed plan) | MUST name `repairTargetRole` (REG-18-AC-04); card returns to author/reviewer queue |
| `human_required` | Indeterminate check with `indeterminateDisposition: 'human-required'`, or two checks disagree on repair role | Stop the line, REG-22 blocked/paused with durable resume target |
| `failed` | Recovery budget exhausted (REG-20-AC-03) | Terminal failure, not retryable |

The full decision shape:

```ts
export interface GateDecision {
  readonly workplaceRef: WorkplaceRef;
  readonly gateRef: string;
  readonly gateRunRef: string;
  readonly gatePhase: 'author' | 'final';
  readonly transitionRef: string;
  readonly subjectCandidateSetRef: string;
  readonly assessmentCandidateSetRefs: readonly string[];
  readonly verdict: GateVerdict;
  readonly repairTargetRole: RepairTargetRole | null;   // REQUIRED iff repair_required
  readonly checkPlanRef: string;
  readonly checkPlanDigest: string;
  readonly decisionPolicyRef: string;
  readonly decisionPolicyDigest: string;
  readonly checkReceiptRefs: readonly string[];          // exact refs the policy reduced
  readonly installationDigest: string;
  readonly decisionKey: string;                          // deterministic, idempotent
  readonly acceptedOutputBindings: readonly AcceptedOutputBinding[];  // empty unless final-accepted
  readonly recoveryIssueRef: string | null;              // non-null iff repair_required
  readonly decisionDigest: string;                       // 64-char hex sha256
}
```

Source: `gate.ts:330-363`.

Cross-field validation (`assertValidGateDecision`, `gate.ts:383-436`):
- All `Ref`/`Digest`/`Key` strings must be non-empty.
- `verdict=repair_required` ⇒ `repairTargetRole !== null` AND `recoveryIssueRef !== null`.
- Any other verdict ⇒ both must be `null`.
- `acceptedOutputBindings.length > 0` ONLY when `verdict=accepted`.
- `decisionDigest` must be 64-char lowercase hex sha256.

---

## 3. The GateRun driver (`driveGateRun`)

Source: `src/process-modules/application/gate-run-driver.ts:56-180`.

The driver orchestrates one immutable quality inspection. It is currently
**synchronous** — a provider returning a `Promise` throws
`ASYNC_CHECK_PROVIDER_UNSUPPORTED`.

Driver flow:

```
1. Compute deterministic gateRunRef from
     sha256({gatePhase, subjectCandidateSetRef, assessmentCandidateSetRefs, checkPlanDigest})
   → 'gate-run:<hex>'.

2. repo.createGateRun({...}) — INSERT OR IGNORE (idempotent on gateRunRef).

3. repo.setGateRunState(gateRunRef, 'checking').

4. FOR EACH entry in checkPlan.entries:
     a. providers.resolve(entry.check.providerId)
        - missing provider → throws CHECK_PROVIDER_MISSING
        - version mismatch → throws CHECK_PROVIDER_VERSION_MISMATCH
     b. provider.run({subjectCandidateSetRef, parameters, environmentRef, candidateSnapshot:{}})
        - Promise result → throws ASYNC_CHECK_PROVIDER_UNSUPPORTED
     c. unwrap outcome + evidenceRefs from CheckProviderResult.
     d. build receipt, ref = 'receipt:<gateRunRef>:<providerId>'.
     e. repo.recordCheckReceipt(receipt).

5. reduceReceipts(receipts, checkPlan) → GateVerdict + repairTargetRole.
     - for each receipt:
         failed → repairTargetRole = entry.repairTargetRoleOnFailure ?? 'author'
         unknown/error (fail-closed plan):
            indeterminateDisposition==='human-required' → return human_required
            else repairTargetRole = entry.repairTargetRoleOnIndeterminate
                                    ?? entry.repairTargetRoleOnFailure
                                    ?? 'author'
     - if two checks disagree on repair target role → return human_required
     - any repair → repair_required (target ?? 'author')
     - no repair → accepted

6. repo.setGateRunState(gateRunRef, 'decided').

7. Build GateDecision (decisionKey = 'decision:<gateRunRef>', etc.) and
   repo.recordDecision(decision) — asserts validity and idempotency.

8. repo.setGateRunState(gateRunRef, 'terminal').

9. Return { decision, receipts }.
```

Key receipts/receipts digest helpers:
- `hashReceipt(...)` — sha256 over the receipt body (ref, run, set, refs,
  check, env, outcome, evidence).
- `hashDecision(key, verdict, role, receipts)` — sha256 over the decision
  essence.

---

## 4. Gate taxonomy — ALL gates in the factory

The factory has gates at three granularity levels:

### 4.1 Per-node submission gates (shift-left)

Run at the `worker_done` boundary, BEFORE the task transitions. Implemented
via `NodeSubmissionValidator` wrapped as a `CheckProvider` by
`submissionValidatorCheckProvider` (`submission-validator-check-provider.ts`).
Registered for every formalization node in
`src/process-modules/application/wire-submission-validation.ts`.

These are NOT GateRuns; they are synchronous validation that throws
`SubmissionValidationError` on rejection, leaving the worker fence alive.
They share their validation logic with the gate-layer providers (no rule
duplication).

### 4.2 Production Cell gate runs

Run after the CandidateSet is sealed. The driver in `gate-run-driver.ts`
runs them. Currently the only gate run is the formalization architecture
gate (`runArchitectureGate`).

### 4.3 Settlement gates (kernel handlers)

Run inside the kernel handler chain (e.g. `formalization-resolve-product-
contract`). These use `findContractGap` to check traceability and
`ExactCandidateAcceptance` to do the artifact CAS. They are the AUTHORITATIVE
traceability gate for the per-node exact-set.

### Full taxonomy table

| Gate | Module / Node | Artifact type | Validation function | Schema / contract |
|---|---|---|---|---|
| Product contract | formalization / `define-product-contract` | PRD, FR, NFR, RULE | `createFormalizationContractValidator({product:true})` | `FORMALIZATION_PRODUCT_BUNDLE_SCHEMA` |
| Use cases | formalization / `model-use-cases` | UC | `createFormalizationContractValidator({product:true,useCases:true})` | `FORMALIZATION_USE_CASE_BUNDLE_SCHEMA` |
| Acceptance contract | formalization / `define-acceptance-contract` | AC | `createAcceptanceContractValidator` | `FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA` |
| Reconciliation | formalization / `reconcile-what` | (none new — verifies upstream) | `createFormalizationContractValidator({product:true,useCases:true,acceptance:true})` | `FORMALIZATION_RECONCILIATION_SCHEMA` |
| Architecture / SRS (shift-left) | formalization / `define-architecture-contract` | SRS | `createSrsContractValidator` | `FORMALIZATION_SRS_SCHEMA`, contract v2.2 |
| Architecture / SRS (gate run) | formalization / `define-architecture-contract` (cell) | SRS | `createSrsStructuralCheckProvider` via `driveGateRun` | `buildArchitectureCheckPlan()` |
| Discovery proposal | discovery / `produce-proposal` | typed proposal product | `createDiscoveryProposalCheckProvider` | `DISCOVERY_PROPOSAL_SCHEMA` |
| Discovery readiness | discovery / `assess-readiness` | typed readiness product | `createDiscoveryReadinessCheckProvider` | `DISCOVERY_READINESS_ASSESSMENT_SCHEMA` |
| Development task graph | development / `plan-task-graph` | typed graph proposal | `createDevelopmentTaskGraphCheckProvider` | `DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA` |
| Development verification evidence | development / `verify-acceptance` | typed evidence product | `createDevelopmentVerificationCheckProvider` (always returns `unknown`) | `DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA` |
| Acceptance baseline freeze | formalization / `freeze-acceptance-baseline` | baseline snapshot | `createBaselineFreezerHandler` | `ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA` |
| Settlement | formalization / settlement | full contract | `createSettlementHandler` + `findContractGap({product,useCases,acceptance,architecture})` | `SOLUTION_CONTRACT_CERTIFICATE_SCHEMA` |

### 4.4 Standard check provider (always-registered)

`PRODUCT_CONTRACT_CHECK_PROVIDER_ID = 'factory.product-contract.v1'` is
auto-registered in `FactoryCheckProviderRegistry` constructor and **always
returns `'passed'`** (`standard-check-providers.ts:13-19`). It is included
in every CheckPlan built by `buildCheckPlan` unless
`{includeProductContract: false}` is passed.

### 4.5 Verification check providers (L4 sandbox)

In `src/infrastructure/verification/accessible-counter-check-providers.ts`:

- `ACCESSIBLE_COUNTER_CHECK_PROVIDER_ID = 'factory.accessible-counter-sandbox-check.v1'`
  (category: `deterministic_evidence`, determinism: full).
- `AUTHORIZED_OBSERVER_CHECK_PROVIDER_ID = 'factory.authorized-verification-observer.v1'`
  (category: `authorized_decision`, determinism: none).

These back the L4 property-test sandbox for verification.

---

## 5. Formalization gates (most complex)

Formalization has the richest validation because it owns the requirements
graph (PRD → FR/NFR → UC → AC → SRS). Validation runs at two layers:

### 5.1 Shift-left submission validators

Registered per node in `wire-submission-validation.ts`. They share logic
with the resolver handlers — `findContractGap` for traceability, the
`srs-d2-parser` for SRS structure.

#### 5.1.1 SRS contract validator (the hardest)

Source: `src/modules/formalization/application/srs-contract-validator.ts`.

`SRS_CONTRACT_VALIDATOR_ID = 'formalization.srs-contract.v1'`,
`SRS_CONTRACT_VALIDATOR_VERSION = '1.1.0'`.

**Validation sequence (lines 89-352 of `srs-contract-validator.ts`):**

```
0. contractRef mismatch check (T1.6)
   - If caller pins a contract version, MUST match SRS_CONTRACT_REF exactly.
   - Reject → code: 'SRS_CONTRACT_VERSION_MISMATCH'.

1. SRS artifact must exist (T1.2, fail-closed)
   - SELECT SRS artifact from artifacts JOIN factory_managed_artifact_productions
     WHERE process_run_id=? AND type='SRS'.
   - Missing → code: 'FORMALIZATION_SRS_MISSING'.

2. SRS → PRD derived_from trace must exist
   - SELECT FROM artifact_traces WHERE source_id=srs.id AND link_type='derived_from'
     AND target.type='PRD'.
   - Missing → adds a derived_from gap.

3. Repository binding must exist (fail-closed)
   - SELECT local_path FROM project_repositories WHERE id=srs.project_repository_id.
   - Missing/no local_path → adds repository-binding gap, returns early.

4. SRS file must exist on disk (fail-closed)
   - path.join(repo.local_path, srs.path.split('#')[0])
   - !existsSync → adds file-exists gap, returns early.

5. File content hash MUST match artifact.content_hash (T1.2)
   - sha256(fileContent) === srs.content_hash
   - Mismatch → adds file-hash-match gap, returns early (hard stop).

6. §12 Decision Log section + columns (T1.3)
   - checkDecisionLogSection(fileContent)
   - Section heading: /^(#{1,4})\s*§?\s*12[^\n]*Decision Log/i
   - Must have either:
       (a) a markdown table with ≥ decisionLogColumns.length (6) header cells, OR
       (b) ≥1 ### or #### Decision N subsection.
   - Failure → adds decision-log-columns OR section gap.

7. §D2 representation + exact frozen-AC binding (T1.3, T1.4)
   - extractD2Stanzas + validateD2Structure (see §5.3 below)
   - Each gap → adds a structured gap with d2-representation/d2-field/etc.

8. Frozen baseline cross-check
   - readFrozenBaseline(processRunId) from factory_formalization_acceptance_baselines
   - For each frozen AC code: stanza MUST exist exactly once
       missing → 'represented_by' gap "Frozen ${code} is missing from §D2"
   - For each stanza ac: MUST be in baseline
       extra → 'exact-frozen-ac-code' gap "§D2 code ${ac} is not in the frozen baseline"
   - Baseline missing/unreadable → adds frozen-acceptance-baseline gap.

If any gaps → reject with code 'FORMALIZATION_SRS_INCOMPLETE' and full details.
Otherwise accept with receipt (artifactIds + hashes, validatedSetDigest).
```

#### 5.1.2 Acceptance contract validator

Source: `acceptance-contract-validator.ts`.

`ACCEPTANCE_CONTRACT_VALIDATOR_ID = 'formalization.acceptance-contract.v1'`,
version `1.0.0`.

Validates every AC has the mandatory edges:
- Every AC must have `derived_from` → exact FR OR exact NFR.
- An FR-derived AC must ALSO have `derived_from` → exact UC.

Failure code: `FORMALIZATION_ACCEPTANCE_INCOMPLETE` with structured gaps.

#### 5.1.3 Generic formalization contract validator

Source: `formalization-contract-validator.ts`. Reused for Product, UC, and
Reconciliation nodes (validator IDs `formalization.product-contract.v1`,
`formalization.use-cases.v1`, `formalization.reconciliation.v1`).

Failure code: `FORMALIZATION_CONTRACT_INCOMPLETE`.

#### 5.1.4 Submission validation flow

The dispatcher (`src/tools/dispatcher.ts:579-592`) calls
`validateSubmissionIfRequired` for `in_progress → review/done` transitions
only (NOT for reviewer verdicts). A rejection:
1. Persists a rejection row + feedback pointer in the same transaction.
2. Returns a sentinel `{kind: 'submission-rejected', error}` so BEGIN
   IMMEDIATE commits.
3. The outer handler then throws the actionable MCP error.

---

### 5.2 The architecture gate run (Production Cell)

Source: `formalization-installation.ts:842-1001, 1017-1124` and
`architecture-check-plan.ts`.

When the architecture handler decides the contract is complete
(`event === 'completed'`), it:
1. Seals a CandidateSet from the worker's SRS artifact
   (`sealArchitectureCandidateSet`, lines 1017-1062).
2. Drives a GateRun with the SRS structural check plan
   (`runArchitectureGate`, lines 1075-1124).
3. If `gateDecision.verdict === 'accepted'` → proceeds with
   ExactCandidateAcceptance.
4. Otherwise returns an `inconsistent` event with `gateVerdict`,
   `gateDecisionKey`, `gateReceipts`, `gap: 'Gate verdict: ${verdict}'`.

The CheckPlan (built by `buildArchitectureCheckPlan`):

```ts
{
  checkPlanId: 'formalization.architecture-check-plan.v1',
  version: '1.0.0',
  entries: [
    {
      check: {
        providerId: 'formalization.srs-structural.v1',
        version: '1.0.0',
        providerDigest: 'srs-structural-v1-digest',
      },
      parameters: {},
      environmentRef: null,
    },
  ],
  decisionPolicyRef: 'formalization.architecture-gate-policy.v1',
  decisionPolicyDigest: sha256('fail-closed-blocker-default-v1'),
  unknownErrorPolicy: 'fail-closed',
}
```

The driver calls `runArchitectureGate` with `checkParameters: {srsArtifactRef}`,
where `srsArtifactRef = 'artifact:${srsArtifact.id}'`. Note:
`expectedWorkplaceRevision = 1` (the materialized initial revision; future
ConveyorRuntime will CAS on the actual revision).

---

### 5.3 The SRS structural check provider

Source: `src/modules/formalization/application/srs-structural-check-provider.ts`.

```
providerId   : 'formalization.srs-structural.v1'
version      : '1.0.0'
providerDigest: 'srs-structural-v1-digest'  (literal string)
```

This is the first concrete CheckProvider for the Production Cell architecture
gate. It performs the SAME structural checks as the SRS submission validator
but runs inside a GateRun AFTER the CandidateSet is sealed.

The provider expects `parameters.srsArtifactRef` (string) and uses an
injected `SrsContentReader` to read the SRS content from disk.

`run()` algorithm (lines 59-89):

```
1. parameters.srsArtifactRef must be a non-empty string → else 'failed'.
2. contentReader.readSrsContent(srsRef)
   - null (file missing, hash mismatch, I/O) → 'unknown'.
3. checkDecisionLogSection(content) → if non-null, 'failed'.
4. validateD2Structure(content) → if any gaps, 'failed'.
5. extractD2Stanzas(content).length > 0 → else 'failed'.
6. else → 'passed'.
```

---

### 5.4 The SRS D.2 parser (srs-d2-parser.ts)

Source: `src/modules/formalization/application/srs-d2-parser.ts`.

This is the strict §D2 YAML-stanza parser shared by both the submission
validator AND the Production Cell structural check. The representation is
narrow: **exactly one explicit §D2 AC Map/Decomposition heading containing
exactly one fenced YAML block**. Markdown tables and headings such as
`D.2 AC-2` are NOT canonical and are rejected.

#### 5.4.1 What format does it expect?

The canonical heading regex (`srs-d2-parser.ts:36`):

```ts
const CANONICAL_HEADING =
  /^(#{2,4})\s*§D\.?2\b[^\n]*(?:AC\s*(?:Map|Mapping)|Decomposition)[^\n]*$/gim;
```

Acceptable headings include:
- `## §D2 AC Map`
- `### §D.2 AC Mapping`
- `#### §D2 Decomposition`

The YAML block regex (`srs-d2-parser.ts:37`):

```ts
const YAML_BLOCK = /```(?:yaml|yml)\s*\r?\n([\s\S]*?)```/gi;
```

Parser flow (`parseD2`, lines 50-164):
1. Find exactly 1 heading — 0 or >1 → `invalid-representation` gap.
2. Slice the section (between this heading and the next same-or-higher level).
3. Find exactly 1 YAML block — 0 or >1 → `invalid-representation` gap.
4. If the section outside YAML contains `- ac:` or `| ac |` (markdown table
   mix) → `invalid-representation` gap ("mixes YAML with another
   decomposition representation").
5. Parse each YAML stanza:
   - Stanza start: `/^\s*-\s+ac\s*:\s*(.*?)\s*$/i`
   - Field: `/^\s{2,}([a-z][a-z0-9_]*)\s*:\s*(.*?)\s*$/i` (≥2 spaces indent)
   - Scalars: clean by stripping surrounding quotes then trimming
     trailing `# comment`.
6. Track duplicates: duplicate `ac` value → `duplicate-ac`; duplicate field
   within a stanza → `duplicate-field`.
7. Malformed lines → `malformed-yaml-line`.

#### 5.4.2 What does it extract?

A `D2Stanza[]`:

```ts
export interface D2Stanza {
  readonly ac: string;
  readonly fields: ReadonlyMap<string, string>;
}
```

Each stanza's `fields` map includes `'ac'` itself plus every other field
(`title`, `module`, `files`, `invariants`, `test_layers`, `pattern`,
`depends_on`, `ac_kind`, `criticality`).

#### 5.4.3 Required fields and enums

From `SRS_CONTRACT` (`src/modules/formalization/domain/srs-contract.ts`):

```ts
d2RequiredFields: [
  'ac', 'title', 'module', 'files', 'invariants', 'test_layers',
  'pattern', 'depends_on', 'ac_kind', 'criticality',
],
d2EnumFields: {
  ac_kind:      ['implementation', 'verification'],
  pattern:      ['A', 'B'],
  criticality:  ['blocker', 'degradable', 'nice_to_have'],
},
decisionLogColumns: ['#', 'Decision', 'Source/profile',
                     'Alternatives considered', 'Rationale', 'Date'],
```

`validateD2Structure(content)` (`srs-d2-parser.ts:190-231`):
- For each stanza, every required field must be present and non-empty
  (else `missing-required-field` or `empty-required-field`).
- Enum fields (`ac_kind`, `pattern`, `criticality`) must have a valid value
  (else `invalid-enum-value` with `allowedValues`).
- If 0 stanzas and 0 gaps → adds `invalid-representation` ("§D2 contains no
  YAML stanzas").

#### 5.4.4 Contract versioning

`SRS_CONTRACT_VERSION = '2.2'`, `SRS_CONTRACT_DIGEST = sha256(JSON.stringify(SRS_CONTRACT))`.

When the contract changes:
1. Bump `SRS_CONTRACT_VERSION`.
2. Recompute digest.
3. Update architect skill, template, validator, reviewer.

Old SRS artifacts created under a previous version are NOT retroactively
re-checkable — their metadata carries the version they were created under.

#### 5.4.5 Decision Log section check

`checkDecisionLogSection(content)` (`srs-d2-parser.ts:233-256`):
1. Find a heading matching `§?12[...]*Decision Log` (or any `*Decision Log`).
2. Slice the section.
3. Look for a markdown table row `\|([^\n]*\|)+`.
4. If no table row, check for `#{3,4}\s*Decision\s*\d/i` subsections.
5. Table header cells (excluding separator rows) must be ≥
   `decisionLogColumns.length` (6).
6. Policy: `decisionLogPolicy: 'semantic-coverage-no-numeric-minimum'` —
   the column count is checked, but the number of decision rows is not
   numerically minimum-enforced.

#### 5.4.6 Canonical example (the format a script MUST produce)

```
## §12 Decision Log

| # | Decision | Source/profile | Alternatives considered | Rationale | Date |
|---|----------|----------------|-------------------------|-----------|------|
| 1 | Use Postgres | architect/v2.2 | SQLite, DynamoDB | ACID + tooling | 2026-08-10 |

## §D2 AC Map

```yaml
- ac: AC-1
  title: Exact frozen AC title
  module: core
  files: [src/core.ts]
  invariants: [INV-1]
  test_layers: [L0]
  pattern: A
  depends_on: []
  ac_kind: implementation
  criticality: blocker
- ac: AC-2
  title: Performance budget met
  module: core
  files: [src/core.ts]
  invariants: [INV-2]
  test_layers: [L3]
  pattern: B
  depends_on: [AC-1]
  ac_kind: verification
  criticality: degradable
```
```

---

### 5.5 Contract snapshot & findContractGap (traceability gate)

Source: `formalization-installation.ts:1581-1763`.

`buildContractSnapshot(graph, artifacts)`:
1. Collects exact (owned) artifacts.
2. Reads outgoing artifact traces via the graph port.
3. Reads target artifacts.
4. **Filters traces to only the canonical edges**:
   - `PRD --derived_from--> brief` (or any non-product ancestor at the node gate)
   - `UC --derived_from--> PRD`
   - `UC --covers--> FR`
   - `AC --derived_from--> FR | NFR | UC`
   - `SRS --derived_from--> PRD`

`findContractGap(snapshot, required)` — returns null if complete, else a
';'-joined gap string. Cardinality checks return early with a single gap:

| Dimension | Cardinality | Edge checks |
|---|---|---|
| `product` | exactly 1 PRD, ≥1 FR | PRD → root ancestor (any non-OWN_PRODUCT_TYPE) |
| `useCases` | ≥1 UC | each UC → derived_from PRD AND covers FR |
| `acceptance` | ≥1 AC | each AC → derived_from (FR OR NFR); FR-derived AC → also UC |
| `architecture` | exactly 1 SRS | SRS → derived_from PRD |

`OWN_PRODUCT_TYPES = {PRD, FR, NFR, RULE, UC, AC, SRS}` — the root ancestor
must NOT be one of these (so a `brief` or `decision` qualifies).

**Important duplicate:** there is a second, deliberately different
traceability check, `findFirstTraceabilityGap` in
`sqlite-formalization-kernel.ts`, AUTHORITATIVE for the settlement
certificate (RULE-012). It runs against the LIVE epic-wide artifact_traces
and requires the literal `brief` edge. The two are NOT consolidated — see
the comment at `formalization-installation.ts:1638-1675`.

---

### 5.6 Baseline drift check

`findBaselineDrift(graph, baseline)` (`formalization-installation.ts:2295-2312`):
1. Read AC artifacts by the baseline's `acArtifactIds`.
2. If any missing → return all missing IDs.
3. Drifted = artifacts where type != AC, OR not accepted+clean, OR
   `baseline.acArtifactHashes[id] !== artifact.contentHash`.
4. If recomputed `acceptanceBaselineHash(artifacts) !== baseline.baselineHash`
   → return ALL drifted + ALL artifacts (set-level drift).

`isAcceptedClean(artifact)` (`formalization-installation.ts:2373-2378`):
```
status === 'accepted'
&& isSha256(contentHash)
&& acceptedHash === contentHash
&& driftState === 'clean'
```

---

## 6. Discovery gates

### 6.1 Proposal check provider

Source: `src/modules/discovery/application/discovery-check-providers.ts:42-61`.

```
providerId: 'discovery.proposal-contract.v1'
version:    '1.0.0'
invariant:  'discovery-proposal-schema-and-required-fields'
```

Validates against `DISCOVERY_PROPOSAL_SCHEMA = 'factory.discovery-proposal.v1'`
and `validateDiscoveryProposal` (`src/modules/discovery/domain/discovery-proposal.ts:68`):

- Required non-empty strings: `problem_statement`, `observed_context`,
  `candidate_scope`, `rationale`.
- Required string arrays: `stakeholders_or_actors`, `assumptions`,
  `unknowns`, `risks`, `evidence_refs`.
- `recommended_outcome` must be one of: `go | clarify | reject | defer |
  inconclusive | failed`.

### 6.2 Readiness check provider

Source: `discovery-check-providers.ts:63-110`.

```
providerId: 'discovery.readiness-contract.v1'
version:    '1.0.0'
invariant:  'readiness-binds-exact-accepted-proposal-and-cites-only-allowed-sources'
```

Validates against
`DISCOVERY_READINESS_ASSESSMENT_SCHEMA = 'factory.discovery-readiness-assessment.v2'`
and `validateReadinessAssessment` (lines 156-322 of
`discovery-readiness-assessment.ts`).

The provider additionally:
1. Loads the **accepted proposal** for the process run
   (`node_id='produce-proposal'`, schema = proposal schema).
2. Computes `allowedProposalSourceRefs` from the proposal's keys and
   `evidence_refs`.
3. Calls `validateReadinessAssessment(payload, proposal.id,
   proposal.content_hash, allowedRefs)`.

The validator's rules:
- `proposal_id` must equal `expectedProposalId` (integer).
- `proposal_content_hash` must be lowercase 64-char sha256 AND match the
  stored proposal's hash.
- `overall_readiness` ∈ {ready, conditionally_ready, not_ready, inconclusive}.
- `recommended_next_action` ∈ {proceed_to_settlement, request_clarification,
  repeat_discovery, defer, reject, manual_review}.
- `confidence` finite, ∈ [0, 1].
- `rationale` non-empty.
- `dimension_assessments` must include EXACTLY the seven required dimensions
  (`problem_clarity`, `scope_boundedness`, `stakeholder_coverage`,
  `assumption_visibility`, `unknowns_manageability`, `risk_visibility`,
  `evidence_grounding`) — no more, no less. Each dimension has a `status`
  ∈ {sufficient, partial, insufficient, unknown}, non-empty `rationale`,
  and ≥1 `source_refs` entry (P1-1 grounding requirement).
- `blocking_gaps` and `non_blocking_gaps` well-formed with non-empty unique
  `code`, non-empty `description`, ≥1 `source_refs` each.
- Codes unique WITHIN each list AND across the two lists.
- **Anti-invent-evidence**: every `source_ref` must resolve to an allowed
  identifier from the canonical Proposal. Anything else → "unresolved
  source reference" error.

D3 is **advisory/shadow-only** — the assessment CANNOT change the discovery
outcome or settle. Only D4 settlement makes the proposal authoritative.

---

## 7. Development gates

### 7.1 Task graph check provider

Source: `src/modules/development/application/development-check-providers.ts:84-132`.

```
providerId: 'development.task-graph-contract.v1'
version:    '1.0.0'
invariant:  'development-task-graph-validates-before-cell-acceptance'
```

Algorithm:
1. Read `processRunId` from parameters (positive integer, else `'error'`).
2. Read the author CandidateSet (must be author role, else `'error'`).
3. Read the latest `factory_managed_node_submissions` row for
   (productionRevisionRef, exact ProductRef). Schema MUST equal
   `DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA`, else `'failed'`.
4. `decodeDevelopmentTaskGraphProposal(JSON.parse(payload))` — must decode
   OK, else `'failed'`.
5. Read `factory_process_runs.input_schema` — MUST equal
   `DEVELOPMENT_CASE_SCHEMA`, else `'error'`.
6. `buildCanonicalDevelopmentTaskGraph(developmentCase, proposal, ref)`.
7. `policy.validate(developmentCase, graph).valid ? 'passed' : 'failed'`.
8. Any throw → `'error'`.

### 7.2 Verification evidence check provider

Source: `development-check-providers.ts:134-210`.

```
providerId: 'development.verification-product-contract.v2'
version:    '2.0.0'
invariant:  'verification-product-shape-and-frozen-lineage-before-acceptance'
```

Algorithm:
1. Validate processRunId, candidate, candidate.members.length === 1.
2. Member schema MUST equal
   `DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA` AND ref MUST start with
   `managed-node-submission:`. Else `'failed'`.
3. Read the submission row joined with `tasks.verification_target_artifact_id`
   and `artifacts.accepted_hash`. `content_hash` MUST equal
   `member.productRef.digest`, else `'failed'`.
4. `decodeDevelopmentVerificationProduct(payload)` — must decode OK.
5. Cross-check lineage in task metadata:
   - `decoded.verificationItemKey === item.key`
   - `criterionIds.length === 1`
   - `decoded.acceptanceCriterionId === criterionIds[0]`
   - `decoded.acceptanceCriterionId === row.verification_target_artifact_id`
   - `decoded.acceptedCriterionHash === row.accepted_hash`
   - `decoded.candidateHash === frozenHash`
   - Any mismatch → `'failed'`.
6. **Returns `'unknown'` always** — this provider validates the LM assessment
   contract and lineage, NOT the criterion. An LM-authored `passed` cannot
   become Factory acceptance; until an independent candidate-check receipt
   is present, every well-formed assessment is indeterminate and the plan
   stops the line WITHOUT blaming the LM.

### 7.3 Source commit / branch validation (PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH)

Source: `src/infrastructure/workplace/sqlite-production-cell-integration.ts:133-321`.

This is the **integration adapter** that runs AFTER a git-changing Workplace
is accepted. `integrateAcceptedWorkplace(input)`:

1. Look up the integration task by joining
   `tasks → project_repositories → repository_checkouts →
   factory_candidate_sets → factory_candidate_set_members →
   factory_managed_node_submissions`.
   - Missing → `PRODUCTION_CELL_INTEGRATION_TASK_MISSING: <workplace>`.

2. Parse the submitted payload snapshot:
   ```ts
   {
     workItemKey, terminalStatus,
     source: { branch, commitSha, workItemKey },
     snapshot: { commitSha, treeSha },
     repository: { projectRepositoryId, integrationBranch },
   }
   ```
   Missing/invalid fields → `PRODUCTION_CELL_INTEGRATION_SOURCE_COMMIT_MISSING`.

3. **Exactly what is checked (PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH)**:
   Run `git rev-parse ${sourceCommit}^{commit}` → must equal `sourceCommit`.
   Run `git rev-parse refs/heads/${sourceBranch}` (or `refs/${sourceBranch}`
   if it already starts with `refs/`) → must equal `sourceCommit`
   (the branch HEAD MUST be exactly the source commit).
   Run `git rev-parse ${sourceCommit}^{tree}` → must equal
   `payload.snapshot.treeSha`.
   Any mismatch → throws:
   ```
   PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH: task ${id} submitted
   ${sourceCommit} but branch is ${branchHead ?? 'missing'}
   ```

4. Resolve integration branch HEAD
   (`git rev-parse refs/heads/${task.integration_branch}`).
   Missing → `PRODUCTION_CELL_INTEGRATION_TARGET_MISSING`.

5. If `integration_state === 'merged'` OR
   `isAncestor(sourceCommit, targetHead)` → mark merged, return succeeded
   (`alreadyApplied: true` if it was a no-op replay).

6. Otherwise merge; on conflict → `PRODUCTION_CELL_INTEGRATION_CONFLICT`.

Also note `observeAcceptedWorkplace` (lines 45-131): an observation-time
version that marks already-merged tasks without attempting integration,
returning one of `matched | absent-retry-safe | blocked`.

---

## 8. Storage — where gate results live

Three append-only tables in `src/schema.ts` (lines 1349-1455). The schema
enforces immutability via `BEFORE UPDATE`/`BEFORE DELETE` triggers.

### 8.1 `factory_gate_runs` (REG-15)

```sql
CREATE TABLE IF NOT EXISTS factory_gate_runs (
  gate_run_ref            TEXT PRIMARY KEY,
  workplace_ref           TEXT NOT NULL,
  gate_phase              TEXT NOT NULL CHECK (gate_phase IN ('author','final')),
  subject_candidate_set_ref TEXT NOT NULL,
  assessment_candidate_set_refs TEXT NOT NULL DEFAULT '[]',
  check_plan_ref          TEXT NOT NULL,
  check_plan_digest       TEXT NOT NULL,
  expected_workplace_revision INTEGER NOT NULL,
  gate_lease_ref          TEXT NOT NULL,
  state                   TEXT NOT NULL DEFAULT 'claimed'
                            CHECK (state IN ('claimed','checking','decided','terminal')),
  ...
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref)
);
```

State transitions: `claimed → checking → decided → terminal`. NOT append-only
(the run row is the inspection lifecycle audit).

### 8.2 `factory_check_receipts` (REG-17) — IMMUTABLE

```sql
CREATE TABLE IF NOT EXISTS factory_check_receipts (
  check_receipt_ref       TEXT PRIMARY KEY,
  check_run_ref           TEXT NOT NULL,
  subject_candidate_set_ref TEXT NOT NULL,
  assessment_candidate_set_refs TEXT NOT NULL DEFAULT '[]',
  provider_id             TEXT NOT NULL,
  provider_version        TEXT NOT NULL,
  provider_digest         TEXT NOT NULL,
  environment_ref         TEXT,
  outcome                 TEXT NOT NULL
                            CHECK (outcome IN ('passed','failed','unknown','error')),
  evidence_refs           TEXT NOT NULL DEFAULT '[]',
  receipt_digest          TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER trg_factory_check_receipts_no_update BEFORE UPDATE ...
  RAISE(ABORT, 'v4 check receipts are immutable (REG-17)');
CREATE TRIGGER trg_factory_check_receipts_no_delete BEFORE DELETE ...
  RAISE(ABORT, 'v4 check receipts are immutable (REG-17)');
```

### 8.3 `factory_gate_decisions` (REG-18) — IMMUTABLE

```sql
CREATE TABLE IF NOT EXISTS factory_gate_decisions (
  decision_key            TEXT PRIMARY KEY,
  workplace_ref           TEXT NOT NULL,
  gate_ref                TEXT NOT NULL,
  gate_run_ref            TEXT NOT NULL,
  gate_phase              TEXT NOT NULL CHECK (gate_phase IN ('author','final')),
  transition_ref          TEXT NOT NULL,
  subject_candidate_set_ref TEXT NOT NULL,
  assessment_candidate_set_refs TEXT NOT NULL DEFAULT '[]',
  verdict                 TEXT NOT NULL
                            CHECK (verdict IN ('accepted','repair_required',
                                               'human_required','failed')),
  repair_target_role      TEXT CHECK (repair_target_role IN ('author','reviewer')
                                       OR repair_target_role IS NULL),
  check_plan_ref          TEXT NOT NULL,
  check_plan_digest       TEXT NOT NULL,
  decision_policy_ref     TEXT NOT NULL,
  decision_policy_digest  TEXT NOT NULL,
  check_receipt_refs      TEXT NOT NULL DEFAULT '[]',    -- JSON array
  installation_digest     TEXT NOT NULL,
  accepted_output_bindings TEXT NOT NULL DEFAULT '[]',   -- JSON array
  recovery_issue_ref      TEXT,
  decision_digest         TEXT NOT NULL,
  decided_at              TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workplace_ref) REFERENCES factory_workplaces(workplace_ref)
);

CREATE UNIQUE INDEX idx_factory_gate_decisions_digest ON ... (decision_digest);
CREATE TRIGGER trg_factory_gate_decisions_no_update BEFORE UPDATE ...
  RAISE(ABORT, 'v4 gate decisions are immutable (REG-18)');
CREATE TRIGGER trg_factory_gate_decisions_no_delete BEFORE DELETE ...
  RAISE(ABORT, 'v4 gate decisions are immutable (REG-18)');
```

Idempotency: PK is `decision_key` (deterministic over
workplace+phase+sets+plan+policy). A replay returns the stored row; a
different `decision_digest` under the same key throws
`GATE_DECISION_REPLAY_MISMATCH`.

Repository class: `SqliteGateRepository`
(`src/infrastructure/workplace/sqlite-gate-repository.ts`).

---

## 9. How gate results are consumed

### 9.1 In the formalization kernel

The architecture handler (`formalization-installation.ts:909-1000`) branches
on the returned `gateDecision`:

- `verdict === 'accepted'` → call `withExactCandidateAcceptance(...)` to
  perform the artifact CAS. The GateDecision is authoritative in bridge
  mode; both run in parallel until Stage 5 removes ExactCandidateAcceptance.
- Otherwise → return `manifestResult(..., 'inconsistent', { gateVerdict,
  gateDecisionKey, gateReceipts, gap: 'Gate verdict: ${verdict}' })`. This
  surfaces the gate failure to the recovery policy.

### 9.2 In the dispatcher (requireProductionCellSubmission)

`src/tools/dispatcher.ts:1914-1985`. Before allowing `worker_done` to
transition `running → verifying`:

1. Look up the Workplace's `production_cell_id` (NULL ⇒ not a production
   cell, return).
2. If task metadata has `product_source === 'managed-production'` ⇒ return
   (managed-production cells assemble the product from the desk at seal
   time; no typed submission required).
3. Otherwise look up the latest `factory_managed_node_submissions` row for
   (task_id, executionId).
4. If found AND `schema_version === output_schema` ⇒ return (OK).
5. If found but schema mismatches ⇒ throw
   `PRODUCTION_CELL_PRODUCT_SCHEMA_MISMATCH`.
6. If missing ⇒ throw `PRODUCTION_CELL_PRODUCT_REQUIRED`.

### 9.3 In factory-start.ts (recovery)

The recovery operator (`src/app/factory-start.ts:560-689`) records a
synthetic rejection with `rejectionCode: 'PRODUCTION_CELL_PRODUCT_REQUIRED'`
and a structured `SubmissionGap`, then requeues the workplace for repair.

For failed-gate recovery (`factory-start.ts:770-849`), the operator:
1. Finds exactly one recoverable failed gate (`FACTORY_FAILED_GATE_NOT_UNIQUE`
   if zero or >1).
2. Parses the failure: a `CHECK_PROVIDER_VERSION_MISMATCH` regex extract.
3. Validates preconditions (one accepted worker_done, no live execution, no
   GateDecision yet for the run).
4. Accepts a replacement CheckPlan that is the canonical successor of the
   failed plan (digest must differ, must include a check with the new
   version).

---

## 10. Scripting strategy — how to make each gate PASS

### 10.1 Formalization Product gate (`define-product-contract`)

For `findContractGap(snapshot, {product:true})` to return null:

| Requirement | How to satisfy |
|---|---|
| Exactly 1 PRD, ≥1 FR (status `accepted`, not `superseded`) | Create exactly one PRD artifact and at least one FR via `artifact_create`. Use `artifact_update({status:'accepted'})`. |
| PRD `derived_from` → root ancestor | Create a `brief` (or any non-product-type accepted artifact) and `trace_add(source=PRD, target=brief, link_type='derived_from')`. The kernel will auto-provision a brief if missing (`ensureBriefRootTrace`), but scripts should create one explicitly. |
| All artifacts accepted+clean | `status='accepted'`, `accepted_hash === content_hash`, `drift_state='clean'`. Set `content_hash` to the sha256 of the artifact's doc content. |
| Artifact hash is sha256 | `content_hash` must be 64-char lowercase hex. |
| Managed production ledger | Each artifact/trace creation must go through the managed production ledger so `factory_managed_artifact_productions` rows exist for the process run. |

### 10.2 Formalization Use Case gate (`model-use-cases`)

In addition to product requirements:

| Requirement | How to satisfy |
|---|---|
| ≥1 UC artifact | Create UC via `artifact_create`. |
| Each UC → `derived_from` PRD | `trace_add(source=UC, target=PRD, link_type='derived_from')`. PRD must be in the snapshot. |
| Each UC → `covers` FR | `trace_add(source=UC, target=FR, link_type='covers')`. FR must be in the snapshot. |

### 10.3 Formalization Acceptance gate (`define-acceptance-contract`)

In addition to product + use cases:

| Requirement | How to satisfy |
|---|---|
| ≥1 AC artifact | Create AC via `artifact_create`. |
| Each AC → `derived_from` (FR OR NFR) | At least one `derived_from` trace to an FR or NFR. |
| FR-derived AC → also `derived_from` UC | If the AC derives from an FR, add a second `derived_from` trace to a UC. (NFR-only ACs do not need a UC trace.) |

### 10.4 Formalization Architecture / SRS gate

The hardest. The shift-left validator and the gate-run provider share rules.

**In addition to all upstream requirements:**

| Requirement | How to satisfy |
|---|---|
| Exactly 1 SRS artifact | Create exactly one SRS via `artifact_create`. |
| SRS → `derived_from` PRD | `trace_add(source=SRS, target=PRD, link_type='derived_from')`. |
| Repository binding with `local_path` | `project_repositories.local_path` must be non-null and point at a real directory. |
| SRS file exists on disk at `path.join(repo.local_path, srs.path.split('#')[0])` | Write the SRS markdown to that path before completing. |
| `sha256(fileContent) === artifact.content_hash` | Compute the sha256 of the UTF-8 file bytes and store it as the artifact's `content_hash`. |
| §12 Decision Log section present | Include a heading `## §12 Decision Log` (or similar matching the regex). |
| §12 table ≥ 6 columns OR ≥1 `### Decision N` subsection | Use the table form with the 6 canonical columns: `#, Decision, Source/profile, Alternatives considered, Rationale, Date`. |
| §D2 AC Map/Decomposition heading exactly once | `## §D2 AC Map`. |
| §D2 contains exactly one fenced YAML block | One ` ```yaml ... ``` ` block. |
| Each frozen AC appears exactly once as a stanza | The set of `ac:` values must EXACTLY equal the frozen baseline's AC codes. |
| Each stanza has all 10 required fields non-empty | `ac, title, module, files, invariants, test_layers, pattern, depends_on, ac_kind, criticality`. |
| Enum fields valid | `ac_kind ∈ {implementation, verification}`, `pattern ∈ {A, B}`, `criticality ∈ {blocker, degradable, nice_to_have}`. |
| No duplicate `ac` values, no duplicate fields | Each `ac:` appears once; each field name appears once per stanza. |
| No mixing YAML with markdown tables in §D2 | Keep only the YAML block. |
| Frozen baseline exists and has not drifted | The `factory_formalization_acceptance_baselines` row for the process run must be readable, with all referenced AC artifacts still `accepted+clean` and at the recorded hashes. |
| Contract ref pinned in policy matches `SRS_CONTRACT_REF` (v2.2, current digest) | If you pin a contractRef, it MUST equal `{version:'2.2', digest:SRS_CONTRACT_DIGEST}`. |

### 10.5 Discovery Proposal gate

| Requirement | How to satisfy |
|---|---|
| Typed submission with `schema_version === 'factory.discovery-proposal.v1'` | Submit via `product_submit` with `schema` set to the proposal schema. |
| Required non-empty strings | `problem_statement`, `observed_context`, `candidate_scope`, `rationale`. |
| Required string arrays (may be empty) | `stakeholders_or_actors`, `assumptions`, `unknowns`, `risks`, `evidence_refs`. |
| `recommended_outcome` enum | One of `go, clarify, reject, defer, inconclusive, failed`. |

### 10.6 Discovery Readiness gate

| Requirement | How to satisfy |
|---|---|
| Typed submission with `schema_version === 'factory.discovery-readiness-assessment.v2'` | Submit via `product_submit`. |
| `proposal_id` and `proposal_content_hash` bind to the EXACT accepted proposal | Use the row ID and content_hash of the accepted `factory_managed_node_submissions` row for `produce-proposal`. |
| `overall_readiness` enum | One of `ready, conditionally_ready, not_ready, inconclusive`. |
| `recommended_next_action` enum | One of `proceed_to_settlement, request_clarification, repeat_discovery, defer, reject, manual_review`. |
| `confidence` ∈ [0, 1] | Finite number. |
| All 7 dimensions present, no extras | `problem_clarity, scope_boundedness, stakeholder_coverage, assumption_visibility, unknowns_manageability, risk_visibility, evidence_grounding`. Each has `status` enum, non-empty `rationale`, ≥1 `source_refs`. |
| Gap lists well-formed, codes unique within and across | `blocking_gaps`, `non_blocking_gaps`; each gap has non-empty `code`, non-empty `description`, ≥1 `source_refs`. |
| Every `source_ref` resolves to an allowed identifier | Allowed set = proposal's top-level keys as `$.<key>` PLUS each entry in `proposal.evidence_refs`. Anything else is rejected as invented evidence. |

### 10.7 Development Task Graph gate

| Requirement | How to satisfy |
|---|---|
| Typed submission with `schema_version === DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA` | Submit via `product_submit`. |
| Payload decodes via `decodeDevelopmentTaskGraphProposal` | Follow the proposal schema exactly. |
| Process run input schema is `DEVELOPMENT_CASE_SCHEMA` | The ProcessRun was started with a Development case. |
| `policy.validate(developmentCase, graph).valid === true` | The canonicalized task graph satisfies the reference policy (every AC has an implementation task unless `ac_kind:verification`, every task is reachable, etc.). |

### 10.8 Development Verification gate

Note: this provider ALWAYS returns `'unknown'` after structural validation.
Under a fail-closed plan, this contributes to `repair_required` — but the
plan is designed so that the indeterminate result stops the line WITHOUT
blaming the LM. In scripts:

| Requirement | How to satisfy |
|---|---|
| Single-member CandidateSet | CandidateSet has exactly 1 member. |
| Member schema = `DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA` | Set the schemaId on the product ref. |
| Member ref starts with `managed-node-submission:` | The product came from `product_submit`. |
| `content_hash === member.productRef.digest` | The stored content hash matches the digest in the CandidateSet member. |
| Payload decodes via `decodeDevelopmentVerificationProduct` | All required fields present, correct types, `evidence.{summary,observations,limitations}` well-formed. |
| Lineage matches task metadata | `verificationItemKey`, `acceptanceCriterionId`, `acceptedCriterionHash`, `candidateHash` all match the task's `cell_input_item` and `process_node_input.upstream.bindings.candidate.candidateHash`. |

Because the provider returns `'unknown'`, scripted tests that need a clean
PASS must either (a) accept the `repair_required`/`human_required` verdict
as the expected outcome, or (b) build a CheckPlan with
`indeterminateDisposition: 'human-required'` for this entry and expect
`human_required`, or (c) wire a separate independent candidate-check receipt
(the provider comment notes "Until an independent candidate-check receipt is
present, every well-formed assessment is indeterminate").

### 10.9 Development source commit (integration adapter)

To avoid `PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH`:

| Requirement | How to satisfy |
|---|---|
| Submitted `source.commitSha` resolves as a commit | `git rev-parse ${commitSha}^{commit}` === `commitSha`. |
| Branch HEAD === `source.commitSha` | `git rev-parse refs/heads/${source.branch}` === `source.commitSha`. Commit AND push to the branch BEFORE submitting. |
| Tree SHA matches | `git rev-parse ${commitSha}^{tree}` === `payload.snapshot.treeSha`. |
| `snapshot.commitSha === source.commitSha` | Self-consistency in the payload. |
| `repository.projectRepositoryId === task.project_repository_id` | Match the task's binding. |
| `repository.integrationBranch === task.integration_branch` | Match the project's configured integration branch (default `dev`). |
| `terminalStatus === 'complete'` | Set explicitly. |
| `workItemKey` is a string (and `source.workItemKey` matches if present) | Set both consistently. |
| Integration branch exists | `git rev-parse refs/heads/${integration_branch}` returns a SHA. |

---

## 11. Known failure modes — every error code

### 11.1 Driver-level errors (gate-run-driver.ts)

| Code | Trigger | Avoidance |
|---|---|---|
| `CHECK_PROVIDER_MISSING` | `providers.resolve(entry.check.providerId)` returned null | Register the provider via `registerFactoryCheckProvider` before running the gate. |
| `CHECK_PROVIDER_VERSION_MISMATCH` | Registered provider's version ≠ entry.check.version | Use the exact version the plan declares. Recovery operator (factory-start.ts:781) parses `expected ([^,]+), got (.+)` from this message. |
| `ASYNC_CHECK_PROVIDER_UNSUPPORTED` | Provider returned a Promise | Keep providers synchronous. Split long work into multiple calls. |
| `CHECK_PLAN_RECEIPT_MISMATCH` | A receipt's index has no plan entry | Plan/receipt alignment bug in the driver; should never happen in normal operation. |

### 11.2 Repository errors (sqlite-gate-repository.ts)

| Code | Trigger | Avoidance |
|---|---|---|
| `GATE_DECISION_REPLAY_MISMATCH` | Same `decision_key` submitted with a different `decision_digest` | Deterministic replay: feed the same inputs to get the same digest. |
| `CHECK_RECEIPT_REPLAY_MISMATCH` | Same `check_receipt_ref` with a different `receipt_digest` | Same as above. |
| `GATE_REPOSITORY_CORRUPT` | `workplace_ref` column doesn't parse as `workplace/<runId>/<module>/<cell>/<workKey>` | Don't manually edit workplace_ref strings. |
| `CHECK_PROVIDER_IDENTITY_REQUIRED` | Provider has empty `providerId` or `version` | Set both non-empty. |
| `CHECK_PROVIDER_DUPLICATE` | Registering a different provider under an existing providerId with a different version | Unregister first, or use a new id. |

### 11.3 Submission validation rejection codes

| Code | Validator | Trigger |
|---|---|---|
| `SRS_CONTRACT_VERSION_MISMATCH` | srs-contract-validator | Pinned `contractRef` version or digest ≠ canonical `SRS_CONTRACT_REF`. Treated as configuration error, not `changes_requested`. |
| `FORMALIZATION_SRS_MISSING` | srs-contract-validator | No SRS artifact in `factory_managed_artifact_productions` for the process run. |
| `FORMALIZATION_SRS_INCOMPLETE` | srs-contract-validator | Any of: missing PRD trace, missing repo binding, missing file, hash mismatch, §12 missing, §D2 structural gaps, frozen-baseline AC mismatch. |
| `FORMALIZATION_ACCEPTANCE_INCOMPLETE` | acceptance-contract-validator | Some AC lacks `derived_from → FR/NFR`, or an FR-derived AC lacks `derived_from → UC`. |
| `FORMALIZATION_CONTRACT_INCOMPLETE` | formalization-contract-validator (product/UC/recon) | Cardinality failure (e.g. "exactly one PRD") or a traceability gap in the requested dimensions. |

### 11.4 Production cell completion errors (dispatcher.ts)

| Code | Trigger | Avoidance |
|---|---|---|
| `PRODUCTION_CELL_PRODUCT_REQUIRED` | Typed-submission cell, no `factory_managed_node_submissions` row for the execution before `worker_done`. | Call `product_submit({schema, content})` for the declared `output_schema` BEFORE `worker_done`. |
| `PRODUCTION_CELL_PRODUCT_SCHEMA_MISMATCH` | Submission exists but `schema_version !== output_schema`. | Submit with the exact declared schema. |

Note: managed-production cells (metadata `product_source === 'managed-production'`)
do NOT require typed submission — the factory assembles the product from the
Workplace desk at seal time.

### 11.5 Integration adapter errors (sqlite-production-cell-integration.ts)

| Code | Trigger |
|---|---|
| `PRODUCTION_CELL_INTEGRATION_TASK_MISSING` | No task matches the workplace + candidate set + expected schema. |
| `PRODUCTION_CELL_INTEGRATION_SOURCE_COMMIT_MISSING` | Payload missing `terminalStatus:'complete'`, `workItemKey`, valid `source.commitSha`, `source.branch`, `snapshot.treeSha`, or repository fields don't match the task binding. |
| `PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH` | The reviewed `source.commitSha` does not equal the branch HEAD, OR the tree SHA doesn't match. **The most common scripted-test failure** — commit AND push to the branch before submitting. |
| `PRODUCTION_CELL_INTEGRATION_TARGET_MISSING` | The integration branch doesn't exist (`refs/heads/${integration_branch}` doesn't resolve). |
| `PRODUCTION_CELL_INTEGRATION_CONFLICT` | Merge produced a conflict (or task was already in `conflict` state). |
| `PRODUCTION_CELL_REVIEW_BINDING_INVALID` | The reviewer verdict cell's binding to the author cell is invalid. |
| `PRODUCTION_CELL_INTEGRATION_CHECKOUT_FAILED` | `git checkout` of the integration branch failed. |
| `PRODUCTION_CELL_INTEGRATION_RESULT_INVALID` | Post-merge result validation failed. |

### 11.6 Production cell projection errors (sqlite-production-cell-projection-persistence.ts)

| Code | Trigger |
|---|---|
| `PRODUCTION_CELL_PLAN_INVALID` | Projected task has no `work_intent_id` in metadata. |
| `PRODUCTION_CELL_PLAN_BINDING_MISMATCH` | Generation key mismatch on replay. |
| `PRODUCTION_CELL_PLAN_TASK_MISMATCH` | Intent's projected task ID doesn't match. |
| `PRODUCTION_CELL_PLAN_REPLAY_MISMATCH` | Replay produced a different task ID. |
| `PRODUCTION_CELL_PROJECTED_TASK_NOT_FOUND` | Task ID not in projection. |
| `PRODUCTION_CELL_METADATA_REBIND_DENIED` | Attempt to rebind an immutable metadata key. |
| `PRODUCTION_CELL_GRAPH_DIGEST_INVALID` | Graph digest doesn't match content. |
| `PRODUCTION_CELL_GRAPH_REPLAY_MISMATCH` | Graph replay produced a different digest. |

### 11.7 Factory-start recovery errors (factory-start.ts)

| Code | Trigger |
|---|---|
| `FACTORY_MISSING_PRODUCT_UNSAFE` | Missing-product recovery could not satisfy the exact managed process binding preconditions. |
| `FACTORY_FAILED_GATE_NOT_UNIQUE` | Failed-gate recovery found 0 or >1 recoverable failed gates. |
| `FACTORY_FAILED_GATE_UNSAFE` | Failed-gate recovery preconditions not met (lease state, revision, etc.). |
| `FACTORY_FAILED_GATE_PLAN_INVALID` | Replacement CheckPlan is not the canonical successor (digest must differ, must include the new version). |

---

## 12. Key file reference

All paths absolute.

### 12.1 Domain contracts

- `D:/Development/saga-mcp/src/process-modules/domain/workplace/gate.ts` —
  universal gate types (CheckPlan, CheckProvider, CheckReceipt, GateRun,
  GateDecision, `assertValidGateDecision`).
- `D:/Development/saga-mcp/src/modules/formalization/domain/srs-contract.ts`
  — `SRS_CONTRACT` v2.2 (requiredSections, d2RequiredFields, d2EnumFields,
  decisionLogColumns) and `SRS_CONTRACT_DIGEST`.

### 12.2 Drivers and registries

- `D:/Development/saga-mcp/src/process-modules/application/gate-run-driver.ts`
  — `driveGateRun`, `reduceReceipts`, `hashReceipt`, `hashDecision`.
- `D:/Development/saga-mcp/src/process-modules/application/standard-check-providers.ts`
  — `FactoryCheckProviderRegistry`, the always-passing
  `factory.product-contract.v1` provider, `buildCheckPlan` helper.
- `D:/Development/saga-mcp/src/process-modules/application/submission-validator-check-provider.ts`
  — wraps a `NodeSubmissionValidator` as a CheckProvider.

### 12.3 Formalization gates

- `D:/Development/saga-mcp/src/modules/formalization/application/srs-d2-parser.ts`
  — `extractD2Stanzas`, `validateD2Structure`, `checkDecisionLogSection`,
  `parseD2CriticalityByAc`.
- `D:/Development/saga-mcp/src/modules/formalization/application/srs-contract-validator.ts`
  — `createSrsContractValidator`, the shift-left validator.
- `D:/Development/saga-mcp/src/modules/formalization/application/srs-structural-check-provider.ts`
  — `createSrsStructuralCheckProvider`, the gate-run provider.
- `D:/Development/saga-mcp/src/modules/formalization/application/architecture-check-plan.ts`
  — `buildArchitectureCheckPlan`.
- `D:/Development/saga-mcp/src/modules/formalization/application/acceptance-contract-validator.ts`
  — `createAcceptanceContractValidator`.
- `D:/Development/saga-mcp/src/modules/formalization/application/formalization-contract-validator.ts`
  — `createFormalizationContractValidator` (product/UC/reconciliation).
- `D:/Development/saga-mcp/src/modules/formalization/application/formalization-check-providers.ts`
  — `registerFormalizationCheckProviders`, `FORMALIZATION_CHECK_REFS`.
- `D:/Development/saga-mcp/src/modules/formalization/application/formalization-installation.ts`
  — `buildContractSnapshot`, `findContractGap`, `findBaselineDrift`,
  `categorize`, `isAcceptedClean`, `sealArchitectureCandidateSet`,
  `runArchitectureGate`, all kernel handlers.
- `D:/Development/saga-mcp/src/modules/formalization/application/gate-decision-adapter.ts`
  — `gateDecisionFromAcceptedCandidate`, `gateDecisionForRepair`,
  `gateDecisionForHuman`, `gateDecisionForFailure`.

### 12.4 Discovery gates

- `D:/Development/saga-mcp/src/modules/discovery/application/discovery-check-providers.ts`
  — `createDiscoveryProposalCheckProvider`,
  `createDiscoveryReadinessCheckProvider`, `allowedProposalSourceRefs`.
- `D:/Development/saga-mcp/src/modules/discovery/domain/discovery-proposal.ts`
  — `validateDiscoveryProposal`.
- `D:/Development/saga-mcp/src/modules/discovery/domain/discovery-readiness-assessment.ts`
  — `validateReadinessAssessment`.

### 12.5 Development gates

- `D:/Development/saga-mcp/src/modules/development/application/development-check-providers.ts`
  — `createDevelopmentTaskGraphCheckProvider`,
  `createDevelopmentVerificationCheckProvider`,
  `developmentVerificationPayloadContract`.
- `D:/Development/saga-mcp/src/modules/development/domain/development-verification-product.ts`
  — `decodeDevelopmentVerificationProduct`.
- `D:/Development/saga-mcp/src/modules/development/domain/development-schemas.ts`
  — `DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA`,
  `DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA`, product shapes.

### 12.6 Consumption & integration

- `D:/Development/saga-mcp/src/tools/dispatcher.ts` —
  `requireProductionCellSubmission` (line 1914),
  `validateSubmissionIfRequired` (called at line 580).
- `D:/Development/saga-mcp/src/infrastructure/workplace/sqlite-production-cell-integration.ts`
  — `SqliteProductionCellIntegration`,
  `PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH`.
- `D:/Development/saga-mcp/src/infrastructure/workplace/sqlite-gate-repository.ts`
  — `SqliteGateRepository` (createGateRun, recordCheckReceipt,
  recordDecision).
- `D:/Development/saga-mcp/src/process-modules/application/wire-submission-validation.ts`
  — wires all formalization submission policies.
- `D:/Development/saga-mcp/src/app/factory-start.ts` — recovery operator
  for missing-product and failed-gate.
- `D:/Development/saga-mcp/src/schema.ts` — DDL for `factory_gate_runs`,
  `factory_check_receipts`, `factory_gate_decisions` (lines 1349-1455).
