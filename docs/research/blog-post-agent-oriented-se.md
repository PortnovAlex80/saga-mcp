# Agent-Oriented Software Engineering: что меняется, а что нет

> Рабочий блог-пост для обсуждения. Не публикация — идея для дискуссии.
> Основан на Research Charter v1.0, прошедшем adversarial review (7 research reports + 6 критиков с разными идеологическими позициями).

---

## TL;DR

Мы исследовали вопрос: **должна ли измениться архитектура ПО, когда код пишут LLM-агенты, а не люди?** После 7 исследовательских отчётов и 6 критиков с противоположными позициями, ответ:

**Код — нет. Small files, SRP, Clean Architecture, Hexagonal, DDD — всё работает.** Агенты работают лучше на классическом коде, не хуже.

**НО enforcement-слой над кодом — да, радикально.** То, что человеческие команды делают через code review, разговоры и «я помню где что лежит» — должно стать machine-mediated, когда исполнители stateless, изолированы и не могут договориться.

---

## С чего началось

У нас есть saga-mcp — MCP-сервер, управляющий параллельными LLM-агентами (воркерами в git worktree, мерж через lock, episode state machine с hard gates). Мы провели convergence к концепту CGAD (Contract-Governed Agentic Development): 4-valued verdict, RiskClass computation, semantic conflict detection, runtime observation store, 12-правильный linter.

После этого возник вопрос: **а сам код тоже должен быть другим?** Если классическая архитектура (SRP, Clean, DDD, GoF) оптимизирована под человека — не нужна ли новая архитектура под agent-runtime?

## Что мы сделали (методология)

Запустили параллельно 7 исследовательских агентов:

1. **GoF revisited** — все 23 паттерна под parallel-agent runtime
2. **Literature scan** — что опубликовано про architecture for agents
3. **TOGAF/DDD/Clean** — как классические фреймворки деформируются
4. **Test pyramid + tooling** — linters/SAST/security как Trusted Providers
5. **Industry essays** — OpenAI/Anthropic/Cognition/Aider
6. **Thought leaders** — Fowler/Evans/Uncle Bob/Newman/Cockburn/Henney/Booch
7. **Precedents** — WIT/seL4/OCaml/Actor/Luna/SCIP

Потом — **6 критиков с жёсткими, различными бриефами**: классик-консерватор, эмпирический скептик, практик Cursor, seL4-пурист, DDD-традиционалист, type-theorist. Каждый читал отчёты и должен был либо сломать тезис, либо усилить.

Это не «найди подтверждение». Это «выживет ли тезис под ударом с каждой стороны».

---

## Что пало (честно)

### «SRP заточен под Miller 7±2»

**Миф.** SRP (Uncle Bob, через Parnas 1972) — про change-propagation axes: разные стейкхолдеры меняют код по разным причинам, декомпозируй так, чтобы изменение в одной ответственности не заставляло перепроверять другие. Это про coupling-and-cohesion, не про chunking memory.

LLM с 2M-окном всё равно выигрывает от SRP: модуль с N reasons-to-change в N раз чаще оказывается в зоне конфликта параллельных агентов.

### «Большие файлы для большого контекста»

**Опровергнуто трижды.** Идея была: LLM имеет 100K-2M токенов, дай ему большой cohesive блок, чтобы не было transitions между файлами. Три независимых факта её убили:

- **Lost-in-the-middle** (Liu et al., TACL 2024): U-shaped recall — LLM хуже всего работает в середине большого контекста
- **AGENTS.md hurts** (Raschka, ETH Zurich): добавление контекст-файлов может **снизить** success rate агента на 20%+
- **Индустрия единогласна**: практики Cursor, r/cursor, Simon Willison — малые файлы 150-500 LOC работают лучше

**Вывод:** small cohesive files + generated symbol index (Aider repomap, Cursor indexing, Sourcegraph SCIP) — вот что работает.

### «Face/Body = новая архитектура»

**Переоткрытие Hexagonal.** Cockburn 2005: Ports = discovery surface, Adapters + Application = body. Constellation Architecture = то же самое + индекс портов в БД. Конвергентное переоткрытие — это не новизна, это рекомендация использовать Cockburn правильно и добавить CI step.

### «Face replacing imports»

**Непрактично.** Python/JS/TS не имеют runtime mediator. `importlib.import_module("anything")` — ambient authority, который Face не может ограничить. Получаются две системы зависимостей (imports + saga graph), которые будут расходиться.

### «Face as type (как OCaml signature)»

**Face = spec, не type.** ML signatures проверяются компилятором: существует decision procedure, которая отвергает несоответствующие программы. Face — это markdown/YAML, и R19 (lint) — это name-presence matching, не type checking. Чтобы стать type, нужен refinement-type checker (Liquid Haskell/F*) — future direction, не текущее состояние.

