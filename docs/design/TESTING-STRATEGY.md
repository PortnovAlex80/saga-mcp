# Стратегия тестирования saga-mcp — тестирование без повторного прогона lifecycle

Status: **Design**
Owner: saga-mcp architecture
Date: 2026-07-30
Связанные документы:
- `docs/BUGS-2026-07-30.md` (10 найденных багов)
- `docs/design/PARTIAL-RESET-AND-RESUME.md` (resume/reset механика)
- `docs/RUN-SAGA-2026-07-29.md` (инструкции запуска)
- `docs/design/TRACE-REPLAY-GUIDE.md` (кеширование traces)

---

## 0. Постановка проблемы

Сегодня багфикс в одном узле (например, в `define-acceptance-contract`) заставляет
делать `reset-saga-db.mjs` и гнать весь lifecycle `Discovery → Formalization →
Development → Delivery` заново. Издержки одного такого прогона:

- **Discovery + Formalization**: ~30 мин, повторяются идентично (outcomes уже известны).
- **Токены**: миллионы на генерацию документов, которые уже сгенерированы.
- **Сигнал/шум**: 95% времени тратится на заведомо-зелёные узлы, баг-регрессия маскируется.

Корневая причина не техническая, а **процедурная**: нет понятия «тестовый пакет»
(frozen artifacts, заранее засеянные в БД) и нет правила «после багфикса запускать
только поражённый уровень». Эта стратегия вводит оба и связывает их с уже
существующими инструментами (`formalization-e2e-smoke.test.mjs`, `saga-reset-stage.mjs`,
warm-start fixture).

**Цель по эффективности:** типичный багфикс закрывается прогоном L1+L2 за **2–5 минут**
вместо полного lifecycle-прогона 30–60 минут. Полный прогон (L4) — только при изменении
`LifecycleDefinition` или перед релизом.

---

## 1. Уровни тестирования

Пирамида снизу вверх. Чем выше уровень — тем дороже и реже запускается. Каждый багфикс
должен быть закрыт **минимально достаточным** уровнем (правило см. §3).

### L0 — Static (tsc + lint, 0 токенов)

Уже есть в `package.json`:
```bash
npx tsc --noEmit          # типы
npm run lint              # eslint src/
npm run cgad-lint         # CGAD 18 правил
```

Покрывает: опечатки в типах, dead code, нарушения CGAD-инвариантов. Запускается перед
каждым коммитом. **Цена:** <30 c. **Токенов:** 0.

### L1 — Unit (pure TS, node --test, 0 токенов)

Изолированные функции kernel-логики, без БД, без LLM. Реестр уже существующих тестов
в `tests/process-modules/` и `tests/saga3/` (D1–D5). **На каждый из 10 исправленных
багов добавить по одному L1-тесту** (§4.2 «bug-trap suite»).

