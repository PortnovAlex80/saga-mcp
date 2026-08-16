# Карта поверхностей отказа и доставки причин до воркера (v2)

> Исследование: агент «Research worker feedback loops», 2026-08-16 (v1) +
> глубокая верификация канала/кейсов и разбор stopwatch (v2, та же дата).
> Контекст: слепая петля P01/counter, парк-без-причины P02/stopwatch.
> Статус: исследовательская записка, код не менялся. БД читалась readonly.

## 0. Главное фактическое уточнение по P01 (важно для диагноза)

Проверка по живой БД и логам воркеров **уточняет исходную формулировку дефекта**. Утверждение «воркер получил только рефы» в буквальном виде **не подтверждается**: канал доставки причин до воркера в текущем коде существует и работал 16.08. Ключевые доказательства:

- `tasks.id=71` metadata.recovery_feedback (`factory.production-cell-recovery-feedback.v1`) **содержит декодированные findings**: `issue.findings[].message` = «implementation items 'step-selector' and 'ui-presence' overlap without a dependency order» и «required implementation coverage does not equal the accepted AC scope» (декодирование — `src/infrastructure/workplace/sqlite-production-cell-projection-persistence.ts:683-704`, схема — :730-763).
- В исполнительных каталогах воркеров №2 и №3 физически лежит `recovery-feedback.json` с этими findings: `.factory-testbed/repos/counter/docs/development/projects/3/executions/node-plan-task-graph/workplace-5a9073ec27b26056564debc8/worker-execution_{82b557ef,60a38cd2}/recovery-feedback.json` (запись — `src/process-modules/application/pinned-workspace-materializer.ts:301-305`).
- Логи воркеров доказывают, что они **прочитали** файл: `board-runs/board-3-20564-1786867956259/task-71-worker-65405e41-*.jsonl` и `board-3-20564-1786868212035/task-71-worker-43234645-*.jsonl` (tool_use Read → tool_result с JSON; трекер воркера №3: «Read recovery-feedback.json — found implementation-coverage-gap (zero implementation items)»).
- Три сабмита имеют **разные** дайджесты — воркер итерировал, а не повторял одинаковое.

**Настоящие дефекты P01**: (а) сообщения первых двух отказов были **слишком общими** — `implementation-coverage-gap` статичен и не называет незакрытые AC (дифф вычислим, но не сериализуется — `src/modules/development/domain/development-settlement-policy.ts:455-466`); (б) точная причина «repository 3 does not assign required change scope 'tests/'» появилась **только на третьем отказе** (:361-377) — бюджет 3 закончился ровно в момент, когда фидбек стал точным; (в) оператор на human-gate не увидел причину вообще (см. §4b).

Хронология P01 (из БД): воркер `ba46c509` (15.08 09:23) потерян («OS process is not alive»); рехайры 16.08: `54811931` (08:08) → отказ `cf3f8466` (только generic coverage-gap); `82b557ef` (08:12, читал recovery-feedback.json) → отказ `b0cdde9f` (overlap точный + coverage generic); `60a38cd2` (08:16, читал) → отказ `165d6507` (точная причина 'tests/') → бюджет исчерпан → `kanban_phase=blocked, loop_state=paused, terminal_reason=NULL`, `active_recovery_case_ref=NULL`.

## 0b. Полная цепочка доставки (верифицирована по каждой стрелке)

```text
gate-run-driver.ts:210-247      CheckReceipt(outcome, evidence_refs[base64-diag])
  → factory_check_receipts (append-only)
sqlite-production-cell-projection-persistence.ts:594-611
  читает factory_workplace_gate_decision_heads + решение
  (verdict==='repair_required' && repair_target_role===role)
:653-674  читает реценты решения; отбирает failing (outcome!=='passed')
:683-704  ★ ДЕКОДИРОВАНИЕ decodeCheckDiagnostic(base64) → findings[]{code,message,subjectRef}
          (fallback «Check X returned Y», если diagnostic-реф не декодируется
           или провайдер вернул голый 'failed' без evidence — см. §1)
:730-763  → объект factory.production-cell-recovery-feedback.v1
             {attempt, maxAttempts, gateDecision{refs}, issue{reasonCode,summary,
              findings,requiredAcceptance,allowedChanges}, rejectedCandidateSet}
:98-160 (bindProjectedTaskProcessContext) → tasks.metadata.recovery_feedback
          (вызывается в ensureRoleProjection на каждом requeue→queued reconcile —
           production-cell-node-executor.ts:522-533)
process-execution-workspace.ts:286-301 (recoveryFeedbackFromMetadata)
pinned-workspace-materializer.ts:301-305 → <executionDir>/recovery-feedback.json
claude-runner.mjs:278-297 (buildPrompt) ★ ПРОМПТ
  '⚠️ REPAIR ATTEMPT — YOUR PREVIOUS SUBMISSION WAS REJECTED BY THE GATE'
  + «READ <path> FIRST … It carries issue.findings[]: the EXACT reasons…»
  + протокол-скилл и трекер повторяют «Never rework blind»
```

