# D3 Smoke Evidence — Shadow Readiness Advisor

**Date:** 2026-07-24
**Branch:** `d3-discovery-readiness` (commits 530d984 → 6414018 → b4fda5a → 9895532 → correction acb9a80 → a12828a → 4bc6eea)
**Base:** `saga3-discovery` after D2 squash-merge (`6d5061b`)
**Model:** `qwen3.6-35b-a3b@q4_k_xl` (LM Studio, `http://localhost:1234`)
**Suite:** `npm test` green — 506 tests, 505 pass, 0 fail, 1 todo (+59 D3 tests: 44 original + 12 correction + 3 migration).

Three independent epics, one per scenario (fresh epic each, no shared
WorkIntent / generation_key / readiness ControlIntent):

| Smoke | Project/Epic | Discovery proposal | Forces |
|-------|--------------|--------------------|--------|
| A | 4 / 4 | id 3 | Clearly ready Proposal |
| B | 5 / 5 | id 4 | Proposal with visible gaps |
| C | D3-Smoke-Mig / 1 | id 1 | Advisor submits deliberately invalid source ref (run on a pre-correction DB migrated on open) |

Each smoke ran via `node dist/orchestrate-cli.js <proj> <epic> --concurrency=1`
with `SAGA_ORCHESTRATION_MODE=saga3-discovery`, `SAGA_CLAUDE_PATH=claude`,
`TRACKER_AUTOSTART=0`. The discovery worker used the existing
`skills/saga-discovery-worker/SKILL.md`; the readiness advisor used the new
`skills/saga-discovery-readiness-advisor/SKILL.md`. For Smoke C only, a
temporary `### D3 SMOKE C` override was injected into the advisor skill
(submit with an invented source_ref) and reverted immediately after.

---

## Smoke A — clearly ready Proposal

**Engine result:**
```json
{ "reason": "completed", "cycles": 127, "scopeCompleted": true,
  "outcome": "go", "outcomeAuthority": "worker_proposal",
  "proposalId": 3, "proposalHash": "6219b3e1…095585c7",
  "readiness": {
    "status": "completed", "authority": "shadow_advisor",
    "assessmentId": 2, "assessmentHash": "eff9c1b5…fff79f916",
    "overallReadiness": "ready",
    "recommendedNextAction": "proceed_to_settlement", "error": null } }
```

**DB state:**
- one readiness ControlIntent for proposal 3 (status `concluded`);
- one advisor task (`discovery.assess`, `done`);
- one assessment row id=2, `status=accepted_by_kernel`, `overall_readiness=ready`.

**Verdict:** PASS. The advisor ran to completion and assessed the Proposal
as `ready`. The discovery outcome is UNCHANGED: `outcomeAuthority` stays
`worker_proposal` (NOT `shadow_advisor`), `scopeCompleted` stays true, reason
stays `completed`. The shadow verdict lives only in the `readiness` section.

---

## Smoke B — Proposal with visible blocking gaps

**Engine result:**
```json
{ "reason": "completed", "cycles": 144, "scopeCompleted": true,
  "outcome": "go", "outcomeAuthority": "worker_proposal",
  "proposalId": 4, "proposalHash": "93490cb8…3de07439",
  "readiness": {
    "status": "completed", "authority": "shadow_advisor",
    "assessmentId": 4, "assessmentHash": "ef10f135…006e0b2ea",
    "overallReadiness": "conditionally_ready",
    "recommendedNextAction": "proceed_to_settlement", "error": null } }
```

**DB state (assessment id=4 payload):**
- `overall_readiness = conditionally_ready`;
- `blocking_gaps` = 1 (non-empty, e.g. `GAP-RUNTIME-001`);
- `non_blocking_gaps` = 2;
- two dimensions classified `partial` (`evidence_grounding`,
  `stakeholder_coverage`), the rest `sufficient`;
- the blocking gap cites a real source `raw:5` (anti-invent-evidence held —
  the advisor did not fabricate references).
- product proposal 4: `execution_id` = discovery exec, `provenance` has NO
  advisor/normalizer block (lineage separation held).

**Verdict:** PASS. The advisor found genuine gaps but did NOT block the
discovery outcome or convert it to a failure. `overall_readiness` is
`conditionally_ready` (an honest verdict), the discovery outcome is unchanged,
and every cited source resolves to a real identifier. The advisor said "not
fully ready" and D3 correctly recorded that as a shadow observation rather
than rewriting the outcome — exactly the central D3 invariant.

---

## Smoke C — advisor submits a deliberately invalid source reference

> **History:** the original D3 (9895532) marked this scenario PASS with
> `readiness.status = not_run` — a P0 defect that made "advisor ran and
> failed" indistinguishable from "advisor never ran". The first correction
> (acb9a80) fixed the shadow matrix and made rejection durable, but a
> second-review P0 found that the idempotency-index migration was a no-op on
> pre-correction DBs (the old execution-scoped index survived by name, so
> `ON CONFLICT(control_intent_id, content_hash)` threw and no rejected row
> could persist). The final correction (4bc6eea) rebuilds the index via
> `PRAGMA index_info` inspection + deterministic dedupe. The run below is the
> authoritative end-to-end evidence: a pre-correction DB, migrated on open,
> with a durable `rejected_by_kernel` row.

### Smoke C (final, upgraded pre-correction DB)

