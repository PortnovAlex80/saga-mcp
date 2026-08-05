# W13 Legacy Removal — Честный Аудит Exit-Gates

> Аудит выполнен после находки бага #4 (model-driven flow ломается на `PROCESS_WORKSPACE_ASSET_MISSING`).
> Метод: `git show <sha> --stat` (что заявлено) → `grep`/`find`/`node` по коду (что реально).
> Принцип: **не верить commit-messages, верифицировать реальное состояние**.

## Сводная таблица W13 Lanes

| Lane | Заявлено | Реально | Статус |
|---|---|---|---|
| **A1** | Удалить catalog.ts, installations.ts, catalog import в resolver | Файлы удалены, resolver переписан на inline | ✅ честно |
| **A2** | Удалить global skill/template/tracker/workspace special-cases | tracker-reminder.mjs удалён, special-case КОД убран, НО **ФАЙЛЫ tool-templates/ + skills не перенесены в packages**. Descriptors хардкодят legacy global-root пути | ❌ ПРОВАЛ |
| **A3** | Удалить routeResolver, Object.defineProperty dodge, ProcessOutputPayloadRegistry | routeResolver убран, dodge убран, Registry удалена из src. НО **stale dist leftover** (`dist/.../process-output-payload-registry.js` остался, исчезнет при clean rebuild) | ⚠️ частично |
| **A4** | Удалить `restoreFrame()` legacy path (v2 only), `listArtifactsForNodeInEpic` fallback | **`restoreFrame()` всё ещё вызывается** (`generic-flow-executor.ts:459`), `listArtifactsForNodeInEpic` тоже есть. Коммит тронул только `sqlite-managed-production-ledger.ts` | ❌ ПРОВАЛ |
| **A5** | Удалить hard-coded Discovery workflow strings из saga3-args.ts, параметризовать workflow hint в saga3-proposals.ts | Hardcoded strings убраны | ✅ честно |
| **A6** | Заменить legacy manual-wiring composition-root на composition loader | Body переехал в `src/app/product-lifecycle-runtime.ts`, файл стал thin re-export shim | ✅ честно |
| **A7** | Drop unused tables/columns после retention proof | Retention proof честный: блокирует ВСЕ drop candidates (всё используется). Ничего не удалено, т.к. нечего | ✅ честно (nothing to do) |
| **A8** | DoD verification test | Тест существует, НО поверхностный (см. §18 ниже) | ⚠️ тест есть, но не ловит |

## Сводная таблица Definition of Done §18

