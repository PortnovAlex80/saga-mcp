# D4 — Authoritative Discovery Settlement — Implementation Contract & Checklist

**Branch:** `d4-discovery-settlement` (base: `saga3-discovery` @ `c312464`, post-D3 squash-merge)
**Status:** IN PROGRESS
**Last updated:** 2026-07-24

This file is the **single source of truth** for D4 progress. Each stage updates its
checkbox + a one-line result. Subagents write their stage result here.

---

## Core principle

```
LM proposes. Advisor assesses. Kernel settles. Certificate proves.
```

Neither the discovery worker, nor the normalizer, nor the readiness advisor can set
the final `go` / `clarify` / `reject`. Only a **versioned kernel policy** may. D4 is
the **authoritative** boundary (unlike D3 shadow).

**Outcome authority transition:**
- Before settlement: `outcomeAuthority = worker_proposal | normalized_worker_proposal`
- After successful settlement: `outcomeAuthority = discovery_settlement_policy`
- Provisional result is NEVER deleted or rewritten — preserved in `result.provisional`.

**D4 must NOT:** advance to formalization (finalStage stays `discovery`); add product
workers; add an LM advisor; auto-retry discovery; diagnose anomalies; repair the
Proposal; mutate the Proposal or readiness assessment; do D5 self-diagnosis; do F1.

---

## Verified integration anchors (from code reconnaissance)

These are NOT guesses — confirmed by reading current source on `c312464`.

### Engine (`src/engines/saga3-discovery-engine.ts`)
- `runResult()` at **:540-571** builds the returned literal.
- Provisional outcome built at **:433-462** (`DiscoveryRunOutcome` type at **:61-66**).
- `outcomeAuthority` values: `'worker_proposal' | 'normalized_worker_proposal' | 'none'` (type at **:63**).
- `finalStage = persistence.episodes.currentStage(epicId) ?? 'discovery'` (**:474**).
- `scopeCompleted = terminal === 'clean' && validProposal` (**:473**).
- Readiness block at **:495-536** (try/catch isolation).
- **D4 insertion point: between :536 (readiness end) and :537 (return runResult).**
- Deps interface `Saga3DiscoveryEngineDependencies` at **:68-89**; `readinessService?` optional at ~:82.

### Run result interface (`src/application/ports/orchestration-engine.ts`)
- `OrchestrationRunResult` at **:24-74**.
- `outcomeAuthority?: 'worker_proposal' | 'normalized_worker_proposal' | 'none'` (inline at **:53**) → widen to add `'discovery_settlement_policy'`.
- `readiness?` inline object at **:65-73** (mirror style for `settlement?`).
- **NO `normalization?` field exists** — normalization leaks only via `outcomeAuthority='normalized_worker_proposal'`.

### Readiness service (`src/saga3/application/discovery-readiness-service.ts`)
- `assess(request)` returns `{ success, cycles, error, shadow: ReadinessShadowResult }`.
- `ReadinessShadowResult`: `{ status, authority, assessmentId, assessmentHash, overallReadiness, recommendedNextAction, error }`.

### Hashing (MUST reuse — byte-compatibility with D2/D3 lineage)
- `canonicalJson` in **`src/saga3/persistence/saga3-normalization-repository.ts:209-216`**.
- `createHash('sha256').update(canonicalJson(payload)).digest('hex')` → lowercase hex (64 chars).
- **DO NOT** use any of the other 3 `canonicalJson`/`hashPayload` implementations.

### Proposal domain (`src/saga3/domain/discovery-proposal.ts`)
- `DISCOVERY_PROPOSAL_SCHEMA = 'saga3.discovery-proposal.v1'` (**:37**).
- `DiscoveryProposalPayload`: problem_statement, observed_context, stakeholders_or_actors[], assumptions[], unknowns[], risks[], candidate_scope, evidence_refs[], **recommended_outcome**, rationale (the field is `recommended_outcome`, NOT `outcome`).
- `validateDiscoveryProposal(payload) → { valid, errors }` (**:67-103**) — structural, does NOT check schema_version (check that separately).
- `provisionalOutcomeFromProposal` (**:111-115**).

