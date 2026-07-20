# Сага-mcp: перестановка SRS после AC — рабочее задание для новой сессии

## Контекст проекта (Память)

Ты — агент, работающий с проектом **saga-mcp** (форк `PortnovAlex80/saga-mcp`). Это governance-платформа для параллельных LLM-агентов: discovery → formalization → planning → development → verification → integration.

### Окружение (Windows, Git Bash)
- **Репозиторий saga-mcp:** `D:/Разработка/saga-mcp` (ветка `master`, remote `origin`)
- **Рабочая БД saga:** `C:/Users/user/.zcode/saga.db`
- **Канбан:** `http://localhost:4321` (tracker-view.mjs)
- **Docs-graph:** `http://localhost:4322`
- **LM Studio:** `http://localhost:1234` (модель `qwen3.6-35b-a3b@q4_k_xl` — загружена)
- **Claude CLI:** v2.1.215+ (поддерживает `--forward-subagent-text`)
- **Запущенные процессы saga:** обычно 3 инстанса `dist/index.js` (по одному на каждую ZCode-сессию) + `tracker-view.mjs` + `docs-graph/server.mjs`. При работе будь осторожен с их перезапуском — tracker-view (порт 4321) должен слушать.

### Состояние кода saga-mcp
- Последний коммит в master: `0f2b086 fix(lmstudio): two-template settings switching + atomic fsync + DB-init guard` (уже в remote)
- Этот фикс уже смержен — НЕ трогать повторно. Речь идёт о **новой работе**: перестановка pipeline.

### Рабочий эпизод Cannon REQ-001 (полигон)
- **Проект:** `Cannon-\`` (в `D:/Development/Cannon-\``) — калькулятор баллистических траекторий
- Saga-эпизод прошёл: discovery → formalization → planning → development (частично)
- Артефакты (47 шт.): PRD, SRS, UC×6, AC×15 (7 FR + 7 NFR + AC-7), FR×7, NFR×7, RULE×3, ADR, hypotheses, metrics
- Работает на LM Studio, локальная модель
- **Главная проблема эпизода:** saga-architect выбрал Hexagonal/Ports для M-size задачи (over-engineering), planner вслепую создал 15 dev-задач, воркеры тратят ~7 Read на exploration структуры

### Документация в saga (notes в saga.db)
- **note #1** — research подходов к декомпозиции (14 SE-подходов, что saga использует, что упущено)
- **note #2** — план перестановки SRS после AC

---

## Что нужно сделать (главное задание)

**Реализовать перестановку шага Architecture (SRS) с позиции "до AC" на позицию "после AC"** + связать Complexity Gate с архитектором + добавить секцию DECOMP §D с per-AC mapping в SRS.

### Корень проблемы
Сейчас: `PRD → [SRS+UC] → AC → Reconcile → Planning` — архитектор выбирает стиль вслепую (без знания AC).
Должно: `PRD → UC → AC → Reconcile → SRS+DECOMP → Planning` — архитектор видит замороженные AC и их сложность.

### Целевой pipeline (канон)

```
BRIEF → PRD (с FR/NFR/RULE) → UC → AC → Reconcile → SRS+DECOMP → Planning → Dev → Verify → Integrate
```

### FR/NFR/RULE переезжают из SRS в PRD
Раньше SRS смешивал "ЧТО" (FR/NFR/RULE) и "КАК" (архитектура). Теперь:
- **PRD** владеет ЧТО: scope, success criteria, hypotheses, **FR/NFR/RULE**
- **SRS** владеет КАК: архитектурный стиль, Module Manifest, Port Registry, Invariant Registry, tech stack, **§D DECOMP**

### Новая последовательность transitions (workflow.ts)

| task_kind | transition | что создаёт |
|---|---|---|
| `discovery.kickstart` | `brief_accepted` | `formalization.prd` (как раньше) |
| `formalization.prd` | `prd_accepted` | **ТОЛЬКО `formalization.uc`** (не SRS+UC) |
| `formalization.uc` | `uc_accepted` | `formalization.ac` (без ожидания SRS) |
| `formalization.ac` | `ac_accepted` | `formalization.reconciliation` (без dep на SRS) |
| `formalization.reconciliation` | `baseline_accepted` | `formalization.srs` (НОВОЕ — SRS после AC) |
| `formalization.srs` | `srs_accepted` (НОВЫЙ) | `planning.decomposition` |

### Формат DECOMP §D (новая секция SRS)

