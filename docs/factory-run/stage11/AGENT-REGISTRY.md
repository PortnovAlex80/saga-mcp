# АГЕНТ-РЕЕСТР — номера агентов для продолжения после сжатия контекста

**Дата:** 2026-08-19 ~18:10 UTC
**Завод:** stage-11 прогон, карта 22 (websocket), 30/32 done
**Это файл-якорь:** следующий диалог начнётся с пустым контекстом — читай ЭТОТ файл первым.

## 🏛 АРХИТЕКТОРЫ AC-DRIFT (отправлены 2026-08-19 ~19:35 UTC, фон)

Задача: красивое архитектурное закрытие потери требований (docker/TS/Chrome)
на мосту discovery→formalization. Вердикт следователя — в
ARCHITECT-HANDOVER-DRAFT.md, блок «AC-drift forensic verdict».

| № | Угол | Agent ID |
|---|------|----------|
| А1 | Мост контента discovery→formalization (brief_payload, authority-граница копия/ссылка, PRD-валидатор требует реакцию на каждый constraint) | agent_08b50387-d945-43eb-b90c-60cee354b5c6 (перезапуск; первый f67db509 остановился) |
| А2 | Requirement-coverage рэтчет (typed constraint-ID, детерминированная проверка покрытия без LLM в гейте, куда встроить) | agent_9f8c8d8f-2109-49de-a803-0803f68c6fb1 |
| А3 | Конец цепочки (профиль проверки производен из ЗАКАЗА не из продукта, классы требований статика/исполнение/человек, SEAM слой 2) | agent_abc068b3-a5b8-488b-a597-5781d3a37c74 |

Предыдущий следователь (вердикт получен): agent_f19e303e-1f8d-4fb6-90ed-19c543ee4ba2.

## 🔨 ИСПОЛНИТЕЛИ РЕШЕНИЙ (отправлены 2026-08-19 ~20:10 UTC, фон)

| Задача | Ветка | Worktree | Agent ID |
|---|---|---|---|
| AC-drift: три сети (реестр + реакция А1 + структура А2 + стык А3) | repair/ac-drift-remedy | D:/Development/saga-wt/acdrift | agent_a6768c3b-f9a5-4aee-b74b-490bf6c85133 |
| Дезориентация: эксперимент + пининг шима + маркер песочницы | repair/worker-disorientation | D:/Development/saga-wt/disorient | agent_d0bbd93f-df0b-4b98-8fc4-543af0dc0259 |

## 🔍 СЛЕДОВАТЕЛИ ДЕЗОРИЕНТАЦИИ (отправлены 2026-08-19 ~19:55 UTC, фон) — ВСЕ ВЕРНУЛИСЬ

Феномен: воркеры стартуют с ошибкой резолва против главного репо (cwd сессии
= корень saga-mcp вместо продуктового репо), восстанавливаются сами через cd.
Пример: task-36 (readiness-сертификация).

| № | Слой | Agent ID |
|---|------|----------|
| Д1 | Шим/опенкод-бэкенд: кто перебивает cwd раннера | agent_73a28194-6d7d-46e0-bdbd-253480fae64f |
| Д2 | Раннер/пути: где лежит workplace-док и что даёт промпт | agent_1ad2821d-3190-4c89-9142-08e44e04f564 |
| Д3 | Эмпирика: частота/цена/корреляция со смертями по 48 логам | agent_b8fd197e-ca07-454d-bc31-46514c9fcabe |

## ✅ ID ОТПРАВЛЕННЫХ АГЕНТОВ (2026-08-19 ~18:20 UTC)

Все 8 работают в фоне. Продолжить/спросить агента: SendMessage to <Agent ID>.
Отчёты приходят автоматически уведомлением в сессию-оркестратор.

| № | Срез | Ветка | Worktree | Agent ID |
|---|------|-------|----------|----------|
| 1 | Worker prompt delivery | repair/blindsight-worker-prompt | D:/Development/saga-wt/blind1-prompt | agent_dcb492e3-dc7a-4da4-af8b-d9a4180ae6f9 |
| 2 | Gate/check delivery | repair/blindsight-gate-delivery | D:/Development/saga-wt/blind2-gate | agent_b1da60fd-e429-4633-858d-ca46ef36076b |
| 3 | Lifecycle delivery | repair/blindsight-lifecycle | D:/Development/saga-wt/blind3-lifecycle | agent_cca62bda-d7ec-4a72-a9fb-f2ffc6186a31 |
| 4 | Persistence readers | repair/blindsight-persistence | D:/Development/saga-wt/blind4-persistence | agent_46ea082f-e5e6-445c-b726-418db1747f04 |
| 5 | Phantom bridges | repair/blindsight-phantom-bridges | D:/Development/saga-wt/blind5-phantom | agent_9fb345ad-7a35-4eb5-a6ca-17d47b731950 |
| 6 | SEAM слой 2 (integration-verify) | repair/blindsight-integration-verify | D:/Development/saga-wt/blind6-seam2 | agent_3faa2102-ac31-4da6-8b12-b617bcb0ee72 |
| 7 | Worker names (WORKER-NAMES-DESIGN) | repair/worker-names | D:/Development/saga-wt/names | agent_fd68c9e3-b9c9-42e5-bb77-bbc0a2c4e576 |
| 8 | SEAM слой 3 (reconciliation + previous-attempt) | repair/blindsight-reconciliation | D:/Development/saga-wt/blind8-seam3 | agent_611c0549-635a-45d8-afb1-3408490e1d8b |

