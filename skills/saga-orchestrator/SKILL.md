---
name: saga-orchestrator
description: "Orchestrate one logical product from Discovery through formalization, planning, repository-scoped execution, verification, and integration. Use when the user asks to start or continue the complete Saga flow."
---

# saga-orchestrator — единый запуск saga-flow

## Typed product workflow (типизированный продуктовый рабочий процесс; REQ-007)

> **Pipeline (reordered, ADR-013).** The WHAT-side (UC + AC) runs BEFORE the
> HOW-side (SRS). Sequence:
>
> ```
> BRIEF → PRD(+FR/NFR/RULE) → UC → AC → Reconcile → SRS(+DECOMP §D) → Planning → Dev → Verify → Integrate
> ```
>
> Architectural style is chosen AFTER AC are baselined, with full visibility of
> what is being verified. Planner is a dumb copier from SRS §D2.

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

Do not independently create the right-side UC/SRS tasks — the engine's
`workflow_generate_next` does that from typed transitions:
`brief_accepted`→PRD, `prd_accepted`→UC (only UC, NOT SRS+UC parallel),
`uc_accepted`→AC, `ac_accepted`→reconciliation, `baseline_accepted`→SRS,
`srs_accepted`→planning.decomposition. For typed `git_change` work, review
approval produces `integration_state=pending`; only
`worker_merge_release(result:"merged")` releases dependencies and triggers
idempotent downstream generation. `done` without merge is not accepted input
for the next stage.

Use explicit checkpoints:

```text
formalization -> planning: PRD(+FR/NFR/RULE) + UC + AC accepted and
                            hash-pinned; reconciliation done; SRS accepted
                            (architect chose style after seeing AC; §D2 written)
planning -> development: completed planning tasks (planner copied §D2)
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

## Flow position (saga-flow — позиция в потоке)

- **Stage (этап):** ЕДИНАЯ ТОЧКА ВХОДА (весь флоу, от идеи до working product — работающего продукта)
- **Precondition (предусловие):** Идея от пользователя одной фразой. saga-mcp подключен. skills/agents установлены.
- **Postcondition (постусловие):** Working product (Docker/код) + все artifacts accepted (приняты) + 0 coverage gaps (пробелов покрытия: implements + verified_by)
- **Called by (вызывается):** Пользователь напрямую (`Skill("saga-orchestrator")`)
- **Next enables (что разблокирует):** ничего (терминальная роль — отдаёт результат пользователю)
- **Вызывает:** saga-kickstart → saga-product → saga-analyst (UC) → saga-analyst (AC) → saga-reconciler → saga-architect (SRS) → saga-planner → saga-dispatch (с роем saga-worker) → AC-verification → INTEGRATE
- **Main-context-coordination-only (только координация в главном контексте):** НЕ пишет код/PRD/SRS — только оркестрирует роли.

Ты — оркестратор saga-flow. **Твоя единственная работа — запускать роли в
правильном порядке и ждать результаты.** Ты НЕ пишешь код, НЕ пишешь PRD/SRS,
НЕ создаёшь задачи руками. Ты координируешь.

## Главное правило (одно на всю сессию)

**Пользователь дал идею одной фразой → ты прогоняешь весь флоу → отдаёшь
working product.** Между ними — вызовы ролей. Каждая роль — отдельный Agent
или Skill. Ты их чейнишь.

## Состав ролей (что вызывает оркестратор)

> **Reordered pipeline (ADR-013).** SRS moved AFTER AC. Planner is now a dumb
> copier. Architect reads the frozen AC and the brief's `complexity.tshirt` to
> choose a style from the complexity→architecture table.

| Фаза | Кто | Как вызывает | Что делает |
|---|---|---|---|
| 1. Discovery | saga-kickstart | **Skill("saga-kickstart") в main-context** (НЕ subagent — Sign 005) | идея → brief (+ `complexity.tshirt`, `topology_hint`, `shared_mutation_risk`) → decision |
| 1.5. Complexity Gate | senior-analyst (ref) + orchestrator | `Skill("senior-analyst")` в main-context | `complexity.tshirt` → artifact-set decision; `topology_hint` → hints architect's later style choice |
| 2. Formalization-PRD | saga-product | Agent(subagent_type:"saga-product") | brief → PRD(+ FR/NFR/RULE children) |
| 3. Formalization-UC (WHAT part 1) | saga-analyst | Agent(subagent_type:"saga-analyst") | PRD → UC (`derived_from` PRD, `covers` ≥1 FR) |
| 4. Formalization-AC (WHAT part 1) | saga-analyst | Agent(subagent_type:"saga-analyst") | UC + PRD(FR/NFR/RULE) → AC |
| 4.5. Reconcile | saga-reconciler | через engine (`ac_accepted` transition) | freeze AC baseline_hash, repair traces |
| 5. Formalization-SRS (HOW part 2) | saga-architect | Agent(subagent_type:"saga-architect") | frozen AC + brief complexity → SRS §2.1 style (по таблице) + §2b Ports + §2.3 Invariants + **§D Decomposition** |
| 6. Planning | saga-planner | Agent(subagent_type:"saga-planner") | SRS §D2 → dev/verification/spike tasks (dumb copier) |
| 7. Execution | saga-worker (рой) | Agent(subagent_type:"saga-worker") ×N | dev-задачи → код → review → merge |
| 8. AC-verification | saga-verifier / saga-worker (role:reviewer) | через dispatch loop | сверка эталонов AC с кодом |
| 9. Integration | saga-worker | через dispatch loop | финальный merge + smoke |

## Алгоритм (строго по этапам)

### Подготовка

```
0. BEFORE spawning any subagent, check if the Agent tool / subagent_type
   spawning is available in this harness. If it is NOT available, switch to
   inline mode for the whole flow (see "Inline mode" below). Decide once,
   up front — do not improvise per-role.
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

