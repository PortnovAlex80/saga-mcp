# DRAGON-MAP — карта поедания завода saga4 (мозг первым, обёртка потом)

> **Английский промпт для нового дракона: `DRAGON-PROMPT.md`** (копипастнуть целиком).
> Эта карта — авторитетный маршрут; промпт — инструкция как её есть и чего не трогать.

> Карта для нового агента-«дракона». Цель: понять завод **как инженер** — как он
> устроен, как его запускать, как читать существующие цеха и как создавать новые.
> Порядок принципиален: сначала ум (архитектура + домен + ядро исполнения),
> потом мышцы (композиция/запуск), потом кожа (MCP-инструменты, SQLite-адаптеры,
> UI, тесты). Всё, что не указано в этапах 0–5, — обёртка, её глотать по нужде.
>
> Оценка «мозга» (этапы 0–5): ~24 000 строк ≈ 200–280 тыс. токенов.
> Обёртка (этап 6+): ещё ~95 000 строк — есть только по мере надобности.

## Правила глотания

1. **Этапы 0→5 строго по порядку.** Каждый этап опирается на предыдущий.
2. После каждого этапа прогоняй себя по «Законам завода» (конец файла).
   Не понял закон — вернись, не иди дальше.
3. Домен (этап 1) читается целиком — это ~3 400 строк чистых инвариантов без I/O.
4. В коде ядра комментарии — половина ума. Не пропускай их: здесь комментарий
   объясняет ИНВАРИАНТ, а не очевидное.
5. Файлы >2000 строк (`schema.ts`, `production-cell-node-executor.ts`,
   `generic-flow-executor.ts`) глотать за 2–3 присеста, без пропусков.

---

## Этап 0 — Ум: ментальная модель (~3 700 строк, читать ДО кода)

| Порядок | Файл | Строк | Что даёт |
|---|---|---|---|
| 1 | `ARCHITECTURE.md` | 125 | Скелет в 6 абзацах: одна точка старта, владения рантайма |
| 2 | `docs/architecture/CONVEYOR-MENTAL-MODEL.md` | 1456 | **Архитектурный компас.** Production Cell, replay-first, эффекты, dual-cycle, §27 фитнес-функции |
| 3 | `docs/architecture/FACTORY-DOMAIN-ACCEPTANCE-REGISTRY.md` | 888 | **Словарь завода.** REG-01..29 (Workplace, CandidateSet, GateRun…), PROC-01..17, E2E-сценарии. Глоссарий, к которому привязан весь код |
| 4 | `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md` | 1021 | **Главный диагноз.** Почему владелец материала — WorkplaceProductionRevision, а WorkerExecution — только provenance. Без этого код ядра не читается |
| 5 (опц.) | `docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md` + `CONVEYOR-TRANSITION-CHECKLIST.md` | 332 | Универсальная диагностика «почему не едет» |

Культурный контекст (обязательно, коротко): `AGENTS.md` —
правило «читай ADR-053 перед стабилизационным фиксом».

## Этап 1 — Доменное ядро: инварианты без I/O (~3 400 строк)

`src/process-modules/domain/` — чистые типы + редьюсеры. Порядок:

1. `workplace/workplace-ref.ts` (190) — идентичность рабочего места:
   `(processRunId, moduleRef, productionCellId, workKey)`. НИКОГДА не содержит execution.
2. `workplace/workplace-state.ts` (402) — **двухканальная машина**: Kanban-фаза ×
   loop-state, закрытая таблица разрешённых пар (REG-28).
3. `workplace/production-cell-reducer.ts` (372) — чистый редьюсер всех переходов
   ячейки. Это грамматика завода.
4. `workplace/workplace-production-revision.ts` (478) — **сердце ADR-053**:
   Contribution → Revision, materialDigest/semanticDigest, partition invariance
   (X+Y ≡ X-then-Y).
5. `workplace/candidate-set.ts` (331) — seal key = (workplace, revision, role,
   +subject для reviewer). Execution-идентичность запрещена.
6. `workplace/gate.ts` (512) — CheckPlan / CheckProvider / CheckReceipt /
   GateRun / GateDecision. Только GateDecision двигает ячейку.
7. `workplace/production-cell-definition.ts` (253) — **как объявляется цех**
   (декларация ячейки: контракты, гейты, recovery, transitions) + desync-firewall.
8. `workplace/execution-reservation.ts` (171) — наряд: (workplace, role, revision).
9. `workplace/accepted-authority-head.ts` (116) — C1/C5: точный указатель
   «текущий принятый автор» (+carry-forward-safe task id).
10. `transition-obligation.ts` (128) — бренды CausalSourceRevision ≠ LeaseFence.
11. `process-module.ts` (335) — ProcessModuleDefinition/FlowDefinition/профили,
    kind='production-cell' как первоклассный узел.
