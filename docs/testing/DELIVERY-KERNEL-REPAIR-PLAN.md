# План: возврат Delivery в единое conformance-ядро

По разбору оператора (2026-08-22 утро): ядро не сломано и уже приносит
пользу, но Delivery подключён архитектурно неправильно, а «движок для всех
4 цехов готов» — преувеличение. План ниже чинит дрейф ДО начала полного
покрытия Development (явное ordering-ограничение оператора).

## Текущее честное состояние (фиксируем как baseline)

| Цех | Статус | Обоснование |
|---|---|---|
| Discovery | **CLOSED 27/27** | через runScenario → bundle → CoverageKernel |
| Formalization | **CLOSED 26/26** | там же |
| Development | spine PASS, **D2–D10 pending** | pack честно декларирует |
| Delivery | spine PASS, **архитектурный долг** | обходит runScenario; много путей pending |
| Глобальная coverage-математика | отсутствует | inventory ≠ universe/kill-rate/aggregate |

## Фаза 1 — Delivery внутрь ядра (три фикса оператора)

### 1.1 ScenarioRunner принимает lifecycleDefinition
`tests/factory-proof/scenario-runner.mjs`:
- новый опциональный параметр `lifecycleDefinition` в `runScenario(...)`;
- пробрасывается в `buildCanonicalProofComposition` (allowlist ключа
  `lifecycleDefinition` уже есть — aec34b18);
- без параметра — дефолт `productBuildLifecycle` (существующее поведение
  discovery/formalization/dev паков не меняется).

### 1.2 readInstalledIdentity фингерпринтит РЕАЛЬНЫЙ lifecycle
Сегодня: `readInstalledIdentity()` жёстко импортирует `productBuildLifecycle`
→ evidence fingerprint врёт при delivery-прогоне.
Фикс:
- identity-функция получает определение lifecycle, которое реально
  установлено/исполняется (передаётся из composition/drive);
- `composition.sections.lifecycle`-хэш должен покрывать именно исполненный
  `productDeliveryLifecycle` в delivery-прогонах;
- отрицательный тест: fingerprint build-прогона ≠ fingerprint delivery-прогона
  той же композиции в остальном.

### 1.3 Убрать mini-runner, Delivery через общий конвейер
Удалить специализированный путь в `tests/factory-proof/delivery-scenario-drive.mjs`
(ручной buildCanonicalProofComposition → driveCanonicalProof → самовызовы
oracle.evaluate() → самосборный `factory.proof.scenario-evidence.v1`).
Переделать по единому шаблону:
```
buildDeliveryRuntimeCase(scenarioId)   // pack: сценарии+оракулы+хендлеры
        ↓
runScenario({ ..., lifecycleDefinition: productDeliveryLifecycle })
        ↓
ScenarioEvidenceBundle v1 (bundleDigest, installationFingerprint, proofModes)
```
Особенности delivery (сборка AUTHORIZED-инпута через прод-модули хэшей,
`launchMod.requestFactoryLaunch`, resolved repo identity) переезжают в
runtime-case builder / тонкую обёртку drive — не в отдельный конвейер
доказательств.

### 1.4 Что это даёт немедленно
- Delivery-бандлы попадают в `CoverageKernel.demonstratedCoverage` (PASS-only)
  — цех становится участником общей coverage-математики;
- один evidence-контракт `factory.proof.scenario-evidence-bundle.v1` на всех;
- K2/T3-решётки распространяются на delivery автоматически.

### 1.5 Тесты фазы 1
- структурный пин: delivery-сценарий через runScenario выдаёт bundle v1 c
  digest + fingerprint, привязанным к delivery-lifecycle;
- пин: scenario-runner передаёт lifecycleDefinition в composition (и не
  передаёт ничего лишнего — overlay allowlist следит);
- regression: discovery/formalization/dev-драйвы не изменили fingerprint
  (байт-в-байт та же identity, что до рефакторинга — прогнать до/после).

## Фаза 2 — честная модель покрытия (после фазы 1)

### 2.1 Статусная таблица как данные
Внедрить в coverage-отчёты понятие workshop closure: CLOSED / SPINE /
PENDING — с числами из паков, чтобы «все 4 цеха зелёные» больше нельзя было
утверждать случайно. Discovery/Formalization = CLOSED; Development = SPINE
(D2–D10 pending: retry-exhaustion, blocked-continuations, repair-loop,
recovery epochs, restart-idempotency, fan-out edge); Delivery = SPINE
(approval-required, denied, observation mismatch, observation-inconclusive,
restart, duplicate-effect/K4 idempotency, provider-untrusted fail-closed,
deferred mode — из DELIVERY_PENDING_UNIVERSE).

### 2.2 Дописывание pending-вселенных
- Development D2–D10 по гайду авторинга (§9), начиная с recovery-класса;
- Delivery pending-сценарии через НОВЫЙ единый путь (фаза 1) — каждый новый
  сценарий сразу проходит bundle→coverage.

### 2.3 Глобальная coverage-математика (поверх workshop-inventory.mjs)
- Factory Coverage Universe: инвентарь обязательств всех 4 паков +
  obligation-contracts + edge-вселенные → единый реестр coverage-токенов;
- demonstrated vs pending vs uncovered по всем цехам (set-equality);
- mutation kill rate: переиспользовать non-vacuity-пины инвентаря как
  мини-мутационную решётку (drop-node/drop-dep уже меняют digest);
- inter-workshop aggregate (handoff-обязательства через границы цехов) и
  recovery aggregate (retry/restart/epoch-сценарии всех цехов);
- глобальный uncovered-obligations отчёт → ratchet (K0-стиль).

## Фаза 3 — верификация и высадка

1. Полный сьют зелёный (включая новые тесты фаз 1–2).
2. Coverage-драйвы: discovery 27/27 и formalization 26/26 не деградировали
   (fingerprint-stability из 1.5); delivery-спина зелёная ЧЕРЕЗ runScenario.
3. Брифинг скорректировать: формулировка «движок для 4 цехов» →
   «ядро единое для 4 цехов; закрыты Discovery и Formalization;
   Development/Delivery — spine + pending-вселенные».
4. Merge → saga4 → push.

## Порядок и критерии готовности

- **Фаза 1 обязательна ДО** разработки полного покрытия Development
  (ordering оператора: чинить дрейф до расширения).
- Фаза 1 готова, когда: delivery-сценарий выдаёт стандартный bundle,
  fingerprint связан с исполненным lifecycle, mini-runner удалён,
  все решётки зелёные.
- Фаза 2 готова, когда: closure-статусы являются данными, pending-вселенные
  сходятся с пакетными декларациями (set-equality), глобальный отчёт
  существует и включён в ratchet.
- Фаза 3 — стандартные ворота высадки.

## Риски

- Fingerprint-stability (1.5): смена identity-вычисления заденет исторические
  bundle-digest'ы — фиксированная точка: до/после на неизменённых прогонах.
- Authorized-инпут delivery зависит от прод-модулей хэшей — при переносе в
  runtime-case builder следить, чтобы не появился тест-сайд синтез authority
  (разрешены только те же прод-модули, что сейчас).