### Proposal persistence
- `readLatestProposal(intentId)` on the port — `SELECT * FROM saga3_proposals WHERE intent_id=? AND status='submitted' ORDER BY id DESC LIMIT 1`.
- **NO `readProposalById` on port** — readiness tool does inline SELECT (`src/tools/saga3-readiness.ts:166-170`).
- `saga3_proposals` columns: id, intent_id, task_id, execution_id, kind, schema_version, payload, content_hash, status, provenance, source_submission_id, normalization_proposal_id, created_at.
- `epic_id` is NOT on saga3_proposals — on saga3_work_intents (join via intent_id).
- `provenance.normalization_mode` ('lm_transformation' | 'deterministic') determines provisional authority.

### Readiness domain/records
- `ReadinessAssessmentRecord`: id, control_intent_id, proposal_id, proposal_content_hash, task_id, execution_id, payload, content_hash, status ('submitted'|'accepted_by_kernel'|'rejected_by_kernel'), overall_readiness, recommended_next_action, validation_errors, provenance, created_at.
- `ReadinessAssessmentPayload`: proposal_id, proposal_content_hash, overall_readiness, dimension_assessments (7 dims), blocking_gaps[], non_blocking_gaps[], recommended_next_action, confidence, rationale.
- Repository: `readLatestAcceptedReadinessAssessmentForControl(db, controlIntentId)` exists; need read-by-proposal for D4.

### Schema patterns (`src/schema.ts` + repository ensure)
- DDL for readiness tables at **:755-799**.
- `ensureSaga3ReadinessSchema(db)` uses **`db.exec()`** (multi-statement template) — NOT `prepare().run()`.
- Called in `SqliteSaga3DiscoveryRuntime` constructor (**sqlite-saga3-discovery-runtime.ts:41**) + MCP handlers.
- UNIQUE indexes as separate `CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_<table>_<meaning>`.
- JSON arrays: `TEXT NOT NULL DEFAULT '[]'`; write `JSON.stringify(...)`, read `JSON.parse(row ?? '[]')`.

### Tests
- `node --test` runner; `npm test` = `tsc && node --test` (auto-discovers `tests/saga3/d4-*.test.mjs`).
- Tests import from `../../dist/...` (compiled JS).
- Temp-file DB via `mkdtempSync(os.tmpdir(), 'saga3-d4-<tag>-')` + `process.env.DB_PATH`.
- Architecture boundary test (`d3-architecture-boundary.test.mjs`): regex/string search over `readFileSync` — forbids `getDb`, inline SQL, upward imports.

---

## Stage checklist

### Stage 0 — Prep ✅
- [x] D3 docs commit `cf4ddab` done
- [x] D3 squash-merge → `saga3-discovery` (`c312464`, pushed)
- [x] Build green, 506/505/0/1
- [x] Branch `d4-discovery-settlement` created from `c312464`
- [x] Code reconnaissance complete (4 parallel Explore agents)

### Stage 1 — Domain: settlement policy + input snapshot + certificate
**Files:** `src/saga3/domain/discovery-settlement-policy.ts`, `src/saga3/domain/discovery-settlement-input.ts`, `src/saga3/domain/discovery-outcome-certificate.ts`

- [ ] 1.1 `discovery-settlement-policy.ts`:
  - `DISCOVERY_SETTLEMENT_POLICY_VERSION = 'saga3.discovery-settlement-policy.v1'`
  - `DiscoverySettlementReasonCode` union (14 codes: GO_READY_AND_GROUNDED, CLARIFY_* ×11, REJECT_WORKER_AND_ADVISOR_AGREE)
  - `DiscoverySettlementDecision { decision: 'go'|'clarify'|'reject'; reason_codes: ReasonCode[]; rationale: string; policy_version: string; policy_hash: string }`
  - `DiscoverySettlementPolicy` interface `{ version, contentHash, settle(input) }`
  - `DiscoverySettlementPolicyV1` class — pure, no DB/LM imports. Constants `GO_MIN_CONFIDENCE=0.70`, `REJECT_MIN_CONFIDENCE=0.70`.
  - `POLICY_V1_CONTENT_HASH` = `sha256(canonicalJson({version, go_min_confidence, reject_min_confidence}))` — computed once, stable.
  - GO rule (§6.1): proposal go AND valid AND ≥1 evidence_ref AND readiness accepted AND overall=ready AND blocking_gaps empty AND evidence_grounding=sufficient AND recommended_next_action=proceed_to_settlement AND confidence≥0.70.
  - REJECT rule (§6.2): proposal reject AND readiness accepted AND overall=not_ready AND recommended=reject AND blocking_gaps non-empty AND each blocking gap has source_refs AND confidence≥0.70.
  - CLARIFY (§6.3): everything else. Fail-closed. Includes readiness missing/failed/inconclusive/conditionally_ready, low confidence, conflict, manual_review/repeat_discovery/defer, policy fallback.
  - rationale built from reason_codes by kernel (no LM text).
