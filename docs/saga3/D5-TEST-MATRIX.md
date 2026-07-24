# D5 — Advisory Discovery Diagnosis: Test Matrix

> **Roadmap D5, §15.** This matrix is created BEFORE any application/engine
> integration code. Every required test is listed with its invariant ID,
> scenario, expected result, test file, test name, and evidence type.
>
> Evidence types:
> - **pure** — deterministic unit test of a pure domain function (no DB, no LM).
> - **persistence** — test against a temp-file SQLite DB via `mkdtempSync`.
> - **service** — test of the diagnosis service against a real SQLite runtime
>   port + a fake/controlled worker (no live LM, unless noted).
> - **engine** — test of the engine integration against a fake executor + real
>   SQLite runtime port (no live LM).
> - **architecture** — static source-grep boundary test (no runtime).
> - **adversarial** — Stage 5 read-only attack tests (separate subagent).
> - **smoke** — live LM evidence for A/B and controlled end-to-end or integrity evidence for C/D/E.
> - **integrity** — adversarial checks of frozen-case, lineage, replay and accepted-report verification.

The exact test names may evolve slightly during implementation; the invariant +
scenario columns are the contract.

## Final executable status

The original A–H rows remain the planning trace. The final executable suite is
larger because the independent review added a shared certificate-bundle suite,
integrity attacks and a controlled end-to-end REJECT smoke.

| File | Tests | Result |
|---|---:|---|
| `d5-certificate-bundle.test.mjs` | 10 | pass |
| `d5-diagnosis-case.test.mjs` | 10 | pass |
| `d5-diagnosis-validator.test.mjs` | 23 | pass |
| `d5-diagnosis-persistence.test.mjs` | 13 | pass |
| `d5-diagnosis-service.test.mjs` | 8 | pass |
| `d5-diagnosis-engine.test.mjs` | 11 | pass |
| `d5-adversarial.test.mjs` | 10 | pass |
| `d5-diagnosis-integrity.test.mjs` | 5 | pass |
| `d5-controlled-reject-smoke.test.mjs` | 1 | pass |
| **Focused runtime total** | **91** | **91 pass / 0 fail** |

The D5 architecture-boundary file adds 11 static checks. The repository-wide
Node.js 24 gate is 701 total, 700 pass, 0 fail and 1 pre-existing todo.

---

## A. DiagnosisCase builder — pure tests (§16)

| # | invariant | scenario | expected | file | test name | evidence |
|---|-----------|----------|----------|------|-----------|----------|
| A1 | I3,I4 | GO snapshot → policy_conditions | every GO predicate marked `passed`; reason_code `GO_READY_AND_GROUNDED` present | `tests/saga3/d5-diagnosis-case.test.mjs` | `D5 case: GO conditions marked passed` | pure |
| A2 | I3 | clarify-from-gaps snapshot | blocking-gap predicates marked `failed`; reason code `CLARIFY_BLOCKING_GAPS` surfaces a failed condition | `d5-diagnosis-case.test.mjs` | `D5 case: clarify reason codes map to failed conditions` | pure |
| A3 | I3 | reject agreement snapshot | exact policy trace contains contributing passed REJECT predicates; GO branch predicates are `not_evaluated` and cannot be cited as causes | `d5-diagnosis-case.test.mjs` | `D5 case: reject agreement represented correctly` | pure |
| A4 | I4 | source allowlist deterministic | `allowed_source_refs` is a function of the certificate+proposal+assessment only (same inputs ⇒ same set, same order-independent content) | `d5-diagnosis-case.test.mjs` | `D5 case: allowed_source_refs deterministic` | pure |
| A5 | I7 | case hash deterministic | same certificate+proposal+readiness+policy ⇒ same `diagnosis_case_hash` | `d5-diagnosis-case.test.mjs` | `D5 case: hash deterministic` | pure |
| A6 | I3 | changed certificate hash ⇒ changed case hash | mutating the certificate_hash changes `diagnosis_case_hash` | `d5-diagnosis-case.test.mjs` | `D5 case: certificate hash change changes case hash` | pure |
| A7 | I7 | `captured_at` excluded from semantic hash | two cases with different `captured_at` but identical inputs ⇒ same hash | `d5-diagnosis-case.test.mjs` | `D5 case: captured_at not in semantic hash` | pure |
| A8 | I3 | readiness missing/failed/paused | each non-accepted readiness state produces the matching failed condition + reason code (no fabricated assessment) | `d5-diagnosis-case.test.mjs` | `D5 case: missing/failed/paused readiness conditions` | pure |

