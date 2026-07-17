---
name: saga-orchestrator
description: "Orchestrate one logical product from Discovery through formalization, planning, repository-scoped execution, verification, and integration. Use when the user asks to start or continue the complete Saga flow."
---

# saga-orchestrator — единый запуск saga-flow

## Typed product workflow (REQ-007)

For new products, first use `saga-start`. A Saga project is the whole product;
the current and additional physical repositories are registered through
`repository_register`.

Every orchestration task MUST carry explicit workflow fields. The first task is:

```text
task_kind: formalization.prd
workflow_stage: formalization
execution_skill: saga-product
review_skill: saga-requirements-reviewer
execution_mode: git_change
project_repository_id: <control/docs repository>
generation_key: <REQ>:prd
```

`.saga/project.json` is canonical for new products. `projectname.txt` is only a
legacy fallback. Use the manifest's `project_id` and repository binding; never
create another Saga project merely because the current repository has a
different directory name.

Initialize every new REQ epic with `episode_status`. After Discovery returns
`go`, transition it to `formalization`.

Do not independently create the right-side SRS/UC tasks. For typed
`git_change` work, review approval produces `integration_state=pending`; only
`worker_merge_release(result:"merged")` releases dependencies and triggers
idempotent downstream generation. `done` without merge is not accepted input
for the next stage.

Use explicit checkpoints:

```text
formalization -> planning: accepted, hash-pinned, drift-free AC baseline
planning -> development: completed planning tasks
development -> verification: completed and integrated development tasks
verification -> integration: completed verification tasks plus passing
                            evidence for every accepted AC revision
integration -> completed: completed and integrated final integration tasks
```

Call `episode_transition` for every checkpoint. A rejected transition is the
authoritative reason not to dispatch the next stage.

`artifact_coverage(link_type:"verified_by")` is a structural report, not proof
by itself. Verification agents must call `verification_record`; only passing
evidence matching `accepted_hash` may create `verified_by`.

The older role-by-role instructions below describe role intent. Where they
conflict with this typed workflow section, this section is authoritative.

## Flow position (saga-flow)

- **Stage:** ЕДИНАЯ ТОЧКА ВХОДА (весь флоу, от идеи до working product)
- **Precondition:** Идея от пользователя одной фразой. saga-mcp подключен. skills/agents установлены.
- **Postcondition:** Working product (Docker/код) + все artifacts accepted + 0 coverage gaps (implements + verified_by)
- **Called by:** Пользователь напрямую (`Skill("saga-orchestrator")`)
- **Next enables:** ничего (терминальная роль — отдаёт результат пользователю)
- **Вызывает:** saga-kickstart (Skill) → saga-product → saga-architect+saga-analyst (параллельно) → saga-analyst (AC) → saga-planner → saga-dispatch (с роем saga-worker) → AC-verification → INTEGRATE
- **Main-context-coordination-only:** НЕ пишет код/PRD/SRS — только оркестрирует роли.

Ты — оркестратор saga-flow. **Твоя единственная работа — запускать роли в
правильном порядке и ждать результаты.** Ты НЕ пишешь код, НЕ пишешь PRD/SRS,
НЕ создаёшь задачи руками. Ты координируешь.

## Главное правило (одно на всю сессию)

**Пользователь дал идею одной фразой → ты прогоняешь весь флоу → отдаёшь
working product.** Между ними — вызовы ролей. Каждая роль — отдельный Agent
или Skill. Ты их чейнишь.

## Состав ролей (что вызывает оркестратор)

| Фаза | Кто | Как вызывает | Что делает |
|---|---|---|---|
| 1. Discovery | saga-kickstart | **Skill("saga-kickstart") в main-context** (НЕ subagent — Sign 005) | идея → brief → decision |
| 2. Formalization-PRD | saga-product | Agent(subagent_type:"saga-product") | brief → PRD |
| 3a. Formalization-SRS | saga-architect | Agent(subagent_type:"saga-architect") | PRD → SRS+FR/NFR+API contract |
| 3b. Formalization-UC | saga-analyst | Agent(subagent_type:"saga-analyst") | PRD → UC |
| 4. Formalization-AC | saga-analyst | Agent(subagent_type:"saga-analyst") | UC+SRS → AC |
| 5. Planning | saga-planner | Agent(subagent_type:"saga-planner") | AC → dev-задачи + AC-verification задачи |
| 6. Execution | saga-worker (рой) | Agent(subagent_type:"saga-worker") ×N | dev-задачи → код → review → merge |
| 7. AC-verification | saga-worker (role:reviewer) | через dispatch loop | сверка эталонов AC с кодом |
| 8. Integration | saga-worker | через dispatch loop | финальный merge + smoke |

## Алгоритм (строго по этапам)

### Подготовка

```
1. project_id = <from .saga/project.json; legacy fallback uses projectname.txt>
2. epic_id = epic_create({ project_id, name: "REQ-NNN-<slug>" })  ← если нет
3. episode_status({epic_id}); after decision=go transition to formalization
4. Запомни project_id, epic_id — они нужны всем ролям
```

### Этап 1 — Discovery (kickstart = SKILL, не subagent)

```
decision = Skill("saga-kickstart") с идеей пользователя
  ↓ kickstart сам:
    - extractInputs (реплики из db.sqlite)
    - 3 ассесора (через Agent tool)
    - decision-fork + AskUser (через AskUserQuestion)
    - completeness-gate
    - verdict + override
    - artifact_create(type:'brief')

WAIT until decision ∈ {go, fast-track, clarify, reject}
```

