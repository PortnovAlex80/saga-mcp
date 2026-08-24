# ADR-053: Accepted material is a sealed Workplace production revision; WorkerExecution is provenance only

- **Status:** Accepted (see the 2026-08-25 addendum; closure evidence state is tracked separately in the closure registry)
- **Date:** 2026-08-10
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** review of Run 011 stabilization chain
- **MUST READ:** before any further Factory stabilization commit or real-model run.

---

## ⚠️ Обязательно прочитать для продолжения работы

Этот документ — архитектурный диагноз, не очередная точечная regression.
Прочитать **до** следующего `fix(formalization): handle another recovery case`.
Дальнейший live-debugging без cutover материального авторитета имеет
убывающую отдачу. См. «Итоговый вердикт» в конце.

---

## Архитектурный диагноз

Да, здесь обнаруживается не просто длинная серия независимых багов, а
системная архитектурная проблема.

Но сама идея завода — `Factory → Workshop → Production Cell → Workplace →
CandidateSet → Gate → Effect` — не выглядит принципиально ошибочной. Ошибка
находится в центре модели собственности на производимый материал:

> В нормативной модели владельцем всей работы является Workplace, но в
> нескольких ключевых API и типах владельцем материала всё ещё считается
> последнее WorkerExecution.

Из-за этого система одновременно реализует две несовместимые модели:

### 1. Workplace-scoped model

Рабочий стол переживает рабочих, повторные попытки, падения, автора,
рецензента и ремонт. Новый рабочий продолжает то, что осталось на столе.

### 2. Execution-scoped model

`CandidateSet` запечатывается от имени одного `producerExecutionRef`;
`produced`-члены считаются созданными этим исполнением;
post-acceptance effect получает `producerExecutionRef` и может снова искать
материал по нему.

Последний коммит как раз вскрыл это противоречие. Новый
`WorkplaceProductionSnapshot` явно разделяет:

- `presenterExecutionRef` — кто предъявил работу;
- `contributingExecutionRefs` — кто реально внёс части материала.

Но `CandidateSet` по-прежнему определён как партия, произведённая одним
`execution`, его ключ включает `producerExecutionRef`, а post-acceptance API
продолжает передавать это поле как будто оно является материальной властью.

**Это и есть главная архитектурная трещина.**

---

## Что произошло в Run 011

Сценарий последнего бага выглядит так:

```text
Workplace
 ├─ Execution A
 │   └─ brief + PRD
 │
 └─ Execution B (после восстановления)
     └─ FR + NFR + RULE

Итоговый принятый CandidateSet:
  brief + PRD + FR + NFR + RULE

Post-acceptance effect:
  выбрал только продукты Execution B

Результат:
  prd-missing
```

То есть Gate принял полное состояние общего рабочего стола, а effect снова
перешёл к старой картине мира: «продукт — это то, что сделал последний
рабочий».

Коммит `72fdd3e1…` исправляет конкретный effect: теперь он извлекает
принятый snapshot через точный `candidateSetRef` и проецирует вклад всех
исполнений. Но внешний интерфейс effect всё равно содержит
`producerExecutionRef`, а для typed submissions сохранён execution-scoped
fallback. Поэтому исправлен один потребитель, но возможность повторения
того же класса ошибки в другом effect остаётся.

Дополнительное подтверждение находится в универсальном executor:

- интерфейс всё ещё называется `readExecutionProducts`;
- сначала он получает `executionRef`;
- только после этого для managed production восстанавливает Workplace;
- после Gate он передаёт effect одновременно `candidateSetRef` и
  `producerExecutionRef`;
- выходной manifest продолжает публиковать `producerExecutionRef` как
  основную координату результата.

Получается, Workplace пока является каноническим владельцем по документации
и некоторым новым адаптерам, но не является единственной допустимой единицей
материальной авторитета на уровне типов.

---

## Что показывает история коммитов

История ночной работы очень показательна. Это не повторение одного и того
же бага. Каждый новый реальный прогон проходил исправленную границу и ломался
на следующей.

### 1. Цепочка reviewer authority

Последовательность:

- `105de75` — malformed review verdict принимался хранилищем;
- `20b924f` — Gate не понимал structured findings;
- `9f24c1b` — reviewer payload contract не попадал в WorkIntent;
- `f10d095` — отдельный worker MCP process не установил те же decoder-ы;
- `63639e4` — структурно корректный reviewer указал Workplace ref вместо
  точного CandidateSet ref.