---

## B. Diagnosis validator — pure tests (§16, §8)

| # | invariant | scenario | expected | file | test name | evidence |
|---|-----------|----------|----------|------|-----------|----------|
| B1 | I3 | exact target accepted | report.target matches case.certificate exactly ⇒ valid | `tests/saga3/d5-diagnosis-validator.test.mjs` | `D5 validator: exact target accepted` | pure |
| B2 | I3 | wrong certificate_id | mismatched certificate_id ⇒ rejected | `d5-diagnosis-validator.test.mjs` | `D5 validator: wrong certificate id rejected` | pure |
| B3 | I3 | wrong certificate_hash | mismatched certificate_hash ⇒ rejected | `d5-diagnosis-validator.test.mjs` | `D5 validator: wrong certificate hash rejected` | pure |
| B4 | I8 | unknown reason code | a cause cites a reason_code NOT on the certificate ⇒ rejected | `d5-diagnosis-validator.test.mjs` | `D5 validator: unknown reason code rejected` | pure |
| B5 | §8 | missing reason coverage (clarify/reject) | a clarify/reject certificate reason_code not covered by any cause ⇒ rejected. NOTE: reason-coverage applies to CLARIFY and REJECT only — GO may legitimately have empty causes (it explains why everything is fine via residual risks + proceed_with_monitoring). Resolves the §7↔§8 tension: §7 allows empty causes for GO, §8 requires coverage. Coverage is enforced where §7 mandates causes. | `d5-diagnosis-validator.test.mjs` | `D5 validator: missing reason coverage rejected` | pure |
| B6 | I4 | invented source ref | a cause cites a source ref not in allowed_source_refs ⇒ rejected | `d5-diagnosis-validator.test.mjs` | `D5 validator: invented source ref rejected` | pure |
| B7 | I4 | empty source refs | a cause/action/risk with empty source_refs ⇒ rejected | `d5-diagnosis-validator.test.mjs` | `D5 validator: empty source refs rejected` | pure |
| B8 | §8 | dangling internal ref | `resolves_cause_ids` points to a non-existent cause_id ⇒ rejected | `d5-diagnosis-validator.test.mjs` | `D5 validator: dangling cause ref rejected` | pure |
| B9 | §8 | invalid condition grounding | a cause cites a non-contributing or wrong-branch `cited_condition_id` ⇒ rejected | `d5-diagnosis-validator.test.mjs` | final validator grounding tests | pure |
| B10 | §7 | GO with blocking cause | decision=go but a cause has severity=`blocking` ⇒ rejected | `d5-diagnosis-validator.test.mjs` | `D5 validator: GO with blocking cause rejected` | pure |
| B11 | §7 | clarify with empty causes | decision=clarify but cause_analysis is empty ⇒ rejected | `d5-diagnosis-validator.test.mjs` | `D5 validator: clarify with empty causes rejected` | pure |
| B12 | §7 | reject without blocking cause | decision=reject but no blocking cause ⇒ rejected | `d5-diagnosis-validator.test.mjs` | `D5 validator: reject without blocking cause rejected` | pure |
| B13 | §8 | confidence out of range | confidence < 0 or > 1 ⇒ rejected | `d5-diagnosis-validator.test.mjs` | `D5 validator: confidence out of range rejected` | pure |
| B14 | I1 | forbidden fields present | payload contains `new_outcome`/`override_decision`/`settled`/`transition_stage`/`new_certificate` ⇒ rejected | `d5-diagnosis-validator.test.mjs` | `D5 validator: forbidden authority fields rejected` | pure |
| B15 | §8 | duplicate ids | cause_id / action_id / request_id duplicated ⇒ rejected | `d5-diagnosis-validator.test.mjs` | `D5 validator: duplicate ids rejected` | pure |

