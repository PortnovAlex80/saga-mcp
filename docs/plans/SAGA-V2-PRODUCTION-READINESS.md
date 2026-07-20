# План: saga-mcp v2 — Production Readiness (autonomy + quality + completeness)

**Статус:** DRAFT
**Дата:** 2026-07-20
**Автор:** сессия пользователя (GLM-5.2 + user)
**Предыдущий план:** `PIPELINE-REORDER-SRS-AC.md` (v1 — перестановка SRS после AC + Complexity Gate + DECOMP, ADR-014, merged в master `213b867`)
**Источники:** 7 research-документов в `docs/research/`, audit `audit-2026-07-20-cannon-1000-score.md` (661/1000 baseline)

---

## §0. Почему мы это делаем — корень проблемы

### Что показал прогон Cannon (epic 1, qwen3.6-35b, 22ч)

**Итоговый балл: 661/1000 (66.1%, Acceptable)**. Приложение собрано, но:

| Категория | Балл | % | Что не так |
|---|---:|---:|---|
| A. Архитектура | 155/200 | 77.5% Good | Структурно крепко |
| B. Код | 78/150 | 52% **Weak** | 36 TS errors, scratch в git, тип-дрейф |
| C. Тесты | 108/150 | 72% Acceptable+ | Покрытие есть, но типы не проверяются |
| D. Артефакты | 128/150 | 85.3% Good | 46 артефактов, traceability работает |
| E. Работает | 75/150 | 50% **Weak** | UI не рендерит орбиту после расчёта |
| F. Эффективность | 62/100 | 62% Acceptable | 38 retry-циклов на #31 = 95 минут waste |
| G. Автономия | 55/100 | 55% **Weak** | 6 вмешательств человека за эпизод |

**Корень проблемы:** saga хорошо управляет **формальной структурой** (artifact graph, traces, lifecycle), но **не управляет качеством исполнения** (build/lint/types не запускаются) и **не справляется с тупиковыми ситуациями** (retry loops, unverifiable ACs). Это **ограничивает автономию** — saga требует оператора в цикле.

### Цель v2 — закрыть 3 класса проблем

```
1. КАЧЕСТВО (Дыры A, B, C, E++)  → build-gate, scratch-фильтр, path-sync, verifier-enforce
2. АВТОНОМИЯ (Дыры D, E, E+, F)  → zombie-detect, loop-detect, circuit-breaker, attempt-history, hint
3. ПОЛНОТА (Дыра G, ГОСТ 5)       → saga-arbiter, §10/§11/§12, decision-log gate
+ БОНУС (рекомендация 7)          → dynamic model swap (3× verify speed)
```

**Ожидаемый эффект:** следующий Cannon run на той же модели/задаче должен достичь **800-840/1000** (+115-175 баллов). Человеческих вмешательств: 0-2 (вместо 6).

---

## §1. Двухфазная стратегия — baseline → refactor → re-measure

### Phase A — Cannon v2 baseline на ADR-014 (8-12 ч, human-in-loop)

**Цель:** прогнать ту же задачу Cannon на новом pipeline (перестановка SRS после AC + Complexity Gate + DECOMP) и собрать новый аудит, **прежде чем** вносить v2 правки.

**Зачем:** без baseline на ADR-014 мы не узнаем, дал ли сам v1 прирост. Возможно Hexagonal уже не выбран, complexity M вместо XL, и половина проблем ушла.

**Процедура:**
1. Стартовать новый Cannon-проект (`D:\Development\Cannon-v2-\``) с тем же user prompt
2. Запустить saga-engine (concurrency=4, LM Studio qwen3.6-35b)
3. Наблюдать до `completed` стадии (~12-18 ч wall clock)
4. Собрать аудит по той же 1000-балльной системе
5. Сравнить с v1 (661/1000):
   - Снизился ли complexity с XL → M?
   - Hexagonal или Modular Monolith выбран?
   - Есть ли target_file в task.metadata?
   - Сколько конфликт-ключей проставлено?

**Критерий успеха Phase A:** доказано, что ADR-014 сам по себе закрывает хотя бы 2 из 5 болей (over-engineering, planner вслепую). Если этого нет — рефакторинг v2 не имеет смысла, надо откатить ADR-014.

