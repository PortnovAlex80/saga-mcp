# saga-mcp

Платформа управления параллельными LLM-агентами. SQLite, MCP-native, контракт-управляемый жизненный цикл эпизодов, enforcement-слой и продуктовый цикл (discovery → hit/kill).

**Не клон Jira.** saga-mcp не просто跟踪ивает задачи — она управляет полным циклом: от бизнес-гипотезы через архитектуру, требования, параллельную разработку, независимую верификацию, до наблюдения за runtime и решения (продолжать / закрыть).

---

> ## Происхождение форка
>
> Форк [spranab/saga-mcp](https://github.com/spranab/saga-mcp) (v1.6.0). Upstream — Jira-like MCP трекер. Этот форк добавляет:
> - **Диспетчер** (worker_next / worker_done / merge-lock) для оркестрации параллельных агентов
> - **Машина состояний эпизода** (7 стадий с hard gates: discovery→formalization→planning→development→verification→integration→completed)
> - **CGAD enforcement-слой** (Contract-Governed Agentic Development): 18 lint-правил, 4-значный вердикт, вычисление RiskClass, семантическая детекция конфликтов, runtime-наблюдения
> - **12 скиллов** (saga-start, saga-kickstart, saga-product, saga-architect, saga-analyst, saga-planner, saga-worker, saga-verifier, saga-orchestrator, saga-dispatch, saga-tracker, senior-analyst)
> - **14 типов артефактов**, **7 типов trace-связей**, **реестр Trusted Providers**
> - **Продуктовый цикл**: гипотеза → метрика → наблюдение → hit/kill
>
> Полная история: [docs/saga-mcp-history.md](docs/saga-mcp-history.md)

---

## Что делает saga-mcp

### Какую боль решает

Когда несколько LLM-агентов работают параллельно над одним проектом, они ломают друг друга:
- Два воркера независимо изобретают несовместимую архитектуру → merge-конфликт на архитектурном уровне
- Агент объявляет «готово» — тесты зелёные, но не покрывают критерий приёмки (AC)
- Никто не знает, на каком этапе проект
- Меняется замороженный контракт mid-work → downstream ломается молча

saga-mcp предотвращает всё это **механизмами, не дисциплиной**.

### Как это работает

```
ИДЕЯ (одна фраза)
   │
   ▼
1. DISCOVERY (saga-kickstart: 3 асессора, completeness-gate, decision-fork)
   │ → артефакт brief, решение ∈ {go, fast-track, clarify, reject}
   │ → Complexity Gate (senior-analyst: thin/modular/regulated/research → набор артефактов)
   ▼
2. FORMALIZATION (saga-product → saga-architect → saga-analyst)
   │ → PRD (с Гипотезами: метрика, baseline, target, kill-критерий)
   │ → SRS (Архитектурный стиль, Module Manifest, Invariant Registry, Port Registry, NFR Targets)
   │ → UC + AC (properties-блоки: YAML contract-as-data для L3 property-тестов)
   │ → RULE (бизнес-логика, enforced-by trace) + SPEC (механизм реализации)
   │ → Frozen Contract Snapshot (accepted_hash, drift detection)
   ▼
3. PLANNING (saga-planner)
   │ → Pattern B scaffold (замороженный контракт как заглушки)
   │ → conflict_keys_set + conflict_check (планирование-time детекция коллизий)
   │ → dev-задачи (implements AC) + verification.ac задачи (saga-verifier)
   ▼
4. DEVELOPMENT (рой saga-worker, параллельно в worktrees)
   │ → Каждый: claim → worktree → код + L2 тесты → merge-lock → done
   │ → RiskClass = max(declared, derived, policy) — агент не может сам понизить (P15)
   ▼
5. VERIFICATION (saga-verifier: независимые L3 property-тесты)
   │ → Читает замороженный AC-контракт (НЕ тесты Builder'а)
   │ → Генерирует Hypothesis/QuickCheck property-тесты из YAML properties-блока
   │ → verification_record({outcome, provider, test_layer})
   ▼
6. INTEGRATION (merge-lock, post-merge build check)
   │ → assertVerificationPassed: каждый AC должен иметь passing evidence с matching hash
   │ → Deny by default (P14): нет evidence = нет transition
   ▼
7. COMPLETED → post-launch observation
   │ → observation_record (benchmark/canary/incident/runtime_metric)
   │ → R16 lint: hypothesis должна иметь observation (продуктовый цикл замкнут)
   │ → hit/kill решение по метрике vs target
```

### Enforcement-слой (cgad-spec-lint v1.4.0)

18 детерминированных правил:

| Правило | Что ловит |
|---|---|
| R1 | Deny-by-default: evidence без provider, UNKNOWN/ERROR как PASS |
| R2 | P15 risk floor: final_risk < max(declared, derived, policy) |
| R3 | AC с implements, но без verified_by evidence |
| R4 | Greenfield эпизод без scaffold (Pattern B) |
| R5 | Семантическая коллизия: ≥2 задачи делят conflict key |
| R6 | Агент сам установил состояние без activity_log |
| R7 | Неатомарный переход эпизода |
| R8 | Замороженный контракт изменён (drift_state='drifted') |
| R9 | Self-approval: verifier == builder |
| R10 | Work package самодекомпозиция |
| R11 | Скрытое исключение без owner |
| R12 | Human approval как proof of correctness |
| R13 | SRS без verification.ac задач (invariant enforcement gap) |
| R14 | FR содержит forbidden implementation detail |
| R15 | RULE без enforced-by trace |
| R16 | Hypothesis без runtime observation (продуктовый gap) |
| R17 | AC ссылается на test fixture/framework (контракт загрязнён) |
| R18 | NFR смешивает determinism + real-clock timing |

### Ключевые примитивы

| Примитив | Назначение |
|---|---|
| Машина состояний эпизода | 7 стадий с hard gates, без пропусков |
| Frozen Contract Snapshot | accepted_hash + drift_state — никаких mid-work изменений контракта |
| 4-значный вердикт | passed / failed / unknown / error (deny-by-default) |
| RiskClass | max(declared, derived, policy) — агент не может сам понизить |
| Семантические conflict keys | file_path / schema / public_protocol / integration_branch |
| Runtime observations | Append-only, immutable, 3-я ось истины (Declared / Implemented / Observed) |
| Trusted Provider Registry | Deterministic Evidence / Authoritative State / Authorized Decision |
| Artifact types (14) | PRD, SRS, UC, AC, FR, NFR, RULE, SPEC, decision, brief, theme, OQ, hypothesis, business_metric |
| Trace link types (7) | covers, implements, implements_spec, derived_from, depends_on, verified_by, superseded_by |

---

## Архитектура

saga-mcp **НЕ заменяет** классическую архитектуру (SRP, Clean, Hexagonal, DDD).
Она строит **enforcement-слой** над ней: то, что человеческие команды делают через
code review и разговоры, saga делает через детерминированные guards и hard gates.

### Что выжило (подтверждено 6 adversarial critics)

- Малые cohesive файлы (150-500 LOC)
- SRP (Parnas change-propagation, не Miller 7±2)
- Hexagonal / Ports & Adapters
- Composition over inheritance
- Явные импорты, без dynamic metaprogramming

### Что меняется для agent-runtime

| Человеческая команда | saga-mcp enforcement |
|---|---|
| Code review ловит нарушения инвариантов | INVARIANCES.md + property-тесты (L3) + R13 lint |
| «Я помню где что лежит» | Artifact graph (saga DB), queryable, drift-detected |
| Standup координация | Frozen contract snapshot + conflict_keys (planning-time) |
| «Тесты зелёные = работает» | Independent Verifier: L3 property-тесты из frozen AC |
| «Вроде нормально» | 4-значный вердикт + deny-by-default |

См. [Research Charter](docs/research/00-research-charter-v1-final.md) — полный тезис
(7 research reports + 6 adversarial critics).

---

## Установка

### Требования

- Node.js 18+ (для better-sqlite3 native build)
- npm
- Git
- ZCode (или любой MCP-клиент)

### Шаг 1 — клонировать и собрать

```bash
git clone https://github.com/PortnovAlex80/saga-mcp.git
cd saga-mcp
npm install
npm run build
```

Проверка:
```bash
DB_PATH=./smoke.db node dist/index.js
# Должно вывести: Tracker MCP Server running on stdio
```

### Шаг 2 — зарегистрировать в ZCode

Редактировать `~/.zcode/cli/config.json`:

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

### Шаг 3 — установить скиллы

```bash
cp -r skills/* ~/.zcode/skills/
```

Перезапустить ZCode снова.

### Шаг 4 — smoke-тест

Из любой папки проекта:
```
Skill("saga-start")
```

---

## Скиллы

| Скилл | Роль | Когда |
|---|---|---|
| **saga-start** | Bootstrap проекта + repository binding | Первый запуск |
| **saga-kickstart** | Discovery: идея → brief → решение | Complexity gate, 3 асессора |
| **saga-product** | PRD с гипотезами | Formalization |
| **saga-architect** | SRS с Invariant Registry, Port Registry | Formalization |
| **saga-analyst** | UC + AC с properties-блоками | Formalization |
| **saga-planner** | Pattern B scaffold, dev-задачи, conflict_keys | Planning |
| **saga-worker** | Код + L2 тесты, merge-lock | Development |
| **saga-verifier** | Независимые L3 property-тесты из frozen AC | Verification |
| **saga-orchestrator** | Полный episode flow, Complexity Gate | Main context |
| **saga-dispatch** | Dispatch loop | Development fleet |
| **saga-tracker** | Bootstrap + правила очереди | Entry point |
| **senior-analyst** | Reference-методология (BABOK/Wiegers) | Загружается orchestrator'ом |

---

## Тестирование

```bash
npm test                    # 163 теста (tsc + node --test)
npm run cgad-lint -- <db>   # cgad-spec-lint v1.4.0 (18 правил)
```

## CI/CD

```bash
npx tsc --noEmit            # TypeScript strict (noUnusedLocals, noImplicitReturns)
npx eslint src/             # ESLint с @typescript-eslint
node tools/cgad-spec-lint.mjs <db>  # 18 детерминированных правил
```

GitHub Actions CI (`.github/workflows/ci.yml`): tsc strict + ESLint + npm test на каждый push/PR.

---

## Документация

- [История](docs/saga-mcp-history.md) — полная эволюция от форка до CGAD
- [CGAD spec](docs/architecture/cgad-v2-spec.md) — 1619-строчный target-state reference
- [Research Charter](docs/research/00-research-charter-v1-final.md) — тезис agent-oriented SE
- [Блог-пост](docs/blog-saga-mcp-agent-governance.md) — популяризация для обсуждения
- [ADR](docs/architecture/decisions/) — 005 (CGAD), 006 (Pattern B), 007 (convergence)
- [GUARDRAILS](GUARDRAILS.md) — Signs 001-009 (неформальная конституция)
- [cgad-spec-lint](tools/cgad-spec-lint.mjs) — 18 правил enforcement
- [SRS template](docs/requirements/templates/SRS.md) — 8 обязательных секций
- [AC template](docs/requirements/templates/acceptance-criteria.md) — contract-as-data
- [INVARIANCES template](docs/requirements/templates/INVARIANTS.md) — per-module инварианты

---

## Лицензия

MIT