Файл `.saga-bootstrap.md` в кодовой базе **не существует** — сборка промпта полностью инлайн в `tracker-view/claude-runner.mjs` (`buildPrompt`, ~строки 100-420); десковые файлы — `recovery-feedback.json` / `review-feedback.json`.

## 1. Таблица поверхностей отказа (цех × точка × что видит воркер × вердикт)

| Цех | Точка отказа | Что видит воркер сегодня | Вердикт | Доказательство (file:line) |
|---|---|---|---|---|
| Все | `product_submit`: payload-contract | MCP-ошибка `PRODUCT_PAYLOAD_CONTRACT_REJECTED: <schema>: <gaps через '; '>` — детали едут в самой строке | ✅ | `src/process-modules/application/product-payload-contract.ts:143-175`; живой пример — лог воркера 60a38cd2 |
| Formalization | `worker_done` preflight (5 узлов, policy `required`) | MCP-ошибка с gapSummary + repair-context (Decision Log repr/columns/example ≤4000 симв.) — ремонт в той же сессии; плюс durable-фидбек следующей EXECUTION | ✅ | `src/process-modules/application/wire-submission-validation.ts:45-88`; `node-submission-policy.ts:241-288`; persist: `src/lifecycle/submission-validation-rejections.ts:49-214`; вызов: `src/tools/dispatcher.ts:1943-1984` |
| Discovery / Development | `worker_done` preflight | policy `mode:'none'` — валидация перенесена на cell gate (осознанно) | н/д | `wire-submission-validation.ts:91-128` |
| Development | gate `plan-task-graph` | findings декодированы → recovery-feedback.json → промпт-блок «⚠️ REPAIR ATTEMPT … READ FIRST» + tracker «Rework rules» + skill; НО сообщения частично статичные (без списка недокрытых AC) | ⚠️ (доставка ✅, качество причин ⚠️) | decode+schema: `sqlite-production-cell-projection-persistence.ts:568-764`; файл: `pinned-workspace-materializer.ts:301-305, 499-501`; промпт-блок: `tracker-view/claude-runner.mjs:278-291`; статичное сообщение: `development-settlement-policy.ts:455-466`; точное: `:361-377, 388-398` |
| Development | gate `implement-work-items` (implementation-scope) | основная ветка ричевая (точные пути/scope — `scopeFailure`, :615-625), но часть веток проверки в соседних провайдерах возвращает голый `'failed'` без evidence → fallback-фидбек «Check … returned failed.» | ❌ (2 живых слепых реквизита) | `src/modules/development/application/development-check-providers.ts:655, 660, 665, 682, 686` (verification-провайдер) |
| Discovery | gate proposal/readiness | валидатор вычисляет `errors[]`, но провайдер их **выбрасывает**, возвращает `'failed'` без evidence → воркер видит только «Check discovery.readiness-contract.v1@1.0.0 returned failed.» | ❌ слепой | `src/modules/discovery/application/discovery-check-providers.ts:50-58, 85-93` (голый `'failed'` против `validateDiscoveryProposal(...).valid`); живой пример: task 14, workplace/9 |
| Formalization | gate (все 5) | провайдеры проверяют наличие запечатанного receipt'а preflight-валидации; единственный отказ — «SUBMISSION_VALIDATION_RECEIPT_REQUIRED» с человекочитаемым сообщением | ✅ | `formalization-check-providers.ts:45-60`; `submission-validator-check-provider.ts:131-140` |
| Verification (цех) | local-runnability gate | подробные диагностики (сообщение + стектрейс ≤1200 симв.) | ✅ | `src/infrastructure/verification/local-runnability-check-provider.ts:95-120, 945-960` |
| Все | review-loop (`changes_requested`) | текст ревью → `metadata.managed_review_last_feedback` → `review-feedback.json` на стол + промпт | ✅ | `src/tools/dispatcher.ts:713-726`; `pinned-workspace-materializer.ts:311`; читатель `process-execution-workspace.ts:313-331`; ричевые findings ревьюера в рецентах: `review-verdict-check-provider.ts:167-226` |
| Все | `worker_done` без продукта / не та схема | actionable-ошибки (`PRODUCTION_CELL_PRODUCT_REQUIRED`, `…_SCHEMA_MISMATCH`) | ✅ | `src/tools/dispatcher.ts:2018-2065` |
| Все | гейт `failed` с ownership=upstream → терминал | попыток больше нет (контур continuation); причина только в рецентах | ⚠️ вверх | `gate-run-driver.ts:263-272` |
| Все | гейт `unknown/error` + human-disposition / конфликт repair-target → human_required парк | причина только в рецентах; у парковки reason-поля нет, `recovery_issue_ref=null` для не-repair вердиктов | ❌ | `gate-run-driver.ts:236-238, 280-301` |
| Все | budget exhausted → human gate | `pauseForHuman` **не принимает и не переносит причину**: `terminal_reason=NULL`, `active_recovery_case_ref=NULL`; оператор видит только вердикт | ❌ (для оператора) | `src/application/conveyor-runtime.ts:225-231`; reducer `production-cell-reducer.ts:278-286`; вызов парка: `production-cell-node-executor.ts:479-500` |
| Все | effect failure → `acceptance-effect-repair-required` | workplace → repair_wait; **отдельного фидбека по эффекту нет**: head-декларация уже `accepted` ⇒ сборщик возвращает null ⇒ метаданные `recovery_feedback` ЗАТИРАЮТСЯ (`…persistence.ts:607-611, 127-130`) — перенайм слеп | ❌ (главная дыра, кейс stopwatch) | `production-cell-node-executor.ts:833-837`; reducer `production-cell-reducer.ts:266-276`; причина только в `factory_external_effect_actions.last_error` |
| Все | effect `human_required` → парк | reason в ledger'е, воркплейс/трекер чистые | ❌ | `production-cell-node-executor.ts:838-845`; `git-integration-effect.ts:57-58, 82-88` |
| Все | смерть воркера (`lost`/`spawn_failed`) → следующий воркер | причина пишется в `worker_executions.last_error`, но рехайр-воркер об этом **не узнаёт**; spawn_failed паркует через `pauseForHuman` (reason есть в scope, но не передаётся) | ⚠️ | reason+pause: `claude-worker-executor-factory.ts:366-393`; авто-recovery только `REPOSITORY_DESK_BASE_MISMATCH`: `automatic-pre-spawn-recovery.ts:9-12` |
| Все | NodeExecutionError контракта (cardinality/schema/no-reservation) | бросается выше флоу — воркеру не возвращается | ❌ | `production-cell-node-executor.ts:1471-1508` |
| Delivery | settlement/preflight failures | терминальный сертификат с `rationale`+`settlementError` | ✅ (вверх) | `delivery-installation.ts:641-676` |
| Все | stage/lifecycle error (TB-8) | `extractFailedOutcomeReason` поднимает причину (слайс 500 симв.) в stage_runs/lifecycle_runs | ✅ (вверх) | `generic-flow-executor.ts:1526-1544` |
| Все | оператор: трекер | tracker-view не читает **ни одной** factory-таблицы (0 упоминаний `factory_workplaces/gate_decisions/check_receipts/external_effect_actions`); `blocked_reason` карточки — только зависимости | ❌ | `tracker-view/*.mjs`; `src/infrastructure/projections/sqlite-board-projection-reader.ts:107-118`; проекция статуса без причин: `src/infrastructure/projections/workplace-projector.ts:54-78` |
| Все | оператор: core-view | вердикт-уровень (`lastGate.verdict`, `obligation.lastError`, `terminalReason`) — без декодированных findings | ⚠️ | `core-view/core-snapshot.mjs:320-345` |
| — | `factory_recovery_cases` | легаси-репозиторий, Production Cell его не пишет — **0 строк на весь тестбед** | ❌ | `src/process-modules/persistence/sqlite-recovery-case-repository.ts` |

