# GRAPH-TEST-STRATEGY — тестирование по графам приёмки (цех × завод)

Статус: план согласуется. Дата: 2026-08-20. Ветка: saga4.
Основа: 5 параллельных анализов (графы 4 цехов + заводская стратегия),
карты `docs/architecture/checks/CHECKS-*.md`, CONVEYOR-MENTAL-MODEL §23.

Исполнимые handoff-брифы: `CAUSAL-PROOF-IMPLEMENTATION-BRIEFS.md`. Порядок
обязателен: сначала W0 proof-kernel, затем W1 causal/P0 scenario packs.

Дополняет, не заменяет: `WORKSHOP-TEST-PLAN.md` (реальная модель, 20 проектов)
— здесь детерминированная проверка ФИЗИКИ ЗАВОДА по графам; там — КАЧЕСТВО
ЦЕХОВ реальной моделью. Разделение зафиксировано моделью §23 (L0–L5+S).

---

## 0. Резюме

Построены формальные графы приёмки каждого цеха (флоу + машина ячейки +
бюджетный автомат эпох) и завода (outcomeRoutes + obligation-рёбра +
капсульные границы). Главные результаты:

1. **Машина ячейки конечна и перечислима** (~23 легальных перехода) —
   edge coverage достижим исчерпывающе и дёшево. Флоу цехов: 8–17 рёбер —
   path coverage по исходам реален. Вердиктные цепочки усекаются
   reason-identity клапаном (§15): перебор линейный, не экспоненциальный.
2. **Три архитектурных proof'а не исполняются вообще** (P0):
   канонический двухпроходный §16 (golden-path Run B — выключен в коде
   теста), authorized-хэппи-пас Delivery (ни одного теста),
   композиционный proof ADR-078 (эпик-накопление формализации — юнит есть,
   сквозного нет).
3. **Систематические дыры одного класса**: бюджетно-эпоховая механика
   ADR-075 протестирована на синтетических ячейках, но ни разу — на реальных
   ячейках цехов; crash-окна obligation-границ — по точечным тестам, не сеткой.
4. **Statechart explorer из §23 не существует** — ступень лестницы не
   заполнена; ближайший аналог — `tests/matrix/` (перечисление форм дефекта).
5. Recovery playbook сведён в трёхуровневую иерархию (раздел 4) —
   «что делать, когда случилось» теперь один документ, а не знание оператора.

---

## 1. Методология: четыре уровня графа

### Уровень A — машина одной ячейки (цеховой, L1/L2)

Закрытая таблица пар (kanban × loop) + 16–20 событий редьюсера.
Пространство конечно. Метод: **полное перечисление легальных рёбер** +
представительские нелегальные. Сейчас покрыто 16 из ~23 классов
(`production-cell-transitions.test.mjs`) — догнать до set-equality.

### Уровень B — флоу цеха (L3-композиция узлов + вердиктные траектории)

- **Edge/path coverage**: каждое декларированное ребро флоу должно иметь
  trace (реестр `lifecycle-outcome-edge-coverage.test.mjs` — уже ратчет;
  2 из 10 рёбер завода честно PENDING: `initial-discovery:failed`,
  `solution-development:failed` — нужны fault-injection в kernel-seam).
- **Вердиктные траектории**: буква продуктивного цикла {Repair_author,
  DefectProven, InvalidReviewerOutput} при maxAttempts даёт 3^n — НО
  reason-identity клапан (§15, `finding-trajectory.ts`) сворачивает к
  классам: константное множество (спин), строго убывающее (сходимость —
  работа, не спин), несравнимое (сброс). Перебор линейный по длине
  дефект-цепочки + 3 бюджетных отсечки (maxAttempts, totalAttempts=30,
  convergence=20) + межэпоховая память диагнозов (ROLLOVER-DENIED).
- **Fan-out (только Development)**: пространство = линейные расширения DAG
  e(P) × точка отказа × класс отказа. N≤4 перебираем исчерпывающе (цепь/V/
  ромб/антицепина), N>4 — представительные формы.

### Уровень C — завод (композиция цехов)