| Пункт | Заявлено | Реально | Статус |
|---|---|---|---|
| **§18.1** | Новый Process Module Package ставится без правок Runtime | DoD test проверяет synthetic lmMarketing module через installPackage API | ⚠️ API-only, не доказывает реальную extensibility |
| **§18.3** | Runtime core НЕ импортирует concrete module impl | `grep` подтверждает — application/domain чистые (только composition imports modules) | ✅ честно |
| **§18.4** | Modules НЕ импортируют другие module impl | Нужно верифицировать отдельно | ❓ не проверено в этом аудите |
| **§18.5** | Каждый active run pinned to immutable bytes | **`package_digest: null`, `installation_id: null` в реальных ProcessRuns**. Тест проверяет synthetic manual INSERT + setPinnedInstallation API, но **production path (orchestrate-cli/LifecycleOrchestrator) НЕ пинит runs** | ❌ ПРОВАЛ (false-green) |
| **§18.7** | Recovery использует durable receipts, НЕ latest-execution fallback | `restoreFrame()` legacy fallback ОСТАЛСЯ (см. A4) | ❌ ПРОВАЛ |
| **§18.8** | Tracker + agent assistance из authoritative protocol state | Renderer **НЕ wired в production**. Hook сам признаёт в комментарии: *«Until W5-A6 wires the W5-A4 AgentAssistanceRenderer ... the hook fails closed to '{}'»*. Workers не получают assistance | ❌ ПРОВАЛ |
| **§18.9** | Module-specific tools/skills/templates/checklists ship with owning package | Discovery/Formalization/Development templates **НЕ в packages** (см. A2) | ❌ ПРОВАЛ |
| **§18.10** | Product Delivery + Campaign complete through same Runtime | DoD test использует stub executor `throw new Error('not executed')`. **Нет real model-driven e2e** через spawn claude | ❌ ПРОВАЛ (false-green) |
| **§18.11** | Scenarios complete repeatedly без manual edits | Именно это сломалось в model-driven прогоне (бага #4) | ❌ ПРОВАЛ |

## Корневая патология (повторяется 4 раза)

**Pattern «incomplete refactor masked by green tests»:**

1. Спека требует удалить X
2. Коммит заявляет «X removed»
3. Реально: убран только special-case КОД, либо тронут adjacent файл
4. Файлы/функции остаются в коде
5. Тесты зелёные, потому что:
   - DoD test проверяет synthetic/unit-API, не production path
   - Ни одного real model-driven e2e (spawn claude) теста в wave
6. Регрессия всплывает только при РЕАЛЬНОМ использовании (как бага #4)

**Где всплыло:** только когда я запустил реальный model-driven flow. Все W13 тесты зелёные, но production сломан.

## Конкретные доказательства (file:line)

### ❌ A4 — `restoreFrame()` жив
- Подзадача W13-a4.md: *«REMOVE generic-flow-executor.ts restoreFrame() legacy path (v2 only)»*
- Коммит `196ad0f`: тронул ТОЛЬКО `sqlite-managed-production-ledger.ts`
- Реально: `src/process-modules/application/generic-flow-executor.ts:459` → `const frame = restoreFrame(context.inputPayload, allRuns);`
- `listArtifactsForNodeInEpic`: `src/process-modules/application/execution-context-assembler.ts` (grep подтверждает наличие)

### ❌ §18.5 — ProcessRuns не пинятся
- Спека: *«Every active run is pinned to immutable scenario + module package bytes»*
- DoD test `tests/execution/definition-of-done.test.mjs:740`: manual `setPinnedInstallation(runId, ...)`
- Реальный прогон: `SELECT package_digest, installation_id FROM saga3_process_runs` → `[null, null]`
- Production path (orchestrate-cli → LifecycleOrchestrator → start) НИКОГДА не вызывает setPinnedInstallation

### ❌ §18.8 — Renderer не wired
- `tracker-view/structured-context-hook.mjs:53`: *«Until W5-A6 wires the W5-A4 AgentAssistanceRenderer to write agent-assistance.json at runtime, the hook fails closed to '{}'»*
- `src/process-modules/application/agent-assistance-renderer.ts` существует, но НЕ вызывается из production (только упоминается в комментариях)

### ❌ §18.10/11 — Нет real model-driven e2e
- DoD test `tests/execution/definition-of-done.test.mjs:1061`: `executor: { kind: 'legacy-adapter', execute: async () => { throw new Error('not executed at install time'); } }`
- `grep -rln "createPinnedClaudeWorkerExecutorFactory" tests/` → пусто. Ни один тест не спавнит реальный claude.

## Рекомендации (НЕ чинить — только список)

1. **A4**: дополнительно удалить `restoreFrame()` legacy path + `listArtifactsForNodeInEpic`, ИЛИ явно задокументировать почему они оставлены (dual-path v2/legacy — но тогда DoD §18.7 ложный)
2. **A2/§18.9**: завершить миграцию tool-templates + skills в packages (мигратор уже работает над этим)
3. **§18.5**: wire package pinning в production path (orchestrate-cli → orchestrator → start должен выставлять package_digest). Это **P-PM-1** из PROCESS-MODULE-PACKAGE-SPI
4. **§18.8**: wire AgentAssistanceRenderer в production (чтобы hook перестал fail-closed на '{}')
5. **§18.10/11**: добавить минимум один real model-driven e2e тест через spawn claude (не stub), чтобы патология «green tests, broken prod» не повторялась
6. **A3**: clean rebuild (`rm -rf dist && npm run build`) чтобы убрать stale leftovers (process-output-payload-registry.js)
7. **Процесс**: каждый DoD пункт должен иметь ЧЕСТНОЕ доказательство выполнения через production path, не synthetic unit-API test
