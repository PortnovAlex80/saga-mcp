# Guardrails

## Rules

These rules apply to ALL AI agents and human developers working in this repository.

- **Never delete test files** without explicit human approval
- **Never modify `docs/specs/*.md`** without also updating `AGENTS.md` if conventions or APIs changed
- **Always run tests** (`cargo test`) before claiming a task is done
- **Never introduce new dependencies** without creating a task in saga-mcp tracker first
- **Never use `unsafe`** without a `// SAFETY:` comment explaining the invariant
- **Never use `expect()` or `unwrap()`** in library/public API code — use `?` or return `Result`
- **Always read the relevant `docs/specs/*.md`** before modifying a subsystem
- **Always create an ADR** when making an architectural decision (library choice, API design, threading model)

## Signs

Append-only log of learned constraints from real bugs. **Never delete a sign.** Only append new ones.

<!-- No signs yet. Add signs when bugs reveal recurring pitfalls. -->
<!-- Format:
### NNN - Short Title
**Symptom:** What goes wrong (observable behavior)
**Cause:** Root cause analysis
**Fix:** How to prevent it (code change, pattern, or invariant)
**Date:** YYYY-MM-DD
**Related:** GUARDRAILS rule #N, ADR-NNN, docs/specs/foo.md
-->

### 001 - extractInputs silent-pass (нарушение NFR-1)
**Symptom:** `extractInputs(parentSessionId)` возвращал `coverage: 1.0, gate_passed: true` при `covered_count: 0, total_count: 113`. Completeness-gate (шлюз полноты) молча пропускал непокрытые реплики — ровно то, что NFR-1 должен предотвращать.
**Cause:** Helper не знает про brief — он только извлекает inputs. Воркер истолковал "extract complete = gate passed", но coverage = covered/total требует знания какие InputRow покрыты brief'ом. Возврат `coverage=1.0` был дефолтной ложью.
**Fix:** `extractInputs` возвращает `coverage: 0, gate_passed: false` (нейтрально). Caller (kickstart skill в main-context) маппит InputRow→brief section и считает coverage/gate_passed. Контракт обновлён в JSDoc: "Do NOT trust gate_passed from this helper alone".
**Date:** 2026-07-03
**Related:** saga-mcp commit `9d2c1a9`, smoke-test REQ-003 v1, kickstart-design.md §6 (completeness-gate)

### 002 - Scaffold-conflict при параллельных greenfield-воркерах
**Symptom:** N воркеров стартуют одновременно на пустом репо. Каждый создаёт свой scaffold (каркас: package.json, tsconfig, App.tsx). Merge (слияние) → `add/add` конфликт на всех общих файлах. REQ-001: 3/4 задач в conflict. REQ-003: 3/11 в conflict.
**Cause:** Без зафиксированного API contract ДО тел, каждый воркер независимо изобретает архитектуру. Git не может auto-merge `add/add` — это не line-level, а архитектурный конфликт.
**Fix:** Pattern B (scaffold-then-parallel): scaffold-задача (priority:critical) первой материализует сигнатуры как stubs (заглушки). Все body-задачи depends_on [scaffold_task_id]. Воркеры пишут под зафиксированный контракт. REQ-002 и REQ-004: **0 конфликтов** при 3 и 9 параллельных телах.
**Date:** 2026-07-03
**Related:** saga-planner skill (Pattern A/B), kickstart-design.md §16, REQ-001 3/4 conflicts vs REQ-004 0/9 conflicts

