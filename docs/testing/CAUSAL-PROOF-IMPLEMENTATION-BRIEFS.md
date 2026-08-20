# Causal Proof Implementation Briefs

Статус: архитектура зафиксирована ADR-084. Этот файл — последовательность
копируемых implementation briefs для агента уровня 4–5/7. Исполнитель не
принимает новых архитектурных решений: при обнаружении противоречия он
останавливает конкретный brief и возвращает evidence архитектору.

## Общий контракт для всех брифов

Обязательные входы:

- `docs/testing/GRAPH-TEST-STRATEGY.md`;
- `docs/architecture/decisions/084-causal-conformance-proof-kernel.md`;
- `docs/architecture/CONVEYOR-MENTAL-MODEL.md` §23;
- `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md`;
- `src/factory-e2e/fresh-harness.ts`.

Непереговорные ограничения:

1. Не создавать четвёртый runtime, reducer, scheduler или recovery router.
2. Canonical driver — `src/factory-e2e/fresh-harness.ts`, вызывающий настоящий
   `createFactoryApplication → runEpisode → distributeQueuedTasks`.
3. Scripted actor заменяет только inference. SQLite repositories, WorkIntent,
   MCP, ProductRef, CandidateSet, Gate, effects, routing и postconditions —
   production implementations.
4. Никаких прямых test-записей в authority tables для изготовления результата.
   Допустим bootstrap через опубликованный production API; fault injector может
   оборвать границу, но не дорисовать итоговое состояние.
5. Нормативные ожидания нельзя генерировать из production declarations.
6. Scripted actor не видит scenario id, attempt number, скрытую БД или ожидаемый
   outcome. Он видит только то, что видит production worker.
7. Терминальная история не откатывается. Recovery создаёт append-only ревизию,
   continuation или typed terminal/wait.
8. Не менять persisted production schema и не вводить универсальный RecoveryPlan
   в этих брифах. Это отдельное архитектурное решение уровня 7/7.
9. Не ослаблять Gate, timeout, budget, quarantine или acceptance assertions ради
   зелёного теста.
10. Все factory workers/agent tooling используют opencode shim; прямой Claude
    CLI запрещён репозиторием.

Каждый brief завершается отдельным коммитом и отчётом:

- изменённые production/test seams;
- что является oracle;
- какие authority rows появились естественно;
- выполненные команды и точный результат;
- остающиеся неизвестные, без объявления их закрытыми.

---

## Brief W0-1 — Одна canonical proof composition

### Цель

Устранить три конкурирующие test-composition surfaces. Все новые causal proofs
должны использовать один адаптер над `src/factory-e2e/fresh-harness.ts`.

### Исходная проблема

- `tests/factory-contract/scenario-composition.mjs`;
- `tests/factory-temporal/lib/temporal-composition.mjs`;
- `tests/factory-e2e/harness-composition.mjs`.

Temporal allowlist проверяется на игрушечных объектах, но не на реально
собранной композиции. W9 объявлен заменой temporal suite, но не включён в
blocking acceptance matrix.

### Сделать

1. Выделить один `tests/factory-proof/canonical-proof-composition.mjs`, который
   вызывает production fresh harness и подставляет только:
   - `workerExecutorFactory`;
   - `resolveWorkerContext`;
   - явно типизированные внешние provider seams, без которых нельзя доказать
     Delivery в изолированной среде.
2. Не передавать Reference-политики как «override», если production root уже
   устанавливает те же политики. Если explicit binding неизбежен, добавить
   assertion идентичности класса/version/digest с production default.
3. Реальный composition fingerprint строить из фактически переданного override
   объекта и установленных module/package/check identities.
4. Allowlist assertion вызывать на настоящей композиции каждого proof-run, не
   на synthetic `safe` fixture.
5. Новые proof tests направить только через этот файл. Старые surfaces пока
   можно оставить как migration debt, но запретить их новые импорты ratchet-ом.
6. Написать migration map: какой старый suite на какой scenario pack переезжает.

### Запреты

- Не копировать `driveFreshHarness`.
- Не создавать test-only transition handlers.
- Не подменять GateDecision reducer, settlement, CandidateSet sealing или
  SQLite repositories.
- Не называть provider «production», если это deterministic external double;
  identity/evidence должны явно показывать test provider.

### Приёмка

- Подмена незаявленного ключа в реальном override делает proof красным.
- Удаление production module/check identity меняет fingerprint и делает proof
  красным.