Разделение ответственности (вбито в промпты, чтобы не дублировали):
- previous-attempt.patch — ТОЛЬКО №8; ревью-фидбек в промпте — №1
- F1/F2 lifecycle (ревьюер/автор история) — №1 и №2; №3 делает только F3–F7
- epoch last_diagnosis — №3 (reader + использование); №4 его НЕ трогает
- ретро-читатели receipts/attempts/events — №4; routing причин capsule — №4

## ЗАДАЧИ НА РЕАЛИЗАЦИЮ (8 субагентов, по одному на каждый)

Каждый агент работает в ИЗОЛИРОВАННОМ WORKTREE, RED-first тесты,
полная архитектурная дисциплина, НИКАКИХ дешёвых фиксов.

### АГЕНТ-1: Доставка слепоты в worker prompt (HIGH)
**Файл:** PREVENTIVE-HUNT.md → "Worker/Tool слой" (найдки 1-3)
**Что делать:**
1. Review-фидбек громко в промпте — зеркалировать ⚠️⚠️⚠️ блок gate-фидбека
   для review-фидбека (path + "read first" + inline text)
2. Глубина истории > 1 раунда — materialize feedback-history.json из
   factory_submission_validation_rejections + comments
3. Смерти карточки в промпте — SELECT worker_executions WHERE state IN
   ('lost','spawn_failed') + inline "prior attempts: N, last failure: X"
4. Previous-attempt.patch на desk (REPAIR-CODE-PRESERVATION дизайн)
**Точки:** claude-runner.mjs buildPrompt, pinned-workspace-materializer.ts,
repository-desk-provisioner.ts
**Ветка:** repair/blindsight-worker-prompt

### АГЕНТ-2: Доставка слепоты в gate/check providers (HIGH)
**Файл:** PREVENTIVE-HUNT.md → "Authority/Gate слой" C1+C1a+C6
**Что делать:**
1. Передать finding-chain tail через candidateSnapshot (gate-run-driver.ts:158)
   — НЕ пустой объект, а trajectory данные
2. Recovery-feedback sheet с trajectory label (converging/spinning/churning)
3. Ревьюер видит номер раунда + прошлые вердикты
4. Стабильные коды для reviewer findings (не ordinal review-finding-N)
**Точки:** gate-run-driver.ts, production-cell-projection-persistence.ts,
review-verdict-check-provider.ts
**Ветка:** repair/blindsight-gate-delivery

### АГЕНТ-3: Доставка слепоты в lifecycle/obligations (HIGH)
**Файл:** PREVENTIVE-HUNT.md → "Lifecycle слой" F1-F5
**Что делать:**
1. Obligation redrive ветвится по lastReasonKey (deterministic → human park)
2. Anti-cycle budget seed от durable attempt sum
3. Resume видит failed NodeRuns между checkpoint и crash
4. Epoch last_diagnosis доставляется в ROLLOVER лог
5. Burial abandon несёт lifecycle error
**Точки:** transition-obligation-reconciler.ts, lifecycle-orchestrator.ts,
generic-flow-executor.ts, engine-start-lifecycle-burial.ts
**Ветка:** repair/blindsight-lifecycle

### АГЕНТ-4: Оживление мёртвых readers + persistence fixes (HIGH)
**Файл:** PREVENTIVE-HUNT.md → "Persistence слой" F1-F6
**Что делать:**
1. readEffectAttempts — вызвать в pending branch (escalate to human_required)
2. Effect events pattern detection (identical error K times → typed block)
3. last_diagnosis читать в readRecoveryEpochBaseline
4. Capsule invalidation reasons — не boolean, а typed routing
5. Drift event append (не overwrite, а history)
6. Мёртвые таблицы lifecycle_events/episode_workflows — либо удалить, либо
   начать читать
**Точки:** sqlite-cell-final-acceptance.ts, sqlite-external-effect-ledger.ts,
sqlite-recovery-case-repository.ts, artifacts.ts (drift)
**Ветка:** repair/blindsight-persistence

### АГЕНТ-5: Phantom contracts — скиллы обещают то чего нет (HIGH)
**Файл:** PREVENTIVE-HUNT.md → "Cross-Layer" X2
**Что делать:**
1. Реализовать RECOVERY: парсер (comment_add → task metadata attempt_history)
2. Заполнить metadata.previous_failures из evidence/receipts
3. Либо реализовать ВСЕ обещанные мосты, либо ЧЕСТНО удалить ссылки из скиллов
4. Скиллы: saga-verifier, saga-code-reviewer, saga-perf-tuner,
   saga-type-fixer, saga-diagnostician, saga-retrospective
