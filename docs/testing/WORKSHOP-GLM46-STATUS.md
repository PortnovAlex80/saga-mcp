# WORKSHOP-GLM46-STATUS — статус прогона 21 проекта на glm-4.6

> Единая точка входа для наблюдающей сессии. Обновляется harness'ом (testbed-run.mjs) после каждого прогона.

**Обновлено:** 2026-08-15 22:53 UTC (GB-5/B fixed — ночь перезапущена night-rerun драйвером)
**Текущая фаза:** каскад W1→W2→W3 (драйвер testbed-cascade.mjs)
**Пространство:** одна БД `.factory-testbed-glm46/factory.sqlite`, фронт `http://localhost:4323`
**МОДЕЛЬ:** `glm-4.6` (провайдер zai, effort high, параллелизм 1)

## Сетка прогресса 21×3

Легенда: `⬚` не начинался · `🔄` идёт · `✅` pass · `✖` fail · `⏸` приостановлен · `↻` перезапуск

| PID | Проект | Тир | W1 Discovery | W2 Formaliz. | W3 Development | Примечание |
|---|---|---|---|---|---|---|
| P01 | counter | XS | ✖ | ✖ | ⬚ | fail |
| P02 | stopwatch | XS | ✖ | ✖ | ⬚ | fail |
| P03 | tips | XS | ✖ | ✖ | ⬚ | fail |
| P04 | themes | XS | ✖ | ✖ | ⬚ | fail |
| P05 | todo | S | ✖ | ✖ | ⬚ | fail |
| P06 | units | S | ✅ | ✖ | ⬚ | fail |
| P07 | snake | S | ✅ | ✖ | ⬚ | fail |
| P08 | pomodoro | S | ✅ | ⬚ | ⬚ | граница dirty (1 карт.) |
| P09 | kanban | M | ✅ | ⬚ | ✖ | fail |
| P10 | expenses | M | ✅ | ⬚ | ✖ | fail |
| P11 | markdown | M | ✅ | ⬚ | ✖ | fail |
| P12 | typing | M | ✅ | ⬚ | ✖ | fail |
| P13 | mars | L | ✅ | ⬚ | ✖ | fail |
| P14 | sortviz | L | ✅ | ⬚ | ✖ | fail |
| P15 | sudoku | L | ✅ | ⬚ | ✖ | fail |
| P16 | tetris | L | ✅ | ⬚ | ✖ | fail |
| P17 | sheets | XL | ✅ | ⬚ | ✖ | fail |
| P18 | elite | XL | ✅ | ⬚ | ✖ | fail |
| P19 | mario3d | XXL | ✅ | ⬚ | ✖ | fail |
| P20 | interp | XXL | ✅ | ⬚ | ✖ | fail |
| P21 | foodlog | S | ✅ | ⬚ | ✖ | fail |

## Последние события (журнал-хвост, новые сверху)

| Время (UTC) | Событие |
|---|---|