То есть проверка постепенно поднималась:

```text
Gate
  → payload decoder
  → WorkIntent
  → MCP composition
  → exact relational authority binding
```

Это означает, что authority не переносилась как один атомарный объект. Она
каждый раз заново собиралась из строк, schema IDs, registry registrations и
metadata на новом слое.

### 2. Цепочка Git/write authority

Затем реальный worker изменил файлы за пределами разрешённого scope. Reviewer
это одобрил, потому что scope был частью prompt, а не исполняемой властью.
После этого был добавлен детерминированный Git Gate и object-level merge.

Следующий прогон сломался уже на представлении данных: реальные workers
передали `changedFiles` как typed objects, а test fixture и decoder ожидали
`string[]`.

То есть снова:

```text
правильная идея authority
  → authority не выражена типом
  → prompt заменяет enforcement
  → enforcement добавлен
  → внешний payload имеет другое представление
```

### 3. Цепочка SRS и acceptance criteria

Далее четыре последовательных исправления одной материальной границы:

- один Markdown artifact ошибочно считался одним acceptance criterion;
- parser понимал только один уровень заголовков;
- несколько atomic artifact rows ссылались на один общий документ, но каждый
  row повторно парсил весь файл;
- `acceptedHash` одновременно использовался как hash принятого документа и
  hash отдельного критерия.

Это уже не ошибки LLM. Это отсутствие явно смоделированных сущностей:

- `DocumentContainer`
- `AtomicContractMember`
- `ContainerAcceptanceHash`
- `MemberSemanticHash`

Пока этих сущностей не было, смысл восстанавливался из Markdown-заголовков,
artifact rows и перегруженного поля `acceptedHash`.

### 4. Recovery вернул проблему к Workplace

После reviewer, Git и SRS реальный прогон дошёл до восстановления рабочего.
Там выяснилось, что принятый продукт уже Workplace-scoped, но effect остался
execution-scoped.

Таким образом, Run 011 не открыл случайный дефект Formalization. Он замкнул
круг и доказал, что основной runtime всё ещё не полностью перешёл на модель
общего рабочего стола.

### 5. Это повторение более старого паттерна

В июле уже был практически тот же мета-дефект: новый lifecycle kernel
существовал в тестах и backfill-логике, тесты были зелёными, но production
dispatcher продолжал напрямую менять старое состояние. В execution plan
отдельно требовалось сначала подключить новый application service, а затем
удалить старую машину переходов.

Это повторяющаяся стратегия миграции:

```text
новая архитектура добавляется рядом со старой
  → тесты доказывают новую архитектуру
  → production продолжает иметь старый путь
  → compatibility fallback остаётся
  → следующий компонент случайно выбирает старую единицу истины
```

Это можно назвать **strangler migration without strangulation**: новая
модель появляется, но старая не удаляется.

---

## Классификация природы багов

### 1. Ошибки материального авторитета — критические

Примеры:

- Workplace ref вместо CandidateSet ref;
- reviewer prose вместо Git authority;
- post-acceptance effect читает последнее execution;
- consumer повторно ищет материал, хотя точный CandidateSet уже принят.

Общий дефект:

> После появления точной immutable authority система продолжает передавать
> рядом альтернативные координаты: execution, task, node, latest submission.

Пока они доступны в API, какой-нибудь следующий adapter снова выберет
неверную.

### 2. Ошибки идентичности и кардинальности — критические

Примеры:

- один artifact container против пятнадцати atomic criteria;
- N rows, указывающих на один документ;
- один hash используется для контейнера и его semantic member;
- snapshot, CandidateSet и accepted artifact описывают один материал разными
  способами.

Общий дефект:

> В системе нет одного канонического material model. Один продукт
> многократно перекодируется между таблицами, документами, ProductRef,
> CandidateSet, accepted artifacts, baseline и DevelopmentCase.

Фактический маршрут сейчас примерно такой:

```text
worker output
  → managed production rows / typed submission
  → mutable Workplace desk
  → WorkplaceProductionSnapshot
  → process product
  → CandidateSet member
  → GateDecision
  → effect
  → accepted artifact rows
  → Formalization baseline
  → Solution Contract
  → DevelopmentCase
```