### Этап 1.5 — Complexity Gate (saga-orchestrator main-context)

After Discovery (brief accepted), BEFORE Formalization:

1. Load `Skill("senior-analyst")` reference into main context.
2. Read brief: complexity.tshirt, risk_triggers, affected_projects, classification.
   Also note `topology_hint` and `shared_mutation_risk` — these hint the
   architectural style the architect will later choose (see table in §2.3 of
   the reorder plan / saga-architect SKILL).
3. Classify: thin / modular / regulated / research.
4. Decide artifact set: which types does THIS project need?
5. Create a `decision` artifact recording the artifact set:
   ```
   artifact_create({ type:'decision', title:'Artifact set for REQ-NNN',
     path:'docs/.../artifact-set.md', status:'accepted',
     metadata: { complexity_class: 'modular', artifacts: ['PRD','FR','NFR','RULE','UC','AC','SRS','SPEC','hypothesis'],
                 complexity_tshirt: 'M', topology_hint: 'scaffold-then-parallel' } })
   ```
6. Pass artifact set to downstream skills:
   - saga-product: "create PRD with FR/NFR/RULE children (complexity=modular)"
   - saga-analyst: "create UC + AC from PRD (the WHAT side, BEFORE SRS)"
   - saga-architect (LATER, after AC): "create SRS with style per complexity table (complexity=M, topology_hint=scaffold-then-parallel → Modular Monolith + Ports, Pattern B); include §D Decomposition"

Rules:
- For thin (XS-S, no risk triggers): skip hypothesis, skip RULE, minimal SRS.
- For modular: full set — hypothesis + RULE + SPEC + Invariant Registry.
- For regulated: add DR + IR + CONSTRAINT + RISK (create as artifacts).
- For research: brief → decision → OQ only. No PRD/SRS/AC.
- The decision artifact IS the authority — downstream skills read it and know their scope.
- `complexity.tshirt` + `topology_hint` are read LATER by saga-architect to
  pick the style. They are recorded in the brief (saga-kickstart writes them)
  and surfaced through this decision artifact's metadata.

### Этап 2 — PRD (saga-product, with FR/NFR/RULE children)

```
create task role:product (PRD)
spawn Agent(subagent_type:"saga-product", prompt с brief artifact_id + project_id + epic_id + complexity hint)
WAIT until PRD is done and, for git_change, integration_state=merged

CHECKPOINT: PRD MUST have FR/NFR/RULE children registered
  artifact_list({epic_id, type:'FR'})   → ≥1
  artifact_list({epic_id, type:'NFR'})  → ≥1 (if any capacity targets)
  artifact_list({epic_id, type:'RULE'}) → ≥1 (if any business rules)
If FR list is empty → STOP, saga-product did not finish.
```

