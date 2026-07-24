# D5 — Advisory Discovery Diagnosis: Implementation TODO

> **Roadmap D5, §21.** Staged workflow. Code is forbidden until Stage 0 docs
> exist. The implementer does NOT close the gate (invariant I8); after finishing,
> the line written is "implementation finished; ready for independent review".
>
> **Per-stage rule (§22):** do NOT declare "all gates closed". Each stage gate is
> checked by a real `npm test` run whose pass/fail is recorded here verbatim, not
> by the implementer's assertion.

---

## Stage 0 — analysis only (NO code)

- [x] **0.1** `D5-INVARIANTS.md` written — 8 invariants, I1..I8
- [x] **0.2** `D5-TEST-MATRIX.md` written — A..H groups, ~72 cases
- [x] **0.3** `D5-TODO.md` written (this file)
      status: ✅ done   дата: 2026-07-24   исполнитель: main   коммит: pending (commit 1)
- [ ] **0.4** commit 1: `docs(saga3-d5): define diagnosis invariants and test matrix`
      status: ☐ pending   дата: —   коммит: —

Gate 0: documents exist, zero implementation files touched. ✅

---

## Stage 1 — domain only

**New files:**
- `src/saga3/domain/discovery-diagnosis-case.ts` — `DiscoveryDiagnosisCase`,
  `DiagnosisPolicyCondition`, `buildDiagnosisCase`, `diagnosisCaseHash`.
- `src/saga3/domain/discovery-diagnosis-report.ts` —
  `DiscoveryDiagnosisPayload` (schema `saga3.discovery-diagnosis.v1`), forbidden
  fields list, `hashDiagnosisReport`.
- `src/saga3/domain/discovery-diagnosis-validator.ts` — pure
  `validateDiagnosisReport(case, payload)` enforcing §8.

**New tests:** `tests/saga3/d5-diagnosis-case.test.mjs` (A1–A8),
`tests/saga3/d5-diagnosis-validator.test.mjs` (B1–B15).

- [ ] **1.1** diagnosis case builder + hash (A1–A8)
- [ ] **1.2** diagnosis report schema + forbidden fields + hash
- [ ] **1.3** validator: target binding (B1–B3)
- [ ] **1.4** validator: reason + condition coverage (B5, B9)
- [ ] **1.5** validator: source refs + internal refs + ids (B6, B7, B8, B14, B15)
- [ ] **1.6** validator: outcome consistency (B10–B12)
- [ ] **1.7** validator: confidence + unknown reason code + forbidden fields (B4, B13)
- [ ] **1.8** `npx tsc --noEmit` green
- [ ] **1.9** `node --test tests/saga3/d5-diagnosis-case.test.mjs tests/saga3/d5-diagnosis-validator.test.mjs` green
- [ ] **1.10** commit 2: `feat(saga3-d5): add deterministic diagnosis case and validator`
      status: ☐ pending   дата: —   коммит: —

Gate 1: build green + all pure D5 tests green. ☐

---

## Stage 2 — persistence only

**New files:**
- `src/saga3/persistence/saga3-diagnosis-repository.ts` —
  `ensureSaga3DiagnosisSchema`, ControlIntent + report CRUD,
  `insertReportAtomically` (BEGIN IMMEDIATE), atomic target re-verification.
- **Modified:** `src/schema.ts` (DDL mirror for `saga3_discovery_diagnosis_control_intents`,
  `saga3_discovery_diagnosis_reports`), `src/saga3/persistence/saga3-discovery-runtime-port.ts`
  (+ `ensureDiagnosisControl`, `setDiagnosisControlStatus`,
  `readDiagnosisControlForTarget`, `readAcceptedDiagnosisReport`,
  `readLatestDiagnosisReport`, `insertDiagnosisReportAtomically`,
  `markDiagnosisReportAccepted`/`Rejected`, `readDiagnosisControl`),
  `src/saga3/persistence/sqlite-saga3-discovery-runtime.ts` (impl).

**New tests:** `tests/saga3/d5-diagnosis-persistence.test.mjs` (C1–C12).

