# WORKSHOP-GLM46-STATUS — статус прогона 21 проекта на glm-4.6

> Единая точка входа для наблюдающей сессии. Обновляется harness'ом (testbed-run.mjs) после каждого прогона.

**Обновлено:** 2026-08-15 20:29 UTC (P01/W1: ✖)
**Текущая фаза:** каскад W1→W2→W3 (драйвер testbed-cascade.mjs)
**Пространство:** одна БД `.factory-testbed-glm46/factory.sqlite`, фронт `http://localhost:4323`
**МОДЕЛЬ:** `glm-4.6` (провайдер zai, effort high, параллелизм 1)

## Сетка прогресса 21×3

Легенда: `⬚` не начинался · `🔄` идёт · `✅` pass · `✖` fail · `⏸` приостановлен · `↻` перезапуск

| PID | Проект | Тир | W1 Discovery | W2 Formaliz. | W3 Development | Примечание |
|---|---|---|---|---|---|---|
| P01 | counter | XS | ✖ | ⬚ | ⬚ | fail |
| P02 | stopwatch | XS | ⬚ | ⬚ | ⬚ | — |
| P03 | tips | XS | ⬚ | ⬚ | ⬚ | — |
| P04 | themes | XS | ⬚ | ⬚ | ⬚ | — |
| P05 | todo | S | ⬚ | ⬚ | ⬚ | — |
| P06 | units | S | ⬚ | ⬚ | ⬚ | — |
| P07 | snake | S | ⬚ | ⬚ | ⬚ | — |
| P08 | pomodoro | S | ⬚ | ⬚ | ⬚ | — |
| P09 | kanban | M | ⬚ | ⬚ | ⬚ | — |
| P10 | expenses | M | ⬚ | ⬚ | ⬚ | — |
| P11 | markdown | M | ⬚ | ⬚ | ⬚ | — |
| P12 | typing | M | ⬚ | ⬚ | ⬚ | — |
| P13 | mars | L | ⬚ | ⬚ | ⬚ | — |
| P14 | sortviz | L | ⬚ | ⬚ | ⬚ | — |
| P15 | sudoku | L | ⬚ | ⬚ | ⬚ | — |
| P16 | tetris | L | ⬚ | ⬚ | ⬚ | — |
| P17 | sheets | XL | ⬚ | ⬚ | ⬚ | — |
| P18 | elite | XL | ⬚ | ⬚ | ⬚ | — |
| P19 | mario3d | XXL | ⬚ | ⬚ | ⬚ | — |
| P20 | interp | XXL | ⬚ | ⬚ | ⬚ | — |
| P21 | foodlog | S | ⬚ | ⬚ | ⬚ | — |

## Последние события (журнал-хвост, новые сверху)

| Время (UTC) | Событие |
|---|---|