### Этап 3 — UC (saga-analyst, WHAT side, AFTER PRD only — no SRS dep)

```
create task role:analyst (UC)
spawn Agent(subagent_type:"saga-analyst", PRD(+FR/NFR/RULE) → UC)
WAIT until UC done

CHECKPOINT: every UC traces `derived_from` → PRD and `covers` → ≥1 FR
  artifact_coverage({epic_id, type:'UC', link_type:'derived_from'}) → 0 gaps
  (FR are children of PRD — UC links to the FR artifact id directly.)
```

SRS is NOT started yet. UC runs straight from PRD.

### Этап 4 — AC (saga-analyst, WHAT side, AFTER UC only — no SRS dep)

```
create task role:analyst (AC)
spawn Agent(subagent_type:"saga-analyst", UC + PRD(FR/NFR/RULE) → AC)
WAIT until AC done

VERIFY: artifact_coverage(type:'AC', epic_id, link_type:'derived_from') → 0 gaps
VERIFY: every AC is accepted, hash-pinned and drift_state=clean
```

SRS is STILL not started. AC is written from the PRD's FR/NFR/RULE + UC.

### Этап 4.5 — Reconciliation + Baseline freeze (engine-driven)

```
ac_accepted transition fires → engine spawns formalization.reconciliation task
saga-reconciler runs → repairs traces, accepts draft artifacts, stamps baseline_hash
baseline_accepted transition fires → engine spawns formalization.srs task
```

The AC baseline is now frozen. This is the input the architect needs.

### Этап 5 — SRS (saga-architect, HOW side, AFTER baseline)

```
create task role:architect (SRS) via baseline_accepted transition
spawn Agent(subagent_type:"saga-architect",
            frozen AC + brief complexity.tshirt/topology_hint → SRS)
WAIT until SRS done

CHECKPOINT: SRS §2.1 style matches the complexity→architecture table
  (e.g. M/sequence → Modular Monolith; M/scaffold-then-parallel → Modular
  Monolith + Ports; L/scaffold-then-parallel → Hexagonal)
CHECKPOINT: SRS §D Decomposition present
  §D1 File Tree, §D2 AC→Implementation Map, §D3 Priority, §D4 Pattern
CALL: episode_transition({epic_id, to_stage:"planning"})
  (this gate now requires PRD+UC+AC+SRS all accepted, traces complete)
```

### Этап 6 — Planning (saga-planner, dumb copier)

```
srs_accepted transition fires → engine spawns planning.decomposition task
spawn Agent(subagent_type:"saga-planner", SRS §D2 → tasks)
WAIT until planner done

VERIFY:
  artifact_coverage(type:'AC', link_type:'implements')  → 0 gaps (структурно)
  tasks have metadata.target_file / files / functions / types / public_protocol
    (copied from §D2 — if missing, planner did not copy faithfully)
  verification.ac tasks created for every §D2 entry with ac_kind=verification
  scaffold tasks present for clusters where §D4 chose Pattern B

  # REQ-010 — semantic conflict detection (after planner, before development)
  for each dev task: conflict_keys_auto_derive({task_id})
  conflict_check({epic_id})  → collision_count должен быть 0, либо каждый
                                collision разрулен (scaffold / depends_on /
                                scope split). R5 в lint потом это проверит.
CALL: episode_transition({epic_id,to_stage:"development"})
```

> **Note.** The planner no longer chooses Pattern A/B or priority — the
> architect encoded those in §D3/§D4. If you see the planner inventing these,
> that is a regression; flag it.

> **REQ-013 / CGAD-R4.** Если эпизод greenfield с ≥2 параллельными
> dev-задачами, разделяющими модуль, и нет scaffold-задачи — R4 заблокирует
> переход в development. Architect должен был выбрать Pattern B в §D4 для
> этого кластера; planner скопировал scaffold-задачу из §D2. См.
> saga-planner SKILL.md «Step 2».

> **REQ-010 / CGAD-R5.** Если ≥2 активные задачи делят conflict-key —
> collision обнаруживается здесь, до запуска воркеров. 3+ коллизующихся
> задач или любая коллизия с ≥2 in-flight → error (scaffold обязателен).

