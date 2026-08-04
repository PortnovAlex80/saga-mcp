# Factory Domain Acceptance Registry

Статус: **нормативное приложение к целевой архитектуре Saga4**. Версия 1.

Связанный документ: [Conveyor Mental Model](CONVEYOR-MENTAL-MODEL.md).
Формальные safety-инварианты CGAD имеют приоритет; этот реестр нормативен для
доменного языка, поведения сущностей, архитектурных границ и критериев приёмки.
Указанный машинный контракт является целевой семантикой, а не утверждением, что
одноимённый класс или таблица уже существуют в production-коде. Текущие разрывы
и migration seams описываются в Conveyor Mental Model и implementation plans.

## 1. Зачем существует этот реестр

Имена классов, таблиц, функций и переменных могут меняться. Доменный смысл
меняться незаметно не может. Код считается соответствующим модели завода не по
словам `Factory`, `Workshop` или `Worker` в имени, а по наблюдаемому поведению,
identity, lifetime, authority и исполняемым инвариантам.

Для каждого понятия реестр отвечает на шесть вопросов:

1. Как этот объект или процесс называется для человека?
2. Чем он является в коде: aggregate, entity, definition, value/evidence,
   projection, domain service или infrastructure mechanism?
3. Какова его identity и сколько он живёт?
4. За что он отвечает и чего делать не имеет права?
5. Почему заводская аналогия соответствует этому поведению?
6. Какими тестами и наблюдаемыми фактами это принимается?

Поле **«Человеческое поведение»** в карточках и есть обоснование знака `=`:
аналогия считается верной только если machine contract воспроизводит эту фразу
с теми же identity, lifetime и границами полномочий.

Нормативные слова:

- **MUST / ОБЯЗАН** — нарушение блокирует приёмку.
- **MUST NOT / НЕ ИМЕЕТ ПРАВА** — нарушение является архитектурным дефектом.
- **MAY / МОЖЕТ** — допустимая вариативность реализации.

Каждое изменение доменной модели ОБЯЗАНО либо сослаться на существующий
`REG-*`/`PROC-*`/`E2E-*` критерий, либо сначала изменить этот реестр.

## 2. Реестр человеческих производственных процессов

Эти названия используются в разговорах, задачах, тестовых сценариях и
архитектурных решениях. Машинная последовательность может быть реализована
разными классами, но её доменный результат фиксирован.

| ID | Процесс для человека | Машинный процесс | Завершающий факт |
|---|---|---|---|
| `PROC-01` | **Открыть производственный заказ** | `StartProcessRun` с закреплёнными module/package refs и исходным input | создан один `ProcessRun` с неизменной identity |
| `PROC-02` | **Открыть рабочее место** | материализовать Production Cell instance и `WorkplaceRef` | Workplace=`todo/idle`, карточка восстанавливается из события |
| `PROC-03` | **Допустить работу на конвейер** | проверить зависимости/accepted bindings и выполнить admission | Workplace=`in_progress/queued`, `nextRole=author` |
| `PROC-04` | **Нанять рабочего на одну смену** | `ReserveEligibleWorkplace` → `ExecutionReservation` → launch | один fenced `WorkerExecution` получил точный контекст |
| `PROC-05` | **Отработать смену и уволиться** | get/read/submit/complete; процесс рабочего завершается | запечатан CandidateSet либо попытка явно потеряна/отменена |
| `PROC-06` | **Передать партию в ОТК** | `running → verifying`, создать idempotent `GateRun` | ОТК закрепил точный subject CandidateSet |
| `PROC-07` | **Провести контроль качества** | выполнить CheckPlan, записать CheckReceipts и GateDecision | один закрытый verdict с точными evidence refs |
| `PROC-08` | **Отправить изделие в ремонт** | `repair_required`, создать RecoveryIssue/RecoveryCase | то же Workplace=`repair_wait`, указан `repairTargetRole` |
| `PROC-09` | **Нанять нового ремонтного рабочего** | новая reservation/execution на том же Workplace | старый fence недействителен; прежний брак доступен как input |
| `PROC-10` | **Передать изделие независимому контролёру** | author gate accepted → reviewer reservation | та же карточка=`review[/review_in_progress]`, reviewer pinned к author set |
| `PROC-11` | **Принять изделие ОТК** | final GateDecision accepted + output bindings | текущая карточка=`done`, Workplace=`terminal(accepted)` |
| `PROC-12` | **Передать заказ в следующий цех** | ProcessRun применяет final typed outcome и двигает Flow | создано следующее Workplace/множество Workplace с новыми карточками |
| `PROC-13` | **Остановить линию и вызвать человека** | `human_required` → durable HumanInteractionRun | Workplace=`blocked/paused`, сохранена точка resume |
| `PROC-14` | **Выполнить отгрузку или внешнюю операцию** | authorize → execute → observe EffectAttempt | durable receipt; один effective external effect |
| `PROC-15` | **Обойти завод и найти пропавших рабочих** | supervision/reaper reconciliation | lost/expired execution fenced; Kanban не откатан в `todo` |
| `PROC-16` | **Перезапустить завод после остановки** | resume из cursor, reservations, evidence и outbox | продолжен тот же ProcessRun без дубликатов |
| `PROC-17` | **Закрыть производственный заказ** | применить terminal Flow outcome | ProcessRun terminal и больше не возвращается в running |

Ключевая человеческая формула рабочей смены:

> Рабочий нанимается на одну конкретную работу и одну роль, приходит на уже
> подготовленный рабочий стол, оставляет продукцию, сообщает об окончании смены
> и увольняется. Он не выбирает следующую работу, не принимает собственное
> изделие и не возвращается под той же execution identity.

## 3. Классификация понятий

Не всё в аналогии является entity в тактическом смысле DDD.