Каждая стрелка — место, где можно потерять:

- идентичность;
- кардинальность;
- provenance;
- hash;
- subject ref;
- форму payload.

Ночная история прошла почти по всем этим стрелкам.

### 3. Ошибки распространения контрактов — высокие

Контракт был:

- объявлен в module;
- зарегистрирован в orchestrator;
- не скопирован в reviewer WorkIntent;
- не установлен в другом MCP process;
- затем проверял только форму, но не exact subject identity.

Это показывает, что Workshop пока не является автономным versioned package,
содержащим полный набор:

- cell definition
- product schemas
- payload decoders
- gate providers
- effects
- skills
- execution profiles
- authority bindings
- installation digest

Вместо этого часть capability собирается через process-global registries.
Реальный orchestrator и отдельный worker MCP process поэтому могут получить
разные наборы contract decoder-ов. Именно это уже произошло в LIVE-REVIEW-004.

В текущем коде effect registry также является process-global singleton, а
composition root хранит «последние созданные» assignment/executor handles в
module-level переменных. В пределах одного процесса это поддерживает идею
«одного завода», но между отдельными процессами единство приходится
восстанавливать вручную.

### 4. Ошибки нормализации внешнего представления — высокие

Примеры:

- `findings: string[]` против structured objects;
- `changedFiles: string[]` против `{path, status}[]`;
- `## AC-1` против `### AC-1.1`;
- Markdown table против subsections;
- Workplace-shaped ref против CandidateSet-shaped ref.

Общий дефект:

> Внешнее представление LLM слишком глубоко проникает в domain/runtime.

Нормализация должна происходить один раз на ingress:

```text
untrusted LM payload
  → versioned decoder
  → canonical domain command/product
```

После этого внутренний runtime не должен снова разбирать свободные
JSON/Markdown-варианты.

### 5. Ошибки temporal ownership — критические

Ранее был зафиксирован legal-but-stalled state:

```text
WorkerExecution = exited
Workplace        = verifying
Task             = in_progress
Lifecycle        = paused
Candidate/Gate   = absent
```

Все локальные состояния были допустимыми, но ни один компонент не владел
следующим переходом. Локальные unit/repository tests не могли это поймать,
потому что их doubles одновременно меняли execution и host state, тем самым
удаляя реальный interleaving.

ADR-048 и ADR-049 правильно распознали проблему, но durable obligation ledger
был отложен. Temporal harness наблюдает потерянный переход, однако сам не
делает каждый межмашинный handoff долговечным и принадлежащим конкретному
owner.

Отдельные state machines здесь не являются ошибкой. Ошибка — их неявная
синхронизация через повторный запуск reconciler-а, без durable obligation:

```text
CandidateSet sealed   → Gate must run
Gate accepted         → Effect must run
Effect settled        → Process must settle
Process settled       → Lifecycle must route
```

Каждая такая стрелка должна иметь записанное обязательство, fence и
idempotent completion receipt.

### 6. Ошибки тестовой архитектуры — высокие

Tracker уже содержит случаи, когда тесты:

- проходили с нулевым dependency DAG;
- использовали внешнюю отсутствующую fixture;
- копировали только основной SQLite-файл без WAL и создавали невозможное
  состояние;
- использовали всегда корректного scripted reviewer;
- использовали одно artifact = один criterion;
- использовали только строковый вариант `changedFiles`.

Это не означает, что тесты бесполезны. Они хорошо предотвращают повторение
уже известного конкретного контрпримера. Но пока они плохо исследуют
пространство эквивалентных представлений и перекрёстных комбинаций.

---

## Главная концептуальная ошибка

В модели отсутствует одна явная сущность:

> Неизменяемая ревизия производственного материала общего Workplace.

Назовём её `WorkplaceProductionRevision`.

Сейчас её обязанности частично распределены между:

- mutable Workplace desk;
- `WorkplaceProductionSnapshot`;
- `ProductRef`;
- execution-owned `CandidateSet`;
- accepted artifacts;
- baseline.

Правильная цепочка должна выглядеть так:

```text
WorkerExecution
    |
    | создаёт Contribution
    v
Workplace (mutable общий рабочий стол)
    |
    | seal
    v
WorkplaceProductionRevision (immutable точное состояние материала)
    |
    | submit to QC
    v
CandidateSet (точная партия на проверку)
    |
    | GateDecision
    v
AcceptedCandidateAuthority
    |
    | deterministic effects
    v
CellFinalAcceptance
```

