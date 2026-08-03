# T10: tracker-view.mjs Split Plan

> План разбиения 5605-строчного монолита на 8 фокусных модулей.
> Произведён агентом T10-plan. Не реализован — это план.

## Target layout

```
tracker-view/
  tracker-view.mjs              ← HTTP core + composition root (~700 lines)
  shared.mjs                    ← cross-cutting helpers (~120 lines)
  artifact-render.mjs           ← markdown + artifact views (~900 lines)
  board-render.mjs              ← kanban + index + task views (~1700 lines)
  board-runner-adapter.mjs      ← ClaudeBoardRunner wiring + recovery (~140 lines)
  model-management.mjs          ← /api/models + /api/model/set + LM Studio (~370 lines)
  lifecycle-endpoints.mjs       ← engine control + stage-summary + workers (~700 lines)
  admin-endpoints.mjs           ← project/epic CRUD + create-from-idea (~430 lines)
```

## Extraction order (7 steps, lowest risk first)

| # | Module | Risk | Почему этот порядок |
|---|---|---|---|
| 1 | shared.mjs | Very low | Leaf — нет зависимостей от других новых модулей |
| 2 | board-runner-adapter.mjs | Low | Зависит только от shared + claude-runner (уже существует) |
| 3 | model-management.mjs | Medium | Требует обновления saga2-boundaries.test.mjs |
| 4 | admin-endpoints.mjs | Low | Зависит от shared + git-bootstrap + dist |
| 5 | lifecycle-endpoints.mjs | Medium | Большой, но механический |
| 6 | artifact-render.mjs | Medium | Требует обновления artifact-presentation.test.mjs |
| 7 | board-render.mjs | High | Самый большой (~1700 строк), page() переезжает последним |

## Tests that MUST be updated

1. `tests/lifecycle/artifact-presentation.test.mjs` — target file → artifact-render.mjs
2. `tests/architecture/saga2-boundaries.test.mjs` — model-management.mjs (payload.env.* + CLAUDE_SETTINGS_LMSTUDIO_TPL)
3. `tests/characterization/saga2-runtime-contracts.test.mjs` — split: COLS/DB_PATH/routes stay on tracker-view.mjs, board tokens → board-render.mjs

## Key constraint

Pattern: factory injection (`createXxxApi({ deps })`), как уже делает `lifecycle-pipeline/pipeline-api.mjs`. Каждый модуль получает deps от core, никаких globals.
