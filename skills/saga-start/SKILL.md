---
name: saga-start
description: Choose and execute the canonical Saga4 factory start mode: production resume, new production order from an HTTPS idea URL, zero-LLM checkpoint replay, or real-LLM warm-start testing.
---

# Saga Start — единая точка входа в завод

Используй skill в основном интерактивном контексте, когда пользователь просит
запустить, перезапустить, продолжить или протестировать завод.

## Сначала обязательно выбрать режим

До записи в БД, создания проекта, восстановления checkpoint или запуска worker
покажи пользователю этот список:

```text
В каком режиме запустить завод?

1. Resume существующего заказа
   Продолжить тот же production LifecycleRun с последней durable-точки.
   Нужен project_id; новый заказ не создаётся.

2. Новый production-заказ
   Создать новый завод из продуктовой идеи и выполнить полный live-конвейер.
   Нужна HTTPS-ссылка idea_url; источник замораживается с digest.

3. Тест без LLM — checkpoint replay
   В diagnostic clone подставить уже готовые результаты узлов. LLM не
   вызывается; обычные downstream kernel/gate и переходы выполняются заново.
   Результат test-only и не может стать production-eligible.

4. Тест с реальной LLM — warm start
   Дать настоящей модели ранее созданные документы как draft. Проверяются её
   рабочий стол, инструкции, tools, review feedback, логи и повторный переход.
   Дорогие внешние/NFR checks разрешено не запускать только по test check plan:
   они получают not_run, а не passed. Результат не production-eligible.
```

Если пользователь уже явно выбрал точный режим и предоставил необходимые
параметры, не спрашивай повторно. Иначе дождись ответа; режим нельзя выводить из
догадок по текущей директории, наличию старых файлов или последнему Epic.

## Режим 1 — production resume

Запроси `project_id`, если его ещё нет. Используй только канонический gateway:

```http
POST /api/factory/start
Content-Type: application/json

{"project_id": 42}
```

Инварианты:

- project id означает только resume;
- завод разрешает ровно один resumable FactoryOrder/LifecycleRun;
- при неоднозначности остановись с явной ошибкой, не выбирай «самый свежий»;
- input, epic, idempotency key, checkpoint и cursor берутся из durable state;
- не создавай новый Project, Epic или LifecycleRun как fallback.

## Режим 2 — новый production-заказ

Запроси `idea_url`, если её ещё нет. URL должен быть HTTPS. Используй только:

```http
POST /api/factory/start
Content-Type: application/json

{"idea_url":"https://docs.example.com/product-idea"}
```

Завод сам замораживает source bytes, создаёт Project/Repository/Epic/FactoryOrder,
собирает lifecycle input и выдаёт одноразовый launch capability. Не спрашивай у
пользователя `epic_id`, lifecycle input path, idempotency key, model или
concurrency как параметры старта.

## Режим 3 — checkpoint replay без LLM

Запроси:

- checkpoint manifest/ref;
- путь к отдельной diagnostic clone или разрешение создать её;
- target project/epic/process run/node и source node run, если они не следуют
  однозначно из checkpoint;
- диагностическую цель/reason.

Порядок:

1. `saga-checkpoint verify`.
2. `saga-checkpoint restore-clone` — никогда не restore поверх production DB.
3. `saga-checkpoint adopt --profile=test_replay` в clone.
4. Продолжить runtime с resume directive; LLM для adopted node не запускается.
5. Обычный downstream kernel/gate принимает или отклоняет точный результат.

Нельзя вручную ставить artifact `accepted`, task `done` или фабриковать reviewer
receipt. Replay заменяет producer результата, но не решение gate.

## Режим 4 — real-LLM warm start

Запроси:

- `project_id` либо diagnostic clone;
- checkpoint manifest/ref или готовый warm-start fixture;
- какой узел и какой review/repair-loop требуется проверить.

Подготовь fixture через `saga-checkpoint warm-start-fixture`, затем включи:

```powershell
$env:SAGA_TEST_WARM_START='1'
$env:SAGA_TEST_WARM_START_FIXTURE='D:\fixtures\factory-warm-start.json'
```

Ранее созданный материал является draft, не accepted product. Настоящий worker
обязан увидеть pinned skill, инструкции, allowed tools, node input и recovery
feedback, зарегистрировать результат штатными MCP-вызовами и пройти reviewer и
kernel. Если test check plan исключает дорогую проверку, зафиксируй `not_run` и
`productionEligible=false`; отсутствие evidence нельзя превращать в `passed`.

## Общие запреты

- Не использовать удалённые `/api/engine/start`, `/api/engine/restart` или
  `/api/project/create-from-idea`.
- Не запускать runtime host вручную по project/epic: он принимает только
  одноразовый `launch_ref`, созданный gateway.
- Не смешивать test evidence с production DB.
- Не ослаблять provenance, hash, scope, fence, exact-candidate acceptance или
  settlement даже в тестовом режиме.
- Не утверждать, что semantic review протестирован, если reviewer был fixture
  или не запускался.

Подробный контракт: `ЗАВОД-ЗАПУСК.md` и
`docs/design/FACTORY-CHECKPOINT-AND-TEST-PROFILES.md`.
