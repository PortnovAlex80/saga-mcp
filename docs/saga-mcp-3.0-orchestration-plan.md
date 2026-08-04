# saga-mcp 3.0 — План: Autonomous Orchestration Engine

> Этот файл — стартовый промпт для новой сессии.
> Прочитай целиком, затем начни реализацию.
> Не задавай вопросов — план утверждён.

## Контекст

saga-mcp 2.x: оркестратор = умный агент в main context. Может обойти saga (AutoCad3D доказал).
saga-mcp 3.0: оркестратор = тупой движок (pump loop). НЕ может обойти saga.

Feature flag: `SAGA_ORCHESTRATION_MODE=v2|v3` (env). v2 = текущее поведение. v3 = autonomous engine.
v3 не меняет v2 код. Новые файлы добавляются аддитивно. Переключение через env.

## Архитектура

```
Веб-форма (tracker-view)
  → POST /api/project/create-from-idea
  → project + repo + epic + first task (discovery.kickstart)
  → engine.start({ project_id, epic_id, concurrency: 4 })

Engine (новый файл: src/orchestrate.ts)
  while (stage !== 'completed'):
    1. pump() — есть задачи? → spawn workers (ClaudeBoardRunner)
    2. Очередь пуста → workflow_generate_next (создать следующие)
    3. Нет новых → episode_transition (hard gate)
    4. Gate failed → needs-human, pause
    5. Gate success → продолжить цикл
```

## Что строим (4 компонента)

### 1. `src/orchestrate.ts` — оркестрационный цикл (~150 строк)

Новый файл. Не MCP-тул (долгий цикл). Запускается как background process.

```typescript
export async function orchestrate(projectId, epicId, options) {
  const runner = createRunner({ projectId, concurrency: 4, ... });

  while (true) {
    const status = episode_status({ epic_id: epicId });
    if (status.workflow.stage === 'completed') {
      await postIntegration(projectId, epicId);
      break;
    }

    // 1. Запустить воркеров для текущих задач
    await runner.pumpAndWait();

    // 2. Очередь пуста → создать следующие задачи
    const next = workflow_generate_next_if_ready({ epic_id: epicId });
    if (next.created > 0) continue;

    // 3. Попытаться перейти на следующую стадию
    try {
      episode_transition({ epic_id: epicId, to_stage: NEXT[status.workflow.stage] });
    } catch (gateError) {
      // Gate failed → pause, needs-human
      await pauseAndAlert(epicId, gateError);
      await waitForResume(epicId);
    }
  }
}
```

Ключевые методы:
- `pumpAndWait()` — вызывает существующий ClaudeBoardRunner.pump(), ждёт завершения всех active workers
- `workflow_generate_next_if_ready()` — проверяет последнюю done задачу, вызывает workflow_generate_next с правильным transition
- `pauseAndAlert()` — ставит epic metadata `needs-human`, пишет в activity_log, heartbeat
- `waitForResume()` — polling saga DB каждые 10 сек на изменение metadata (resume signal)

### 2. `workflow_generate_next` — добавить `brief_accepted` (~30 строк в workflow.ts)

> **Исправлено ADR-008** ([008-brief-accepted-prd-only.md](architecture/decisions/008-brief-accepted-prd-only.md)).
> Изначальный набросок этого раздела говорил «brief → PRD + SRS параллельно».
> При чтении кода выяснилось: существующий `prd_accepted` (workflow.ts:84-100)
> уже создаёт SRS+UC как children of PRD, а `srs_accepted`/`uc_accepted`
> (workflow.ts:102-125) ищут свою пару через `sibling(...)` по
> `generated_from_task_id`. Если бы `brief_accepted` создал SRS как child of
> kickstart, а `prd_accepted` создал бы UC как child of PRD — `sibling()`
> упал бы с `"matching formalization.uc task was not found"` и заблокировал
> весь downstream. Поэтому переход создаёт **только PRD**.
>
> **Superseded (ADR-014, 2026-07-20):** `sibling()` rationale между SRS и UC
> больше не применяется. После перестановки pipeline SRS создаётся через
> `baseline_accepted` (после AC), а не через `prd_accepted` параллельно с UC.
> `prd_accepted` теперь создаёт ТОЛЬКО UC. См. addendum к ADR-008 и сам
> ADR-014 ([014-pipeline-reorder-srs-after-ac.md](architecture/decisions/014-pipeline-reorder-srs-after-ac.md)).

