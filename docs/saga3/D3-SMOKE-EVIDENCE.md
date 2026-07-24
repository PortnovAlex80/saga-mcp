# D3 Smoke Evidence — Shadow Readiness Advisor

**Date:** 2026-07-24
**Branch:** `d3-discovery-readiness` (commits 530d984 → 6414018 → tests → this doc)
**Base:** `saga3-discovery` after D2 squash-merge (`6d5061b`)
**Model:** `qwen3.6-35b-a3b@q4_k_xl` (LM Studio, `http://localhost:1234`)
**Suite:** `npm test` green — 492 tests, 491 pass, 0 fail, 1 todo (+44 new D3 tests).

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

**Advisor instruction (temporary, reverted):** submit an assessment whose
`problem_clarity.source_refs` includes
`invented:evidence:that:does:not:exist` (not in `allowed_source_refs`).

**Engine result:**
```json
{ "reason": "completed", "cycles": 116, "scopeCompleted": true,
  "outcome": "go", "outcomeAuthority": "worker_proposal",
  "proposalId": 5, "proposalHash": "14c82ad2…82abb07e1",
  "readiness": {
    "status": "not_run", "authority": "none",
    "assessmentId": null, "assessmentHash": null,
    "overallReadiness": null, "recommendedNextAction": null, "error": null } }
```

**DB state:**
- readiness ControlIntent for proposal 5: id=3, `status=concluded`;
- advisor task id=10 (`discovery.assess`, `done`);
- **assessments for control 3: []** — no accepted assessment persisted;
- advisor task comments (authored by the advisor worker, two attempts):
  *"D3 SMOKE C: Submitted readiness assessment with deliberately invalid source
  reference 'invented:evidence:that:does:not:exist' in problem_clarity
  dimension. Kernel rejected the submission — validation [error]"*
- product proposal 5: `execution_id` = discovery exec, provenance clean.

**Verdict:** PASS. The kernel deterministically REJECTED the assessment
because the cited source did not resolve to an allowed identifier — the
anti-invent-evidence guard held. No assessment was accepted, no shadow verdict
was fabricated. The advisor worker honestly reported the rejection and exited.
The discovery outcome is completely unchanged. This confirms the rule: a
rejected advisor submission cannot silently turn into an accepted assessment,
and cannot convert a successful discovery into a product failure.

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