### Этап 7 — Execution (рой saga-worker через saga-dispatch)

```
Skill("saga-dispatch")  ← цикл диспетчеризации
  ↓ dispatch сам:
    - worker_next → Agent(saga-worker) ×N параллельно
    - rounds пока очередь не пуста
    - solo-worker review + merge в каждом раунде

WAIT until queue empty (task_list todo+review = 0)
CALL: episode_transition({epic_id,to_stage:"verification"})
```

### Этап 8 — AC-verification (через тот же dispatch)

```
Продолжаем dispatch — verification.ac задачи (role:reviewer, tag:ac-verification,
created by planner from §D2 entries with ac_kind=verification)
выполняются автоматически в следующих раундах.

VERIFY after:
  verification_record contains passing evidence for each accepted AC hash
  artifact_coverage(type:'AC', link_type:'verified_by') → 0 gaps
CALL: episode_transition({epic_id,to_stage:"integration"})
```

### Этап 9 — Integration (финальный)

```
Если есть INTEGRATE задача (Pattern B из §D4) → выполнить через dispatch
VERIFY: post-merge build green, все задачи done
CALL: episode_transition({epic_id,to_stage:"completed"})
```

### Этап 9.5 — Post-integration: документация и продуктовые скиллы

После Integration, ДО объявления финального отчёта — оркестратор создаёт
продуктовую документацию и проектные скиллы. Это делает продукт
**поставляемым**, а не просто «код слит в dev».

#### 9.5a — README продукта

Создать `README.md` в корне продукта. Содержание:
- **Быстрый старт** — одна команда запуска (из SRS §9 technology_stack)
- **Что это** — один абзац (из PRD §1 problem & value)
- **Установка** — зависимости, команды сборки (из SRS §9)
- **Тестирование** — как запустить тесты (из SRS §2.5 test strategy)
- **Архитектура** — стиль, модули, инварианты (из SRS §2.1-2.3)
- **Метрика гипотезы** — что измеряем, target, kill criteria (из PRD §4)
- **Стек технологий** — язык, фреймворки, инструменты (из SRS §9)

Если продукт многоязычный — создать также `README.ru.md`.

#### 9.5b — Продуктовые скиллы

Создать проектные скиллы в `.saga/skills/` продукта:

**`.saga/skills/<product>-release/SKILL.md`** — чеклист релиза продукта:
- Все тесты green
- Lint проходит (из SRS §9: mypy/eslint/clippy)
- Build successful
- README актуален
- Метрика гипотезы может быть измерена (observation infra готова)
- Version bump + tag

**`.saga/skills/<product>-qa/SKILL.md`** — процедура QA продукта:
- Как запустить (из README)
- Что проверить вручную (UI, edge cases не покрытые AC)
- Как записать observation (observation_record)
- Критерии приёмки релиза (из AC документа)

#### 9.5c — Инструкция запуска

Создать `INSTALL.md` или секцию в README:
```bash
# Минимальный запуск (из SRS §9)
<install_deps_command>
<build_command>
<run_command>
```

Конкретные команды берутся из SRS §9 technology_stack:
- `language: python` → `pip install -r requirements.txt && python main.py`
- `language: typescript` → `npm install && npm run build && npm start`
- `language: rust` → `cargo build --release && ./target/release/<binary>`

#### 9.5d — Регистрация в saga DB

Создать artifacts для документации:
```
artifact_create({ type:'decision', title:'Product README + skills for REQ-NNN',
  path:'README.md', status:'accepted',
  metadata: { deliverables: ['README.md', 'INSTALL.md', '.saga/skills/<product>-release', '.saga/skills/<product>-qa'] } })
```

### Финальный отчёт пользователю