```yaml
# §D1 File Tree (canonical, scaffold обязан следовать)
# §D2 AC → Implementation Map (одна строка на AC)
- ac: AC-1
  title: "..."
  module: physics
  files: [src/physics/orbital.ts]
  functions: [calculateOrbit]
  types: [LaunchParameters, OrbitResult]
  public_protocol: PhysicsEnginePort
  conflict_keys: [{key_type: file_path, key_value: 'src/physics/orbital.ts'}, ...]
  invariants: [INV-PHYS-1, INV-PHYS-3]
  ac_kind: implementation   # implementation | verification | spike | merge_with
  depends_on: [scaffold:physics]
# §D3 Priority rationale
# §D4 Pattern selection per module cluster
```

### Таблица complexity → architecture (обязательная для saga-architect)

| complexity.tshirt | topology_hint | Архитектурный стиль | Pattern | Кол-во задач |
|---|---|---|---|---|
| XS | sequence | KISS | Single | 1 |
| S | sequence | KISS / Module | Pattern A | 1-2 |
| M | sequence | Modular Monolith | Pattern A | 2-4 |
| M | scaffold-then-parallel | Modular Monolith + Ports | Pattern B | 4-8 |
| L/XL | scaffold-then-parallel | Hexagonal / Ports | Pattern B | 8-15 |
| L/XL | sequence | Layered | Pattern A + spikes | 5-12 |
| research | any | Spike-first | Spike → re-plan | N+M |

---

## План работы

### ОБЯЗАТЕЛЬНО прочитать перед стартом

1. **Полный план:** `D:/Разработка/saga-mcp/docs/plans/PIPELINE-REORDER-SRS-AC.md` (664 строки, 117 чекбоксов, 9 секций)
2. **Декомпозиция для субагентов:** `D:/Разработка/saga-mcp/docs/plans/PIPELINE-REORDER-SRS-AC-SUBAGENTS.md`
3. **Research-фон:** saga note #1 (можно прочитать через MCP `mcp__saga__note_list` или SQL к saga.db, таблица `notes`)

В этих файлах — детальный план с обоснованием, перекрёстными проверками, оценкой рисков.

### Декомпозиция на 6 потоков для параллельной работы

| Поток | Имя | Владение файлами | Старт | Время |
|---|---|---|---|---|
| **A** | CORE | `src/tools/workflow.ts`, `src/tools/lifecycle.ts`, `src/orchestrate.ts` | параллельно | 4-6 ч |
| **B** | PRODUCT | `skills/saga-product/SKILL.md`, `docs/requirements/templates/{PRD,SRS,INVARIANCES}.md` | параллельно | 3-4 ч |
| **C** | ARCHITECT | `skills/saga-architect/SKILL.md`, `skills/saga-architecture-reviewer/SKILL.md` | параллельно | 4-6 ч |
| **D** | ANALYST+PLANNER | `skills/saga-{analyst,planner,orchestrator,reconciler,requirements-reviewer,senior-analyst,autonomous-recovery}/SKILL.md` (7 файлов) | параллельно | 4-6 ч |
| **E** | DOCS | `README.md`, `README.ru.md`, `docs/{INSTALL,saga-flow-overview,saga-mcp-3.0-pipeline-ui-spec,blog-saga-mcp-agent-governance,saga-mcp-history,srs-br-and-traceability,saga-mcp-3.0-orchestration}.md`, `docs/architecture/decisions/{008-brief-accepted-prd-only,012-multi-track-pipeline}.md`, НОВЫЙ `013-pipeline-reorder-srs-after-ac.md` | параллельно | 4-6 ч |
| **F** | TESTS | `tests/lifecycle/{formalization-mechanics,traceability-gate}.test.mjs`, `tests/product-workflow.test.mjs`, опц. `tests/{track-pipeline,fast-track/fast-track,migrations/migration-tests}.test.mjs` | **после A** | 8-12 ч |

### Фазы запуска

```
Фаза 1 — ПАРАЛЛЕЛЬНО (5 агентов): A + B + C + D + E
Фаза 2 — после A:                  F (TESTS)
Фаза 3 — каскадная проверка:       6 кросс-потоковых + smoke-test
```

---

## До начала работы — ОБЯЗАТЕЛЬНО

### 1. Подготовка git
```bash
cd "D:/Разработка/saga-mcp"
git checkout master && git pull
git checkout -b pipeline-reorder-srs-ac
cp -r skills skills.backup.YYYYMMDD
npm test 2>&1 | tee tests-baseline.log
```

