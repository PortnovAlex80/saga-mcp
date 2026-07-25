# Saga 3 Lifecycle Orchestrator

> Что происходит после того, как одна Stage生命周期 выдала свой артефакт.
> Где сегодня проходит граница "построено / не построено".

## 1. Два уровня оркестрации

Saga 3 orchestrates work at two distinct levels. Mixing them is the most
common source of confusion when reading the code.

```
┌──────────────────────────────────────────────────────────────┐
│  УРОВЕНЬ 1 — Episode Orchestrator (внешний, "роутер стадий") │
│  Проходит по Stage'ам ЖЦ продукта. Не лезет внутрь Stage.   │
│                                                              │
│    discovery → formalization → planning → development →      │
│    verification → integration → completed                    │
└────────────────────────┬─────────────────────────────────────┘
                         │ вызывает stage.run()
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  УРОВЕНЬ 2 — Scenario Runner (внутренний, "интерпретатор")   │
│  Проходит по Node'ам внутри одной Stage по DAG.             │
│                                                              │
│    worker → readiness → settlement → certificate → diagnosis │
└──────────────────────────────────────────────────────────────┘
```

**Уровень 2 (Scenario Runner)** — построен и доказан (epic 37, GLM-5.2,
Discovery Stage прошла end-to-end за один проход, diagnosis accepted).

**Уровень 1 (Episode Orchestrator)** — **не построен**. После того как
Discovery Stage выдаёт certificate, никто не вызывает следующую Stage.
Движок `saga3-discovery` возвращает `finalStage: 'discovery'`,
`scopeCompleted: true` и завершается.

## 2. Что происходит после Discovery (фактически)

```
[ТЕПЕРЬ] Discovery done, certificate issued
    │
    │  finalStage: 'discovery'
    │  scopeCompleted: true
    │  outcome: clarify | go | reject
    │
    ├── СИСТЕМА: останавливается
    │      (нет Episode Orchestrator'а, который вызвал бы
    │       episode_transition → formalization)
    │
    └── БИЗНЕС: человек читает diagnosis report
            │
            │  outcome определяет дальнейший путь:
            │
            ├── outcome = 'clarify'
            │      Два варианта blocking gaps (data + regulatory).
            │      Нужны действия человека:
            │        • интервью с проектировщиками (PLAXIS data?)
            │        • аудит данных (историческая осадка)
            │        • консультация с регуляторами (статус shadow-AI)
            │      Затем → перезапуск Discovery с обновлённым evidence.
            │
            ├── outcome = 'reject'
            │      Идея закрыта. Certificate остаётся как audit trail.
            │      Повторная подача — только как новый epic.
            │
            └── outcome = 'go'
                   Идея одобрена для formalization.
                   Но Formalization Stage ещё не построена —
                   certificate пока "висит" без продолжения.
                   Когда Episode Orchestrator будет готов,
                   'go' автоматически запустит formalization.
```

**Ключевой вывод:** `clarify` — это не сбой, а **штатное завершение**.
Discovery сказала: "идея валидна, но требует уточнений перед тем как
идти дальше". Это и есть правильное поведение системы для большинства
greenfield-идей.

## 3. Граница "построено / не построено" (сегодня)

| Stage ЖЦ | Построена? | Доказана? | Что есть |
|---|---|---|---|
| **Discovery** | ✅ да | ✅ epic 37 E2E | saga3-discovery engine, 5 Node, certificate + diagnosis |
| Formalization | ❌ нет | — | (saga2 legacy, не интегрирована в saga3) |
| Planning | ❌ нет | — | — |
| Development | ❌ нет | — | — |
| Verification | ❌ нет | — | — |
| Integration | ❌ нет | — | — |
| **Episode Orchestrator** | ❌ нет | — | нет router'а, который проходит по Stage'ам |

## 4. Контракт Stage (для будущего Episode Orchestrator'а)

Каждая Stage возвращает `StageResult` — именно его читает Episode
Orchestrator, чтобы решить "что дальше":

