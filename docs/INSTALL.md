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
Saga:   [Formalization Part 1: PRD с гипотезой + FR/NFR/RULE → UC → AC → Reconcile (заморозка baseline_hash)]
Saga:   [Formalization Part 2: SRS ПОСЛЕ AC (стиль по сложности, §D DECOMP)]
Saga:   [Planning: planner = тупой копировщик §D2 (одна задача на AC)]
Saga:   [Development: рой воркеров в worktrees (рабочих копиях)]
Saga:   [Verification: независимые L3 property-тесты (тесты-свойства)]
Saga:   [Integration: merge (слияние) + hard gate (жёсткий шлюз)]
Saga:   ✅ Продукт готов
```

> Pipeline canonical order (ADR-014): `BRIEF → PRD(+FR/NFR/RULE) → UC → AC → Reconcile → SRS(+DECOMP) → Planning → Dev → Verify → Integrate`.

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

## Локальные модели (LM Studio) — маршрут отставлен

> **⚠️ Отставлено (директива оператора 2026-08-20).** Воркеры завода идут
> **только через opencode** (`SAGA_REAL_CLAUDE_PATH` →
> `tools/agent-proxy/claude-shim.mjs`, см. `ЗАВОД-ЗАПУСК.md` §1). Claude CLI
> и основанная на нём схема переключения на LM Studio (перезапись
> `~/.claude/settings.json`) больше не используются. Текст ниже оставлен как
> историческая справка о механизме; для локальной модели в мире opencode
> понадобился бы её провайдер в конфиге opencode — в производственную
> директиву это не входит.

Исторически: по умолчанию воркеры saga идут на облачные модели Z.ai (подписка).
Чтобы было можно гонять
воркеров на **локальной модели через LM Studio** — без подписки, бесплатно:

1. **Запустите LM Studio**, загрузите модель (например `qwen/qwen3-4b-2507`),
   включите сервер на порту `1234` (вкладка Developer → Start Server).
2. Откройте канбан `http://localhost:4321`.
3. В селекторе моделей (правый верх) выберите группу **«LM Studio (локально)»**
   → конкретную модель. Список моделей подтягивается автоматически из LM Studio
   через `GET /v1/models`. Если LM Studio выключен — группа покажет
   «офлайн», а опция `↻ обновить список` перезапросит список после запуска.
4. Запустите движок эпизода. **Новые** воркеры пойдут на локальную модель;
   активные доработают на старой.

**Как это работает.** LM Studio отдаёт Anthropic-совместимый эндпоинт `/v1/messages`.
saga переключает claude CLI воркера на него через перезапись
`~/.claude/settings.json` (шаблоны `settings.cloud.json` ↔ `settings.lmstudio.json`,
атомарно + fsync + readback). В claude CLI v2 spawn-env `ANTHROPIC_BASE_URL`
больше не перекрывает settings.json (регрессия anthropics/claude-code#8500),
поэтому на время эпизода **весь claude на машине** идёт через LM Studio.
Облачный токен заморожен в `settings.cloud.json` и не теряется.

**Preflight: saga MCP-сервер обязан загружаться.** Каждый воркер спавнит
`node dist/index.js` как приватный stdio-MCP-child. Если сервер не грузится —
воркер молча теряет ВСЕ saga-инструменты (видит только Bash/Read/Edit), сжигает
бюджет на реверс-инжиниринг `product_submit` и умирает без сабмита. В панели
клиента то же самое выглядит как `MCP error -32000: Connection closed` /
`0 tools`. `node_modules` и скиллы клиента НЕ обновляются вместе с
`git pull`: новая зависимость в package.json убивает загрузку с
`ERR_MODULE_NOT_FOUND: Cannot find package '@modelcontextprotocol/sdk'`, а
установленные скиллы (`~/.zcode/skills/`) молча дрейфуют от репо. Поэтому
после каждого pull — полный триплет:

```bash
npm install && npm run build
cp -r skills/* ~/.zcode/skills/     # синк операторских скиллов (перезапусти сессию клиента)
DB_PATH=<db> TRACKER_AUTOSTART=0 node dist/index.js   # смоук: баннер + живёт, не падает
```

**Гонка нового заказа.** Оба стартовых пути (`factory.mjs start`,
`POST /api/factory/start`) записывают профиль по умолчанию в
`lifecycle_execution_controls` и сразу спавнят движок — первый claim может
заморозиться на нём до переключения селектора. Если это случилось: убить
воркера нецелевого профиля и движок, затем `node scripts/factory.mjs resume
<db>` без флагов — supervision пометит воркера `lost`, и task перезаклеймится
на целевую модель. Подробности: `ЗАВОД-ЗАПУСК.md` §4 (единая opencode-only
инструкция; с бывш. `docs/FACTORY-START-QUICKSTART.md` слит 2026-08-20).

**Prerequisite: модель должна принимать system-сообщения в середине диалога**
(Claude Code шлёт их после tool-результатов). У ряда локальных моделей Jinja
шаблон кидает `System message must be at the beginning.` → LM Studio отдаёт
500, причём **GUI эти ошибки не показывает**. Симптом в логе воркера: 10×
`api_retry error_status 500`, затем exit code 1. Процедура патча (Qwen 3.6 и
почему патч hub `model.yaml` не действует для GGUF-вшитых шаблонов) — в
`CLAUDE.md` → «LM Studio: Qwen 3.6 chat template patch».

**Нестандартный адрес LM Studio.** Если LM Studio на другом хосте/порту — задайте
env перед запуском saga-mcp:
```bash
SAGA_LMSTUDIO_URL=http://192.168.1.10:1234/v1  # вместо дефолта localhost:1234
```
Это читается один раз при старте tracker-view.

**Переключение обратно на облако.** Выберите любую модель из группы «Z.ai (облако)»
в том же селекторе — saga запатчит `~/.claude/settings.json` для новых воркеров,
старые доработают локально.

## Что saga делает автоматически

## Что saga делает автоматически

| Этап | Что происходит | Кто |
|---|---|---|
| Discovery (исследование) | Идея → измеримая гипотеза (metric, target, kill criteria) | saga-kickstart |
| Complexity Gate (шлюз сложности) | Оценка: thin/modular/regulated/research → набор артефактов | senior-analyst |
| Formalization Part 1 (ЧТО) | PRD (+FR/NFR/RULE) → UC → AC (contract-as-data) → Reconcile (заморозка baseline_hash) | product/analyst/reconciler |
| Formalization Part 2 (КАК) | SRS ПОСЛЕ AC: стиль по таблице сложности, инварианты, порты, §D DECOMP (per-AC map) | saga-architect |
| Planning (планирование) | Planner = тупой копировщик §D2: одна задача на AC с file_path/schema/conflict_keys | saga-planner |
| Development (разработка) | Параллельные воркеры в worktrees (рабочих копиях), merge-lock (мьютекс слияния) | saga-worker |
| Verification (проверка) | Независимые property-тесты (тесты-свойства) из frozen AC (не Builder'овские) | saga-verifier |
| Integration (интеграция) | Hard gate (жёсткий шлюз): каждый AC имеет passing evidence | episode_transition |
| Post-integration (пост-интеграция) | README продукта + инструкция + проектные скиллы (release, QA) | saga-orchestrator |
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
