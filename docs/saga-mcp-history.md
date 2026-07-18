# saga-mcp: От форка до Contract-Governed Agentic Development (CGAD)

> История создания системы управления параллельными LLM-агентами.
> От Jira-like трекера до enforcement-платформы (платформы принуждения к соблюдению контрактов) для agent-oriented software engineering (агентно-ориентированной разработки ПО).
> Рабочая статья, не публикация.

---

## Акт I. Форк

Всё началось с [spranab/saga-mcp](https://github.com/spranab/saga-mcp) — Jira-like MCP-сервера для AI-агентов. 31 тулза: projects, epics, tasks, subtasks, comments, notes, templates, dashboard, export/import. SQLite-backed, per-project scoped, self-contained.

Это был хороший трекер. Но он был пассивным — агенты должны были сами решать, какую задачу брать. Не было диспетчера, не было очереди, не было изоляции работы.

Форк (`PortnovAlex80/saga-mcp`) добавил одну вещь: **dispatcher** (диспетчер). Две тулзы — `worker_next` и `worker_done` — превратили saga из пассивного трекера в активную очередь работ. Агент вызывает `worker_next({project_id, worker_id})` и получает одну задачу. Не две, не ноль — ровно одну. Атомарно, через `BEGIN IMMEDIATE`, с conditional UPDATE.

Эта двойственная природа — пассивный трекер + активный диспетчер — определила всё, что случилось потом.

---

## Акт II. Боль

Первые smoke-тесты выявили паттерн, который стал известен как **GUARDRAILS Sign 002**:

> N воркеров стартуют одновременно на пустом репозитории. Каждый создаёт свой scaffold: package.json, tsconfig.json, App.tsx. Merge → add/add конфликт на всех общих файлах. REQ-001: 3/4 задач в конфликте.

Это была первая встреча с болью, которая определила всю дальнейшую эволюцию: **параллельные агенты ломают друг друга**.

Git merge ловит line-level конфликты. Но архитектурный конфликт — когда два воркера независимо изобретают несовместимую структуру — git не ловит. `add/add` на package.json это не строковый конфликт, это конфликт **архитектурных решений**.

Решение пришло из инженерной практики: **Pattern B (scaffold-then-parallel — каркас-затем-параллельно)**. Первая задача (scaffold) создаёт структуру: API контракты, stub-функции (функции-заглушки), конфигурацию. Все остальные задачи `depends_on` scaffold и реализуют тела против замороженного контракта. REQ-002: 0/3 конфликтов. REQ-004: 0/9.

Pattern B работал. Но он был **opt-in** (опциональным) — планировщик должен был его выбрать. Если brief не указывал `topology_hint: 'scaffold-then-parallel'`, воркеры расходились без scaffold и ломали друг друга.

---

## Акт III. CGAD — формализация интуиции

К этому моменту saga-mcp имела:
- Episode state machine (машина состояний эпизода: 7 стадий с hard gates — жёсткими шлюзами)
- Frozen Contract Snapshot (замороженный снимок контракта: accepted_hash + drift_state)
- Verification evidence (доказательства проверки: passed/failed)
- Worktree isolation (изоляция рабочей копии: task/<id> ветки, merge-lock — мьютекс слияния)
- 9 GUARDRAILS Signs — informal constitution (неформальная конституция)

Это работало, но lacked naming (не хватало именования). Каждый элемент был изобретён ad-hoc (на ходу), реагируя на конкретную боль. Не было теории.

CGAD v2 (Contract-Governed Agentic Development — управление разработкой через контракты) — это 1619-строчный спецификационный документ, который формализовал то, что saga уже делала интуитивно, и назвал то, чего не хватало:

- **P14 Deny by default (отказ по умолчанию)** → `assertVerificationPassed` (уже было)
- **§15 Frozen Contract Snapshot (замороженный снимок контракта)** → `accepted_hash` + `drift_state` (уже было)
- **§22 §34 Git conflict ≠ only detector (git-конфликт — не единственный детектор)** → Pattern B (уже было, но не enforced — не принуждалось)
- **§7 4-valued guard verdict (4-значный вердикт проверки)** → passed/failed (только 2 значения, gap — пробел)
- **§11 RiskClass (класс риска)** → priority (manual label — ручная метка, не computed — не вычисляется, gap)
- **§17 Runtime Observation Store (хранилище наблюдений за runtime)** → absent (отсутствует, gap)

ADR-005 принял CGAD как target-state reference (целевое состояние). Не как инструкцию к исполнению — 14-фазный CGAD bootstrap (начальная загрузка) невыполним. Как **карту пробелов**: что есть, чего нет, что важно.

---

## Акт IV. Convergence (сходимость) — закрытие шести пробелов

Шесть REQ эпизодов закрыли пробелы ADR-005 Roadmap (дорожной карты):

**REQ-008: 4-valued guard verdict (4-значный вердикт проверки).** `verification_evidence.outcome` расширен с {passed, failed} до {passed, failed, unknown, error}. Unknown = входов недостаточно (deny — отказ). Error = provider упал (deny + Incident). Provider column добавлен для CGAD §6 Trusted Guard Input Provider identity (идентичности доверенного провайдера входов проверки).

**REQ-009: RiskClass computation (вычисление класса риска).** Четыре колонки (declared_risk, derived_risk, policy_minimum, final_risk) с `final_risk = max(declared, derived, policy)`. Агент не может понизить derived или policy ниже текущего значения — monotonicity guard (монотонность, P15 enforcement). Risk auto-derived из tags: security → critical, data → high.

**REQ-010: Semantic Conflict Model (модель семантических конфликтов).** `task_conflict_keys` table + 5 MCP tools. Typed keys: file_path, schema, public_protocol, integration_branch. `conflict_check` находит коллизии на planning time (этапе планирования), до запуска воркеров. Это прямое решение Sign 002 — конфликты теперь детектируются до git merge.

**REQ-011: Runtime Observation Store (хранилище наблюдений за runtime).** `runtime_observations` table — append-only (только добавление), immutable (неизменяемый). observation_type: benchmark/canary/shadow/incident/runtime_metric. Третья ось истины (CGAD §4): Declared (AC), Implemented (evidence), Observed (runtime). Observation не может менять acceptance oracle (P17 enforced structurally — нет UPDATE path).

**REQ-012: Full cgad-spec-lint (полный линтер).** 13 правил покрывают 12 из 25 запрещённых конструкций CGAD §22. Linter v1.2.0 — детерминированный Node-скрипт, read-only (только чтение), не мутирует БД. Правила: deny-by-default (отказ по умолчанию), P15 risk floor (нижняя граница риска), verified_by gap (пробел верификации), Pattern B enforcement (принуждение), semantic collisions (семантические коллизии), agent self-set state (самоустановка состояния агентом), non-atomic transition (неатомарный переход), frozen contract drift (дрейф замороженного контракта), self-approval (самоодобрение), self-decomposition (самодекомпозиция), hidden exception (скрытое исключение), human-approval-as-proof (человеческое одобрение как доказательство), invariant enforcement (принуждение к инварианту).

**REQ-013: Pattern B default (Pattern B по умолчанию).** cgad-spec-lint R4: greenfield episode с ≥2 параллельными задачами без scaffold → error. Принудительно направляет планировщик на Pattern B для greenfield эпизодов.

Каждый REQ прошёл через собственный saga flow: discovery → formalization → planning → development → verification → integration → completed. Saga использовала саму себя для развития.

---

## Акт V. Исследование — нужна ли другая архитектура?

После convergence (сходимости) возник фундаментальный вопрос: **должна ли измениться сама архитектура кода, когда исполнители — LLM-агенты, а не люди?**

Была запущена исследовательская программа:
- **7 параллельных отчётов**: GoF паттерны, литература, TOGAF/DDD/Clean, test pyramid (пирамида тестирования), industry essays (отраслевые эссе), thought leaders (лидеры мнений), Face/Body precedents (прецеденты)
- **6 параллельных критиков**: классик-консерватор, эмпирический скептик, практик Cursor, seL4-пурист, DDD-традиционалист, type-theorist (теоретик типов)

### Что пало

- «SRP заточен под Miller 7±2» — SRP это Parnas change-propagation (оси распространения изменений), не working memory (рабочая память)
- «Большие файлы для большого контекста» — Lost-in-the-Middle (потеряно в середине) убивает, индустрия за small files (малые файлы)
- «Face replacing imports» — Python не имеет runtime mediator (посредника времени выполнения)
- «Constellation Module = новая архитектура» — это Hexagonal + registry (реестр)

### Что выжило — главный вклад

> **Классическая архитектура говорит про инварианты постоянно и enforce'ит (принуждает соблюдать) их почти никогда. Это — gap (пробел), который saga-mcp закрывает.**

Не новая архитектура. **Durable enforcement layer (долговечный слой принуждения)**: machine-checked invariants (машинно-проверяемые инварианты), generated discovery surfaces (генерируемые поверхности обнаружения), independent verification (независимая проверка), planning-time conflict detection (обнаружение конфликтов на этапе планирования). Saga-mcp — инфраструктура этого слоя.

### Эмпирическое подтверждение

После исследования был проведён аудит кода самой saga. Найдено: **P15 enforcement был заявлен в комментариях, но не имел механизма** — монотонности guard отсутствовал. Ровно тот дефект, который research charter критиковал в классической архитектуре, был воспроизведён в собственном enforcement-коде.

Это одновременно:
1. Эмпирическое подтверждение тезиса (даже зная об invariant enforcement gap (пробеле принуждения к инварианту), мы его воспроизвели)
2. Доказательство ценности enforcement layer (audit нашёл его, fix закрыл)
3. Хороший материал для статьи

---

## Акт VI. Усиление скиллов

Исследование показало: saga-architect и saga-analyst не направляют систему в конкретный архитектурный стиль и не требуют машино-проверяемых инвариантов.

Были обновлены:
- **saga-architect**: требует Architectural Style declaration (объявление архитектурного стиля), Module Manifest с conflict-key surface (поверхностью ключей конфликтов), Invariant Registry (реестр инвариантов), Port Registry (реестр портов), Test Strategy L0-L4 (стратегия тестирования), NFR Capacity Targets (целевые показатели нефункциональных требований)
- **saga-analyst**: требует properties блок (YAML contract-as-data — контракт как данные) для алгоритмических AC — Verifier генерирует L3 property tests (тесты-свойства) из frozen контракта
- **SRS template (шаблон)**: 8 обязательных секций (было 5)
- **AC template (шаблон)**: YAML contract-as-data с inputs/outputs/examples/properties/operational

Эксперимент (water-cannon smoke-test) подтвердил: **скиллы работают**. Архитектор пишет Invariant Registry (7 формальных предикатов), аналитик превращает их в properties блок, planner создаёт verification.ac задачи. Когда скилл говорит «MUST list every invariant (ОБЯЗАНО перечислить каждый инвариант)» — архитектор пишет 7 формальных предикатов. Не от себя — потому что скилл требует.

---

## Акт VII. Текущее состояние и что дальше

### saga-mcp сегодня

- **136 тестов green (зелёных)** (было 83 до начала работ)
- **13 cgad-spec-lint правил** (было 3)
- **15 таблиц SQLite** (было 9)
- **~50 MCP tools** (было 31 базовый + 2 dispatcher = 33)
- **10 skills (скиллов)** (saga-start, saga-kickstart, saga-product, saga-architect, saga-analyst, saga-planner, saga-worker, saga-orchestrator, saga-dispatch, saga-tracker)
- **3 ADR** (005-007)
- **9 GUARDRAILS Signs (ограничений)** (constitution v0 — конституция v0)
- **17 research documents (исследовательских документов)** (7 отчётов + 6 критиков + charter + blog post + skeleton)

### Что не сделано (roadmap — дорожная карта)

1. **Trusted Provider Registry (реестр доверенных провайдеров)** — `trusted_providers` table с category/trust_basis/determinism/scope/layer. Linters/SAST/security как first-class Guard Input Providers (провайдеры входов проверки первого класса; L0-L4).
2. **Independent Verifier (независимый проверяющий)** — отдельный skill/mode: читает AC + contract-as-data, генерирует L3 property tests (тесты-свойства) из frozen контракта, НЕ из Builder'овского тест-файла.
3. **test_layer field (поле test_layer)** — L0/L1/L2/L3/L4 на verification_evidence. Lint: AC с verified_by только на одном слое → warning.
4. **Generated Faces via SCIP (генерируемые фасеты через SCIP)** — SCIP-compatible indexer в CI, генерирует symbol graph (граф символов) из AST. Workers запрашивают Faces (фасеты) через saga DB, не через grep.
5. **Refinement types (уточняющие типы)** (future direction — направление будущего, type-theorist recommendation — рекомендация теоретика типов) — Liquid Haskell / F* для L0 invariant checking (проверки инвариантов). Продвигает «protects» с L3 (property-tested) на L0 (compile-time certain — определённость на этапе компиляции).

---

## Главная мысль

**saga-mcp не заменяет классическую архитектуру.** SRP, Clean Architecture, Hexagonal, DDD — всё работает. Агенты работают лучше на классическом коде, не хуже.

Saga-mcp строит **enforcement layer (слой принуждения) над кодом**: то, что человеческие команды делают через code review (ревью кода), разговоры и «я помню где что лежит» — становится machine-mediated (машинно-опосредованным), когда исполнители stateless (без состояния), изолированы и не могут договориться.

Каждый элемент enforcement layer — ответ на конкретную LLM-failure mode (режим отказа LLM):

| LLM failure mode (режим отказа) | saga-mcp enforcement (принуждение) |
|---|---|
| Selective memory (избирательная память) между сессиями | completeness-gate (шлюз полноты) |
| Меняет контракт под себя mid-work (в процессе работы) | accepted_hash + drift_state |
| Объявляет «готово» преждевременно | hard gates (жёсткие шлюзы) на episode_transition |
| Угадывает молча, без матрицы решений | decision-matrix ≥3×≥2 в kickstart |
| Не помнит project_id / что дальше | stop:true + projectname.txt |
| Видит чужие задачи, путается | role: теги + worker_next role filter (ролевой фильтр) |
| Воркеры не договариваются голосом | Pattern B scaffold + conflict_keys |
| Трактует «не знаю» как «наверное ок» | 4-valued verdict (4-значный вердикт: passed/failed/unknown/error) |
| Понижает risk чтобы обойти gate | RiskClass max() + P15 monotonicity guard (монотонность) |
| Git — единственный детектор конфликта | task_conflict_keys + conflict_check + R5 |
| Не наблюдает runtime, только код | runtime_observations (3rd truth axis — третья ось истины) |
| Доверяет LLM-reasoning как guard input | cgad-spec-lint 13 правил (детерминированный) |

Это не процесс. Это **среда, спроектированная под исполнителя с амнезией и pattern-matching (поиском по образцу)**.

---

## Принцип

> Классическая архитектура выживает. saga-mcp строит над ней слой контроля:
> то, что человеческие команды делают через code review (ревью кода) и разговоры —
> становится машинным, когда исполнители не имеют памяти между сессиями.

---

*Harmess workspace, 2026-07-17. Рабочая статья для внутреннего обсуждения.*