| Класс понятия | Понятия |
|---|---|
| **System / bounded-context composition** | завод/конвейер, ОТК |
| **Aggregate / entity** | ProcessRun, Workplace, WorkerExecution, ExecutionReservation, GateRun, RecoveryCase, HumanInteractionRun, EffectAttempt |
| **Definition / policy** | ProcessModule/цех, ProductionCellDefinition, CheckPlan, execution profile/специальность |
| **Immutable value / evidence** | ProductEnvelope, ProductRef, CandidateSet, CheckReceipt, GateDecision, RecoveryIssue, EffectReceipt |
| **Projection / read model** | WorkItem/карточка, dashboard queue view |
| **Domain/application service** | dispatcher, cell coordinator, recovery policy, decision policy |
| **Infrastructure mechanism** | work desk adapter, model launcher, supervisor, reaper, process probe, provider implementation |

Эта классификация является частью критерия приёмки. Например, карточка не
может стать write aggregate только потому, что физически хранится в таблице, а
CheckProvider не может получить право двигать Flow только потому, что он
возвращает результат проверки.

### 3.1. Индекс реестра

| Registry ID | Термин для человека | Машинный контракт | Класс понятия |
|---|---|---|---|
| `REG-01` | завод / конвейер | Saga Runtime composition | system |
| `REG-02` | производственный заказ | `ProcessRun` | aggregate |
| `REG-03` | цех | `ProcessModule` | versioned definition/package |
| `REG-04` | производственная ячейка | `ProductionCellDefinition` | Flow definition |
| `REG-05` | рабочее место | `Workplace` / `WorkplaceRef` | aggregate |
| `REG-06` | карточка | `WorkItem` | projection/read model |
| `REG-07` | рабочий стол | workspace + product desk view | durable resource |
| `REG-08` | рабочий / смена | `WorkerExecution` | one-shot entity |
| `REG-09` | наряд и пропуск | `ExecutionReservation` + fence | authority entity/value |
| `REG-10` | диспетчер и очередь | reservation service + eligibility view | application service/projection |
| `REG-11` | изделие | `ProductEnvelope` / `ProductRef` | immutable value/evidence |
| `REG-12` | партия на проверку | `CandidateSet` | sealed evidence |
| `REG-13` | отдел качества / ОТК | quality coordinator + evidence boundary | subsystem |
| `REG-14` | план контроля | `CheckPlan` | versioned definition |
| `REG-15` | инженер ОТК | `GateRun` | one-shot entity |
| `REG-16` | проверочный стенд | `CheckProvider` behind `CheckRunnerPort` | capability plugin |
| `REG-17` | протокол проверки | `CheckReceipt` | immutable evidence |
| `REG-18` | акт ОТК | `GateDecision` | immutable domain decision |
| `REG-19` | брак-лист | `RecoveryIssue` | immutable evidence/instruction |
| `REG-20` | ремонтный случай | `RecoveryCase` | aggregate/entity |
| `REG-21` | мастер, вахтёр, табель | supervision/reaper/observations | infrastructure mechanism |
| `REG-22` | вызов человека | `HumanInteractionRun` | durable interaction entity |
| `REG-23` | отгрузка / внешняя операция | `EffectAttempt` / `EffectReceipt` | effect entity/evidence |
| `REG-24` | производственный журнал | events/receipts/provenance/outbox | audit substrate |
| `REG-25` | специальность / скилл | execution profile / skill resource | versioned definition |
| `REG-26` | оснастка / инструменты | `ModuleInstallation` + capability authority | aggregate/infrastructure |
| `REG-27` | обычная технологическая операция | control `FlowNode` / `NodeRun` | definition/audit |
| `REG-28` | два канала состояния | `kanbanPhase` + `loopState` | aggregate state/value machine |
| `REG-29` | контрольная точка | lifecycle/tool hooks | policy enforcement mechanism |

## 4. Реестр доменных контрактов и критериев приёмки

### `REG-01` Завод / конвейер — Saga Runtime

- **Тип:** system composition; не одна god-object сущность.
- **Кодовая база:** Conveyor Runtime, Execution Control, Work Projection,
  Production/Evidence, Module Contracts, Module Catalog, Lifecycle Composition.
- **Человеческое поведение:** завод принимает производственный заказ, открывает
  рабочие места, нанимает рабочих, вызывает ОТК и передаёт принятый продукт
  дальше.
- **Зона ответственности:** orchestration, единый concurrency budget,
  reservations, transitions, restart/recovery и композиция портов.
- **Почему аналогия верна:** только завод видит весь поток; отдельный цех или
  рабочий не должен управлять всей инфраструктурой.

Критерии приёмки:

- `REG-01-AC-01`: существует один авторитетный путь выбора queued Workplace и
  один глобальный worker concurrency budget.
- `REG-01-AC-02`: только инфраструктура создаёт, запускает, отменяет и заменяет
  WorkerExecution.
- `REG-01-AC-03`: restart сохраняет ProcessRun, Workplace, desks, products,
  decisions и active recovery state.
- `REG-01-AC-04`: runtime core не ветвится по module name, task kind или skill.
- `REG-01-AC-05`: ни один компонент одновременно не выбирает работу, запускает
  процесс, пишет произвольный SQL, меняет desk и выносит domain verdict.

### `REG-02` Производственный заказ — `ProcessRun`

- **Тип:** aggregate root.
- **Identity:** неизменный `processRunId`.
- **Lifetime:** от `PROC-01` до одного terminal outcome; restart продолжает ту
  же identity.
- **Состояние:** исходный input, pinned module/install refs, Flow cursor,
  активный sealed cell-instance set, Workplace refs, outcome.
- **Зона ответственности:** допустимые переходы между Flow nodes и фиксация
  завершения заказа.
- **НЕ ИМЕЕТ ПРАВА:** нанимать процессы напрямую, хранить mutable product body,
  зависеть от строки board projection.

Критерии приёмки:

- `REG-02-AC-01`: повторный Start с тем же idempotency key не создаёт второй run.
- `REG-02-AC-02`: original input и pinned installation identity аудируемы и не
  переписываются repair-попыткой.
- `REG-02-AC-03`: resume использует exact persisted cursor/input bindings, а не
  эвристику «последний завершённый узел».