**Phase A НЕ делается субагентами** — это работа saga-engine + LM Studio + наблюдение оператора.

### Phase B — Рефакторинг v2 (4-6 дней, параллельные субагенты)

**Цель:** закрыть 7 дыр + 5 дыр ГОСТ + dynamic model swap, измерить прирост на новом Cannon run.

**Precondition:** Phase A завершена, baseline записан.

**Декомпозиция:** см. §3 (6 потоков как в v1).

---

## §2. Целевая архитектура v2

### §2.1. Новый lifecycle с Circuit Breaker и Attempt History

```
worker spawned → reads task.metadata.{attempt_history, hint} (NEW)
  → works → writes evidence + recovery_summary (NEW)
    ├─ passed → done
    ├─ failed → appends to attempt_history[]
    │   ├─ n < 3 → recovery → fresh worker (читает историю)
    │   ├─ n = 3 + edit_count=0 → tag needs-specialist → route to domain skill (NEW)
    │   ├─ n = 5 → tag needs-human → saga halts
    │   └─ loop detected (S1/S2) → terminate + increment loop_recoveries
    └─ unknown → saga-arbiter decides (NEW): accept-with-caveat | retry | escalate
```

### §2.2. Build-gate — выполнение SRS §9 stack declaration

Архитектор пишет в SRS §9 **runnable commands** (не названия):
```yaml
type_checker: tsc --noEmit (strict mode)     # was: "tsc"
build_tool: npm run build                     # was: "npm"
test_framework: npm test                      # was: "jest"
linter: npx eslint .                          # was: "eslint"
```

`saga-worker` SKILL перед `worker_done` обязан исполнить ВСЕ 4 команды из §9 и вставить вывод в `result`. Ядро saga-core остаётся стек-агностик (проверяет evidence + merge_state) — enforcement на уровне SKILL + read_only_evidence для verifier (см. §2.3).

### §2.3. Verifier read_only enforcement

В `claude-runner.mjs` добавить `--disallowedTools Edit,Write` для `execution_mode=read_only_evidence`:
- Verifier НЕ может править код (устраняет Дыру E++)
- Если AC unreachable — verifier пишет evidence=unknown с `recovery_summary`
- Decision accept/retry/escalate делает `saga-arbiter` (см. §2.4)

### §2.4. saga-arbiter skill (NEW)

**Назначение:** автономное решение «accept-with-caveat / retry / escalate» для unverifiable ACs (Дыра G).

**Фреймворк:** MCDA + Subjective Logic (Jøsang 2016):
- 5 критериев: correctness 0.30, blast-radius 0.25, reversibility 0.20, audit-clarity 0.15, no-data-loss 0.10
- 4 опции: accept / accept-with-caveat / retry / escalate-to-human
- Subjective Logic: opinion = (belief, disbelief, uncertainty, baseRate)
- Решение принимается если `belief - disbelief > 0.3` с uncertainty ≤ 0.5

**Когда запускается:** при `evidence.outcome='unknown'` saga-core генерирует `decision.arbiter` задачу (новый task_kind, stage='verification').

**Что пишет:** `decision` артефакт с типом 'accept-with-caveat' + обоснование + caveats list. `verification_evidence.outcome='passed'` + metadata `{decided_by: 'arbiter', framework: 'MCDA+SL'}`.

### §2.5. Specialist skills (NEW, опционально для v2.0 — расширяемая library)

| Skill | Домен | Что умеет |
|---|---|---|
| `saga-perf-tuner` | bundling, Lighthouse, startup | bundle analysis, code-splitting, lazy-load patterns |
| `saga-type-fixer` | TS errors, tsconfig | tsc diagnostics, type-narrowing |
| `saga-a11y-expert` | WCAG, axe, ARIA | semantic HTML, keyboard nav |
| `saga-browser-expert` | Safari/Firefox/Edge | polyfills, vendor prefixes |

**Routing:** тег `domain:<name>` проставляется arbiter'ом на основе AC keyword analysis. Specialist запускается через `worker_next({role:'<skill>'})`.