---

## C. Persistence tests (§17)

| # | invariant | scenario | expected | file | test name | evidence |
|---|-----------|----------|----------|------|-----------|----------|
| C1 | I3 | fresh schema | `ensureSaga3DiagnosisSchema` creates both tables idempotently on an empty DB | `tests/saga3/d5-diagnosis-persistence.test.mjs` | `D5 persistence: fresh schema idempotent` | persistence |
| C2 | I7 | migration from pre-D5 DB | a DB seeded with D4 rows but no D5 tables accepts the D5 DDL without error and FK-checks pass | `d5-diagnosis-persistence.test.mjs` | `D5 persistence: migration from pre-D5 DB` | persistence |
| C3 | I3 | one ControlIntent per target | two `ensureDiagnosisControl` calls for the same (certificate_id, certificate_hash, contract_version) return the SAME controlIntentId | `d5-diagnosis-persistence.test.mjs` | `D5 persistence: one control per target` | persistence |
| C4 | I7 | same content under new execution reuses report | resubmitting the same content_hash under a different execution_id returns the existing accepted report (no duplicate) | `d5-diagnosis-persistence.test.mjs` | `D5 persistence: same content reuses report` | persistence |
| C5 | I7 | corrected content creates new report | a different content_hash under the same control creates a NEW report row | `d5-diagnosis-persistence.test.mjs` | `D5 persistence: corrected content new report` | persistence |
| C6 | §14 | rejected report durable | a rejected_by_kernel report row + its validation_errors survive | `d5-diagnosis-persistence.test.mjs` | `D5 persistence: rejected report durable` | persistence |
| C7 | I6 | accepted report immutable | no repository API path accepts an UPDATE on an accepted report's payload/status | `d5-diagnosis-persistence.test.mjs` | `D5 persistence: accepted report has no mutation path` | persistence |
| C8 | I3 | certificate hash change ⇒ new target | ensureDiagnosisControl with a different certificate_hash creates a NEW ControlIntent | `d5-diagnosis-persistence.test.mjs` | `D5 persistence: new certificate hash new control` | persistence |
| C9 | I3 | report target mismatch rejected | inserting a report whose target fields disagree with the control's target is rejected | `d5-diagnosis-persistence.test.mjs` | `D5 persistence: report target mismatch rejected` | persistence |
| C10 | I7 | restart returns same id/hash | re-reading the accepted report for a target returns the same id + content_hash | `d5-diagnosis-persistence.test.mjs` | `D5 persistence: restart same report id/hash` | persistence |
| C11 | I3 | exact target lineage verified atomically | the atomic insert re-verifies the control's target (cert id/hash/input_hash/decision) inside BEGIN IMMEDIATE; a tampered control row aborts | `d5-diagnosis-persistence.test.mjs` | `D5 persistence: atomic insert verifies target lineage` | persistence |
| C12 | I7 | atomic insert rejects co-tamper | payload+hash changed together to agree with each other but not with the validator's recomputation ⇒ rejected inside the tx | `d5-diagnosis-persistence.test.mjs` | `D5 persistence: atomic insert rejects co-tamper` | persistence |

---

## D. Engine tests (§18)