### WorkerExecution

Только:

- lease;
- fence;
- actor;
- contributor;
- provenance;
- причина запуска;
- attempt accounting.

Он **не** владеет итоговым материалом общего стола.

### Workplace

Владеет:

- рабочей историей;
- вкладом всех attempts;
- repair continuity;
- author/reviewer cycle;
- mutable текущим состоянием.

### WorkplaceProductionRevision

Должна содержать:

```text
WorkplaceProductionRevision {
  revisionRef
  workplaceRef
  parentRevisionRef
  materialMembers[]
  contributingExecutionRefs[]
  presenterRef
  materialDigest
  semanticDigest
  sealedAt
}
```

`presenterRef` означает лишь: кто инициировал предъявление текущей ревизии.
Это **не** владелец всех её членов.

### CandidateSet

Должен ссылаться на точную `WorkplaceProductionRevision`, а не считать
последнее execution владельцем всей партии.

Минимальное исправление модели:

```text
producerExecutionRef
        ↓
presenterRef / sealTriggerRef
```

И убрать утверждение, что все `produced` members обязательно были созданы
этим execution.

Более чистое исправление:

```text
CandidateSet {
  candidateSetRef
  workplaceRef
  productionRevisionRef
  role
  subjectCandidateSetRef
  presenterRef         // provenance only
  members              // exact immutable ProductRefs
}
```

---

## Что означает «единый рабочий стол»

Это не означает, что все workers обязаны физически работать в одной
директории.

Отдельные Git worktrees для:

- автора;
- параллельного автора;
- reviewer-а;
- repair attempt

— нормальны и даже необходимы.

Единый стол означает другое:

> У всех физических desks должна быть одна логическая цепочка
> `Workplace → ProductionRevision`, и ни один consumer не должен считать
> конкретную директорию, task или execution владельцем принятого материала.

То есть проблема не в изолированных worktrees. Проблема в переходе:

```text
logical Workplace material
  → обратно к latest execution
```

---

## Что означает «единый цех»

Workshop должен быть immutable installed package, а не набором регистраций,
которые разные процессы повторяют вручную.

Нужен единый `InstalledWorkshopManifest`:

- module identity
- cell definitions
- product contracts
- payload decoders
- check providers
- post-acceptance effects
- skills
- execution profiles
- authority bindings
- package digest

Orchestrator и worker MCP должны запускаться с одним и тем же manifest
digest. При несовпадении startup должен завершаться ошибкой до выдачи работы.

Тогда ситуация «orchestrator знает decoder, worker MCP не знает decoder»
станет конструктивно невозможной, а не просто покрытой regex-тестом по
исходнику.

---

## Почему зелёные тесты не помогли

### 1. Они доказывали не ту теорему

Большинство локальных тестов доказывает:

> Если данный компонент вызван с ожидаемым объектом, он делает правильный
> переход.

Реальные баги задают другие вопросы:

- Кто вызовет этот компонент?
- С каким exact subject?
- Из какого процесса?
- После какого interleaving?
- Не восстановит ли он материал заново по execution?
- Совпадают ли container и semantic member?

ADR-048 именно поэтому появился после состояния, в котором все локальные
машины были легальны, но следующий переход никто не вызвал.

### 2. Scripted workers слишком корректны

Golden scenarios сами:

- находят точный author CandidateSet;
- вставляют правильный `subject_candidate_set_ref`;
- создают канонический SRS;
- используют простую cardinality;
- передают ожидаемые типы;
- строят предсказуемый DAG.

Они проходят настоящий MCP и production finalizer, что полезно. Но cognition
и payload generation задаются детерминированным scenario handler. Поэтому
wrong-but-well-formed ответы реального LLM почти не исследуются.

### 3. Temporal harness подменяет слишком крупный порт

Temporal composition всё ещё подменяет `workerExecutorFactory`,
verification provider и Delivery providers. Она сохраняет много production
physics, но это шире, чем «заменить только inference». Сам ADR-049 признавал,
что первая версия заменяла весь `WorkerExecutorFactory`, а не только
модельную когницию.

В текущем composition root уже имеется более узкий `workerSpawn` seam. Именно
его нужно использовать для canonical tests: assignment, desk provisioning,
MCP config, contract manifest и finalization должны оставаться абсолютно
production.

