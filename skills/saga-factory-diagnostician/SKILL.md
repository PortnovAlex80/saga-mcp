---
name: saga-factory-diagnostician
description: "Завод-уровневый диагност runtime-ошибок конвейера saga4 (AUTHORITY_BINDING_INVALID, PACKAGE_PIN_REQUIRED, FLOW_IDENTITY_REQUIRED, LIFECYCLE_*, MANAGED_PRODUCTION_*, WORKPLACE_*). Читает блок логики целиком (ЗАВОД-ЗАПУСК + CONVEYOR-MENTAL-MODEL + 7 каналов БД) ПРЕЖДЕ чем делать выводы. Не патчит кусками — формирует root-cause отчёт по форме журнала запусков. Не путать с saga-diagnostician (T-011 stuck worker) и saga-bug-diagnostician (product code bugs)."
---

# saga-factory-diagnostician — завод-уровневая диагностика конвейера

## Что это и чем НЕ является

Этот скилл диагностирует **runtime-ошибки самого завода saga4** — то есть
нарушения в работе конвейера: lifecycle/process/stage/node runs, workplaces,
work intents, worker executions, gates, managed productions. Он читает
состояние завода по **семи каналам** и формирует root-cause отчёт по форме
журнала запусков.

**Не использовать для:**

- застрявшего воркера на одной задаче (MAX_ATTEMPTS) → `saga-diagnostician` (T-011)
- бага в коде продукта под эпизодом saga → `saga-bug-diagnostician`
- каскада TypeScript-ошибок → `saga-type-fixer`
- продуктовой разработки одной задачи → `saga-worker`

**Признаки завод-уровневой ошибки** (когда этот скилл нужен):

- в `factory_orders.last_error` лежит код вида `*_INVALID`, `*_REQUIRED`,
  `*_MISMATCH`, `*_NOT_FOUND`, `FENCE_*`
- `worker_next` бросает `AUTHORITY_BINDING_INVALID` или подобное
- lifecycle застрял в `paused` дольше policy-grace без прогресса
- workplace завис в `verifying` / `repair_wait` без движения worker execution
- intent и task разошлись по статусам (intent concluded, task todo и т.п.)
- gate не запускается, хотя product persisted

## Железное правило — сначала весь блок логики, потом выводы

> **Никаких точечных патчей до полного разбора.**

Пользователь прямо требует: *«Сначала загрузить в себя весь блок логики где
ошибка, и только потом делать выводы. А не кусками что-то патчить».*

Поэтому порядок строго такой:

1. **Загрузить три документа** (раздел «Блок логики» ниже) — полностью,
   не по диагонали.
2. **Прочитать 7 каналов БД** по проблемному эпизоду — все сразу,
   одним проходом.
3. **Построить timeline** рассинхрона: какое событие в каком канале
   произошло, а в каком — не произошло.
4. **Сверить с инструкцией**: какой переход спецификация предписывает,
   и какой канал его нарушил.
5. **Только после этого** сформулировать root cause и предложить варианты.

Если шаги 1–4 не пройдены — выводов не делать. Вернуться и дочитать.

## Блок логики — три обязательных документа

Перед любым выводом загрузить (Read целиком, не выдержки):

### 1. Инструкция по запуску завода — `ЗАВОД-ЗАПУСК.md` (корень репо)

Даёт операционную модель: что делает каждая кнопка, какие переходы
легитимны, что разрешено и запрещено оператору. Ключевые секции:

- §3 «Кто чем владеет» — LifecycleRun / ProcessRun / Workplace / Task
- §4 «Состояния карточки и Workplace» — kanban × loop_state матрица
- §7 «Когда завод должен продолжать работу» — критерии паузы/resume
- §9 «Наблюдение» — **семь каналов, которые надо различать при диагностике**
- §10 «Безопасность оператора» — что нельзя делать руками

### 2. Ментальная модель конвейера — `docs/architecture/CONVEYOR-MENTAL-MODEL.md`

Даёт доменную модель: какие сущности authorитативны, какие проекции,
кто чем владеет. Ключевые секции:

- §«Two channels» (строки ~780–822) — kanban vs loop_state, crash-MUST-NOT-return-to-todo
- §«Loop transitions» (строки ~955–973) — таблица переходов
  Worker-completed → `running → verifying`, Worker-crashed → `running → repair_wait`
- §«Shift, pass, lease and heartbeat» (~1314–1327) — execution fence правила
- §«Foreman, watchman» (~1329–1366) — dead/escaped/stuck worker матрица
- §«Products and production journal» (~1431–1442) — append-only journal,
  consumer reads by exact ref

### 3. Диагностика переходов — `docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md`

Даёт универсальную грамматику `FactoryOrder → LifecycleRun → StageRun →
ProcessRun → NodeRun → Workplace → WorkerExecution → CandidateSet →
GateRun → Decision → Certificate`. Ключевое: **три слоя с разной
authority** (§2) — domain state / causal journal / telemetry. Ошибка в
одном слое не аннулирует committed decision в другом.

## Семь каналов БД (читать ВСЕ, одним проходом)

БД: `C:/Users/user/.zcode/saga.db` (readonly open). Префикс saga4 — `factory_`.

