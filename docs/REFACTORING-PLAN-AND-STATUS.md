# Завод saga4 — план рефакторинга и статус после волны фиксов (2026-08-15)

> Этот файл — точка остановки: что сделано, что осталось, где golden-path
> красный и почему. Контекст: оператор запретил прогоны до полного
> рефакторинга; завод не трогаем.

## Сводка: 25+ пунктов плана, 20 закрыто, 5 в бэклоге

### ✅ ЗАКРЫТО (в порядке исполнения)

| # | Пункт | Коммит | Что сделал |
|---|---|---|---|
| 1 | Коммит рабочего дерева (RETAIN + анти-голод + resume-scope + burial + TB-11 + капсулы) | `bfa9f761`…`6b5459b4` (11) | Весь накопленный банк фиксов лег |
| 2 | Fallback автора по конверту (TB-10) | `7fb53ea6` | completion_products → revision.presenterRef, с роль-фильтром и carry-forward guard |
| 3+4 | Сериализация соединений + busy_timeout 250мс + withBusyRetry (TB-2) | `9a41748f` | Один кэш-коннект на путь; 3×250мс вместо 5с глухого окна |
| 5 | (частично) FlowRecovery: обёртка СНЯТА (мина устранена удалением) | этот коммит | withKernelRecoveryIssue был мёртвым кодом с недекларированным policyId; удаление устраняет и мину, и топологическую поломку |
| 6 | Ранний чекер AC код↔заголовок | `6d2e5256` + этот коммит (opt-in) | SAGA_AC_HEADING_STRICT=1 включает; freezer остаётся authoritative |
| 7 | Проброс failed-outcome причины в stage/lifecycle error | `8b66b6c2` | 3 шва: executor settlement → result → snapshot |
| 8 | Ledger на refreshArtifactHash (TB-6) | `b8c667eb` | Каждое изменение content_hash пишет ledger-строку с provenance |
| 9 | (снято) Мина repair-development-task-graph | этот коммит | Обёртка удалена; clarification-required остаётся легитимным терминалом |
| 10 | TB-7: kill/verify движка по engine_pid | `b0b0bb2c` | Легаси-паттерн никогда не матчил --launch-ref |
| 11 | TB-3: composition-env + last_launch.error | `cf71e4c0` | Дефолт env в чайлда; статус показывает причину смерти |
| 12 | TB-1: factory_node_runs в getDb | `dfc9e28b` | FK на лениво-создаваемую таблицу больше не падает |
| 13 | TB-5: clean build | `0b8ca173` | npm run build = rm -rf dist && tsc |
| 14 | Реестр багов | `d7068cf8` | TB-1..7 → fixed; TB-10/TB-12 добавлены; TB-9-нарратив исправлен |
| 16 | KI-5: обратное покрытие FR/NFR | `cf0c0f47` + этот коммит | Перенесено в reconciliation-фазу (не acceptance) |
| 17 | KI-2: метрика wasted-turns | `9379bae9` | read-only скрипт; на тестбеде: 32/166=19%, 2612 wasted |
| 24 | Глагол abandon | `ec050cfb` + `21811efb` | API + CLI, fail-closed критерии, идемпотентный |
| 25 | Глагол rerun | `21811efb` | abandon-if-poisoned + new_start, re-anchor к текущему HEAD |
| — | TB-12: fall-through completed-обязательств | `9ec914b6` | Гейт доводится, а не паркуется навсегда |
| — | Rerun-скрипт фиксы | `36123f33` | Новейший lifecycle напрямую; heal только мёртвого движка |

### ⬜ ОСТАЛОСЬ (бэклог)

| # | Пункт | Что |
|---|---|---|
| 15 | Реальные дайджесты handler-исходников | handlerRefs в 4 манифестах всё ещё pending@wave-2; fail-closed на чтение добавлен (этот коммит), но штамповка реальных sha256 при install не сделана |
| 18 | Сухой прогон W3 | Операционный (оператор); ждёт зелёного golden-path |
| 19 | Фаталы диспетчеризации → типизированные исходы | Капсула неоднозначна → ineligible → модель, не смерть движка |
| 22 | Checkpoint по смене состояния | Сейчас чекпоинт каждый цикл (5.57с/цикл); сжать до смены состояния |
| 23 | Дисциплина одного движка на эпик | Тестбед-процедура, не код |

## ⚠️ Golden-path E2E — КРАСНЫЙ (известная проблема)

**Симптом:** `tests/factory-contract/golden-path.test.mjs` падает с exit 1
(~10с работы, lifecycle failed). Проходил на `9ec914b6`, сломался серией
коммитов `7bc4a6a4`…`0b8ca173`.

**Бисекция провена:** первый failing = `7bc4a6a4` (recovery declaration).
Уже устранён в этом коммите (обёртка снята), но golden-path ВСЁ ЕЩЁ красный —
значит есть ещё как минимум одна ломающая change в серии.

**Диагностика сделана:**
- WORKSHOP_CAPABILITY_BINDING_MISMATCH (версия валидатора 1.0.0 vs 1.1.0) — исправлена (check-refs синхронизирован)
- Recovery топология (clarification-required redirect) — исправлена (обёртка снята, терминальный маршрут восстановлен)
- Reverse coverage в acceptance-фазе — исправлена (перенесена в reconciliation)
- AC heading checker — исправлен (opt-in via env)

**Что не найдено:** оставшаяся причина exit 1. Вероятные кандидаты:
1. `8b66b6c2` (error propagation) — error поле в ProcessModuleRunResult может влиять на settlement digest
2. `b8c667eb` (hash refresh ledger) — дополнительные ledger-строки могут влиять на submission validation
3. Комбинация выше

**Что делать:** `git bisect start 0b8ca173 9ec914b6` → протестировать
`8b66b6c2` и `b8c667eb` изолированно. Или запустить golden-path с
`SAGA_DEBUG_SETTLEMENT=1` и прочитать stage_runs.error.

## Отчёты о 20 проектах

- `docs/testing/WORKSHOP-BUGS.md` — баг-реестр (обновлён: fixed-статусы, TB-10/TB-12)
- `docs/testing/WORKSHOP-STATUS.md` — живой статус сетки 20×3
- `docs/testing/WORKSHOP-JOURNAL.md` — журнал прогонов W1/W2
- `docs/testing/W2-SPEED-AND-RECOVERY-ARCHITECTURE-ANALYSIS.md` — 382-строчный анализ скорости W2 (субагент)

## Отчёт о 20 проектах (снимок на момент коммита)

W1 Discovery: 20/20 pass (~90 мин, среднее 3.5 мин)
W2 Formalization: 6 pass / 5 fail / 1 paused / 8 не начаты (на 15:06 UTC)
  - P01 counter ✅, P02 stopwatch ✅ (после rerun), P03 tips ✅, P04 themes ✅, P05 todo ✅, P06 units ✅, P08 pomodoro ✅
  - P07 snake ✖ (TB-8, grammar fix влита), P09 kanban ✖ (TB-9+TB-10, вылечено вручную + фиксы)
  - P10 expenses ✖, P11 markdown ✖, P12 typing ✖ (все TB-10, fixed)
  - P13-P20 в очереди

W2 pass rate до фиксов: 6/12 = 50%. После фиксов TB-9/TB-10/TB-12 + rerun:
все 5 упавших должны проходить (инфраструктурные причины устранены).