- **Sync-edge coverage**: в текущем production-коде пять obligation-рёбер:
  `close-presentation`, `run-gate`, `run-effects`,
  `record-final-acceptance`, `route-lifecycle`. `transition-handler` — класс
  capability, а не шестой handoff kind. Пространство fault-сценариев строится
  не слепым декартовым произведением состояний, а из именованных commit-boundary
  каждого handler-а: легальные crash-before/crash-after/redrive расписания.
  Каждый сценарий обязан сходиться
  к completion-receipt / typed wait / терминалу — никогда к тихому простою
  (класс TB-9/TB-10/TB-12).
- **Кросс-продукт «исход цеха N × вход цеха N+1»** — ограничен
  декларированными рёбрами (~10 комбинаций, не взрыв): все 4 исхода
  Discovery реально ведут в формализацию (пермиссивный гейт!) — значит
  формализация обязана корректно работать и с `failed`-сертификатом.
- **Progress-obligation инспектор** (§23) как assertion-харнес после каждого
  краш-теста: каждый nonterminal scope имеет live owner / runnable command /
  typed wait / transition due — иначе `stalled`/`inconsistent_state` с рефом.

### Уровень D — кросс-рановые свойства

Replay two-pass (§16), капсулы (hit/miss/конфликт/инвалидация K8/K9),
continuation (ADR-038), resume-compat (K5), третий lifecycle-ран.
Тестируется ТОЛЬКО здесь — цеховой юнит не видит ранов N−1/N−2.

### Уровень E — Causal Fault/Recovery Graph (замкнутый агентский цикл)

Уровни A–D отвечают на вопрос «какие переходы и композиции достижимы».
Уровень E отвечает на более сильный вопрос: **что происходит с известным
дефектом от места рождения до автономного исправления**.

```text
место рождения дефекта
→ нарушенное нормативное обязательство
→ первый авторизованный detector
→ точный receipt / reason / evidence
→ causal owner
→ feedback channel
→ минимальный repair frontier
→ invalidation cone
→ новый append-only проход
→ повторная приёмка | bounded typed wait/terminal
```

Это не rollback Kanban и не мутация терминальной истории. «Вернуться на два
или три шага» означает по provenance найти самую раннюю скомпрометированную
authority boundary, сохранить валидный префикс и пересобрать только зависимый
суффикс новой ревизией/continuation. Если причина неоднозначна, Factory запускает
дополнительный probe или выбирает безопасно расширенный frontier; он не угадывает
root cause по тексту ошибки.

#### Независимая oracle-архитектура

Чтобы тест не доказывал сам себя, сравниваются три независимых источника:

1. **Acceptance Obligation Contracts** — независимые machine-readable
   декларации защищаемых свойств (REG/PROC/ADR/failure-axis references), из
   которых compiler строит normative registry и mutation families. Человек не
   пишет отдельные negative fixtures для каждого Gate.
2. **Installed protection** — фактически установленные nodes, schemas,
   CheckPlans, providers, effects, routes и recovery policies.
3. **Observed trace** — реально полученные SQLite-факты, ProductRefs,
   CheckReceipts, GateDecisions, RecoveryIssues, effect/transition receipts и
   независимые наблюдения filesystem/Git/Docker.

Норма не генерируется из validator implementation или installed CheckPlan.
Иначе удалённый гейт исчезнет одновременно из реализации и ожидаемого теста.
Она объявляется один раз как часть versioned acceptance contract. Обязательны
set-equality `compiled normative obligations ↔ installed protection`,
фактический trace и mutation kill matrix: для каждого constraint compiler
порождает дефекты, которые назначенный гейт обязан убить.

#### Contract-derived mutation algebra

Ручной список мусора не масштабируется. Общий compiler автоматически строит:

- из JSON/tool schema: missing required, wrong type/enum/bounds, empty,
  malformed, unknown field и incompatible version;
- из constraint DSL: zero/below/above cardinality, duplicate, malformed или
  truncated grammar, missing/foreign/stale/cross-run ref, wrong-object digest,
  missing/extra/substituted member, empty/ambiguous projection, broken lineage,
  ordering и cross-field mismatch.

