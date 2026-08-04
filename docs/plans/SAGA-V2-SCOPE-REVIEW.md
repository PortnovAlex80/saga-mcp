# saga-mcp v2 — Комплексный пересмотр скоупа

**Дата:** 2026-07-21
**Автор:** сессия пользователя (GLM-5.2 + user)
**Предыдущие документы:**
- `docs/plans/SAGA-V2-PRODUCTION-READINESS.md` (исходный план, 398 строк)
- `docs/research/investigation-2026-07-20-cannon-development-stage.md` (Дыры A–F)
- `docs/research/audit-2026-07-20-cannon-1000-score.md` (661/1000 baseline, 7 рекомендаций)
- `docs/research/design-2026-07-20-worker-loop-detection.md` (S1/S2 дизайн)
- `docs/research/autonomous-decision-unverifiable-acs.md` (arbiter фреймворк)
- `docs/research/saga-vs-gost-34-602-and-iso-12207.md` (8 видов обеспечения)
- `docs/research/lmstudio-dynamic-model-management.md` (per-task model swap)
- `docs/research/literature-2026-agentic-loops-and-escalation.md` (IAL/Reflexion/Voyager)
- **NEW:** https://docs.bmad-method.org/ (BMAD method — внешний фреймворк)

**Цель документа:** пересмотреть весь скоуп v2 с учётом:
1. Всех 7 architectural holes + 5 GOST holes из плана
2. Всех 5 идей из BMAD method (заимствовать — там, где они сильнее saga)
3. Всех рекомендаций из audit (661 → 800-840)
4. Open questions из research-документов, которые НЕ попали в исходный план

---

## §0. Корень проблемы — что показал Cannon

**Baseline: 661/1000 (Acceptable).** Приложение собрано, архитектура крепкая,
но:

| Категория | Балл | Что не так |
|---|---:|---|
| A. Архитектура | 155/200 (77%) | Хорошо |
| B. Код | **78/150 (52%)** | 36 TS errors, scratch в git, тип-дрейф |
| C. Тесты | 108/150 (72%) | Покрытие есть, типы не проверяются |
| D. Артефакты | 128/150 (85%) | Traceability работает |
| E. Работает | **75/150 (50%)** | UI не рендерит орбиту после расчёта |
| F. Эффективность | 62/100 (62%) | 38 retry-циклов на #31 = 95 минут waste |
| G. Автономия | **55/100 (55%)** | 6 вмешательств человека |

**Корень:** saga хорошо управляет **формальной структурой**, но **не управляет качеством исполнения** (build/lint/types не запускаются) и **не справляется с тупиковыми ситуациями** (retry loops, unverifiable ACs).

---

## §1. Полная инвентаризация проблем (объединённая)

### §1.1. Architectural holes (7) — из investigation-отчёта

| ID | Дыра | Где фиксить | Была в плане v2? |
|---|---|---|---|
| **A** | Stack declaration декларирована, не исполняется | saga-worker SKILL build-gate | ✅ есть |
| **B** | Scratch-файлы и бинарники в git | .gitignore + saga-code-reviewer | ⚠️ частично (только .gitignore) |
| **C** | Пути в SRS §2b расходятся с реальными | cgad-spec-lint R19 | ✅ есть |
| **D** | Zombie detection отсутствует в saga-core | orchestrate.ts pump-loop | ✅ есть |
| **E** | Бесконечный retry без circuit breaker | orchestrate.ts + attempt_history | ✅ есть |
| **E+** | Ручной hint в description не масштабируется | типизированное metadata.hint | ✅ есть |
| **E++** | Verifier правит код, нарушая read_only | claude-runner --disallowedTools | ✅ есть |
| **F** | Kanban скрывает агентский цикл (нет attempt history) | metadata.attempt_history | ✅ есть |
| **G** | Unverifiable ACs блокируют pipeline | saga-arbiter + MCDA + SL | ✅ есть |

### §1.2. GOST holes (5) — из saga-vs-gost отчёта

| ID | Что | Где фиксить | Было в плане v2? |
|---|---|---|---|
| **G1** | Deployment (ГОСТ пункт 13) | SRS §10 technical supporting_system | ✅ есть |
| **G2** | External integrations (ГОСТ пункт 10) | SRS §11 + external_protocol | ✅ есть |
| **G3** | Decision Log (ГОСТ пункт 5) | SRS §12 + decision artifacts | ✅ есть |
| **G4** | Make/buy/integrate policy (ГОСТ пункт 9) | supporting_system organizational | ⚠️ частично |
| **G5** | Stakeholder influence registry (ГОСТ пункт 4) | PRD §stakeholders | ❌ НЕТ в плане |