**Для v2.0:** сделать 2 специалиста (perf-tuner + type-fixer), остальные добавить в v2.1.

### §2.6. SRS extension — §10/§11/§12 (ГОСТ compliance)

| Секция | Что | Обязательность |
|---|---|---|
| **§10 Supporting Systems** | 8 видов обеспечения ГОСТ 34.602: информационное, программное, техническое, лингвистическое, организационное, методическое, правовое, эргономическое. Каждое — либо описание, либо `n/a` с обоснованием | REQUIRED для L/XL |
| **§11 External Integration Landscape** | REST/GraphQL/gRPC endpoints, webhook URLs, OAuth scopes, SLA | REQUIRED при наличии external integrations |
| **§12 Decision Log** | Living document: каждый ключевой выбор (порт, паттерн, зависимость, deployment) → запись с alternatives | REQUIRED всегда, min 3 записи |

**Gate:** formalization→planning требует наличия всех 3 секций для L/XL эпизодов. Для S/M — §12 обязательно (3+ decisions), §10/§11 опциональны.

### §2.7. Dynamic model management

LM Studio lifecycle API позволяет 2 модели одновременно на 2×3090 (48 GB VRAM):
- **dev/code**: qwen3.6-35b-a3b@q4_k_xl (~22 GB)
- **verification/arbiter**: gemma-4-12b@q8 (~13 GB, faster)

`saga-engine` выбирает модель по `task_kind` через `metadata.model_hint` (новое поле, выставляет planner). Routing в `claude-runner.mjs` через `--model` + auto-load.

**Эффект:** ~3× ускорение verification, dev без изменений в качестве.

### §2.8. Zombie detection в pump-loop

В `src/orchestrate.ts` pump-loop (рядом с `ZOMBIE_CHECK_TICKS`) добавить проверку `isProcessAlive(pid)` для каждого execution с `state='running'`. Если false → `releaseExecutionAtomically({terminalState: 'terminated', reason: 'process_dead'})`.

Функция `isProcessAlive` уже экспортируется из `worker-executions.ts` и используется в tracker-view — просто импортировать в orchestrate.

### §2.9. Loop detection (S1/S2)

В `tracker-view/claude-runner.mjs` добавить `Transform` над `child.stdout`:
- Парсит JSONL стрим
- Хэширует `(tool_name, canonical_input)` → счётчик `consecutiveIdenticalCalls`
- При N ≥ 5 (identical ИЛИ repeated error) → `recoverFromLoop(execution, reason)`
- Recovery: kill child → `releaseExecutionAtomically` → increment `tasks.metadata.loop_recoveries`
- При `loop_recoveries >= 3` → tag `needs-human`

Дизайн готов: `design-2026-07-20-worker-loop-detection.md`.

---

## §3. Декомпозиция на 6 потоков (как в v1)

Каждый поток работает в **изолированном наборе файлов**.

| Поток | Имя | Владение | Время |
|---|---|---|---|
| **A** | CORE-LOOP | `src/orchestrate.ts` (pump-loop), `src/lifecycle/atomic-release.ts`, `src/worker-executions.ts`, `src/tools/dispatcher.ts` | 6-8 ч |
| **B** | CORE-BUILD | `tracker-view/claude-runner.mjs` (read_only enforcement + loop detector), `src/validators/brief.ts` (model_hint extension) | 6-8 ч |
| **C** | WORKER-VERIFIER | `skills/saga-worker/SKILL.md` (build-gate), `skills/saga-verifier/SKILL.md` (recovery_summary), `skills/saga-planner/SKILL.md` (model_hint + domain tagging) | 4-6 ч |
| **D** | ARBITER+SPECIALISTS | **NEW** `skills/saga-arbiter/SKILL.md`, **NEW** `skills/saga-perf-tuner/SKILL.md`, **NEW** `skills/saga-type-fixer/SKILL.md`, `skills/autonomous-recovery/SKILL.md` (arbiter integration) | 6-8 ч |
| **E** | SRS-EXT+TEMPLATES | `docs/requirements/templates/SRS.md` (+§10/§11/§12), `skills/saga-architect/SKILL.md` (runnable §9 + decision log enforcement), `skills/saga-architecture-reviewer/SKILL.md` | 4-6 ч |
| **F** | TESTS+DOCS | `tests/lifecycle/*` (circuit breaker, attempt history, loop detector tests), `tests/loop-detector.test.mjs` (NEW), `README.md`, `CHANGELOG.md`, ADR-015 NEW | 8-12 ч |