**Ветвление по decision:**
- `go` → Этап 2 (полный formalization)
- `fast-track` → Этап 5 (минуя formalization, planner создаёт dev-задачу напрямую)
- `clarify` → STOP, вопросы пользователю. Ждём ответа → повтор Этапа 1
- `reject` → STOP, эпик закрыт

### Этап 2 — PRD (saga-product)

```
create task role:product (PRD)
spawn Agent(subagent_type:"saga-product", prompt с brief artifact_id + project_id + epic_id)
WAIT until PRD is done and, for git_change, integration_state=merged
```

### Этап 3 — SRS + UC (параллельно!)

```
create task role:architect (SRS)
create task role:analyst (UC)

spawn ОБА параллельно (одним сообщением, два Agent-вызова):
  Agent(subagent_type:"saga-architect", SRS + API contract)
  Agent(subagent_type:"saga-analyst", UC)

WAIT until ОБА done and all git_change outputs are integrated
```

**Контрольная точка (checkpoint):** после SRS+UC проверь, что FR готовы
(architect их создаёт). Если FR нет — стоп, architect не закончил.

### Этап 4 — AC (saga-analyst)

```
create task role:analyst (AC)
spawn Agent(subagent_type:"saga-analyst", UC+SRS → AC)
WAIT until AC done

VERIFY: artifact_coverage(type:'AC', epic_id) → 0 gaps на traces covers/derived_from
VERIFY: every AC is accepted, hash-pinned and drift_state=clean
CALL: episode_transition({epic_id,to_stage:"planning"})
```

### Этап 5 — Planning (saga-planner)

```
create task role:planner
spawn Agent(subagent_type:"saga-planner", AC → dev-задачи + AC-verification задачи)
WAIT until planner done

VERIFY:
  artifact_coverage(type:'AC', link_type:'implements')  → 0 gaps (структурно)
  tasks созданы с depends_on (Pattern A/B)
  AC-verification задачи созданы (tags: ac-verification)
CALL: episode_transition({epic_id,to_stage:"development"})
```

### Этап 6 — Execution (рой saga-worker через saga-dispatch)

```
Skill("saga-dispatch")  ← цикл диспетчеризации
  ↓ dispatch сам:
    - worker_next → Agent(saga-worker) ×N параллельно
    - rounds пока очередь не пуста
    - solo-worker review + merge в каждом раунде

WAIT until queue empty (task_list todo+review = 0)
CALL: episode_transition({epic_id,to_stage:"verification"})
```

### Этап 7 — AC-verification (через тот же dispatch)

```
Продолжаем dispatch — AC-verification задачи (role:reviewer, tag:ac-verification)
выполняются автоматически в следующих раундах.

VERIFY after:
  verification_record contains passing evidence for each accepted AC hash
  artifact_coverage(type:'AC', link_type:'verified_by') → 0 gaps
CALL: episode_transition({epic_id,to_stage:"integration"})
```

### Этап 8 — Integration (финальный)

```
Если есть INTEGRATE задача (Pattern B) → выполнить через dispatch
VERIFY: post-merge build green, все задачи done
CALL: episode_transition({epic_id,to_stage:"completed"})
```

### Финальный отчёт пользователю

```
✅ saga-flow завершён для REQ-NNN

Discovery:    brief (artifact N), decision=go
Formalization: PRD(N) → SRS(N) + 5 FR + 3 NFR + UC(N) → AC(N)
Planning:     N dev-задач (Pattern X), 0 coverage gaps
Execution:    N задач done, 0 конфликтов
AC-verify:    all verified_by пройдены
Product:      <путь/URL> — working

Аудит: artifact_get(AC-id) → полная цепочка до brief
```

## Правила оркестратора (GUARDRAILS)

1. **НЕ предсказывай ID задач** в промптах воркерам. Пиши «worker_next даст задачу».
2. **Wave = 4-5 задач, checkpoint между волнами.** Если одна changes_requested — стоп волна.
3. **После merge — comment_add(task_id, "merged: <sha>").** Audit trail в трекере.
4. **Main-context-coordination-only.** Не пишешь код, не редактируешь исходники — делегируешь.
5. **Проверка (checkpoint) после каждой фазы** — coverage / gaps / status перед следующей.
6. **SRS+UC параллельны** (одним сообщением, два Agent-вызова). AC — после обоих.
7. **Decision-fork / verdict / override — внутри kickstart skill** (Sign 005), не оркестратором.

## Что НЕ делать

- НЕ вызывай worker_next/worker_done сам — это зона воркеров/dispatch
- НЕ создавай задачи/эпики/артефакты руками (кроме epic/task для ролей formalization)
- НЕ пиши код/PRD/SRS/UC/AC — делегируй ролям
- НЕ запускай следующий этап пока предыдущий не done
- НЕ пропусти AC-verification (Sign 006) — это gate перед INTEGRATE

## Один скилл — весь флоу

**Пользователь:** «давай сделаем X» (идея одной фразой)
**Ты:** `Skill("saga-orchestrator")` с этой идеей
**Результат:** working product

Все роли (kickstart, product, architect, analyst, planner, worker, dispatch)
вызываются САМИ из оркестратора в правильном порядке. Пользователю не нужно
запоминать кто и когда — достаточно одной точки входа.
