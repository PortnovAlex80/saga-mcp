# Saga-mcp — Критерии приёмки системы (верхний уровень)

> Документ описывает, **как должна работать система**, её ключевые идеи и принципы.
> Это не тест-план и не спека реализации — это критерии приёмки: по ним можно
> сказать «система работает» или «система не работает».
>
> Уровень: верхний. Без деталей реализации. Для каждой группы — что должно быть
> правдой, чтобы система считалась принятой.

---

## 0. Декларация цели

**Saga — это LLM-worker production system.** Она превращает идею продукта в
реализованный, проверенный и доставленный продукт через управляемую цепочку
языковых моделей (LM), где каждая модель делает только то, что не может делать
машина.

Фундаментальный принцип (из `ARCHITECTURE.md`, CGAD):

> **Недопустимое действие невозможно провести как допустимый переход.**
> Governance, а не трекер. Механизмами, а не дисциплиной.

Два непреложных правила:

1. **Process Module определяет содержание работы. Runtime определяет физику исполнения.** (`docs/saga3/process-modules/ARCHITECTURE.md`)
2. **Machine-known data must be machine-filled. LLM produces only irreducibly semantic data.** Модель не заполняет то, что машина знает лучше (ID, хэши, статусы, порядок шагов).

---

## 1. Жизненный цикл продукта (Lifecycle)

### Что должно быть правдой

Система проводит продукт через исполняемый lifecycle:

```
Discovery → Formalization → Development → Delivery
```

- **Discovery** превращает идею/гипотезу в авторитетный discovery certificate
  (outcome: go / clarify / reject / defer / inconclusive / failed).
- **Formalization** превращает одобренное намерение в замороженный,
  трассируемый solution contract (PRD → FR/NFR/RULE → UC → AC → Reconcile →
  SRS).
- **Development** превращает contract в проверенный integration candidate.
- **Delivery** публикует candidate через controlled release.

### Критерии приёмки

| # | Критерий | Как проверить |
|---|---|---|
| L1 | Полный lifecycle (4 стадии) доходит до терминала `released` с реальной моделью | Model-driven прогон через `orchestrate-cli` |
| L2 | Каждая стадия передаёт immutable handoff следующей (frozen output envelope + exact lineage) | Проверить `output_hash` / `content_hash` consistency между stage runs |
| L3 | Lifecycle routing чисто декларативный (outcomeRoutes таблица), без executable resolvers | Нет `routeResolver` в lifecycle definition |
| L4 | Повторный запуск с тем же idempotency key = replay (0 повторных executions) | Replay test |

---

## 2. Process Module как единый delivery-пакет

### Что должно быть правдой

Каждый модуль (Discovery, Formalization, Development, Delivery) — это
**единая, versioned, hash-pinned поставка**: flow definition, node protocols,
skills, templates, checklists, MCP tool semantics, guards, kernel handlers —
всё в одном пакете.

- Пакет имеет `packageDigest` (content address).
- Каждый ProcessRun **пинится** к конкретной installation (`installation_id` +
  `package_digest`).
- Редактирование любого shipped resource (skill, template) без bumping version
  → новый digest → drift наблюдаем.

### Критерии приёмки

| # | Критерий | Как проверить |
|---|---|---|
| M1 | Все 4 production модуля устанавливаются через `installPackage` с реальным `packageDigest` | `SELECT package_digest FROM saga3_process_runs` ≠ null |
| M2 | Новый Process Module Package ставится без правок Runtime/runner/catalog | Extensibility proof (как WAVE10 synthetic modules) |
| M3 | Resources (skills/templates/checklists) читаются из pinned installation store, не из workspace tree | Запуск с workspace ≠ корень репо |
| M4 | Pinned bytes верифицируются (digest check) при каждом чтении | Tamper test — изменить byte в store → spawn fails |

---

## 3. Атака на слабые модели (Weak-Model Defense)

### Принцип

Слабая LM (qwen3.6-27b, GLM-4.7 и подобные) делает плохо:
- точные идентификаторы (ID, хэши, schema versions);
- статус и порядок шагов;
- выбор инструментов;
- удержание контекста между tool-call'ами;
- self-correction по ошибке;
- соблюдение инструкций без enforcement.

