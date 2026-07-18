# Agent-Oriented Software Engineering: что меняется, а что нет

> Рабочий блог-пост для обсуждения. Не публикация — идея для дискуссии.
> Основан на Research Charter v1.0, прошедшем adversarial review (сопоставительном обзоре; 7 research reports + 6 критиков с разными идеологическими позициями).

---

## TL;DR (краткая выжимка)

Мы исследовали вопрос: **должна ли измениться архитектура ПО, когда код пишут LLM-агенты, а не люди?** После 7 исследовательских отчётов и 6 критиков с противоположными позициями, ответ:

**Код — нет. Small files (малые файлы), SRP, Clean Architecture, Hexagonal, DDD — всё работает.** Агенты работают лучше на классическом коде, не хуже.

**НО enforcement-слой (слой принуждения) над кодом — да, радикально.** То, что человеческие команды делают через code review (ревью кода), разговоры и «я помню где что лежит» — должно стать machine-mediated (машинно-опосредованным), когда исполнители stateless (без состояния), изолированы и не могут договориться.

---

## С чего началось

У нас есть saga-mcp — MCP-сервер, управляющий параллельными LLM-агентами (воркерами в git worktree — рабочих копиях; мерж через lock — блокировку слияния; episode state machine — машина состояний эпизода с hard gates — жёсткими шлюзами). Мы провели convergence (сходимость) к концепту CGAD (Contract-Governed Agentic Development): 4-valued verdict (4-значный вердикт), RiskClass computation (вычисление класса риска), semantic conflict detection (обнаружение семантических конфликтов), runtime observation store (хранилище наблюдений за временем выполнения), 12-правильный linter.

После этого возник вопрос: **а сам код тоже должен быть другим?** Если классическая архитектура (SRP, Clean, DDD, GoF) оптимизирована под человека — не нужна ли новая архитектура под agent-runtime (агентное время выполнения)?

## Что мы сделали (методология)

Запустили параллельно 7 исследовательских агентов:

1. **GoF revisited (пересмотр GoF)** — все 23 паттерна под parallel-agent runtime
2. **Literature scan (обзор литературы)** — что опубликовано про architecture for agents
3. **TOGAF/DDD/Clean** — как классические фреймворки деформируются
4. **Test pyramid (пирамида тестирования) + tooling (инструментарий)** — linters/SAST/security как Trusted Providers (доверенные провайдеры)
5. **Industry essays (отраслевые эссе)** — OpenAI/Anthropic/Cognition/Aider
6. **Thought leaders (лидеры мнений)** — Fowler/Evans/Uncle Bob/Newman/Cockburn/Henney/Booch
7. **Precedents (прецеденты)** — WIT/seL4/OCaml/Actor/Luna/SCIP

Потом — **6 критиков с жёсткими, различными бриефами**: классик-консерватор, эмпирический скептик, практик Cursor, seL4-пурист, DDD-традиционалист, type-theorist (теоретик типов). Каждый читал отчёты и должен был либо сломать тезис, либо усилить.

Это не «найди подтверждение». Это «выживет ли тезис под ударом с каждой стороны».

---

## Что пало (честно)

### «SRP заточен под Miller 7±2»

**Миф.** SRP (Uncle Bob, через Parnas 1972) — про change-propagation axes (оси распространения изменений): разные стейкхолдеры меняют код по разным причинам, декомпозируй так, чтобы изменение в одной ответственности не заставляло перепроверять другие. Это про coupling-and-cohesion (связность-и-сцепление), не про chunking memory (фрагментацию памяти).

LLM с 2M-окном всё равно выигрывает от SRP: модуль с N reasons-to-change (причинами для изменения) в N раз чаще оказывается в зоне конфликта параллельных агентов.

### «Большие файлы для большого контекста»

**Опровергнуто трижды.** Идея была: LLM имеет 100K-2M токенов, дай ему большой cohesive блок (связный блок), чтобы не было transitions (переходов) между файлами. Три независимых факта её убили:

- **Lost-in-the-middle (потеряно-в-середине)** (Liu et al., TACL 2024): U-shaped recall (U-образное вспоминание) — LLM хуже всего работает в середине большого контекста
- **AGENTS.md hurts (вредит)** (Raschka, ETH Zurich): добавление контекст-файлов может **снизить** success rate (уровень успеха) агента на 20%+
- **Индустрия единогласна**: практики Cursor, r/cursor, Simon Willison — малые файлы 150-500 LOC работают лучше

