# Decision Artifacts (ADR/RFC) в Review Flow — идея (2026-07-30)

> Возникла во время наблюдения за SRS review loop: архитектор и reviewer
> спорят в комментариях, но обсуждение не становится артефактом. ADR решил бы.

## Контекст

Во время прогона formalization, SRS проходил через 6+ executions review loop.
Каждый раз reviewer находил проблемы, developer чинил. Но:

- Обратная связь живёт в task comments (обрезанных до 200 символов) — эфемерно
- Нет WHY: архитектор выбрал scaffold-then-parallel, но не записал почему
- Нет альтернатив: reviewer говорит "поменяй", но не "рассмотри вариант A vs B"
- Нет связи с архитектурным решением (к какому разделу SRS относится замечание)
- После restart всё теряется

## Что даст ADR/RFC в review

Review enrichment (не новый узел flow, а **дополнительный output** существующего review):

```yaml
# decision artifact
code: DEC-1
title: "Architecture topology: scaffold-then-parallel"
status: proposed  # → accepted после согласования
context: |
  17 ACs, shared sensory settings, multiple button variants.
  Complexity Gate: size=M, shared_mutation_risk=true.
decision: |
  Base component + sensory settings infrastructure (scaffold),
  then variants developed in parallel.
alternatives:
  - name: "monolithic"
    rejected_because: "shared mutation risk too high, merge conflicts"
  - name: "pure-component"
    rejected_because: "duplicated sensory settings, NFR-1 violation"
consequences:
  - positive: "parallelizable, fewer conflicts"
  - negative: "scaffold phase blocks everything"
reviewer_concern: |
  FR-6 (TypeScript) needs types in scaffold phase, not after.
```

## Почему ценно для Saga

1. **Слабая модель (GLM-4.7)** делает выборы интуитивно. ADR **заставляет**
   записать rationale. Слабый rationale → reviewer видит и блокирует.
2. **Traceability**: `decision` → `derived_from` → `SRS` + `derived_from` → `AC`/`FR`.
   "Почему выбрана эта архитектура?" → DEC-1 → потому что Complexity Gate + NFR-1.
3. **Development**: developer читает не только AC, но и DEC. Понимает WHY, не только WHAT.
4. **Recovery**: ADR переживает reset (artifact в БД с content_hash), не нужно перерегистрировать.

## Как встроить (минимально инвазивно)

- **НЕ менять** review loop структуру
- Reviewer, находя архитектурную проблему, создаёт `decision` artifact (status=proposed)
- Архитектор в fix round читает decision, обновляет SRS, меняет status → accepted
- Decision связан с SRS через `derived_from`
- Kernel settlement проверяет: каждый SRS имеет ≥1 accepted decision (если Complexity Gate > S)

Это **не новый узел в flow** — это дополнительный output существующего review process.
Тот же reviewer, та же задача, просто ещё один тип артефакта.

## Тип `decision` уже есть

Artifact type `decision` уже существует в коде (`artifact_create` принимает type:'decision').
Просто не активирован в formalization flow. Включение — вопрос:
- skill-инструкции для reviewer ("создавай decision при архитектурных замечаниях")
- проверки в kernel settlement ("SRS без accepted decision → clarification-required")
- НЕ архитектурное изменение

## Статус

Идея, не реализована. Запущена на дизайн когда формализация пройдёт полностью.
Приоритет: после proof-of-concept полного lifecycle (Discovery → Delivery).