- `REG-02-AC-04`: terminal ProcessRun не возвращается в running.
- `REG-02-AC-05`: Flow покидает Production Cell только по её final typed outcome.

### `REG-03` Цех — `ProcessModule`

- **Тип:** versioned definition/package, не runtime aggregate.
- **Identity:** `moduleRef = name@version` плюс installation/package digest.
- **Lifetime:** версия цеха неизменна; новый вариант устанавливается как новая
  version/installation identity.
- **Человеческое поведение:** цех знает специальность работы и критерии качества,
  но не нанимает рабочих и не управляет заводом.
- **Кодовая база:** manifest, Flow, Production Cell/control-node definitions,
  schemas/contracts, skills/resources, CheckPlans и declarative policies.
- **Зона ответственности:** определить **что** производить и проверять.
- **НЕ ИМЕЕТ ПРАВА:** определять **как** запускать процессы, создавать private
  dispatch loop, собственный submit/read engine, status machine или product
  table.
- **Почему это цех:** разные цеха имеют разную специальность, но используют один
  заводской механизм найма, рабочего стола, ОТК и ремонта.

Критерии приёмки:

- `REG-03-AC-01`: модуль тестируется с fake/in-memory ports без SQLite, MCP,
  filesystem и реальной LM.
- `REG-03-AC-02`: module domain/application не импортирует другой module
  implementation, concrete repository, global DB, model driver или dispatcher.
- `REG-03-AC-03`: модуль выбирает закрытые platform capability presets и
  installed provider IDs, но не внедряет raw tool handlers.
- `REG-03-AC-04`: пятый обычный текстовый цех устанавливается без изменения
  core executor, dispatcher, table, submit tool и enum статусов.
- `REG-03-AC-05`: все смысловые различия цеха находятся в contracts, skills,
  CheckPlan и policies, а не в `if (moduleName === ...)` runtime-коде.

### `REG-04` Производственная ячейка — `ProductionCellDefinition`

- **Тип:** first-class `FlowNode kind=production-cell` definition.
- **Identity:** `productionCellId` внутри versioned module.
- **Lifetime:** definition живёт с module version; materialized instances живут
  как Workplace.
- **Человеческое поведение:** это типовое место производства с автором, ОТК,
  optional reviewer и repair policy.
- **Состав:** input selectors, materialization/workKey rule, product contracts,
  author profile, author/final gates, optional review, recovery и transitions.
- **НЕ ЯВЛЯЕТСЯ:** скрытым графом из producer/resolver/recovery Flow nodes.

Критерии приёмки:

- `REG-04-AC-01`: Flow cursor остаётся на ячейке через author/review/repair и
  покидает её только после final outcome.
- `REG-04-AC-02`: WorkerExecution, CheckRun и GateRun являются внутренними runs,
  а не неявными Flow nodes.
- `REG-04-AC-03`: singleton использует стабильный `workKey=default`; fan-out
  выводит workKey из accepted binding и stable item id, не из array index.
- `REG-04-AC-04`: sealed fan-out instance set нельзя изменить строками доски.
- `REG-04-AC-05`: completion policy явно определяет, когда множество Workplace
  завершает Flow node.

### `REG-05` Рабочее место — `Workplace`

- **Тип:** aggregate root целевого write model.
- **Identity:** полный `WorkplaceRef(processRunId,moduleRef,productionCellId,workKey)`.
- **Lifetime:** от materialization до terminal состояния одной cell instance;
  переживает всех рабочих, reviewer и repair attempts.
- **Состояние:** authoritative `kanbanPhase`, `loopState`, `nextRole`, revision,
  active reservation/gate/recovery refs, desk/evidence refs.
- **Человеческое поведение:** карточка и стол остаются на месте; рабочие приходят
  и уходят.
- **Зона ответственности:** continuity производства и допустимые paired-state
  transitions.

Критерии приёмки:

- `REG-05-AC-01`: worker id, attempt, package drift и recovery number не входят
  в WorkplaceRef.
- `REG-05-AC-02`: одновременно revision может принадлежать только одному
  mutation actor: WorkerExecution или GateRun.
- `REG-05-AC-03`: crash/expiry/repair не меняет `in_progress` на `todo` и не
  создаёт новое Workplace.
- `REG-05-AC-04`: author → reviewer меняет role/channel state, но сохраняет
  WorkplaceRef, WorkItem identity, desk и product history.
- `REG-05-AC-05`: final accepted делает **текущий** Workplace `terminal` и
  текущую карточку `done`; следующий цех получает новое Workplace.
- `REG-05-AC-06`: state transition использует expected revision CAS и
  идемпотентен при replay.

### `REG-06` Карточка — `WorkItem`

- **Тип:** rebuildable projection/read model, не orchestration aggregate.
- **Identity:** детерминированно выводится из WorkplaceRef.
- **Lifetime:** логически совпадает с cell instance; физическая строка может
  быть удалена и восстановлена.
- **Человеческое поведение:** показывает, где работа находится на Канбане и что
  внутри делает агентный луп.
- **Зона ответственности:** отображение `kanbanPhase`, `loopState`, role,
  attempts и human-readable work description.
- **НЕ ИМЕЕТ ПРАВА:** запускать worker, быть авторитетом loop state или создавать
  factory work при сканировании таблицы.

Критерии приёмки:

- `REG-06-AC-01`: полное удаление projection и rebuild воспроизводят оба
  статусных канала без изменения производства.
- `REG-06-AC-02`: human command адресует Workplace use case и domain event, а не
  произвольный UPDATE строки карточки.
- `REG-06-AC-03`: отсутствие/задержка board projection не блокирует dispatch.
- `REG-06-AC-04`: recovery не создаёт дубликат карточки.

### `REG-07` Рабочий стол — workspace + product desk view

- **Тип:** durable resource, реализуемый через ports/adapters; не aggregate.
- **Identity:** полный WorkplaceRef.
- **Lifetime:** весь lifetime Workplace и retention period после terminal.
- **Содержимое:** drafts, materialized exact inputs, recovery feedback,
  platform tooling и view immutable products/evidence.
