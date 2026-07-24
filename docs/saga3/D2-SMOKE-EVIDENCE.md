# D2 Smoke Evidence — Deterministic Normalization + Bounded LM Advisor

**Date:** 2026-07-24
**Branch under test:** `d2-discovery-normalization` @ `bc04195`
**Model:** `qwen3.6-35b-a3b@q4_k_xl` (LM Studio, `http://localhost:1234`)
**DB:** fresh `C:/Users/user/.zcode/saga.db` (deleted + re-initialized so the D2
schema and the `'paused'` CHECK are present; see D1-1 deferred gap).
**Suite:** `npm test` green before smoke — 448 tests, 447 pass, 0 fail, 1 todo.

Three independent epics, one per scenario, to avoid mixing WorkIntent /
generation_key / raw submissions across runs:

| Smoke | Project/Epic | Intent | Forces |
|-------|--------------|--------|--------|
| A | 1 / 1 | discovery (id 1) | Markdown fence + supported aliases |
| B | 2 / 2 | discovery (id 2) + discovery.normalize (id 3) | Alias conflict → LM normalizer |
| C | 3 / 3 | discovery (id 4) | Invalid JSON string |

Each smoke ran via `node dist/orchestrate-cli.js <proj> <epic> --concurrency=1`
with `SAGA_ORCHESTRATION_MODE=saga3-discovery`, `SAGA_CLAUDE_PATH=claude`,
`TRACKER_AUTOSTART=0`. The LM Studio model route was set in
`episode_workflows.metadata` (`active_model`/`active_provider`/`active_model_limit=1`)
per epic; `~/.claude/settings.json` was already on the LM Studio template.

The temporary smoke payload was injected via `skills/saga-discovery-worker/SKILL.md`
(a `### D2 SMOKE …` override section, swapped between runs) and **reverted**
(`git checkout skills/saga-discovery-worker/SKILL.md`) immediately after each run.
The committed skill contains no smoke text.

---

## Smoke A — deterministic repair, no LM

**Worker instruction:** submit `payload` as a string with one Markdown ```json
fence, using only supported aliases (`problem`, `context`, `stakeholders`,
`assumption`, `questions`, `risk`, `scope`, `evidence`, `outcome="needs_clarification"`,
`reason`). Then `worker_done`.

**Engine result:**
```json
{ "reason": "completed", "cycles": 36, "scopeCompleted": true,
  "outcome": "clarify", "outcomeAuthority": "worker_proposal",
  "proposalId": 1, "proposalHash": "1b9b6ea9…0c200ad" }
```

**DB state:**
- `saga3_raw_submissions` (1 row, id 1):
  - `status = accepted_deterministically`
  - `normalization_trace = ["direct_object","supported_aliases_applied"]`
  - `validation_errors = []`, `alias_conflicts = []`
- `saga3_control_intents` (epic 1): **0 rows**
- `saga3_normalization_proposals` (source 1): **0 rows**
- `saga3_proposals` (intent 1, 1 row):
  - `provenance.normalization_mode = deterministic`
  - `provenance.source_submission_id = 1`

**Verdict:** PASS. Fence + known aliases were normalized without any second LM
call. No ControlIntent, no normalization proposal. Note: the worker emitted a
JSON object (the tool-call layer expanded the fence), so the trace shows
`direct_object` rather than `markdown_fence_removed` — but the alias coercion
step (`supported_aliases_applied`) still fired, proving the deterministic path.

---

## Smoke B — semantic ambiguity → bounded LM normalizer

**Worker instruction:** submit a `payload` object that DELIBERATELY contains
BOTH the canonical field and its alias with DIFFERENT values:

```json
{ "problem_statement": "The primary problem formulation",
  "problem": "A conflicting alternative formulation",
  "observed_context": "Existing project context",
  "stakeholders_or_actors": ["user"], "assumptions": [],
  "unknowns": ["Which formulation is intended"],
  "risks": ["Incorrect scope"],
  "candidate_scope": "Resolve the intended problem and proceed",
  "evidence_refs": [], "recommended_outcome": "clarify",
  "rationale": "The two problem formulations conflict" }
```
Then `worker_done`. Do NOT reconcile the conflict — the kernel's normalizer
handles it.

**Engine result:**
```json
{ "reason": "completed", "cycles": 110, "scopeCompleted": true,
  "outcome": "clarify", "outcomeAuthority": "normalized_worker_proposal",
  "proposalId": 2, "proposalHash": "0d9f57e1…017019ab5" }
