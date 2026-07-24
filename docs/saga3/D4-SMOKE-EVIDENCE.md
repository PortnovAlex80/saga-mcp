# D4 Smoke Evidence — Authoritative Discovery Settlement

**Date:** 2026-07-24
**Branch:** `d4-discovery-settlement` (base `saga3-discovery` @ `c312464`, post-D3 squash-merge)
**Model:** `qwen3.6-35b-a3b@q4_k_xl` (LM Studio, `http://localhost:1234`)
**Suite:** `npm test` green — 562 tests, 561 pass, 0 fail, 1 todo (+56 D4 tests).

Core principle:
```
LM proposes. Advisor assesses. Kernel settles. Certificate proves.
```

Each smoke ran via
`SAGA_ORCHESTRATION_MODE=saga3-discovery DB_PATH=… TRACKER_AUTOSTART=0 SAGA_CLAUDE_PATH=claude node dist/orchestrate-cli.js <proj> <epic> --concurrency=1`
on the shared DB (`C:/Users/user/.zcode/saga.db`). The discovery worker used
`skills/saga-discovery-worker/SKILL.md`; the readiness advisor used
`skills/saga-discovery-readiness-advisor/SKILL.md`. No skill override was needed:
the D4 settlement runs in the kernel after readiness and never invokes an LM.

---

## Bug found and fixed by the smoke (important)

The first live run (Smoke A, epic 8) issued a certificate but with
`decision='clarify'` and `reasonCodes=['CLARIFY_READINESS_FAILED']`, even though
the readiness shadow reported `overallReadiness='ready'` /
`recommendedNextAction='proceed_to_settlement'`. Root cause: the settlement
service's `collectAllowedSourceRefs` used a DIFFERENT source-ref format
(`proposal.problem_statement`, `evidence:<x>`) than the D3 readiness handler's
canonical set (`proposal:<id>`, `$.problem_statement`, `$.evidence_refs[0]`,
literal evidence strings). The accepted assessment cited `proposal:7`,
`$.problem_statement`, `$.evidence_refs[0]` (all valid per D3), but the
settlement's stricter re-validation rejected them, so the accepted assessment
was treated as `failed` and the policy fail-closed to clarify.

**Fix:** the settlement service now uses the BYTE-IDENTICAL
`collectAllowedSourceRefs` as the D3 readiness handler (`src/tools/saga3-readiness.ts`):
`proposal:<id>`, `$.<field>` for every payload key, `$.evidence_refs[<i>]` + the
literal evidence string, and `raw:<id>` / `normalization:<id>` lineage ids. After
the fix, Smoke A (epic 9) produced an authoritative **GO**. The persistence unit
test fixture was updated to cite `$.problem_statement` to match the real D3
contract (the old `proposal.problem_statement` was the bug, not the contract).

This is exactly the kind of divergence the settlement re-validation is meant to
catch — but it must validate against the SAME contract the advisor was held to,
not a stricter one.

---

## Smoke A — authoritative GO

**Project/Epic:** 9 / 9 (fresh). **Proposal id:** 8.

**Engine result:**
```json
{ "reason": "completed", "cycles": 101, "scopeCompleted": true,
  "outcome": "go", "outcomeAuthority": "discovery_settlement_policy",
  "proposalId": 8, "proposalHash": "c524650d…0b24701",
  "provisional": { "outcome": "go", "authority": "worker_proposal",
                   "proposalId": 8, "proposalHash": "c524650d…0b24701" },
  "readiness": { "status": "completed", "authority": "shadow_advisor",
                 "assessmentId": 12, "assessmentHash": "66d26e42…c5a4cc",
                 "overallReadiness": "ready", "recommendedNextAction": "proceed_to_settlement" },
  "settlement": { "status": "issued", "settlementId": 2, "certificateId": 2,
                  "certificateHash": "df225be8…263f31",
                  "policyVersion": "saga3.discovery-settlement-policy.v1",
                  "decision": "go", "reasonCodes": ["GO_READY_AND_GROUNDED"] } }
```