Каждый generated mutant несёт `obligationId`, `operatorId`, нарушенный
constraint, seed digest и ожидаемую authorized rejection boundary. Нарушающий
обязательство mutant может завершиться schema rejection, `repair_required` или
declared typed wait/terminal, но никогда acceptance или ownerless stall.

Полный mutant family исполняется дёшево на реальной validator/Gate boundary.
Полный causal loop исполняется для representative каждого эквивалентного класса
`{detector, reason, owner, frontier}`. Поэтому стоимость не равна количеству
комбинаций полей, но каждый объявленный класс неправильности проверен.

#### Таксономия дефектов и диагностируемость

Finite fault model закрывает не все мыслимые ошибки текста или внешнего мира, а
все **заявленные классы нарушений протокола Factory**. Каждый класс имеет
отдельный injection seam и независимый наблюдаемый факт:

| Fault class | Где рождается | Авторитетное наблюдение | Типичный frontier |
|---|---|---|---|
| `authored-semantic` | worker/reviewer product | adjudicated corpus или независимый provider | causal producer Workplace |
| `contract-shape` | tool/product/provider payload | decoder/schema + rejected bytes | тот же fenced actor |
| `authority-binding` | stale/wrong ref, digest, subject, role | persisted exact authority graph | producer точного неверного binding |
| `derived-evidence` | caller-authored hash/tree/file set/receipt | Factory-owned source adapter | сторона, способная представить источник |
| `detector-fault` | checker/provider/config | independent obligation + external fact | provider repair/typed infrastructure wait |
| `feedback-fault` | issue projection/delivery | persisted issue против actor input digest | feedback handoff/redrive |
| `durable-transition` | receipt/CAS/obligation boundary | raw SQLite facts + postcondition | transition owner/redrive |
| `effect-external` | Git/Docker/release/external service | external state + effect receipt | retry effect, product repair или human boundary |
| `scheduler-fence` | lease, crash, race, restart | fence/lease/receipt trace | deterministic reconciliation |

Для каждого сценария заранее объявляется diagnosability:

- `isolated` — evidence однозначно называет earliest compromised authority;
- `ambiguous` — несколько корней дают одну сигнатуру; нужен объявленный probe
  или безопасно расширенный frontier;
- `external` — исправление требует внешней authority; допустим только typed
  wait/human boundary, но не безымянная остановка.

Detector location и causal owner могут различаться. Поле
`failureOwnership: workplace|upstream` считается направлением, но не полным
доказательством корня: exact frontier обязан выводиться из ProductRef/revision/
receipt lineage либо оставаться `ambiguous`. Сценарий, который угадал owner по
тексту reason, не засчитывается.

#### Scenario DSL (тестовый, не production authority)

```ts
interface CausalFaultScenario {
  readonly defectId: string;
  readonly mutant?: {
    readonly obligationId: string;
    readonly mutantId: string;
    readonly operatorId: string;
    readonly violatedConstraint: string;
    readonly seedDigest: string;
  };
  readonly faultClass: 'authored-semantic' | 'contract-shape'
    | 'authority-binding' | 'derived-evidence' | 'detector-fault'
    | 'feedback-fault' | 'durable-transition' | 'effect-external'
    | 'scheduler-fence';
  readonly proves: readonly string[]; // normative obligation ids
  readonly oracleClass: 'mechanical' | 'semantic-adjudicated' | 'harvested';
  readonly assumptions: {
    readonly faultMultiplicity: 'single' | 'declared-pair';
    readonly fairness: readonly string[];
  };
  readonly injection: {
    readonly boundary: 'worker-output' | 'world-state' | 'provider-output'
      | 'feedback-delivery' | 'durable-boundary' | 'scheduler';
    readonly fixtureRef: string;
  };
  readonly expected: {
    readonly detectorRef: string;
    readonly acceptableFallbackDetectors?: readonly string[];
    readonly reasonCode: string;
    readonly evidenceKind: string;
    readonly diagnosability: 'isolated' | 'ambiguous' | 'external';
    readonly repairOwner: string;
    readonly repairFrontier: string;
    readonly preservedPrefix: readonly string[];
    readonly invalidationCone: readonly string[];
    readonly terminalBudget: string;
  };
  readonly repair: {
    readonly triggerReasonCode: string;
    readonly fixtureRef: string;
  };
  readonly independentFacts: readonly string[];
}
```

