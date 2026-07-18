# saga-mcp — Установка и запуск

## Что это

**saga-mcp** — платформа управления параллельными LLM-агентами. Не трекер задач —
governance-слой: от бизнес-гипотезы через архитектуру, требования, параллельную
разработку, независимую верификацию, до наблюдения за runtime и решения
(продолжать / закрыть).

**Цель:** недопустимое действие невозможно провести как допустимый переход.

## Быстрый старт (3 команды)

```bash
# 1. Установить
git clone https://github.com/PortnovAlex80/saga-mcp.git
cd saga-mcp && npm install && npm run build

# 2. Скопировать скиллы
cp -r skills/* ~/.zcode/skills/

# 3. Зарегистрировать MCP-сервер (редактировать ~/.zcode/cli/config.json)
```

`config.json`:
```json
{
  "mcp": {
    "servers": {
      "saga": {
        "type": "stdio",
        "command": "node",
        "args": ["D:/Development/saga-mcp/dist/index.js"],
        "env": { "DB_PATH": "C:/Users/<вы>/.zcode/saga.db" }
      }
    }
  }
}
```

Перезапустить ZCode.

## Запуск продукта

**Одна команда для пользователя:**

```
Skill("saga-start")
```

Из любой пустой папки. Дальше — диалог:

```
Вы:     Skill("saga-start")
Saga:   Какой продукт делаем? (одной фразой)
Вы:     Депозитный калькулятор для сайта банка
Saga:   [Discovery: 3 ассесора → brief → decision=go]
Saga:   [Complexity Gate: класс=modular, артефакты определены]
Saga:   [Formalization: PRD с гипотезой → SRS с инвариантами → AC с properties]
Saga:   [Planning: scaffold + dev tasks + verification tasks]
Saga:   [Development: рой воркеров в worktrees]
Saga:   [Verification: независимые L3 property-тесты]
Saga:   [Integration: merge + hard gate]
Saga:   ✅ Продукт готов
```

## Канбан-доска (автозапуск)

После запуска saga-mcp автоматически стартует веб-канбан на `http://localhost:4321`.

Показывает все проекты, эпизоды и задачи из saga DB:
- Доски: Backlog / In Progress / Review / Done / Blocked
- Матрица покрытия AC (implements / verified_by)
- Реестр приёмки (verification status)
- Кликабельные карточки задач
- Live heartbeat (агенты работают / простаивают / упали)

Запуск вручную:
```bash
DB_PATH=C:/Users/<вы>/.zcode/saga.db npm run tracker
```

## Что saga делает автоматически

| Этап | Что происходит | Кто |
|---|---|---|
| Discovery | Идея → измеримая гипотеза (metric, target, kill criteria) | saga-kickstart |
| Complexity Gate | Оценка: thin/modular/regulated/research → набор артефактов | senior-analyst |
| Formalization | PRD + SRS (стиль, инварианты, порты) + UC/AC (contract-as-data) | product/architect/analyst |
| Planning | Pattern B scaffold, conflict_keys, verification.ac tasks | saga-planner |
| Development | Параллельные воркеры в worktrees, merge-lock | saga-worker |
| Verification | Независимые property-тесты из frozen AC (не Builder'овские) | saga-verifier |
| Integration | Hard gate: каждый AC имеет passing evidence | episode_transition |
| Observation | Runtime метрики → hit/kill решение | observation_record |

## Что saga НЕ даёт сделать

- Перейти в development без принятых AC (hard gate)
- Объявить done без passing evidence (deny-by-default)
- Изменить замороженный контракт mid-work (drift detection)
- Двум воркерам ломать один файл (conflict_keys на planning time)
- Агенту понизить risk чтобы обойти gate (P15 monotonicity)
- Записать UNKNOWN/ERROR как PASS (4-valued verdict)
- Создать гипотезу без измерения (R16: observation required)

## Проверка после установки

```bash
npm test                              # 163 теста green
node tools/cgad-spec-lint.mjs <db>    # 18 правил, read-only
ls ~/.zcode/skills/ | grep saga       # 13 skills
```

## Системные требования

- Node.js 18+
- npm
- Git
- ZCode (или любой MCP-клиент)
- SQLite (встроен через better-sqlite3, не нужен отдельно)

## Управление версиями

Перед релизом новой версии saga-mcp:

```
Skill("saga-release")
```

Release skill проверит: тесты, lint, skills, agents, метаданные, документацию,
CI/CD, schema, git hygiene — 10 секций чеклиста.

## Документация

- [README.md](../README.md) — English overview
- [README.ru.md](../README.ru.md) — Русский обзор
- [История](saga-mcp-history.md) — полная эволюция (7 актов)
- [Research Charter](research/00-research-charter-v1-final.md) — agent-oriented SE тезис
- [ADR](architecture/decisions/) — архитектурные решения
- [GUARDRAILS](../GUARDRAILS.md) — конституция (Signs 001-009)

---

*Начни с `Skill("saga-start")` из пустой папки. Saga проведёт через весь цикл.*