Статистика по живой БД: 15 failed/error-квитов; 12 с декодированной диагностикой, **3 слепых** (1 discovery.readiness, 2 development.implementation-scope).

## 2. Корневой диагноз

Механизм доставки «последней мили» **уже построен и работает** (4 слоя: инлайн-MCP-ошибка → durable-ледарь отказов → `recovery_feedback` в метаданных → `recovery-feedback.json` + громкий промпт-блок). Дефицит — в **качестве причин на источнике**, в **бюджетном учёте** и в **двух слепых аудиториях** (парк-причина, эффект-причина):

1. **Диагностическая бедность провайдеров.** Часть политик пишет статические сообщения, часть возвращает голый `'failed'`, выбрасывая готовые `errors[]`.
2. **Слепой human-gate.** `pauseForHuman` не несёт причину; трекер показывает только вердикт. Оператор декодирует base64 руками.
3. **Бюджет ест принятые попытки.** `attemptCount` (`production-cell-node-executor.ts:1554-1581`) считает ВСЕ sealed-сеты роли, включая ACCEPTED: effect-repair после успешной 3-й попытки гарантированно «исчерпан» до найма ремонтника (механика кейса stopwatch, §5).
4. **Effect-repair стирает фидбек.** Сборщик фидбека ориентируется на head-гейт-декларацию; на момент effect-repair она `accepted` ⇒ null ⇒ старые метаданные затираются ⇒ перенайм слеп.
5. **Мелочь:** рехайр после `lost` не получает уведомления, что предшественник умер на середине работы.

