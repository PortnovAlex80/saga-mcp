# saga-flow — установка в новый проект

**Портабельный пакет saga-flow:** 8 skills + 6 agents + install-инструкция.
Копируешь этот раздел → `~/.zcode/` → saga-flow работает в новом проекте.

---

## Что входит в saga-flow

```
saga-mcp/                        ← этот репозиторий (форк)
├── skills/                      ← 8 skills (процедуры для ролей)
│   ├── saga-kickstart/          ← discovery: идея → brief → decision
│   ├── saga-product/            ← formalization: PRD
│   ├── saga-architect/          ← formalization: SRS + API contract
│   ├── saga-analyst/            ← formalization: UC + AC
│   ├── saga-planner/            ← bridge: AC → dev-задачи (Pattern A/B)
│   ├── saga-worker/             ← execution: claim → worktree → merge
│   ├── saga-dispatch/           ← execution: цикл диспетчеризации
│   └── saga-tracker/            ← bootstrap: resolve project, dashboard
├── agents/                      ← 6 subagent profiles (ZCode frontmatter)
│   ├── saga-kickstart.md
│   ├── saga-product.md
│   ├── saga-architect.md
│   ├── saga-analyst.md
│   ├── saga-planner.md
│   └── saga-worker.md
└── docs/
    ├── INSTALL.md               ← этот файл
    ├── ac-verification.md       ← AC-gate дизайн (Sign 006)
    └── saga-flow-overview.md    ← архитектура saga-flow
```

---

## Быстрая установка (3 шага)

### Шаг 1: установить saga-mcp как MCP-сервер

```bash
cd /path/to/saga-mcp
npm install
npm run build    # → dist/index.js
```

Добавить в ZCode MCP config (`~/.zcode/cli/config.json`):

```json
{
  "mcp": {
    "servers": {
      "saga": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/saga-mcp/dist/index.js"],
        "env": {
          "DB_PATH": "/absolute/path/to/.tracker.db"
        }
      }
    }
  }
}
```

`DB_PATH` — где хранить saga-БД проекта. Может быть:
- `~/.zcode/saga.db` — глобальная (все проекты в одной БД, saga изолирует по project_id)
- `<project>/.tracker.db` — per-project (каждый проект своя БД)

### Шаг 2: скопировать skills и agents в ~/.zcode/

```bash
# Skills (8 штук)
cp -r skills/saga-* ~/.zcode/skills/

# Agents (6 штук)
cp agents/saga-*.md ~/.zcode/agents/
```

**Важно:** ZCode 3.2.x грузит agents из `~/.zcode/agents/` (user-level).
Workspace-level (`<repo>/.zcode/agents/`) тоже валидируется, но в Settings
не виден. Копируй в user-level для надёжности.

### Шаг 3: перезапустить ZCode

```bash
# Через supervisor (если есть):
curl -s -X POST http://127.0.0.1:7878/restart

# Или вручную: закрыть и открыть ZCode
```

После рестарта проверить: **Settings → Subagents** — должны быть видны
`saga-kickstart`, `saga-product`, `saga-architect`, `saga-analyst`,
`saga-planner`, `saga-worker`.

### Шаг 4 (опционально): создать saga-проекты

```bash
# В MCP (через ZCode чат или CLI):
project_create(name: "requirements", description: "...")
project_create(name: "<project>-builders", description: "...")
```

В корне каждого рабочего репозитория:
```bash
echo "<project-name>" > projectname.txt
```

---

## Проверка установки

1. **MCP подключен:** `/mcp list` → saga: connected, tools ≥ 40
2. **Skills загружены:** `/skill` → видны saga-kickstart, saga-product, ...
3. **Agents загружены:** Settings → Subagents → 6 saga-* профилей
4. **Smoke-test:** вызови `@saga-kickstart` или `Skill("saga-kickstart")`
   с идеей одной фразой → должен начать discovery

---

## Архитектура saga-flow (кратко)

```
Идея (1 фраза)
  │
  ▼
Discovery (saga-kickstart — SKILL в main-context, НЕ subagent)
  │  3 ассесора → decision-fork → completeness-gate → verdict → brief
  ▼
Formalization (цепь ролей)
  │  saga-product (PRD) → saga-architect+SRS+FR/NFR || saga-analyst+UC
  │  → saga-analyst+AC
  ▼
Planning (saga-planner)
  │  AC → dev-задачи (Pattern A: sequence / Pattern B: scaffold+parallel)
  │  + AC-verification задачи (verified_by gate)
  ▼
Execution (рой saga-worker)
  │  scaffold (critical) → bodies (parallel) → review → merge
  ▼
AC-verification (saga-worker role:reviewer)
  │  сверка эталонов AC с реальным выводом
  ▼
INTEGRATE → working product
```

---

## Ключевые правила (GUARDRAILS)

Подробно: `GUARDRAILS.md` в harmess, Sign 001-006. Кратко:

1. **Sign 001:** `extractInputs` не считает coverage — caller делает это
2. **Sign 002:** Pattern B (scaffold+parallel) для shared_mutation_risk=true
3. **Sign 003:** dispatcher role-filter bug (known-issue)
4. **Sign 004:** saga-planner skill запрещает worker_done (known-issue)
5. **Sign 005:** kickstart = SKILL в main-context, НЕ subagent (нет Agent/AskUser tools)
6. **Sign 006:** AC coverage (`implements`) ≠ AC satisfaction (`verified_by`)

---

## Устранение неполадок

### Профиль не появился в Settings → Subagents

1. Проверь путь: `~/.zcode/agents/<name>.md` (НЕ workspace-level)
2. Frontmatter валиден: `---\nname: ...\ndescription: ...\n---`
3. Имя файла совпадает с `name` во frontmatter
4. Перезапусти ZCode (профили грузятся только на старте)
5. Логи: `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl` → grep `bootstrap.subagents`

### MCP saga не подключается

1. `npm run build` в saga-mcp → `dist/index.js` существует
2. Путь в config.json абсолютный, с правильными слешами (Windows: `D:/...` или `D:\\...`)
3. DB_PATH существует и доступен для записи
4. Логи: `~/.zcode/cli/log/` → grep `mcp.server.connected` или `mcp.server.error`

### saga-worker не может заклеймить задачу

1. `projectname.txt` в корне репозитория (содержимое = saga project name)
2. `worker_next({ project_id: <N> })` — project_id ОБЯЗАТЕЕЛЕН
3. Задача в `todo` или `review` статусе, `assigned_to: null`, без unmet deps

---

## Перенос в новый проект (чек-лист)

```
[ ] saga-mcp fork склонирован/скопирован
[ ] npm install && npm run build в saga-mcp
[ ] MCP config добавлен (DB_PATH, args → dist/index.js)
[ ] skills/saga-* скопированы в ~/.zcode/skills/
[ ] agents/saga-*.md скопированы в ~/.zcode/agents/
[ ] ZCode перезапущен
[ ] Settings → Subagents: 6 saga-* видны
[ ] /mcp list: saga connected
[ ] projectname.txt в корне рабочего репозитория
[ ] saga-проект создан (project_create)
[ ] Smoke-test: @saga-kickstart с тестовой идеей
```