### §1.3. Что НЕ попало в исходный план v2 (новые пробелы)

| ID | Что | Источник | Категория |
|---|---|---|---|
| **N1** | `saga-code-reviewer` skill (phantom — упоминается в audit пункт 5, не реализован) | audit §7.5 | B (качество кода) |
| **N2** | Deterministic tool gate (CGAD extension) — verifier должен парсить tool output и передавать model diagnostic | investigation Дыра E+ механизм 4 | G (автономия) |
| **N3** | Failure-context propagation (mechanism 2) — `metadata.previous_failures` со списком правок, которые worker пробовал | investigation Дыра E+ механизм 2 | F (эффективность) |
| **N4** | **Stakeholder registry** в PRD (GOST пункт 4) — кто влияет, сила влияния, интерес | gost §5.5 | D (артефакты) |
| **N5** | **Project Profile** на Complexity Gate (web-frontend/library/embedded/data-pipeline/enterprise-service) — профиль адаптирует SKILL'ы | gost §7.2 | D (артефакты) |
| **N6** | Make/buy/integrate policy — явная запись в Decision Log | gost §5.4 | D (артефакты) |
| **N7** | Loop-recoveries hard cap → `needs-human` | investigation + design | G (автономия) |
| **N8** | Thinking budget per task_kind (`--effort xhigh` для dev, `none` для verify) | lmstudio §5 | F (эффективность) |
| **N9** | Concurrency adjustment per model (4 workers для 35b, 2 для 70b) | lmstudio §7.6 | F (эффективность) |

### §1.4. BMAD ideas (5) — из docs.bmad-method.org

| ID | Идея | Что даёт | Саге не хватает? |
|---|---|---|---|
| **B1** | `bmad-check-implementation-readiness` — adversarial gate PASS/CONCERNS/FAIL между Planning и Implementation | Ловит архитектурные проблемы ДО кодирования | ✅ да (Дыра E+ следствие) |
| **B2** | `bmad-retrospective` — formalised lessons learned после epic | Voyager-style skill library, растёт со временем | ✅ да (новое) |
| **B3** | `bmad-forge-idea` — pre-Discovery pressure-testing с kill-criteria | Уменьшает waste на нежизнеспособных эпизодах | ⚠️ опционально |
| **B4** | **Code Review Crew** — 5 независимых линз (security, adversary, edge, craftsman, pragmatist) | Ловит rubber-stamping (Дыра A следствие) | ✅ да |
| **B5** | **Party Mode** для key architectural decisions | Демократичные решения вместо single-model | ⚠️ опционально |

---

## §2. Пересмотренный скоуп v2 — полная карта

### §2.1. 3 уровня приоритетов

**Tier 1 — ОБЯЗАТЕЛЬНО (минимальный pipeline v2):** 7 architectural holes + 5 GOST holes + dynamic model swap + N1 (code-reviewer) + N7 (loop hard cap).
Ожидаемый эффект: **661 → 780-820 / 1000**.

**Tier 2 — РЕКОМЕНДУЕТСЯ (бустит автономию/эффективность):** N2-N3 (deterministic tool gate + failure-context) + N8-N9 (thinking/concurrency policy) + B1 (readiness gate) + B2 (retrospective).
Ожидаемый эффект: **820 → 850-880 / 1000**.

**Tier 3 — ОПЦИОНАЛЬНО (v2.1 / v3):** B3 (forge) + B4 (review crew) + B5 (party mode) + N4/N5/N6 (stakeholder/profile/make-buy).
Ожидаемый эффект: **880 → 900+ / 1000**.

### §2.2. Полная карта задач с приоритетами