---

## Что выжило (и это главное)

### 1. Инварианты должны быть machine-enforced, а не просто декларированы

**Это главный выживший тезис.** Все 6 критиков, даже самые враждебные, согласились с одним:

> «Классическая архитектура говорит про invariants постоянно и enforce'ит их почти никогда» (Critic #1, classical defender)

> «Это enforcement, которого DDD-практики ждали 15 лет и никогда не имели» (Critic #5, DDD traditionalist)

> «Если свернуть до INVARIANTS.md на модуль + lint правило, проверяющее покрытие тестами — я бы попробовал» (Critic #3, practitioner)

**Что это значит:** Hexagonal/DDD/Clean объявляют инварианты в комментариях, wiki, на review. Но нет machine-checking. saga-mcp закрывает этот gap: инвариант → property test (L3) → Trusted Guard → `verification_evidence(outcome=passed)`. Без этого переход development→verification не проходит.

### 2. Stateless execution требует durable state

LLM-агент не имеет памяти между сессиями. Всё, что не вынесено во внешнее состояние, потеряно. saga-mcp уже реализовала 12 элементов durable-state инфраструктуры: frozen baseline, drift detection, typed provenance, hard gates, 4-valued verdict, conflict keys, observation store. Это **не меняет архитектуру кода** — это инфраструктура поверх неё.

### 3. Artifact graph — queryable provenance layer

Не замена imports — **параллельный слой tracability** (как INCOSE Requirements Traceability Matrix, но для кода). Когда stateless worker стартует, он не помнит «модуль A зависит от модуля B». Он запрашивает saga DB: `trace_list({source_id: A, link_type: 'consumes'})`. БД отвечает Face модуля B. Worker работает. Imports остаются — saga graph делает зависимости видимыми для stateless-execution.

### 4. Property tests (L3) эффективнее example tests (L2) для agent-written code

LLM пишет тесты против LLM-написанного кода. Оба могут ошибаться одинаково → тесты проходят, система неправильная. Property test (Hypothesis/QuickCheck) выражает **инвариант** (монотонность, положительность, идентичность), не пример. Неправильная реализация должна удовлетворять инварианту для всех входов, а не для 5 примеров, которые тот же агент выбрал.

**Но:** property tests работают только для алгоритмических AC (формулы, инварианты). Для UI-тестов — example/E2E остаются единственным вариантом. Пирамида не сдвигается uniformly — она bifurcates.

### 5. Generated Faces (SCIP-совместимые), не hand-authored

Критик #3 (практик) был прав: hand-maintained Face на модуль — это AGENTS.md rot на новом уровне. Решение: Face **генерируется** из AST через SCIP-совместимый indexer (как Sourcegraph). Человек пишет только:
- `INVARIANTS.md` (10 строк: инварианты, которые модуль защищает)
- Структурированные секции SRS (Port Registry, Aggregate invariants, UL glossary)

Generated Face = discovery surface (бесплатный, всегда свежий). Authored INVARIANTS.md = enforcement target (минимальный, стабильный).

### 6. Independent Verifier — не re-run Builder'овских тестов

Текущий verification.ac в saga greps Builder-written test и re-runs. Это Builder evidence под Verifier hat (CGAD §9 forbidden). Реальное решение:
- Verifier читает AC + contract-as-data (frozen)
- Verifier генерирует **свой** L3 property test (другой слой, другая директория)
- Verifier не смотрит Builder'овский test файл

Для solo-worker это даёт structural independence (разный слой, разная директория, разный generated test). Для multi-worker — полную independence (разный агент).

---

## Что классические фреймворки дают saga-mcp

Исследование (Report 03) показало: saga-mcp **независимо переоткрыла** 80% классики, под другими именами:

| Классика | saga-mcp (уже было) |
|---|---|
| DDD Context Mapping | conflict_key types (file_path, schema, public_protocol) |
| Hexagonal scaffold | Pattern B (scaffold-then-parallel) |
| DDD Aggregate boundary | worktree isolation + conflict detection |
| Clean Architecture Dependency Rule | accepted_hash + drift_state |
| TOGAF Phase G compliance | episode_transition hard gates |
| TOGAF Transition Architecture | multi-episode roadmap (REQ-008→013) |

Что классика **добавляет**: naming and typing discipline. Saga делает имплицитно то, что DDD/Hexagonal prescribe эксплицитно. Называя вещи правильно, мы получаем queryable artifacts (а не grep'ы) и lint rules (а не review checklist).

---

## Главная дискуссионная точка

**Меняется ли архитектура под агентов?**

Два лагеря в индустрии:

1. **«Правила те же»** (Uncle Bob, Henney): SRP/Clean/GoF не зависят от исполнителя. Bottleneck сдвигается от typing к знанию паттернов.

2. **«Эшафоты поверх»** (Fowler, OpenAI harness): классика работает, но нужны harnesses — feedforward guides, feedback sensors, scaffolded contracts.

**Наше исследование предлагает третий путь:**

3. **«Enforcement layer»**: классика работает на уровне кода. Но enforcement инвариантов, который человеческие команды делают через social process, должен стать machine-mediated для stateless parallel агентов. saga-mcp — инфраструктура этого слоя.

Разница с подходом Fowler: Fowler строит harnesses **вокруг** процесса (sensors, guides). Мы строим enforcement **внутри** pipeline (invariant registry → Trusted Guard → hard gate). Fowler's harnesses помогают агенту; saga's enforcement **не пускает** агента дальше, если инвариант не проверен.

---

## Практические следствия для saga-mcp

Что мы строим дальше (roadmap):

1. **`INVARIANTS.md` convention** — на критический модуль, ~10 строк, human-authored. Lint: каждый инвариант → property test существует.

2. **Contract-as-data в AC** — saga-analyst пишет `properties:` block (YAML) для алгоритмических AC: монотонность, положительность, идентичность. Verifier генерирует L3 тесты из этого блока.

3. **Generated Faces via SCIP** — saga-mcp CI emits symbol graph из AST. Workers запрашивают Faces через saga DB, не через grep.

4. **Trusted Provider Registry** — `trusted_providers` table: ESLint (L0), Semgrep (L1), pytest (L2), hypothesis (L3), pytest-benchmark (L4). Provider не free-form string, а зарегистрированный с trust_basis и determinism.

5. **`test_layer` field** на verification_evidence — L0-L4. Lint: AC с verified_by только на одном слое → warning (вероятно Verifier переиспользовал Builder'овский тест).

---

## Что НЕ делаем (честно)

- ❌ Не меняем структуру файлов (small files остаются)
- ❌ Не заменяем imports saga-graph'ом (параллельный слой, не замена)
- ❌ Не создаём «Constellation Module» как новый артефакт (= Hexagonal module)
- ❌ Не требуем hand-authored Face на каждый модуль (генерируем через SCIP)
- ❌ Не претендуем на «новую архитектуру» (мы — enforcement layer над классикой)

---

## Открытые вопросы для обсуждения

1. **Должен ли saga-architect требовать DDD Bounded Context declaration в SRS?** Или BC = module = repository binding (как сейчас)?

2. **Как заставить property tests работать для stateful систем?** Hypothesis stateful, PropEr parallel — нужны ли они в saga ACs?

3. **Event Storming под agent-runtime?** Как LLM-архитектор может «интервьюировать» domain expert? Нужен ли saga-kickstart → domain-discovery шаг?

4. **Refinement types как future direction?** Liquid Haskell / F* для L0 invariant checking — реально ли это для Python/TypeScript?

5. **Стоит ли делать empirical experiment?** Взять water-cannon, прогнать под Constellation vs classical SRP, замерить merge conflicts / time-to-completion / changes_requested. N=1 — не статистика, но datapoint.

---

## Ссылки

Полные отчёты (13 документов): `D:/Development/Harmess/docs/research/`

- Research Charter v1.0 (этот документ, расширенный): `00-research-charter-v1-final.md`
- 7 research reports: `01-07-*.md`
- 6 critic reports: `critic-01-06-*.md`

Ключевые внешние источники:
- OpenAI "Harness engineering": [openai.com/index/harness-engineering](https://openai.com/index/harness-engineering)
- Anthropic "Context engineering": [anthropic.com/engineering/effective-context-engineering-for-ai-agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic "Agent Skills" (progressive disclosure): [anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- Aider repo map: [aider.chat/2023/10/22/repomap.html](https://aider.chat/2023/10/22/repomap.html)
- Sourcegraph SCIP: [scip-code.org](https://scip-code.org/)
- Fowler "Harness engineering": [martinfowler.com/articles/harness-engineering.html](https://martinfowler.com/articles/harness-engineering.html)
- Cockburn Hexagonal: [alistair.cockburn.us/hexagonal-architecture](https://alistair.cockburn.us/hexagonal-architecture)
- arXiv "Lost in the Middle" (Liu et al.): [arxiv.org/abs/2307.03172](https://arxiv.org/abs/2307.03172)

---

*Этот блог-пост — идея для дискуссии, не истина в последней инстанции. Главный вывод исследования: мы не строим новую архитектуру, мы строим enforcement layer, который делает любую архитектуру пригодной для параллельной LLM-разработки. saga-mcp — инфраструктура этого слоя.*