- [ ] **2.1** schema.ts DDL + repository `ensureSaga3DiagnosisSchema`
- [ ] **2.2** port method signatures + record types
- [ ] **2.3** SQLite adapter impl (mirror settlement repository style)
- [ ] **2.4** atomic report insert with target-lineage re-verification
- [ ] **2.5** persistence tests C1–C12
- [ ] **2.6** `npx tsc --noEmit` green
- [ ] **2.7** `node --test tests/saga3/d5-diagnosis-persistence.test.mjs` green
- [ ] **2.8** full `npm test` green (D5 + D1–D4 regression)
- [ ] **2.9** commit 3: `feat(saga3-d5): persist diagnosis controls and reports`
      status: ☐ pending   дата: —   коммит: —

Gate 2: all Stage 1 + Stage 2 tests green. ☐

---

## Stage 3 — worker/application

**New files:**
- `src/saga3/application/discovery-diagnosis-service.ts` — the kernel application
  layer (mirrors settlement service style: no getDb, no inline SQL, no
  WorkerExecutorFactory import — it delegates spawning to the readiness-style
  service pattern OR a thin bounded worker; decision in 3.1).
- `src/tools/saga3-diagnosis.ts` — `diagnosis_get` (read-only: immutable case +
  allowed_source_refs + schema + rule) and `diagnosis_submit` (bounded: persist
  submitted → validate → accept/reject durable; one call per execution).

**New domain:** `DISCOVERY_DIAGNOSIS_INTENT_KIND = 'discovery.diagnose'`,
`DIAGNOSE_DISCOVERY_OUTCOME_KIND = 'DiagnoseDiscoveryOutcome'`,
`DISCOVERY_DIAGNOSIS_ASSESSMENT_SCHEMA` (output_schema name), output schema
constant `saga3.discovery-diagnosis.v1`.

**Modified:** `src/index.ts` (register diagnosis handlers), `src/app/composition-root.ts`
(wire diagnosis service).

**New tests:** `tests/saga3/d5-diagnosis-service.test.mjs` (E1–E8).

- [ ] **3.1** diagnosis WorkIntent kind + ControlIntent kind + output schema name
- [ ] **3.2** `ensureDiagnosisControl` lifecycle (open→executing→concluded; paused on interrupt)
- [ ] **3.3** `diagnosis_get` handler — immutable case + allowed refs + rule
- [ ] **3.4** `diagnosis_submit` handler — persist submitted → validate → accept/reject durable
- [ ] **3.5** diagnosis service: certificate load + lineage verify + case build + worker spawn/resume/reuse + accept/reject + advisory result
- [ ] **3.6** durable rejection path (invalid payload stays, validation_errors non-empty)
- [ ] **3.7** service tests E1–E8
- [ ] **3.8** `npx tsc --noEmit` green
- [ ] **3.9** `node --test tests/saga3/d5-diagnosis-service.test.mjs` green
- [ ] **3.10** full `npm test` green
- [ ] **3.11** commit 4: `feat(saga3-d5): add bounded diagnosis worker and service`
      status: ☐ pending   дата: —   коммит: —

Gate 3: invalid report durable; D4 rows unchanged. ☐

---

## Stage 4 — engine/recovery

**Modified:** `src/engines/saga3-discovery-engine.ts` (post-settlement diagnosis
hook; failure isolation; no-respawn on accepted; resume on paused),
`src/application/ports/orchestration-engine.ts` (`diagnosis` section),
`src/app/composition-root.ts` (inject diagnosis service into engine).

**New tests:** `tests/saga3/d5-diagnosis-engine.test.mjs` (D1–D10).

- [ ] **4.1** engine `diagnosis` section in OrchestrationRunResult
- [ ] **4.2** eligibility: only when settlement.status=issued + certificateId/Hash + authority=discovery_settlement_policy
- [ ] **4.3** diagnosis hook after settlement (fresh-run path)
- [ ] **4.4** failure isolation: diagnosis failed ⇒ reason stays completed, scopeCompleted stays true
- [ ] **4.5** accepted no-respawn (recovery path)
- [ ] **4.6** paused resume (recovery path, exactly once)
- [ ] **4.7** engine tests D1–D10
- [ ] **4.8** `npx tsc --noEmit` green
- [ ] **4.9** `node --test tests/saga3/d5-diagnosis-engine.test.mjs` green
- [ ] **4.10** full `npm test` green
- [ ] **4.11** commit 5: `feat(saga3-d5): integrate advisory diagnosis and recovery`
      status: ☐ pending   дата: —   коммит: —