| # | Канал | Таблицы | Что показывает |
|---|---|---|---|
| 1 | **lifecycle** | `factory_lifecycle_runs` | status, current_stage_id, terminal_status, error, lease |
| 2 | **stage** | `factory_stage_runs` | ordinal, stage_id, attempt, status, process_run_id |
| 3 | **process run** | `factory_process_runs` | module_name, status, local_outcome, authority |
| 4 | **node run** | `factory_node_runs` | node_id, status, **event**, completion, output_ref |
| 5 | **workplace** | `factory_workplaces` | kanban_phase, **loop_state**, next_role, terminal_reason, active_reservation_ref |
| 6 | **task projection** | `tasks` | status, assigned_to, workplace_ref, metadata.work_intent_id |
| 7 | **worker execution** | `worker_executions` | state, phase, pid, lease_expires_at, heartbeat_at, progress_at |

Дополнительные каналы по необходимости:

- **work intent** — `factory_work_intents` (id, kind, status, projected_task_id)
- **managed productions (ledger)** — `factory_managed_artifact_productions`
- **gate** — `factory_gate_runs`, `factory_exact_candidate_acceptance_decisions`
- **recovery** — `factory_recovery_cases`, `factory_recovery_attempts`
- **activity journal** — `activity_log` (entity_type, action, summary, created_at)
- **order** — `factory_orders` (order_ref, state, last_error, updated_at)

## Порядок разбора (чеклист — идти строго по порядку)

### Шаг 0 — Зафиксировать ошибку и scope

- Прочитать `factory_orders.last_error` — определить код ошибки.
- Выделить проблемный order_ref / lifecycle_run_id / epic_id.
- Найти в `src/` точку бросания (grep по коду ошибки).

### Шаг 1 — Загрузить блок логики

Прочитать три документа (см. раздел «Блок логики»). Не пропускать.

### Шаг 2 — Снять слепок 7 каналов

Одним запросом прочитать все 7 таблиц по проблемному эпик/order.
Не выбирать подмножество «что кажется релевантным» — брать всё.

### Шаг 3 — Построить timeline

По `started_at` / `updated_at` / `recorded_at` выстроить хронологию:

- какое событие произошло в каждом канале;
- **где каналы разошлись** (например: intent concluded, а workplace остался
  в `verifying`);
- какой writer записал первый канал, а какой не записал второй.

### Шаг 4 — Сверить со спецификацией

Найти в CONVEYOR-MENTAL-MODEL строку перехода, который **должен был**
сработать. Зафиксировать:

- какой переход предписан;
- какой канал его не выполнил;
- какое правило нарушено (цитата со ссылкой на строку документа).

### Шаг 5 — Root cause (только теперь)

Сформулировать:

- **корневой дефект** (один-два предложения);
- **уровень**: точечный / архитектурный;
- **какой writer правильный, какой отсутствует / рассинхронизирован;
- **варианты устранения** — несколько альтернатив с оценкой риска;
- **какой инструкции это противоречит** (с цитатой).

### Шаг 6 — Отчёт по форме журнала запусков

Запись в `ЖУРНАЛ-ЗАПУСКОВ.md` со структурой:

```
### Run #<N> (order-<ref>) — <ошибка>
- Причина: <root cause>
- Уровень: точечный | архитектурный
- Нарушено: CONVEYOR-MENTAL-MODEL §<ссылка> (цитата)
- Канал-источник: <какой writer записал>
- Канал-жертва: <какой канал не получил переход>
- Варианты устранения: (а)... (б)... (в)...
```

## Категории ошибок — куда смотреть в первую очередь

| Префикс кода | Что проверять в первую очередь |
|---|---|
| `AUTHORITY_BINDING_*` | `factory_work_intents.status` vs `tasks.status` vs `factory_workplaces.loop_state`. Рассинхрон intent/workplace/task. |
| `PACKAGE_PIN_*`, `FLOW_IDENTITY_*` | `resolvePackagePin` / `packageInstallation` wiring в composition-root; moduleRef → digest resolution. |
| `MANAGED_PRODUCTION_FENCE_*` | fence-check (`execution_state` vs `task_status`); ledger producer resolution (`readLatestManagedProductionExecutionIdForNode`). |
| `LIFECYCLE_*` | `factory_lifecycle_runs` lease/status; stage binding; idempotency-key collisions. |
| `WORKPLACE_*`, `RESERVATION_*` | `factory_workplaces` CAS revision; `active_reservation_ref`; workplace_ref serialization. |
| `RECOVERY_*` | `factory_recovery_cases`, `factory_recovery_attempts`; repair_target_role. |
| `*_HASH_MISMATCH`, `*_DRIFT` | content digest drift; package digest; checkpoint integrity. |

## Что КАТЕГОРИЧЕСКИ нельзя делать при разборе

Из §10 «Безопасность оператора» и CGAD P2 («status change, not destruction»):

- удалять `saga.db` при наличии прогресса;
- вручную `DELETE`/`UPDATE` по `accepted artifacts`, hashes, ledger rows;
- переводить task в `done` SQL-командой;
- удалять ProcessRun/StageRun «для разблокировки»;
- убивать worker и сразу назначать второго без fence expiry/release.

Исключение — явное разрешение пользователя на деструктивную операцию.

## Не патчить — формировать вывод

Этот скилл **не пишет код** и не применяет фикс. Его выход —
документированный root cause + варианты устранения. Починка выполняется
отдельной задачей (`saga-worker` / ручной фикс), после того как пользователь
выбрал вариант. Если был сделан snapshot перед разбором — отметить его
в отчёте для возможности отката.

## Когда скилл НЕ нужен

- Ошибка в коде продукта, не в работе конвейера → `saga-bug-diagnostician`.
- Worker крутится на одной задаче MAX_ATTEMPTS → `saga-diagnostician`.
- Нужен просто статус завода без разбора → пульс `/api/heartbeat`,
  не этот скилл.
