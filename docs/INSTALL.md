# saga-mcp — Установка и запуск

## Что это

**saga-mcp** — платформа управления параллельными LLM-агентами. Не трекер задач —
governance-слой (слой управления): от бизнес-гипотезы через архитектуру, требования, параллельную
разработку, независимую верификацию, до наблюдения за runtime (работающей системой) и решения
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
Saga:   [Complexity Gate (шлюз сложности): класс=modular, артефакты определены]
Saga:   [Formalization: PRD с гипотезой → SRS с инвариантами → AC с properties]
Saga:   [Planning: scaffold (каркас) + dev tasks + verification tasks]
Saga:   [Development: рой воркеров в worktrees (рабочих копиях)]
Saga:   [Verification: независимые L3 property-тесты (тесты-свойства)]
Saga:   [Integration: merge (слияние) + hard gate (жёсткий шлюз)]
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
| Discovery (исследование) | Идея → измеримая гипотеза (metric, target, kill criteria) | saga-kickstart |
| Complexity Gate (шлюз сложности) | Оценка: thin/modular/regulated/research → набор артефактов | senior-analyst |
| Formalization (формализация) | PRD + SRS (стиль, инварианты, порты) + UC/AC (contract-as-data) | product/architect/analyst |
| Planning (планирование) | Pattern B scaffold, conflict_keys, verification.ac tasks | saga-planner |
| Development (разработка) | Параллельные воркеры в worktrees (рабочих копиях), merge-lock (мьютекс слияния) | saga-worker |
| Verification (проверка) | Независимые property-тесты (тесты-свойства) из frozen AC (не Builder'овские) | saga-verifier |
| Integration (интеграция) | Hard gate (жёсткий шлюз): каждый AC имеет passing evidence | episode_transition |
| Observation (наблюдение) | Runtime-метрики → hit/kill решение | observation_record |

## Что saga НЕ даёт сделать

- Перейти в development без принятых AC (hard gate — жёсткий шлюз)
- Объявить done без passing evidence (deny-by-default — отказ по умолчанию)
- Изменить замороженный контракт mid-work (drift detection — детекция дрейфа)
- Двум воркерам ломать один файл (conflict_keys на planning time — этапе планирования)
- Агенту понизить risk чтобы обойти gate (P15 monotonicity — монотонность)
- Записать UNKNOWN/ERROR как PASS (4-valued verdict — 4-значный вердикт)
- Создать гипотезу без измерения (R16: observation required — требуется наблюдение)

## Проверка после установки

```bash
npm test                              # 163 теста green (зелёные)
node tools/cgad-spec-lint.mjs <db>    # 18 правил, read-only (только чтение)
ls ~/.zcode/skills/ | grep saga       # 13 skills (скиллов)
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

- [README.md](../README.md) — English overview (обзор на английском)
- [README.ru.md](../README.ru.md) — Русский обзор
- [История](saga-mcp-history.md) — полная эволюция (7 актов)
- [Research Charter](research/00-research-charter-v1-final.md) — тезис agent-oriented SE (агентно-ориентированной разработки)
- [ADR](architecture/decisions/) — архитектурные решения (Architecture Decision Records)
- [GUARDRAILS](../GUARDRAILS.md) — конституция (ограничения; Signs 001-009)

---

*Начни с `Skill("saga-start")` из пустой папки. Saga проведёт через весь цикл.*