- **Человеческое поведение:** новый рабочий видит то, что оставил предыдущий.
- **НЕ ПЕРЕНОСИТСЯ:** рабочий не уносит стол с собой и не получает новый стол
  только из-за новой попытки.

Критерии приёмки:

- `REG-07-AC-01`: path выводится из полного WorkplaceRef, а не execution/attempt.
- `REG-07-AC-02`: adapter проверяет path normalization и containment.
- `REG-07-AC-03`: replacement worker видит prior drafts, rejected CandidateSet
  и exact RecoveryIssue.
- `REG-07-AC-04`: worker completion не удаляет desk; cleanup требует retention
  policy и аудируемого события.
- `REG-07-AC-05`: один logical ProductRepository может использовать generic
  envelope/blob storage, но не workshop-specific desk.

### `REG-08` Рабочий / смена — `WorkerExecution`

- **Тип:** one-shot entity/attempt.
- **Identity:** unique `executionRef` + fence; не переиспользуется.
- **Lifetime:** committed reservation → launch/running → ровно одно terminal
  состояние (`completed|lost|expired|failed|cancelled|superseded`).
- **Человеческое поведение:** рабочий делает одну назначенную работу и после
  `execution_complete` увольняется.
- **Инструменты протокола:** `workplace_get`, `product_read`, `product_submit`,
  `execution_complete` плюс centrally authorized capability preset.
- **НЕ ИМЕЕТ ПРАВА:** выбирать очередь, нанимать workers, менять Канбан, принимать
  изделие, выполнять незаявленный внешний effect или работать за другую role.

Критерии приёмки:

- `REG-08-AC-01`: launch context закрепляет Workplace, role, exact read set,
  execution и fence до старта процесса.
- `REG-08-AC-02`: `product_read` ограничен pinned read set и журналируется.
- `REG-08-AC-03`: submit/seal атомарно проверяют live fence; stale execution не
  может писать или завершаться.
- `REG-08-AC-04`: `execution_complete` только seals CandidateSet и не означает
  acceptance/Канбан transition.
- `REG-08-AC-05`: summary не является gate input; значимый output обязан стать
  ProductEnvelope.
- `REG-08-AC-06`: recovery всегда создаёт новый WorkerExecution.

### `REG-09` Наряд и пропуск — `ExecutionReservation` + fence

- **Тип:** entity/value authority boundary.
- **Identity:** deterministic reservation/idempotency key; unique fence.
- **Lifetime:** `queued → leased`, затем consumed/expired/cancelled ровно один раз.
- **Человеческое поведение:** завод заранее выписывает наряд и пропуск на одно
  рабочее место; рабочий не выбирает место сам.
- **Transaction owner:** Conveyor Runtime атомарно меняет Workplace revision и
  создаёт reservation; Execution Control потребляет её идемпотентно.

Критерии приёмки:

- `REG-09-AC-01`: два dispatchers в гонке создают одну effective reservation.
- `REG-09-AC-02`: процесс не запускается до durable commit reservation.
- `REG-09-AC-03`: launch retry по той же reservation не создаёт второго live
  execution.
- `REG-09-AC-04`: revoked/expired fence не может очистить или заменить более
  новый fence.

### `REG-10` Диспетчер и очередь

- **Тип:** application service + derived eligibility view; очередь не aggregate.
- **Кодовая база:** `ReserveEligibleWorkplace`, priority/concurrency policies.
- **Человеческое поведение:** диспетчер видит готовые рабочие места, сначала
  закрывает накопившуюся проверку, затем нанимает авторов.
- **Зона ответственности:** fairness/priority, global concurrency и atomic
  reservation; не semantic quality.

Критерии приёмки:

- `REG-10-AC-01`: queue состоит из Workplace с `loopState=queued`, а не из
  произвольных legacy task rows.
- `REG-10-AC-02`: reviewer role имеет приоритет перед author при равной/более
  высокой policy priority.
- `REG-10-AC-03`: unmet Flow/input dependencies исключают Workplace из queue.
- `REG-10-AC-04`: worker не имеет `worker_next`/queue-listing capability.
- `REG-10-AC-05`: все launch paths учитываются одним concurrency budget.

### `REG-11` Изделие — `ProductEnvelope` / `ProductRef`

- **Тип:** immutable value/evidence.
- **Identity:** exact ProductRef (`id + schemaRef + digest`).
- **Lifetime:** append-only; новый content создаёт новый ref.
- **Содержимое:** canonical text/JSON, TextSetManifestRef или immutable blob ref,
  lineage и tagged producer authority/scope.
- **Человеческое поведение:** изделие оставлено на столе и может быть точно
  передано ОТК или следующему цеху.

Критерии приёмки:

- `REG-11-AC-01`: repository canonicalizes/hashes internally и не доверяет
  caller-supplied digest.
- `REG-11-AC-02`: schema, digest, producer authority, fence-at-submit и lineage
  проверяются на trust boundary.
- `REG-11-AC-03`: consumer читает exact ref/accepted binding, не «latest worker».
- `REG-11-AC-04`: kernel/human/effect evidence использует реальный tagged
  producer, а не выдуманный WorkerExecution.
- `REG-11-AC-05`: TextSet сохраняет paths, modes, rename/delete operations и
  canonical manifest digest.

### `REG-12` Партия на проверку — `CandidateSet`

- **Тип:** sealed immutable evidence.
- **Identity:** `candidateSetRef`; deterministic seal key
  `(workplaceRef,producerExecutionRef,role)`.
- **Lifetime:** создаётся один раз на attempt и никогда не изменяется.
- **Содержимое:** produced members, явно разрешённые carried-forward members,
  optional reviewer subject set и authority seal receipt.
- **Человеческое поведение:** рабочий сдаёт ОТК конкретную партию, а не всё
  меняющееся содержимое стола.

Критерии приёмки:

- `REG-12-AC-01`: replay с тем же payload возвращает тот же ref; mismatch
  отклоняется.