Система компенсирует каждую слабость **механически** — каждый механизм
существует в двух слоях: **prompt (advisory) + runtime/gateway (authoritative)**.
Один prompt никогда не достаточен.

### Линии защиты (defense in depth)

| Слой | Что | Какую слабость компенсирует |
|---|---|---|
| **1. Inline skills** | Protocol skill + semantic skill встраиваются прямо в prompt (не «Read skill file») | Слабые модели skip'ают Read |
| **2. Machine-filled bindings** | `intent_id`, `task_id`, `execution_id` вписываются в templates автоматически | Модель не помнит точные ID |
| **3. Materialized MCP calls** | Готовый JSON-call-file с заполненными machine-полями; модель редактирует только semantic-поля | Модель не строит call из памяти |
| **4. Checklists** | Pre-submit checklist перед каждым MCP-write; модель читает call-file обратно | Модель пропускает шаги |
| **5. Frozen authority + gateway** | `allowedTools` замораживается при claim; gateway deny = terminal (handler не запустится) | Модель расширяет полномочия |
| **6. ActionableToolError** | Ошибка = expected-shape + source + resume-step + retry-permission; не тупик | Модель не self-correct'ит |
| **7. Read-only tracker** | Tracker = deterministic projection из ProtocolRun-state; модель не может редактировать статус | Модель hallucinate'ит checkbox-status |
| **8. Agent assistance hook** | PostToolUse hook ре-инжектит bounded ориентацию после каждого tool-call; dedup + budgets | Модель забывает «где я» |
| **9. Required-evidence gate** | Шаг физически нельзя завершить без required evidence | Модель проскакивает шаги |
| **10. Bounded recovery** | recovery-feedback.json + requiredTools + retry budget; exhaustion → escalate | Модель зацикливается |

### Критерии приёмки

| # | Критерий | Как проверить |
|---|---|---|
| W1 | LM-узел исполняется как bounded Execution Cell: WorkIntent + authority + skill + workspace + materialized calls + checklist + validation | `hardening-weak-model.test.mjs` green |
| W2 | Модель физически не может вызвать `worker_done` до completion step | Required-evidence gate rejects early `worker_done` |
| W3 | Модель не видит инструменты, которые не имеет права вызывать | `--allowedTools` в spawn содержит только frozen authority |
| W4 | ActionableToolError содержит source + expected-shape + resume-step | Error format assertion |
| W5 | Tracker — read-only projection; модель не редактирует статус символов | Tracker render из ProtocolRun, не из Markdown-edit |
| W6 | Recovery получает `requiredTools` (расширение authority только на repair attempt) | UC trace repair не deadlocks на `trace_delete` |

---

## 4. Discovery Pack vs Runtime Core (граница)

### Принцип

> **Discovery определяет содержание работы. Runtime определяет физику её исполнения.**

Runtime Core (универсальный, агностик к модулям):
- WorkIntent lifecycle, task projection, execution fencing
- Worker spawn, skill injection, tracker provisioning
- Materialized MCP calls, machine-filled parameters
- Retry budgeting, pause/resume, recovery
- Artifact storage, output validation, node routing
- Generic certificate infrastructure

Discovery Pack (доменный, специфичный):
- Proposal semantics, discovery document template
- Readiness criteria, settlement policy
- Discovery outcome vocabulary, certificate schema
- Diagnosis vocabulary
- Специфичные skill-инструкции, MCP call templates, checklists
- Provenance rules

### Критерии приёмки

| # | Критерий | Как проверить |
|---|---|---|
| D1 | Runtime core (`application/`, `domain/`) НЕ импортирует concrete module implementations | `dependency-direction.test.mjs` green |
| D2 | Modules НЕ импортируют другие module implementations | То же |
| D3 | Runtime работает с любым Process Module как данными (не знает слово «discovery») | Universal ProcessModuleRuntime proof |

---

## 5. Durable Execution & Integrity

### Принцип

> **Только assigned worker создаёт семантический output.** Контроллер/политики/
> ledgers/guards ничего не создают — только координируют/авторизуют/
> наблюдают/верифицируют.

Каждое решение контроллера, требующее работы, материализуется как executable
WorkIntent. WorkIntent — single-use: клеймится CAS'ом (open→executing),
завершается (concluded) или паузится (paused).

### Критерии приёмки

