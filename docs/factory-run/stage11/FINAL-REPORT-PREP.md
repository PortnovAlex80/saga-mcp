# STAGE-10/11 FINAL REPORT — подготовка (СОХРАНИТЬ ПЕРЕД СЖАТИЕМ КОНТЕКСТА)

**Это буфер контекста. Всё, что нужно для финального отчёта, — здесь.**
Дата: 2026-08-19 ~17:20 UTC. Завод работает (Development, карта 20 renderer).

## 1. ЧТО МЫ ЖДЁМ ОТ ПРОГОНА (бриф-10, отчёт по формату)

### Обязательные разделы отчёта:

1. **Как далеко дошёл завод по стадиям** с принятыми головами на каждой точке
2. **Баг-база по серьёзности** (B-001..B-005 + новые из прогона)
3. **G1/G2 предсказания vs реальность** (см. ниже)
4. **Путь снапшотов**
5. **«Чего не могу объяснить»** (честный раздел)

### G1/G2 предсказания — проверены:

| Предсказание | Статус | Evidence |
|---|---|---|
| G1: heartbeat-комплайнс (воркеры пишут CLAIMED) | ❌ НЕ подтверждён — GLM НЕ писали heartbeat-строки | heartbeat log: только STARTED/CLOSED от runner |
| G2: выход без worker_done | ✅ ПОДТВЕРЖДЁН ×2 | supervision.reaped: 2 инстанса (карта 3 ~10:15, карта 14 ~12:15), оба восстановлены <1с |
| Faked completion | НЕ наблюдался | ни один воркер не подделал worker_done |
| 20-мин транспортный потолок | ✅ ПОДТВЕРЖДЁН ×3 | stage-10: точно 20:00.1; stage-11: 21.4 и 30.0 мин (тишина mid-work) |

### Баг-база (B-001..B-005):

- B-001: смерть воркера на 20:00 — ОБЪЯСНЁН (внешний session ceiling, не репо)
- B-002: лог движка теряется — ИСПРАВЛЕН (ep1 влит)
- B-003: core-view /api/worker/tail — мелочь
- B-004: пост-акцептанс re-dispatch — ИСПРАВЛЕН (b004 влит)
- B-005: REPLAY_CAPTURE_TRACE_NOT_FOUND — ИСПРАВЛЕН (stage-11 task 2)

## 2. ПРОГОН STAGE-11 — ТЕКУЩЕЕ СОСТОЯНИЕ

**Момент:** карта 20 (renderer-2d) пишется. 26/30 done, 36 гейтов,
13 финальных принятия, 15 эффектов, 88 чистых worker_done, 2 реапа.

**Цепочка стадий:**
- Discovery: COMPLETED (2 карты, 2 CFA, ~8 мин)
- Formalization: COMPLETED (11 карт, 5 CFA, ~2.5 часа, 1 repair-loop)
- Development: PAUSED (в фанауте, 7 implementation items + ревьюеры)

**Осталось:** карта 20 (renderer) → 22 (websocket) → 15 (automated-test) → freeze → verification → runnable-local

**Смерти воркеров в этом прогоне:** 2 (оба transport ceiling, оба самовосстановлены <1с)

## 3. STAGE-11 БРИФ — ЗАДАЧИ 1-6 (всё выполнено)

| Задача | Коммит | Статус |
|---|---|---|
| TASK 1: RED тест | 9c3c9f38 | ✅ |
| TASK 2: контент-идентичность | 3681f32a | ✅ |
| TASK 3+4: отчёты | 66891edf | ✅ |
| TASK 5: журнал отказов | 52189f43 | ✅ |
| TASK 6: перезапуск | ЭТО ПРОГОН | 🔄 идёт |

TASK 5 proof: supervision.reaped сработал в живом прогоне ×2 (error.thrown + run.terminal тоже работают).

## 4. ВЛИТО В SAGA4 (полный список)

