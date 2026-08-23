# ЦЕХ РАЗРАБОТКИ (solution-development) — контракт входа, выхода и гейтов

> Рабочая спецификация по коду сборки `cc/elite7-run` (905f5940 + a990157d).
> Источники: `src/process-modules/modules/development/development-process-module.ts`,
> `src/modules/development/**`, живые раны Elite-7/8. Обновляется с кодом.

## 1. ВХОД — что цех получает

Единственный вход — **`factory.development-case.v1`**, собираемый из замороженной
капсулы формализации (settlement上个 цеха). Живёт в `process_node_input` первой
ноды (`plan-task-graph`) и метаданных её задачи. Составляющие:

| Блок | Что внутри | Откуда |
|---|---|---|
| **solutionContractPayload** | контракт формализации целиком | `factory_formalization_solution_contracts.payload` |
| — `acceptanceCriteria[20]` | критерии: code, artifactId, criterionHash, criticality, implementationRequired + **`coveredConstraintIds`** (kernel-derived из SRS §D2 — поле, которого не было у Elite-7) | заморозка settlement формализации |
| — `constraintRegisterCoverage` | регистр: ref+digest, 13 записей ord-c-001..013, waivedIds (на v2 всегда ∅) | discovery-сертификат → формализация |
| — `srs` | замороженный SRS (§2.2 манифест модулей, §D2 AC Map) | SRS-узел формализации |
| — `baselineSnapshotRef/Hash` | замороженный baseline приёмки | freeze-acceptance-baseline |
| — `artifactHashes`, `traceIds`, `bundle` | бандл принятых артефактов + трассировки | settlement |
| **warrantRef** | cross-bind: discoveryCertificateHash + formalizationCaseDigest | ADR-090 (CC-IC-1/2) |
| **readiness-manifest payload contract** | двойная 64-hex cross-bind идентичность при наличии warrant | m7 (CC-IC-2) |

**Дед-клауз**: ран без регистра (legacy v1) — единственное законное состояние
с пустым покрытием; на v2 регистре `constraint-register-uncovered` — типизированный
красный, никогда skip (ADR-088).

## 2. ГРАФ УЗЛОВ (flow)

```
plan-task-graph ──accepted──▶ resolve-task-graph ──valid──▶ implement-work-items (×N карточек)
      │                            │                            │ accepted
      │ failed                     │ failed                     ▼
      ▼                            ▼                    freeze-integrated-candidate
complete-failed              settle-development                │ frozen
      │                            ▲                            ▼
      │                            │                    certify-product-readiness
      │                            │                            │ accepted
      └────── любой failed ────────┴────────────────────────────┘ ... ─▶ bind-runnable-candidate
                                                                       │ bound
                                                                       ▼
                                                                verify-acceptance
                                                                       │ accepted
                                                                       ▼
                                                              settle-development ─▶ complete
```

Каждая рабочая нода — production cell (author + reviewer циклы, recovery-бюджет
эпох, human_required-парковка при исчерпании).

## 3. ГЕЙТЫ ПРОВЕРКИ — что обязано пройти

| Гейт / чек | Что проверяет | Код причины при отказе |
|---|---|---|
| **`development.task-graph-contract.v1`** (гейт планировщика) | (а) покрытие: регистр − Σ kernel-derived `coveredConstraintIds` − waived = ∅; (б) граф замкнут, ацикличен, пересекающиеся пункты явно упорядочены (F-B даёт вычисленный набор пар); (в) декларации тест-файлов согласованы с SRS §2.2; (г) entrypoint-владение (`constraint-entrypoint-unowned`) | `constraint-register-uncovered` (per-ID), графовые reds |
| **`development.implementation-scope.v1`** | каждая карточка имплементации держится в рамках своего scope/файлов | typed error receipt |
| **Верификация критериев** (verification cells) | L3-свойства из замороженного AC (не из тестов билдера); **criterion-key accounting ledger** — proposed→executed→terminal факт на каждый критерий, executed не приписывается чужому item | `DEVELOPMENT_VERIFICATION_LEDGER_ITEM_KEY_MISMATCH` |
| **`factory.local-runnability.v1` @ 1.14.0`** (readiness) | продукт реально ставится/стартует/отвечает; **K19 fence идентичности**: OCI registry manifest digest образа + dependency-lock digest едут в receipt; срезы субстрата TOCTOU-перепроверяются (ADR-091); сбои среды → typed unknown с bounded retry (ADR-089), НЕ продукт-failed | `ENVIRONMENT_IMAGE_IDENTITY_*`, `LOCAL_RUNNABILITY_*`, warrant-blocked-environment |
| **Settlement-инвариант** (GAP-8) | **каждый** терминальный маршрут (включая оба post-ledger провала: implement --failed, certify --failed) проходит через `settle-development` — ни один выход не минует учёт ledger'а | `TerminalWorkerSettlementError` (ADR-087 хвосты) |
| **Покрытие сохранности** (сессия-2026-08-23) | регистр виден гейтам ВСЕЙ формуляции run-scoped; проекция промпта суммаризирует recovery_feedback ≤12КБ (G1.9) | матрица: run-shape-parity, worker-prompt-assembly |

## 4. ВЫХОД — что цех производит

Settlement (`settle-development`) замораживает **капсулу разработки**:

1. **Принятые продукты имплементации** — код+тесты в репо продукта, каждый
   работу — с Git-рецептом (capsule cell identity = ЗАДАЧА, не исполнение);
2. **Verification ledger** — append-only: на каждый из 20 критериев
   proposed → executed(terminal факт, required-истина открытия) → discharge
   (passed-receipt; executed-failed НЕ разряжает);
3. **Readiness-сертификат** — receipt с fence идентичности (digest образа,
   lock), warrant cross-bind, /healthz-факт;
4. **Settlement record** — локальный вердикт (`formalized`-эквивалент:
   `developed`/`blocked`), stage_outcome/product_outcome разделены;
5. **Кросс-бинды** — warrantRef: discovery ⇄ formalization ⇄ development
   digest-цепочка (сохранность идеи до конца).

Терминальные исходы: `complete` (всё покрыто+readiness passed) | `blocked`
(continuation-приемлемо: implementation-incomplete / local-readiness-failed
/ candidate-missing с decoded producer-defect) | `complete-failed` (бюджет
исчерпан). Любой исход — ровно один `run.terminal` (GAP-4) с разделёнными
вердиктами (GAP-2), без фантомных исполнений (ADR-087 drain).

## 5. Контрольные точки живого прогона (Elite-8 → Development)

- planner-гейт: первое в истории прохождение с run-scoped покрытием —
  ожидаем pass при SRS с `covered_constraint_ids` (скилл теперь учит);
- parallel-карточки: контролы 8/8 должны раскрыть ширину диспетчера;
- readiness: первый прод-прогон K19-fence 1.14.0 + ADR-089/091 на реальном образе.