```
✅ saga-flow завершён для REQ-NNN

Discovery:    brief (artifact N), decision=go, complexity=<tshirt> topology=<hint>
Formalization (WHAT):
              PRD(N) + N FR + N NFR + N RULE → UC(N) → AC(N)
              Baseline: frozen AC hash (artifact N)
Formalization (HOW):
              SRS(N) — style <Modular Monolith / Hexagonal / KISS> per complexity table
              §D2: <N> AC entries (impl=X, verify=Y, spike=Z, merge=W)
              Hypothesis: HYP-1 metric=X target=Y kill=Z
Planning:     N dev-задач (Pattern from §D4), 0 coverage gaps on implements
              conflict_check: 0 collisions (или N разруленных вручную)
              final_risk: max(declared, derived, policy) per task
Execution:    N задач done, 0 конфликтов
AC-verify:    all verified_by пройдены (4-valued: passed)
Integration:  merged в dev
Post-integration:
              README.md создан (быстрый старт, стек, метрика)
              INSTALL.md создан (команды запуска из SRS §9)
              .saga/skills/<product>-release/SKILL.md (чеклист релиза)
              .saga/skills/<product>-qa/SKILL.md (процедура QA)
Runtime obs:  (если есть) observation_record benchmark/canary/incident
Product:      <путь/URL> — working, документирован, имеет релизный чеклист

Аудит: artifact_get(AC-id) → полная цепочка AC→UC→FR→PRD→brief
       cgad-spec-lint: N rules, 0 error-severity findings на этом эпизоде
```

### REQ-009 — RiskClass aware orchestration

`task_create` и `task_update` автоматически вычисляют `final_risk = max(declared,
derived, policy_minimum)`. Оркестратору не нужно ничего считать — но нужно:

1. **Не понижать risk чтобы пропустить проверки.** CGAD P15. Если задача
   security-tagged, её `final_risk` автоматически поднимется до critical;
   попытка поставить `declared_risk='low'` не поможет (max() всё равно
   даст critical). Lint R2 это ловит.
2. **Human gate на critical.** Если episode достиг стадии development с
   critical-risk задачей без human approval — это блокер. Подними вопрос
   пользователю до запуска роя.
3. **High-blast-radius задачи** (data, migration, public API) получают
   `derived_risk='high'` автоматически через теги или task_kind.

## Inline mode (инлайн-режим: когда subagent spawning недоступен)

**Detection (step 0 of Подготовка).** Before spawning any subagent, check
whether the `Agent` tool / `subagent_type` spawning is actually available in
the current harness. In ZCode's harness only the read-only `Explore` subagent
typically exists; writable `saga-*` subagent types usually do **not**. If
`Agent(subagent_type:"saga-*")` is unavailable (or would be read-only and
therefore unable to write artifacts/PRD/SRS/UC/AC), switch the **entire** flow
to inline mode. Decide this once, up front — never improvise a mixed mode.

**Inline execution.** In inline mode you invoke each role skill **inline in the
main context** via the `Skill` tool — the same role skills, in the same order,
just sequentially rather than in parallel subagents:

```text
Skill("saga-kickstart")    → decision (with complexity.tshirt, topology_hint)
Skill("saga-product")      → PRD (+ FR/NFR/RULE children)
Skill("saga-analyst")      → UC                       } WHAT side
Skill("saga-analyst")      → AC                       } WHAT side (no SRS dep)
Skill("saga-reconciler")   → freeze baseline (engine-driven, may auto-run)
Skill("saga-architect")    → SRS (+ §D Decomposition) } HOW side, AFTER AC baseline
Skill("saga-planner")      → dev + verification tasks (dumb copier from §D2)
Skill("saga-dispatch")     → worker loop, review, merge
```

The roles are **sequential** (the parallelism opportunity between UC and SRS is
gone — SRS now needs frozen AC, so it cannot start until AC is done). Run in
the order above. Everything else (checkpoints, `episode_transition`,
`artifact_coverage` gates, `conflict_check`, merge protocol) is identical to
the algorithm above.