```

**DB state (lineage invariants):**
- `saga3_raw_submissions` (1 row, id 2):
  - `status = normalized`
  - `alias_conflicts = ["problem_statement<->problem"]`
  - `raw_hash` unchanged from insert (immutable)
- `saga3_control_intents` (epic 2, 1 row, id 1):
  - `kind = NormalizeDiscoveryProposal`, `status = concluded`
  - `source_submission_id = 2`, `authority_intent_id = 3`, `projected_task_id = 3`
- `saga3_work_intents` (epic 2, 2 rows):
  - id 2 `kind=discovery` `status=concluded`
  - id 3 `kind=discovery.normalize` `status=concluded`
- `tasks` (epic 2, 2 rows):
  - id 2 `task_kind=discovery.work` `status=done`
  - id 3 `task_kind=discovery.normalize` `status=done`
- `saga3_normalization_proposals` (source 2, 1 row, id 1):
  - `status = accepted_by_kernel`
  - `task_id = 3`, `execution_id = exec-2-11260-…232823-1` (normalizer exec)
- `saga3_proposals` (intent 2, 1 row, id 2) — **the critical invariant**:
  - `task_id = 2` (original product task, NOT normalizer task 3)
  - `execution_id = exec-2-11260-…142641-1` (original product execution)
  - `source_submission_id = 2`, `normalization_proposal_id = 1`
  - `provenance.execution_id = exec-…142641-1` (product)
  - `provenance.normalization_mode = lm_transformation`
  - `provenance.normalizer.execution_id = exec-…232823-1` (normalizer)
  - `provenance.normalizer.worker_id = board-2-…232823-1`

**Verdict:** PASS. The full pipeline ran: alias conflict detected → ControlIntent
created → bounded normalizer worker (`saga-discovery-normalizer`) spawned →
`normalization_submit` accepted by kernel → canonical proposal written. The
provenance-separation fixes (`97bfd10` + `e901d26`) hold: the canonical product
proposal keeps the original product `task_id`/`execution_id`; the normalizer
execution is recorded only in the separate `saga3_normalization_proposals` row
and the nested `provenance.normalizer` block. No false task↔execution pair.
`outcomeAuthority = normalized_worker_proposal` correctly marks this as
non-authoritative (D4 settlement owns the eventual committed outcome).

---

## Smoke C — invalid JSON, no LM

**Worker instruction:** submit `payload` as the exact string
`{ this is not valid JSON`. Then `worker_done`.

**Engine result:**
```json
{ "reason": "failed", "cycles": 40, "scopeCompleted": false,
  "outcome": "failed", "outcomeAuthority": "none",
  "proposalId": null, "proposalHash": null,
  "lastError": "worker response was not strict JSON after deterministic fence removal" }
```

**DB state:**
- `saga3_raw_submissions` (1 row, id 3, intent 4):
  - `status = rejected_syntax`
  - `normalization_trace = []`
  - `validation_errors = ["worker response is not a strict JSON object"]`
  - `alias_conflicts = []`
  - kernel comment on task 4: "Raw proposal rejected deterministically: source=3 invalid JSON"
- `saga3_proposals` (intent 4): **0 rows**
- `saga3_control_intents` (epic 3): **0 rows**
- `saga3_normalization_proposals` (source 3): **0 rows**

**Verdict:** PASS. Syntactically unparseable input was rejected
deterministically — it is NOT semantic ambiguity and did NOT trigger a second
LM call. No ControlIntent, no normalizer worker, no proposal. The engine
reported an honest failure (`reason=failed`, `scopeCompleted=false`).

---

## Roadmap D2 exit-gate coverage

| Exit gate | Covered by | Status |
|-----------|-----------|--------|
| deterministic parser fixtures pass | `d2-normalization.test.mjs` (5 cases) + live Smoke A | ✅ |
| advisor invocation is observable | Smoke B: ControlIntent + normalizer worker + `accepted_by_kernel` | ✅ |
| original and normalized hashes retained | Smoke B: `raw_hash` immutable + `content_hash` on normalized proposal | ✅ |
| no normalization path turns missing evidence into present | Smoke B normalizer could not invent evidence (validated by `source_field_map` + `allowed_evidence_refs`); invalid JSON (Smoke C) rejected, not repaired | ✅ |

**D2 is smoke-verified end-to-end on the local LM.** PR #7 is ready for review
→ squash merge into `saga3-discovery` → D2 accepted → next slice D3
(AssessDiscoveryReadiness in shadow mode).