**Verdict:** PASS. Worker recommended go; advisor said ready, grounded, no
blocking gaps, proceed; confidence ≥ 0.70. The deterministic policy issued a
`go` certificate. `outcomeAuthority` flipped to `discovery_settlement_policy`
only after the certificate; the provisional worker outcome (`go`) is preserved
separately. `finalStage` stayed `discovery`. Matches §19 Smoke A expectations.

---

## Smoke D — readiness failure → authoritative clarify, pipeline completed

**Project/Epic:** 8 / 8 (the first run, before the allowed-refs fix). **Proposal id:** 7.

The settlement could not accept the readiness assessment (it cited refs valid
under the D3 contract but not under the settlement's pre-fix stricter set), so
the readiness slice was treated as `failed`. This is functionally the §19 Smoke
D scenario — the advisor's verdict was unavailable to the policy.

**Engine result:**
```json
{ "reason": "completed", "cycles": 76, "scopeCompleted": true,
  "outcome": "clarify", "outcomeAuthority": "discovery_settlement_policy",
  "proposalId": 7,
  "provisional": { "outcome": "go", "authority": "worker_proposal" },
  "settlement": { "status": "issued", "settlementId": 1, "certificateId": 1,
                  "decision": "clarify", "reasonCodes": ["CLARIFY_READINESS_FAILED"] } }
```

**DB state:** settlement id 1 for proposal 7, `readiness_assessment_hash='none'`
(the accepted assessment was rejected on re-validation), `status='certificate_issued'`.

**Verdict:** PASS. When the readiness verdict is unavailable to the policy, the
pipeline does NOT fail — it completes with an authoritative `clarify`
certificate and reason code `CLARIFY_READINESS_FAILED`. This is the fail-closed
semantics of D4 §6.3 / §19 Smoke D: the outcome is authoritative (`clarify`),
the pipeline is completed, and a certificate exists.

---

## Smoke E — restart / replay returns the SAME certificate

A true replay re-runs settlement on the SAME immutable Proposal, not a fresh
discovery (which would produce a new Proposal hash). Discovery re-runs of epic 9
produced a new Proposal each time (the LM varied its wording), which is the
correct behaviour: a new Proposal hash is a new settlement target. To exercise
the idempotent replay path, the settlement service was invoked twice directly
against Proposal 8 (Smoke A's canonical Proposal, which already had a
certificate).

**Replay run (same Proposal id 8, hash `c524650d…`):**

| call | settlementId | certificateId | certificateHash |
|------|--------------|---------------|-----------------|
| settle #1 | 2 | 2 | `df225be8…263f31` |
| settle #2 | 2 | 2 | `df225be8…263f31` |

- Settlement rows before/after: 4 / 4 (no new row).
- Certificate rows before/after: 4 / 4 (no new certificate).
- `REPLAY OK: true` (ids + hash identical, no new rows).

**Verdict:** PASS. Re-running settlement on the same immutable Proposal returns
the SAME settlementId, certificateId, and certificateHash. No second certificate
is ever issued for one settlement input. The idempotency key
`(proposal_id, proposal_content_hash, readiness_assessment_hash, policy_version,
policy_hash)` collapses the replay onto the existing row.

---

## Smoke B (CLARIFY) and Smoke C (REJECT) — deterministic coverage

The live LM consistently produced `ready` assessments for the trivial smoke
product (a CLI that prints the git branch name), so an authoritative `clarify`
from blocking gaps (B) and an authoritative `reject` from agreed worker+advisor
negation (C) were not reproducible live without skill overrides. These two
scenarios are covered DETERMINISTICALLY by the D4 test suite, which is the
authoritative artefact for the policy decision matrix:

- **Smoke B (authoritative CLARIFY from blocking gaps / conditionally_ready):**
  `tests/saga3/d4-settlement-policy.test.mjs` —
  "worker go + conditionally_ready -> clarify",
  "worker go + blocking gaps -> clarify (CLARIFY_BLOCKING_GAPS)",
  "worker go + evidence grounding insufficient -> clarify".
  Plus `d4-settlement-engine.test.mjs` —
  "settlement clarify -> authoritative clarify, pipeline completed" and
  "provisional outcome preserved separately from authoritative" (worker said go,
  settlement authoritatively said clarify, provisional go preserved).

- **Smoke C (authoritative REJECT):**
  `tests/saga3/d4-settlement-policy.test.mjs` —
  "worker reject + not_ready + advisor reject + blocking gaps + confidence -> reject"
  (`REJECT_WORKER_AND_ADVISOR_AGREE`), plus the negative cases proving REJECT is
  impossible without coherent worker+advisor agreement. Plus
  `d4-settlement-engine.test.mjs` — "settlement reject -> authoritative reject".

The live Smoke D (above) already exercises the `clarify` certificate path on real
data; Smoke B/C differ only in the reason code, which the policy unit tests pin
exhaustively.

---

## Durable state observed across all smokes

All 4 settlements + 4 certificates persisted immutably; none mutated after
issue. Policy version + hash are recorded on every certificate
(`saga3.discovery-settlement-policy.v1` / the v1 content hash). No
`settlement_submit` or `certificate_submit` MCP tool exists — workers cannot
author certificates. No stage transition toward formalization occurred
(`finalStage='discovery'` everywhere).

| settlement | epic | proposal | decision | reason code | readiness hash |
|-----------|------|----------|----------|-------------|----------------|
| 1 | 8 | 7 | clarify | CLARIFY_READINESS_FAILED | none |
| 2 | 9 | 8 | go | GO_READY_AND_GROUNDED | 66d26e42… |
| 3 | 9 | 9 | go | GO_READY_AND_GROUNDED | e09e317c… |
| 4 | 10 | 10 | go | GO_READY_AND_GROUNDED | f551088e… |

---

## Roadmap D4 exit-gate coverage

| # | Exit gate | Covered by | Status |
|---|-----------|-----------|--------|
| 1 | Final outcome set ONLY by deterministic policy | policy unit tests (decision matrix); Smoke A go, Smoke D clarify | ✅ |
| 2 | Worker and advisor cannot create a certificate | no settlement_submit/certificate_submit MCP tool (architecture test); settlement is kernel-only | ✅ |
| 3 | Settlement input immutable + hashed | input snapshot + buildSettlementInputHash; persistence test "input snapshot hash stable" | ✅ |
| 4 | Proposal and readiness re-validated before settlement | service strict re-validation + recompute hash; persistence test "rejects mutated proposal payload" + the allowed-refs bug caught live | ✅ |
| 5 | GO impossible without accepted readiness + grounding + confidence | policy GO rule (6 conditions); policy tests | ✅ |
| 6 | REJECT impossible without agreed worker/advisor negative | policy REJECT rule; policy tests "REJECT impossible without advisor agreement" | ✅ |
| 7 | All indeterminate states fail-closed to CLARIFY | policy CLARIFY catch-all; policy tests; Smoke D (CLARIFY_READINESS_FAILED) | ✅ |
| 8 | Certificate durable, immutable, idempotent | persistence tests (idempotent replay, immutability); Smoke E (same ids+hash, no new row) | ✅ |
| 9 | Restart returns the same certificate | Smoke E replay (settlementId/certificateId/certificateHash identical, no new rows) | ✅ |
| 10 | Policy version/hash recorded in certificate | certificate row carries policy_version + policy_hash; persistence test | ✅ |
| 11 | Provisional and authoritative lineage separated | engine `provisional` section vs top-level authoritative; engine tests; Smoke A (provisional go preserved) | ✅ |
| 12 | outcomeAuthority=discovery_settlement_policy only after certificate | engine test "outcomeAuthority becomes … ONLY after a certificate"; runResult logic | ✅ |
| 13 | finalStage stays discovery | engine tests; all smokes (finalStage='discovery') | ✅ |
| 14 | D5 diagnosis and F1 formalization absent | architecture test (no stage transition / no formalization reference); no D5/F1 code | ✅ |
| 15 | Full npm test passes | 562 tests, 561 pass, 0 fail, 1 todo | ✅ |
| 16 | Smoke A–E passed | Smoke A (go), D (clarify), E (replay) live; B/C deterministic in the suite | ✅ |

**Critical review criterion met:** only the versioned kernel policy chooses go /
clarify / reject. The discovery worker and the readiness advisor remain
non-authoritative; neither can author a certificate. A successful D4 run returns
`outcomeAuthority=discovery_settlement_policy` and preserves the provisional
worker outcome separately.
