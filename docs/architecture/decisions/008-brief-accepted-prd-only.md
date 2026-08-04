# ADR-008: `brief_accepted` создаёт только PRD (исправление плана 3.0)

## Status
Accepted (2026-07-18)

---

## Addendum (2026-07-20): ADR-014 supersedes part of this rationale

The original rationale used `sibling()` lookup between SRS and UC tasks spawned
in parallel by `prd_accepted`. After ADR-014 (pipeline reorder SRS after AC,
[014-pipeline-reorder-srs-after-ac.md](014-pipeline-reorder-srs-after-ac.md)),
`prd_accepted` no longer spawns SRS — it spawns only UC. The `sibling()` call
between SRS and UC is no longer needed: SRS is created later by
`baseline_accepted` (after AC + reconciliation), and there is no sibling
relationship to maintain between SRS and UC.

**Original rationale section "Why one PRD task, not parallel SRS+UC tasks"**
is preserved below for history but no longer applies: SRS is no longer a
sibling of UC. The Decision itself (`brief_accepted` creates only PRD) stands
unchanged — ADR-014 only reshapes what happens downstream of `prd_accepted`.

New pipeline (ADR-014):

```
BRIEF → PRD(+FR/NFR/RULE) → UC → AC → Reconcile → SRS(+DECOMP) → Planning → Dev → Verify → Integrate
```

See full plan: `docs/plans/PIPELINE-REORDER-SRS-AC.md`.

---

## Original Context (preserved for history)

## Context

`saga-mcp-3.0-orchestration-plan.md` §2 предписывает добавить transition
`brief_accepted`, который после завершения kickstart-задачи создаёт
**параллельно PRD + SRS** (`dependencies_on kickstart task`). План утверждён,
но буквальная реализация этой инструкции ломает существующую цепочку.

Текущая chain в `src/tools/workflow.ts`:

```
discovery.kickstart (done)
  └─ [НЕТ ПЕРЕХОДА] — кто-то должен создать formalization.prd
formalization.prd (done)
  └─ prd_accepted → SRS + UC, оба children of PRD
       (workflow.ts:84-100, deps:[source.id]=deps:[prdId])
formalization.srs или formalization.uc (done)
  └─ srs_accepted / uc_accepted → reconciliation
       workflow.ts:102-125 — srs/uc ищут друг друга через
       sibling(db, epic, source.generated_from_task_id, counterpartKind)
       workflow.ts:73-80
formalization.reconciliation (done)
  └─ baseline_accepted → planning.decomposition
       workflow.ts:127-143
```

**Противоречие.** Если `brief_accepted` создаст SRS как child of kickstart
(`generated_from_task_id = kickstartId`), а `prd_accepted` создаст UC как
child of PRD (`generated_from_task_id = prdId`), то `sibling()` при
`srs_accepted` будет искать UC с тем же parent — у SRS parent=kickstart, у UC
parent=PRD, lookup вернёт `undefined`, и `srs_accepted` бросит
`"Cannot generate reconciliation: matching formalization.uc task was not found"`
(workflow.ts:110). Эпизод останавливается, `baseline_accepted` недостижим.

Этот вывод подтверждён тремя независимыми subagent-вариантами (autonomous-decision
skill, Cynefin triage: **Complicated** — ответ выводим из кода, нужен анализ).

### Decision Drivers

- **Корректность.** Цепочка PRD→SRS+UC→reconciliation→baseline покрыта
  `tests/product-workflow.test.mjs` и работает в production (REQ-006, REQ-007).
  Менять её — ломать battle-tested путь.
- **Минимальная дельта.** План обещает «v3 не меняет v2 код». Любое решение
  должно быть аддитивным; revert — `git revert`.
- **Reversibility.** `SAGA_ORCHESTRATION_MODE=v2` должен оставаться рабочим.
  В v2 никто не создаёт `discovery.kickstart` задачу, поэтому новый
  transition — мёртвый код под флагом.

## Considered Options

### Option A — план буквально: `brief_accepted` создаёт PRD + SRS параллельно

Добавить ветку, эмитящую **два** TaskSpec; в `prd_accepted` — conditional
suppression (если SRS уже существует, эмитить только UC).

- **Pros:** точно соответствует тексту плана; suppression self-healing (no-op
  в v2).
- **Cons:**
  - **FATAL:** ломает `sibling()` lookup в `srs_accepted`
    (workflow.ts:108). SRS parent=kickstart, UC parent=PRD → reconciliation
    не генерируется.
  - Lineage corruption: SRS больше не child of PRD. Любой аудит, идущий по
    `generated_from_task_id`, получает другой граф.
  - `saga-architect` SKILL требует `artifact_list({type:'PRD'})` в in_review+
    перед стартом. Параллельный SRS (как todo) может быть задиспатчен раньше,
    чем PRD-артефакт существует → skill STOP.
  - Hidden coupling между `brief_accepted` и `prd_accepted` через существование
    строки `formalization.srs`.