## 3. Разбор кейса stopwatch (P4, workplace `b62c7ecb…`) — решён

Таймлайн (UTC, из БД; gate-рефы и реценты сверены):

```text
08:43:00  author gate repair_required  (implementation-scope: error)   — субъект 7a720035
08:45:34  author gate repair_required  (implementation-scope: error)   — субъект bed4ef6b
08:51:11  author gate ACCEPTED          (scope: passed)                 — субъект 3b05c4f4
08:53:21  ревьюер (воркер d36ce341) чисто вышел: exit_code=0, last_error=''
08:53:33  final gate ACCEPTED           (review-verdict: passed)
          → reviewer-verdict accepted + effectRequired → effect_pending → git-integration
08:53:43  эффект (external_effect_actions id=2, state=failed):
          PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH: "task 187 submitted
          86e28119… but branch is 793c0704…"
          → outcome repair_required → requireAcceptanceEffectRepair
          → acceptance-effect-repair-required → in_progress/repair_wait/author (rev+1)
08:53:43+ следующий reconcile: attemptCount = 3 sealed author-сета
          (2 rejected + 1 ACCEPTED) ≥ maxAttempts(3, onExhausted='pause')
          → applyGateDecision(human_required, isFinal) → blocked/paused, rev=17
```

Итого: механизм паркинга при PASSED-чеках — **не гейт**, а пара
`production-cell-node-executor.ts:833-837` (эффект) → `:479-500` (бюджет).
Что пишется как причина — **ничего**: typed-причина лежит исключительно в
`factory_external_effect_actions` (id=2: `last_error`,
`execution_result_snapshot` с sourceCommit/branch/sourceTree);
`factory_recovery_cases` — 0 строк; трекер — карточка `blocked` без причины;
`factory_workplaces.updated_at=08:53:43`, `terminal_reason=NULL`,
`active_recovery_case_ref=NULL`. Обязательство `run-effects` (08:53:33) висит
в `pending` c DEFERRED-записями («exact GateDecision has neither an effect
receipt nor a FinalAcceptance yet») — головной боли не добавляет, но подтверждает,
что settlement не дошёл.

Первопричина самого мисматча (git-репа stopwatch):
- `793c070` = «factory: integrate task #184» — интеграционный коммит
  зависимости; все три ветки `saga/task/187/execution/*` стоят на нём;
- `86e2811` = коммит воркера «feat: add module structure tests…» лежит на
  **main** (`(HEAD -> main)`), а не на task-ветке. Эффект требует строгого
  `branchHead === sourceCommit` (`sqlite-production-cell-integration.ts:262-286`)
  → мисматч. Воркер закоммитил работу не в тот ref (слабая модель; отдельный
  дефект-кандидат — проверить, в каком checkout физически работал дескт), но
  отказ типизирован и обязан был уйти в ремонт, а не в слепой human-gейт.

Двойной дефект кейса: бюджет (№3 в §2) +effect-фидбек (№4 в §2).

## 4. Варианты фикса и рекомендация (v2, объединённая)