| # | invariant | scenario | expected | file | test name | evidence |
|---|-----------|----------|----------|------|-----------|----------|
| D1 | I1,I2 | D4 GO + diagnosis completed | top-level outcome stays `go`, authority `discovery_settlement_policy`; diagnosis.status `completed`, authority `advisory_diagnosis` | `tests/saga3/d5-diagnosis-engine.test.mjs` | `D5 engine: GO + diagnosis keeps outcome go` | engine |
| D2 | I1 | D4 CLARIFY + diagnosis completed | top-level outcome stays `clarify`; causes + information_requests non-empty in the result | `d5-diagnosis-engine.test.mjs` | `D5 engine: CLARIFY keeps outcome and surfaces causes` | engine |
| D3 | I1 | D4 REJECT + diagnosis completed | top-level outcome stays `reject` | `d5-diagnosis-engine.test.mjs` | `D5 engine: REJECT keeps outcome` | engine |
| D4 | I5 | diagnosis worker failure | outcomeAuthority stays `discovery_settlement_policy`, scopeCompleted stays `true`, reason stays `completed`; diagnosis.status `failed` | `d5-diagnosis-engine.test.mjs` | `D5 engine: worker failure does not break D4 result` | engine |
| D5 | I5,§14 | invalid payload | durable `rejected_by_kernel` report; D4 result unchanged | `d5-diagnosis-engine.test.mjs` | `D5 engine: invalid payload durable rejected` | engine |
| D6 | I7 | accepted diagnosis exists on restart | worker NOT respawned (no second executor.start) | `d5-diagnosis-engine.test.mjs` | `D5 engine: accepted no respawn` | engine |
| D7 | I7 | paused diagnosis resumed | worker resumed EXACTLY once (no second ControlIntent) | `d5-diagnosis-engine.test.mjs` | `D5 engine: paused resume once` | engine |
| D8 | §12 | no certificate | diagnosis.status `not_run` | `d5-diagnosis-engine.test.mjs` | `D5 engine: no certificate diagnosis not_run` | engine |
| D9 | I1 | report attempts outcome override | a payload with `new_outcome`/`override_decision` is rejected; outcome unchanged | `d5-diagnosis-engine.test.mjs` | `D5 engine: outcome override attempt rejected` | engine |
| D10 | I1 | finalStage stays discovery | after diagnosis, finalStage === `discovery` | `d5-diagnosis-engine.test.mjs` | `D5 engine: finalStage unchanged` | engine |

---

## E. Service tests (§11)

| # | invariant | scenario | expected | file | test name | evidence |
|---|-----------|----------|----------|------|-----------|----------|
| E1 | I3 | exact certificate load + lineage | diagnose() loads the certificate by id, verifies hash + settlement + snapshot lineage before building the case | `tests/saga3/d5-diagnosis-service.test.mjs` | `D5 service: loads and verifies certificate lineage` | service |
| E2 | I7 | accepted report exists ⇒ reuse | no worker spawned; same reportId/reportHash returned | `d5-diagnosis-service.test.mjs` | `D5 service: accepted report reused` | service |
| E3 | I7 | resumable control ⇒ resume | paused/executing control with no accepted report ⇒ worker resumed, no second control | `d5-diagnosis-service.test.mjs` | `D5 service: resumable control resumed` | service |
| E4 | §14 | invalid report durable rejected | worker submits a report with an invented source ref ⇒ row persisted as rejected_by_kernel, validation_errors non-empty, result status failed | `d5-diagnosis-service.test.mjs` | `D5 service: invalid report durable rejected` | service |
| E5 | I5 | worker throws | service returns status failed; D4 rows untouched | `d5-diagnosis-service.test.mjs` | `D5 service: worker throw isolated` | service |
| E6 | I3 | wrong certificate target in report | worker targets a different certificate_id than the control ⇒ rejected | `d5-diagnosis-service.test.mjs` | `D5 service: wrong target rejected` | service |
| E7 | I6 | service writes ONLY diagnosis tables | after a successful diagnose(), no row in proposals/readiness/settlements/certificates changed (snapshot diff) | `d5-diagnosis-service.test.mjs` | `D5 service: only diagnosis tables written` | service |
| E8 | I1 | service does not mutate top-level fields | diagnose() returns an advisory result; it never returns an object that the engine could mistake for an outcome override | `d5-diagnosis-service.test.mjs` | `D5 service: result shape is advisory only` | service |

---

## F. Architecture boundary tests (§19)