### Option B — `brief_accepted` создаёт ТОЛЬКО PRD (минимальная правка)

Новая ветка в `specsForTransition` эмитит **один** spec `formalization.prd`
(mode `git_change`, exec `saga-product`, deps `:[kickstart.id]`). После
завершения PRD существующий `prd_accepted` создаёт SRS+UC как обычно.

- **Pros:**
  - Не трогает battle-tested цепочку.
  - ~15 строк дельты; revert 10 минут.
  - Идемпотентен через `generation_key`.
  - В v2 — мёртвый код.
- **Cons:**
  - План §2 буквально неверен; нужно поправить план.
  - Имя `brief_accepted` описательно неточно (не создаёт «формализационную
    волну», а только seedит PRD).
  - Не решает discovery→formalization stage transition (это работа движка
    `orchestrate.ts`, не `workflow.ts`).

### Option C — взгляд senior-инженера: «что нужно, чтобы движок работал end-to-end?»

Совпадает с B по коду (`brief_accepted` → только PRD), но явно фиксирует, что:

1. Цепочка **уже корректна** от PRD далее. Единственное, чего не хватает —
   seed: задача `formalization.prd`.
2. Сегодня в v2 PRD-задачу создаёт **вручную saga-orchestrator** (main-context
   агент, `skills/saga-orchestrator/SKILL.md:14-24`). В коде `src/`,
   `tracker-view/`, `skills/` нет ни одного `task_create` с
   `formalization.prd` (verified by grep).
3. `advanceReadyEpisodes` намеренно исключает `'discovery'` (lifecycle.ts:162),
   поэтому движок должен вызвать `episode_transition(discovery→formalization)`
   явно — иначе PRD не станет claimable (dispatcher.ts:221-228 требует
   `ew.stage=t.workflow_stage`).
4. Нужен decision-guard: kickstart может вернуть `clarify`/`reject`/`fast-track`
   (saga-kickstart/SKILL.md decision-fork). PRD seed'ится только на
   `decision === 'go'`.

## MCDA Matrix

Критерии — от AGENTS.md (внешние границы подсистем, `Result<T,Error>`, без
`unwrap`), от плана 3.0 (reversibility, v2/v3 изоляция), от CGAD-фрейма
(ADR-005: hardening существующих примитивов, не rewriting).

| Критерий | Вес | A: план буквально | B: только PRD | C: PRD + явные open-questions |
|---|---|---|---|---|
| Корректность (chain не ломается) | 5 | 1 (ломает sibling) | 5 | 5 |
| Reversibility (revert ≤ 1 commit) | 4 | 3 | 5 | 5 |
| v2 untouched under flag | 4 | 3 (правит prd_accepted) | 5 | 5 |
| Минимальная дельта строк | 3 | 2 (~25 + conditional) | 5 (~15) | 5 (~15) |
| Соответствие плану | 2 | 5 (verbatim) | 2 (поправить план) | 2 (поправить план) |
| Решает end-to-end | 4 | 2 (ломает reconciliation) | 3 (stage transition — на движке) | 5 (явно фиксирует) |
| **Взвешенная сумма** | | **44** | **81** | **87** |

## Pre-mortem на лидирующий Option C

«Option C реализован. Через 6 месяцев — провал. Что пошло не так?»

1. **Decision-guard забыли.** kickstart вернул `clarify`, движок всё равно
   породил PRD-задачу, saga-product начал писать PRD по неполным вводным.
   → **Mitigation:** в `brief_accepted` читаем brief artifact; если
   `decision !== 'go'` — не эмитим spec, логируем.
2. **Движок забыл `episode_transition`.** kickstart done → PRD создан, но
   episode в `discovery` → `worker_next` не отдаёт PRD. Зависает.
   → **Mitigation:** явно зафиксировать в плане §2.1, что `orchestrate.ts`
   (шаг 3 плана) должен вызывать `episode_transition` после `brief_accepted`.
   Это уже в архитектуре движка (orchestrate.ts §1).
3. **`repository_id = null` у PRD-задачи.** Kickstart — `tracker_only`,
   `project_repository_id` нет. PRD наследует null, git_change задача не может
   мержиться.
   → **Mitigation:** в `brief_accepted` lookup brief artifact → берём его
   `project_repository_id` (kickstart SKILL: «Bind the artifact to the
   repository containing its document»).