**Вариант A — минимальный дата-плюмбинг (немедленно).**
1. Обогатить статические сообщения вычислимыми диффами: `development-settlement-policy.ts:455-466` — добавить `missing: [AC-12, AC-14]; extra: [...]` (множества уже построены рядом, :449-454); аналогично `verification-plan-coverage-gap` (:470+).
2. Discovery-провайдеры: вместо `return 'failed'` возвращать `{outcome:'failed', evidenceRefs: errors.map(m => encodeCheckDiagnostic({code:'proposal-contract-invalid', message:m, subjectRef}))}`.
3. Убрать голые `'failed'` в `development-check-providers.ts:655-686` (обёртка `scopeFailure` уже есть).
4. `pauseForHuman` получает опциональный `reason` и пишет его (см. Fix-1 ниже); все колл-сайты передают причину — включая `claude-worker-executor-factory.ts:386-390`, где reason уже есть в scope.

**Вариант B — контрактное расширение `factory.production-cell-recovery-feedback.v1` → v2.**
Денормализованные `reasons: string[]` и `attemptHistory: [{attempt, decisionRef, reasons[]}]` — N-й воркер видит причины **всех** предыдущих попыток. Запись идемпотентна по `decision_key`.

**Вариант C — конверт на старте воркера.**
Раннер/`task_get` возвращают обязательный блок `rejection_reasons` первым пользовательским сообщением (не файл, который модель может не открыть); топ-3 причины инлайнятся в промпт.

**Fix-1 (v2). «Парк всегда с причиной»** — закрывает слепоту оператора системно:
- `ProductionCellCoordinator.applyEvent` уже принимает `actors.activeRecoveryCaseRef` (`production-cell-coordinator.ts:325-361`); колонка `factory_workplaces.active_recovery_case_ref` существует и вечно NULL.
- Новая append-only таблица `factory_workplace_park_reasons(workplace_ref, reason_code, message, evidence_refs JSON, created_at)`; парка-сайты обязаны писать: бюджет (`production-cell-node-executor.ts:482-495`, reason `RECOVERY_BUDGET_EXHAUSTED` + последний repair-вердикт и failing receipts с декодом), эффект (`:838-845`, reason из `result.reason`, evidence: effect action id), гейт-human (`gate-run-driver.ts:236-238` — присваивать `recovery_issue_ref` и reasonCode для human_required, не только repair), spawn_failed (`claude-worker-executor-factory.ts:386-390`).
- Инвариант-тест: «каждый blocked/paused workplace имеет ≥1 park_reason и непустой active_recovery_case_ref» — fail-closed.

**Fix-2 (v2). Effect-repair замыкает петлю фидбека** — кейс stopwatch:
- В `readCurrentProductionCellRecoveryFeedback` (`…persistence.ts:594-611`): если head-декларация `accepted`, но workplace в `repair_wait/queued` автора и существует **failed effect action** для принятого candidate_set_ref (`factory_external_effect_actions`, state='failed') — собрать issue из ledger-причины: findings=[{code:'<PRODUCTION_CELL_*>', message:last_error, evidenceRefs:['external-effect-action:<id>']}], reasonCode `acceptance-effect-repair-required`. Не затирать, а дополнять.
- Сайт `requireAcceptanceEffectRepair` (`production-cell-node-executor.ts:833-837`) проставляет `activeRecoveryCaseRef='effect-recovery:<action-id>'` (параметр координатора уже поддержан).
- Тест: сценарий stopwatch — assertion: `recovery-feedback.json` следующего найма содержит REVIEWED_SOURCE_MISMATCH с обоими SHA.

**Fix-3 (v2). Бюджет не едят принятые попытки:**
- `attemptCount` (`production-cell-node-executor.ts:1554-1581`): считать сеты, чья гейт-декларация `repair_required` для роли (query по subject refs) + terminal-исполнения; ACCEPTED-попытка не расходует бюджет. У эффектов собственный счётчик `execution_attempts` в ledger.
- Тест: после accept+effect-repair attemptCount = числу REJECTED деклараций (2 в stopwatch-сценарии), не 3.

**Fix-4 (v2). Видимость оператору:**
- Минимальный срез нормативного incident card (CONVEYOR-TRANSITION-DIAGNOSTICS §5): read-only JOIN `tasks.workplace_ref → factory_workplaces → park_reasons ∪ gate_decision_heads → failing receipts (decodeCheckDiagnostic) ∪ external_effect_actions.last_error` → tooltip карточки «blocked: <reason_code> — <message>» в tracker-view (board) + включить findings в core-view.
- Общий property-инвариант (ADR-053-стиль): «ни один nonterminal repair_wait/paused workplace не существует без (а) live-фидбека в metadata ИЛИ (б) park_reason-строки».