**Вывод:** small cohesive files (малые связные файлы) + generated symbol index (генерируемый индекс символов: Aider repomap, Cursor indexing, Sourcegraph SCIP) — вот что работает.

### «Face/Body = новая архитектура»

**Переоткрытие Hexagonal.** Cockburn 2005: Ports = discovery surface (порты = поверхность обнаружения), Adapters + Application = body (адаптеры + приложение = тело). Constellation Architecture = то же самое + индекс портов в БД. Конвергентное переоткрытие — это не новизна, это рекомендация использовать Cockburn правильно и добавить CI step (шаг CI).

### «Face replacing imports»

**Непрактично.** Python/JS/TS не имеют runtime mediator (посредника времени выполнения). `importlib.import_module("anything")` — ambient authority (фоновые полномочия), который Face не может ограничить. Получаются две системы зависимостей (imports + saga graph), которые будут расходиться.

### «Face as type (как OCaml signature)»

**Face = spec (спецификация), не type (тип).** ML signatures проверяются компилятором: существует decision procedure (процедура разрешения), которая отвергает несоответствующие программы. Face — это markdown/YAML, и R19 (lint) — это name-presence matching (сопоставление по наличию имени), не type checking (проверка типов). Чтобы стать type, нужен refinement-type checker (чекер уточняющих типов; Liquid Haskell/F*) — future direction (направление будущего), не текущее состояние.

---

## Что выжило (и это главное)

### 1. Инварианты должны быть machine-enforced (машинно-принуждаемы), а не просто декларированы

**Это главный выживший тезис.** Все 6 критиков, даже самые враждебные, согласились с одним:

> «Классическая архитектура говорит про invariants (инварианты) постоянно и enforce'ит (принуждает соблюдать) их почти никогда» (Critic #1, classical defender — классический защитник)