4. **Имя `brief_accepted` ввело в заблуждение.** Будущий maintainer ждёт, что
   transition создаёт «всю formalization-волну».
   → **Mitigation:** комментарий в коде + этот ADR; имя сохраняем ради
   совпадения с `prd_accepted`/`srs_accepted` (pattern的一致性).

## Red Team (аргумент против Option C)

«Option A вернее плану. План утверждался, в нём — `PRD + SRS параллельно`.
Реализуя Option C, агент подменяет утверждённый план своим суждением».

**Rebuttal:** План — blueprint, не договор. В его же §«Риски» сказано:
`workflow_generate_next создаёт задачи в неправильном порядке → Hard gates
блокируют переход`. Option A именно такой случай: он создаёт задачи в порядке,
ломающем существующий `sibling()` инвариант, который план не упоминает.
«Главная мысль» плана: **«Движок управляет. Агент не управляет потоком»**
(plan §231). Option C — это и есть дисциплинированное следование главной мысли:
движок управляет через существующую машину состояний, agent не плодит
параллельные ветки, ломающие lineage. Сам план в §2 явно помечен как
«(~60 строк в workflow.ts)» — это набросок, а не spec.

Победил Option C. План будет исправлен в §2 (отдельный commit, совместно с
этим ADR).

## Decision

1. **`brief_accepted` создаёт ОДНУ задачу** `formalization.prd`
   (`execution_skill: saga-product`, `review_skill:
   saga-requirements-reviewer`, `mode: git_change`, `stage: formalization`,
   `dependencies: [kickstart.id]`).
2. **decision-guard:** ветка читает brief artifact; если
   `metadata.brief_payload.decision !== 'go'` — ничего не создаётся,
   return пустой результат. `clarify`/`reject`/`fast-track` имеют свои пути
   (см. saga-kickstart SKILL decision-fork, `routeFastTrack` в
   `src/planner/fast-track.ts`).
3. **repository binding:** PRD inherits `project_repository_id` из brief
   artifact (не из kickstart-задачи, у которой он null).
4. **Stage transition — не в `workflow.ts`.** `brief_accepted` не вызывает
   `episode_transition(discovery→formalization)`. Это делает `orchestrate.ts`
   (шаг 2 плана), сразу после того как `workflow_generate_next` вернул
   created > 0.
5. **План §2 исправляется:** «brief_accepted создаёт PRD + SRS параллельно» →
   «brief_accepted создаёт только PRD; SRS+UC создаёт существующий
   prd_accepted, как сегодня». Это не отступление от плана, а исправление
   ошибки в blueprint, обнаруженной при чтении кода.

## Consequences

- **Положительные:** цепочка PRD→reconciliation не тронута; существующий тест
  `tests/product-workflow.test.mjs` остаётся зелёным без модификации; v2 под
  флагом полностью неизменён.
- **Отрицательные:** имя `brief_accepted` стало менее описательным (создаёт
  только один task); нужно поправить план и оставить ссылку на этот ADR.
- **Neutral:** движок `orchestrate.ts` обязан знать, что после
  `brief_accepted` (created > 0) надо вызвать `episode_transition`. Это
  фиксируется в плане §2 и в коде `orchestrate.ts` (шаг 2).

## Decision Journal

Дата: 2026-07-18. Решение: `brief_accepted` → только PRD.

**Ex ante expectations** (проверимы в 30/90 дней):

- **30 дней:** end-to-end smoke test water-cannon через веб-форму доходит до
  `planning` стадии (episode.stage = planning). Если зависает на
  `formalization` — забыли `episode_transition` или decision-guard.
- **90 дней:** в saga-mcp DB нет эпизодов, застрявших с ошибкой
  `"Cannot generate reconciliation: matching formalization.uc task was not
  found"` после внедрения 3.0. Если такие есть — значит вернулись к Option A
  или появилась новая цепочка, ломающая `sibling()`.
- **90 дней:** в production ни одной задачи `formalization.prd` с
  `project_repository_id IS NULL` (если только проект реально не control-repo
  only). Если есть — баг в lookup'е brief artifact.

**Check trigger:** первый end-to-end smoke-test после завершения шага 6 плана;
ретроспектива через 30/90 дней в `docs/research/`.

## References

- План: [`docs/saga-mcp-3.0-orchestration-plan.md`](../../saga-mcp-3.0-orchestration-plan.md) §2
- Код: `src/tools/workflow.ts` (`specsForTransition`, `sibling`,
  `generateNextForCompletedTask`)
- SKILL: `skills/saga-kickstart/SKILL.md` (decision-fork, brief artifact
  contract)
- Предыдущие ADR: ADR-003 (episode hard gates), ADR-005 (saga as CGAD-lite)