- [ ] 1.2 `discovery-settlement-input.ts`:
  - `DISCOVERY_SETTLEMENT_INPUT_SCHEMA = 'saga3.discovery-settlement-input.v1'`
  - `DiscoverySettlementInputSnapshot` per §5 (schema_version, epic_id, proposal{id,content_hash,payload,source_intent_id,source_submission_id,normalization_proposal_id}, readiness{status:'accepted_by_kernel'|'missing'|'failed', assessment_id, content_hash, payload}, policy{version, content_hash}, captured_at).
  - `buildSettlementInputHash(snapshot) = sha256(canonicalJson(snapshot))`.
- [ ] 1.3 `discovery-outcome-certificate.ts`:
  - `DISCOVERY_OUTCOME_CERTIFICATE_SCHEMA = 'saga3.discovery-outcome-certificate.v1'`
  - `DiscoveryOutcomeCertificatePayload` per §10.
  - `buildOutcomeCertificatePayload(...)` + `hashOutcomeCertificate(payload)`.
  - Authority = `'kernel_policy'` (NOT LM provenance).
- [ ] 1.4 Domain stays pure: no `getDb`, no `node:sqlite`, no import from persistence/engine/application. Only `node:crypto` + `canonicalJson` import from normalization-repository (the shared helper).

**Result Stage 1:** ✅ DONE (2026-07-24). 3 files: `discovery-settlement-policy.ts` (policy v1, 14 reason codes, GO/REJECT/CLARIFY rules, `POLICY_V1_CONTENT_HASH`), `discovery-settlement-input.ts` (snapshot + `buildSettlementInputHash` + `NO_READINESS_HASH='none'`), `discovery-outcome-certificate.ts` (payload + `buildOutcomeCertificatePayload` + `hashOutcomeCertificate`). All pure, only `node:crypto` + shared `canonicalJson`. Compiles clean.

### Stage 2 — Persistence: schema + repository + port methods
**Files:** `src/schema.ts`, `src/saga3/persistence/saga3-settlement-repository.ts`, `src/saga3/persistence/saga3-discovery-runtime-port.ts`, `src/saga3/persistence/sqlite-saga3-discovery-runtime.ts`, `src/saga3/domain/discovery-settlement-records.ts`

- [ ] 2.1 `discovery-settlement-records.ts`: `SettlementStatus ('computed'|'certificate_issued'|'failed')`, `SettlementRecord`, `OutcomeCertificateRecord` types.
- [ ] 2.2 `saga3-settlement-repository.ts`:
  - `ensureSaga3SettlementSchema(db)` via `db.exec()` (multi-statement: 2 CREATE TABLEs + indexes).
  - `saga3_discovery_settlements` (§9.1): id, epic_id, proposal_id, proposal_content_hash, readiness_assessment_id (nullable), readiness_assessment_hash (sentinel 'none' for null), policy_version, policy_hash, input_snapshot (TEXT), input_hash, decision, reason_codes (TEXT DEFAULT '[]'), rationale, status ('computed'|'certificate_issued'|'failed'), created_at.
    - Idempotency UNIQUE(proposal_id, proposal_content_hash, readiness_assessment_hash, policy_version, policy_hash).
  - `saga3_discovery_outcome_certificates` (§9.2): id, settlement_id (UNIQUE), epic_id, proposal_id, proposal_content_hash, readiness_assessment_id (nullable), readiness_assessment_hash, policy_version, policy_hash, decision, reason_codes, input_hash, certificate_payload (TEXT), certificate_hash (UNIQUE), issued_at.
  - `findSettlementByInputKey(db, {proposal_id, proposal_content_hash, readiness_assessment_hash, policy_version, policy_hash})`.
  - `insertSettlement(db, input)` with `ON CONFLICT(...) DO NOTHING` → `{ record, replayed }`.
  - `markSettlementCertificateIssued(db, settlementId)` (CAS computed→certificate_issued).
  - `insertCertificate(db, input)` immutable (no update path).
  - `readCertificateForSettlement(db, settlementId)`.
  - Read proposal + accepted readiness assessment helpers (db-first) OR add to port (see 2.4).