> «Это enforcement (принуждение), которого DDD-практики ждали 15 лет и никогда не имели» (Critic #5, DDD traditionalist — DDD-традиционалист)

> «Если свернуть до INVARIANTS.md на модуль + lint правило, проверяющее покрытие тестами — я бы попробовал» (Critic #3, practitioner — практик)

**Что это значит:** Hexagonal/DDD/Clean объявляют инварианты в комментариях, wiki, на review (ревью). Но нет machine-checking (машинной проверки). saga-mcp закрывает этот gap (пробел): инвариант → property test (тест-свойство, L3) → Trusted Guard (доверенный страж) → `verification_evidence(outcome=passed)`. Без этого переход development→verification не проходит.

### 2. Stateless execution (выполнение без состояния) требует durable state (долговечного состояния)

LLM-агент не имеет памяти между сессиями. Всё, что не вынесено во внешнее состояние, потеряно. saga-mcp уже реализовала 12 элементов durable-state инфраструктуры (инфраструктуры долговечного состояния): frozen baseline (замороженный базовый уровень), drift detection (детекция дрейфа), typed provenance (типизированное происхождение), hard gates (жёсткие шлюзы), 4-valued verdict (4-значный вердикт), conflict keys (ключи конфликтов), observation store (хранилище наблюдений). Это **не меняет архитектуру кода** — это инфраструктура поверх неё.

### 3. Artifact graph (граф артефактов) — queryable provenance layer (запрашиваемый слой происхождения)

Не замена imports — **параллельный слой tracability (трассируемости)** (как INCOSE Requirements Traceability Matrix — матрица трассируемости требований, но для кода). Когда stateless worker стартует, он не помнит «модуль A зависит от модуля B». Он запрашивает saga DB: `trace_list({source_id: A, link_type: 'consumes'})`. БД отвечает Face (фасетом) модуля B. Worker работает. Imports остаются — saga graph делает зависимости видимыми для stateless-execution.

### 4. Property tests (тесты-свойства, L3) эффективнее example tests (примеров, L2) для agent-written code (кода, написанного агентом)

LLM пишет тесты против LLM-написанного кода. Оба могут ошибаться одинаково → тесты проходят, система неправильная. Property test (Hypothesis/QuickCheck) выражает **инвариант** (монотонность, положительность, идентичность), не пример. Неправильная реализация должна удовлетворять инварианту для всех входов, а не для 5 примеров, которые тот же агент выбрал.

**Но:** property tests работают только для алгоритмических AC (формулы, инварианты). Для UI-тестов — example/E2E остаются единственным вариантом. Пирамида не сдвигается uniformly (равномерно) — она bifurcates (раздваивается).

### 5. Generated Faces (генерируемые фасеты; SCIP-совместимые), не hand-authored (написанные вручную)

Критик #3 (практик) был прав: hand-maintained Face (фасет, поддерживаемый вручную) на модуль — это AGENTS.md rot (гниение AGENTS.md) на новом уровне. Решение: Face **генерируется** из AST через SCIP-совместимый indexer (как Sourcegraph). Человек пишет только:
- `INVARIANTS.md` (10 строк: инварианты, которые модуль защищает)
- Структурированные секции SRS (Port Registry — реестр портов, Aggregate invariants — инварианты агрегата, UL glossary — глоссарий единообразного языка)

Generated Face = discovery surface (поверхность обнаружения; бесплатный, всегда свежий). Authored INVARIANTS.md = enforcement target (цель принуждения; минимальный, стабильный).

### 6. Independent Verifier (независимый проверяющий) — не re-run Builder'овских тестов

Текущий verification.ac в saga greps Builder-written test и re-runs. Это Builder evidence (доказательство строителя) под Verifier hat (под шляпой проверяющего; CGAD §9 forbidden — запрещено). Реальное решение:
- Verifier читает AC + contract-as-data (контракт как данные; frozen — замороженный)
- Verifier генерирует **свой** L3 property test (другой слой, другая директория)
- Verifier не смотрит Builder'овский test файл

Для solo-worker (соло-воркера) это даёт structural independence (структурную независимость: разный слой, разная директория, разный generated test). Для multi-worker — полную independence (независимость; разный агент).

---

## Что классические фреймворки дают saga-mcp

Исследование (Report 03) показало: saga-mcp **независимо переоткрыла** 80% классики, под другими именами:

| Классика | saga-mcp (уже было) |
|---|---|
| DDD Context Mapping (отображение контекстов) | conflict_key types (типы ключей конфликтов: file_path, schema, public_protocol) |
| Hexagonal scaffold (каркас Hexagonal) | Pattern B (scaffold-then-parallel) |
| DDD Aggregate boundary (граница агрегата) | worktree isolation (изоляция рабочей копии) + conflict detection (обнаружение конфликтов) |
| Clean Architecture Dependency Rule (правило зависимостей) | accepted_hash + drift_state |
| TOGAF Phase G compliance (соответствие фазе G) | episode_transition hard gates (жёсткие шлюзы перехода эпизода) |
| TOGAF Transition Architecture (переходная архитектура) | multi-episode roadmap (дорожная карта нескольких эпизодов: REQ-008→013) |

Что классика **добавляет**: naming and typing discipline (дисциплина именования и типизации). Saga делает имплицитно то, что DDD/Hexagonal prescribe (предписывают) эксплицитно. Называя вещи правильно, мы получаем queryable artifacts (запрашиваемые артефакты; а не grep'ы) и lint rules (правила линтера; а не review checklist — чек-лист ревью).

---

## Главная дискуссионная точка

**Меняется ли архитектура под агентов?**

Два лагеря в индустрии:

1. **«Правила те же»** (Uncle Bob, Henney): SRP/Clean/GoF не зависят от исполнителя. Bottleneck (узкое место) сдвигается от typing (ввода) к знанию паттернов.

2. **«Эшафоды поверх»** (Fowler, OpenAI harness — оснастка OpenAI): классика работает, но нужны harnesses (оснастки) — feedforward guides (направляющие прямой связи), feedback sensors (сенсоры обратной связи), scaffolded contracts (каркасные контракты).

**Наше исследование предлагает третий путь:**

3. **«Enforcement layer (слой принуждения)»**: классика работает на уровне кода. Но enforcement (принуждение) инвариантов, который человеческие команды делают через social process (социальный процесс), должен стать machine-mediated (машинно-опосредованным) для stateless parallel агентов. saga-mcp — инфраструктура этого слоя.

Разница с подходом Fowler: Fowler строит harnesses **вокруг** процесса (sensors, guides — сенсоры, направляющие). Мы строим enforcement **внутри** pipeline (конвейера: invariant registry — реестр инвариантов → Trusted Guard — доверенный страж → hard gate — жёсткий шлюз). Fowler's harnesses помогают агенту; saga's enforcement **не пускает** агента дальше, если инвариант не проверен.

---

## Практические следствия для saga-mcp

Что мы строим дальше (roadmap — дорожная карта):

1. **`INVARIANTS.md` convention (соглашение)** — на критический модуль, ~10 строк, human-authored (написанный человеком). Lint: каждый инвариант → property test существует.

2. **Contract-as-data (контракт как данные) в AC** — saga-analyst пишет `properties:` block (YAML) для алгоритмических AC: монотонность, положительность, идентичность. Verifier генерирует L3 тесты из этого блока.

3. **Generated Faces via SCIP (генерируемые фасеты через SCIP)** — saga-mcp CI emits (выпускает) symbol graph (граф символов) из AST. Workers запрашивают Faces через saga DB, не через grep.

4. **Trusted Provider Registry (реестр доверенных провайдеров)** — `trusted_providers` table: ESLint (L0), Semgrep (L1), pytest (L2), hypothesis (L3), pytest-benchmark (L4). Provider не free-form string (произвольная строка), а зарегистрированный с trust_basis (основанием доверия) и determinism (детерминированностью).

5. **`test_layer` field (поле test_layer)** на verification_evidence — L0-L4. Lint: AC с verified_by только на одном слое → warning (предупреждение; вероятно Verifier переиспользовал Builder'овский тест).

---

## Что НЕ делаем (честно)

- ❌ Не меняем структуру файлов (small files — малые файлы — остаются)
- ❌ Не заменяем imports saga-graph'ом (параллельный слой, не замена)
- ❌ Не создаём «Constellation Module» как новый артефакт (= Hexagonal module)
- ❌ Не требуем hand-authored Face (фасета, написанного вручную) на каждый модуль (генерируем через SCIP)
- ❌ Не претендуем на «новую архитектуру» (мы — enforcement layer над классикой)

---

## Открытые вопросы для обсуждения

1. **Должен ли saga-architect требовать DDD Bounded Context declaration (объявление ограниченного контекста DDD) в SRS?** Или BC (Bounded Context) = module = repository binding (как сейчас)?

2. **Как заставить property tests (тесты-свойства) работать для stateful систем (систем с состоянием)?** Hypothesis stateful, PropEr parallel — нужны ли они в saga ACs?

3. **Event Storming (шторминг событий) под agent-runtime?** Как LLM-архитектор может «интервьюировать» domain expert (эксперта предметной области)? Нужен ли saga-kickstart → domain-discovery (обнаружение предметной области) шаг?

4. **Refinement types (уточняющие типы) как future direction (направление будущего)?** Liquid Haskell / F* для L0 invariant checking (проверки инвариантов на L0) — реально ли это для Python/TypeScript?

5. **Стоит ли делать empirical experiment (эмпирический эксперимент)?** Взять water-cannon, прогнать под Constellation vs classical SRP, замерить merge conflicts (конфликты слияния) / time-to-completion (время до завершения) / changes_requested (запрошенные изменения). N=1 — не статистика, но datapoint (точка данных).

---

## Ссылки

Полные отчёты (13 документов): `D:/Development/Harmess/docs/research/`

- Research Charter v1.0 (этот документ, расширенный): `00-research-charter-v1-final.md`
- 7 research reports (исследовательских отчётов): `01-07-*.md`
- 6 critic reports (критических отзывов): `critic-01-06-*.md`

Ключевые внешние источники:
- OpenAI "Harness engineering (оснасточная инженерия)": [openai.com/index/harness-engineering](https://openai.com/index/harness-engineering)
- Anthropic "Context engineering (инженерия контекста)": [anthropic.com/engineering/effective-context-engineering-for-ai-agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic "Agent Skills" (progressive disclosure — прогрессивное раскрытие): [anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- Aider repo map (карта репозитория Aider): [aider.chat/2023/10/22/repomap.html](https://aider.chat/2023/10/22/repomap.html)
- Sourcegraph SCIP: [scip-code.org](https://scip-code.org/)
- Fowler "Harness engineering": [martinfowler.com/articles/harness-engineering.html](https://martinfowler.com/articles/harness-engineering.html)
- Cockburn Hexagonal: [alistair.cockburn.us/hexagonal-architecture](https://alistair.cockburn.us/hexagonal-architecture)
- arXiv "Lost in the Middle" (Liu et al.): [arxiv.org/abs/2307.03172](https://arxiv.org/abs/2307.03172)

---

*Этот блог-пост — идея для дискуссии, не истина в последней инстанции. Главный вывод исследования: мы не строим новую архитектуру, мы строим enforcement layer (слой принуждения), который делает любую архитектуру пригодной для параллельной LLM-разработки. saga-mcp — инфраструктура этого слоя.*
