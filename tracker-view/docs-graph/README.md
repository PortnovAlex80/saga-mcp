# Docs Graph Viewer

Web UI для визуализации документации saga-проекта в виде дерева-графа (DAG) и
редактирования `.md` файлов в git-ветках с PR-like merge flow.

Подкаталог `saga-mcp`. Запускается как sidecar процесс рядом с `tracker-view`
(порт 4322 по умолчанию).

## Что показывает

Единый граф, объединяющий два источника:

1. **Saga-артефакты** (PRD/SRS/UC/AC/FR/NFR/decision/brief/…) — из таблицы
   `artifacts`. Цветные узлы с бейджем типа. Рёбра:
   - `parent_artifact_id` — позвоночник дерева (decision→PRD→SRS/UC/FR, AC→UC).
   - `artifact_traces` — кросс-рёбра (`covers`, `implements`, `derived_from`,
     `depends_on`, `verified_by`, `superseded_by`, `implements_spec`).
   - Таски-цели (`implements` AC → DEV-таск) превращаются в отдельные узлы.

2. **Markdown-файлы** — все `.md` в репозитории проекта (или под `docs_root`,
   если задан). Файлы, не привязанные к saga-артефакту, показываются серыми
   `doc`-узлами.

Сканер игнорирует `.git`, `.worktrees`, `node_modules`, `dist`, `build`,
`.saga`, `coverage`.

## Запуск

```bash
# Из корня saga-mcp (нужен собранный dist/):
npm run build

# Явный запуск:
DB_PATH=~/.zcode/saga.db npm run docs-graph
# → http://localhost:4322

# Или автоматически — saga-mcp сам spawn'ит viewer при старте (как и tracker-view),
# если DOCS_GRAPH_AUTOSTART != '0' и задан DB_PATH.
```

Переменные окружения:
- `DB_PATH` (обязательно) — путь к saga SQLite базе.
- `DOCS_GRAPH_PORT` (по умолчанию `4322`).
- `DOCS_GRAPH_AUTOSTART=0` — отключить автозапуск из `src/index.ts`.

## Редактирование в ветках (Phase B)

Клик по любому узлу с `path` открывает side-панель с кнопкой
**"✎ Edit in branch"**. Открывается модальный редактор:

- **Path** — относительный путь `.md` (например `docs/foo.md`).
- **Branch** — выбор существующей `docs/<id>` или создание новой (auto-id вида
  `doc-YYYYMMDD-HHMMSS-XXXX`).
- **Textarea** — markdown-исходник с live-preview (через `marked`).
- **Save (commit)** — пишет файл в worktree ветки и делает `git commit`.
- **Discard branch** — удаляет ветку + worktree.

Конвенция именования:
- Ветки: `docs/<change-id>` (slug `[a-z0-9-]+`).
- Worktree: `.worktrees/docs-<change-id>` под корнем репозитория.
- Эта область **не пересекается** с execution-task worktrees saga (префикс
  `.worktrees/task-<id>`), параллельная работа безопасна.

Все файловые операции path-traversal-safe: путь не может выйти за пределы
worktree root.

## Merge flow (Phase C)

Кнопка **🌿 Branches** в toolbar открывает drawer активных `docs/*` веток. У
каждой ветки — **"Merge…"** открывает PR-like modal:

1. Pre-flight **diff preview** — список изменённых файлов с бейджами
   `A`/`M`/`D`/`?`, полный textual diff под `<details>`.
2. **Confirm merge** — вызывает `mergeDocsBranch`:
   - `git merge-tree --write-tree` (без touching working tree)
   - `git commit-tree` с двумя parent'ами и saga-trailer'ом
     `Saga-Docs-Change: <id>`
   - `git update-ref refs/heads/<target> <sha> <expected>` (CAS)
3. **Результаты**:
   - `merged` — ветка влилась, worktree удалён, saga-артефакты получили
     обновлённые `content_hash`/`drift_state`.
   - `already_merged` — ветка уже была предком target.
   - `conflict` — список конфликтных файлов; target не сдвинут.
   - `base_advanced` — target сдвинулся между preview и merge; повторить.
4. После merge — DB-sync: для затронутых `.md` путей вызывается
   `refreshArtifactHash`, чтобы `drift_state` артефактов обновился.

Если `integration_branch` (по умолчанию `dev`) не существует — она
автоматически создаётся из `default_branch` (обычно `main`/`master`). Это
соответствует saga-конвенции, но толерантно к проектам, ещё не перешедшим на
dev/main split.

## API

| Endpoint | Method | Описание |
|---|---|---|
| `/api/projects` | GET | Список saga-проектов со счётчиком артефактов |
| `/api/graph?project=<id>` | GET | Унифицированный граф (nodes + edges + stats) |
| `/api/doc/branch/list?project=<id>` | GET | Активные `docs/*` ветки |
| `/api/doc/branch/create` | POST | `{project_id, change_id?, base?}` → worktree |
| `/api/doc/branch/discard` | POST | `{project_id, change_id\|branch}` |
| `/api/doc/save` | POST | `{project_id, branch, path, markdown, message?}` → commit |
| `/api/doc/read?project=&branch=&path=` | GET | Контент `.md` из worktree |
| `/api/doc/diff?project=&branch=` | GET | Pre-flight diff (files + patch) |
| `/api/doc/merge` | POST | `{project_id, branch}` → merge result |

## Архитектура

```
tracker-view/docs-graph/
  package.json          # ноль зависимостей (better-sqlite3 inherited from root)
  server.mjs            # голый node:http, port 4322
  lib/
    scanner.mjs         # walker .md → индекс (sha256, title, front-matter)
    graph-snapshot.mjs  # сборка унифицированного графа (artifacts + .md + traces)
    paths.mjs           # repo binding + path-traversal-safe resolution
  public/
    index.html          # главная страница
    graph.js            # cytoscape DAG-renderer + interactions
    editor.js           # branch drawer + markdown editor + merge modal
    style.css           # цвета по type/link_type (в синке с tracker-view)

src/lifecycle/docs-worktree.ts   # TS-модуль: branch + worktree + commit + merge
                                 # → компилируется в dist/lifecycle/docs-worktree.js
```

**Переиспользование saga-mcp:**
- `helpers/artifact-file.ts:refreshArtifactHash` — post-merge DB sync.
- `helpers/artifact-file.ts:artifactDiskHash` — паттерн path-traversal guard.
- Pattern `spawnSync('git', ...)` — тот же подход, что в
  `lifecycle/integration-executor.ts` и `helpers/git.ts`.

**НЕ трогает** `lifecycle/integration-executor.ts` — этот модуль связан с
`integration_intents` таблицей и CGAD task-merge flow. Рефакторить его рискованно;
вместо этого `mergeDocsBranch` переиспользует алгоритм (observe → merge-tree →
CAS), но без зависимости от saga task-инфраструктуры.

## Тесты

```bash
node --test tests/docs-graph-scanner.test.mjs    # walker + front-matter
node --test tests/docs-graph-snapshot.test.mjs   # graph builder (DB + FS)
node --test tests/docs-graph-merge.test.mjs      # Phase C merge flow
```

## Limitations / follow-ups

- Push/pull к remote — пока только локальные ветки.
- Wiki-link extraction (`[[code]]`, `[text](rel.md)`) — помечено как optional,
  не реализовано (структурный граф уже покрывает traces + parent).
- Multi-user conflict resolution UI — conflicts показываются списком, ручная
  резолюция вне viewer'а.
- Аутентификация — сервер локальный, как tracker-view.