| Ветка | Коммит | Что |
|---|---|---|
| b004-cluster | ccd862a0 | livelock-клапан + один предикат + C8 + carry-forward |
| ep1-engine-spawn | ad202db6 | detached + лог + штампы + тормоз |
| x65-integration | 8c56d632 | сиблинг-мерж ре-авторизация + branch restore + transient |
| c145-route-freeze | 7280884b | endpoint freeze + limits + guard + C-6 |
| rs-replay-robustness | 8f367b2a | sweep cfa-независимость + reset invalidates + FK + debris |
| finding-trajectory | 19e6002b | convergence-aware budget (оператор) |
| graceful-drain-pause | 6578809f | ⏸ реальная пауза + ▶ unpark |

**Держим до терминала:** es1 (детектор циклов, 1 коммит), provider-retry (2 коммита), snapshot-test-mvp (3 коммита, тест прошёл).
**В работе:** replan-cycle (агент в worktree).

## 5. ДИЗАЙН-ДОКУМЕНТЫ (всё сохранено в git)

- PREVENTIVE-HUNT.md — 8 слоёв, ~90 находок
- SNAPSHOT-TEST-DESIGN.md — ноль-токен ре-ран + error-suite
- FINDING-TRAJECTORY-BUDGET.md — convergence-aware budget
- PAUSE-DESIGN.md — graceful-drain пауза
- PROVIDER-RETRY-DESIGN.md — шим-ретрай на 429/5xx
- SEAM-ARCHITECT-DESIGN.md — 3 архитектора (полировщик vs decomposition)
- REPLAN-CYCLE-DESIGN.md — 5 архитекторов (агентный цикл)
- REPLAN-CYCLE-TZ.md — ТЗ на реализацию

## 6. ПЛАН ДЕЙСТВИЙ НА ТЕРМИНАЛЕ ПРОГОНА

1. **Снапшот первой командой** (любого исхода) — tools/capture-run-snapshot.mjs
2. **Harvest корпуса** — tools/harvest-golden-corpus.mjs
3. **Слить придержатые:** es1 + provider-retry + snapshot-test-mvp
4. **Влить replan-cycle** (когда агент закончит)
5. **Чистка worktree** (12 каталогов)
6. **Полный rebuild** на чистом HEAD
7. **Полная регрессия** одним прогоном (baseline из брифа-11)
8. **Snapshot-test в boundary-манифест** (обязательный регрессионный тест)
9. **Финальный отчёт** (см. формат выше)

## 7. КОНТЕКСТ ИНЦИДЕНТОВ (не забыть в отчёте)

- Инцидент settings.json (12:22): ремонтный агент C-145 написал реальный
  ~/.claude/settings.json при RED-тесте ДО изоляции homeDir; восстановил
  из шаблона cloud.json, а не из конфига оператора. Фикс: homeDir-инъекция.
- Случайный rebuild (12:37): npm run build при живом заводе (окно без
  спавнов, ущерба нет, но нарушение протокола)
- B-006 v1/v2/v3: кнопка ▶ на фронте при слепом controls — три итерации
  (disabled → pause → правда о проводке)
- 22 TS-ошибки от src/modules/documentation/ — чужой WIP (вторая сессия
  оператора строит пятый цех Documentation)

## 8. ВАЖНЫЕ ПУТИ

- БД прогона: .factory-sandboxes/stage11-db/factory.sqlite
- Журнал: .factory-sandboxes/stage11-db/factory-run-journal.jsonl
- Логи: .factory-sandboxes/stage11-logs/
- Снапшоты: factory-snapshots/ (early, replay-fitness, engine-death, settings-hijack)
- Баг-база: docs/factory-run/stage10/BUG-DATABASE.json (B-001..B-005)
- Корпус stage-10: tests/fixtures/golden-corpus/stage10-docking (24 продукта)
- Корпус stage-11: tests/fixtures/golden-corpus/stage11-docking (41 продукт, в worktree snapmvp)
- Ордер: docs/factory-run/stage10/ORDER.md (Elite docking slice)
- Бриф-10: docs/handoff/STAGE-10-AGENT-BRIEF.md
- Бриф-11: docs/handoff/STAGE-11-AGENT-BRIEF.md