`oracleClass` — это метка качества истины, а не способ ослабить assertion:

- `mechanical`: schema/hash/Git/tree/build/SQLite/Docker факт вычисляется
  независимо от результата Factory;
- `semantic-adjudicated`: versioned metamorphic/adversarial profile проверяется
  независимым provider или внешним эталоном; ручная разметка необязательна;
- `harvested`: материал взят из реального рана, но сам факт прежнего acceptance
  не считается доказательством правильности.

#### Корпус `positive / negative / repair`

Для каждого normative obligation compiler формирует не один happy fixture, а
семейство:

1. **positive** — минимальный валидный продукт проходит назначенный detector;
2. **negative** — generated mutant нарушает ровно один объявленный constraint и
   обязан быть убит authorized detector-ом до acceptance;
3. **repair** — новый продукт строится только из видимого exact feedback и
   проходит повторную приёмку как новая immutable revision.

Positive и negative не должны различаться скрытым scenario id. Repair не может
быть заранее привязан к `attempt=2`: он выбирается по nonce/reason/evidence из
реального desk input. Для semantic obligations profiles версионируются
независимо от production CheckPlan; curated fixtures являются дополнительным
усилением, но не ручной основой покрытия. Для mechanical mutations ожидаемый
факт получается независимым вычислением, а не копированием Factory receipt.

Scripted worker заменяет только мышление LLM. Он проходит настоящий
assignment → desk → MCP → ProductRef/CandidateSet → Gate → feedback → effects
→ routing → SQLite. Он видит только настоящий WorkIntent, desk, tool responses
и RecoveryIssue; не видит scenario id, номер попытки или скрытое состояние
теста. Сценарий обязан иметь контрфактическую пару:

- точный feedback → worker исправляет nonce-дефект;
- отсутствующий/stale/искажённый feedback → worker **не** выдаёт магически
  исправленный продукт.

Так доказывается причинность feedback, а не сценарий «bad на попытке 1, good на
попытке 2».

#### Derived evidence — отдельная fault-категория

LLM владеет семантическим содержанием, но не производными фактами, которые
Factory может получить из авторитетного источника. Hash, Git tree SHA,
changed-files set, ancestry и provider receipt не становятся evidence от того,
что строка прошла regex.

```text
derivedEvidence = F(authoritativeSource)
owner(derivedEvidence) = component that authoritatively observes source
```

- новые bytes/payload → Factory вычисляет digest и выдаёт receipt;
- ранее выданный Factory digest → worker может только дословно вернуть его как
  opaque authority echo, после чего Factory проверяет binding;
- caller-computed/fabricated digest → никогда не material authority;
- источник недоступен → `unverifiable`, а не доверие caller-строке.

Первый эталонный сценарий — `fabricated-derived-evidence`: формально валидный
64-hex `content_hash` при отсутствующем файле обязан дать typed rejection и
нулевую durable mutation; worker по точному feedback пишет файл и повторяет
вызов **без hash**; Factory вычисляет SHA-256 наблюдённых bytes. Утверждение о
том, откуда модель взяла конкретную hex-строку, не является частью proof-а:
без внешнего лога это недоказуемо и архитектурно несущественно.

Repair target здесь — не поле digest. Это автор/граница представления
`DocumentContainer`, способные сделать точные bytes доступными по закреплённому
workspace/path. После приёмки Factory хранит разные серверные сущности:

```text
content_hash   = current observed container bytes (drift/CAS coordinate)
accepted_hash  = accepted immutable container version
criterionHash  = semantic hash of one parsed atomic AC section
```

Несколько AC-секций одного контейнера закономерно имеют одинаковый
`accepted_hash`, но разные `criterionHash`. При изменении контейнера invalidation
cone начинается с его принятой версии и замороженной baseline-проекции; при
ошибке только workspace/path до приёмки чинится presentation boundary, а не
подделывается новый hash.