> **Update (ADR-014, 2026-07-20):** pipeline reorder — SRS moved AFTER AC.
> Список transitions теперь (канон):
>
> | task_kind | transition | что создаёт |
> |---|---|---|
> | `discovery.kickstart` | `brief_accepted` | `formalization.prd` |
> | `formalization.prd` | `prd_accepted` | **ТОЛЬКО `formalization.uc`** (не SRS+UC) |
> | `formalization.uc` | `uc_accepted` | `formalization.ac` (без ожидания SRS) |
> | `formalization.ac` | `ac_accepted` | `formalization.reconciliation` (без dep на SRS) |
> | `formalization.reconciliation` | `baseline_accepted` | `formalization.srs` (НОВОЕ — SRS после AC) |
> | `formalization.srs` | `srs_accepted` (НОВЫЙ) | `planning.decomposition` |
>
> FR/NFR/RULE переезжают из SRS в PRD. SRS становится чисто архитектурным +
> содержит §D DECOMP (per-AC YAML map), по которому planner создаёт задачи
> (dumb copier). См. `docs/architecture/decisions/014-pipeline-reorder-srs-after-ac.md`
> и `docs/plans/PIPELINE-REORDER-SRS-AC.md` (полный план).

Добавить:

```typescript
// brief_accepted: kickstart done → создать ОДНУ formalization.prd задачу.
// SRS+UC создаст существующий prd_accepted (workflow.ts:84-100) — оставляем
// эту цепочку нетронутой (battle-tested, покрыта tests/product-workflow.test.mjs).
'brief_accepted': (db, epic, source) => {
  // 1. Validation: source.task_kind === 'discovery.kickstart'
  // 2. Найти brief artifact (type='brief' в эпизоде). Если нет → throw.
  // 3. Decision-guard: прочитать metadata.brief_payload.decision. Если !== 'go'
  //    → return [] (clarify/reject/fast-track имеют свои пути, PRD не нужен).
  // 4. Создать formalization.prd (exec: saga-product, review:
  //    saga-requirements-reviewer, mode: git_change, stage: formalization,
  //    dependencies: [kickstart.id], project_repository_id inherited из brief).
}
```

Дополнительно:
- `generateNextForCompletedTask` (workflow.ts) — добавить в ladder:
  `discovery.kickstart → 'brief_accepted'` (первая ветка в ternary).
- Tool enum и описание — добавить `brief_accepted`.
- **Stage transition (discovery → formalization) НЕ делает `brief_accepted`.**
  Этим занимается движок `orchestrate.ts` (шаг 2): после того как
  `workflow_generate_next` создал PRD, движок вызывает `episode_transition`.
  Это разделение ответственности: `workflow.ts` не мутирует episode stage,
  `lifecycle.ts` (вызванный движком) — мутирует. (См. ADR-008 §Decision п.4.)

Параллельные/позже переходы из изначального наброска:
- `planning_done`: planner done → НИЧЕГО (планнер сам создаёт dev tasks через task_create)
- `development_all_done`: проверяется `episode_transition` hard gate (development → verification)
- `verification_done`: проверяется `episode_transition` hard gate (verification → integration)

Эти три не требуют новых `workflow_generate_next` переходов — они уже работают
через существующую машину состояний `episode_transition`.

### 3. Web UI — форма "New Project" (~80 строк в tracker-view.mjs)

Новый endpoint: `POST /api/project/create-from-idea`

```javascript
// Handler:
app.post('/api/project/create-from-idea', async (req, res) => {
  const { name, idea } = req.body;

  // 1. Создать проект + репо + epic + первую задачу
  const project = handlers.project_create({ name, description: idea });
  const binding = handlers.repository_register({ project_id: project.id, name, local_path: `D:/Development/${name}` });
  mkdirSync(`D:/Development/${name}`);
  // git init

  const epic = handlers.epic_create({ project_id: project.id, name: 'REQ-001' });

  // episode_workflow auto-created (stage: discovery)

  handlers.task_create({
    epic_id: epic.id,
    title: `Discovery: ${idea}`,
    task_kind: 'discovery.kickstart',
    workflow_stage: 'discovery',
    execution_skill: 'saga-kickstart',
    priority: 'critical'
  });

  // 2. Запустить движок (background)
  const orchestrateProcess = spawn('node', ['dist/orchestrate.js', project.id, epic.id], {
    detached: true, stdio: 'ignore'
  });
  orchestrateProcess.unref();

  res.json({ project_id: project.id, epic_id: epic.id, status: 'orchestrating' });
});
```