**Flag the degradation.** Inline mode is non-parallel, so it is a degraded
run and must be marked, not silent (NFR-5 of saga-kickstart: "no silent
degraded pass"). Do one of:

- record a note via `note_save({ note_type: "context", title: "orchestration: inline mode", content: "subagent spawning unavailable; roles ran sequentially in main context", related_entity_type: "epic", related_entity_id: <epic_id> })`, **and/or**
- when the upstream `saga-kickstart` brief carries `degraded: true` (its own
  F1 failover for the decision-fork's 3 assessors — see saga-kickstart
  "Decision-fork §(b)" and Failover-table row F1), propagate the flag by
  noting it alongside this epic.

Every inline run must be grep-observable for `degraded` / `inline mode` so an
auditor can tell parallel and sequential orchestrations apart.

**Relationship to saga-kickstart degraded mode.** The kickstart skill already
handles its own no-subagent case for the decision-fork's three assessors
(Decision-fork §(b) "Субагенты недоступны → degraded-режим" + Failover-table
row F1, marker `FAILOVER: assessors unavailable → degraded=true`). This
orchestrator inline mode is the analogous fallback for the **formalization,
planning, and execution roles**. The two compose cleanly: if the harness has no
subagents at all, kickstart runs its assessor fallback AND the orchestrator
runs every downstream role inline — the whole flow stays in one main context.

**Do not** attempt `Agent(subagent_type:"saga-*")` calls once you have switched
to inline mode for the flow — that is exactly the fragile improvisation this
section replaces. Conversely, if subagent spawning becomes available
mid-session, finish the current epic inline rather than mixing modes.

## Правила оркестратора (GUARDRAILS)

1. **НЕ предсказывай ID задач** в промптах воркерам. Пиши «worker_next даст задачу».
2. **Wave = 4-5 задач, checkpoint между волнами.** Если одна changes_requested — стоп волна.
3. **После merge — comment_add(task_id, "merged: <sha>").** Audit trail в трекере.
4. **Main-context-coordination-only.** Не пишешь код, не редактируешь исходники — делегируешь.
5. **Проверка (checkpoint) после каждой фазы** — coverage / gaps / status перед следующей.
6. **Pipeline order (reordered, ADR-013):** PRD → UC → AC → Reconcile → SRS → Planning. UC and AC are NOT parallel with SRS — SRS waits for the AC baseline. In inline mode every role is sequential in the order above.
7. **Decision-fork / verdict / override — внутри kickstart skill** (Sign 005), не оркестратором.
8. **Architect reads complexity from brief** (Stage 1.5 decision artifact metadata) to pick the SRS §2.1 style from the complexity→architecture table. The orchestrator does NOT override the architect's style choice.
9. **Planner is a dumb copier.** If you see the planner inventing files/functions/pattern/priority instead of copying from §D2, that is a defect — flag it. The architect owns §D.

## Delegation discipline (EXT-1 superpowers, adapted)

<!-- source: EXT-1 https://github.com/obra/superpowers — subagent-driven-development.
     We adopt its delegation *discipline* (fresh worker per task, curated context,
     explicit result-return). We do NOT adopt its phase names, model-tier selection,
     or parallel dispatch — those are reconciled against CGAD below. -->

Each role spawn (saga-product, saga-analyst, saga-architect, saga-planner,
saga-worker) is **one task delegated to one subagent with a result-return
obligation**. The full one-page contract lives in
[`delegation-contract.md`](./delegation-contract.md). The binding summary:

- **One task = one launch = one result.** A worker that finishes calls
  `worker_done` and exits; the dispatch loop claims the next task for a fresh
  worker. Never bundle two tasks, never let a worker self-claim a second.
- **Result-return obligation** — exactly one of these fires before the launch
  closes: `worker_done(verdict:"approved"|"changes_requested")` (work done),
  `worker_ask_need` (blocked, **terminal** — do not wait for a result), or the
  engine terminalizes a crashed/timed-out execution. There is no "keep going
  and grab more tasks" outcome.
- **Done ≠ integrated.** For typed `git_change` tasks, `worker_done` only sets
  `integration_state=pending`; the stage checkpoint needs
  `worker_merge_release(result:"merged")` to release dependents.
- **Curate, don't restate.** Hand the worker *where this task fits* (one line)
  and *where to read its requirements* (the task + its `source_artifact_ids`),
  not a restatement of the spec. The worker reasons from the accepted AC/SRS,
  not from the orchestrator's memory.
- **No self-authorization, no gagged reviewers.** The orchestrator proposes
  (dispatches); the worker proposes (`worker_done`); the engine + evidence +
  (critical risk) the human decide. Never instruct a reviewer to ignore a
  finding — let the review loop raise it and adjudicate via verdict/comment.
- **Durable progress = the tracker.** After any context loss, trust
  `task_list` + `episode_status` + `artifact_coverage` + `git log` over your
  own recollection. Re-dispatching a task already marked `done`/`merged` is
  the most expensive orchestrator failure — read `task_list` first.

This reinforces the CGAD guardrails above; it does not replace `worker_next` /
`worker_done` or rename any episode stage.

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
