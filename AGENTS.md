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

## 🔴 КАК ОТВЕТИТЬ ОПЕРАТОРУ

Оператор ждёт твой ответ в общем канале связи агентов:

- **файл:** `AGENT-ENVELOPE.md` (в корне репо)
- **секция:** «Исходящие сообщения (агенты → оператору / друг другу)»

Напиши туда (в формате: дата + автор + текст):
1. ты прочитал ADR-053?
2. что собираешься делать дальше — продолжать точечные фиксы, или
   переходить к cutover (WorkplaceProductionRevision)?
3. какая следующая граница, на которой Mars/Venus сломается, если cutover
   не сделать?

Не удаляй чужие сообщения — только добавляй своё.

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

- Активный завод: `mars-venus-e2e-20260811-015` (GLM-4.7, Formalization)
- Текущий HEAD: см. `git log -1`
- Оператор (человек) ведёт отдельную сессию наблюдения — не мешать заводу
- По-цеховое тестирование 20 проектов (одна БД `.factory-testbed/factory.sqlite`,
  модель qwen/qwen3.6-35b-a3b, параллелизм 1): план
  `docs/testing/WORKSHOP-TEST-PLAN.md`, **живой статус —
  `docs/testing/WORKSHOP-STATUS.md` (читать его первым для состояния завода)**;
  баг-реестр `docs/testing/WORKSHOP-BUGS.md`, журнал `docs/testing/WORKSHOP-JOURNAL.md`