**Рекомендация: A + Fix-1 + Fix-2 + Fix-3** (A снимает слепоту Discovery и generic-сообщения — главный драйвер P01; Fix-2/3 закрывают stopwatch-класс; Fix-1 закрывает оператора), B и C — следующие по приоритету. Место единой гарантии — **декодирование в момент отказа** (gate decision write / check receipt write), одна точка (`decodeCheckDiagnostic`, `src/process-modules/domain/workplace/check-diagnostic.ts:20-38`): все потребители (recovery_feedback v2, park_reason, трекер) читают готовые строки. Отдельно: «декодировать reasons[] в recovery-контур» уже реализовано — повторять не нужно.

## 5. Эскиз (сигнатуры/поля, без реализации)

```ts
// 1) CheckProvider — без изменений контракта, но запрет голого 'failed':
//    везде { outcome:'failed', evidenceRefs:[encodeCheckDiagnostic({code,message,subjectRef})] }

// 2) development-settlement-policy.ts — дифф в сообщении:
pushIssue(reasons, errors, 'implementation-coverage-gap',
  `required implementation coverage does not equal the accepted AC scope; `
  + `missing: [${missingIds.join(', ') || '—'}]; extra: [${extraIds.join(', ') || '—'}]`);

// 3) conveyor-runtime.ts:
pauseForHuman(input: { workplaceRef: WorkplaceRef; taskId: number;
  reason?: { code: string; message: string; evidenceRefs: string[] } }): UseCaseResult;
// reason → factory_workplace_park_reasons + factory_workplaces.active_recovery_case_ref

// 4) recovery-feedback v2 (аддитивно):
interface ProductionCellRecoveryFeedbackV2 {
  schemaVersion: 'factory.production-cell-recovery-feedback.v2';
  reasons: string[];                    // findings[].message, ≤500 chars/шт
  attemptHistory: Array<{ attempt: number; decisionRef: string; reasons: string[] }>; // ≤ maxAttempts
  effectRepair?: { actionId: number; code: string; message: string }; // Fix-2
  // ...все поля v1 без изменений
}

// 5) конверт раннера (pinned-workspace-materializer → claude-runner buildPrompt):
recoveryFeedback: { present: boolean; path: string | null; reasons: string[] }; // топ-3 инлайнятся в промпт
```

**Безопасность:** leakage исключён — `subjectRef`/messages ограничены собственным candidate-set воркплейса (выборка уже scoped по `workplace_ref`, persistence:594-602); лимиты — 500 симв./finding, ≤20 findings, ≤maxAttempts записей истории; идемпотентность — v2-поля вычисляются из append-only головы gate decision по `decision_key`; метаданные задачи остаются factory-owned.

**Обратная поверхность (воркер → фабрика/оператор):** `worker_executions.last_error` заполняется, boot-revision возвращает `swept[]{reason}` в лог трекера. Но фронтенд причины не показывает: core-view отдаёт только `terminalReason`/`lastGate.verdict`/obligation `lastError` (`core-view/core-snapshot.mjs:320-345`), события — только заголовки вердиктов. Fix-1 + Fix-4 закрывают и этот разрыв.

## 6. Приложение: доказательная база по кейсам (readonly-запросы)

- Гейт-декларации counter: `factory_gate_decisions` run 41 — repair_required 08:12:36 / 08:16:51 / 08:22:37, каждая с recovery_issue_ref; реценты с расшифрованными диагностиками (`implementation-coverage-gap`, `implementation-scope-overlap`, `task-graph-required-scope-missing: … scope 'tests/'`).
- Метаданные task 71: `recovery_feedback` присутствует (attempt=2, findings расшифрованы).
- Дески: `.factory-testbed/repos/counter/docs/development/projects/3/executions/node-plan-task-graph/workplace-5a9073ec…/worker-execution_*/` — recovery-feedback.json в попытках 2 и 3, отсутствует в попытке 1.
- Логи: `~/.zcode/cli/board-runs/board-3-20564-1786868212035/task-71-worker-43234645….jsonl` — воркер читал feedback-файл.
- Stopwatch: `factory_external_effect_actions` id=2 (state=failed, REVIEWED_SOURCE_MISMATCH, оба SHA); `factory_transition_obligations` run-effects pending (DEFERRED); worker_executions задачи 187/208 — все exited/0/без last_error; git-репа: `86e2811` на main, task-ветки `saga/task/187/execution/*` на `793c070` («factory: integrate task #184»).
- `factory_recovery_cases`: 0 строк на весь тестбед.