| # | Задача | Tier | Дыра/Источник | Объём | Эффект |
|---|---|---|---|---|---|
| 1 | **Build-gate** в saga-worker (runnable §9) | T1 | A | ~80 LoC SKILL | +30-50 баллов |
| 2 | **Loop detector S1/S2** в claude-runner | T1 | E | ~250 LoC | +20-30 баллов |
| 3 | **Circuit breaker** в orchestrate (N=5 → needs-human) | T1 | E+ мех.1 | ~25 LoC | +15-20 баллов |
| 4 | **Attempt history** в metadata (append-only) | T1 | F | ~30 LoC | +10-15 баллов |
| 5 | **Hint channel** типизированный | T1 | E+ мех.5 | ~40 LoC | +10-15 баллов |
| 6 | **Zombie detection** в pump-loop (isProcessAlive) | T1 | D | ~30 LoC | +5-10 баллов |
| 7 | **Verifier read_only enforcement** (--disallowedTools) | T1 | E++ | ~5 LoC | +5 баллов |
| 8 | **saga-arbiter** skill (MCDA + Subjective Logic) | T1 | G | ~600 LoC NEW | +10-15 баллов |
| 9 | **SRS §10** Supporting Systems (8 ГОСТ видов) | T1 | G1 | ~150 LoC template+SKILL | +10 баллов |
| 10 | **SRS §11** External Integrations + external_protocol | T1 | G2 | ~80 LoC | +5 баллов |
| 11 | **SRS §12** Decision Log (min 3 decisions) | T1 | G3 | ~80 LoC | +5-10 баллов |
| 12 | **Scratch .gitignore** + cgad R19 path drift | T1 | B+C | ~30 LoC | +5 баллов |
| 13 | **Dynamic model swap** (per-task model policy) | T1 | audit §7.7 | ~250 LoC | +10-15 баллов |
| 14 | **saga-code-reviewer** skill (tsc, размер, scratch) | T1 | audit §7.5 (N1) | ~500 LoC NEW | +20-30 баллов |
| 15 | **Loop-recoveries hard cap** (3 → needs-human) | T1 | N7 | ~20 LoC | +5 баллов |
| 16 | **Deterministic tool gate** (parse tool output) | T2 | E+ мех.4 (N2) | ~150 LoC | +10 баллов |
| 17 | **Failure-context propagation** (previous_failures) | T2 | E+ мех.2 (N3) | ~80 LoC | +10 баллов |
| 18 | **Thinking budget per task_kind** (--effort) | T2 | N8 | ~50 LoC | +5-10 баллов |
| 19 | **Concurrency adjustment per model** | T2 | N9 | ~40 LoC | +5 баллов |
| 20 | **Readiness gate** (adversarial pre-mortem) | T2 | B1 | ~400 LoC NEW skill | +10-15 баллов |
| 21 | **Retrospective** skill (Voyager library) | T2 | B2 | ~300 LoC NEW skill | +5-10 баллов (накапливается) |
| 22 | **forge** skill (pre-Discovery kill-criteria) | T3 | B3 | ~500 LoC NEW skill | уменьшает waste |
| 23 | **Code Review Crew** (5 линз) | T3 | B4 + A следствие | ~800 LoC 5 sub-skills | +10-15 баллов |
| 24 | **Party Mode** для architectural decisions | T3 | B5 | ~1000 LoC | +5-10 баллов |
| 25 | **Stakeholder registry** в PRD | T3 | N4 + G5 | ~60 LoC template | +2-5 баллов |
| 26 | **Project Profile** на Complexity Gate | T3 | N5 | ~300 LoC | +5 баллов |
| 27 | **Make/buy/integrate policy** в Decision Log | T3 | N6 | ~30 LoC SKILL | +2 балла |

### §2.3. Итоговый бюджет

| Tier | Задач | Объём LoC | Эффект к baseline |
|---|---:|---:|---:|
| **T1 (обязательно)** | 15 | ~2200 (src) + ~1100 (NEW skills) | 661 → 780-820 |
| **T2 (рекомендуется)** | 6 | ~980 + ~700 (NEW skills) | 820 → 850-880 |
| **T3 (опционально)** | 6 | ~2690 | 880 → 900+ |
| **ИТОГО полный v2** | 27 | ~7670 | **661 → 900+** |

---

## §3. Декомпозиция на 8 потоков (расширение v1)

Базируется на 6 потоках из `SAGA-V2-PRODUCTION-READINESS.md`, расширена 2 новыми потоками под Tier 2 BMAD-идеи.