### 4. Fixtures кодировали архитектурные предположения

Тест с одним artifact на один criterion фактически утверждал, что это
допустимая универсальная модель. Потом реальный документ содержал много
criteria, и предположение рухнуло.

То же самое произошло с:

- zero-edge DAG;
- `string[]`;
- string findings;
- SQLite main-file copy;
- compliant reviewer.

То есть тесты не только пропустили баг — местами они закрепили неверную
модель как нормальную.

### 5. Regression tests строятся вокруг инцидента

После каждого live failure создаётся хороший точечный regression. Но это всё
ещё схема:

```text
увидели один вариант
  → добавили одну fixture
  → следующий run принёс соседний вариант
```

Нужны не десятки incident-shaped tests, а несколько генеративных invariants,
которые покрывают целый класс представлений.

### 6. Полный E2E ещё не закрыт

Tracker фиксирует зелёные 75/75 Factory Contract и 31/31 temporal tests, но
clean scripted E2E и clean real-model E2E оставались незавершёнными.
Последний commit также сообщает только о focused effect regression и прямо
требует нового clean run.

Поэтому зелёный suite пока означает:

> Известные локальные и temporal контракты выдержаны.

Но не:

> Вся фабрика доказанно сохраняет идентичность материала через любой
> реальный payload и recovery path.

---

## Что нужно изменить

### Шаг 1. Остановить цикл «ещё один real run → ещё один adapter fix»

Следующий реальный запуск сейчас, вероятнее всего, просто найдёт следующую
границу перекодирования.

Real LLM фактически используется как дорогой структурный fuzz-тестер. Это
полезно для исследования, но не является устойчивым способом завершить
архитектуру.

Сначала нужен cutover материального авторитета.

### Шаг 2. Принять отдельное архитектурное решение

Предлагаемое название:

> **ADR-053: Accepted material is a sealed Workplace production revision;
> WorkerExecution is provenance only.**

Основные положения:

1. Workplace — единственный владелец рабочего материала.
2. Execution создаёт contribution, но не владеет итоговым состоянием стола.
3. Перед Gate формируется immutable `WorkplaceProductionRevision`.
4. `CandidateSet` ссылается на эту ревизию.
5. Gate, effects, settlement и downstream handoff работают только с exact
   revision/candidate refs.
6. Execution/task/node IDs после seal используются только для audit и
   telemetry.
7. Старые execution-scoped material lookups удаляются, а не сохраняются как
   постоянный fallback.

### Шаг 3. Изменить post-acceptance authority

Вместо текущего:

```text
PostAcceptanceEffectInput {
  workplaceRef
  processRunId
  nodeId
  candidateSetRef
  producerExecutionRef
  expectedProductSchema
}
```

должно быть:

```text
AcceptedCandidateAuthority {
  workplaceRef
  candidateSetRef
  productionRevisionRef
  acceptedProductRefs
  gateDecisionRef
  productContractRef
  acceptanceDigest
}
```

Effect не должен:

- искать production rows по execution;
- искать latest task;
- искать latest submission;
- повторно связывать product через loose schema/ref/hash join;
- самостоятельно решать, typed это source или managed.

Все эти решения должны быть уже приняты до Gate.

### Шаг 4. Нормализовать product sources до CandidateSet

Сейчас managed production и typed submission остаются разными путями глубоко
внутри runtime.

Нужно:

```text
Managed artifacts adapter
        \
         → canonical Product/Revision
        /
Typed submission adapter
        /
Git contribution adapter
```

После формирования `WorkplaceProductionRevision` core больше не знает, каким
был источник:

- Markdown artifacts;
- JSON typed submission;
- Git commit;
- generated evidence;
- carried-forward product.

`productSource` должен исчезнуть из post-gate поведения.

### Шаг 5. Удалить перегруженные identity-поля

Для Formalization необходимо закрепить отдельные поля:

- `containerArtifactRef`
- `containerAcceptedHash`
- `memberCode`
- `memberSemanticHash`
- `memberAnchor`
- `productionRevisionRef`
- `candidateSetRef`

Никакое поле `acceptedHash` не должно одновременно означать:

- hash принятого файла;
- hash секции;
- hash ProductRef;
- baseline hash.

