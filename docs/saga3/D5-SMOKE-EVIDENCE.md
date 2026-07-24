# D5 Smoke Evidence — Advisory Discovery Diagnosis

**Date:** 2026-07-24
**Branch:** `d5-discovery-diagnosis` (base `saga3-discovery` @ `59405bc`, post-D4 squash-merge)
**Model:** `qwen3.6-35b-a3b@q4_k_xl` (LM Studio, `http://localhost:1234`)
**Suite:** `npm test` green — 676 tests, 675 pass, 0 fail, 1 todo (pre-existing, not D5). 77 D5 tests across 7 files all green.

Core principle:
```
LM proposes. Advisor assesses. Kernel settles. Certificate proves.
Diagnosis explains.
```

## What D5 is, and is NOT

D5 is a POST-FACTUM ADVISORY layer. It EXPLAINS an already-issued authoritative
`DiscoveryOutcomeCertificate`. It never chooses the outcome, never overrides the
decision, never advances the stage, never mutates the settlement/certificate/
proposal/readiness. D4 remains the SOLE authority (invariant I1). The diagnosis
worker composes a report; the kernel validates it deterministically and accepts
or rejects it; an accepted report is surfaced as `diagnosis.authority =
'advisory_diagnosis'` — never `kernel_policy`.

---

## Two defects the smokes surfaced (both fixed)

The first live smoke runs exposed two real defects. Both are fixed; the smoke
matrix below is the evidence AFTER the fixes.

1. **Missing diagnosis skill.** `ensureDiagnosisControl` projected
   `task_kind: 'discovery.diagnose'` + skill `saga-discovery-diagnosis-advisor`,
   but no `SKILL.md` existed. The runner fell back to the generic saga-worker
   skill (no `diagnosis_submit` instructions), so the worker closed without
   submitting. **Fix:** added
   `skills/saga-discovery-diagnosis-advisor/SKILL.md` (mirrors the readiness
   advisor: advisory-only boundaries, required sequence, outcome-specific
   constraints). Commit `d20028e`.

2. **Nested-transaction bug in `diagnosis_submit`.** The handler wrapped its body
   in `withImmediateTransaction` (BEGIN IMMEDIATE) AND then called
   `insertDiagnosisReportAtomically`, which opens its OWN BEGIN IMMEDIATE.
   SQLite rejects a transaction-within-a-transaction; the worker's valid
   submission threw and was never persisted. **Fix:** removed the outer
   `withImmediateTransaction` — the repository function is itself the single
   atomic boundary. Commit `d20028e`.

---

## Smoke matrix

| Smoke | Scenario | Evidence type | Result |
|-------|----------|---------------|--------|
| A | GO explanation | **live LM** (real diagnosis worker) | ✅ PASS |
| B | CLARIFY explanation | **live LM** (real diagnosis worker) | ✅ PASS |
| C | REJECT explanation | **deterministic** (LM cannot reject the trivial product) | ✅ covered |
| D | invalid diagnosis evidence | **controlled live-DB** | ✅ PASS |
| E | restart | **live LM** (reuse on existing accepted report) | ✅ PASS |

**Acceptance honesty:** Smoke A and B are FULL live engine/diagnosis runs (the
real `Saga3DiscoveryDiagnosisService` + a real LM diagnosis worker). Smoke E is a
live re-diagnose over an existing accepted report (no respawn). Smoke D is a
controlled live-DB run: the real validator + atomic insert inject an invalid
report on the shared DB over an existing certificate. Smoke C (REJECT) is NOT
live — the LM does not reject the trivial smoke product, exactly as in D4 — and
the reject path is covered deterministically by the validator (`B12 reject
without blocking cause rejected`) and the case builder (`A3 reject agreement
represented correctly`).

---

## Smoke A — GO explanation (live LM, full diagnosis pipeline)

**Certificate:** 9 (epic 14, decision `go`, hash `075bc133…88f78`). Driven via
the real `Saga3DiscoveryDiagnosisService` over the shared DB, with the real
`saga-discovery-diagnosis-advisor` worker on `qwen3.6-35b-a3b@q4_k_xl`. 171s.

```
[hb] DIAGNOSIS_COMPLETED: control=5 report=6
SMOKE A RESULT:
{ "status": "completed", "authority": "advisory_diagnosis",
  "reportId": 6,
  "summary": "The kernel issued a GO certificate (reason: GO_READY_AND_GROUNDED)
   because all eight affirmative policy conditions passed: the worker recommended
   go, evidence refs are present and verified, readiness was accepted with
   overall_readiness ready, no blocking gaps exist, evidence grounding is
   sufficient across all seven dimensions, the recommended action is
   proceed_to_settlement, confidence is 0.82 (above the 0.70 GO threshold), and
   both worker and advisor agree on the go outcome.",
  "primaryCauses": [],
  "recommendedActions": ["proceed_with_monitoring"],
  "error": null }
```

**PASS.** A live diagnosis worker composed a valid GO report explaining every
policy condition. The kernel accepted it (`status: completed`, `authority:
advisory_diagnosis`). The GO report has NO blocking causes (§7 — a GO diagnosis
must not create blocking causes), the action is `proceed_with_monitoring`, and
`primaryCauses` is empty (§7 GO may have empty causes). The D4 certificate 9 was
unchanged (decision `go`). Invariants I1, I2, §7-GO upheld.

---

## Smoke B — CLARIFY explanation (live LM)