### §3.1. Граф зависимостей

```
       ┌─────────────────────────────────────────────┐
       │     §1 Общий контракт (читают все 6)         │
       └──┬──────────┬──────────┬──────────┬─────────┘
          │          │          │          │
   ┌──────▼──┐ ┌─────▼────┐ ┌──▼─────┐ ┌──▼──────┐
   │A: LOOP  │ │B: BUILD  │ │C:WORKER│ │D:ARBITER│
   │orchestr │ │claude-rn │ │+verify │ │+specials│
   └────┬────┘ └────┬─────┘ └──┬─────┘ └────┬────┘
        │           │          │            │
        └─────┬─────┴──────────┴────────────┘
              │
        ┌─────▼─────┐  ┌──────────────┐
        │E: SRS+TPL │  │F: TESTS+DOCS │
        │architect  │  │(after A+B)   │
        └───────────┘  └──────────────┘
```

**Параллельные:** A, B, C, D, E стартуют одновременно.
**Зависимый:** F стартует после A+B (тесты проверяют их контракты).

---

## §4. Детальный чек-лист реализации Phase B

### Этап 0. Подготовка (2-3 ч)

- [ ] **0.1.** Создать ветку `saga-v2-production-readiness` от master
- [ ] **0.2.** Снять baseline: `npm test`, записать pass count
- [ ] **0.3.** Backup skills: `cp -r skills skills.backup.v2.YYYYMMDD`
- [ ] **0.4.** Прочитать все 7 research-документов (источник для каждого этапа)

### Этап 1. CORE-LOOP (поток A) — 6-8 ч

**Цель:** закрыть Дыры D, E, E+, F (zombie + circuit breaker + attempt history + hint).

- [ ] **1.1.** `src/orchestrate.ts` pump-loop: добавить `isProcessAlive(pid)` check для каждого `execution.state='running'`. Если false → `releaseExecutionAtomically({terminalState:'terminated', reason:'process_dead'})`
- [ ] **1.2.** `src/lifecycle/atomic-release.ts`: при failed outcome добавлять запись в `task.metadata.attempt_history` (JSON array): `{attempt_number, worker_id, outcome, recovery_summary, model, context_peak, edit_count, failed_at, evidence_id}`
- [ ] **1.3.** `src/orchestrate.ts`: добавить `onFailed(task, evidence)` handler:
  - Если `attempt_history.length >= 3 && last.edit_count === 0` → tag `needs-specialist`
  - Если `attempt_history.length >= 5` → tag `needs-human`, halt episode
- [ ] **1.4.** `src/tools/dispatcher.ts`: при tag `needs-specialist` фильтровать очередь по `role:<specialist>` (если такой есть)
- [ ] **1.5.** `src/tools/tasks.ts` (`task_update`): добавить типизированное поле `metadata.hint` (string, сохраняется при planner updates)
- [ ] **1.6.** `src/worker-executions.ts`: при `loop_recoveries >= 3` tag `needs-human`
- [ ] **1.7.** Тесты: `tests/lifecycle/circuit-breaker.test.mjs` (NEW) — simulates 5 failed → needs-human

### Этап 2. CORE-BUILD (поток B) — 6-8 ч

**Цель:** закрыть Дыры A, B, C, E++ (build-gate, scratch-фильтр, path-sync, verifier-enforce) + loop detector.