- Один minimal scripted happy path проходит через real assignment/MCP/Gate.
- В repo есть ratchet: новый causal proof не может импортировать три старые
  composition surfaces.

---

## Brief W0-2 — Компилятор Acceptance Obligation Contracts

### Цель

Создать независимую машинно-читаемую норму «что Factory обязан защищать»,
автоматически вывести из неё конечные семейства мутантов и доказать set-equality
с реально установленными protections. Не создавать вручную поддерживаемую
копию Gate-ов и не требовать от человека писать negative fixtures по одному.

### Сделать

1. Добавить test-side schema и compiler для `AcceptanceObligationContract`.
   Контракт является нормативным источником и не импортирует validator,
   CheckProvider или installed CheckPlan, который будет проверять.
2. Минимальная запись контракта:

```js
{
  obligationId,
  sourceRefs,              // REG/PROC/ADR/failure-axis
  subjectKind,
  protectedProperty,
  constraints: [
    // cardinality, unique, grammar, ref, digestOf, equality, subset,
    // projection, lineage, ordering, version, crossField
  ],
  expectedProtection: { moduleRef, nodeRef, role, checkId, providerRef },
  faultClasses,
  mutationProfile: { structural: true, relational: true, semanticProfileRef: null },
  requiredCorpus: { positive, negative, repair, ignoredFeedback },
  allowedTerminalKinds
}
```

3. Реализовать одну общую mutation algebra. Она автоматически компилирует:
   - из JSON/tool schema: missing required, wrong type/enum/bounds, empty,
     malformed, unknown field и incompatible version;
   - из constraints: zero/below/above cardinality, duplicate, malformed/truncated
     grammar, missing/foreign/stale/cross-run ref, wrong-object digest,
     missing/extra/substituted member, empty/ambiguous projection, broken lineage,
     order и cross-field mismatch.
4. Генератор создаёт `MutantCase` с точным `obligationId`, `operatorId`,
   нарушенным constraint, seed digest и ожидаемой authorized rejection boundary.
   Он не копирует ожидаемый ответ из production validator.
5. Отдельный installed-protection reader получает фактические module manifests,
   CheckPlans, schemas, providers, effects и routes через production public
   declarations. Он не читает obligation compiler output при построении
   installed set.
6. Сравнить exact sets:
   - нормативное обязательство без protection — fail;
   - protection без нормы — fail/unclassified installation;
   - дублирующий/неоднозначный owner — fail;
   - obligation без сгенерированного mutant family — fail;
   - required causal corpus class без representative scenario — fail.
7. Построить kill matrix
   `obligation × operator × assigned detector × observed outcome`.
   Нарушающий обязательство мутант не обязан падать на intake, но не может
   достичь acceptance: допустимы только typed rejection, `repair_required` или
   declared typed wait/terminal.
8. Ввести явные oracle classes:
   `mechanical | semantic-adjudicated | harvested`. Harvested acceptance не
   является положительной истиной без независимой разметки.

### Независимость

- Человек или архитектурный агент один раз объявляет защищаемое свойство и
  constraints при создании/миграции ProductContract или Gate. Он не пишет
  отдельные negative fixtures и mutation cases.
- Obligation contracts версионируются независимо от validator implementation.
- Installed reader может обнаружить реализацию, но не генерирует ожидание.
- Durable trace проверяется третьим компонентом в следующих briefs.
- Семантически бесконечное пространство не объявляется исчерпанным: обязательна
  только полнота относительно объявленного конечного constraint/fault model.

### Приёмка

- Удаление одного installed check из копии manifest делает тест красным.
- Удаление obligation из installed surface не удаляет норму автоматически.
- Новый CheckPlan entry ломает set-equality до явной классификации.
- Один declarative `cardinality(min:1)` автоматически порождает zero-member
  mutant; `unique(by:criterionCode)` — duplicate-code mutant; `grammar` —
  malformed/truncated/near-miss family.
- Принятый мутант делает suite красным и показывает obligation/operator/detector.
- Compiler не импортируется production runtime и ничего не пишет в БД.

---

## Brief W0-3 — Scenario DSL, trace observer и не-всеведущий actor

### Цель

Реализовать test vocabulary ADR-084 без второго runtime.

### Сделать

1. Реализовать runtime validator для `CausalFaultScenario` из стратегии:
   fault class, oracle class, injection boundary, assumptions, detector,
   diagnosability, owner, frontier, preserved prefix, invalidation cone,
   budget, repair fixture и independent facts. Для generated mutation добавить
   `obligationId`, `mutantId`, `operatorId`, `violatedConstraint` и seed digest.
