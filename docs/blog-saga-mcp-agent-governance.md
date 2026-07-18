# saga-mcp: Управление параллельными LLM-агентами через контракты

> Рабочая статья для обсуждения. Не академическая публикация.

## Что мы построили

**saga-mcp** — MCP-сервер на TypeScript/SQLite, который управляет параллельными LLM-агентами через контракт-управляемый жизненный цикл эпизодов. Не Jira-клон. Не фреймворк для кода. — **управляющая плоскость** для разработки ПО силами множества ИИ-агентов.

Отправная точка: форк [spranab/saga-mcp](https://github.com/spranab/saga-mcp) (Jira-like трекер). За одну сессию — convergence (сходимость) к концепту CGAD (Contract-Governed Agentic Development), research program (исследовательская программа) из 7 отчётов + 6 adversarial critics (соперничающих критиков), и валидация на реальном продукте (игровой прототип «Водяная пушка от комаров»).

## Зачем это нужно

Когда 5-10 LLM-агентов работают параллельно над одним проектом:

- Два воркера независимо изобретают несовместимую архитектуру → merge-конфликт (конфликт слияния) архитектурного уровня (git не чинит)
- Агент объявляет «готово, тесты зелёные» — но тесты не покрывают то, что требовалось
- Никто не знает, на каком этапе проект — каждый агент придумывает свой ответ
- Нет доказательства, что принятый критерий приёмки (AC) реально проверен

saga-mcp решает это **механизмами, не дисциплиной**.

## Как это работает (кратко)

Жизненный цикл эпизода — 7 стадий с hard gates (жёсткими шлюзами):

```
ИДЕЯ → Discovery → Formalization → Planning → Development → Verification → Integration → ГОТОВО
         brief         PRD+SRS+AC    scaffold    code+L2      L3 property    merge
                        +RULE+SPEC   +conflict   tests        tests          +gate
                         +INV         keys                      (independent)
```

Между стадиями — **hard gates (жёсткие шлюзы)**: нельзя войти в development без принятых AC, нельзя в integration без passing evidence (прохождения доказательства) с правильным hash. `deny-by-default (отказ по умолчанию)`: отсутствие доказательства = отказ.

## Что меняется под агент-runtime (агентным временем выполнения)

**Главный тезис** (выдержал 6 adversarial critics с разными идеологическими позициями):

> Классическая архитектура (SRP, Clean Architecture, Hexagonal, DDD) **остаётся**. Код организован как обычно: малые файлы, явные импорты, порты и адаптеры.
>
> Что меняется — **enforcement layer (слой принуждения) над кодом**. То, что человеческие команды делают через code review (ревью кода), разговоры и «я помню где что лежит», должно стать machine-mediated (машинно-опосредованным), когда исполнители stateless (без состояния), изолированы и не могут договориться.

Каждый элемент enforcement (принуждения) — ответ на конкретную LLM-failure mode (режим отказа LLM):

| LLM-failure mode (режим отказа) | saga-mcp enforcement (принуждение) |
|---|---|
| Selective memory (избирательная память) между сессиями | completeness-gate (шлюз полноты) |
| Меняет контракт под себя mid-work (в процессе работы) | accepted_hash + drift_state |
| Объявляет «готово» преждевременно | hard gates (жёсткие шлюзы) на episode_transition |
| Угадывает молча, без матрицы | decision-matrix ≥3×≥2 в kickstart |
| Не помнит project_id | stop:true + projectname.txt |
| Видит чужие задачи | role: теги + worker_next role filter (ролевой фильтр) |
| Воркеры не договариваются | Pattern B scaffold + conflict_keys |
| Трактует «не знаю» как «ок» | 4-valued verdict (4-значный вердикт: passed/failed/unknown/error) |
| Понижает risk чтобы обойти gate | RiskClass max() + P15 monotonicity guard (монотонность) |
| Git — единственный детектор конфликта | task_conflict_keys + conflict_check + R5 |
| Не наблюдает runtime, только код | runtime_observations (3rd truth axis — третья ось истины) |
| Доверяет своему reasoning (рассуждению) | cgad-spec-lint 16 правил (детерминированный) |
| Гипотеза не измеряется | hypothesis → business_metric → observation → R16 |

## Architecture (архитектура): что выжило, что пало

Мы исследовали: нужна ли другая архитектура кода для LLM-агентов? После 7 research reports (исследовательских отчётов) и 6 adversarial critics (критиков):

**Пало:**
- «Большие файлы для большого контекста» — Lost-in-the-Middle (потеряно в середине) убивает
- «SRP заточен под 7±2» — SRP = Parnas change-propagation (распространение изменений)
- «Face replacing imports» — Python не имеет runtime mediator (посредника времени выполнения)

**Выжило:**
- SRP, Clean Architecture, Hexagonal, DDD — всё работает
- Small cohesive files (малые связные файлы: 150-500 LOC)
- Composition over inheritance (композиция вместо наследования)

**Главный вклад (novel — новизна):**
> Классическая архитектура говорит про инварианты постоянно и enforce'ит (принуждает соблюдать) их почти никогда. Это — gap (пробел), который saga-mcp закрывает. Invariant Registry (реестр инвариантов) → property tests (тесты-свойства, L3) → Trusted Guard (доверенный страж) → hard gate (жёсткий шлюз).

## Product cycle (продуктовый цикл): от инженерии к продукту

Saga не только строит код — она замыкает продуктовый цикл:

```
HYP-1 (hypothesis: "core loop holds player ≥180s")
  ↓ metric: median_session_length_seconds
  ↓ target: ≥180s, kill: <90s, valid_by: 2026-08-15
  ↓
PRD → SRS (Invariant Registry) → AC (properties YAML) → code → evidence
  ↓
observation_record (median=203s)
  ↓
HYP-1: HIT ✓ → invest in v1
```

R16 lint: если hypothesis accepted (принята), но нет observation (наблюдения) → warning (предупреждение). Продуктовый цикл не замкнут — измерь метрику.

## cgad-spec-lint: 16 детерминированных правил

| Rule (правило) | Что ловит |
|---|---|
| R1 | Deny-by-default (отказ по умолчанию, 4-valued verdict) |
| R2 | P15 risk floor (нижняя граница риска, RiskClass consistency) |
| R3 | AC без verified_by evidence (доказательства проверки) |
| R4 | Greenfield без scaffold (Pattern B) |
| R5 | Semantic collisions (семантические коллизии) |
| R6 | Agent self-set state (самоустановка состояния агентом) |
| R7 | Non-atomic transition (неатомарный переход) |
| R8 | Frozen contract drift (дрейф замороженного контракта) |
| R9 | Self-approval (самоодобрение: verifier == builder) |
| R10 | Work package self-decomposition (самодекомпозиция пакета работ) |
| R11 | Hidden exception (скрытое исключение) |
| R12 | Human approval as proof (человеческое одобрение как доказательство) |
| R13 | SRS без verification.ac (invariant gap — пробел инварианта) |
| R14 | FR forbidden content (запрещённое содержимое: implementation detail) |
| R15 | RULE без enforced-by trace (трассировки принуждения) |
| R16 | Hypothesis без observation (product gap — продуктовый пробел) |

## Валидация: water-cannon

Прототип «Водяная пушка от комаров» (Python + pygame), прогнанный через полный saga flow:

| Проверка | Результат |
|---|---|
| Complexity Gate (шлюз сложности) | ✅ fired → class=modular → artifact set decided |
| Hypothesis (HYP-1) | ✅ median_session_length ≥180s / kill <90s / valid 2026-08-15 |
| Architectural Style (архитектурный стиль) | ✅ Hexagonal + Functional core |
| Invariant Registry (реестр инвариантов) | ✅ 6 formal predicates (формальных предикатов: INV-1..INV-6) |
| Module Manifest + conflict keys | ✅ 10 modules, 2 collisions (resolved by depends_on) |
| AC properties blocks | ✅ 6/7 ACs with YAML contract-as-data |
| FR без implementation detail (деталей реализации) | ✅ all FRs = observable behavior (наблюдаемое поведение) |
| RULE + enforced-by trace | ✅ RULE-1 → implements FR-7 + implements_spec SPEC-1 |
| Pattern B + conflict_check | ✅ scaffold + 7 bodies + 7 verifiers + INTEGRATE |
| verification.ac → saga-verifier | ✅ all 7 routed to saga-verifier (L3 property tests) |

## Что дальше

1. **Trusted Provider Registry (реестр доверенных провайдеров)** (REQ-014) — wire-in ESLint/tsc/Semgrep/pytest-benchmark как first-class Guard Input Providers (провайдеры входов проверки первого класса)
2. **Independent Verifier end-to-end (независимый проверяющий)** — saga-verifier генерирует Hypothesis property tests из frozen AC contract
3. **test_layer field (поле test_layer)** — L0-L4 на verification_evidence
4. **Generated Faces via SCIP (генерируемые фасеты через SCIP)** — symbol graph (граф символов) из AST, discovery surface (поверхность обнаружения) без grep
5. **Refinement types (уточняющие типы)** (future — будущее) — Liquid Haskell/F* для L0 invariant checking (проверки инвариантов)

---

*Полная история: [docs/saga-mcp-history.md](saga-mcp-history.md)*
*Research Charter: [docs/research/00-research-charter-v1-final.md](research/00-research-charter-v1-final.md)*
*ADRs: [docs/architecture/decisions/](architecture/decisions/)*