- [ ] **2.1.** `tracker-view/claude-runner.mjs`: для `execution_mode='read_only_evidence'` добавить `--disallowedTools Edit,Write` в spawn args. Verifier не может править код.
- [ ] **2.2.** `tracker-view/claude-runner.mjs`: добавить `JsonlTee` Transform над `child.stdout`. Парсит JSONL, передаёт в `loopDetector.onLine(line)` + пишет в log без изменений.
- [ ] **2.3.** `tracker-view/claude-runner.mjs`: реализовать `createLoopDetector()` с S1/S2 счётчиками (готовый алгоритм из `design-2026-07-20-worker-loop-detection.md` §3).
- [ ] **2.4.** `tracker-view/claude-runner.mjs`: `recoverFromLoop(execution, reason)` — kill child → `recoverAssignment()` → increment `metadata.loop_recoveries`
- [ ] **2.5.** `src/validators/brief.ts`: расширить `BriefPayload` полем `model_hint?` (опционально: какая модель лучше подходит для verification)
- [ ] **2.6.** Template: `docs/requirements/templates/.gitignore.template` — расширить паттерны: `_*`, `*-report/`, `playwright-report/`, `coverage/`, `*.scratch`, `_calc*`
- [ ] **2.7.** `tools/cgad-spec-lint.mjs`: NEW правило R19 — file_path в SRS §D1 должен существовать в репо после scaffold (ловит Дыру C: path drift)

### Этап 3. WORKER+VERIFIER (поток C) — 4-6 ч

**Цель:** закрыть Дыру A (worker не запускает build) + подготовить specialist routing.

- [ ] **3.1.** `skills/saga-worker/SKILL.md`: заменить строку 165 "run tests/lint" на:
  ```
  Before worker_done, prove the project still builds.
  Read SRS §9 stack declaration. Run ALL of these commands (each MUST exit 0):
    1. type_checker command (e.g. tsc --noEmit)
    2. test_framework command (e.g. npm test)
    3. build_tool command (e.g. npm run build)
    4. linter command (e.g. npx eslint .)
  Paste actual output of each command into worker_done result.
  ```
- [ ] **3.2.** `skills/saga-verifier/SKILL.md`: при failed/unknown outcome ОБЯЗАТЕЛЬНО писать `recovery_summary` (1-2 предложения диагностики) через `comment_add` с prefix `RECOVERY:`. Handler парсит и кладёт в attempt_history.
- [ ] **3.3.** `skills/saga-planner/SKILL.md`: при создании dev-задачи читать SRS §9 и подставлять команды в `metadata.pipeline`. Также проставлять `metadata.model_hint` (например, для verification задач — быстрее модель).
- [ ] **3.4.** `skills/saga-planner/SKILL.md`: domain tagging — keyword-анализ AC title/body. Если содержит `lighthouse|performance|bundle` → tag `domain:perf`. `cross-browser|safari|firefox` → `domain:browser`. И т.д.

### Этап 4. ARBITER+SPECIALISTS (поток D) — 6-8 ч

**Цель:** закрыть Дыру G (unverifiable ACs) + specialist library.

- [ ] **4.1.** **NEW** `skills/saga-arbiter/SKILL.md`: MCDA + Subjective Logic framework. Алгоритм:
  1. Прочитать evidence с outcome=unknown
  2. Собрать 5 критериев (correctness, blast-radius, reversibility, audit-clarity, no-data-loss)
  3. Для каждой опции (accept/accept-with-caveat/retry/escalate) посчитать weighted score
  4. Вычислить Subjective Logic opinion (belief, disbelief, uncertainty)
  5. Если `belief - disbelief > 0.3 AND uncertainty <= 0.5` → accept-with-caveat
  6. Записать `decision` артефакт + обновить evidence outcome='passed' с metadata.decided_by='arbiter'
- [ ] **4.2.** **NEW** `skills/saga-perf-tuner/SKILL.md`: diagnosis skill для domain:perf. Запускается при tag `needs-specialist + domain:perf`. Анализирует bundle, находит проблемы, генерирует hint для dev-воркера (НЕ правит код сам).
- [ ] **4.3.** **NEW** `skills/saga-type-fixer/SKILL.md`: diagnosis skill для domain:types. Запускается при `needs-specialist + domain:types`. Анализирует tsc diagnostics, генерирует план фиксов.
- [ ] **4.4.** `skills/autonomous-recovery/SKILL.md`: добавить arbiter integration. DIAGNOSE phase: если verification gate failed с unknown → spawn `formalization.arbiter` task.
- [ ] **4.5.** `src/tools/workflow.ts`: NEW transition `arbiter_decided` (если arbiter принимает accept-with-caveat → verification_evidence.outcome обновляется, эпизод продолжает).