**DB under test:** a fresh DB seeded with the ORIGINAL execution-scoped index
`UNIQUE(control_intent_id, execution_id, content_hash)` (the 9895532 shape),
then opened through the corrected engine so `ensureSaga3ReadinessSchema`
runs the migration. Project/epic = D3-Smoke-Mig / 1, proposal id 1.

**Advisor instruction (temporary, reverted):** submit an assessment whose
`problem_clarity.source_refs` includes
`invented:evidence:that:does:not:exist` (not in `allowed_source_refs`).

**Engine result:**
```json
{ "reason": "completed", "cycles": 120, "scopeCompleted": true,
  "outcome": "go", "outcomeAuthority": "worker_proposal",
  "proposalId": 1, "proposalHash": "00d9d5ec…82b653be0c",
  "readiness": {
    "status": "failed", "authority": "none",
    "assessmentId": 2, "assessmentHash": "0e52d064…c77e191ef72",
    "overallReadiness": null, "recommendedNextAction": null,
    "error": "assessment rejected: … blocking_gaps[0] cites an unresolved source reference 'invented:evidence:that:does:not:exist'" } }
```

**Migration result (DB after open):**
- `PRAGMA index_info('idx_saga3_readiness_assessment_idempotency')` →
  `[control_intent_id, content_hash]` (was the 3-column execution-scoped index).

**DB state (durable rejected assessments):**
- `saga3_readiness_assessments`: two rows, both `status = rejected_by_kernel`,
  each with non-empty `validation_errors`; `overall_readiness = null` on both.
  The rejected rows cite the invented source reference among the validation
  errors (e.g. `blocking_gaps[0] cites an unresolved source reference
  'invented:evidence:that:does:not:exist'`).
- readiness ControlIntent: `status = concluded`.
- advisor task (`discovery.assess`): `done`.
- product proposal 1: `execution_id` = discovery exec; provenance clean (no
  advisor/normalizer block).

**Verdict (final):** PASS. Every P0/P1 is confirmed end-to-end on an upgraded
DB:
- the index migration rebuilds the content-scoped unique index (the old
  execution-scoped index no longer blocks `ON CONFLICT`);
- the rejected advisor proposal is now DURABLE — `rejected_by_kernel` rows
  survive with their `validation_errors`, exactly as the model requires
  (LM proposes → kernel validates → kernel accepts or rejects → decision
  remains durable);
- `readiness.status = failed` with `assessmentId` and the rejection error in
  the shadow section (not the misleading `not_run`);
- the discovery outcome is completely unchanged (`go` / `worker_proposal` /
  `scopeCompleted=true`) — a failed/paused readiness phase cannot convert a
  successful discovery into a product failure.

The durable-rejected-row contract is ALSO covered deterministically by
`tests/saga3/d3-readiness-correction.test.mjs` (handler + shadow observability)
and the migration path by `tests/saga3/d3-readiness-index-migration.test.mjs`
(index rebuild, cross-exec replay, duplicate collapse).

---

## Roadmap D3 exit-gate coverage

| # | Exit gate | Covered by | Status |
|---|-----------|-----------|--------|
| 1 | readiness runs only after a valid canonical Proposal | engine hook gated on `validProposal && proposal`; Smoke C ran the advisor only after a valid proposal existed; missing-Proposal lifecycle test asserts not_run + no advisor worker | ✅ |
| 2 | advisor authority is minimal and runtime-enforced | `allowed_tools=['task_get','readiness_get','readiness_submit','worker_done']`, `enforcement:'runtime'`; lifecycle test pins the 4-tool allowlist (no proposal_submit/normalization_submit/task_create) | ✅ |
| 3 | source/evidence invention is deterministically rejected | Smoke C: invented ref → durable `rejected_by_kernel` row with the ref in `validation_errors`; domain tests (invented evidence, vague ref, nonexistent ref); empty-refs grounding tests | ✅ |
| 4 | assessment is durable, typed, hashed, idempotent, separately provenanced | Smoke C durable rejected rows; handler tests (idempotent replay, lineage separate); Smoke A/B persisted accepted assessments with content_hash + separate advisor provenance; migration test (cross-exec replay, content-scoped idempotency) | ✅ |
| 5 | product outcome unchanged under every readiness result | Smoke A (ready), B (conditionally_ready), C (rejected/failed) all kept `outcome=go`, `outcomeAuthority=worker_proposal`; lifecycle tests | ✅ |
| 6 | readiness failure cannot convert successful discovery into product failure | lifecycle test "readiness failure does NOT turn successful discovery into a product failure"; Smoke C | ✅ |
| 7 | restart reuses the same ControlIntent and task | service restart-resume + lifecycle "accepted → no respawn"; ControlIntent UNIQUE(proposal_id, proposal_content_hash) | ✅ |
| 8 | full npm test passes | 506 tests, 505 pass, 0 fail, 1 todo | ✅ |
| 9 | all three real LM smoke scenarios pass | Smoke A/B/C above | ✅ |
| 10 | D4 settlement, certificate, stage transition remain absent | engine never advances finalStage; no OutcomeCertificate table/code; `outcomeAuthority` never becomes authoritative; architecture boundary tests | ✅ |

**Critical review criterion met:** the advisor may say `not_ready` (Smoke B
said `conditionally_ready`, the domain supports `not_ready`), but D3 never
rewrites the outcome, never blocks it as an authoritative decision, and never
pretends to be settlement — that is reserved for D4.

**D3 is smoke-verified end-to-end on the local LM.** Next: squash-merge into
`saga3-discovery` → D3 accepted → next slice D4 (authoritative settlement).