Gate 4: top-level D4 outcome UNCHANGED in every D5 scenario. ☐

---

## Stage 5 — adversarial (separate subagent, read-only)

The adversarial reviewer gets ONLY: `D5-INVARIANTS.md`, the public interfaces
(domain types + port methods + tool definitions), and the DB schema. It does NOT
read the implementer's narrative or the smoke evidence doc.

- [ ] **5.1** launch read-only adversarial subagent (G1–G8)
- [ ] **5.2** implementer fixes found defects (without editing invariant defs)
- [ ] **5.3** commit 6: `test(saga3-d5): cover evidence, authority, restart, and tamper cases`
      status: ☐ pending   дата: —   коммит: —

Gate 5: G1–G8 green; no invariant was redefined to pass. ☐

---

## Stage 6 — smokes (A–E on final code)

- [ ] **6.1** Smoke A — GO explanation (live LM)
- [ ] **6.2** Smoke B — CLARIFY explanation (live LM, controlled advisor gaps)
- [ ] **6.3** Smoke C — REJECT explanation (**controlled override**, not a unit test)
- [ ] **6.4** Smoke D — invalid diagnosis evidence (controlled)
- [ ] **6.5** Smoke E — restart (controlled)
- [ ] **6.6** record results in `D5-SMOKE-EVIDENCE.md` (honest classification)
- [ ] **6.7** commit 7: `docs(saga3-d5): record final diagnosis smoke evidence`
      status: ☐ pending   дата: —   коммит: —

Gate 6: A–E run; each honestly classified (live vs controlled vs deterministic). ☐

---

## Stage 7 — evidence audit (separate auditor subagent)

- [ ] **7.1** launch read-only auditor subagent
- [ ] **7.2** verify every PASS has a command/output/test row; suite counts add up; no live scenario mislabelled live if it was a service call; no unit coverage mislabelled smoke; no partially-completed scenario closes the gate
- [ ] **7.3** implementer amends any unsupported PASS claim
- [ ] **7.4** final state: "implementation finished; ready for independent review"
      status: ☐ pending   дата: —   коммит: —

Gate 7: no unsupported PASS claims. ☐

---

## Exit gate D5 (§24) — checked by the HUMAN reviewer, NOT the implementer

The implementer records evidence for each of the 18 criteria but does NOT mark
them "satisfied". The human reviewer does the final verdict (matching the D4
close-out).

1. [ ] D4 certificate remains sole authoritative outcome
2. [ ] diagnosis exact-bound to certificate id/hash
3. [ ] diagnosis cannot change outcome
4. [ ] diagnosis cannot change stage
5. [ ] all causes/actions cite allowed source refs
6. [ ] all D4 reason codes covered by diagnosis causes
7. [ ] GO diagnosis has no blocking causes
8. [ ] CLARIFY diagnosis produces actionable information requests
9. [ ] REJECT diagnosis preserves reject + describes reconsideration
10. [ ] invalid diagnosis durable-rejected
11. [ ] diagnosis failure does not break completed D4 result
12. [ ] restart returns the same accepted report
13. [ ] paused diagnosis resume creates no second ControlIntent
14. [ ] new certificate creates new diagnosis target
15. [ ] full suite green
16. [ ] smokes A–E run + honestly classified
17. [ ] independent evidence auditor found no unsupported PASS claims
18. [ ] implementer did NOT issue a merge verdict

---

## Constraints carried from D4 (preserve verbatim)

- `settings.cloud.json` — not touched.
- `settings.lmstudio.json` — no defaults, front-filled only.
- `platform_policies` global seed — not deleted.
- **Do NOT commit `nul`.**
- **Do NOT commit `docs/research/CHAIN-WORKING-V2.md`.**
- Do not stop engines/workers unless asked.
- Write questions as text in chat, not via the AskUserQuestion tool.