### Этап 5. SRS EXTENSION + TEMPLATES (поток E) — 4-6 ч

**Цель:** закрыть 5 дыр ГОСТ (deployment, integrations, decision log, supporting systems).

- [ ] **5.1.** `docs/requirements/templates/SRS.md`: добавить секции:
  - **§10 Supporting Systems** (8 видов обеспечения ГОСТ 34.602)
  - **§11 External Integration Landscape**
  - **§12 Decision Log** (living document, min 3 записи)
- [ ] **5.2.** `skills/saga-architect/SKILL.md`: §9 должен содержать **runnable commands** (не названия). Шаблон:
  ```yaml
  type_checker: tsc --noEmit      # was: "tsc"
  build_tool: npm run build        # was: "npm"
  test_framework: npm test         # was: "jest"
  linter: npx eslint .             # was: "eslint"
  ```
- [ ] **5.3.** `skills/saga-architect/SKILL.md`: §12 Decision Log обязательная секция. Архитектор должен создать минимум 3 decision-артефакта (framework, dependency, deployment target).
- [ ] **5.4.** `skills/saga-architecture-reviewer/SKILL.md`: проверить наличие §10/§11/§12 для L/XL. Для S/M — только §12 обязательно.
- [ ] **5.5.** `src/tools/lifecycle.ts`: formalization→planning gate — для L/XL требовать §10/§11/§12. Для S/M — только §12 с min 3 decisions.

### Этап 6. TESTS + DOCS (поток F, после A+B) — 8-12 ч

- [ ] **6.1.** **NEW** `tests/lifecycle/circuit-breaker.test.mjs`: simulates 5 failed outcomes → tags `needs-human`. Simulates 3 failed + edit_count=0 → tags `needs-specialist`.
- [ ] **6.2.** **NEW** `tests/lifecycle/attempt-history.test.mjs`: failed outcome → appends to attempt_history. Worker читает историю при claim.
- [ ] **6.3.** **NEW** `tests/loop-detector.test.mjs`: JSONL stream с 5 identical tool_use → recoverFromLoop вызывается. JSONL с 4 identical + 1 different → не вызывается.
- [ ] **6.4.** **NEW** `tests/arbiter-decision.test.mjs`: evidence outcome=unknown → arbiter spawned → accept-with-caveat → outcome updated.
- [ ] **6.5.** Обновить существующие тесты: `formalization-mechanics` (§10/§11/§12 gate), `product-workflow` (decision log enforcement).
- [ ] **6.6.** `npm test` — все зелёные.
- [ ] **6.7.** `README.md` + `README.ru.md`: обновить диаграмму с arbiter + specialists + circuit breaker.
- [ ] **6.8.** **NEW** `docs/architecture/decisions/015-saga-v2-production-readiness.md`: обоснование всех 7 изменений.
- [ ] **6.9.** `CHANGELOG.md`: entry для v2.

---

## §5. Перекрёстная проверка целостности

### §5.1. Полная инвентаризация затронутых файлов

| Категория | Файлов | LoC правок |
|---|---:|---:|
| src/ (CORE-LOOP + CORE-BUILD) | 6 | ~400 |
| tracker-view/claude-runner.mjs | 1 | ~250 |
| Skills existing (worker, verifier, planner, architect, reviewer, recovery) | 6 | ~400 |
| Skills NEW (arbiter, perf-tuner, type-fixer) | 3 | ~1500 |
| Templates (SRS, .gitignore) | 2 | ~150 |
| Tests existing | 2 | ~100 |
| Tests NEW | 4 | ~600 |
| Docs (README, ADR, CHANGELOG) | 4 | ~200 |
| **ИТОГО** | **~28** | **~3600** |

### §5.2. Ключевые блокеры (без них v2 невозможен)