Markdown должен быть распарсен один раз в момент acceptance. Downstream
получает замороженный member manifest и больше не выводит atomic cardinality
заново из файла.

### Шаг 6. Сделать Workshop manifest единым

Убрать ручное повторение:

```js
registerProductPayloadContract(...)
registerFactoryPostAcceptanceEffect(...)
registerFactoryCheckProvider(...)
```

из нескольких process roots.

Вместо этого:

```text
InstalledWorkshopManifest
  → orchestrator installation
  → worker MCP installation
  → test installation
```

Каждый процесс записывает и сверяет один `installationDigest`. Несовпадение —
hard startup failure.

### Шаг 7. Добавить durable transition obligations

Не нужно создавать одну гигантскую глобальную state machine. Нужно сохранить
отдельные bounded machines, но сделать их синхронизацию явной:

```text
CandidateSetSealed   → obligation: RunAuthorGate
GateAccepted         → obligation: RunPostAcceptanceEffects
EffectsSettled       → obligation: RecordFinalAcceptance
FinalAcceptanceRecorded → obligation: SettleProcess
ProcessSettled       → obligation: RouteLifecycle
```

Каждое обязательство:

- записывается атомарно с исходным переходом;
- имеет owner;
- имеет fence;
- выполняется idempotently;
- получает completion receipt;
- может быть найдено reconciler-ом после crash.

---

## Какие тесты нужны вместо текущей цепочки регрессий

### 1. Authority conservation

Для любого accepted Workplace:

```text
Gate.subject
  ==
CandidateSet
  ==
Effect.input
  ==
FinalAcceptance.candidate
  ==
Downstream product
```

Дополнительные adversarial условия:

- появляется более новый execution;
- появляется более новый task;
- появляется unrelated submission;
- последний worker содержит только часть материала;
- reviewer передаёт другой, но формально корректный ref.

Результат не должен измениться.

### 2. Contribution partition invariance

Один и тот же материал производится:

- одним execution;
- двумя executions после network loss;
- тремя repair attempts;
- carry-forward + repair.

При одинаковом финальном столе semantic material revision должна быть
одинаковой.

```text
A produces X+Y
```

эквивалентно:

```text
A produces X
B continues and produces Y
```

Последний Run 011 должен стать частным случаем этого общего property test.

### 3. Cardinality conservation

Для любого Formalization input:

```text
frozen atomic members
  ==
SRS D2 members
  ==
Solution Contract criteria
  ==
DevelopmentCase criteria
```

Варианты:

- один criterion в одном файле;
- много criteria в одном файле;
- много файлов;
- parent + dotted children;
- standalone level-two AC;
- разные допустимые порядки;
- shared document anchors.

### 4. Representation normalization

Эквивалентные входы:

```text
"src/a.ts"
{ path: "src/a.ts", status: "modified" }
```

должны нормализоваться в один domain object.

То же для:

- string/structured findings;
- ref objects;
- headings;
- decision-log representations.

После decoder boundary внутренние тесты больше не должны знать о внешних
вариантах.

### 5. Composition parity

Тест запускает:

- orchestrator;
- worker MCP;
- test worker

с одним frozen package manifest и проверяет digest handshake.

Нельзя проверять это только regex-поиском вызова регистрации в `src/index.ts`.

### 6. Mutation tests архитектурных запретов

Нужно намеренно вернуть:

- execution-scoped effect query;
- latest submission;
- отсутствие decoder в worker process;
- zero-edge dependency graph;
- container hash вместо member hash.

Suite должен гарантированно стать красным.

Это докажет, что тесты защищают архитектурный инвариант, а не только ожидаемый
happy path.

---

## Жёсткие критерии завершения cutover

До следующего финального real-model прогона зафиксировать следующие критерии:

1. В `PostAcceptanceEffectInput` отсутствует `producerExecutionRef`.
2. После CandidateSet seal ни один material consumer не выбирает данные по
   `execution_id`, `task_id`, `node_id` или `latest`.
3. `CandidateSet` ссылается на immutable Workplace production revision.
4. `producerExecutionRef` переименован в provenance-only `presenterRef` либо
   удалён из CandidateSet authority.
5. Typed, managed и Git production нормализованы до одного core material
   contract.
6. Формат документа и atomic members связываются один раз и сохраняются как
   versioned manifest.
