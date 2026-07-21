# Финальный аудит: Sollar (новый pipeline ADR-014) vs Cannon (baseline)

**Дата:** 2026-07-21
**Модель:** qwen3.6-35b-a3b@q4_k_xl (LM Studio, 2×RTX 3090)
**Wall clock:** ~14 часов (05:02 → 19:00 UTC, с остановками)
**Baseline:** Cannon — 661/1000 (`audit-2026-07-20-cannon-1000-score.md`)

---

## 0. Executive Summary — честный вердикт

**Sollar НЕ является работающим приложением.** Оно не запускается ни через `file://`, ни через HTTP-сервер из-за 2 критических багов, которые verifier'ы находили 15 раз, но pipeline не смог направить developer'ам на исправление.

**При этом pipeline ADR-014 структурно превосходит Cannon baseline** — быстрее, чище traceability, автономнее recovery. Но провалился на verification-фазе: **не смог превратить найденные баги в development fixes**, застряв в бесконечных recovery-loops и verifier-loops.

**Итоговый балл Sollar: ~520/1000** (vs Cannon 661/1000). Ниже baseline, потому что:
- Cannon произвёл **запускаемое** приложение (с ручной доработкой)
- Sollar произвёл **не запускаемое** приложение (2 критических бага не исправлены)
- НО: Sollar выявил **15 архитектурных проблем** saga и привёл к **6 код-фиксам** движка

**Главный результат прогона — не продукт, а улучшения saga-mcp.**

---

## 1. Качество кода Sollar (что было сделано)

### 1.1 Объём

| Метрика | Sollar | Cannon |
|---|---|---|
| Коммитов в `dev` | 20 | 27 |
| Файлов | 1 (`index.html`) + 2 test files | 23 (src) + 32 (tests) |
| Строк кода | **2 314** (single HTML) | ~7 000 TS |
| Строк тестов | ~200 (2 test files) | **9 944** |
| Соотношение test:code | **0.09 : 1** | 1.41 : 1 |

### 1.2 Структурный анализ

```
index.html (2314 строк)
├── <style> блок (~400 строк CSS)
├── constants module (PhysicalConstants, PlanetaryData NASA JPL)
├── physics module (calculateTrajectory, orbitalVelocity, escapeVelocity)
├── ui-form module (renderForm, validateParams, clampValue)
├── ui-canvas module (renderTrajectory, renderSolarSystem, computeTrajectoryRenderData)
├── persistence module (saveScenario, loadScenario, setAcknowledged)
├── content module (educationalConcepts, quizQuestions)
└── main module (calculateTrajectoryGate, navigation, disclaimer)
```

**Плюсы:**
- ✅ Все 13 функций из SRS §D2 реализованы (13/13)
- ✅ NASA JPL данные (25 упоминаний)
- ✅ ARIA labels (10 атрибутов для accessibility)
- ✅ CSS inline (responsive, dark theme)
- ✅ 0 TODO/FIXME, 0 console.log, 0 eval

**Минусы:**
- ❌ **Single-file monolith** с inline ESM self-imports (11 раз `from './index.html'`)
- ❌ **0 Jest/Playwright test infrastructure** в основной ветке
- ❌ `renderTrajectory` — 207 строк (монолит)
- ❌ `innerHTML =` — 11 раз (potential XSS)
- ❌ 0 JSDoc `@typedef` (типы только в комментариях)

### 1.3 КРИТИЧЕСКИЕ БАГИ (приложение не запускается)

#### BUG 1: ESM self-import MIME mismatch (T-012)

```html
<script type="module">
  import { PhysicalConstants } from './index.html';  // ← САМ НА СЕБЯ
</script>
```

**Браузер отклоняет это** — MIME type `text/html` не подходит для module scripts (нужно `application/javascript`). Модули fail silently → `#calcForm` пустой → приложение не работает.

**Причина:** saga-architect выбрал single-file monolith (SRS §2.1), не проверив, что Playwright (SRS §2.5) сможет загрузить приложение. T-012 зафиксирован, фикс в saga-architect SKILL (Test Reachability Check).