#### Критерий recovery completeness

Для каждого дефекта из объявленной конечной fault-модели, при явных fairness и
single-fault assumptions, Factory обязан:

1. не принять нарушенное обязательство молча;
2. привязать evidence к точному subject/revision;
3. доставить reason/evidence авторизованному владельцу ремонта;
4. сохранить валидный accepted prefix и immutable историю;
5. создать новую исправленную ревизию и повторить применимые проверки;
6. прийти к acceptance либо к явному typed wait/terminal в пределах бюджета;
7. не оставить ownerless nonterminal scope или stranded obligation.

Эта теорема доказывает физику и причинность завода, но не универсальную
истинность семантического решения LLM. Semantic-adjudicated corpus и реальные
model canaries — отдельная теорема качества oracle-а.

Release-условие задаётся set-equality, а не процентом тестов:

```text
normative obligations
  = installed protection declarations
  = covered positive/negative/repair triples

emitted repair_required / failed / human_required reason classes
  = registered recovery routes or explicit unclassified typed terminals
```

Любое добавленное обязательство, provider, effect outcome или recovery reason
делает blocking proof красным, пока не появятся независимая норма, mutation и
замкнутый маршрут. `unclassified_fault` допустим как явный безопасный исход,
но не считается autonomous recovery и не может маскироваться generic `error`.

### Комбинаторика (сводно)

| Пространство | Размер | Метод |
|---|---|---|
| Машина ячейки | ~23 рёбра | полный перебор |
| Флоу цеха | 8–17 рёбер | edge + path coverage по исходам |
| Вердиктные цепочки | 3^n → O(n) классов | reason-identity свёртка |
| Fan-out DAG | e(P) ≤ N! | N≤4 исчерпывающе, далее формы |
| Obligation fault schedules | 5 handler-ов × легальные named cutpoints | полный перебор легальных расписаний |
| Цех×цех | ~10 рёбер | все рёбра |
| 4 цеха × всё × ремонт-петли | взрыв | **НЕ тестируем** — отсекается реестром рёбер |

### Чего НЕ тестируем (осознанно)

- Полный кросс-продукт цехов (см. таблицу выше).
- Реальную LLM на композиционных сценариях (недетерминизм убивает
  атрибуцию; это зона WORKSHOP W1–W3).
- Реальные внешние цели Delivery (провайдеры фейкаются; реальный deploy —
  не заводская теорема).
- Краши внутри SQLite/WAL — только на ЗАВОДСКИХ durable-границах.
- Multi-host диспетчеризацию (single-host по §22).
- Wave-10 ext-пакеты как продакшн (SPI-тесты достаточны).

---

## 2. Сводные графы цехов