7. Все workshop capabilities поступают из одного installed manifest.
8. Каждый cross-machine handoff имеет durable obligation либо атомарный
   outbox.
9. Run 011 воспроизводится как общий partition-invariance test.
10. Clean scripted E2E и clean real canary стартуют с новой БД и нового
    repository без reload-зависимых старых процессов.

---

## Итоговый вердикт

Завод выбрасывать не нужно.

Но продолжать текущую стабилизацию в форме локальных patches тоже нельзя.

Главная проблема состоит из двух частей:

1. **В доменной модели отсутствует явная immutable ревизия материала общего
   Workplace.** Поэтому CandidateSet одновременно пытается быть execution
   output и принятым состоянием общего стола.

2. **Миграции выполняются добавлением новой модели рядом со старой, а не её
   полным cutover.** Старые execution/task/latest пути остаются доступными
   и периодически снова становятся фактической authority.

Sol Ultra не «не смог исправить один баг». Он последовательно устранил целую
цепочку реальных дефектов и каждый раз открывал следующую потерю смысла между
представлениями. Это полезная работа, но она показывает, что дальнейший
live-debugging будет иметь убывающую отдачу.

Следующий существенный commit должен быть не очередным:

```text
fix(formalization): handle another recovery case
```

а архитектурным cutover:

```text
refactor(factory): make sealed Workplace production revision
the sole accepted-material authority
```

После него реальная модель перестанет быть основным средством поиска очередного
адаптерного дефекта и вернётся к правильной роли — финального canary поверх уже
доказанной фабричной физики.

---

## Addendum 2026-08-25 — implementation truth and closure state

This decision was executed through releases K6–K13 (material-authority
cutover phases 3–7) and independently re-audited on 2026-08-24/25 as Phase 3
of `docs/plans/CANONICAL-CONSISTENCY-AND-ADR053-CLOSURE-PLAN.md`. The full
per-criterion evidence matrix is
`docs/verification/ADR-053-CLOSURE-MATRIX-2026-08-25.md`. Summary of the
audited truth:

- **EC-1..EC-9 of the «Жёсткие критерии завершения cutover» are MET** with
  blocking, executable proofs run green on the audited canonical tree
  (`57468bb6`), including the three residuals named by the 2026-08-16
  conformance audit — the epic-scoped settlement readers are deleted (exact
  lifecycle-scoped reads only), the replay capsule binder binds by semantic
  key (typed conflict, never newest-wins), and resume compatibility compares
  handler implementation digests (drift → restart-required, never
  compatible). `producerExecutionRef` no longer exists in `src/`; the effect
  input is exactly `AcceptedCandidateAuthority`.
- **EC-10 remains OPEN.** The scripted-E2E leg was red at the audit base and
  is repaired on the canonical line (`9ff82434` merged as `a4565be0`:
  `SUBMISSION_VALIDATION_POLICY_MISSING@4.0.0` production wiring repair +
  stale admission fixtures; w9-02/w9-03/golden-path 10/10 green). Its
  frozen-immutable-build confirmation and the clean real canary are Phase-7
  qualification evidence under ADR-096 and are NOT claimed here.
- **Vocabulary reconciliation (EC-6):** the implemented contract fulfills the
  criterion through the schema-versioned frozen baseline manifest
  (per-AC artifact/code/hash entries frozen once at acceptance); the literal
  entity names proposed in «Шаг 5» (`DocumentContainer`,
  `containerAcceptedHash`, `memberSemanticHash`, `memberAnchor`) were not
  introduced. Substance implemented, names differ.
- **Workshop manifest (EC-7):** one declarative capability manifest with a
  deterministic digest is installed by both process roots with fail-closed
  binding receipts; cross-process equality holds by construction and is
  durably recorded rather than compared at dispatch.
- **Out of scope, recorded separately:** CC-U2 (non-circular warrant
  oracle-command authority) is an open gap owned by reserved ADR-093 — it is
  not an ADR-053 exit criterion and is not folded into this decision's
  closure.

**Decision status:** Accepted — the cutover direction is normative and
executed; execution vocabulary (`presenterRef`,
`WorkplaceProductionRevision`, `AcceptedCandidateAuthority`) is the shipped
code. **Closure state:** in-progress — closure requires the Phase-7 evidence
(EC-10) per the closure plan §3.4; the closure registry tracks this
separately and its `in-progress` value remains the truthful record.