1. **`isProcessAlive` в pump-loop** (Этап 1.1) — без этого zombie detection не работает.
2. **`attempt_history` в atomic-release** (Этап 1.2) — без этого circuit breaker слеп.
3. **`--disallowedTools` в claude-runner** (Этап 2.1) — без этого verifier продолжает править код.
4. **`saga-arbiter` skill** (Этап 4.1) — без этого unverifiable ACs блокируют pipeline.
5. **`recovery_summary` в verifier SKILL** (Этап 3.2) — без этого attempt_history пустой.

---

## §6. Риски и митигации

| Риск | Вероятность | Влияние | Митигация |
|---|---|---|---|
| Circuit breaker слишком агрессивен (FP на легитимных retries) | средняя | высокое | N=5 (не N=3), только consecutive matches, reset при любом другом tool_use |
| saga-arbiter принимает неверное решение (accept-with-caveat когда не надо) | средняя | критическое | Subjective Logic uncertainty ≤ 0.5 + always log caveats в evidence metadata. Откат: revert outcome через admin tool |
| Specialist skills плохо написаны → модель путается | высокое | среднее | Начать с 2 (perf, type). Каждый specialist ~500 строк, не больше |
| Build-gate ломает существующие weak-model runs (qwen не может tsc) | среднее | среднее | Build-gate только для formalization.prd stage=S+ complexity. Для XS — опционально |
| Loop detector FP на verifier'ах (они делают много artifact_list) | низкое | низкое | S1/S2 считает ТОЛЬКО consecutive identical, любой different сбрасывает |
| Model swap не работает на вашем LM Studio build | среднее | низкое | Fallback на current single-model. Проверить на чистом тесте |

---

## §7. Временная оценка

| Этап | Время |
|---|---|
| Phase A: Cannon v2 baseline на ADR-014 | 12-18 ч (saga running + observation) |
| Phase B Этап 0: подготовка | 2-3 ч |
| Phase B Этап 1: CORE-LOOP | 6-8 ч |
| Phase B Этап 2: CORE-BUILD | 6-8 ч |
| Phase B Этап 3: WORKER+VERIFIER | 4-6 ч |
| Phase B Этап 4: ARBITER+SPECIALISTS | 6-8 ч |
| Phase B Этап 5: SRS EXTENSION | 4-6 ч |
| Phase B Этап 6: TESTS+DOCS | 8-12 ч |
| Phase C: Cannon v3 run на v2 (re-measure) | 12-18 ч |
| **ИТОГО** | **70-87 ч (8-11 дней календарно)** |

---

## §8. Критерии успеха v2

План считается успешным если после применения + Cannon v3 run:

1. **Автономия ≥ 90%.** Человеческих вмешательств ≤ 1 (вместо 6). Circuit breaker ловит retry loops.
2. **Код проходит build-gate.** 0 TS errors в src/. `npm run build` зелёный.
3. **UI работает.** Data flow не нарушен (OrbitResult отображается).
4. **Unverifiable ACs решаются arbiter'ом.** NFR-1/NFR-3 не блокируют pipeline. evidence=unknown → decision artifact → accept-with-caveat.
5. **SRS содержит §10/§11/§12.** Deployment doc, external integrations, decision log.
6. **Нет зомби.** `worker_health` и saga-core согласованы (isProcessAlive check).
7. **Итоговый балл ≥ 800/1000.** +140 баллов к baseline 661.

---

## §9. Откат

- [ ] **R1.** Ветка `saga-v2-production-readiness` не мержится в master без Phase C (re-measure)
- [ ] **R2.** `skills.backup.v2.YYYYMMDD/` для restore SKILLs
- [ ] **R3.** `saga-arbiter` можно отключить через удаление skill из `~/.zcode/skills/` — fallback на `needs-human`
- [ ] **R4.** Build-gate можно отключить через `tasks.metadata.skip_build=true` (для weak models)
- [ ] **R5.** Model swap можно отключить через `SAGA_DISABLE_MODEL_SWAP=1`

---

## §10. История изменений плана

- **2026-07-20 v1:** создан. Двухфазная стратегия (Phase A baseline + Phase B refactor). 6 потоков. Опирается на 7 research-документов и audit 661/1000.