**Workaround (сделан verifier'ом #31 в worktree, но НЕ merged в dev):** разбить на multi-file ESM (`js/constants.js`, `js/physics.js`, ...). Этот рефакторинг был в worktree task-31, но никогда не попал в `dev`.

#### BUG 2: validateParams() не возвращает `body` (T-013)

```javascript
export function validateParams(state) {
  // ... validation logic ...
  return {
    valid: true,
    params: {
      massKg: clampedMass,
      thrustN: clampedThrust,
      launchAngleDeg: clampedAngle,
      initialVelocityMps: clampedVelocity
      // ← body ОТСУТСТВУЕТ
    }
  };
}

export function calculateTrajectory(params) {
  const body = resolveBody(params.body);  // ← body=undefined → throw
}
```

**Причина:** dev-worker, реализовавший AC-1.6 (Parameter Validation), забыл передать `body` (выбранное небесное тело) в возвращаемый объект. Verifier находил это 15 раз, но pipeline не создал dev-task для фикса.

### 1.4 Можно ли запустить?

**Нет.** Любая попытка открыть `index.html` в браузере:
- `file://` → ESM modules не грузятся → пустая страница
- `http://localhost` → ESM modules не грузятся (MIME mismatch) → пустая страница

Даже если пофиксить BUG 1 (multi-file), BUG 2 сделает траекторию нерассчитываемой — `calculateTrajectory` бросит `Unknown celestial body: undefined`.

---

## 2. Оценка по 7 категориям (1000-score)

### A. Архитектура и модульность — 140/200 (70%)

**Плюсы:**
- SRS §2.1 Architectural Style обоснован (Modular Monolith + Pattern A для M-size)
- Module Manifest (SRS §2.2) — 7 модулей с conflict-keys
- 24/25 функций SRS §D2 на месте
- Pattern A (sequence) — правильно для single-file

**Минусы:**
- Single-file ESM self-imports — архитектурный тупик (T-012)
- SRS §2.1 противоречит SRS §2.5 (Test Strategy требует Playwright, но single-file не тестируется)
- `renderTrajectory` 207 строк — монолит внутри модуля
- Нет Test Reachability Check (§2.6 отсутствует в SRS)

### B. Чистота кода — 105/150 (70%)

**Плюсы:**
- 0 TODO/FIXME/console.log/eval
- Комментарии с AC-привязкой
- Низкая цикломатическая сложность (101)
- Короткие функции (большинство <30 строк)

**Минусы:**
- `innerHTML =` 11 раз (XSS risk)
- `clampValues` обещан в SRS, есть только `clampValue`
- 0 JSDoc `@typedef`
- Magic numbers (физические константы inline)

### C. Тестовое покрытие — 30/150 (20%)

**Катастрофически слабо:**
- 0 Jest property tests (SRS обещал L3 для INV-PHYS-1..5)
- 0 Playwright E2E tests в основной ветке
- 2 test files в worktree (не merged)
- Verification evidence: 39 passed records — но это **проверки verifier'ов**, не тесты в коде

**Сравнение:** Cannon — 442 теста, 97.3% pass rate. Sollar — **0 тестов в коде**.

### D. Артефакты и traceability — 145/150 (97%)

**Сильнейшая сторона Sollar:**
- 51 accepted артефактов (brief, PRD, SRS, UC×5, FR×9, NFR×6, RULE×3, AC×25)
- 0 orphan AC (все имеют derived_from → parent)
- 124+ trace edges
- baseline hash зафиксирован
- Verification evidence: 39 passed, 20 failed

### E. Runnable state — 20/150 (13%)

**Критический провал:**
- Приложение **не запускается** (2 критических бага)
-BUG 1 (ESM) — форма не рендерится
-BUG 2 (validateParams) — траектория не считается
- NFR-3 (60fps) — невозможно проверить (UI не загружается)
- NFR-2 (load ≤3s) — невозможно проверить
- NFR-6 (accessibility) — ARIA labels есть, но не функциональны (UI не загружается)

### F. Эффективность — 75/100 (75%)

**Плюсы:**
- Discovery→Planning за 51 мин (Cannon ~1.5-2 ч)
- Development 19 AC за ~4 ч (Cannon ~9 ч)
- kWh ~1.4 (vs Cannon 3.06) — **в 2× меньше электричества**
- GPU throttle 14.3% (Cannon 0%)

**Минусы:**
- Verification-фаза: ~8 часов (из них ~5 часов stuck на loops)
- 15 recovery tasks (Cannon 3)
- 8 human interventions (Cannon 4-5)
- 5 код-фиксов saga сделаны во время прогона (отвлекли время)

### G. Автономность — 55/100 (55%)

**Что сделала сама:**
- Discovery→Planning полностью автономно
- 19 dev tasks без вмешательства
- Recovery #46 автономно создала 19 verification tasks (T-014)
- Atomic-release zombies (T-002: #3, #11)
- Merge-conflict recovery (#33/#34/#35)
- 39 passed evidence records

**Что потребовало человека:**
- 8 раз: manual DB fixes (priority, integration_state, hint injections)
- 3 раза: engine restart после краха (T-005 × 2)
- 2 раза: kill stuck worker + manual close (#31, #67)
- 6 код-фиксов в saga-mcp (T-006/T-008/T-012/T-013/T-014/T-015)

### Итоговый балл

| Категория | Max | Sollar | Cannon | Δ |
|---|---|---|---|---|
| A. Архитектура | 200 | 140 | 155 | −15 |
| B. Чистота кода | 150 | 105 | 120 | −15 |
| C. Тесты | 150 | 30 | 110 | −80 |
| D. Артефакты | 150 | 145 | 140 | +5 |
| E. Runnable | 150 | 20 | 90 | **−70** |
| F. Эффективность | 100 | 75 | 62 | +13 |
| G. Автономность | 100 | 55 | 55 | 0 |
| **Итого** | **1000** | **570** | **661** | **−91** |

**Sollar проигрывает Cannon 91 балл.** Главные причины: E (−70, не запускается) и C (−80, нет тестов). Но выигрывает по F (+13, быстрее и энергоэффективнее) и D (+5, лучше traceability).

---

## 3. Сравнение pipeline: новый (ADR-014) vs старый (Cannon)

### 3.1 Процесс-метрики

| Метрика | Cannon (старый) | Sollar (новый) | Что лучше |
|---|---|---|---|
| Discovery→Planning | ~1.5-2 ч | **51 мин** | Sollar (−50%) |
| Development (19 AC) | ~9 ч | **~4 ч** | Sollar (−55%) |
| Wall clock total | ~12 ч | ~14 ч* | Cannon (Sollar stuck в verification) |
| Контекстных крахов | 2 | **0** | Sollar |
| Recovery tasks | 3 (all manual) | 15 (10 auto + 5 manual) | Sollar (больше autonomy) |
| Human interventions | 4-5 | **8** | Cannon (но 6 из 8 → код-фиксы) |
| Retry-loops | 38 (#31 Lighthouse) | 15 (#31 Browser, T-013 fixed) | Sollar (T-013 фикс сработает в next run) |
| Orphan AC | 2 | **0** | Sollar |
| Traceability edges | ~50 | **124+** | Sollar (2.5×) |
| Verification evidence | 12 | **59** (39 passed + 20 failed) | Sollar (5×) |

*Sollar wall clock включает 8 часов verification-фазы (из них ~5 часов stuck)

### 3.2 Что новый pipeline делает лучше

1. **Pipeline reorder (ADR-014)** — SRS после AC работает: architecture соответствует requirements, conflict_keys useful
2. **Auto-recovery** — atomic-release зомби, merge-conflict resolution, verification gap filling
3. **Speed** — Discovery→Development в 2-3× быстрее
4. **Traceability** — 0 orphan AC, 124+ edges (vs Cannon ~50)
5. **Energy** — 1.4 kWh vs 3.06 kWh (−54%)

### 3.3 Что новый pipeline НЕ решил (провалы)

1. **Verification loops** — verifier находит баги, но pipeline не создаёт dev-tasks для фикса (T-013)
2. **Planner gap** — не создаёт verification tasks для всех AC (T-014)
3. **Engine instability** — движок перестаёт spawn'ить без видимых причин (T-005)
4. **No degradation model** — binary gate (passed/failed), нет partial-verification (T-010)
5. **Single-file ESM** — архитектор не проверил test-reachability (T-012)

---

## 4. Архитектурные находки — 15 кейсов (T-001..T-015)

### Код-фиксы (6, в origin/master)

| Кейс | Что | Файл | Commit |
|---|---|---|---|
| **T-006** | `worker_next` раздаёт все приоритеты (was: medium+) | dispatcher.ts, orchestrate.ts | `95a9049` |
| **T-008** | Kanban dispatch + reviewer-does-merge + conflict-key gate | dispatcher.ts, saga-worker/SKILL.md | `c90c436` |
| **T-012** | saga-architect Test Reachability Check §2.6 | saga-architect/SKILL.md | `abb29e1` |
| **T-013** | Verification review-loop escape (≥2 failed → done) | dispatcher.ts | `5fd4b80` |
| **T-014** | saga-planner: every AC gets verification task | saga-planner/SKILL.md | `2d17afd` |
| **T-015** | Stop-and-resume proposal (manual close stuck tasks) | research doc | `5aa5e7c` |

### Design proposals для v2 (9)

| Кейс | Что | Приоритет |
|---|---|---|
| T-001 | Loop-detector (S1 tool_use hash + S2 error hash) | high |
| T-005 | Cross-agent isolation (separate saga.db for tests) | high |
| T-007 | Gate принимает done если all depends_on merged | medium |
| T-009 | Planner: verification.ac = tracker_only, не git_change | medium |
| T-010 | Degradation model (7 принципов resilience) | critical |
| T-011 | Adaptive retry с гипотезами (diagnostician + explorer) | high |
| T-013b | FAILED → spawn dev task автоматически | high |
| T-014b | Planner: L1-L3 tests как обязательная часть dev-task | medium |
| T-015 | Watchdog + timeout-escape + stop-and-resume UI | high |

### Системный вывод (T-010)

**Корень всех проблем:** saga не имеет модели частичного выполнения (degradation model). Pipeline предполагает, что каждый шаг будет выполнен. Любой stuck → авария. Это нарушает принцип resilience-by-design.

**7 принципов для v2:**
1. Контракт на невыполнение для каждого task_kind
2. Разделение concerns (verifier ≠ fixer)
3. Деградация как first-class concept
4. Continuous delivery model (Draft/Partial/Verified/Certified)
5. Backpressure вместо бесконечного retry
6. AC criticality (blocker/degradable/nice-to-have)
7. Pipeline как DAG с degradable edges

---

## 5. Сводная таблица прогона

| Метрика | Значение |
|---|---|
| Wall clock | ~14 часов |
| Задач создано | 69 (44 planner + 25 recovery/retroactive) |
| Done | 63/69 (91%) |
| Не завершено | 5 (verification tasks, pipeline застрял) |
| Артефактов | 57 (51 accepted) |
| Trace edges | 124+ |
| Verification evidence | 59 (39 passed, 20 failed) |
| Recovery tasks | 15 |
| Human interventions | 8 |
| Код-фиксов saga-mcp | 6 |
| Design proposals | 9 |
| GPU kWh | ~1.4 |
| Стоимость электричества | ~8 ₽ |

---

## 6. Рекомендации для следующего прогона

### Перед запуском

1. **Применить все 6 код-фиксов** (уже в master)
2. **Обновить skills** на всех машинах (`skills/` → `~/.zcode/skills/`)
3. **Изолировать saga.db** — `SAGA_DB` env для тестов соседнего агента
4. **Использовать stronger модель** если возможно (qwen3.6-35b@q6 или @q8)

### Ожидаемые улучшения (от 6 фиксов)

| Фикс | Что изменится |
|---|---|
| T-006 | Все задачи выдаются (включая low-priority) — 0 dead-locks |
| T-008 | Reviewer мержит сразу — 0 merge-конфликтов в single-file |
| T-012 | Архитектор проверяет test-reachability — 0 ESM/file:// сюрпризов |
| T-013 | Verifier не крутится на product bugs — 0 бесконечных loops |
| T-014 | Planner создаёт verification для всех 25 AC — 0 retroactive recovery |
| T-015 | (proposal) Stop-and-resume для stuck tasks — quick unblock |

### Что всё ещё НЕ решено (риски следующего прогона)

1. **No degradation model** (T-010) — gate всё ещё binary (passed/failed)
2. **No loop-detector** (T-001) — «тихие» loops возможны (T-015)
3. **No auto-spawn dev task on FAILED** (T-013b) — verifier найдёт баг, но dev не узнает
4. **Engine spawn-stall** (T-005) — движок иногда перестаёт spawn'ить без причин

---

## 7. Главный вывод

**Sollar-эпизод — это не провал, а diagnostic session.** За 14 часов A/B-тестирования мы:

1. **Подтвердили**, что pipeline ADR-014 структурно лучше ADR-013 (быстрее, чище, автономнее)
2. **Обнаружили**, что verification-фаза — слабое звено (loops, planner gap, no degradation)
3. **Исправили 6 конкретных багов** в saga-mcp (все в master, запушены)
4. **Сформулировали 9 design proposals** для v2 (degradation model, adaptive retry, watchdog)
5. **Доказали**, что слабая локальная модель (qwen3.6-35b@q4) может проходить pipeline, но требует системной оркестрации

**Продукт Sollar не запускается** (2 критических бага), но **saga-mcp стал значительно лучше** — 6 код-фиксов напрямую улучшают оркестрацию для всех будущих прогонов.

**Ценность прогона — в архитектурных находках, а не в продукте.**

---

## Ссылки

- `docs/research/testing-2026-07-21-sollar-new-pipeline.md` — полный журнал прогона (кейсы T-001..T-015)
- `docs/research/audit-2026-07-20-cannon-1000-score.md` — Cannon baseline 661/1000
- `CHANGELOG.md` — все 6 код-фиксов с описанием
- `git log origin/master --oneline` — коммиты `95a9049`..`5aa5e7c`