| Цех | Флоу | Машина ячейки | Ключевые особенности |
|---|---|---|---|
| 1 Discovery | 7V/8E | 10 из 20 пар, 16 событий | нет ревью/эффектов; human_required-ребро объявлено, но не выстреливает; исход решает settlement-политика; lifecycle пермиссивный (все исходы → вперёд) |
| 2 Formalization | 10V/16E | 17 пар, две гейт-ветки (author/final) | 5 reviewed-столов × maxAttempts 5; два источника inconsistent (drift baseline и settlement); эффект accept-products → effect_pending; шов накопления закрыт ADR-078 модульно, композиционно — нет |
| 3 Development | 11V/17E(+4 мёртвых деклараций) | 21 пара + эффект | fan-out ×2 с DAG; failed верификации → settlement (upstream-эскалация); git-конфликт = типизированный исход; scope-widening до бюджетной арифметики |
| 4 Delivery | 9V/17E | внешних ячеек НЕТ: kernel/human + машина effect-действий (7 состояний) | 2 декларативных ребра недостижимы (#8/#9); гварды 1 и 10 чек-листа не кодовые; unknown-эффект → терминал blocked, intra-run ретрая нет |
| Завод | outcomeRoutes: 4+3+3+4 исхода; 6 obligation-рёбер | — | сертификат = капсульная граница; product-build терминал runnable-local без Delivery |

Общий структурный дефект, найденный в 3 цехах независимо: **декларации
`transitions.humanRequired` у ячеек без соответствующих flow-переходов** —
human_required паркует ворксплейс, ран встаёт в paused, а ребро в
`complete-blocked` фактически недостижимо. Либо рёбра нужны в flow, либо
декларации мертвы — зафиксировать тестом честность графа.

---

## 3. Реестр пробелов (сводный, с приоритетами)

### P0 — архитектурные proof'ы, не исполняющиеся сейчас

| # | Тест | Что доказывает | Нашёл |
|---|---|---|---|
| 0.1 | `golden-path-runb-replay` — вернуть Run B в `golden-path.test.mjs` (выключен, строки 358–363) | §16 two-pass: новый Factory Start того же проекта хитит капсулы, ноль вызовов модели, гейты новые. Без него капсульная экономика — вера | цех1 + стратег |
| 0.2 | `delivery-authorized-happy-path` | реальный kernel+runtime+ledger+git-провайдер → released. **Сейчас authorized-путь Delivery не покрыт НИ ОДНИМ тестом** (golden-path исключает Delivery, e2e мокает execute) | цех4 |
| 0.3 | `formalization-cross-lifecycle-isolation-composition` — два полных рана формализации на одном эпике, разный материал | композиционный proof ADR-078: settlement рана B видит только lifecycle B; epic accumulation запрещено, а не является целью | цех2 + стратег |
| 0.4 | `factory-obligation-crash-grid` — пять handler-ов × легальные named cutpoints | обобщение TB-12: каждое sync-ребро доводится до receipt, ни одно — в тихий простой | стратег |
| 0.5 | `third-lifecycle-run-dispatch` — 3 рана через реальный dispatch-loop со сменой пакета | K8/K9 end-to-end: hit → инвалидация → регенерация; выход из `FINAL_PRESENTATION_FENCE_MISMATCH` реально достижим (юнит биндера есть, диспетчеризации — нет) | стратег |
| 0.6 | `golden-path-discovery-repair` — ремонтная дуга (reject→repair→accept) на реальной ячейке Discovery | сейчас дуга доказана только на formalization-ячейке; + цеховые эпохи (ROLLOVER/backoff/TOTAL-CAP на реальной ячейке) | цех1 |

### P1 — сквозные циклы и окна цехов

| # | Тест | Суть |
|---|---|---|
| 1.1 | `delivery-crash-window-receipt-lost` | эффект применён, чек потерян → claim null → uncertain → blocked `action-receipt-missing` → continuation лечит. Самая тонкая дыра Delivery |
| 1.2 | `delivery-approval-flow-pause-resume` + `local-release-continuation` | human-пауза/резюм через flow-executor; continuation после approval-required — единственный полностью непокрытый операторский путь |
| 1.3 | `development-fanout-linear-extensions` | перебор порядков завершения DAG (N≤4): effective-base зависимых, сериализация мержей — ядро цеха, пространство не тронуто |
| 1.4 | `development-git-conflict-repair-cycle` | конфликт → repair_required → ребейз → merge; свидетельство не стёрто (ADR-074) |
| 1.5 | `formalization-verdict-trajectory` | качель двух бюджетов: author-accept → reviewer-invalid×k → defect-proven → автор-repair → final-accept |
| 1.6 | `resume-rewritten-handler` (K5 e2e) | переписанный settlement-хендлер → restart_required, не тихая подмена пина |
| 1.7 | `delivery-preflight-guard-matrix` + `observation-matrix` | по одному нарушению на гварды 2–9; item×receipt×required → точный исход settle |
| 1.8 | `development-effect-crash-windows` + `cas-target-advanced` | kill между update-ref и receipt; конкурентный CAS на ref |
| 1.9 | fault-injection 2 PENDING-рёбер реестра | `initial-discovery:failed`, `solution-development:failed` через kernel-seam |

### P2 — честность графа и наблюдаемость

- `human-required-edge-routing` (все 4 цеха): ребро достижимо или декларация мертва.
- `epoch-backoff-hold` — окно `rolledBackoffUntilMs` держит repair_wait.
- `review-budget-epoch-interplay` — reason-blind бюджет диспетчера × эпохи.
- `development-scope-widening-refusal` / `effect-stasis-park` / `cross-epoch-spin-memory`.
- `discovery-readiness-unresolved-hash` — bare-'error' провайдера = непрозрачный repair-loop.
- `delivery-pause-kind-observability` — human-пауза без `pause.kind` (минус наблюдаемости).
- `managed-empty-artifacts-gate-proof` — валидатор принял, гейт требует proof.
- `verification-continuation-runtime` — трасса adopt→verify→settle.

### Найденные дефекты документов/кода (чинить, не тестировать)

1. `CHECKS-DISCOVERY.md` — утверждение про Run B неверно (выключен); репейр-дуга — формализационная ячейка. **Исправлено 2026-08-20.**
2. `CHECKS-DELIVERY.md` — golden-path не гоняет Delivery; acceptance-effect-тесты — не Delivery. **Исправлено 2026-08-20.**
3. «Статус конформности» в CONVEYOR-MENTAL-MODEL устарел: ADR-077/078/079/080 закрыли три шва модульно — переписать (остаток: композиционные proof'ы + busy-точки).
4. Delivery: гварды 1 и 10 префлайта не кодовые (документация обещает больше кода); ребра #8/#9 недостижимы; `pause.kind` не проставляется.
5. TB-5 (мусор в dist) — открыт; TB-6 (HASH_DRIFT) — недоказанная гипотеза, форензика до любых ослаблений.

---

## 4. Единый recovery playbook («что делать, когда случилось»)

Принцип: **Recovery = ремонт того же Workplace; Checkpoint = та же машина
рана; Replay = реиспользование производства; Continuation = новый ран от
принятого префикса.** Выбор — всегда минимальный уровень. Терминал не
откатывается; карточка не пересоздаётся; Kanban не откатывается в todo.

### Уровень 1 — авто (человека не звать)

| Ошибка | Диагностика | Действие |
|---|---|---|
| repair_required (гейт) | `factory_gate_decisions` + RecoveryIssue с диагностиками | новый fenced-воркер на тот же стол с feedback; бюджет эпохи |
| Исчерпание эпохи | `[recovery-budget] ROLLOVER` лог; `factory_workplace_recovery_epochs` | backoff 1→15 мин, потом requeue; повтор диагноза через эпоху → ROLLOVER-DENIED → терминал |
| Спин/потолок | TOTAL-CAP 30 / CONVERGENCE-CEILING 20 | честный terminal failed с surviving-ключами → оператор (уровень 3) |
| Воркер потерян | `worker_executions` terminal, supervision | перезаклейм того же стола (lease/fence) |
| Git-конфликт | typed outcome + ADR-074 issue | автор ребейзит; accepted-свидетельство не стирается |
| Обязательство-лайвлок | `last_reason_key`+`reason_repeat_count` | клапан N=3 → terminal abandon `OBLIGATION_VALVE` |
| Фриз движка | heartbeat >120с при живом pid; `factory_engine_watchdog_events` | supervisor: soft-stop → resume-код; backoff 1→5→15; бюджет → `failed_watchdog` |
| Краш между durable-границами | obligations; terminal-accepted без FinalAcceptance | redrive идемпотентен (C8); вмешательство не требуется |

### Уровень 2 — цех (continuation, `scripts/factory.mjs continue`)

| Ситуация | Команда |
|---|---|
| Terminal failed Development при принятом префиксе | `continue --from-lifecycle N --adopt-task T --scope ...` (сначала `--check` на копии) |
| Верификация упала при принятой интеграции | `continue --verification-only` |
| approval-required + операторский грант | `continue --local-release` (child только suffix) |
| Отравлённый Development при живой формализации | `redevelop --from-lifecycle N` |

### Уровень 3 — завод (оператор)

`stop` (многофазный) / `resume` (+узкие флаги: `--requeue-paused`,
`--recover-failed-gate`, `--recover-missing-product`, `--resume-worker-loss`) /
`unpark` / `rerun` / `abandon` / checkpoint-restore
(`restore-from-checkpoint.mjs --fix-stuck|--reset-stage`).
Перед ручным — снапшот БД. «Завод стоит» ≠ resume сразу: сначала последний
отклонённый MCP-вызов и `production_envelope` в `factory_node_runs` (урок TB-8).

### НЕЛЬЗЯ (§15/§27)

SQL-ом done; удалять ProcessRun/StageRun «для разблокировки»; менять
accepted-артефакты/хэши; возвращать терминал в running; тот же
idempotency-key с другим input; молча править инструкции в живом прогоне.

### Человек обязателен (исчерпывающе после ADR-075)

1. Delivery approval + локальный release-грант.
2. human_required вне цикла качества: readiness-сужение, заблокированные
   эффекты, поломка спавна.
3. Операторские решения над честными терминалами (failed_watchdog,
   approval-required, development-blocked) — continue или abandon.
В цикле качества человека НЕТ (эпохи до потолка 30).

---

## 5. Definition of Done архитектурного рефакторинга

Рефакторинг имеет конечную SMART-цель: на свежих БД production Factory должен
без человека сначала произвести и принять простой эталонный продукт, а затем в
отдельном прогоне обнаружить заранее внесённый исправимый дефект, доставить exact
feedback причинному владельцу, создать новую immutable revision и завершиться в
пределах бюджета.

Архитектурная программа закрыта, когда одновременно:

1. приняты W0-1…W0-4 и P0 proofs W1-1…W1-4;
2. прошли fresh scripted happy и repair E2E через production composition;
3. прошли real-model happy и repair canary через opencode, Docker,
   concurrency `1`, без SQL-правок, `unpark`, подмены результата и hidden resume;
4. durable trace сохраняет цепочку `WorkIntent → ProductRef → ProductionRevision
   → CandidateSet → GateDecision → effect/final receipt → terminal`;
5. после fair drain нет `DEFERRED`, ownerless nonterminal, material selection по
   latest/task/execution, ручного восстановления и ложного terminal label.

До canary допускается максимум две итерации исправлений scripted E2E. После
достижения цели локальный баг получает обычный `fix`, новый объявленный fault —
obligation/constraint, слабость LLM — prompt/model/eval. Новый архитектурный ADR
допустим только при нарушении authority invariant. W1-5 продолжает систематическое
mutation coverage, но не удерживает проект в бесконечном refactor после P0 и двух
успешных canary.

## 6. Дорожная карта

- **Волна 0 (proof kernel)**: выбрать одну production composition authority;
  запретить четвёртый harness; валидировать реальный overlay, а не toy-object;
  ввести obligation-contract compiler, mutation algebra, общий trace vocabulary,
  Scenario DSL и
  первый causal proof `fabricated-derived-evidence`. Ни temporal, ни W9 proof
  не считается существующим, пока он не входит в blocking acceptance matrix.
- **Волна 1 (P0)**: 6 тестов раздела 3 + исправление «Статуса конформности».
  Критерий готовности: §16-proof зелёный, authorized-Delivery зелёный,
  obligation-сетка зелёная без единого тихого простоя.
- **Волна 2 (P1)**: 9 сквозных циклов; критерий: реестр рёбер без PENDING;
  каждый цеховой граф — полный edge-coverage.
- **Волна 3 (P2)**: честность графа (мёртвые декларации), наблюдаемость,
  interplay бюджетов; решение о statechart explorer §23 (строить или
  считать matrix+сетку достаточными).
- **Связка с WORKSHOP-планом**: волны 1–2 — ДО раунда W2 (формализация
  опирается на proof 0.3/0.5); качество цехов — как в WORKSHOP-плане.

## 7. Исходные материалы

Полные граф-отчёты цехов (машинные состояния, все corner cases, per-цеховые
playbook'и) — в сессии анализа 2026-08-20; карты проверок:
`docs/architecture/checks/CHECKS-*.md` (с секциями «Покрытие тестами»).
Ключевые файлы рантайма — см. указатели в конце каждой карты.
