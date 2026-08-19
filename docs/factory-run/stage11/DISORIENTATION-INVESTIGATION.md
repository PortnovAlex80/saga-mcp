# ДЕЗОРИЕНТАЦИЯ СТАРТА ВОРКЕРОВ — расследование тремя следователями

Феномен: воркеры спотыкаются на старте — первая Read резолвится против
корня ГЛАВНОГО репо вместо продуктового, затем самовосстановление через `cd`.
Пример: task-36 (readiness-сертификация). Затрагивает стоимость каждой
сессии (средняя ~12,7 мин).

---

## Д2 (слой раннера): РАННЕР НЕ ВИНОВЕН — контракт согласован, ломается ниже ✅

Доказательная база полная:

- **Генерация путей**: `materializePinnedWorkspace`
  (`src/process-modules/application/pinned-workspace-materializer.ts:277-296`)
  строит `docs/<stage>/projects/<epic>/executions/node-<nodeId>/workplace-<sha256[0:24]>`
  от `workspaceRoot`. Desk-поля строго ОТНОСИТЕЛЬНЫЕ
  (`process-execution-workspace.ts:282-284`; materializer `:507-513`),
  включая `TRACKER_PATH` в agent-assistance.json (`:473`).
- **buildPrompt** (`tracker-view/claude-runner.mjs:307-311, 322`) отдаёт их
  как есть: «Read ${trackerPath} before any domain action».
- **Фактическое место документа**: существует ТОЛЬКО в продуктовом сэндбоксе
  (`.factory-sandboxes/stage11/product/docs/development/projects/1/
  executions/node-certify-product-readiness/workplace-2ebbec…/`). В главном
  репо `docs\development\projects\…` НЕТ вовсе. Резолв против workspaceRoot —
  корректен.
- **cwd спавна корректен**: `claude-runner.mjs:890-891` (`executionCwd =
  repositoryDesk?.executionPath ?? workspaceRoot`), `:1125` (`cwd`), и лог
  спавна подтверждает: `cwd="…\.factory-sandboxes\stage11\product"`.
- **Итог**: обе стороны контракта согласованы (относительный путь ↔ cwd
  продукт-репо). Разрыв ПОСЛЕ спавна: шим/opencode-бэкенд начал сессию с
  эффективным cwd = корень главного репо (вид ошибки — конкатенация главного
  корня с относительным путём промпта).
- **Альтернатива опровергнута**: «абсолютный путь — баг генерации» — путь
  строго относителен на трёх уровнях; ошибка конкатенативна, не абсолютна.
- **Не доказано**: почему бэкенд взял чужой cwd — внутри `claude-shim.mjs`
  (территория Д1).

## Д1 (слой шима/opencode-бэкенда): ⏳

## Д3 (эмпирика 48 сессий: частота/цена/смерти): ⏳

## Синтез и фикс: ⏳ после Д1+Д3
