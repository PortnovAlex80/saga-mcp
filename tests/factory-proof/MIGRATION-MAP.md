# Composition-surface migration map (W0-1)

Статус: 2026-08-20, ветка saga4. Каноническая композиция для всех НОВЫХ
causal proofs — `tests/factory-proof/canonical-proof-composition.mjs`
(адаптер над `src/factory-e2e/fresh-harness.ts`; ADR-084,
GRAPH-TEST-STRATEGY W0-1). Ratchet: `import-ratchet.test.mjs` запрещает
импортировать три старые поверхности из `tests/factory-proof/`.

Старые поверхности остаются как migration debt для СУЩЕСТВУЮЩИХ
потребителей; новые импорты запрещены. Ни одна строка ниже не считается
«мигрировавшей», пока её обязательства не перенесены в normative registry
(W0-2) и её сценарий не прогнан через canonical adapter (W1-*).

| Старая поверхность | Текущие потребители | Судьба | Куда переезжает |
|---|---|---|---|
| `tests/factory-contract/scenario-composition.mjs` | `golden-path.test.mjs` (QUARANTINE FLAKY), `c5-carry-forward-adversarial-matrix.test.mjs` (blocking, factory-contract group), `parallel-git-desk.test.mjs` (QUARANTINE FLAKY) | retirement по suite | golden-path §16 two-pass → canonical proof W1-2 (Run B / Run C); parallel-git-desk → canonical scenario pack после W0-3; C5-матрица — последней: её обязательства (carry-forward adversarial) мигрируют в registry и canonical pack, до тех пор остаётся debt |
| `tests/factory-temporal/lib/temporal-composition.mjs` | весь `tests/factory-temporal/*.test.mjs` (QUARANTINE FLAKY, ≥5 файлов) | retirement suite-wide | temporal-обязательства (ADR-048 fingerprint/allowlist, crash-window) мигрируют в normative registry (W0-2) + canonical scenario packs (durable-transition fault class); suite объявляется заменённым ТОЛЬКО после миграции обязательств и зелёного blocking `factory-proof` (W0-4) |
| `tests/factory-e2e/harness-composition.mjs` | `fresh-harness.self-test.mjs`, `w9-02-single-drive.mjs`, `w9-03-adversarial-drive.mjs`, `w9-04-outcome-edge-drive.mjs`, `w9-05-disobedience-drive.mjs`, `w9-06-scope-widening-drive.mjs` | retirement drive-by-drive | каждый W9-drive переподключается на `buildCanonicalProofComposition` (это смена одной функции композиции + добавление fingerprint/allowlist-дисциплины); W9-сценарии становятся первыми canonical scenario packs; механика драйва (`driveFreshHarness`) уже production и не меняется |

Правила миграции:

1. Новый causal proof — ТОЛЬКО через `canonical-proof-composition.mjs`.
2. Миграция существующего suite = перенос обязательств в registry + прогон
   через canonical adapter + отдельный коммит; старый импорт удаляется в том
   же коммите.
3. `W9 объявлен заменой temporal suite` — недопустимая формулировка до
   п.2 для каждого temporal-обязательства (GRAPH-TEST-STRATEGY W0;
   CAUSAL-PROOF-IMPLEMENTATION-BRIEFS W0-4 §6).