| Поток | Имя | Файлы (владение) | Tier | Время |
|---|---|---|---|---|
| **A** | CORE-LOOP | `src/orchestrate.ts`, `src/lifecycle/atomic-release.ts`, `src/worker-executions.ts`, `src/tools/dispatcher.ts`, `src/tools/tasks.ts` | T1 | 6-8 ч |
| **B** | CORE-BUILD | `tracker-view/claude-runner.mjs`, `src/validators/brief.ts`, `tools/cgad-spec-lint.mjs`, `docs/requirements/templates/.gitignore.template` | T1+T2 | 8-10 ч |
| **C** | WORKER+VERIFIER | `skills/saga-worker/SKILL.md`, `skills/saga-verifier/SKILL.md`, `skills/saga-planner/SKILL.md` | T1+T2 | 4-6 ч |
| **D** | ARBITER+SPECIALISTS | **NEW** `skills/saga-arbiter/SKILL.md`, **NEW** `skills/saga-perf-tuner/SKILL.md`, **NEW** `skills/saga-type-fixer/SKILL.md`, `skills/autonomous-recovery/SKILL.md`, `src/tools/workflow.ts` | T1 | 6-8 ч |
| **E** | SRS-EXT+TEMPLATES | `docs/requirements/templates/SRS.md`, `docs/requirements/templates/PRD.md`, `skills/saga-architect/SKILL.md`, `skills/saga-architecture-reviewer/SKILL.md`, `skills/saga-product/SKILL.md`, `src/tools/lifecycle.ts` | T1+T3 | 6-8 ч |
| **F** | TESTS+DOCS | `tests/lifecycle/*` (NEW), `tests/loop-detector.test.mjs` (NEW), `README.md`, `CHANGELOG.md`, ADR-015 NEW | T1 | 8-12 ч |
| **G** | **NEW** REVIEWER+RETRO | **NEW** `skills/saga-code-reviewer/SKILL.md`, **NEW** `skills/saga-retrospective/SKILL.md`, `skills/saga-reconciler/SKILL.md` (retro hook) | T1+T2 | 6-8 ч |
| **H** | **NEW** READINESS+POLICY | **NEW** `skills/saga-readiness-checker/SKILL.md`, `src/tools/lifecycle.ts` (readiness gate), `src/tools/workflow.ts` (readiness transition) | T2 | 6-8 ч |

### §3.1. Граф зависимостей

```
       ┌─────────────────────────────────────────────────┐
       │     §1 Общий контракт (читают все 8)             │
       └──┬──────┬──────┬──────┬──────┬──────┬──────┬────┘
          │      │      │      │      │      │      │
   ┌──────▼┐ ┌──▼───┐ ┌▼────┐ ┌▼────┐ ┌▼────┐ ┌▼────┐ ┌▼────┐
   │A:LOOP │ │B:BLD │ │C:WV │ │D:ARB│ │E:SRS│ │G:REV│ │H:RDY│
   │orch   │ │run   │ │skill│ │skill│ │tmpl │ │+ret │ │+pol │
   └────┬──┘ └──┬───┘ └─┬──┘ └────┘ └────┘ └────┘ └────┘
        │       │       │
        └───┬───┴───────┘
            │
      ┌─────▼─────┐
      │F: TESTS+  │
      │   DOCS    │
      └───────────┘
```

**Параллельные:** A, B, C, D, E, G, H стартуют одновременно.
**Зависимый:** F стартует после A+B+C (тесты проверяют их контракты).

---

## §4. Что нужно добавить в исходный план v2

Ниже — дельты относительно `SAGA-V2-PRODUCTION-READINESS.md`. Не повторяю уже описанные там задачи, только **новые** или **существенно расширенные**.

### §4.1. Поток G — saga-code-reviewer + saga-retrospective (NEW)

**G.1. saga-code-reviewer SKILL (NEW, ~500 строк)**
- Заменяет текущий phantom "reviewer" — теперь реальный skill
- Что проверяет на коде (НЕ на артефактах):
  - `npx tsc --noEmit` exit 0 (static type check)
  - Размер изменённых файлов (нет файлов >500 строк без обоснования)
  - Scratch-детекция: `_*`, `*-report/`, `*.scratch`, `_calc*` в `git diff`
  - Дублирование: `jscpd` или эквивалент
  - ESLint warnings count
- Verdict: PASS / REQUEST_CHANGES + конкретные указания
- Запускается на каждой `development.code` задаче в review стадии
- **Закрывает audit §7.5** — saga-code-reviewer был phantom в v1

**G.2. saga-retrospective SKILL (NEW, ~300 строк) — из BMAD idea B2**
- Триггер: `completed.transition` эпизода
- Что делает:
  1. Читает `worker_executions` за эпизод
  2. Группирует по паттернам: retry loops, time waste, missing specialists, model swap candidates
  3. Записывает артефакт `summary.retro` с lessons learned
  4. Сохраняет patterns в `project.notes` с тегами `voyager-skill` (переиспользуемые)
- **Эффект:** единственная вещь, чей ROI растёт со временем. После 10 эпизодов saga имеет library of patterns. После 100 — критическая масса для автоэскалации.

**G.3. saga-reconciler extension — hook на retro**
- В `saga-reconciler/SKILL.md` добавить: после marking episode completed, spawn `summary.retro` task
- ~30 строк дополнительно

### §4.2. Поток H — readiness checker + thinking/concurrency policy (NEW)