12. `recovery.ts` (122) + `workplace/recovery-issue-target.ts` (155) — брак-лист.

## Этап 2 — исполнительное ядро: как движок гоняет домен (~7 800 строк)

`src/process-modules/application/`, порядок «от кнопки к материалу»:

1. `production-cell-coordinator.ts` (510) — применяет редьюсер через CAS;
   атомарная запись authority-head при accept (ADR-053 C1/C5).
2. `gate-run-driver.ts` (332) — one-shot GateRun: digest провайдера, ординал
   чека, полный decision digest, replay терминального решения.
3. `node-executor.ts` (337) — контракты NodeExecutionContext/Result (словарь).
4. **`node-executors/production-cell-node-executor.ts` (2073) — МОНСТР №1.**
   Реконсилятор ячейки: материализация → admit → verifying → seal revision +
   CandidateSet + obligation в ОДНОЙ транзакции → gate → эффекты →
   FinalAcceptance + replay-capture → repair/carry-forward. Читать целиком.
5. `node-executors/kernel-node-executor.ts` (44) + `human-node-executor.ts` (31).
6. **`generic-flow-executor.ts` (1608) — МОНСТР №2.** Walkер Flow: NodeRun-чекпойнты,
   crash-resume, recovery-loop (verify→repair с feedback), v2-конверты,
   settlement → сертификат → onProcessSettled.
7. `lifecycle-orchestrator.ts` (872) — этапы, лизы, outcomeRoutes (декларативный
   роутинг), handoff-фрейм, transition budget.
8. `lifecycle-router.ts` (173) + `lifecycle-mapper.ts` — роутинг/маппинг значений.
9. `transition-obligation-integrator.ts` (174) + `transition-obligation-reconciler.ts`
   (242) — 6 durable handoff'ов (см. Законы №6).
10. `execution-context-assembler.ts` (447) — immutable-конверт исполнения + пины пакета.
11. `post-acceptance-effects.ts` (216) + `standard-check-providers.ts` (156) —
    реестры эффектов/проверок (Git-интеграция, replay-capture, product-contract).
12. `production-ingress-contract.ts` (78) + `production-source-adapters.ts` (68) —
    единственный ingress: frozen WorkIntent → canonical ProductRefs (ADR-067).
13. `workshop-capability-manifest.ts` (471) — единый манифест payload-контрактов
    для orchestrator + worker MCP (ADR-053 Phase 1).

## Этап 3 — Композиция и запуск: как завод включается (~7 500 строк)

1. `src/orchestrate-cli.ts` (714) — **главный цикл движка**: launch-ref →
   controller-lease → runEpisode ↔ distributeQueuedTasks ↔ supervision;
   paused≠terminal, exit codes 0/1/2.
2. `src/app/composition-root.ts` (497) — ОДНА точка спавна: WorkAssignmentPort +
   WorkerExecutorFactory + route resolver.
3. `src/app/product-lifecycle-runtime.ts` (1051) — сборка всего: репозитории,
   ProductionCellNodeExecutor, obligation-reconciler в составе engine,
   регистрация четырёх цехов, resolversBySchema.
4. `src/app/dispatch-loop.ts` (300) — диспетчер: admission = min(operator, model),
   yield-to-kernel, durable-terminal fail-safe.
5. `src/app/factory-start.ts` (1690) — decode start-команды + ВСЕ операторские
   recovery: orphaned launch, missing product, failed gate, paused submission,
   worker-loss.
6. `src/app/start-product-lifecycle-from-idea.ts` (280) +
   `product-lifecycle-run-starter.ts` (264) — идея → валидированный input →
   launch ticket → спавн движка с receipt-подтверждением.
7. Хвосты: `automatic-pre-spawn-recovery.ts` (211), `engine-start-adoption.ts` (146),
   `factory-continuation.ts` (295), `factory-release-continuation.ts` (127),
   `orchestration-idle-state.ts` (72).
8. **Операторская сторона:** `ЗАВОД-ЗАПУСК.md` (517) — 4 режима запуска, LM Studio,
   гонка первого claim, правила безопасности; `docs/FACTORY-START-QUICKSTART.md`
   (513) — factory.mjs start/resume/continue, checkpoint-restore, мониторинг §7a.
9. `scripts/factory.mjs` — единственный публичный CLI (start/resume/continue).

## Этап 4 — Схема данных: конституция БД (~4 200 строк)