### 2. Проверка целостности (5 проверок из плана §1)
- [ ] 1.1 Complexity Gate существует: `src/validators/brief.ts:36-65` содержит `BriefPayload.complexity.tshirt`, `topology_hint`, `shared_mutation_risk`
- [ ] 1.2 saga-architect SKILL НЕ ссылается на complexity (grep возвращает 0)
- [ ] 1.3 На Cannon timestamps: SRS создан раньше AC? (SQL к saga.db)
- [ ] 1.4 Все dev-задачи Cannon не содержат `metadata.target_file` (подтверждает проблему)
- [ ] 1.5 `assertTraceability` проверяет рёбра, не порядок — граф корректен после перестановки

---

## Запуск субагентов (Фаза 1)

Для каждого потока используй `Agent` tool со следующим шаблоном (адаптируй под конкретный поток):

```
Ты — субагент в параллельной команде, выполняющей перестановку SRS после AC в saga-mcp.

## ОБЯЗАТЕЛЬНО прочитать перед стартом
1. ОБЩИЙ КОНТРАКТ: D:/Разработка/saga-mcp/docs/plans/PIPELINE-REORDER-SRS-AC-SUBAGENTS.md §1
2. ПОЛНЫЙ ПЛАН (вся контекст): D:/Разработка/saga-mcp/docs/plans/PIPELINE-REORDER-SRS-AC.md
   особенно §2 (целевая архитектура), §3 (инвентаризация), §4 (свой этап)

## Твой поток: <ИМЯ_ПОТОКА>

## Файлы под твоим владением (ТОЛЬКО эти)
<список файлов из §3 спецификации соответствующего потока>

## Запрещено трогать
<список владений других потоков — из SUBAGENTS.md §2>

## Задача
<детальная спецификация из SUBAGENTS.md §3 для твоего потока>

## По завершении
- Сообщи список изменённых файлов
- Для каждого файла — краткое summary что изменено
- НЕ делай commit (это сделает оркестратор после каскадной проверки)
```

**Потоки для Фазы 1 (запускать в одном сообщении, параллельно):**
- A: CORE (src/tools/workflow.ts, lifecycle.ts, orchestrate.ts)
- B: PRODUCT (skills/saga-product, templates)
- C: ARCHITECT (skills/saga-architect, architecture-reviewer)
- D: ANALYST+PLANNER (7 SKILLs)
- E: DOCS (12 docs + 2 ADR + новый ADR-013)

Каждый агент получает полный общий контракт (читает сам) + конкретную спецификацию своего потока.

---

## После Фазы 1 — запуск Фазы 2

Когда поток A (CORE) завершён — запускай поток F (TESTS). Спецификация — в SUBAGENTS.md §3.F.

Поток F проверяет transitions, построенные потоком A. Без завершенного A тесты писать нельзя.

---

## Фаза 3 — Каскадная проверка

После завершения всех 6 потоков выполнить последовательно:

### Проверка 3.1 — Сборка
```bash
cd "D:/Разработка/saga-mcp"
npm run build    # TypeScript strict, без ошибок
npm run lint     # ESLint, без ошибок
```

### Проверка 3.2 — Тесты
```bash
npm test         # все зелёные
```
Если упали — найти какой поток виноват (по типу ошибки), вернуть задачу.

### Проверка 3.3 — CGAD lint
```bash
node tools/cgad-spec-lint.mjs "C:/Users/user/.zcode/saga.db"   # 0 findings
```

### Проверка 3.4 — Кросс-потоковая целостность (6 проверок)

Прогнать вручную через SQL/cat:

- [ ] **3.4.1.** `workflow.ts` transitions (поток A) совпадают с тестами (поток F): `prd_accepted` → только UC, `baseline_accepted` → SRS, `srs_accepted` → planning
- [ ] **3.4.2.** `saga-product SKILL` (поток B) создаёт FR/NFR/RULE с `derived_from` PRD — соответствует `saga-requirements-reviewer` (поток D) проверке AC→FR
- [ ] **3.4.3.** `saga-architect SKILL` (поток C) пишет §D DECOMP в формате, который `saga-planner SKILL` (поток D) умеет парсить
- [ ] **3.4.4.** `saga-architect SKILL` (поток C) таблица complexity→architecture соответствует контракту
- [ ] **3.4.5.** `README.md` (поток E) pipeline совпадает с `saga-orchestrator SKILL` (поток D) и `workflow.ts` (поток A)
- [ ] **3.4.6.** `saga-architect SKILL` (поток C) precondition SRS после baseline соответствует `workflow.ts:baseline_accepted` (поток A) создающему SRS

