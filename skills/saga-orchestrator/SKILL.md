---
name: saga-orchestrator
description: Единый launch saga-flow от идеи до working product. Один скилл — весь
  конвейер: Discovery → Formalization → Planning → Execution → AC-verification →
  Integration. Сам вызывает все остальные saga-роли в правильном порядке. Использовать
  когда пользователь говорит «запусти флоу», «давай сделаем», дал идею одной фразой.
  НЕ делать работу сам — только оркестрировать роли.
---

# saga-orchestrator — единый запуск saga-flow

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
1. project_id = project_resolve_by_name({ name: <из projectname.txt> })
2. epic_id = epic_create({ project_id, name: "REQ-NNN-<slug>" })  ← если нет
3. Запомни project_id, epic_id — они нужны всем ролям
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
WAIT until PRD done
```

### Этап 3 — SRS + UC (параллельно!)

```
create task role:architect (SRS)
create task role:analyst (UC)

spawn ОБА параллельно (одним сообщением, два Agent-вызова):
  Agent(subagent_type:"saga-architect", SRS + API contract)
  Agent(subagent_type:"saga-analyst", UC)

WAIT until ОБА done (parallel completion)
```

**Контрольная точка (checkpoint):** после SRS+UC проверь, что FR готовы
(architect их создаёт). Если FR нет — стоп, architect не закончил.

### Этап 4 — AC (saga-analyst)

```
create task role:analyst (AC)
spawn Agent(subagent_type:"saga-analyst", UC+SRS → AC)
WAIT until AC done

VERIFY: artifact_coverage(type:'AC', epic_id) → 0 gaps на traces covers/derived_from
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
```

### Этап 6 — Execution (рой saga-worker через saga-dispatch)

```
Skill("saga-dispatch")  ← цикл диспетчеризации
  ↓ dispatch сам:
    - worker_next → Agent(saga-worker) ×N параллельно
    - rounds пока очередь не пуста
    - solo-worker review + merge в каждом раунде

WAIT until queue empty (task_list todo+review = 0)
```

### Этап 7 — AC-verification (через тот же dispatch)

```
Продолжаем dispatch — AC-verification задачи (role:reviewer, tag:ac-verification)
выполняются автоматически в следующих раундах.

VERIFY after:
  artifact_coverage(type:'AC', link_type:'verified_by') → 0 gaps (содержательно)
```

### Этап 8 — Integration (финальный)

```
Если есть INTEGRATE задача (Pattern B) → выполнить через dispatch
VERIFY: post-merge build green, все задачи done
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