### 003 - Dispatcher role-filter пропускает review-задачи чужой роли
**Symptom:** saga-analyst вызвал `worker_next(role:'analyst')` ожидая AC-задачу. Получил UC-задачу в `review` (для saga-reviewer). role-фильтр не отличает "role работы" от "role ревью".
**Cause:** `findNextClaimable` отдаёт `review`-задачи раньше `todo`, и role-фильтр по tag `role:analyst` матчит UC-задачу (которая role:analyst по работе, но сейчас в review-статусе для reviewer'а).
**Fix:** (НЕ ЧИНИТЬ ПУТЕМ УГАДЫВАНИЯ — это архитектурный дефект dispatcher'а). Записан как known-issue. Нужен отдельный REQ: status-aware routing в worker_next (todo+role:X отдельно от review+role:reviewer).
**Date:** 2026-07-03
**Related:** smoke-test REQ-003 formalization, dispatcher.ts findNextClaimable, known-issue для REQ-006+

### 004 - saga-planner skill запрещает worker_done → задача зависает
**Symptom:** saga-planner создал dev-задачи, вернул summary, остановился. Его собственная задача осталась в `in_progress` навсегда — skill предписывает "Return a one-line summary, then stop. Do NOT call worker_next — that's the orchestrator's job". Но stop без worker_done = zombie (висящая задача).
**Cause:** Конфликт правил в SKILL.md: "stop, don't call worker_next" vs обязанность закрыть свою задачу через worker_done. Planner — bridge-роль, его работа создать задачи и вернуть summary, но закрыть себя он обязан.
**Fix:** (НЕ ЧИНИТЬ ПУТЕМ УГАДЫВАНИЯ). SKILL.md должен говорить "stop after worker_done", не "stop". Записан как known-issue для saga-orchestrator (REQ-006+).
**Date:** 2026-07-03
**Related:** saga-planner SKILL.md, smoke-test REQ-003 #214 stuck, saga-orchestrator концепция

### 005 - Kickstart = skill в main-context, НЕ subagent
**Symptom:** saga-kickstart запущенный как `Agent(subagent_type:"saga-kickstart")` не имеет Agent и AskUserQuestion tools. Decision-fork не может запустить 3 ассесоров. Verdict+override не может спросить пользователя. F1 degraded=true всегда.
**Cause:** subagent_child в ZCode 3.2.x не получает Agent/AskUserQuestion tools. Discovery по своей природе — диалог с пользователем (AskUser) + 3 ассесора (Agent). Это структурное противоречие.
**Fix:** Kickstart вызывается как **Skill("saga-kickstart") в main-context**, НЕ как subagent. Main-context имеет все tools. Профиль saga-kickstart.md остаётся как документация контракта, но не используется как subagent_type.
**Date:** 2026-07-03
**Related:** kickstart-design.md §13 (обновить), zcode-subagents-howto.md, smoke-test REQ-003 v1 (failed) vs v2 (passed)

### 006 - AC coverage ≠ AC satisfaction (implements не проверяет содержательно)
**Symptom:** `artifact_coverage(link_type:'implements')` показал 0 gaps — все AC связаны с dev-задачами. Но это **структурная** проверка (есть ли trace), не **содержательная** (удовлетворяет ли код конкретному Given/When/Then из AC). Reviewer APPROVE'нул задачу по "тесты green", но никто не сверял, что тесты **реально** утверждают то, что AC требует. Числа AC-1 (100000@12%→112682.50) были проверены только вручную, после факта, оркестратором — не workflow.
**Cause:** `implements` link_type означает "эта задача реализует этот AC" — но не "эта задача **проверена** против этого AC". Нет gate'а, который берёт AC.Given/When/Then, находит соответствующий test-assertion (через `verified_by`), запускает его и сверяет результат. Worker пишет тесты сам → может написать тесты про что-то другое, и reviewer видит "green" не зная покрывают ли они AC.
**Fix:** Использовать `verified_by` link_type (уже в enum, не использовался): AC ──verified_by──▶ конкретный test case. Перед merge (или в INTEGRATE) — прогон: для каждого AC найти verified_by test, запустить, сверить assertion. Это **содержательный AC-gate**, не структурный coverage. Пока не реализовано — reviewer должен вручную сверять "этот тест утверждает то, что AC требует", не просто "тесты green".
**Date:** 2026-07-04
**Related:** REQ-006 demo, artifact_coverage (implements vs verified_by), AC-template (DoD "Способ проверки")

### 007 - Fresh schema supports `brief`, migrated schema rejects it
**Symptom:** Discovery creates an accepted document, but fast-track cannot route it to a dev task. The row is stored as `type='decision'`, has no repository binding and no trace to kanban work.
**Cause:** `SCHEMA_SQL` added `brief/theme`, but existing SQLite databases retained the old `artifacts.type` CHECK constraint. Additive columns do not update CHECK constraints, so agents worked around the rejected `brief` type with `decision`; `routeFastTrack` correctly rejected that substitute.
**Fix:** Rebuild the artifacts table when its DDL lacks `brief`, preserving IDs, hashes, repository bindings and foreign keys; run `foreign_key_check`. Fast-track routing is typed, repository-scoped and idempotent per brief revision.
**Date:** 2026-07-05
**Related:** REQ-003-rangefinder artifact #347, task #376, ADR-004

### 008 - CGAD legitimacy-wash (ADR-005 descriptive mapping misread as implementation)
**Symptom:** A README, SKILL.md, ADR, tracker comment, or external communication claims saga "implements CGAD", "has a Constitution", "uses Frozen Contract Snapshots", "enforces guards with Trusted Providers", "runs a Workflow Ledger", or "computes RiskClass." Reviewers, onboarding users, or downstream REQ episodes believe formal CGAD guarantees exist and proceed against invariants that are actually informal.
**Cause:** ADR-005 adopts CGAD v2 as saga's target-state reference and maps saga entities to CGAD concepts for evolution planning. The mapping is **descriptive** (intent), not **implementive** (guarantee). Calling saga's `verified_by` "the CGAD Evidence Bundle", `activity_log` "the Workflow Ledger", GUARDRAILS "the Constitution", or `tasks.priority` "RiskClass" without qualification implies the formal CGAD machinery is in place. As of ADR-005 it is not — gaps #1 (4-valued verdict), #2 (RiskClass computation), #3 (semantic conflict model), #4 (runtime observation store), #5 (constitution versioning — permanently out of scope), #6 (cgad-spec-lint — only v0.1 partial close) remain open per the ADR-005 Roadmap.
**Fix:** Any artifact (ADR, README, SKILL.md, tracker comment, code comment, external doc) that references CGAD MUST distinguish the saga entity (what exists today) from the CGAD concept it maps to (target-state reference). Use "maps to" / "~=" language, never identity. A claim that a formal CGAD guarantee holds requires the corresponding REQ episode in the ADR-005 Roadmap to be `completed` with passing `verification_evidence`. The ADR-005 concept-mapping table is the authoritative source for which mappings are descriptive vs implementive. **Until REQ-008/009/010/011/012 are completed, every CGAD reference in saga is descriptive.**
**Date:** 2026-07-17
**Related:** ADR-005 (saga-as-cgad-lite-evolution), docs/architecture/cgad-v2-spec.md, GUARDRAILS Signs 001-007

### 009 - Bootstrap-honesty after convergence (ADR-007 retrospective)
**Symptom:** After REQ-008/009/010/011/012/013 merged to saga-mcp dev, an agent or doc claims "saga is now fully CGAD-compliant" or "all CGAD gaps closed." The claim is false — only 6 of the original 7 gaps are closed (gap #5 Constitution is permanently out of scope per ADR-005), and the cgad-spec-lint covers 12 of CGAD's 25 forbidden constructs.
**Cause:** ADR-007 retrospectively records what shipped. Six REQs landed: 4-valued verdict (REQ-008), RiskClass computation (REQ-009), Semantic Conflict Model v1 (REQ-010), Runtime Observation Store (REQ-011), full cgad-spec-lint v1.0 (REQ-012), Pattern B default + R4 (REQ-013). The Roadmap predicted ~85h; the convergence ran in one extended session with effort concentrated in schema and lint. saga-mcp test suite: 83 → 110 green. But "CGAD-compliant" remains false because (a) the Architecture Graph metamodel (24 nodes / 21 edges) is still descriptive, (b) the Wave Scheduler is still the episode stage machine not a separate component, (c) AgentLease lifecycle is still merge-lock-scoped not its own state machine, (d) cgad-spec-lint covers 12 of 25 forbidden constructs, (e) Constitution versioning is permanently out of scope.
**Fix:** After convergence, the qualified claim is: "saga-mcp implements 6 of 7 CGAD gaps from the ADR-005 Roadmap (gap #5 permanently out of scope). cgad-spec-lint v1.0 covers 12 of 25 CGAD §22 forbidden constructs deterministically. The remaining gaps are catalogued in ADR-007 §'What remains descriptive or out of scope'." Do NOT claim full CGAD compliance. Per Sign 008, every CGAD reference must still qualify what-shipped vs what-is-descriptive.
**Date:** 2026-07-17
**Related:** ADR-007 (cgad-convergence-retrospective), ADR-005, ADR-006, GUARDRAILS Signs 001-008, REQ-008 through REQ-013

### 010 - Log silence is not worker death
**Symptom:** Verification tasks are released and re-dispatched while their Claude CLI processes are still running cargo/vitest or reading contracts; late `worker_done` calls fail and the old processes become orphans.
**Cause:** Task status, assignment ownership, log activity, and OS process liveness were treated as one state machine. A short no-output timeout was used as a death detector.
**Fix:** Track each managed process in `worker_executions`, fence mutations with `current_execution_id`, and reconcile local liveness by host/PID/process-birth identity. Logs are progress telemetry only.
**Date:** 2026-07-18
**Related:** ADR-009, `src/worker-executions.ts`, `tracker-view/claude-runner.mjs`

### 011 - Verification ownership must precede evidence
**Symptom:** One verification worker records several neighboring ACs; each passed record creates another `verified_by` edge, so the approval gate later requires unrelated or unreplayable evidence.
**Cause:** Evidence was allowed to create the task-to-AC relationship that the evidence itself was supposed to prove. No canonical target existed.
**Fix:** Every `verification.ac` task stores one accepted `verification_target_artifact_id` from planning provenance. Reject cross-AC records and treat `verified_by` as derived output. Evidence uniqueness includes the fenced execution attempt so a new holder can retry.
**Date:** 2026-07-18
**Related:** ADR-009, `src/tools/lifecycle.ts`, `src/tools/tasks.ts`