Паттерн L1 (пример для бага #5 `findContractGap`):
```js
// tests/process-modules/formalization-find-contract-gap.test.mjs
test('findContractGap собирает ВСЕ gaps, не первый', () => {
  const gaps = findContractGap({ missingTraces: ['UC-1→FR', 'UC-2→FR', 'AC-3→UC'] });
  assert.equal(gaps.length, 3);            // НЕ 1
  assert.ok(gaps.some(g => g.includes('UC-1')));
  assert.ok(gaps.some(g => g.includes('AC-3')));
});
```

Что попадает на L1 (по багам из BUGS-2026-07-30):
| Баг | Функция | Файл |
|---|---|---|
| #1, #6 | node-level query, CAS accept | `sqlite-exact-candidate-acceptance.ts`, `formalization-installation.ts` |
| #2 | `matchesFenceRelaxed` | `formalization-installation.ts` |
| #5 | `findContractGap` | `formalization-installation.ts` |
| #3 | `COMMON_WRITE_TOOLS` содержит `trace_delete` | `formalization-process-module.ts` |

**Цена:** секунды. **Токенов:** 0. **Покрытие:** чистая логика, без БД-побочных.

### L2 — Node isolation (kernel-узел + seeded DB, 0 токенов)

**Ключевой уровень для стратегии.** Один kernel-узел исполняется на заранее засеянной
БД. LLM НЕ вызывается — моделируются только MCP-продукции (artifact_create, trace_add,
process_node_submit), которые в реальном прогоне делает worker. Это закрытый ответ на
вопрос «как тестировать один узел изолированно».

**Эталонный паттерн уже существует** — `tests/process-modules/formalization-e2e-smoke.test.mjs`
(функция `seedGraph(db, epicId, mode)`). Расширить тот же подход до **тестовых пакетов** (§2):
запускаем ровно `define-acceptance-contract`-settlement с готовым набором PRD+FR+UC+AC и
проверяем, что CAS accept проходит (регрессия багов #1, #6).

Пример L2:
```js
// tests/process-modules/formalization-ac-settlement.test.mjs
test('AC settlement принимает все 17 AC после recovery (regression багов #1,#6)', async () => {
  const { temp, db } = seedFixture('formalization-ac-frozen.json', epicId=100);
  try {
    // Симулируем: артефакты созданы в exec#1, recovery в exec#5, CAS accept в exec#5.
    simulateManagedProduction(db, { processRunId: 83, nodeId: 'define-acceptance-contract',
                                     execId: 1, artifactIds: ac17 });
    simulateRecovery(db, { processRunId: 83, originalExecId: 1, recoveryExecId: 5 });

    const result = await runFormalizationSettlement({ processRunId: 83, epicId: 100 });

    assert.equal(result.outcome, 'formalized');
    assert.equal(result.acceptedAcCount, 17);
  } finally { cleanup(temp); }
});
```

Что обязательно покрывать на L2:
- `define-acceptance-contract` settlement (баги #1, #6 — node-level CAS query).
- `formalization.reconciliation` traceability check (баг #5 — все gaps собраны).
- `planning.decomposition` settlement (баги #9, #10 — submission валиден, recovery
  получает предыдущий draft).
- skill resolution для каждого LM-узла (баг #7 — `buildWorkspaceProjection` возвращает
  resource, а не undefined; регрессионный тест уже рекомендован в BUGS §«Skills audit»).

**Цена:** секунды–десятки секунд (БД в `os.tmpdir()`, in-memory). **Токенов:** 0.

### L3 — Stage / ProcessRun (engine, mock-LLM, 0 токенов)

Один stage целиком (например, весь `solution-formalization` flow: 5 узлов), но LLM
заменён на `tests/mock-claude.mjs`. Проверяет **склейку узлов**, checkpoint-resume,
recovery-loop внутри stage. Уже есть примеры:
- `tests/process-modules/formalization-generic-flow.test.mjs`
- `tests/process-modules/generic-flow-feedback-recovery.test.mjs`
- `tests/process-modules/discovery-generic-flow-scenarios.test.mjs`

L3 — это ответ на «как тестировать formalization без discovery»: L3-тест formalization
seeds-ит discovery-выход (готовый certificate) и стартует formalization с нуля.

Запуск:
```bash
npm run test:process-modules        # все P6-тесты
SAGA_CLAUDE_PATH="node tests/mock-claude.mjs" npm run mock:run ...
```

**Цена:** минуты. **Токенов:** 0 (mock). **Покрытие:** stage-интерфейсы, не LLM-качество.

### L4 — Lifecycle end-to-end (реальная LLM, золотой прогон)

Полный прогон `saga3-lifecycle` с реальной моделью (GLM-4.7) и **golden path fixture**.
Используется:
- перед релизом (`saga-release` skill),
- после изменения `LifecycleDefinition` (определение stages/mappings),
- после изменения pinned package (skill/template).

**Цена:** 30–60 мин, реальные токены. Запускать максимально редко (см. §3 правило 5).
Именно на этом уровне работает `test-warm-start` (см. `docs/RUN-SAGA-2026-07-29.md`
§«Test warm-start») — он переиспользует документы между прогонами и срезает ~50% времени.

### Сводная таблица уровней

| Ур. | Имя | Запуск | Время | Токены | Что проверяет |
|---|---|---|---|---|---|
| L0 | Static | `tsc --noEmit`, `lint`, `cgad-lint` | <30 c | 0 | типы, CGAD |
| L1 | Unit | `node --test tests/...` | секунды | 0 | чистые функции kernel |
| L2 | Node isolation | `node --test formalization-ac-settlement.test.mjs` | секунды | 0 | один узел + seeded БД |
| L3 | Stage / ProcessRun | `npm run test:process-modules` | минуты | 0 | склейка узлов, recovery |
| L4 | Lifecycle e2e | `orchestrate-cli --lifecycle-input=...` | 30–60 мин | реальные | весь pipeline |

---

## 2. Тестовые пакеты (fixtures) для каждого этапа

«Тестовый пакет» = **сериализованное состояние БД (artifacts + traces + acceptance
decisions + work_intents) для старта с любого узла**, без прогона предыдущих стадий.
Формат — JSON-дамп строк таблиц, который тест засовывает в чистую temp-БД через
`seedFixture(pkg, epicId)`. Хранятся в `tests/fixtures/lifecycle/`.

> Принцип: пакет = **детерминированный снимок результатов одной стадии**, выработанный
> однажды на «золотом» L4-прогоне. После accept изменений в коде стадии пакет
> перегенерируется и коммитится заново (один L4-прогон), затем снова замораживается.

### 2.1 Реестр пакетов

| Пакет | Что содержит | Для старта с | Заменяет прогоны |
|---|---|---|---|
| `discovery-frozen.json` | proposal (outcome=go/clarify), readiness assessment, settlement certificate, control/work intents discovery | Formalization | Discovery (~5–7 мин) |
| `formalization-frozen.json` | PRD + 10 FR + 8 NFR + 8 RULE + 9 UC + 17 AC + SRS, все `accepted`, полный trace-граф (covers/derived_from/implements_spec), formalization acceptance baseline + decisions, formalization outcome certificate | Development | Discovery + Formalization (~30 мин) |
| `ac-baseline-frozen.json` | Подмножество formalization-frozen: готовые UC+FR для построения AC-baseline. Для тестирования **только AC-settlement узла** | AC-узел | Discovery + Formalization до AC |
| `planner-input-frozen.json` | Принятые AC + SRS + repository bindings + task-graph-submit-call-template **с предзаполненными реальными artifact ids** (лекарство от бага #9) | Planning-узел Development | Discovery + Formalization + dev-preplanning |

### 2.2 Формат пакета

```json
{
  "schemaVersion": "saga3.test-fixture-frozen.v1",
  "fixtureId": "formalization-frozen-2026-07-30",
  "source": {
    "lifecycleRunId": 35,
    "epicId": 1,
    "generatedAt": "2026-07-30T...",
    "goldenHash": "<sha256canonical(status snapshot)>"
  },
  "rows": {
    "projects":            [{ "...": "one row" }],
    "epics":               [{ "...": "one row" }],
    "artifacts":           [{ "...": "PRD/FR/.../AC rows" }],
    "traces":              [{ "...": "covers/derived_from/..." }],
    "saga3_exact_candidate_acceptance_decisions": [{ "...": "frozen baseline" }],
    "saga3_exact_candidate_acceptance_items":     [{ "...": "27 items" }],
    "saga3_work_intents":  [{ "...": "formalization.* kinds" }],
    "saga3_control_intents": [{ "...": "settlement certificate refs" }]
  }
}
```

### 2.3 Генерация пакета из «золотого» прогона

Один скрипт, выгружающий достижение стабильной точки:
```bash
# Создаёт formalization-frozen.json из текущего состояния epic 1 в saga.db.
# Запускать ПОСЛЕ подтверждённо зелёного L4-прогона.
node tools/saga-freeze-fixture.mjs --epic=1 \
  --from-stage=initial-discovery --to-stage=solution-formalization \
  --out=tests/fixtures/lifecycle/formalization-frozen.json
```

Скрипт `tools/saga-freeze-fixture.mjs` (новый, ~1 день работы) экспортирует указанные
таблицы в JSON, вычисляет `goldenHash = sha256canonical(rows)` и кладёт в файл. На CI
(L0/CI шаг) сравнивается текущий `goldenHash` с зафиксированным — расхождение сигнализирует,
что пора перегенерировать пакет (или что кто-то правил код без обновления fixture).

### 2.4 `seedFixture()` — загрузчик в temp-БД

Реализуется на основе `seedGraph()` из `formalization-e2e-smoke.test.mjs`:

```js
// tests/fixtures/lifecycle/seed-fixture.mjs
export function seedFixture(fixtureName, { epicId } = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-fx-'));
  process.env.DB_PATH = path.join(temp, 'fx.db');
  const db = getDb();                      // createSchema отрабатывает автоматически
  const pkg = JSON.parse(readFileSync(
    path.join('tests/fixtures/lifecycle', fixtureName), 'utf8'));
  for (const [table, rows] of Object.entries(pkg.rows)) {
    if (rows.length === 0) continue;
    const cols = Object.keys(rows[0]);
    const placeholders = cols.map(() => '?').join(',');
    const stmt = db.prepare(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
    for (const r of rows) stmt.run(...cols.map(c => r[c]));
  }
  return { temp, db, goldenHash: pkg.source.goldenHash };
}
```

Это даёт ответ на первые три вопроса стратегии:
1. **Formalization без discovery** → `seedFixture('discovery-frozen.json')` → запустить
   formalization ProcessRun (L3-тест или partial-reset+resume на реальной БД).
2. **Development без formalization** → `seedFixture('formalization-frozen.json')` →
   запустить development ProcessRun.
3. **Один узел изолированно** → `seedFixture('ac-baseline-frozen.json')` → вызвать
   `runFormalizationSettlement({ nodeId: 'define-acceptance-contract' })` (L2).

### 2.5 Связь с уже существующим warm-start fixture

`test-fixtures/lifecycle/autism-buttons-warm-start.json` — это **документный** кеш
(markdown drafts), переиспользуемый между L4-прогонами. Тестовые пакеты из §2.1 — это
**БД-снимки** (artifacts/traces/acceptance), переиспользуемые на L2/L3. Они
**комплементарны**:

| Инструмент | Слой | Уровень | Эффект |
|---|---|---|---|
| warm-start fixture | документы (markdown) | L4 | LLM не пишет текст заново, только перерегистрирует artifacts |
| frozen test-packs | БД (artifacts/traces) | L2/L3 | LLM не вызывается вовсе, kernel исполняется на готовом графе |

Полная оптимизация (когда-нибудь) — `TRACE-REPLAY-GUIDE.md`: replay traces между
L4-прогонами, чтобы опустить и перерегистрацию. До этого frozen-пакеты дают 90% выгоды.

---

## 3. Процедура багфикса без полного прогона

Жёсткий порядок действий. **Цель:** 95% багфиксов закрывается на L1+L2, полный прогон
только в двух случаях (см. правило 5).

### 3.1 Дерево решения (что запускать после фикса)

```
Что изменилось?
│
├─ Pure function в kernel (findContractGap, matchesFenceRelaxed, CAS-query)
│   → L1 regression test + L0 (tsc/lint). Всё. (~30 c)
│
├─ Один узел formalization/development (allowed_tools, settlement, CAS accept)
│   → L2 test (seedFixture) + L1 если есть чистая функция. (~1 мин)
│
├─ Склейка узлов / flow / recovery-loop внутри stage
│   → L3 test (test:process-modules, mock-LLM). (~5 мин)
│
├─ Skill / template (data в package, не код модуля и не lifecycle definition)
│   → partial-reset этого stage + --resume на реальной БД (warm-start включён).
│     Module digest НЕ меняется → resume проходит. (~5–10 мин)
│
└─ LifecycleDefinition (stages/mappings/outcomeRoutes) ИЛИ код ProcessModule
    (package_digest меняется)
    → только тогда полный L4-прогон с reset-saga-db + bootstrap. (30–60 мин)
```

### 3.2 Пошаговая процедура типичного багфикса

1. **Воспроизвести на минимальном уровне.** Прежде чем править код, написать тест, который
   падает на баге. Использовать максимальный низкий уровень (см. дерево выше). Для 7 из 10
   багов из BUGS-2026-07-30 это L1/L2.
2. **Зафиксировать симптом в bug-trap тесте** (§4.2). Тест остаётся в репо навсегда.
3. **Внести фикс.** Прогнать L0 + соответствующий уровень теста (L1/L2/L3).
4. **Только при изменении package/lifecycle** —partial-reset проблемного stage + resume:
   ```bash
   node tools/saga-reset-stage.mjs --stage=solution-formalization --dry-run   # проверить
   node tools/saga-reset-stage.mjs --stage=solution-formalization
   # resume без повтора Discovery/остальных stage:
   DB_PATH=... SAGA_ORCHESTRATION_MODE=saga3-lifecycle \
     SAGA_PRODUCT_LIFECYCLE_COMPOSITION=.../hex-composition.mjs \
     SAGA_TEST_WARM_START=1 \
     SAGA_TEST_WARM_START_FIXTURE=.../autism-buttons-warm-start.json \
     node dist/orchestrate-cli.js 1 1 --lifecycle-input=... --resume --concurrency=1
   ```
   Это закрывает «resume доказан» из BUGS (lifecycle #35: formalization за один прогон,
   development перезапущен без повторения Discovery/Formalization).
5. **Полный L4-прогон** — только в двух случаях: (a) менялось `LifecycleDefinition`,
    (b) подготовка к релизу. Во всех остальных —partial-reset + resume достаточно.

### 3.3 Доработки `saga-reset-stage.mjs` (необходимо для §3)

Текущий `tools/saga-reset-stage.mjs` близок к корректному, но имеет 3 недочёта,
которые мешают стратегии. Устранить их (работы ~0.5 дня):

1. **`work_intents` чистится по LIKE-префиксу `module.split('-')[0]`** (строка 117/259).
   Для `solution-formalization` префикс `solution` совпадёт с `solution-development` →
   снесёт чужие intents. Исправить: точное сравнение `kind LIKE 'formalization.%'`
   (mapping в `STAGE_TO_INTENT_PREFIX`).
2. **Не чистит `saga3_module_installations` при изменённом digest.** Если правили код
   модуля — `package_digest` изменился, reinstall падает (баг #8). Добавить опцию
   `--reinstall-module=<name>` которая делает `DELETE FROM saga3_module_installations
   WHERE name=<module>` (только для сбрасываемого stage, не трогая остальные —
   см. PARTIAL-RESET §7 п.7).
3. **Не проверяет outcome-certificate перед node-rollback.** Для будущей поддержки
   `--node=` (Сценарий B из PARTIAL-RESET): блокировать откат узла, если для
   `process_run_id` уже есть сертификат (PARTIAL-RESET §7 п.6).

После этих правок partial-reset + resume — это **рабочая лошадка** стратегии, и
`reset-saga-db.mjs` уходит в категория «новый проект / смена lifecycle».

---

## 4. Автоматизация проверки

### 4.1 npm-скрипты для каждого уровня

Добавить в `package.json` `scripts`:
```json
{
  "test:unit":          "node --test tests/process-modules/formalization-*.test.mjs tests/saga3/",
  "test:node-isolation":"node --test tests/node-isolation/",
  "test:bug-trap":      "node --test tests/regression/",
  "test:stage":         "tsc && node tools/run-process-module-tests.mjs all",
  "test:fast":          "npm run test:unit && npm run test:node-isolation && npm run test:bug-trap",
  "fixture:freeze":     "node tools/saga-freeze-fixture.mjs",
  "fixture:verify":     "node tools/saga-verify-fixtures.mjs"
}
```

`test:fast` — это полный набор «без LLM, без БД-прогона»: должен работать в CI за <2 мин и
покрывать L0+L1+L2+bug-trap. Это то, что запускается после **каждого** багфикса.

### 4.2 Bug-trap regression suite (`tests/regression/`)

Один файл на каждый из 10 исправленных багов. Имя = ID бага. Каждый тест моделирует
**симптом бага** (не реализацию фикса) — поэтому тест переживает рефакторинги.

```
tests/regression/
├── bug-01-node-level-artifact-query.test.mjs      (L2: recovery меняет exec → query находит)
├── bug-02-matches-fence-relaxed.test.mjs          (L1: recovery intent/task ≠ исходные)
├── bug-03-trace-delete-in-tools.test.mjs          (L1: COMMON_WRITE_TOOLS содержит trace_delete)
├── bug-04-reset-cleans-all-tables.test.mjs        (L1: reset-saga-db чистит receipts/acceptance/installations)
├── bug-05-find-contract-gap-all.test.mjs          (L1: 3 gaps → 3 findings)
├── bug-06-cas-accept-node-level.test.mjs          (L2: CAS accept после recovery)
├── bug-07-no-ghost-skills.test.mjs                (L1/L2: buildWorkspaceProjection ≠ undefined для всех LM-узлов)
├── bug-08-module-installations-clear.test.mjs     (L1: partial-reset умеет --reinstall-module)
├── bug-09-planner-template-filled.test.mjs        (L2: planner-input-frozen → submission без FILL_ placeholders)
└── bug-10-recovery-draft-accumulation.test.mjs    (L2: recovery worker получает свой предыдущий draft)
```

Эти 10 файлов — это **страховка от регрессии** найденных проблем. Любой будущий фикс
должен не сломать их. Это прямой ответ на вопрос «как измерять регрессии после багфикса»:
**bug-trap suite остаётся зелёным = нет регрессии.**

### 4.3 Skill-ghost check (регресс бага #7)

Особый автоматический тест — для каждого LM-профиля каждого из 4 модулей:
```js
// tests/regression/bug-07-no-ghost-skills.test.mjs
for (const mod of ['product-discovery','solution-formalization','solution-development','delivery-release']) {
  for (const profile of listLmProfiles(mod)) {
    test(`${mod}/${profile.nodeId}: skill resource resolved`, () => {
      const proj = buildWorkspaceProjection({ module: mod, profile });
      assert.ok(proj.executionSkill, `executionSkill undefined for ${mod}/${profile.nodeId}`);
      assert.ok(proj.reviewSkill !== '__GHOST__', `ghost skill in ${mod}/${profile.nodeId}`);
    });
  }
}
```
Этот тест рекомендован в BUGS §«Skills audit» — он поймал бы баг #7 (`saga-planning-reviewer`)
автоматически, без 15 попыток спавна.

### 4.4 Golden-path snapshot (L4, редкий)

Один эталонный L4-прогон с известным правильным результатом, сохранённый как snapshot:
- input: `autism-buttons-lifecycle-input.json` (фиксированный).
- warm-start: `autism-buttons-warm-start.json`.
- Ожидаемые checkpoints: outcomes по stage, artifact counts (1 PRD + 10 FR + ... + 1 SRS),
  `goldenHash` formalization-baseline.

Запускается перед каждым релизом (`saga-release` skill). Расхождение со snapshot = регрессия
поведения (необязательно баг — может быть улучшением, тогда обновить snapshot). CI-вариант
того же прогона — **не запускать** L4 автоматически: дорого и нестабильно из-за LLM.

### 4.5 Проверка fixtures на дрейф

```bash
npm run fixture:verify   # сравнивает goldenHash всех *.json в tests/fixtures/lifecycle/
                         # с пересчётом по текущему коду; расхождение = fixture устарел.
```

Запускается в CI (L0) после `tsc`. Если фикс меняет shape артефакта — `fixture:verify`
падает и напоминает перегенерировать пакет (один L4-прогон).

---

## 5. Метрики эффективности

Что измерять, чтобы доказать, что стратегия работает (и ловить просадки).

### 5.1 Базовые метрики

| Метрика | Источник | Целевое |
|---|---|---|
| **Время до зелёного после багфикса** | time от коммита до зелёного CI | L1+L2: <5 мин; типичный фикс: <10 мин |
| **Токенов на один багфикс** | mock-claude runner / billing | L1/L2: 0; partial-reset+resume: только поражённый stage |
| **Количество полных L4-прогонов за неделю** | счётчик `reset-saga-db` запусков | ≤ 1 (только для смены lifecycle / релиза) |
| **Доля багфиксов, закрытых без L4** | разметка в коммите `fix(l1)` / `fix(l2)` / `fix(l3)` / `fix(l4)` | ≥ 80% |
| **Bug-trap suite: recidivism** | счётчик падений regression/ | 0 (никогда не должен падать) |
| **Skill-ghost обнаружения** | bug-07 тест | 0 (тест зелёный всегда) |

### 5.2 Контр-метрика: «сэкономлено»

Считать разницу между «как было» (полный прогон на каждый багфикс) и «как стало»:
```
saved_minutes = (количество багфиксов за неделю) × (30–60 мин полного прогона) − (фактическое время прогонов)
saved_tokens = (количество багфиксов) × (tokens полного Discovery+Formalization) − (фактические токены)
```

По данным из BUGS-2026-07-30: 14 прогонов с нуля + 2 resume. При новой стратегии те же
багфиксы закрылись бы как **2 L4-прогона + 12 L1/L2** → экономия ~12 × 30 мин = **6 часов
и миллионы токенов за один цикл отладки**.

### 5.3 Знаки того, что стратегия буксует

- `reset-saga-db.mjs` запускается чаще 1 раза в неделю → кто-то игнорирует §3 правило 5.
- bug-trap suite периодически падает → фикс ломает старый контракт, нужен отдельный
  review (не «обновить snapshot и забыть»).
- `fixture:verify` падает регулярно → пакет генерируется вручную небрежно; ввести
  требование: коммит, меняющий formalization-код, обязан обновить или явно обосновать
  неизменность `formalization-frozen.json`.

---

## 6. Приоритеты внедрения

| # | Задача | Усилие | Эффект |
|---|---|---|---|
| 1 | **Bug-trap suite** (10 файлов в `tests/regression/`) | ~1–2 дня | Закрывает регрессии всех 10 багов; L1, 0 токенов |
| 2 | **Frozen test-packs** + `seedFixture()` + `saga-freeze-fixture.mjs` | ~2–3 дня | L2 node-isolation; «старт с любого этапа» |
| 3 | **Доработка `saga-reset-stage.mjs`** (§3.3: prefix bug, --reinstall, cert-check) | ~0.5 дня | Partial-reset+resume становится надёжным |
| 4 | **npm-скрипты** + CI-запуск `test:fast` | ~0.5 дня | Автоматизация на каждый пуш |
| 5 | Skill-ghost check (bug #7) | ~0.5 дня | Ловит «ghost skill» до прогона |
| 6 | Golden-path L4 snapshot + `fixture:verify` | ~1 день | Редкая, но дешёвая защита от поведенческого дрейфа |

Минимальный жизнеспособный набор — пункты **1+3**: даже без frozen-пакетов bug-trap
suite + надёжный partial-reset уже отрубают 80% потерь. Пункты 2+4 — следующий шаг,
когда станет тесно от L1 (нужно проверять узлы с реальным графом). Пункты 5+6 —
финальная полировка.

---

## 7. Краткая шпаргалка (ответы на 5 вопросов стратегии)

1. **Как тестировать formalization без discovery?**
   `seedFixture('discovery-frozen.json')` (L2/L3) ИЛИ partial-reset formalization +
   `--resume` на реальной БД. Discovery-артефакты переживают reset formalization.

2. **Как тестировать development без formalization?**
   `seedFixture('formalization-frozen.json')` (L2/L3). Готовый PRD+FR+NFR+RULE+UC+AC+SRS
   + trace-граф + acceptance baseline засеиваются в temp-БД, development стартует с нуля.

3. **Как тестировать один узел изолированно?**
   L2: `seedFixture('ac-baseline-frozen.json')` → прямой вызов
   `runFormalizationSettlement({ nodeId })`. Kernel исполняется, LLM не вызывается.
   Эталон реализации — `formalization-e2e-smoke.test.mjs::seedGraph`.

4. **Как создать «golden path» тест?**
   Один эталонный L4-прогон с фиксированным input + warm-start. Снимок результатов
   (outcomes, artifact counts, baseline hash) коммитится как snapshot (§4.4).
   Расхождение = регрессия поведения.

5. **Как измерять регрессии после багфикса?**
   `tests/regression/` (10 bug-trap файлов) + `fixture:verify` (дрейф снимков) +
   метрики из §5 (recidivism = 0, L4-прогонов/неделю ≤ 1).
