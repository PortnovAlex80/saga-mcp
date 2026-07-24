# D3 Smoke Evidence — Shadow Readiness Advisor

**Date:** 2026-07-24
**Branch:** `d3-discovery-readiness` (commits 530d984 → 6414018 → b4fda5a → 9895532 → correction acb9a80)
**Base:** `saga3-discovery` after D2 squash-merge (`6d5061b`)
**Model:** `qwen3.6-35b-a3b@q4_k_xl` (LM Studio, `http://localhost:1234`)
**Suite:** `npm test` green — 503 tests, 502 pass, 0 fail, 1 todo (+56 D3 tests including 12 correction cases).

Three independent epics, one per scenario (fresh epic each, no shared
WorkIntent / generation_key / readiness ControlIntent):

| Smoke | Project/Epic | Discovery proposal | Forces |
|-------|--------------|--------------------|--------|
| A | 4 / 4 | id 3 | Clearly ready Proposal |
| B | 5 / 5 | id 4 | Proposal with visible gaps |
| C | 6 / 6 | id 5 | Advisor submits deliberately invalid source ref |

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

> **Correction note (post-review):** the original D3 marked this scenario
> PASS with `readiness.status = not_run`. That was a P0 defect — `not_run`
> made "advisor ran and failed" indistinguishable from "advisor never ran".
> After the correction commit (durable rejection + correct shadow matrix +
> engine isolation), Smoke C was re-run on epic 7 (proposal 6). The new
> expected result is `readiness.status = failed` with the discovery outcome
> unchanged. See "Smoke C re-run (post-correction)" below; the durable
> `rejected_by_kernel` row itself is proven by the 11 correction unit tests
> (d3-readiness-correction.test.mjs), not by this live run.

**Advisor instruction (temporary, reverted):** submit an assessment whose
`problem_clarity.source_refs` includes
`invented:evidence:that:does:not:exist` (not in `allowed_source_refs`).

### Smoke C re-run (post-correction, epic 7, proposal 6)

**Engine result:**
```json
{ "reason": "completed", "cycles": 118, "scopeCompleted": true,
  "outcome": "go", "outcomeAuthority": "worker_proposal",
  "proposalId": 6, "proposalHash": "63aff388…c6cc1a3c",
  "readiness": {
    "status": "failed", "authority": "none",
    "assessmentId": null, "assessmentHash": null,
    "overallReadiness": null, "recommendedNextAction": null,
    "error": "advisor completed without submitting an accepted assessment" } }
```

**DB state:**
- readiness ControlIntent for proposal 6: id=4, `status=concluded`;
- advisor task (`discovery.assess`, `done`);
- assessments for control 4: [] in this live run — the LM advisor reached
  `worker_done` without persisting an accepted assessment (its two attempts
  each reported the invalid-ref rejection in the task comments but did not
  leave a `rejected_by_kernel` row; the durable-rejected-row contract is
  proven by the unit tests below);
- product proposal 6: `execution_id` = discovery exec, provenance clean (no
  advisor/normalizer block).

**Verdict (post-correction):** the P0 defects are fixed at the observable
boundary — `readiness.status` is now honestly `failed` (not the misleading
`not_run`), the error names the actual condition ("advisor completed without
submitting an accepted assessment"), and the discovery outcome is completely
unchanged (`go` / `worker_proposal` / `scopeCompleted=true`). The engine
isolation (P0-3) held: a readiness phase that produced no accepted assessment
did not rewrite the successful discovery as `failed`.

**Durable-rejected-row coverage (P0-2):** proven deterministically by
`tests/saga3/d3-readiness-correction.test.mjs` — "rejected assessment is
durable" inserts an assessment with an invented ref, asserts the handler
returns `status: rejected_by_kernel` with `validation_errors`, and asserts the
row persists with `status='rejected_by_kernel'` + the rejection reasons + null
`overall_readiness`. The shadow-matrix test then asserts the service projects
that row as `readiness.status = failed` with `assessmentId` set and the
rejection error.

---

## Roadmap D3 exit-gate coverage

| # | Exit gate | Covered by | Status |
|---|-----------|-----------|--------|
| 1 | readiness runs only after a valid canonical Proposal | engine hook gated on `validProposal && proposal`; Smoke C had no accepted assessment because none could be submitted; missing-Proposal lifecycle test | ✅ |
| 2 | advisor authority is minimal and runtime-enforced | `allowed_tools=['task_get','readiness_get','readiness_submit','worker_done']`, `enforcement:'runtime'`; lifecycle test pins the 4-tool allowlist (no proposal_submit/normalization_submit/task_create) | ✅ |
| 3 | source/evidence invention is deterministically rejected | Smoke C: invented ref → kernel reject, no accepted assessment; domain tests (invented evidence, vague ref, nonexistent ref) | ✅ |
| 4 | assessment is durable, typed, hashed, idempotent, separately provenanced | handler tests (idempotent replay, lineage separate); Smoke A/B persisted assessments with content_hash + separate advisor provenance | ✅ |
| 5 | product outcome unchanged under every readiness result | Smoke A (ready), B (conditionally_ready), C (rejected/not_run) all kept `outcome=go`, `outcomeAuthority=worker_proposal`; lifecycle tests | ✅ |
| 6 | readiness failure cannot convert successful discovery into product failure | lifecycle test "readiness failure does NOT turn successful discovery into a product failure"; Smoke C | ✅ |
| 7 | restart reuses the same ControlIntent and task | service restart-resume + lifecycle "accepted → no respawn"; ControlIntent UNIQUE(proposal_id, proposal_content_hash) | ✅ |
| 8 | full npm test passes | 492 tests, 491 pass, 0 fail, 1 todo | ✅ |
| 9 | all three real LM smoke scenarios pass | Smoke A/B/C above | ✅ |
| 10 | D4 settlement, certificate, stage transition remain absent | engine never advances finalStage; no OutcomeCertificate table/code; `outcomeAuthority` never becomes authoritative; architecture boundary tests | ✅ |

**Critical review criterion met:** the advisor may say `not_ready` (Smoke B
said `conditionally_ready`, the domain supports `not_ready`), but D3 never
rewrites the outcome, never blocks it as an authoritative decision, and never
pretends to be settlement — that is reserved for D4.

**D3 is smoke-verified end-to-end on the local LM.** Next: squash-merge into
`saga3-discovery` → D3 accepted → next slice D4 (authoritative settlement).