```typescript
interface StageResult {
  finalStage: string;              // 'discovery' | 'formalization' | ...
  scopeCompleted: boolean;         // эта Stage замкнулась?
  outcome?: string;                // авторитетный вердикт стадии
                                   //   discovery:  go | clarify | reject
                                   //   formalization: baseline_accepted | ...
  outcomeAuthority: string;        // кто авторитет (settlement_policy / reviewer / ...)
  reason: 'completed' | 'failed' | 'paused_timeout';
  nextStage?: string;              // куда передать эстафету (если scopeCompleted)
  certificateId?: number;          // immutable артефакт Stage (если есть)
}
```

Episode Orchestrator — это цикл:

```typescript
async function runEpisode(projectId, epicId) {
  let stage = 'discovery';                    // стартовая Stage
  while (stage !== 'completed') {
    const stageImpl = stages[stage];          // берём реализацию Stage
    const result = await stageImpl.run({ projectId, epicId });
    if (!result.scopeCompleted) {
      return { status: 'paused', stage };     // Stage не замкнулась — стоп
    }
    stage = result.nextStage ?? 'completed';  // эстафета
  }
  return { status: 'completed' };
}
```

## 5. Решение по outcome — роутинг после Discovery

Episode Orchestrator читает `outcome` из certificate и решает:

| outcome | Действие orchestrator'а | Кто должен работать дальше |
|---|---|---|
| `go` | `episode_transition → formalization` | система (автоматически) |
| `clarify` | **остановка**, создание human-action task | человек (интервью, данные, регуляторика) |
| `reject` | **закрытие эпика**, archive | человек (решение принято) |

`clarify` и `reject` — это **человеческие развилки**. Система не может
сама провести интервью с проектировщиком или проконсультироваться с
регулятором. Она честно говорит: "я дошла до границы своих знаний,
дальше нужен человек".

`go` — **машинная развилка**. Система может идти дальше сама
(в formalization), когда научится.

## 6. Что нужно построить, чтобы "дальше" работало

### 6.1 Episode Orchestrator (Уровень 1)

- Читает `StageResult` после каждой Stage
- Роутит по `outcome` (go → formalization, clarify → human, reject → close)
- Хранит current stage в `episode_workflows.stage`
- Поддерживает restart (если упал посреди formalization — возобновить с неё)

### 6.2 Formalization Stage (следующая Stage)

По плану Node-архитектуры (`NODE-ARCHITECTURE-PLAN.md`):

```yaml
nodes:
  - { id: prd,        kind: worker_node,  skill: saga-product,           produces: PRD }
  - { id: prd_review, kind: review_node,  skill: saga-requirements-reviewer }
  - { id: uc,         kind: worker_node,  skill: saga-analyst,           produces: UC }
  - { id: uc_review,  kind: review_node,  skill: saga-requirements-reviewer }
  - { id: ac,         kind: worker_node,  skill: saga-analyst,           produces: AC }
  - { id: baseline,   kind: deterministic_node, service: Reconciler,     produces: baseline_hash }
  - { id: srs,        kind: worker_node,  skill: saga-architect,         produces: SRS }
  - { id: srs_review, kind: review_node,  skill: saga-architecture-reviewer }
terminal: srs_review.approved
```

Артефакты: PRD → UC → AC → baseline hash → SRS. Каждый проходит review-gate.

### 6.3 Stage Package (для каждой новой Stage)

По контракту из `NODE-ARCHITECTURE-PLAN.md` секция J:
- scenario (DAG из Node)
- skills (по одному на worker/review Node)
- templates (call-шаблоны + checklists)
- MCP handlers (stage-specific tools)
- tracker template

## 7. Текущий статус (одной фразой)

**Discovery Stage построена и доказана end-to-end (epic 37).**
**Episode Orchestrator и следующие 5 Stage ЖЦ — не построены.**
**Следующий шаг — Episode Orchestrator + Formalization Stage по плану
Node-архитектуры.**

## См. также

- `NODE-ARCHITECTURE-PLAN.md` — детальный план миграции на Node (5 фаз)
- `SAGA-3-DISCOVERY-FIRST-ROADMAP.md` — roadmap Discovery Edition
- `docs/saga3/D6-FIRST-REAL-RUN-EVIDENCE.md` — evidence первого полного прогона