| # | invariant | scenario | expected | file | test name | evidence |
|---|-----------|----------|----------|------|-----------|----------|
| F1 | I6 | no getDb in diagnosis service | source of `discovery-diagnosis-service.ts` has no `getDb` | `tests/saga3/d5-architecture-boundary.test.mjs` | `D5 arch: diagnosis service db-free` | architecture |
| F2 | I6 | no inline SQL in diagnosis service | no CREATE/INSERT/UPDATE/DELETE in service source | `d5-architecture-boundary.test.mjs` | `D5 arch: diagnosis service no inline SQL` | architecture |
| F3 | I6 | no settlement/certificate table UPDATE in D5 | D5 persistence repo has no `UPDATE saga3_discovery_settlements` / `saga3_discovery_outcome_certificates` | `d5-architecture-boundary.test.mjs` | `D5 arch: no settlement/cert mutation` | architecture |
| F4 | I6 | no Proposal mutation from D5 | D5 repo has no `UPDATE/INSERT saga3_proposals` | `d5-architecture-boundary.test.mjs` | `D5 arch: no proposal mutation` | architecture |
| F5 | I6 | no readiness mutation from D5 | D5 repo has no `UPDATE/INSERT saga3_readiness_assessments` | `d5-architecture-boundary.test.mjs` | `D5 arch: no readiness mutation` | architecture |
| F6 | I1 | no stage transition from D5 | diagnosis service + repo have no `episode_transition` / `formalization` | `d5-architecture-boundary.test.mjs` | `D5 arch: no stage transition` | architecture |
| F7 | I6 | no formalization imports | diagnosis service does not import any formalization module | `d5-architecture-boundary.test.mjs` | `D5 arch: no formalization imports` | architecture |
| F8 | I6 | diagnosis worker has no authoritative write tools | the diagnosis WorkIntent allowed_tools contains ONLY read + `diagnosis_submit` (no proposal_submit/readiness_submit/settlement_submit/certificate_submit/stage_transition/task_create) | `d5-architecture-boundary.test.mjs` | `D5 arch: diagnosis worker no write tools` | architecture |
| F9 | I6 | only diagnosis_submit is the new tool | index.ts registers `diagnosis_submit` and does NOT register settlement_submit/certificate_submit | `d5-architecture-boundary.test.mjs` | `D5 arch: only diagnosis tool registered` | architecture |
| F10 | I6 | diagnosis repo does not import application/engine | persistence must not import upward | `d5-architecture-boundary.test.mjs` | `D5 arch: repo no upward import` | architecture |
| F11 | I2 | diagnosis domain has no LM client import | diagnosis case/validator/report modules do not import an LM client | `d5-architecture-boundary.test.mjs` | `D5 arch: domain no LM import` | architecture |

---

## G. Adversarial tests (§21 Stage 5 — separate subagent, read-only)

| # | invariant | attack | expected | file | test name | evidence |
|---|-----------|--------|----------|------|-----------|----------|
| G1 | I3 | target mismatch | feed the service a certificate whose hash was edited after the control was created ⇒ rejected, no report accepted | `tests/saga3/d5-adversarial.test.mjs` | `D5 adv: target mismatch rejected` | adversarial |
| G2 | I4 | invent evidence | worker submits a report citing `$.invented_field` ⇒ durable rejection | `d5-adversarial.test.mjs` | `D5 adv: invented evidence rejected` | adversarial |
| G3 | §8 | break reason coverage | worker omits a certificate reason_code from all causes ⇒ rejected | `d5-adversarial.test.mjs` | `D5 adv: reason coverage broken` | adversarial |
| G4 | I7 | break restart | restart returns a DIFFERENT reportId for the same target ⇒ fail | `d5-adversarial.test.mjs` | `D5 adv: restart idempotent` | adversarial |
| G5 | I7 | break idempotency | two concurrent executions insert two accepted reports for one target ⇒ fail | `d5-adversarial.test.mjs` | `D5 adv: idempotency under concurrency` | adversarial |
| G6 | I1 | outcome override | worker submits `override_decision:'go'` on a clarify certificate ⇒ rejected, outcome unchanged | `d5-adversarial.test.mjs` | `D5 adv: outcome override rejected` | adversarial |
| G7 | I1 | stage transition attempt | worker payload contains `transition_stage:'formalization'` ⇒ rejected | `d5-adversarial.test.mjs` | `D5 adv: stage transition rejected` | adversarial |
| G8 | I7 | accepted report cannot be overwritten | a second accepted-by-kernel row for the same target is impossible (UNIQUE / atomic guard) | `d5-adversarial.test.mjs` | `D5 adv: accepted report immutable` | adversarial |