- [ ] 2.3 Add DDL also to `src/schema.ts` (so fresh DBs via `getDb()` get the tables) — mirror readiness DDL style at :755-799.
- [ ] 2.4 Port additions on `Saga3DiscoveryRuntimePersistence`:
  - `readProposalForSettlement(proposalId): SettlementProposalInput | null` (full row incl source_submission_id, normalization_proposal_id, epic_id via join).
  - `readAcceptedReadinessAssessmentForProposal(proposalId): ReadinessAssessmentRecord | null`.
  - `findSettlementByInputKey(key): SettlementRecord | null`.
  - `insertSettlement(input): { record, replayed }`.
  - `markSettlementCertificateIssued(settlementId): boolean`.
  - `insertCertificate(input): OutcomeCertificateRecord`.
  - `readCertificateForSettlement(settlementId): OutcomeCertificateRecord | null`.
  - Implemented in SQLite adapter, delegating to standalone repository functions (db-first). Service stays db-free.
- [ ] 2.5 Call `ensureSaga3SettlementSchema(getDb())` in `SqliteSaga3DiscoveryRuntime` constructor (mirror readiness at :41).

**Result Stage 5:** ✅ DONE (2026-07-24). 4 test files, 56 new tests:
- `d4-settlement-policy.test.mjs` (22): full §15 decision matrix (GO/REJECT/CLARIFY rules), hash stability, determinism, fail-closed.
- `d4-settlement-persistence.test.mjs` (11): input hash stable, policy hash stable, certificate hash stable, idempotent replay, certificate immutability, new-readiness-hash→new settlement, missing-readiness clarify, mutated-payload rejection, provenance unchanged, certificate lineage (proposal+readiness). Fixed a placeholder-count bug in the proposal fixture INSERT.
- `d4-settlement-engine.test.mjs` (10): authoritative go/clarify/reject, settlement exception→failed+no cert+provisional preserved, outcomeAuthority=discovery_settlement_policy only after cert, provisional preserved separately, finalStage stays discovery, settlement runs when readiness failed, not_run when missing/no-service.
- `d4-architecture-boundary.test.mjs` (13): no getDb/SQL in engine/service/policy/input/certificate, no WorkerExecutorFactory/LM-client/SQLite-import in policy, no upward import from repo, no settlement_submit/certificate_submit MCP handler, no UPDATE on certificates table, no stage transition.
Full suite green: **562 tests, 561 pass, 0 fail, 1 todo** (was 506/505/0/1 → +56 D4 tests, no regressions).
**File:** `src/saga3/application/discovery-settlement-service.ts`

- [ ] 3.1 `DiscoverySettlementService` interface: `settle(request): Promise<DiscoverySettlementResult>`.
  - `SettleRequest`: projectId, epicId, proposalId, proposalHash, readiness: ReadinessShadowResult (from engine).
  - `DiscoverySettlementResult`: `{ status: 'issued'|'failed'|'not_run'; settlementId, certificateId, certificateHash, policyVersion, decision, reasonCodes, error, provisional }`.
- [ ] 3.2 `Saga3DiscoverySettlementService` class — constructor takes `{ runtimePersistence }` (NO workerExecutorFactory, NO host, NO LM). Mirrors readiness service shape but NO worker spawn.
- [ ] 3.3 `settle()` flow (§11):
  1. load canonical Proposal by id via port (`readProposalForSettlement`).
  2. strict re-validation: `validateDiscoveryProposal(payload)`, assert schema_version, recompute hash via `canonicalJson`+sha256, compare to stored `content_hash` AND to engine-supplied `proposalHash`. Mismatch → throw (settlement.failed).
  3. load accepted readiness assessment if `readiness.status === 'completed' && readiness.assessmentId != null` via port (`readAcceptedReadinessAssessmentForProposal`). Else readiness section = missing/failed per shadow.status.
  4. if assessment present: re-validate payload, recompute hash, compare to stored content_hash AND engine-supplied assessmentHash.
  5. build immutable `DiscoverySettlementInputSnapshot`, compute input hash.
  6. find existing settlement by idempotency key; if exists + has certificate → return SAME certificate (no recompute). If exists + no certificate → deterministically rebuild certificate.
  7. run `DiscoverySettlementPolicyV1.settle(snapshot)`.
  8. persist settlement (status='computed').
  9. build `DiscoveryOutcomeCertificatePayload`, hash it.
  10. persist immutable certificate.
  11. mark settlement 'certificate_issued'.
  12. return authoritative result.