2. Создать read-only durable trace observer. Он читает реальные:
   WorkIntent, ProductRef, CandidateSet, CheckReceipt, GateDecision,
   RecoveryIssue, effect/transition receipts и lifecycle outcomes.
3. Observer не вычисляет ожидаемый transition; он только нормализует факты и
   authority refs. Ожидания приходят из registry/scenario.
4. Создать actor program, который принимает только production-visible input:
   WorkIntent/prompt, desk files, MCP result/error, recovery feedback.
5. Actor reaction выбирается по видимому nonce/reason/evidence, а не по
   attempt/scenario id. Записать `visibleInputDigest → actorOutputDigest`.
6. Реализовать counterfactual runner:
   - exact feedback;
   - feedback absent;
   - stale subject/ref;
   - corrupted nonce/reason.
7. Fault injection допускается на именованной durable или actor-visible
   границе. Нельзя менять ожидаемый DB projection напрямую.
8. Progress oracle после fair drain обязан классифицировать каждый nonterminal:
   runnable owner, due transition, typed wait или typed terminal. Иначе fail как
   anonymous stall.
9. Полная mutation conformance выполняется дёшево на реальной Gate/validator
   границе. Полный causal loop выполняется минимум для одного автоматически
   выбранного representative каждого эквивалентного класса outcome/frontier,
   а не для каждой комбинации полей.

### Приёмка

- Actor получает одинаковый output при одинаковом visible input независимо от
  номера запуска.
- Exact nonce feedback приводит к repair; три контрфактических варианта — нет.
- Trace observer не импортирует reducers и не пишет authority tables.
- Scenario без explicit fairness/budget/diagnosability не валидируется.

---

## Brief W0-4 — Blocking proof group и mutation ratchets

### Цель

Сделать proof-kernel обязательным, а не ещё одной необязательной папкой.

### Сделать

1. Добавить `factory-proof` group в `tools/run-acceptance-matrix.mjs` только
   после зелёных W0-1..W0-3.
2. Включить obligation-contract compilation, installed-protection set-equality,
   mutation kill matrix, DSL validation, actual-composition allowlist, actor
   counterfactual self-test и progress oracle.
3. Не помещать новый group в quarantine и не использовать `continue-on-error`.
4. Coverage self-test обязан видеть новый group и его файлы.
5. Добавить mutation tests:
   - удалить obligation contract;
   - принять generated mutant;
   - отключить один mutation operator;
   - удалить protection;
   - изменить provider/version/check id;
   - actor тайно смотрит attempt number;
   - observer реконструирует expected state из reducer;
   - сценарий не имеет ignored-feedback terminal.
6. W9/factory-temporal нельзя объявлять заменёнными до миграции их обязательств
   в registry и canonical scenario packs.

### Приёмка

- CI-команда `--group factory-proof` запускает ненулевой exact file set.
- Каждая self-mutation proof-kernel делает suite красным.
- В отчёте есть ненулевая kill matrix; ни один mutant не достиг acceptance.
- Quarantine не вырос.

---

## Brief W1-1 — Первый полный causal proof: fabricated derived evidence

### Цель

Провести известный hash-дефект через настоящий agentic loop, а не только через
direct handler test.

### Сценарии

1. Positive: worker пишет file-backed artifact, вызывает MCP без hash; Factory
   вычисляет container `content_hash`; Gate принимает.
2. Negative-shape: malformed hash/path payload отвергается intake schema/handler,
   durable material mutation = 0.
3. Negative-semantic: shape-valid fabricated 64-hex при недоступных bytes
   отвергается `ARTIFACT_CONTENT_HASH_UNVERIFIABLE`, mutation = 0.
4. Repair: actor видит exact path/reason, пишет bytes, повторяет без hash;
   Factory создаёт новую valid presentation и проводит её до acceptance.
5. Counterfactual: absent/stale/corrupt feedback не вызывает магический repair;
   budget заканчивается typed terminal/wait, не циклом.

### Authority assertions

- Hash активного machine checkout, а не stale canonical path.
- Caller string не входит в accepted authority.
- `content_hash` = current container bytes;
  `accepted_hash` = accepted container version;
  `criterionHash` = atomic section identity.
- Repair frontier — container presentation/workspace/path owner, не поле hash.
- Старый rejected attempt не мутируется; repaired material — новая immutable
  presentation/revision.

### Приёмка

- Один proof trace содержит origin, detector, exact error, actor input digest,
  repaired ProductRef/CandidateSet/Gate и terminal state.