HTML: кнопка «+ Новый проект» → модальная форма (name + idea textarea) → POST → redirect на канбан.

### 4. Web UI — "Resume" кнопка (~30 строк)

Когда `episode_workflows.metadata.needs-human = true`:
- Канбан показывает красный pulse + сообщение об ошибке
- Кнопка "Resume" → `POST /api/episode/resume` → снимает needs-human → движок продолжает

## Существующая инфраструктура (что переиспользуем)

### ClaudeBoardRunner (`tracker-view/claude-runner.mjs`, ~400 строк)
- `pump()` (строка 222) — главный цикл: claimTask → launch → ждать close → pump снова
- `launch()` (строка 268) — spawn `claude -p` с MCP config, skill prompt, env vars
- `close` handler (строка 340) — recovery: проверяет task status, completed/failed/changesRequested
- Recovery через `recoverAssignment` (tracker-view.mjs:238-260) — возвращает задачу в очередь
- Singleton instance: `boardRunner` в tracker-view.mjs:262

### workflow_generate_next (`src/tools/workflow.ts`)
- `specsForTransition` (строка 82) — 4 transition: prd_accepted, srs_accepted, uc_accepted, baseline_accepted
  (before ADR-014; after ADR-014: 6 transitions — added `brief_accepted` (ADR-008)
  and reshaped `prd_accepted` → UC only, `baseline_accepted` → SRS, `srs_accepted`
  → planning. См. таблицу выше и ADR-014.)
- `generateNextForCompletedTask` (строка 175) — вызывается из worker_done и worker_merge_release
- `insertGeneratedTask` (строка 28) — idempotent через generation_key

### episode_transition (`src/tools/lifecycle.ts`)
- Hard gates: formalization→planning (acceptedBaseline), planning→development (tasksReady), development→verification (tasksReady), verification→integration (assertVerificationPassed), integration→completed (tasksReady)
- `advanceReadyEpisodes` (строка 155) — вызывается из worker_next автоматически

### HTTP endpoints (tracker-view.mjs)
- `POST /api/board-run/start` → boardRunner.start() (строка 1859)
- `POST /api/board-run/stop` → boardRunner.stop() (строка 1879)
- `GET /api/board-run/status` → boardRunner.status() (строка 2609)
- `POST /api/episode/transition` → lifecycleHandlers.episode_transition

## Что НЕ меняем

- ClaudeBoardRunner — остаётся как есть, движок его использует
- episode_transition hard gates — остаётся, движок их вызывает
- worker_next/worker_done — остаётся
- Skills — остаётся (saga-kickstart, saga-product, etc.)
- cgad-spec-lint — остаётся
- v2 mode (main context оркестрация) — остаётся как fallback

## Порядок реализации

> **Статус: реализовано (2026-07-18).** Все 6 шагов выполнены. См. ADR-008 для
> ключевого архитектурного решения по `brief_accepted`. Smoke-test пройден:
> `POST /api/project/create-from-idea` в `SAGA_ORCHESTRATION_MODE=v3` создаёт
> полную цепочку project+repo+epic+task и spawn'ит движок; движок pump'ает
> задачу в `worker_next`, spawn'ит воркера, пишет heartbeat. Полный end-to-end
> цикл (до `completed`) требует реального `claude` CLI и не покрыт автотестом.

1. `workflow_generate_next` — добавить `brief_accepted` transition ✅
   - В `src/tools/workflow.ts`: новый transition в `specsForTransition`
     (создаёт **одну** formalization.prd задачу, не PRD+SRS — см. ADR-008)
   - Decision-guard: читает brief artifact, skip если `decision !== 'go'`
   - В `src/tools/workflow.ts` `generateNextForCompletedTask`: добавлен
     `discovery.kickstart → 'brief_accepted'` в ladder
   - Покрыто 3 новыми тестами в `tests/product-workflow.test.mjs`

