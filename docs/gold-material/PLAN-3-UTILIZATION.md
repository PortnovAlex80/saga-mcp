# План 3: Максимальное использование golden material

## Цель
Извлечь максимальную ценность из одного factory-прогона для ускорения разработки, тестирования и отладки.

## 1. Regression test fixtures (из планов 1+2)

### Что даёт:
- **Детектор регрессий**: любое изменение seal/revision/digest формул ломает тесты
- **20+ assertion'ов** на конкретных данных, а не на синтетических моках
- **ADR-053 coverage на реальном прогоне** — не только в исходниках

### Как использовать:
```bash
# На каждом PR:
npm run test:factory-regression-golden

# Если упал digest-pinning → canonical-json дрейфнул (пересчитать + аудит)
# Если упал topology-invariants → изменилось число handoff'ов
# Если упал referential-integrity → отвалился cross-ref
```

## 2. Replay capsule test material

### Что даёт:
- 13 капсул с `payload_snapshot` — готовый материал для byte-replay тестов
- Каждая капсула = принятый worker output → можно переиграть без LLM

### Как использовать:
```js
// Для каждой капсулы:
// 1. Достать payload_snapshot + replay_key
// 2. Прогнать через production-cell executor в replay-режиме
// 3. Сравнить новый candidate_set_digest с payload_hash
// Результат: доказательство deterministic-replay
```

### Покрывает:
- Authority conservation (запечатанный материал не меняется)
- Crash recovery (kill → resume → replay → тот же результат)
- Partition invariance (та же material через разные executions → тот же digest)

## 3. Worker log analysis (27 JSONL файлов)

### Что даёт:
- Полные трассы GLM-4.7: thinking tokens, tool calls, MCP interactions
- Стоимость каждого вызова (total_cost_usd)
- Время выполнения (duration_ms)
- Качество verdict'ов (approved vs repair_required)

### Как использовать:
```bash
# Извлечь статистику:
for f in worker-logs/*.jsonl; do
  task=$(basename $f | sed 's/task-\([0-9]*\)-.*/\1/')
  result=$(grep '"type":"result"' $f | tail -1)
  echo "task $task: $(echo $result | jq -r '.duration_ms, .total_cost_usd, .terminal_reason')"
done

# Результат:
# task 1:  46893ms, $0.00, completed
# task 8:  59913ms, $0.50, completed
# task 26: 217383ms, $1.07, completed
```

### Применения:
- **Benchmarking**: отслеживать изменение LLM-качества между прогонами
- **Cost analysis**: сколько стоит каждый тип задачи (author vs reviewer)
- **Failure analysis**: какие промпты приводят к repair_required
- **Skill debugging**: какие MCP-вызовы делают workers

## 4. Requirements traceability graph

### Что даёт:
- Полный graph: PRD → FR(4) → UC(4) → AC(10) → RULE(2) → SRS
- 25 артефактов с content_hash, accepted_hash, parent_artifact_id
- `artifact_traces` таблица с link_type (derived_from, covers, implements)

### Как использовать:
```sql
-- Проверить traceability любой AC:
SELECT a.code, a.title, tr.link_type, target.code, target.title
FROM artifacts a
JOIN artifact_traces tr ON tr.source_id = a.id
JOIN artifacts target ON target.id = tr.target_id
WHERE a.code = 'AC-4';
-- Результат: AC-4 derived_from FR-2 (Increment Control)
--            AC-4 derived_from UC-2 (Increment Counter)
--            AC-4 derived_from NFR-1 (Accessibility Compliance)
```

### Применения:
- **Coverage gap analysis**: какие FR/NFR не покрыты AC
- **Impact analysis**: изменение FR-2 → какие AC/UC затронуты
- **Audit**: полное документирование требований для compliance

## 5. Development code quality baseline

### Что даёт:
- 1,370 строк исходного кода (5 JS модулей)
- 3,077 строк тестов (unit + property + integration)
- Coverage report (LCov HTML)
- Review verdicts с конкретными AC coverage

### Как использовать:
```bash
# Запустить тесты продукта:
cd tests/golden-runs/production-run-001/repo/product
npm ci
npm test
# Результат: 177/177 passed (baseline)

# Если в следующем прогоне тестов меньше → регрессия
# Если coverage ниже → качество упало
```

### Baseline метрики:
| Модуль | Строк кода | Строк тестов | AC покрытие |
|--------|-----------|-------------|-------------|
| counter-core.js | 122 | 322 | AC-2, AC-3, AC-5, AC-7 |
| accessibility-manager.js | 536 | 1310 (shared) | AC-4, AC-6, AC-9 |
| interaction-handler.js | 312 | 1310 (shared) | AC-1, AC-8 |
| storage-adapter.js | 187 | 488 | AC-7, AC-8 |
| ui-renderer.js | 213 | 530 | AC-1, AC-2 |

## 6. Known divergence signals

### Что даёт:
- 1 managed_artifact_productions row с content_hash дрейфом (детектор regression)
- 1 external effect action в `state=unknown` (crash recovery material)
- Все 53 obligations в `pending` (reconciler не подключён — known gap)
- `REPLAY_CAPSULE_CONTEXT_INVALID` для formalization cells (replay key material missing)

### Как использовать:
- **Drift signal**: пиннать как baseline (1 drift), уменьшать до 0 когда починят
- **Crash candidate**: action id=6 в `unknown` — материал для crash recovery теста
- **Obligation gap**: НЕ пинать state=pending как golden; пинать топологию

## 7. CI pipeline

```yaml
# .github/workflows/ci.yml — добавить после architecture gate
- name: Factory regression golden
  run: npm run test:factory-regression-golden

# Separate slow-suite:
factory-regression-replay:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: npm ci && npm run build
    - run: npm run test:factory-regression-replay
  # На push to main, не на каждый PR
```

## 8. Freshness guard

```js
test('golden material not stale', () => {
  const manifest = loadFixture('manifest.json');
  const age = Date.now() - new Date(manifest.extracted_at).getTime();
  const SIX_MONTHS = 180 * 24 * 60 * 60 * 1000;
  assert.ok(age < SIX_MONTHS, 'golden material older than 6 months — regenerate');
});
```