- `REG-12-AC-02`: produced member принадлежит текущему execution.
- `REG-12-AC-03`: carried-forward member содержит разрешённый
  `sourceCandidateSetRef`; upstream input нельзя выдать за новый output.
- `REG-12-AC-04`: reviewer CandidateSet обязан ссылаться на exact author subject.
- `REG-12-AC-05`: repair attempt получает старый set как input, но seals новый set.

### `REG-13` Отдел качества / ОТК

- **Тип:** factory-owned domain/application subsystem, не цех и не worker.
- **Кодовая база:** cell quality coordinator, GateRun, CheckRunnerPort,
  QualityEvidenceRepositoryPort, decision application/outbox.
- **Человеческое поведение:** ОТК принимает точную партию, проводит заявленные
  проверки, оформляет акт и либо принимает, либо выписывает брак-лист.
- **Разделение ответственности:** цех определяет смысл качества через contracts
  и CheckPlan; ОТК одинаково исполняет механизм для всех цехов.
- **НЕ ИМЕЕТ ПРАВА:** переписывать продукт, скрыто нанимать LM через CheckProvider
  или придумывать module-specific lifecycle.

Критерии приёмки:

- `REG-13-AC-01`: ОТК core не импортирует Discovery/Formalization/Development/
  Delivery и не ветвится по их именам.
- `REG-13-AC-02`: GateRun всегда получает exact Workplace, gate phase, subject,
  assessment sets, CheckPlan и expected revision.
- `REG-13-AC-03`: worker и GateRun не владеют mutation authority одновременно.
- `REG-13-AC-04`: ОТК принимает решение только из versioned receipts/policy и
  пишет immutable evidence.
- `REG-13-AC-05`: один conformance harness применим ко всем LM-producing цехам.

### `REG-14` План контроля — `CheckPlan`

- **Тип:** immutable versioned definition/policy input.
- **Identity:** CheckPlan ref + digest, закреплённые installation identity.
- **Содержимое:** ordered registered check refs, pinned parameters/environment,
  decision policy ref и fail-closed rules.
- **Человеческое поведение:** цех заранее сообщает ОТК, чем и по каким правилам
  проверять изделие.

Критерии приёмки:

- `REG-14-AC-01`: план не содержит candidate-supplied arbitrary shell.
- `REG-14-AC-02`: schema/lint/build/test выполняются registered sandboxed
  providers над immutable snapshot.
- `REG-14-AC-03`: `unknown|error` не превращаются в accepted без явной безопасной
  policy, причём default fail-closed остаётся non-accepting.
- `REG-14-AC-04`: LM review является reviewer WorkerExecution, human approval —
  HumanInteractionRun; CheckProvider не скрывает ни то, ни другое.

### `REG-15` Инженер ОТК — `GateRun`

- **Тип:** one-shot authorized inspection entity.
- **Identity:** idempotent key по Workplace revision, gate phase, exact subject/
  assessment sets и plan digest.
- **Lifetime:** claim в `verifying` → receipts/decision → terminal.
- **Человеческое поведение:** инженер проверяет одну закреплённую партию, пишет
  акт и уходит; он не исправляет изделие.

Критерии приёмки:

- `REG-15-AC-01`: GateRun имеет собственные lease/authority; live worker fence к
  моменту проверки не требуется.
- `REG-15-AC-02`: GateRun проверяет immutable submit/seal receipts, доказывающие
  authority рабочего в момент записи.
- `REG-15-AC-03`: gate читает CandidateSet snapshot, не mutable latest desk.
- `REG-15-AC-04`: retry GateRun идемпотентен; stale decision не меняет newer
  Workplace revision.

### `REG-16` Проверочный стенд — `CheckProvider`

- **Тип:** infrastructure/capability plugin behind `CheckRunnerPort`.
- **Identity:** provider id + version + digest.
- **Человеческое поведение:** стенд выполняет один тип измерения и выдаёт
  протокол; он не решает судьбу карточки.
- **Граница:** checks read-only относительно authoritative/external state либо
  полностью sandbox-contained.

Критерии приёмки:

- `REG-16-AC-01`: provider получает exact immutable inputs и pinned parameters.
- `REG-16-AC-02`: provider не меняет Workplace/Flow и не пишет GateDecision.
- `REG-16-AC-03`: provider не запускает скрытый worker/human interaction.
- `REG-16-AC-04`: новый provider устанавливается как отдельно versioned и
  security-reviewed capability plugin, не как private engine цеха.

### `REG-17` Протокол проверки — `CheckReceipt`

- **Тип:** immutable evidence.
- **Identity:** receipt ref/digest; produced by exact CheckRun authority.
- **Содержимое:** subject/assessment refs, check/provider ref+version+digest,
  environment, closed outcome, evidence refs.
- **Человеческое поведение:** воспроизводимый документ о том, что именно и чем
  измеряли; не итоговый акт приёмки.

Критерии приёмки:

- `REG-17-AC-01`: receipt невозможно перепривязать к другой партии.
- `REG-17-AC-02`: изменение provider/version/environment создаёт новый receipt.
- `REG-17-AC-03`: GateDecision перечисляет exact receipt refs.
- `REG-17-AC-04`: replay/audit решения возможен без повторного запуска
  nondeterministic проверки.

### `REG-18` Акт ОТК — `GateDecision`

- **Тип:** append-only immutable domain decision/evidence.
- **Identity:** deterministic `decisionKey` + decision digest.
- **Содержимое:** gate run/phase, exact subject/assessment, CheckPlan/policy
  digests, receipts, installation, verdict, repair target и output bindings.
- **Verdict:** `accepted | repair_required | human_required | failed`.
- **Человеческое поведение:** только акт ОТК разрешает выпустить изделие,
  отправить его в ремонт или остановить линию.

Критерии приёмки:

- `REG-18-AC-01`: worker completion/CheckReceipt сами по себе не двигают Канбан.
- `REG-18-AC-02`: author-gate accepted оставляет downstream bindings пустыми и
  только pins exact subject для reviewer.
