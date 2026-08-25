# AGENTS.md — обязательные инструкции для любого агента в этом репо (DRAFT for EK-10 landing)

> **Status: DRAFT** (WP-14, for the EK-10 landing). This file replaces
> `AGENTS.md` when the canonical documentation rewrite lands; until then the
> live `AGENTS.md` remains in force. The change: first-time agents now read
> the new kernel, runbook and test strategy before changing production code,
> and the sole documentation index is `docs/CURRENT-DOCUMENTS.md`.

## 🔴 ПЕРВИЧНОЕ УКАЗАНИЕ (читай перед началом любой работы)

Прежде чем менять любой production-код в этом репо, прочитай целиком (не
выдержки):

1. `docs/architecture/WORKFLOW-KERNEL.md` — владельцы, команды, события,
   обязательства, ожидания, терминальные доказательства, граница проекций.
2. `docs/operations/FACTORY-RUNBOOK.md` — операционный режим (fresh-БД,
   opencode, stop/resume, доказательства).
3. `docs/testing/WORKFLOW-KERNEL-TEST-STRATEGY.md` — как протокол доказывается
   тестами и квалификацией.

Полный порядок чтения и весь список живых документов:
`docs/CURRENT-DOCUMENTS.md` — единственный действующий индекс документации.

Три закона конвейера (краткая форма, развёрнута в
`docs/architecture/CONVEYOR-MENTAL-MODEL.md`):

> **один владелец · durable handoff · Kanban — только проекция**

- У каждого mutable-факта ровно один aggregate-владелец; никаких
  `latest`/`max(id)`/статусных выборок авторитета.
- Каждый межвладельческий переход — атомарные `событие + обязательство`;
  потребитель обязательств stateless и заменяем.
- Состояние работы живёт в obligations/waits/proofs; канбан-карточки —
  перестраиваемые проекции; пустая очередь — не доказательство терминала.
- Любое добавление команды/вида обязательства/ожидания/доказательства/поля
  контракта **переоткрывает EK-1** и обнуляет downstream-квалификацию.
- Назвать владельца, команду, событие, обязательство и доказательство для
  каждого изменяемого перехода — обязательное условие; не можешь — стоп.

## 🔴 OPENCODE ONLY — the claude CLI is retired (operator directive, 2026-08-20)

All factory workers and all agent tooling in this repo run through the
opencode transport. The claude code CLI is NEVER invoked directly, by any
agent, for any reason.

**Why: claude (Anthropic) became very expensive** for factory workloads —
operator decision 2026-08-20. The factory runs on opencode via
`tools/agent-proxy/claude-shim.mjs` (`opencode run` on the official Z.AI
Coding Plan provider); the move was validated by a full production run.

**The prohibition is enforced fail-closed in code:** any executor resolving
to the claude CLI (the bare `claude` default, a binary path, the VS Code
extension binary) aborts the worker spawn with
`FACTORY_CLAUDE_BACKEND_FORBIDDEN`. There is no silent fallback: forgetting
the env makes the first worker fail loudly instead of billing Anthropic.

- ALWAYS set `SAGA_REAL_CLAUDE_PATH="node D:/Development/saga-mcp/tools/agent-proxy/claude-shim.mjs"`
  before any factory start/resume. Never unset it — there is no claude
  fallback anymore.
- NEVER touch, rewrite, patch, "restore" or re-pin `~/.claude/settings.json`.
  It is not ours. Its sha256 is a tripwire only: if it changes during a
  factory run, that is an ABORT condition — investigate, never edit it back.
- Keep `SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS=1` in tracker/engine env so
  model-switch APIs cannot rewrite it either.
- В целевом протоколе каждый provider-запрос идёт через инструментированный
  opencode-транспорт с admission-вызовом непосредственно перед отправкой в
  сеть и оставляет `PromptAssemblyReceipt`. Непрозрачный `opencode run`
  цикл без учёта контекста — неконформен.

## 🔴 Документация и законы репо

- **Единственный индекс живых документов:** `docs/CURRENT-DOCUMENTS.md`.
  Документа нет в индексе (или в ADR-реестре) — он не существует; lint
  (`npm run test:docs-current`) это блокирует.
- **Устаревшие документы удаляются, не архивируются.** Каталога
  `docs/archive` не существует и не должен появляться. Git-история — архив.
- **Единственный runbook:** `docs/operations/FACTORY-RUNBOOK.md`. Никаких
  параллельных «живых статусов», трекеров ночных смен и страниц состояния.
- Диагностика застрявшей работы — только по obligation/wait/proof
  доказательствам: `docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md`.
- Тесты: всё blocking, карантина/скипов нет; удаление теста без замещающей
  мутации запрещено (см. test strategy).

## 🔴 Fresh protocol only

Новая БД — всегда новый пустой путь; старая/чужая БД отказывает с
`FACTORY_DATABASE_PROTOCOL_UNSUPPORTED` без мутации файла. Миграций,
adoption, dual-read/write и resume с precutover-БД не существует и не должно
появляться. Квалификационные прогоны иммутабельны: чинить живой
квалификационный прогон руками запрещено — сохрани evidence и начни новый
kit.

## Контекст текущей работы

- Текущий HEAD: см. `git log -1`.
- Статус рефакторинга event-kernel:
  `docs/refactoring/event-kernel/EXECUTION-TRACKER.md` (координаторский
  трекер work-пакетов; живые статусы заводских смен туда больше не
  заводятся).
- Решения и их статус: ADR-реестр (`docs/architecture/adr-closure-registry.json`),
  история — `docs/architecture/decisions/`.