1. `src/db.ts` (215) — версия схемы (сейчас 10), WAL, busy_timeout 5с, миграции.
2. **`src/schema.ts` (3134) — МОНСТР №3.** Все таблицы. Ключевые семейства:
   - трекер-проекции: `tasks`, `artifacts`, `traces`, `worker_executions`;
   - Workplace-авторитет: `factory_workplaces` (+graphs/dependencies),
     `factory_workplace_production_revisions` (UNIQUE material digest),
     `factory_candidate_sets` (partial unique author/reviewer),
     `factory_gate_runs/decisions/check_receipts`, `factory_accepted_authority_head`,
     `factory_cell_final_acceptances`, `factory_effect_receipts`;
   - `factory_transition_obligations` (fence vs lease_fence);
   - continuation/carry-forward/adoption (append-only, триггеры immutability);
   - `factory_launch_requests` + controller terms/leases (epoch fencing);
   - всё важное — под `BEFORE UPDATE/DELETE … RAISE(ABORT)`.
3. `src/types.ts` (215) + `src/worker-executions.ts` (601, supervision/reaper).

## Этап 5 — Цеха: читать существующие, создавать новые (~4 700 строк)

**Порядок чтения цехов** (от простого к сложному):
`discovery` (215+442) → `delivery` (326+345) → `formalization` (380+372) →
`development` (557+319 + continuations 206+128).

1. `src/process-modules/lifecycles/product-delivery-lifecycle.ts` (505) — полная
   цепочка 4 цехов + input/output mapping + outcomeRoutes;
   `product-build-lifecycle.ts` (39) — MVP-вариант (терминал runnable-local).
2. `src/process-modules/modules/<workshop>/<workshop>-process-module.ts` —
   FlowDefinition: узлы, transitions, профили, recovery-политики.
3. `src/process-modules/modules/<workshop>/package/manifest.ts` — packageManifest:
   ресурсы, skills, чеклисты, схемы → content-addressed digest.
4. `src/process-modules/domain/spi/module-manifest.ts` (395) +
   `node-protocol.ts` (296) — валидируемые SPI-формы пакета.
5. **Минимальный эталон пакета:** `modules-ext/external-seo/` (~15 маленьких
   файлов) — External-узел на чистом SPI, ноль правок рантайма.

**Рецепт «создать новый цех» (проверено external-seo и WAVE10):**
1. ProcessModuleDefinition: identity, input/outputContract, outcomes, flow.
2. Ячейки = узлы kind='production-cell' с inline ProductionCellDefinition:
   inputSelectors, materialization (workKeySelector, completionPolicy),
   author profile, productContracts (+payloadContract с digest),
   authorGate/finalGate CheckPlan (provider refs + digest), review?, recovery,
   transitions.
3. kernel-узлы = детерминированные handlers (регистрируются в KernelHandlerRegistry).
4. packageManifest с реальными sha256 ресурсов → попадает в
   `installProductionModules` (орchestrate-cli сам его ставит).
5. register<Workshop>(registries, sharedDeps) в product-lifecycle-runtime.
6. Stage binding в lifecycle + output resolver по schema.
7. ЗАПРЕЩЕНО: ветвления по имени модуля в рантайме, приватный submit-store,
   второй диспетчер, флаги mock-режима (§27 CONVEYOR-MENTAL-MODEL).
8. Методология: `skills/build-factory-workshop/SKILL.md` + чек-лист
   `docs/WEAK-MODEL-CONTROL-CHECKLIST.md`.

## Этап 6 — Обёртка (есть по нужде, НЕ подряд)

| Блок | Объём | Когда нужен |
|---|---|---|
| `src/lifecycle/work-assignment-core.ts` (840), `atomic-release.ts`, `stuck-policy.ts`, `command-bus.ts` | ~2 000 | Разбираешься с claim/fence/зависимостями карточек |
| `src/application/conveyor-runtime.ts` (406), `routing/*` (373), `saga-application.ts` | ~1 300 | Порты приложения, маршрутизация executor'ов |
| `src/tools/` — 30 MCP-файлов, `dispatcher.ts` ~101 KB | ~6 000 | Поверхность воркера: worker_next/done, product_submit |
| `src/infrastructure/` — `workers/claude-worker-executor-factory.ts` (910), `workplace/sqlite-*` (~7 600 всего), `factory/sqlite-factory-launch-repository.ts` (361) | ~9 000 | Спавн claude-воркеров, SQLite-адаптеры домена |
| `src/process-modules/persistence/` — 32 файла | ~5 000 | Репозитории ProcessRun/NodeRun/обязательств |
| `src/modules/` — семантика цехов (settlement-policy'и, installation'ы) | 26 000 | Только цех, с которым работаешь: discovery ≈ 7 500, development ≈ 8 000, delivery ≈ 5 000, formalization ≈ 4 000 |
| `tracker-view/` (board-render 172 KB, claude-runner 66 KB) | ~10 000 | UI/раннер — последний |
| `tests/factory-contract/design/` — 10 файлов, 10 626 строк | 10 600 | Глубокий дизайн-анализ цехов — избирательно, отличный «второй проход» после этапа 5 |