### Проверка 3.5 — Smoke-test через saga

- [ ] Создать новый тестовый эпизод S-size (например "deposit calculator") через `Skill("saga-start")`
- [ ] Прогнать через новый pipeline на LM Studio
- [ ] Проверить артефакты: PRD с FR/NFR, UC по PRD, AC по PRD, SRS после AC
- [ ] Проверить DECOMP §D присутствует в SRS
- [ ] Проверить dev-задачи содержат `metadata.target_file` (planner их скопировал из §D)
- [ ] Проверить architecture выбрана по complexity (KISS/Modular для S-size, не Hexagonal)

---

## Финал

- [ ] Все 6 потоков отчитались списком изменённых файлов
- [ ] Файлы между потоками не пересекаются (git status показывает чистую картину)
- [ ] Все проверки 3.1-3.5 зелёные
- [ ] Commit: `feat(pipeline): reorder SRS after AC + complexity gate + DECOMP`
- [ ] Обновить CHANGELOG.md
- [ ] Создать PR или merge в master

---

## Ключевые блокеры (без них перестановка невозможна)

1. **`saga-requirements-reviewer:27`** — проверка `AC derived_from → FR/NFR` сломается. Решение: FR/NFR переезжают в PRD (поток B), reviewer обновляется (поток D).
2. **`saga-reconciler`** — baseline_hash замораживается ДО SRS. SRS проверяется отдельно через `assertTasksReady('formalization')`.
3. **`workflow.ts:251-284`** — `ac_accepted` deps на SRS-сиблинга. Убрать dep, SRS создаётся позже.
4. **`seedTraceabilityPyramid`/`buildCompletePyramid` helpers в тестах** — общие для многих случаев, правка каскадно обновит тесты.

---

## Риски и митигации

| Риск | Митигация |
|---|---|
| Сломаются существующие эпизоды в БД (Cannon) | Не мигрировать; Cannon остаётся как есть |
| Воркеры путаются в новых SKILLs | Smoke-test 3.5 на S-size эпизоде |
| Архитектор перегружен DECOMP §D | Fallback: если DECOMP не создан → planner работает по старому алгоритму |
| Тесты ломаются массово | Этап 9 самый дорогой (8-12 ч), заложить время |
| ADR-008 rationale инвалидирован | Поток E пишет addendum + новый ADR-013 |
| Complexity Gate данные не доходят до архитектора | В SKILL архитектора явный `artifact_get(brief)` шаг |

---

## Что НЕ делать

- НЕ трогать `src/validators/brief.ts` (complexity уже правильно определён)
- НЕ трогать `tools/cgad-spec-lint.mjs` (R3/R13/R15/R17/R18 работают с accepted-артефактами, не с порядком)
- НЕ трогать `src/planner/topology.ts`, `cascade.ts`, `fast-track.ts` (Pattern A/B, не formalization)
- НЕ мигрировать Cannon эпизод (старый pipeline)
- НЕ трогать коммит `0f2b086` (LM Studio фикс — уже в master)
- НЕ пушить в master без прохождения всех проверок 3.1-3.5

---

## Управление ожиданиями

- **Время:** 38-60 ч чистой работы, 6-8 дней календарно с учётом параллельности и ожидания saga на LM Studio
- **Объём:** ~2400-3300 LoC через 37 файлов
- **Главный риск:** кросс-потоковая целостность (контракты между потоками могут расходиться)
- **Откат:** ветка не мержится, `cp -r skills.backup.YYYYMMDD skills` восстанавливает SKILLs

---

## Стартовая команда

Прочитай план и декомпозицию:
```bash
cat "D:/Разработка/saga-mcp/docs/plans/PIPELINE-REORDER-SRS-AC.md"
cat "D:/Разработка/saga-mcp/docs/plans/PIPELINE-REORDER-SRS-AC-SUBAGENTS.md"
```

Проверь состояние:
```bash
cd "D:/Разработка/saga-mcp" && git status && git log --oneline -3
curl -s -o /dev/null -w "tracker-view: %{http_code}\n" http://localhost:4321/api/heartbeat
```

Создай ветку:
```bash
cd "D:/Разработка/saga-mcp" && git checkout -b pipeline-reorder-srs-ac
```

Запускай Фазу 1 — 5 агентов параллельно (A, B, C, D, E).

Удачи. Действуй.