2. `src/orchestrate.ts` — цикл pumpAndWait + transition + pause/resume ✅
   - Импортирует ClaudeBoardRunner (или inline pump loop)
   - Импортирует episode_status, episode_transition, workflow_generate_next
   - `pumpAndWait()` — spawn workers, ждать все close events
   - `workflow_generate_next_if_ready()` — найти последнюю done задачу, вызвать transition
   - `pauseAndAlert()` — metadata.needs-human, activity_log
   - `waitForResume()` — poll DB каждые 10 сек

3. `src/orchestrate-cli.ts` — CLI entry point (~30min)
   - `node dist/orchestrate-cli.js <project_id> <epic_id> [--concurrency=4]`
   - Запускает orchestrate(), пишет heartbeat в log

4. Web UI форма "New Project" (~1h)
   - tracker-view.mjs: POST /api/project/create-from-idea
   - HTML: modal с name + idea, кнопка "Создать"
   - Backend: project + repo + epic + first task + spawn orchestrate-cli.js

5. Web UI "Resume" button (~30min)
   - tracker-view.mjs: POST /api/episode/resume
   - HTML: кнопка когда needs-human=true

6. Тест: запустить water-cannon через форму, проверить полный цикл (~1h)

## Feature flag

```bash
# v2 (текущее): main context агент управляет потоком
SAGA_ORCHESTRATION_MODE=v2

# v3 (новое): autonomous engine управляет потоком
SAGA_ORCHESTRATION_MODE=v3
```

v3 не меняет v2 код. Новые файлы (`orchestrate.ts`, `orchestrate-cli.ts`, новые endpoints) добавляются аддитивно. Если v3 ломается → переключить env → v2 работает как раньше.

## Риски

| Риск | Митигация |
|---|---|
| `claude` CLI недоступен/упал | runner recovery (уже есть) → needs-human |
| workflow_generate_next создаёт задачи в неправильном порядке | Hard gates блокируют переход |
| Движок зацикливается | emptyChecks > 3 → finish('failed') |
| Brief decision=clarify → нужна пауза | Движок читает metadata, ставит needs-human |
| Web UI форма не POST'ит | CLI fallback: `node dist/orchestrate-cli.js 37 124` |

## Главная мысль

Агент не управляет потоком. Движок управляет.

Агент в главной сессии делает 5 шагов (или веб-форма) и уходит. Дальше — движок:
- `workflow_generate_next` создаёт задачи по правилам машины состояний
- `episode_transition` проверяет hard gates
- ClaudeBoardRunner spawn'ит воркеров
- Воркеры не могут обойти saga (`--disallowedTools mcp__saga__worker_next`)
- Если hard gate падает → движок останавливается, ставит needs-human, ждёт

## Файлы для чтения перед стартом

1. `src/tools/workflow.ts` — `specsForTransition`, `generateNextForCompletedTask`, `insertGeneratedTask`
2. `src/tools/lifecycle.ts` — `episode_transition`, `advanceReadyEpisodes`, hard gates
3. `src/tools/dispatcher.ts` — `worker_next`, `worker_done`, `generateNextForCompletedTask` вызов
4. `tracker-view/claude-runner.mjs` — `ClaudeBoardRunner`, `pump()`, `launch()`, `close` handler
5. `tracker-view/tracker-view.mjs` — `boardRunner` singleton (строка 262), HTTP endpoints (строки 2592+)

## Итог: что должно работать после реализации

```
Пользователь: localhost:4321 → "Новый проект" → "мини автокад 3д" → [Создать]
Saga:
  - Создаёт проект + репо + git + эпизод
  - Создаёт задачу discovery.kickstart
  - Запускает движок (background)
  - Движок: spawn kickstart worker → brief → formalization tasks → spawn workers → PRD(+FR/NFR/RULE)/UC/AC/Reconcile/SRS(+§D DECOMP) → planning → dev → verify → integration → completed
    (pipeline order per ADR-014: `PRD → UC → AC → SRS`, SRS AFTER AC)
  - Канбан: live обновление, heartbeat pulse
  - Если needs-human: красный pulse + кнопка Resume
Пользователь: открывает канбан через 2 часа → продукт готов
```