- [ ] 3.4 NO LM calls, NO WorkerExecutorFactory, NO getDb, NO MCP tool. Architecture-test-clean.
- [ ] 3.5 Exception path: any failure → catch, persist settlement row status='failed' if input snapshot was built, return `{ status:'failed', error }`. Engine maps to reason=failed.

**Result:** _(filled when done)_

### Stage 4 — Engine integration
**Files:** `src/engines/saga3-discovery-engine.ts`, `src/application/ports/orchestration-engine.ts`, `src/app/composition-root.ts`

- [ ] 4.1 Add `settlementService?: DiscoverySettlementService` to deps (optional, like readiness — D1/D2 tests stay green).
- [ ] 4.2 Widen `outcomeAuthority` union in BOTH `DiscoveryRunOutcome` (:63) and `OrchestrationRunResult` (:53) to include `'discovery_settlement_policy'`.
- [ ] 4.3 Add `settlement?` + `provisional?` sections to `OrchestrationRunResult` (mirror readiness inline type or named `SettlementResult`/`ProvisionalResult`).
- [ ] 4.4 Insert settlement hook after readiness block (between :536 and :537):
  - Guard: `validProposal && proposal && this.deps.settlementService`.
  - try/catch isolation: settlement exception → `settlement.status='failed'`, NEVER rewrites provisional outcome/reason/scopeCompleted destructively — but per §12, settlement failure makes the run `failed` (authoritative boundary, unlike D3 shadow).
  - Call `settlementService.settle({ projectId, epicId, proposalId, proposalHash, readiness })`.
  - On issued certificate: top-level `outcome = settlement.decision`, `outcomeAuthority = 'discovery_settlement_policy'`, `reason='completed'`, `scopeCompleted=true`.
  - On settlement failed: `reason='failed'`, `scopeCompleted=false`, `outcomeAuthority='none'`, provisional preserved.
  - Settlement runs EVEN when readiness failed/paused/not_run (policy returns clarify).
- [ ] 4.5 Restructure `runResult()` to emit `provisional` section (from the pre-settlement outcome) + `settlement` section. Top-level `outcome`/`outcomeAuthority` become authoritative post-settlement, else provisional.
- [ ] 4.6 `composition-root.ts`: construct `Saga3DiscoverySettlementService({ runtimePersistence })`, pass `settlementService` to engine (mirror readiness wiring at :107-121).
- [ ] 4.7 When `settlementService` absent (legacy/test): `settlement.status='not_run'`, provisional outcome stays as top-level (backward compat).

**Result:** _(filled when done)_

### Stage 5 — Tests
**Files:** `tests/saga3/d4-*.test.mjs`

- [ ] 5.1 `d4-settlement-policy.test.mjs` — decision matrix (§15), 11+ cases. Pure, no DB. Verify policy hash stable, rationale from reason codes.
- [ ] 5.2 `d4-settlement-persistence.test.mjs` — input hash stable, policy hash stable, certificate hash stable, idempotent replay returns same settlement+certificate, new readiness hash → new settlement, new policy version → new settlement, mutated proposal payload at old hash rejected, mutated readiness payload at old hash rejected, certificate has no update path, settlement lineage contains proposal+readiness, provisional provenance unchanged (§16).
- [ ] 5.3 `d4-settlement-engine.test.mjs` — D3 success + policy go → authoritative go; conditionally_ready → clarify; readiness failed → clarify + pipeline completed; worker reject + advisor reject → reject; settlement exception → failed + no certificate; existing certificate → no second compute; outcomeAuthority changes only after certificate; provisional preserved separately; finalStage stays discovery; no formalization transition (§17).
- [ ] 5.4 `d4-architecture-boundary.test.mjs` — forbid getDb in engine/service/policy; forbid inline SQL in engine/service/policy; forbid LM client in settlement policy; forbid WorkerExecutorFactory in settlement service; forbid MCP handler for certificate creation; forbid SQLite import from domain/application policy; forbid stage transition in D4; forbid OutcomeCertificate mutation (§18). Mirror `d3-architecture-boundary.test.mjs` regex approach.

**Result:** _(filled when done)_

