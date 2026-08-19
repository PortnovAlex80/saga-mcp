# WORKER NAMES — factory-floor callsigns (design)

**Оператор:** «имена вместо UUID, словарь 20-30 на английском, чередование,
группировка по цехам и скиллам. UUID остаётся внутренним кодом».

## Схема: заводские инструменты, НЕ люди

| Цех | Тема | Имена (7-8) |
|---|---|---|
| Discovery | навигация | Beacon, Compass, Gyro, Meridian, Probe, Transit, Zenith |
| Formalization | чертёж/точность | Draft, Jig, Kernel, Origin, Ruler, Square, Vector |
| Development | кузница/станок | Anvil, Endmill, Forge, Hammer, Lathe, Union, Wrench |
| Documentation | печать/архив | Index, Nib, Quill, Vellum, Binder, Ledger, Ream, Tome |

Свойства: 24/28 уникальных первых букв; 3-7 символов (равные колонки); нет
рифм/префиксов/слов-из-логов; группировка семантическая (не декоративная);
роль НЕ в имени (phase отображается рядом: `Square · review`).

## Механизм: claim-time колонка + deterministic fallback

- `display_name TEXT` на `worker_executions` — пишется В claim-транзакции
- `pickWorkerName(db, projectId, stage)`: свободные из пула цеха → все 28 → суффикс
- Перпроектная уникальность; ротация естественная; после смерти имя остаётся в строке
- Legacy: `COALESCE(display_name, hashName(worker_id))` — нулевая миграция
- UUID НИЧЕГО не меняет: authority, worker_done, gate receipts, имена файлов

## Правила отображения: имя для чтения, UUID на один жест

- Канбан: `@Forge` + tooltip с UUID
- Панель воркеров: `#217 Forge · exec · 14m`
- Journal: `data.display_name` в payload (не correlation key!)
- Промпт воркера: «You are Forge, a single-use Saga CLI worker»
- Heartbeat: `worker=Forge` вместо UUID
- Forensic: `grep Forge` → execution_id → SELECT — имя для чтения, UUID для отладки

## Файлы (9 существующих + 1 новый + 2 теста)

Core: schema.ts, worker-executions.ts, work-assignment-core.ts, NEW worker-names.ts
Display: claude-runner.mjs, lifecycle-endpoints.mjs, board-render.mjs,
core-view/core-cell.mjs, core-view/views/cell.js

НЕ трогаем: dispatch-loop, authorize-tool-call, worker_done, верификацию,
replay, checkpoints, имена лог-файлов.