## ADR-маршрут (хронология ума; читать после этапа 0, по 1 экрану)

`025` единый gateway → `028` атомарный settlement → `029/030` рождение
Production Cell рантайма → `038` append-only continuation → `039` модель пишет
текст, Git принадлежит заводу → `041` carry-forward → `042/043` провайдерная
верификация → `045` ProductRevision/DevOps-сплит → `048/049` temporal-конформанс →
**`053` главный** → `054–064` лечение живых инцидентов (по оглавлению) →
`066` заморозка канареек → `067` один ingress → `070/071` readiness-сертификация
и OCI → `072` durable final presentation.
Операционная реальность: `docs/testing/WORKSHOP-BUGS.md` (TB-1..TB-9 — живые
баги движка), `WORKSHOP-TEST-PLAN.md` (тестбед 20 проектов).

---

## Законы завода — самопроверка после каждого этапа

1. **Один стол.** Принятый материал = sealed `WorkplaceProductionRevision`;
   WorkerExecution — только provenance. Любой `ORDER BY … DESC LIMIT 1` /
   `latest` в material-path — дефект (ADR-053 B-6).
2. **Seal key** CandidateSet = (workplace, revision, role [+subject у reviewer]).
   Никогда execution-ref.
3. **C1/C5-голова.** Текущий принятый автор живёт в
   `factory_accepted_authority_head` (+accepted_author_task_id), не в sets[0].
4. **REG-28.** Закрытая таблица пар kanban×loop; crash/repair НЕ откатывают
   Kanban в todo; semantic backward — только reviewer-verdict(defect-proven).
5. **Только GateDecision** принимает/ремонтит/терминирует ячейку.
   worker_done и CandidateSet — не принятие.
6. **6 обязательств**: close-presentation → run-gate → run-effects →
   record-final-acceptance → settle-process → route-lifecycle. Каждое — durable,
   fenced, idempotent; reconciler — часть production engine.
7. **Один spawn-point.** composition-root создаёт WorkAssignmentPort +
   WorkerExecutorFactory; ячейка/цех/флоу воркеров не нанимают.
8. **Проекции не авторитетны.** tasks/доска/логи — rebuildable projections;
   истина в factory_*-таблицах.
9. **Terminal не откатывают.** Продолжение — только append-only continuation с
   verified prefix (ADR-038), carry-forward — через одноразовую authorization.
10. **Пакеты immutable + digest-pinned.** Правка skill без bump версии = другой
    packageDigest = дрейф виден. Replay-key — семантический, без run-ids.
11. **Один gateway старта**: `POST /api/factory/start {project_id|idea_url}` /
    `scripts/factory.mjs`; resume — тот же ключ, новый старт — новый.
12. **Product Build терминал = runnable-local** (не released): локальный старт +
    probe + чистый shutdown; человек оценивает ПОСЛЕ; Deployment — отдельный заказ.

## Ловушки оператора (проверено инцидентами)

- LM Studio + Qwen: Jinja-патч «System message must be at the beginning» —
  обязателен (CLAUDE.md), ошибка тихая в GUI, видна в worker-логах как 10× api_retry 500.
- БД держи ВНЕ `--sandbox` root (старт стирает sandbox).
- `git pull` НЕ обновляет node_modules/скиллы → `npm install && npm run build`
  после каждого pull (иначе воркеры молча теряют saga-инструменты).
- Гонка первого claim: модель/лимит писать в controls ДО первого claim;
  проиграл — kill + plain `resume` без флагов.
- TB-2: SQLite busy-spin движка (5с окна busy_timeout) — лечение kill+resume.
- `paused` у lifecycle ≠ смерть: это typed wait; смотри Workplace loop_state.

## Ответ на главный вопрос инженера (однострочная шпаргалка)

```
идея → /api/factory/start → factory_orders/launch(epochs)
     → LifecycleRun ─ stage ─ StageRun ─ ProcessRun(pinned package)
     → GenericFlowExecutor ─ node: ProductionCellNodeExecutor
     → Workplace(todo/idle→…) ─ claim: WorkAssignmentPort+reservation+fence
     → claude-воркер (MCP: product_submit/worker_done)
     → ingress(frozen WorkIntent) → Contribution → Revision(immutable)
     → CandidateSet(seal) → GateRun(receipts) → GateDecision
     → [reviewer → final gate] → effects → FinalAcceptance(+replay-capsule)
     → settlement/сертификат → outcomeRoutes → следующий цех
     → … → runnable-local (терминал Product Build)
```