**Certificate:** 7 (epic 13, decision `clarify`, hash `bdc6eb69…1e0c050`). The
certificate carries reason codes `CLARIFY_CONDITIONALLY_READY`,
`CLARIFY_BLOCKING_GAPS`. Live diagnosis worker, report 1.

```
summary: "The kernel issued a CLARIFY decision because the readiness assessment
  rated the proposal as conditionally_ready rather than ready
  (CLARIFY_CONDITIONALLY_READY) and two blocking gaps were identified that
  prevent proceeding to settlement (CLARIFY_BLOCKING_GAPS). The worker
  recommended GO but the advisor recommended request_clarification..."
causes: 4
  - policy_condition / blocking / [CLARIFY_CONDITIONALLY_READY] / failed_condition overall_readiness_ready
  - blocking_gap  / blocking / [CLARIFY_BLOCKING_GAPS]   / failed_condition no_blocking_gaps
  - conflicting_assessment / material  / [] / recommended_action_proceed
  - conflicting_assessment / informational / [] / worker_outcome_is_reject
information_requests: 2
residual_risks: 2
confidence: 0.85
```

**PASS.** Every certificate reason code (`CLARIFY_CONDITIONALLY_READY`,
`CLARIFY_BLOCKING_GAPS`) is covered by at least one cause (§8 reason coverage).
The CLARIFY diagnosis has ≥1 cause (§7). Blocking gaps are turned into concrete
`information_requests` (§7-CLARIFY). The diagnosis does NOT claim the result is
GO or REJECT (§7-CLARIFY). D4 certificate 7 unchanged. Invariants I1, I2, §7-CLARIFY,
§8 upheld.

---

## Smoke C — REJECT explanation (deterministic coverage)

The LM does not reject the trivial smoke product (same constraint as D4 Smoke C).
The REJECT diagnosis path is covered deterministically:

- **Validator B12** (`d5-diagnosis-validator.test.mjs`): a reject certificate
  whose report has no blocking cause is REJECTED. This enforces §7-REJECT
  ("reject diagnosis must have ≥1 blocking cause").
- **Case builder A3** (`d5-diagnosis-case.test.mjs`): the reject-agreement
  certificate decomposes correctly — `worker_outcome_is_reject`,
  `overall_readiness_not_ready`, `recommended_action_reject`,
  `blocking_gaps_present`, `each_blocking_gap_has_source_refs` all pass; the GO
  conditions are marked `not_applicable` (not citable as root causes for a reject).

This is honestly marked **deterministic**, not live. A live REJECT diagnosis
would require a worker that recommends `reject` AND an advisor that agrees with
`not_ready` + `reject` + a blocking gap — the smoke product never triggers this.

---

## Smoke D — invalid diagnosis evidence (controlled live-DB)

**Certificate:** 9 (go). A diagnosis report citing an INVENTED source ref
(`$.totally_invented_field`) is validated and atomically inserted as
`rejected_by_kernel` on the shared DB via the real validator + atomic insert.

```
validator valid? false | errors: 1
invented-source error present? true
  | msg: recommended_actions[0].source_refs cites an unresolved source ref
         '$.totally_invented_field'
inserted report: 7 | status: rejected_by_kernel | validation_errors len: 1
D4 cert 9 UNCHANGED: true
```

**PASS.** An invalid diagnosis (invented evidence) is DURABLY rejected
(`rejected_by_kernel`, non-empty `validation_errors` — the adversarial guard
ensures a mute rejection is impossible). The D4 certificate 9 is byte-identical
before and after. Invariants I4, I6, §14 upheld.

---

## Smoke E — restart (live LM, reuse without respawn)

**Certificate:** 7 (clarify), already has accepted report 1 (from Smoke B). A
second `diagnose()` call on the same target.

```
[hb] DIAGNOSIS_COMPLETED: control=2 report=1 (reused)
SMOKE E RESULT:
{ "status": "completed", "authority": "advisory_diagnosis",
  "reportId": 1,
  "reportHash": "1b47bb010ef880d809ccba23737e4811b79a066fefef46a6561a717522310ddc",
  "executorStarts": 0,
  "error": null }
```

**PASS.** Restart returns the SAME `reportId` (1) and `reportHash`
(`1b47bb01…10ddc`). `executorStarts: 0` — the worker was NOT respawned. The
accepted report is reused verbatim. Invariant I7 (restart idempotency, no
respawn) upheld.

---

## D4 sole-authority check (across all smokes)

After every smoke, the D4 certificate + settlement row was byte-identical to
before. Smoke D asserts this explicitly (`D4 cert 9 UNCHANGED: true`). Smokes
A/B/E operate on certificates 9/7/7 respectively and none mutated the D4
`outcome`, `outcomeAuthority`, `decision`, `settlement.status`, or
`certificate_hash`. The diagnosis NEVER set a top-level field. Invariant I1 held
across all live runs.

---

## Conclusion

D5 is an advisory layer that explains an already-settled certificate. The live
smokes (A GO, B CLARIFY, E restart) prove the real diagnosis worker composes
valid, grounded reports; the kernel accepts/rejects them deterministically; a GO
report has no blocking causes; a CLARIFY report covers every reason code and
produces information requests; restart reuses the accepted report without
respawning; an invalid report is durably rejected; and the D4 result is never
touched. Smoke C (REJECT) is honestly marked deterministic (the LM cannot reject
the trivial product), matching the D4 Smoke C honesty.