- `REG-18-AC-03`: только final accepted может создать named downstream binding
  на exact ProductRefs и завершить cell.
- `REG-18-AC-04`: `repair_required` обязательно содержит
  `repairTargetRole=author|reviewer`.
- `REG-18-AC-05`: decision persistence и Workplace transition сходятся через
  idempotent outbox; crash между ними не теряет решение и не дублирует переход.
- `REG-18-AC-06`: stale/superseded decision остаётся audit evidence, но не
  применим к новой Workplace revision.

### `REG-19` Брак-лист — `RecoveryIssue`

- **Тип:** immutable evidence/instruction.
- **Identity:** recoveryIssueRef + digest.
- **Содержимое:** rejected GateDecisionRef, subject CandidateSetRef, failing
  CheckReceiptRefs, repairTargetRole, findings и required acceptance.
- **Человеческое поведение:** ОТК возвращает на тот же стол точный перечень
  дефектов конкретной партии.

Критерии приёмки:

- `REG-19-AC-01`: issue невозможно применить к другой/более новой партии без
  явного нового решения.
- `REG-19-AC-02`: issue доступен replacement worker как exact desk input, а не
  только как regenerated prompt text.
- `REG-19-AC-03`: findings не дают права менять repairTargetRole, scope или
  allowed capabilities.

### `REG-20` Ремонтный случай — `RecoveryCase`

- **Тип:** aggregate/entity процесса ремонта.
- **Identity:** WorkplaceRef + gate phase/ref по declarative policy.
- **Lifetime:** первый repair_required → resolved/exhausted/paused.
- **Состояние:** issues, attempts, budget, resolution/exhaustion.
- **Человеческое поведение:** завод отслеживает один ремонт изделия через
  несколько новых рабочих, не выдавая каждую попытку за новое производство.

Критерии приёмки:

- `REG-20-AC-01`: один active case на Workplace+gate policy key.
- `REG-20-AC-02`: attempt budget детерминирован и переживает restart.
- `REG-20-AC-03`: accepted gate resolves case; exhaustion даёт explicit
  `failed|paused`, а не бесконечную очередь.
- `REG-20-AC-04`: RecoveryCase не владеет desk/card/product bodies, а хранит refs.

### `REG-21` Мастер, вахтёр и табель — supervision

- **Тип:** infrastructure mechanisms + durable execution observations.
- **Кодовая база:** supervisor, reaper, ProcessProbe, lease/heartbeat/progress.
- **Человеческое поведение:** мастер следит за своей сменой; вахтёр независимо
  обходит завод и находит пропавших рабочих; табель хранит доказательства.
- **Различие сигналов:** liveness означает authority lease, progress —
  наблюдаемую активность, лог — только observability.

Критерии приёмки:

- `REG-21-AC-01`: structured lease heartbeat не зависит от того, вспомнила ли LM
  вызвать инструмент.
- `REG-21-AC-02`: dead local process определяется по PID + birth token.
- `REG-21-AC-03`: alive-but-silent worker не переassignится до cancellation
  grace/deadline и verified termination.
- `REG-21-AC-04`: child-close/reaper race имеет одного effective winner.
- `REG-21-AC-05`: потеря worker/parent приводит к fenced recovery без Kanban
  rollback в `todo`.

### `REG-22` Вызов человека — `HumanInteractionRun`

- **Тип:** durable interaction entity.
- **Identity:** exact request/idempotency key + subject refs.
- **Lifetime:** requested → answered/expired/cancelled.
- **Человеческое поведение:** линия останавливается в известном месте и ждёт
  полномочного решения человека, не удерживая model process.

Критерии приёмки:

- `REG-22-AC-01`: `human_required` создаёт `blocked/paused` с durable resume target.
- `REG-22-AC-02`: ответ проверяет human authority и exact subject/revision.
- `REG-22-AC-03`: duplicate response даёт один effective decision.
- `REG-22-AC-04`: human interaction не скрывается внутри CheckProvider.

### `REG-23` Отгрузка / внешняя операция — `EffectAttempt` и `EffectReceipt`

- **Тип:** authorized effect entity + immutable receipt.
- **Identity:** desired-state digest + authorization digest + deterministic
  idempotency key; каждый physical attempt имеет отдельный ref.
- **Lifetime:** authorized → observing/executing → observed terminal result.
- **Человеческое поведение:** принятое изделие отгружается наружу по наряду;
  генерация текста сама по себе не является отгрузкой.
- **Граница:** commit/merge/tag/push/publish/deploy — effects; schema/lint/build/
  test в disposable sandbox — checks.

Критерии приёмки:

- `REG-23-AC-01`: effect не стартует до final accepted binding и требуемой
  durable authorization.
- `REG-23-AC-02`: effect executor получает exact desired-state ProductRef/digest.
- `REG-23-AC-03`: retry сначала наблюдает external state и использует тот же
  idempotency key.
- `REG-23-AC-04`: crash/retry создают append-only attempts, но один effective
  external change.
- `REG-23-AC-05`: worker не получает direct deploy/publish authority по факту
  того, что он сгенерировал desired-state text.

### `REG-24` Производственный журнал — events, receipts, provenance, outbox

- **Тип:** append-only/tamper-evident audit substrate.
- **Identity:** event/receipt refs и idempotency keys.
- **Lifetime:** не короче retention требований ProcessRun/effects.
- **Человеческое поведение:** по журналу можно восстановить, кто, над чем, каким
  инструментом и на каком основании работал или принимал решение.

Критерии приёмки:

- `REG-24-AC-01`: каждый state-changing use case оставляет domain event/receipt.
- `REG-24-AC-02`: product reads, submits, seals, checks, decisions, human actions
  и effects имеют точную provenance.
- `REG-24-AC-03`: journal не подменяет aggregate state и не является queue.
- `REG-24-AC-04`: replay по idempotency key не создаёт второй effective факт.

### `REG-25` Специальность и скилл — execution profile / skill resource