| # | Критерий | Как проверить |
|---|---|---|
| I1 | Restart после simulated process death resume'ит до того же терминала без manual repair | `hardening-execution-crash.test.mjs` green |
| I2 | Recovery использует durable receipts/products, не latest-execution/metadata fallback | Нет `restoreFrame()` в hot path |
| I3 | Exact candidate acceptance: кандидат принимается только по точному content-hash | `exact-candidate-acceptance.test.mjs` green |
| I4 | Co-tamper detection: settlement input не может быть подменён между assess и settle | `issueCertificateAtomically` WRITE-ONCE |

---

## 6. Многоуровневая проверка (Verification)

### Принцип

> **Verifier генерирует L3 property-тесты ИЗ frozen AC контракта, НЕ из Builder-тестов.**
> (CGAD P7 — anti-self-certification)

Verification — независимая. Builder не может сертифицировать свою же работу.

### Критерии приёмки

| # | Критерий | Как проверить |
|---|---|---|
| V1 | Каждая AC имеет отдельную verification-задачу (не та, что реализовывала) | Task graph: `verification.ac` tasks separate from dev tasks |
| V2 | `implements` (structural coverage) ≠ `verified_by` (содержательная проверка) | Trace edges: `implements` and `verified_by` are distinct link types |
| V3 | Verification evidence recorded как 4-valued verdict (passed/failed/unknown/error) | `verification_record` outcome field |

---

## 7. Композиция и расширяемость

### Принцип

Process Module может быть композиционным: Lifecycle содержит Stage Bindings,
Stage Binding вызывает Process Module, Process Module содержит Flow, Flow
содержит узлы (LM / Kernel / Human / External / другие Process Modules).

Новый модуль или сценарий ставится **без правок Runtime**.

### Критерии приёмки

| # | Критерий | Как проверить |
|---|---|---|
| E1 | Новый synthetic module (LM/External/Human) устанавливается и исполняется без правок core | `extensibility-proof.test.mjs` |
| E2 | Новый Lifecycle Scenario Package устанавливается без правок Runtime или module packages | `hardening-campaign-e2e.test.mjs` |

---

## 8. Операционная готовность

### Критерии приёмки

| # | Критерий | Как проверить |
|---|---|---|
| O1 | `discovery-run.mjs bootstrap` создаёт изолированный sandbox (DB + git workspace + seeds) | Preflight 9/9 green |
| O2 | Real model-driven Discovery run доходит до терминала (go/clarify/reject) | End-to-end прогон с GLM-4.7 |
| O3 | Tracker-view frontend показывает live прогресс (tasks, artifacts, worker activity) | `localhost:4321` visible |
| O4 | Status command даёт snapshot без блокировки run | `discovery-run.mjs status` read-only |

---

## Открытые вопросы (что ещё не доказано)

1. **§18.8 Agent assistance renderer не wired в production** — hook fail-closed
   на `'{}'`. Модель не получает structured guidance между tool-calls. Это
   значит линии защиты 8 (agent assistance) сейчас inactive.
2. **`restoreFrame()` legacy fallback всё ещё в hot path** — recovery может
   использовать stale frame вместо durable receipts (I2 не полностью закрыт).
3. **Нет real model-driven e2e теста в suite** — все e2e тесты используют stub
   executors. Real flow доказывается только ручным прогоном через
   `discovery-run.mjs`.
4. **Protocol skill kind inconsistency** — `saga-process-module-worker-protocol`
   объявлен `kind:'instruction'` в manifest, но profile.protocolSkill ожидает
   его как skill. Pinned resolution fail'ит (найдено при model-driven тесте).

---

## Источники

- `docs/saga3/process-modules/ARCHITECTURE.md` — нормативная архитектура модулей
- `docs/architecture/cgad-v2-spec.md` — CGAD v2 (target-state reference)
- `docs/refactor-management/09-contracts/WAVE1..WAVE13-SPEC.md` — замороженные контракты
- `docs/research/W13-AUDIT.md` — честный аудит exit-gates
- `skills/saga-process-module-worker-protocol/SKILL.md` — контракт execution physics
- `GUARDRAILS.md` — неформальная конституция (Signs 001-008)
- `docs/saga3/process-modules/PROCESS-MODULE-CHECKLIST.md` — gate checklist для модулей