**H.1. saga-readiness-checker SKILL (NEW, ~400 строк) — из BMAD idea B1**
- Триггер: новый transition `readiness_check` между planning и development
- Что делает (adversarial review):
  1. Читает SRS §D2 (AC→Implementation map)
  2. Читает Decision Log §12
  3. Для каждой dev-задачи:
     - Существует ли `target_file` в scaffold? (Дыра C)
     - Есть ли `public_protocol` если файл публичный?
     - Покрыт ли AC хотя бы одним FR/NFR в PRD?
  4. Pre-mortem: "что может пойти не так?" — top 3 рисков
  5. Red Team: "как dev-воркер может сломать план?"
- Verdict: PASS / CONCERNS / FAIL
  - PASS → episode переходит в development
  - CONCERNS → planner дорабатывает, возвращается на readiness
  - FAIL → saga-reconciler (значит формализация неполная)
- **Закрывает Дыру E+** (hint doesn't scale) — adversarial check ДО кода

**H.2. thinking/concurrency policy — из N8, N9**
- В `tracker-view/claude-runner.mjs` (поток B уже владеет) добавить:
  - `--effort` флаг из `task.metadata.thinking_budget`
  - При `task_kind=verification.ac` → `--effort none` (быстрее)
  - При `task_kind=development.code` complexity=M → `--effort xhigh`
- В `src/orchestrate.ts` (поток A):
  - При model swap на gemma-4-12b → concurrency=6 (быстрая модель)
  - При qwen3.6-35b → concurrency=4 (текущее)
  - При 70b → concurrency=2
- ~90 LoC

### §4.3. Детерминированные gates — из N2, N3 (расширение потока C)

**C.X. Deterministic tool gate (CGAD extension)**
- В `verification_record` handler парсить tool output из worker-лога
- При Lighthouse failed → извлечь score (78), Top-3 slowest запросов
- При tsc failed → извлечь first 3 errors с file:line
- Записать в `verification_evidence.diagnostic` (новое поле)
- Verifier при следующей попытке видит **конкретный** diagnostic, не абстрактный "failed"
- ~150 LoC в `src/tools/verification.ts`

**C.Y. Failure-context propagation**
- Каждый failed attempt → в `metadata.previous_failures` добавляется:
  ```json
  {"attempt": 1, "edit_count": 7, "diff_summary": "+45 -12 in renderer.ts", "diagnostic": "Lighthouse=78, vendor-three.js 612KB"}
  ```
- Worker SKILL обязан читать `previous_failures` перед стартом
- ~80 LoC в atomic-release.ts + SKILL patch

---

## §5. Phase-план (обновлённый)

### Phase A — Cannon v2 baseline на ADR-014 (12-18 ч, human-in-loop)

**БЕЗ ИЗМЕНЕНИЙ** относительно исходного плана §1. Прогнать Cannon на новом pipeline (ADR-014) и собрать baseline до v2 правок.

**ВАЖНОЕ УТОЧНЕНИЕ:** сейчас уже запущен Sollar проект (id=1) на новом pipeline. Это и есть Phase A baseline. Ждём результата завтра.

### Phase B — Рефакторинг v2 (расширенный, 8-12 дней)

**Цель:** реализовать Tier 1 + Tier 2 (21 задача) параллельными субагентами.

**Precondition:** Phase A завершена, baseline записан, видно что ADR-014 сам по себе даёт прирост.

#### Phase B.1 — Подготовка (2-3 ч)
- Создать ветку `saga-v2-comprehensive` от master
- Backup skills
- Снять baseline `npm test`

#### Phase B.2 — Параллельные потоки A+B+C+D+E+G+H (6-8 дней)
8 субагентов одновременно, каждый со своим набором файлов.

#### Phase B.3 — Зависимый поток F (2-3 дня)
Тесты проверяют контракты всех 7 предыдущих потоков.

#### Phase B.4 — Каскадная проверка (1 день)
- `npm test` зелёный
- `npm run build` чистый
- CGAD lint 0 findings
- Кросс-потоковая целостность (10 проверок — расширение с 6)
- Smoke-test через saga E2E

### Phase C — Cannon v3 / Sollar v2 run (12-18 ч)
Прогнать ту же задачу на v2 коде, измерить прирост.

**Критерий успеха Phase C:** ≥ 800/1000 (T1) или ≥ 850/1000 (T1+T2).

### Phase D (опционально) — Tier 3 BMAD расширения (3-5 дней)
Если Phase C даёт ≥ 850 — добавляем B3 (forge), B4 (review crew), B5 (party mode) для добивания до 900+.

---

## §6. Риски и митигации (расширение)

| Риск | Вер. | Влияние | Митигация |
|---|---|---|---|
| Circuit breaker FP на легитимных retries | средняя | высокое | N=5 (не N=3), только consecutive identical, reset при другом tool_use |
| saga-arbiter принимает неверное решение | средняя | критическое | Subjective Logic uncertainty ≤ 0.5 + всегда log caveats. Откат: admin tool |
| Specialists плохо написаны → модель путается | высокое | среднее | Начать с 2 (perf, type), каждый ~500 строк |
| Build-gate ломает weak-model runs | среднее | среднее | Build-gate только для stage=S+ complexity. Для XS — опционально (`skip_build=true`) |
| Loop detector FP на verifier'ах | низкое | низкое | S1/S2 считает ТОЛЬКО consecutive identical |
| Model swap не работает на LM Studio build | среднее | низкое | Fallback на single-model. `SAGA_DISABLE_MODEL_SWAP=1` |
| **NEW:** Readiness gate слишком строгий (FAIL на нормальных планах) | среднее | высокое | Начать с CONCERNS (не FAIL), 3 iterations max |
| **NEW:** Retro генерирует шум вместо patterns | среднее | низкое | Min 3 эпизода до того как patterns становятся переиспользуемыми |
| **NEW:** Code Review Crew расходится во мнениях | высокое | среднее | Решающее голосо у craftsman (Dana-equivalent). Адверсариальные только советуют |
| **NEW:** Party Mode дорогая (много токенов) | высокое | низкое | Только для L/XL complexity. Для S/M — session mode |

---

## §7. Критерии успеха v2 (расширенные)

План успешен если после Phase C (Cannon v3 / Sollar v2 run):

1. **Автономия ≥ 90%** — ≤ 1 вмешательства человека (вместо 6)
2. **Build-gate работает** — 0 TS errors в src/, `npm run build` зелёный
3. **UI работает** — data flow не нарушен (OrbitResult отображается)
4. **Unverifiable ACs решаются arbiter'ом** — NFR-1/NFR-3 не блокируют pipeline
5. **SRS содержит §10/§11/§12** — deployment, integrations, decision log
6. **Нет зомби** — pump-loop и worker_health согласованы
7. **Loop detector ловит IAL** — S1/S2 trip на 5-м identical tool_use
8. **NEW: Readiness gate** — ≥ 1 adversarial check перед development, 0 FAIL
9. **NEW: Retrospective** — ≥ 3 patterns в project.notes после эпизода
10. **NEW: Code reviewer** — 0 scratch-файлов в git, все файлы < 500 строк (или обоснование)
11. **Итоговый балл ≥ 800/1000** (T1) или ≥ 850/1000 (T1+T2)

---

## §8. Что НЕ вошло в скоуп v2 (явно)

Следующие идеи обсуждались, но **отложены** до v3:

| Идея | Почему отложена |
|---|---|
| **bmad-forge-idea** (Tier 3) | Discovery уже работает (Cannon/Sollar стартуют). Forge — nice-to-have |
| **Code Review Crew** (Tier 3) | Требует 5 sub-skills (~800 LoC). saga-code-reviewer (одна линза) даёт 80% эффекта за 20% работы |
| **Party Mode** (Tier 3) | ~1000 LoC, спорный ROI для pipeline задач. Полезна для research/brainstorm, не для execution |
| **Stakeholder registry** в PRD (N4) | Минимальный эффект для single-team разработки |
| **Project Profile** на Complexity Gate (N5) | Требует создания 5 профилей. Сейчас complexity→architecture таблица решает главное |
| **Make/buy/integrate policy** (N6) | Для single-team разработки не критично |
| **HTML keepsakes** (BMAD) | Эстетика, не функциональность |
| **UX spine pair** (DESIGN.md + EXPERIENCE.md) из BMAD | UC покрывает сценарии достаточно для current pipeline |
| **Modules концепция** (BMAD) | У saga уже есть skills — это эквивалент |

---

## §9. Связь с предыдущим планом

Этот документ **НЕ заменяет** `SAGA-V2-PRODUCTION-READINESS.md`, а **расширяет** его:

- **§2, §3, §4** исходного плана остаются canonical (6 потоков + 6 этапов)
- Этот документ добавляет **2 новых потока** (G: REVIEWER+RETRO, H: READINESS+POLICY)
- Этот документ добавляет **5 новых задач** (saga-code-reviewer, saga-retrospective, saga-readiness-checker, deterministic tool gate, failure-context propagation)
- Этот документ явно перечисляет **9 пробелов** (N1-N9), которые были упомянуты в research-документах, но не попали в исходный план
- Этот документ фиксирует **5 идей из BMAD method** с оценкой заимствования

**Рекомендация:** при реализации Phase B держать ОБА документа открытыми. Исходный — как детальный план для 6 потоков. Этот — как карту что ещё надо сделать.

---

## §10. История изменений

- **2026-07-21 v1:** создан. Комплексный пересмотр скоупа с интеграцией:
  - 9 пробелов (N1-N9) из research-документов
  - 5 идей из BMAD method
  - расширение с 6 до 8 потоков
  - 3-уровневая приоритизация (T1/T2/T3)
  - целевой балл 900+ при полном v2 (T1+T2+T3)
- **2026-07-21 v2:** ADDENDUM после Sollar A/B-теста (см. §11). Соседняя
  сессия нашла 4 бага (T-006..T-009), 2 из которых (T-006, T-008) уже в
  master. Добавлены 2 новые задачи: T-007 (already_in_dev) и T-009
  (verification.ac tracker_only). Обновлены владения файлов (§12).

---

## §11. ADDENDUM после Sollar A/B-теста (2026-07-21)

Соседняя сессия провела A/B-тест pipeline ADR-014 на эпизоде Sollar (та же
задача + модель, что Cannon baseline 661/1000). Нашла 4 критичных бага,
которые относятся к этому v2 рефакторингу. Полный отчёт:
`docs/research/testing-2026-07-21-sollar-new-pipeline.md`.

### §11.1. Что уже в master (T-006 + T-008) — НЕ дублировать

| ID | Фикс | Файлы | Коммит |
|---|---|---|---|
| **T-006** | `worker_next` выдаёт ВСЕ приоритеты (был priority IN medium+) | `src/tools/dispatcher.ts`, `src/orchestrate.ts` | `95a9049` |
| **T-008** | Kanban dispatch (review раньше todo) + conflict-key gate + reviewer-does-merge | `src/tools/dispatcher.ts`, `skills/saga-worker/SKILL.md` | `c90c436` |

**Эти файлы теперь ЧАСТИЧНО ЧУЖИЕ.** Мои правки должны наслаиваться, не
затирая. См. обновлённую карту владений в §12.

### §11.2. Новые задачи (T-007 + T-009) — ДОБАВИТЬ в скоуп

#### **T-007. `integration_state='already_in_dev'` для no-op dev-задач**

**Проблема:** AC-4.4 (Empty Saved Scenarios) — edge-case, уже реализованный в
#17 (AC-4.1) и #20 (AC-4.2). Worker #28 взял задачу → увидел код уже в dev →
legitimately закрыл через `worker_done` без commit → `integration_state=""` →
gate трактует как «зависло» → 4 recovery в цикле.

**Корень:** design bug в gate. Нет статуса для задач, чьи depends_on уже
merged в ту же ветку.

**Решение (3 части):**

1. **Новый `integration_state='already_in_dev'`** — для dev-задач, где код уже
   в integration-ветке через depends_on. Gate development→verification
   принимает наравне с `merged`.
   - Файл: `src/tools/lifecycle.ts` (`assertTasksReady` или эквивалент)
   - Объём: ~30 LoC

2. **`worker_done({verdict: 'no_op'})`** — новое значение verdict для
   dev-задач, где код уже был. Saga-core автоматически ставит
   `integration_state='already_in_dev'` и ссылается на depend_on-commit.
   - Файл: `src/tools/dispatcher.ts` (`worker_done` handler), `src/db.ts` (CHECK constraint)
   - Объём: ~80 LoC

3. **`autonomous-recovery` должен уметь ставить `integration_state='merged'`**
   со ссылкой на depend_on-commit, если код подтверждён в integration-ветке.
   - Файл: `skills/autonomous-recovery/SKILL.md` (DIAGNOSE фаза)
   - Объём: ~30 строк SKILL

**Приоритет:** T1 (обязательно) — критичен для edge-case AC.

#### **T-009. `verification.ac` → `execution_mode=tracker_only`**

**Проблема:** `verification.ac` задачи получают `execution_mode=git_change`
из planner'а, хотя они только записывают verification_evidence. Это создаёт
ложные pending-merge'и (#25, #29 пришлось вручную помечать merged).

**Корень:** planner не различает dev и verification по execution_mode.

**Решение:** в `saga-planner/SKILL.md` явно указать:
```
при создании verification.ac задачи → execution_mode='tracker_only'
при создании development.code → execution_mode='git_change'
```

**Приоритет:** T1 (обязательно) — простая правка SKILL, убирает класс ошибок.
- Файл: `skills/saga-planner/SKILL.md`
- Объём: ~20 строк SKILL

### §11.3. Обновлённый счётчик задач

| Tier | Было | Стало | Дельта |
|---|---:|---:|---:|
| T1 | 15 | **17** | +2 (T-007, T-009) |
| T2 | 6 | 6 | 0 |
| T3 | 6 | 6 | 0 |
| **Итого v2** | 27 | **29** | +2 |

---

## §12. Обновлённая карта владений файлов (после T-006/T-008)

Эти файлы теперь **содержат чужие фиксы**. Мои правки должны наслаиваться.

| Файл | Чужой фикс (НЕ стирать) | Мои правки |
|---|---|---|
| `src/tools/dispatcher.ts` | T-006 (priority filter removed), T-008 (kanban ORDER BY + conflict-key gate) | Этап 3.5: attempt_history append при claim; T-007 verdict='no_op' |
| `src/orchestrate.ts:412` | T-006 (countActiveTasks priority filter removed) | Этап 3.4: zombie detect, circuit breaker, concurrency-per-model, model swap |
| `skills/saga-worker/SKILL.md` | T-008 (MERGE-BACK секция: reviewer обязан merge) | Этап 2 поток C: build-gate (4 команды из §9) |
| `CHANGELOG.md` | T-006, T-008 entries | Этап 5.6: v2 entry |
| `docs/research/testing-2026-07-21-sollar-new-pipeline.md` | live отчёт соседней сессии | НЕ ТРОГАТЬ — будет финализирован после Sollar completion |

### §12.1. Новые файлы-источники для тест-кейсов

`docs/research/testing-2026-07-21-sollar-new-pipeline.md` — **живой материал
для тестов v2**. Конкретные кейсы:

| Кейс | Что тестирует |
|---|---|
| T-001 | ложная тревога patrol на thinking-моделях |
| T-002 | autonomous recovery без оператора (positive case) |
| T-006 | cascade-recovery-loop из-за priority=low |
| T-007 | recovery-loop для edge-case AC (no_op verdict) |
| T-008 | merge-окно 76 сек → conflict (reviewer-does-merge) |

Каждый из T-006..T-009 должен быть покрыт **NEW тестом** в Этапе 4.

### §12.2. Этап 4 (NEW tests) — обновлённый список

К оригинальным 9 NEW тестам добавляются:
- `tests/lifecycle/dispatch-all-priorities.test.mjs` — T-006 regression
- `tests/lifecycle/no-op-dev-task.test.mjs` — T-007 (verdict=no_op, already_in_dev)
- `tests/lifecycle/verification-tracker-only.test.mjs` — T-009 (execution_mode=tracker_only)
- `tests/lifecycle/conflict-key-gate.test.mjs` — T-008 regression (kanban + conflict-key)

Итого Этап 4 теперь = **13 NEW тестов** (вместо 9).

---

## §13. Координация с соседней сессией

### §13.1. Что соседняя сессия делает СВОЕЙ итерацией

- Патчит `skills/saga-patrol/patrol.mjs` (saga-patrol skill refinement)
- Патчит `skills/autonomous-recovery/SKILL.md` (DIAGNOSE фаза для T-007)
- Финализирует `docs/research/testing-2026-07-21-sollar-new-pipeline.md`
- Делает финальный 1000-score аудит Sollar после completion

### §13.2. Что я делаю в v2-comprehensive

- Все правки в `src/` (dispatcher.ts, orchestrate.ts, lifecycle.ts, workflow.ts,
  tasks.ts, atomic-release.ts, claude-runner.mjs, helpers/metadata.ts)
- Все NEW skills (arbiter, perf-tuner, type-fixer, code-reviewer, retro,
  readiness-checker, forge, crew, party-mode)
- T-007 (already_in_dev) и T-009 (verification.ac tracker_only) — архитектурно
- Все templates (SRS §10/§11/§12, PRD stakeholder)
- Все 13 NEW tests в Этапе 4

### §13.3. Разделение владений (окончательное)

| Файл/зона | Соседняя | Я |
|---|---|---|
| `src/**` (кроме правок соседа T-006/T-008) | — | ✅ |
| `skills/saga-patrol/**` | ✅ | — |
| `skills/autonomous-recovery/SKILL.md` | ✅ (DIAGNOSE T-007 hook) | — |
| `skills/saga-worker/SKILL.md` | ✅ (MERGE-BACK уже сделано) | ✅ (build-gate поверх) |
| `skills/saga-planner/SKILL.md` | — | ✅ |
| Все остальные skills | — | ✅ |
| `docs/research/testing-2026-07-21-*.md` | ✅ (live отчёт) | — |
| `docs/plans/SAGA-V2-*.md` | — | ✅ |
| Tests | — | ✅ |
| CHANGELOG.md | добавил T-006, T-008 | добавит v2 entry |