- **Тип:** versioned definition/resource, не worker и не tool authority.
- **Identity:** profile/skill ref + installation digest.
- **Lifetime:** неизменен внутри module installation; новая семантика требует
  новой version/digest.
- **Человеческое поведение:** специальность объясняет рабочему, какую предметную
  работу выполнять; она не учит его нанимать других рабочих или управлять
  заводом.
- **Содержимое:** semantic instructions, declared input/output contracts,
  capability preset ref и optional reviewer role.

Критерии приёмки:

- `REG-25-AC-01`: skill не содержит queue selection, concurrency, process launch
  или direct lifecycle mutation instructions.
- `REG-25-AC-02`: profile ссылается на contracts/preset по versioned refs, а не
  перечисляет непроверенные raw tools.
- `REG-25-AC-03`: prompt/skill/profile/package digests записываются в execution
  receipt и real-model conformance evidence.
- `REG-25-AC-04`: author и reviewer являются разными roles/profiles даже при
  использовании одной модели.

### `REG-26` Оснастка и инструменты — `ModuleInstallation` / capability authority

- **Тип:** `ModuleInstallation` aggregate плюс infrastructure capabilities.
- **Identity:** manifest/resources/package digest и installation ref.
- **Lifetime:** installed → active/retired; произведённая работа живёт отдельно
  и не удаляется при retirement оснастки.
- **Человеческое поведение:** завод оснащает рабочее место проверенным набором
  инструкций, шаблонов и инструментов до прихода рабочего.
- **Граница:** module выбирает закрытый capability preset; infrastructure
  разрешает конкретные tools для exact execution/fence.

Критерии приёмки:

- `REG-26-AC-01`: installation bytes/resources имеют проверяемый digest и
  dependency lock.
- `REG-26-AC-02`: authority set закреплён за execution/fence и минимален для role.
- `REG-26-AC-03`: pre-tool authorization fail-closed отклоняет другой Workplace,
  read/write scope или expired fence.
- `REG-26-AC-04`: package drift аудируется; compatible resume продолжает прежние
  Workplace/products, incompatible resume завершается явной ошибкой.
- `REG-26-AC-05`: новый raw LM-facing tool требует отдельного security/
  architecture exception и не входит в стандартный contract цеха.

### `REG-27` Обычная технологическая операция — control `FlowNode` / `NodeRun`

- **Тип:** Flow definition + one execution audit record; не Production Cell.
- **Identity:** node id внутри pinned module + NodeRun attempt/idempotency key.
- **Lifetime:** один control transformation/human/effect/settlement step.
- **Человеческое поведение:** автоматическая операция линии выполняется без найма
  LM-рабочего, если она не производит LM-кандидат.
- **Граница:** control node может вернуть typed outcome/product/evidence через
  ports, но не получает фиктивные Card/Desk/Worker identities.

Критерии приёмки:

- `REG-27-AC-01`: author/reviewer/gate loops моделируются Production Cell, а не
  цепочкой скрытых control nodes.
- `REG-27-AC-02`: standalone control/effect node имеет exact declared inputs,
  idempotency/restart semantics и tagged real producer authority.
- `REG-27-AC-03`: NodeRun используется для audit control node; WorkerExecution и
  GateRun не маскируются под один универсальный NodeRun.
- `REG-27-AC-04`: effect control node соблюдает `REG-23`; human node — `REG-22`.

### `REG-28` Два канала состояния — `kanbanPhase` + `loopState`

- **Тип:** value/state machine внутри Workplace aggregate.
- **Identity:** принадлежит WorkplaceRef; не WorkerExecution и не WorkItem row.
- **Человеческое поведение:** Канбан отвечает «в каком этапе работа», машинный
  луп — «что сейчас делает завод внутри этапа».
- **Kanban:** `todo | in_progress | review | review_in_progress | blocked |
  done | failed | cancelled`.
- **Loop:** `idle | queued | leased | running | verifying | repair_wait | paused |
  terminal`; role хранится отдельно как `author|reviewer`.

Критерии приёмки:

- `REG-28-AC-01`: допустимы только закрытые пары фаз/loop states из Conveyor
  Mental Model; произвольная комбинация отклоняется.
- `REG-28-AC-02`: crash, lease expiry и technical repair меняют loop, но не
  откатывают Канбан в todo.
- `REG-28-AC-03`: author accepted с reviewer даёт `review/queued`; reviewer claim
  даёт `review_in_progress/leased|running`.
- `REG-28-AC-04`: reviewer-proven product defect — явный semantic backward
  transition в `in_progress/repair_wait`, а не технический retry.
- `REG-28-AC-05`: done/failed/cancelled совместимы только с соответствующим
  terminal reason; blocked — с paused и durable resume target.

### `REG-29` Контрольная точка — lifecycle/tool hooks

- **Тип:** infrastructure policy enforcement point, не domain decision maker.
- **Identity:** hook policy/version + command/execution/idempotency context.
- **Человеческое поведение:** контрольная точка проверяет пропуск, безопасность
  стола и полноту технического протокола, но не заменяет ОТК.
- **Граница:** hooks валидируют authority/shape и пишут receipts; semantic verdict
  принадлежит GateDecision/политике.

Критерии приёмки:

- `REG-29-AC-01`: pre-launch hook получает уже committed reservation и не может
  выбрать другое Workplace.
- `REG-29-AC-02`: pre-tool hook fail-closed проверяет exact execution/fence/scope.
- `REG-29-AC-03`: post-tool hook пишет provenance/receipt, но не меняет domain
  truth по результату вызова.
- `REG-29-AC-04`: completion hook проверяет authority и структуру CandidateSet,
  но не объявляет продукт accepted.
- `REG-29-AC-05`: retry hook идемпотентен, fail-open/fail-closed policy явна и
  покрыта тестом.

## 5. Сквозные критерии приёмки производственных процессов

Эти сценарии проверяют не отдельный класс, а согласованность нескольких
сущностей. Название теста SHOULD содержать соответствующий `E2E-*` ID.

### `E2E-01` Рабочий успешно отработал смену без reviewer

