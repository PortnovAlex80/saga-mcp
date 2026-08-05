# Factory checkpoint и тестовые профили

**Status:** Implemented foundation  
**Date:** 2026-08-06  
**ADR:** [ADR-024](../architecture/decisions/024-factory-checkpoint-resume-and-adoption.md)

## Что требуется, чтобы результат прошёл ядро

Файл сам по себе не является результатом узла. Ядро проводит результат через
последовательные слои:

| Слой | Что доказывает | Что проверяется |
|---|---|---|
| 0. Run identity | это тот же заказ | project/epic, lifecycle/idempotency, input hash |
| 1. Assignment | исполнитель имел право работать | точная карточка, lease, execution id, fence |
| 2. Workdesk | исполнитель получил правильный стол | pinned package/skill, инструкции, allowed tools, node input, feedback |
| 3. Production | продукт действительно зарегистрирован | managed ledger/submission, producer execution, node lineage |
| 4. Integrity | байты не подменены | schema/ref/digest, disk SHA-256, repository containment |
| 5. Candidate | партия заморожена для проверки | immutable CandidateSet или legacy exact candidate |
| 6. Deterministic checks | выполнены формальные инварианты | schema, completeness, trace graph, policy checks |
| 7. Review | есть независимая оценка, если она нужна | reviewer execution, findings, repair feedback |
| 8. Gate | принято решение ядра | check plan, receipts, policy digest, accepted bindings |
| 9. Settlement | цех закончил работу | completion/certificate, outcome, stage handoff |
| 10. Effects | внешний эффект не повторён | effect idempotency/receipt отдельно от product replay |

Поэтому корректный import не ставит `artifact.status=accepted` и не переводит
`task=done`. Он создаёт отдельную authority `checkpoint_import`, предъявляет
точный ранее полученный `NodeExecutionResult`, а затем отдаёт его обычному
следующему kernel/gate.

## Три разных режима — не один «ослабленный gate»

### Интерактивный выбор перед запуском

Просьба пользователя «запусти завод» сама по себе недостаточна для выполнения.
Агент сначала предлагает четыре операторских варианта: production resume,
новый production-заказ по HTTPS idea URL, `checkpoint_replay` без LLM и
`test-warm-start` с реальной LLM. Готовый текст вопроса и список обязательных
параметров находятся в `ЗАВОД-ЗАПУСК.md` §1 и `skills/saga-start/SKILL.md`.

Это четыре варианта выбора для оператора, но три execution-профиля ниже:
production resume и новый production-заказ оба работают в профиле `live`.

### 1. `live`

Реальная модель создаёт материал. Все слои 0–10 обязательны. Это золотой
прогон и единственный источник новых production-эталонов.

### 2. `checkpoint_replay` — 0 вызовов LLM

Нужен для проверки runtime, routing, kernel, review/gate, settlement и переходов
между цехами. `saga-checkpoint adopt --profile=test_replay` подставляет
проверенный результат перед физическим вызовом LM. `GenericFlowExecutor`
создаёт обычный durable NodeRun с replay receipt и продолжает в текущий gate.

Профиль разрешён **только в diagnostic clone**, созданном `restore-clone`.
Таким образом тестовый acceptance физически не может загрязнить production DB.
Строгость downstream gate не снижается; меняется только источник production.

### 3. `test-warm-start` — реальная модель, но готовый черновик

Это уже существующий механизм для проверки именно поведения модели:

```powershell
$env:SAGA_TEST_WARM_START='1'
$env:SAGA_TEST_WARM_START_FIXTURE='D:\fixtures\factory-warm-start.json'
```

Перед запуском модель получает на рабочий стол:

- прежний документ как draft, а не accepted product;
- pinned skill/package и инструкции текущего узла;
- точный `process_node_input`;
- только разрешённые инструменты;
- `recovery-feedback.json` и причину отказа при repair;
- `test-warm-start.json` с hash/input/package provenance.

Модель должна проверить черновик, зарегистрировать продукты нормальными MCP
вызовами и вызвать обычное завершение worker. Reviewer и kernel остаются
настоящими. Это дешевле новой генерации, но проверяет реальный prompt/workdesk,
tool policy и цикл обратной связи.

Для чистой проверки механики без реальной модели используются существующие L2
(seeded DB) и L3 (mock-LLM) тесты из `TESTING-STRATEGY.md`.

## Карточка перехода рабочего стола

Для каждого перехода диагностика должна показывать один и тот же контракт:

```text
FROM: module/processRun/node/workplace/revision
INPUT: input schema + input hash + predecessor ProductRefs
DESK: package/skill/tools/workspace files/recovery feedback
PRODUCER: worker execution или checkpoint_import adoption
CANDIDATE: exact ProductRefs + digests
CHECK PLAN: deterministic checks + reviewer requirement + policy digest
DECISION: verdict + findings + receipt refs
TO: next node или lifecycle stage + mapped output hash
```

Источники этих полей уже durable: ProcessRun/NodeRun, execution context,
managed ledger, CandidateSet/GateDecision, recovery case, StageRun/transition.
Checkpoint сохраняет всю БД и реальные artifact bytes, поэтому карточку можно
восстановить для посмертной отладки без догадок по логам.

## Команды checkpoint

```powershell
npm run build
node dist/checkpoint-cli.js capture --db=D:\state\saga.db --store=D:\state\checkpoints --project=1 --epic=2 --actor=operator
node dist/checkpoint-cli.js verify --manifest=D:\state\checkpoints\manifests\checkpoint-....json
node dist/checkpoint-cli.js warm-start-fixture --manifest=D:\state\checkpoints\manifests\checkpoint-....json > D:\fixtures\factory-warm-start.json
node dist/checkpoint-cli.js restore-clone --manifest=D:\state\checkpoints\manifests\checkpoint-....json --target-db=D:\diagnostics\run-42\saga.db --target-workspace=D:\diagnostics\run-42\workspace
node dist/checkpoint-cli.js adopt --db=D:\diagnostics\run-42\saga.db --manifest=D:\state\checkpoints\manifests\checkpoint-....json --project=1 --epic=2 --process-run=83 --node=define-acceptance-contract --source-node-run=151 --actor=tester --reason=kernel-regression --profile=test_replay
```

Для автоматического checkpoint после каждого orchestration cycle:

```powershell
$env:SAGA_FACTORY_CHECKPOINT_STORE='D:\state\checkpoints'
$env:SAGA_FACTORY_CHECKPOINT_HMAC_KEY='<secret from secure env>'
```

Raw worker logs по умолчанию не копируются: они могут содержать секреты. Для
локальной диагностики их можно включить `SAGA_FACTORY_CHECKPOINT_LOGS=1`; в
manifest они помечаются `partial` и никогда не используются как replay input.

## Граница текущей реализации

- Auto-resume продолжает единственный активный LifecycleRun и повторно
  использует его idempotency key/input snapshot.
- Resume directive реально потребляется до запуска LM и после этого проходит
  текущий kernel/gate.
- v4 CandidateSet пока не является единственным authority runtime во всех
  цехах. До завершения cutover import использует фактический gate конкретного
  модуля; он не фабрикует v4 GateDecision.
- Online capture выполняется на orchestration-cycle boundary. Для RPO=0 между
  отдельными DB commits следующим шагом остаётся transactional capture outbox;
  точный restart в исходной БД уже обеспечивается NodeRun/ledger replay.