- Три counterfactual traces доказывают причинность feedback.
- Сценарий зарегистрирован как positive/negative/repair family obligation-а.

---

## Brief W1-2 — Настоящий Factory Start A → новый Factory Start B

### Цель

Закрыть §16 replay proof. Resume того же LifecycleRun не засчитывается.

### Сделать

1. Run A: полный canonical proof-run до принятого terminal с capsules/receipts.
2. Run B: намеренный новый Factory Start с новыми Process/Stage/Lifecycle,
   Workplace, CandidateSet и Gate identities, но совместимым semantic input.
3. Доказать capsule hit/miss/invalidity через production replay capture/binder,
   а не прямым SQL seed.
4. Actor invocation count B должен соответствовать точному replay contract;
   zero-call разрешён только при доказанной compatible capsule authority.
5. Добавить Run C с несовместимым key material: reuse запрещён typed reason-ом.
6. Удалить/исправить отключённый Run B в `golden-path.test.mjs`; не считать
   старый resume-сценарий заменой.

### Приёмка

- Assertions явно доказывают разные lifecycle/workplace/candidate/gate refs.
- Semantic-compatible authority сходится; несовместимая не переиспользуется.
- Тест проходит через canonical composition и blocking `factory-proof` group.

---

## Brief W1-3 — Authorized Delivery до `released`

### Цель

Впервые провести отдельный Delivery request через настоящий kernel + ledger +
providers + effects, а не stage-executor stub или vacuous zero-action assertion.

### Сделать

1. Стартовать exact accepted Development candidate через production lifecycle.
2. Создать отдельный authorized Delivery request публичным production API.
3. Использовать deterministic external doubles только в объявленных provider
   seams; они обязаны выдавать exact identity/evidence и наблюдаемое состояние.
4. Пройти preflight, action ledger, effect receipt, external observation,
   settlement и terminal `released`.
5. Negative family: unauthorized request, provider mismatch, receipt-lost after
   external apply, observed-state mismatch, stale candidate.
6. Repair/redrive не повторяет уже применённый effect без idempotency proof.

### Приёмка

- Минимум одна реальная action обязана быть выполнена; `actions.length===0` — fail.
- `released` подтверждается и internal receipts, и independent external marker.
- Каждая негативная ветка имеет typed owner/frontier/terminal.

---

## Brief W1-4 — Два Formalization lifecycle на одном epic

### Цель

Доказать ADR-078 lifecycle isolation на полной production composition.

### Сделать

1. Start A на epic E формализует material A и замораживает baseline A.
2. Новый Start B на том же epic E представляет material B.
3. B не читает accepted artifacts/baseline/candidates A как текущую authority.
4. Изменить cardinality и хотя бы один atomic section, чтобы совпадение нельзя
   было объяснить одинаковым fixture.
5. Проверить container hashes, criterion hashes, baseline snapshot, solution
   contract и Development input каждого lifecycle.
6. Вставить newer decoy rows после freeze и доказать отсутствие recency selection.

### Приёмка

- A и B имеют разные lifecycle-scoped authorities и правильный material.
- Один epic не превращается в неявный material accumulator.
- Исторический A остаётся audit-readable и не мутируется.

---

## Brief W1-5 — Полные gate families и bounded recovery

### Цель

Для каждого installed Gate/CheckPlan entry автоматически скомпилировать
пространство неправильности из его Acceptance Obligation Contracts и доказать
recovery completeness объявленной конечной fault model. Ручной список мусора
и ручной negative fixture на каждый Gate не являются допустимой архитектурой.

### Mutation conformance для каждого entry

1. Получить или построить минимальный valid witness, независимо проверить его
   obligations и не считать прежний production acceptance доказательством.
2. Сгенерировать structural mutant family из schema/tool contract.
3. Сгенерировать relational mutant family из constraint DSL.
4. Подключить версионированный semantic/metamorphic profile там, где свойство
   нельзя выразить структурным constraint; curated fixtures необязательны и не
   являются ручной основой покрытия.
5. Прогнать все mutants через настоящую authorized boundary и записать kill
   matrix. Ни один нарушающий obligation mutant не может достичь acceptance.
6. Принятый mutant — blocking failure с триажем: либо неверна декларация нормы,
   либо найден production defect. До явного решения suite остаётся красным.

### Causal representative family

Для каждого эквивалентного класса `{detector, reason, owner, frontier}` compiler
выбирает representative и проводит полный путь:

1. valid product;
2. generated defective product;
3. exact expected detector/receipt/reason/evidence;
4. exact feedback в следующем worker input;
5. repaired immutable revision;
6. repeated successful acceptance;
7. ignored/no-op repair до bounded typed wait/terminal;
8. absent/stale/corrupted feedback counterfactual.

Обязательный первый relational family Formalization:

- `atomicCriteria cardinality(min:1)` → zero-criteria bundle;
- `criterionCode unique` → duplicate codes;
- heading grammar → malformed, truncated и near-miss headings;
- accepted container без точного atomic anchor → empty/ambiguous projection.

### Causal assertions

- detection site, fault origin и repair owner записываются отдельно;
- `isolated` использует exact lineage;
- `ambiguous` запускает declared probe или wider safe frontier;
- `external` завершает typed wait/human boundary;
- valid prefix/siblings сохраняются;
- invalidation cone пересобирается append-only;
- новый fault reason без route становится `unclassified_fault`, а не generic
  retry или silent acceptance.

### Порядок расширения

1. Mechanical schema/binding checks.
2. Deterministic providers/build/Git checks.
3. Reviewer semantic-adjudicated corpus.
4. Effects/external-state checks.
5. Cross-stage upstream routes, которые реально существуют.

Не изобретать универсальный Development → Formalization/Discovery rewind ради
теста. Если route специализирован/операторский, proof обязан честно получить
typed boundary. Отдельное persisted recovery redesign выносится архитектору.

### Финальная приёмка

```text
normative obligations
  = installed protection declarations
  = compiled non-empty mutant families
  = mutation kill matrix without accepted violations
  = covered causal representative repair/ignored-feedback families

emitted repair_required/failed/human_required reason classes
  = registered routes or explicit unclassified typed terminals
```

Ни один declared fault не принимается молча и не оставляет ownerless
nonterminal scope после fair drain/budget.

---

## Definition of Done — остановка архитектурного рефакторинга

Эта программа не является бесконечной. Архитектурный рефакторинг объявляется
завершённым, когда одновременно выполнены следующие условия:

1. Архитектурно приняты W0-1…W0-4.
2. Закрыты P0 proofs W1-1…W1-4 через canonical production composition.
3. На свежей БД проходит scripted happy E2E без ручных authority-записей.
4. На свежей БД проходит scripted repair E2E: дефект → detector → exact feedback
   → причинный владелец → новая immutable revision → повторная acceptance.
5. Затем проходят два узких real-model canary через opencode, Docker,
   concurrency `1` и production composition:
   - happy canary до заявленного terminal без оператора;
   - repair canary с заранее внесённым исправимым дефектом до acceptance без
     SQL-правок, `unpark`, подмены результата или скрытого resume.
6. Durable trace обоих canary сохраняет точную authority-цепочку:
   `WorkIntent → ProductRef → ProductionRevision → CandidateSet → GateDecision
   → effect/final receipt → terminal`.
7. После fair drain нет `DEFERRED`, ownerless nonterminal, material selection по
   latest/task/execution, ручного восстановления и расхождения terminal label с
   independently observed product.

До canary допускается максимум две итерации исправлений, найденных scripted E2E.
После выполнения Definition of Done единичный новый дефект не открывает новый
архитектурный цикл автоматически:

- implementation defect → обычный локальный `fix`;
- отсутствующий класс объявленной fault model → новый obligation/constraint;
- слабость конкретной LLM → prompt/model/eval;
- новый нарушенный authority invariant → отдельный ADR.

W1-5 продолжается как систематическое расширение mutation coverage и не блокирует
первую эксплуатацию после P0 и двух canary. Он блокирует заявление о полной
recovery-completeness всех Gate families, но не возвращает проект в бесконечный
архитектурный refactor.

Короткий критерий: Factory без человека производит и принимает простой продукт,
а затем без человека обнаруживает, объясняет и исправляет один реальный дефект,
сохраняя exact authority и завершаясь в пределах бюджета.

---

## Порядок передачи рабочей лошадке

Строго последовательно:

1. W0-1 — canonical composition.
2. W0-2 — obligation-contract compiler и mutation algebra.
3. W0-3 — DSL/observer/actor.
4. W0-4 — blocking group.
5. W1-1 — первый causal vertical slice.
6. W1-2, W1-3, W1-4 — независимые P0 proofs; можно выполнять отдельными
   ветками только после общего W0 baseline.
7. W1-5 — систематическое заполнение всех gate families.

После каждого brief архитектор проверяет только архитектурные инварианты и
доказательность trace. Количество зелёных тестов само по себе не является
критерием приёмки.