**Given:** Workplace=`in_progress/queued`, author gate является final.

**When:** диспетчер нанял worker; worker прочитал exact inputs, оставил product,
sealed CandidateSet, завершился; ОТК выполнил checks и принял изделие.

**Then:** WorkerExecution terminal; CandidateSet immutable; final GateDecision
accepted; текущая карточка done; Workplace terminal; downstream binding exact;
ProcessRun активировал следующий node.

### `E2E-02` Рабочий передал изделие reviewer

**Then:** author accepted не создаёт downstream output; та же карточка становится
review, то же Workplace queues reviewer; reviewer context pinned к exact author
CandidateSet; только final accepted завершает cell.

### `E2E-03` ОТК вернул изделие автору в ремонт

**Then:** rejected set и products остаются immutable; RecoveryIssue exact;
Workplace/card/desk те же; loop=`repair_wait`; новый author имеет новый
execution/fence и seals новый CandidateSet; Канбан не откатывается в todo.

### `E2E-04` ОТК забраковал работу reviewer

**Then:** invalid reviewer output сохраняет `review_in_progress`, target role
reviewer и нанимает нового reviewer; author product не объявлен дефектным.

### `E2E-05` Reviewer доказал дефект продукта

**Then:** valid reviewer evidence переводит ту же карточку
`review_in_progress → in_progress`, target role author; новый автор получает
точную отклонённую партию и findings.

### `E2E-06` Рабочий пропал во время смены

**Then:** supervisor/reaper terminalizes execution и fence; Workplace enters
repair через idempotent lifecycle event; desk/products сохраняются; stale worker
не может писать; Канбан stage не меняется технической аварией.

### `E2E-07` Завод перезапустился на каждой durable границе

Проверяются crash points после reservation, launch, submit, seal, CheckReceipt,
GateDecision, output binding и перед Workplace transition. Каждый restart
сходится без duplicate worker, CandidateSet, decision, projection или effect.

### `E2E-08` GateRun и worker одновременно претендуют на место

**Then:** expected Workplace revision/authority CAS даёт одного winner; loser не
может мутировать; stale decision или fence остаются только audit evidence.

### `E2E-09` Task graph создал много рабочих мест

**Then:** accepted source binding seals instance set; каждый stable item даёт
один deterministic workKey/Workplace/WorkItem; reorder/replay не создаёт
дубликаты; join policy явно завершает Production Cell.

### `E2E-10` Доска полностью перестроена

**Then:** оба status channel, role и attempt summary восстановлены из durable
events; dispatch и active executions не изменились; human command до/после
rebuild имеет один effective domain result.

### `E2E-11` Человек остановил и продолжил линию

**Then:** HumanInteractionRun exact и durable; no model process удерживается;
authorized response возобновляет сохранённую transition target; duplicate/
stale response не действует.

### `E2E-12` Внешняя операция пережила неизвестный результат

**Then:** retry использует тот же desired-state/auth digest/idempotency key,
сначала observes provider state и не повторяет уже effective change.

### `E2E-13` Подключён пятый текстовый цех

**Then:** новый module предоставляет только declarations/contracts/skills/
policies/provider refs; не добавляет table, submit tool, executor, dispatch loop
или status; проходит тот же deterministic lifecycle conformance.

### `E2E-14` Реальная LM прошла производственный цикл

Тот же coordinator, stores и protocol tools выполняют happy, repair и reviewer
scenarios с real LM и real sandboxed checks. Fault branches инжектируются
детерминированно. Green означает bounded eventual completion и выполнение
инвариантов, а не совпадение текста или правдоподобный final answer.

## 6. Правила приёмки кода и архитектурного ревью

Изменение принимается только если выполнены все применимые правила:

1. В PR/плане указаны затронутые `REG-*`, `PROC-*` и `E2E-*` IDs.
2. Для новой доменной сущности сначала добавлены human term, classification,
   identity, lifetime, owner, prohibited behavior и acceptance criteria.
3. Если имя класса отличается от глоссария, mapping явно указан в module/API
   documentation; поведение остаётся узнаваемым без чтения реализации.
4. Одно человеческое слово не используется для двух разных identities или
   lifetimes. Например, WorkerExecution не называется Workplace, а WorkItem не
   называется authoritative task aggregate.
5. Domain/application code зависит внутрь через ports; concrete storage, MCP,
   filesystem, process и provider детали находятся в adapters/composition.
6. Happy-path unit test недостаточен: проверяются stale authority, duplicate,
   crash/restart и race там, где сущность владеет transition.
7. State transition принят только при наличии source state, command/event,
   authority, idempotency/CAS rule и terminal/retry semantics.
8. Любая новая module-specific таблица, submit tool, worker launcher, status или
   recovery loop требует доказательства, почему существующий universal contract
   физически неприменим. Для обычного text product такое доказательство считается
   отсутствующим.
9. Board projection, logs и provider observations не становятся domain truth из
   удобства чтения.
10. Архитектурные тесты запрещают legacy task-board reads/writes/foreign keys в
    core после cutover и module-name/task-kind switches в runtime.

## 7. Definition of Accepted

Сущность или процесс считается принятым только когда одновременно доказано:

- **Language:** человеческий термин и машинный mapping однозначны.
- **Identity:** ключ стабилен на всём заявленном lifetime.
- **Authority:** только названный owner меняет состояние; stale actor fenced.
- **Behavior:** happy, repair/failure, terminal и retry transitions закрыты.
- **Boundaries:** запрещённые ответственности не просочились в сущность.
- **Evidence:** решение можно проверить по exact immutable refs/receipts.
- **Recovery:** crash/restart продолжает тот же domain object без дубликатов.
- **Projection:** read models можно перестроить без изменения domain truth.
- **Conformance:** применимые `REG-*` и хотя бы один сквозной `E2E-*` сценарий
  исполняются тестом.

Класс с правильным названием, но неверным lifetime/authority/поведением не
принимается. Класс с другим техническим названием может быть принят, если его
mapping документирован и все доменные критерии доказаны.