### Stage 6 — Smoke (real LM) + evidence
**File:** `docs/saga3/D4-SMOKE-EVIDENCE.md`

- [ ] 6.1 Smoke A — authoritative GO (proposal go + readiness ready + no gaps + grounded + confidence≥0.70). Expect outcome=go, outcomeAuthority=discovery_settlement_policy, reason=GO_READY_AND_GROUNDED, finalStage=discovery.
- [ ] 6.2 Smoke B — authoritative CLARIFY (proposal go + conditionally_ready OR blocking gaps). Expect outcome=clarify, certificate exists, provisional outcome stays go.
- [ ] 6.3 Smoke C — authoritative REJECT (proposal reject + not_ready + recommended=reject + blocking gaps + confidence≥0.70). Expect outcome=reject, reason=REJECT_WORKER_AND_ADVISOR_AGREE.
- [ ] 6.4 Smoke D — advisor unavailable (readiness failed). Expect outcome=clarify, reason=CLARIFY_READINESS_FAILED, pipeline completed.
- [ ] 6.5 Smoke E — restart/replay: re-run same epic → same settlementId, same certificateId, same certificateHash, no second certificate, no new LM call.
- [ ] 6.6 Each smoke on a NEW epic. Record engine result JSON + DB state in D4-SMOKE-EVIDENCE.md.

**Result Stage 6:** ✅ DONE (2026-07-24). Live LM smokes (model `qwen3.6-35b-a3b@q4_k_xl`): Smoke A (GO, epic 9/prop 8, cert 2), Smoke D (readiness-failure→clarify, epic 8/prop 7, cert 1), Smoke E (replay on prop 8 → same ids+hash, no new rows). Bug found+fixed via smoke: settlement `collectAllowedSourceRefs` used a different source-ref format than D3 readiness handler; aligned to byte-identical D3 set; after fix Smoke A produced authoritative GO. Smoke B/C not reproducible live (LM consistently says ready) — covered deterministically by policy+engine suites. 4 settlements+4 certs persisted immutably. Evidence: `docs/saga3/D4-SMOKE-EVIDENCE.md`.

### Stage 7 — Commits + push
- [ ] 7.1 `feat(saga3-d4): add deterministic discovery settlement policy` (Stage 1 domain)
- [ ] 7.2 `feat(saga3-d4): persist settlement inputs and outcome certificates` (Stage 2 persistence)
- [ ] 7.3 `feat(saga3-d4): integrate authoritative settlement into discovery engine` (Stage 3+4)
- [ ] 7.4 `test(saga3-d4): cover policy matrix, certificate lineage, and recovery` (Stage 5)
- [ ] 7.5 `docs(saga3-d4): record authoritative settlement smoke evidence` (Stage 6)
- [ ] 7.6 Push branch. Full `npm test` green before each push.

**Result:** _(filled when done)_

---

## Exit gates D4 (§20) — all must be ✅ before squash-merge

1. [ ] Final outcome set ONLY by deterministic policy.
2. [ ] Worker and advisor cannot create a certificate.
3. [ ] Settlement input immutable + hashed.
4. [ ] Proposal and readiness re-validated before settlement.
5. [ ] GO impossible without accepted readiness + evidence grounding + sufficient confidence.
6. [ ] REJECT impossible without agreed worker/advisor negative result.
7. [ ] All indeterminate states fail-closed to CLARIFY.
8. [ ] Certificate durable, immutable, idempotent.
9. [ ] Restart returns the same certificate.
10. [ ] Policy version/hash recorded in certificate.
11. [ ] Provisional and authoritative lineage separated.
12. [ ] `outcomeAuthority = discovery_settlement_policy` only after certificate.
13. [ ] `finalStage` stays discovery.
14. [ ] D5 diagnosis and F1 formalization absent.
15. [ ] Full `npm test` green.
16. [ ] Smoke A–E passed.

---

## Constraints preserved (do NOT violate)

- `settings.cloud.json` — frozen, do not touch.
- `settings.lmstudio.json` — no defaults, front-fill only.
- `platform_policies` global seed — must NOT be deleted.
- Do NOT commit `nul` or `docs/research/CHAIN-WORKING-V2.md`.
- Do NOT stop engines/workers unless asked.
- D4 has NO LM WorkIntent / ControlIntent / MCP write-tool for settlement. Kernel-only.
- Reuse `canonicalJson` from `saga3-normalization-repository.ts` — do NOT reimplement.
