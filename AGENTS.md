# AGENTS.md — обязательные инструкции для любого агента в этом репо

## 🔴 ПЕРВИЧНОЕ УКАЗАНИЕ (читай перед началом любой работы)

**Прежде чем делать следующий `fix(...)` или стабилизационный коммит, прочитай:**

- `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md`

Это архитектурный диагноз (~1000 строк). Он объясняет, почему серия ночных
фиксов завода (`fix(formalization): ...`, `fix(review): ...`,
`fix(runtime): ...`, `fix(development): ...`) — это не независимые баги, а
проявления одного системного дефекта:

> В нормативной модели владельцем работы является Workplace, но в API и типах
> владельцем материала всё ещё считается WorkerExecution. Поэтому каждый
> следующий прогон находит новую границу перекодирования.

## 🔴 OPENCODE ONLY — the claude CLI is retired (operator directive, 2026-08-20)

All factory workers and all agent tooling in this repo run through the
opencode shim. The claude code CLI is NEVER invoked directly, by any agent,
for any reason.

- ALWAYS set `SAGA_REAL_CLAUDE_PATH="node D:/Development/saga-mcp/tools/agent-proxy/claude-shim.mjs"`
  before any factory start/resume. Never unset it — there is no claude
  fallback anymore.
- NEVER touch, rewrite, patch, "restore" or re-pin `~/.claude/settings.json`.
  It is not ours. Its sha256 is a tripwire only: if it changes during a
  factory run, that is an ABORT condition — investigate, never edit it back.
- Keep `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1` in tracker/engine env so
  `POST /api/model/set` cannot rewrite it either.

## 🔴 ПЕРВИЧНЫЕ ДОКУМЕНТЫ КОНВЕЙЕРА

При любой заводской диагностике читать целиком (не выдержки):

1. `docs/architecture/CONVEYOR-MENTAL-MODEL.md` — архитектурный компас
2. `docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md` — диагностика переходов
3. `docs/architecture/CONVEYOR-TRANSITION-CHECKLIST.md` — чек-лист переходов
4. `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md` — системный диагноз

## 🔴 Официальная документация Codex Hooks

Если нужен механизм для впрыска контекста в agentic loop (вместо ручной
правки AGENTS.md):

- **Codex Hooks — официальная дока:** https://learn.chatgpt.com/docs/hooks
- События: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `notify`
- Конфиг: `~/.codex/hooks.json` или `.codex/hooks.json`
- Впрыск контекста без остановки: `additionalContext` (plain stdout или JSON)

## Контекст текущей работы

- **Stage-12 night shift (2026-08-20, operator-autonomous):** merge waves →
  anti-gaming core → fresh factory run on `glm-4.6` → conditional E9 recycle.
  **Live status — read FIRST: `docs/factory-run/stage12/NIGHT-TRACKER.md`.**
  Brief: `docs/handoff/STAGE-12-AGENT-BRIEF.md` (incl. the OPERATOR OVERRIDE
  section). All night reasoning/reports in English.
- Текущий HEAD: см. `git log -1`
- По-цеховое тестирование 20 проектов (одна БД `.factory-testbed/factory.sqlite`,
  модель qwen/qwen3.6-35b-a3b, параллелизм 1): план
  `docs/testing/WORKSHOP-TEST-PLAN.md`, **живой статус —
  `docs/testing/WORKSHOP-STATUS.md` (читать его первым для состояния завода)**;
  баг-реестр `docs/testing/WORKSHOP-BUGS.md`, журнал `docs/testing/WORKSHOP-JOURNAL.md`