**Точки:** skills/*/SKILL.md, src/tools/dispatcher.ts (comment_add handler),
worker metadata assembly
**Ветка:** repair/blindsight-phantom-bridges

### АГЕНТ-6: Интеграционная верификация — SEAM-ARCHITECT слой 2 (MED-HIGH)
**Файл:** SEAM-ARCHITECT-DESIGN.md → "Слой 2"
**Что делать:**
1. Расширить certify-product-readiness до полной integration-верификации:
   npm install + npm test + served probe + docker compose (если объявлен)
2. Выход — типизированные repair-issues с точной локализацией
3. Routing repair-issues обратно в производящие задачи (владеющая ячейка)
4. Settlement видит failed evidence (не только passed) — enrich rationale
**Точки:** local-runnability-check-provider.ts, development-settlement-policy.ts,
sqlite-development-settlement-state.ts
**Ветка:** repair/blindsight-integration-verify

### АГЕНТ-7: Worker display names ( Beautification)
**Файл:** WORKER-NAMES-DESIGN.md
**Что делать:**
1. display_name TEXT на worker_executions (claim-time stamping)
2. 28 имён в 4 пулах по цехам (Beacon/Forge/Quill...)
3. UUID остаётся authority; имя для чтения
4. Промпт воркера: "You are Forge, a single-use Saga CLI worker"
5. Heartbeat: worker=Forge
**Точки:** schema.ts, worker-executions.ts, work-assignment-core.ts,
NEW worker-names.ts, claude-runner.mjs, board-render.mjs, core-view
**Ветка:** repair/worker-names

### АГЕНТ-8: Reconciliation-ремонт — SEAM-ARCHITECT слой 3 (DEFERRED→NOW)
**Файл:** SEAM-ARCHITECT-DESIGN.md → "Слой 3" + REPAIR-CODE-PRESERVATION
**Что делать:**
1. previous-attempt.patch на desk (git diff от предыдущей попытки)
2. Для безхозных швов — reconciliation-паттерн (ограниченные записи +
   типизированный отчёт repairs[]/remaining_gaps[]/rationale)
3. Independent reviewer + gate для reconciliation-записей
4. Кэп: reconciliation не заменяет re-plan, а дополняет для локальных швов
**Точки:** repository-desk-provisioner.ts, process-execution-workspace.ts,
NEW reconciliation-desk.ts
**Ветка:** repair/blindsight-reconciliation

## ОБЩИЕ ПРАВИЛА ДЛЯ ВСЕХ АГЕНТОВ

1. **Изолированный worktree** — НИКОГДА не трогать главный checkout
2. **RED-first** — падающий тест ДО фикса, verbatim сообщение в коммит
3. **Никаких дешёвых фиксов** — архитектурная дисциплина:
   - Правильные типы (не stringly-typed)
   - Append-only (не overwrite)
   - Fail-closed (не silent fallback)
   - Delivery to point of decision (не "fetchable via task_get")
4. **Наблюдательность** — журнал остаётся observation-only (ничего не читает его обратно)
5. **Один коммит на единицу работы** — push branch, НЕ merge
6. **Регрессия** — process-modules 1098+/0, architecture 329+/0 после изменений
7. **Контекст** — прочитать PREVENTIVE-HUNT.md + соответствующий дизайн-документ

## СОСТОЯНИЕ ЗАВОДА НА МОМЕНТ ЗАПИСИ

- Прогон stage-11: websocket #22 пишется, 30/32 done
- Lifecycle: solution-development running (после паузы)
- 14 финальных принятия, 40 гейтов, 18 эффектов
- Ждем: #22 → #15 (автотест) → freeze → verification → readiness → терминал
- На терминале: снапшот + harvest + отчёт + merge held веток

## ВЕТКИ НА ТЕРМИНАЛЕ ЗАВОДА (держим до конца прогона)

| Ветка | Коммитов | Почему держим |
|---|---|---|
| es1-loop-detector | 1 | Шим = per-worker spawn |
| provider-retry | 2 | Шим = per-worker spawn |
| snapshot-test-mvp | 3 | Тест прошёл, готов к влить |

## ВЛИТО В SAGA4 (что уже работает)

9 веток влито: b004, ep1, x65, c145, rs, finding-trajectory,
graceful-drain-pause, replan-cycle, + документация оператора

## КРИТИЧЕСКИЕ ФАЙЛЫ

- БД: .factory-sandboxes/stage11-db/factory.sqlite
- Журнал: .factory-sandboxes/stage11-db/factory-run-journal.jsonl
- Статус: .factory-sandboxes/stage11-logs/status.mjs
- Реестр находок: docs/factory-run/stage11/PREVENTIVE-HUNT.md
- Бриф-10: docs/handoff/STAGE-10-AGENT-BRIEF.md
- Бриф-11: docs/handoff/STAGE-11-AGENT-BRIEF.md
- Отчёт-подготовка: docs/factory-run/stage11/FINAL-REPORT-PREP.md
- Ордер: docs/factory-run/stage10/ORDER.md
- Баг-база: docs/factory-run/stage10/BUG-DATABASE.json