---

## G2. Independent integrity correction tests

| # | invariant | attack | expected | file | evidence |
|---|---|---|---|---|---|
| I-1 | I3,I4 | frozen case changed while stored hash is unchanged | atomic submit rejects before persistence | `d5-diagnosis-integrity.test.mjs` | integrity |
| I-2 | I3,I4 | case and case hash coherently changed to expand allowlist | independent task/control anchors reject | `d5-diagnosis-integrity.test.mjs` | integrity |
| I-3 | I3,I7 | stored control case drifts from the freshly rebuilt verified certificate bundle | `ensureDiagnosisControl` fails closed | `d5-diagnosis-integrity.test.mjs` | integrity |
| I-4 | I3 | contract, task, authority or lifecycle status drifts | atomic submit rejects | `d5-diagnosis-integrity.test.mjs` | integrity |
| I-5 | I3,I4,I7 | accepted report schema/control/task/target or payload+hash is coherently tampered | accepted-report verifier rejects | `d5-diagnosis-integrity.test.mjs` | integrity |

The persistence/adversarial suites additionally verify that replay re-derives the
verdict from the verified frozen case and rejects a stored row whose verdict,
validation errors or target binding no longer agree.

---

## H. Smoke scenarios (§20 — Stage 6)

| # | invariant | scenario | expected | doc | evidence |
|---|-----------|----------|----------|-----|----------|
| S-A | I1,I2 | full GO pipeline → diagnosis | outcome stays go; diagnosis completed; no blocking causes; residual risks allowed; action `proceed_with_monitoring` | `D5-SMOKE-EVIDENCE.md` | smoke (live LM) |
| S-B | I1 | controlled advisor conditionally_ready + blocking gaps → clarify → diagnosis | outcome stays clarify; all clarify reason codes covered; information_requests non-empty | `D5-SMOKE-EVIDENCE.md` | smoke (live LM) |
| S-C | I1,I3,I7 | coherent worker reject + advisor reject → real D4 REJECT certificate → real D5 diagnosis | accepted advisory report cites contributing passed REJECT conditions; D4 artifacts remain byte-identical; restart returns same report without respawn | `d5-controlled-reject-smoke.test.mjs`, `D5-SMOKE-EVIDENCE.md` | controlled end-to-end |
| S-D | I5 | diagnosis worker returns invented source ref | diagnosis.status failed; report row rejected_by_kernel; validation_errors non-empty; D4 certificate unchanged; outcome unchanged | `D5-SMOKE-EVIDENCE.md` | smoke (controlled) |
| S-E | I7 | restart same epic after accepted diagnosis | same reportId, same reportHash, no second worker execution, outcome unchanged | `D5-SMOKE-EVIDENCE.md` | smoke (controlled) |

---

## Coverage summary

Final executable evidence:

- certificate-bundle verification: 10;
- diagnosis case/policy trace: 10;
- deterministic validator: 23;
- persistence and atomic replay: 13;
- service lifecycle/restart: 8;
- engine integration/isolation: 11;
- adversarial attacks: 10;
- independent integrity correction: 5;
- controlled end-to-end REJECT smoke: 1;
- D5 architecture boundaries: 11 static checks.

The focused runtime suite is **91/91** across 9 files. Architecture boundaries,
TypeScript and the full repository suite are separate gates. The final Node.js
24 repository run is **701 total / 700 pass / 0 fail / 1 todo**.

Smoke evidence classification:

- A and B: live LM;
- C: controlled end-to-end D4 → D5 REJECT;
- D: controlled invalid-evidence attack;
- E: durable restart reuse.

The matrix no longer treats validator A3/B12 as a substitute for Smoke C.
