# Skills Audit — все скиллы, что есть и что пригодится цехам

> Дата: 2026-07-31. Состояние репо: коммит `0088685` (saga4 one conveyor).
> 4 research-агента отработали. Каждый блок с кликабельными `file:line` ссылками
> и абсолютными путями к SKILL.md.

---

## ✅ Скиллы — 3 уровня хранения (уточнённая картина)

После углублённой проверки картина **здоровая**, а не сломанная:

| уровень | путь | что там | как используется |
|---|---|---|---|
| **1. Пакетные скиллы** | `src/process-modules/modules/*/package/resources/skills/<name>/SKILL.md` | 13 продуктовых скиллов (4 discovery + 6 formalization + 3 development) | ✅ **рабочий путь**: materializer берёт SKILL.md из content-addressed store, хеши проверяются |
| **2. Платформенные скиллы** | `skills/<name>/SKILL.md` (корень репо) | мета/инфра скиллы (worker-protocol, planning-reviewer, module-designer, code-reviewer...) | регистрируются в `resourceIndex` модулей как `kind:'instruction'` / `kind:'reviewer-skill'` |
| **3. Установленные** | `C:\Users\user\.zcode\skills\` | 18 скиллов (статичные копии от Jul 19) | legacy для прямой ручной работы БЕЗ модулей; модули их **не используют** |

### Почему "отсутствующие в `~/.zcode/skills/`" — НЕ проблема

`materializePinnedSkill` (`src/infrastructure/workers/legacy-claude-worker-executor-factory.ts:162-191`)
берёт SKILL.md **из pinned package** (content-addressed store), НЕ из `~/.zcode/skills/`.
Хеш проверяется → файл пишется в `os.tmpdir()/saga-pinned-skills/<digest>/<skill>/SKILL.md`.
Так что рабочий всегда получает правильный скилл из пакета, даже если в `~/.zcode/skills/`
лежит устаревшая копия.

### Регистрация скиллов в манифестах (проверено — корректно)

| модуль | execution skills | reviewer skills | protocol skill | всё в `resourceIndex`? |
|---|---|---|---|---|
| Discovery | 4 (`kind:'skill'`) `manifest.ts:236+` | — | 1 (`kind:'instruction'`) `manifest.ts:236` | ✅ |
| Formalization | 4 (`kind:'skill'`) | 2 (`kind:'reviewer-skill'`) `manifest.ts:178,184` | 1 (`kind:'instruction'`) `manifest.ts:191` | ✅ |
| Development | 2 (`kind:'skill'`) | 2 (`kind:'reviewer-skill'`) `manifest.ts:152` | 1 (`kind:'instruction'`) | ✅ |
| Delivery | — | — | — | — (0 LM-узлов) |

> `findNamedResource` (`workspace-projection.ts:318-340`) мэтчит по `logicalId` →
> basename → path-suffix. Protocol ищется как `'skill' ?? 'instruction'` —
> находит через `kind:'instruction'`. Reviewer ищется как `kind:'reviewer-skill'` —
> находит. **Всё работает.**

### Реальные пробелы (после уточнения)

1. **`~/.zcode/skills/` устарели** (Jul 19) — НЕ влияет на модули, но влияет на
   прямую ручную работу (если человек вызывает скилл без модуля). Косметика.
2. **`saga-verifier` orphan** — существует, но НИ ОДИН executionProfile не ставит
   `executionSkill: 'saga-verifier'`. Development прогоняет verification через
   `saga-worker`. Кандидат на отдельный profile или удаление.
3. **Discovery reviewer skills отсутствуют** — все 4 discovery-профиля не имеют
   `reviewSkill` (advisory by design — readiness/diagnosis advisors = review surface).

---

## 1. Saga-скиллы — полный инвентарь (18 установленных)

### 1.1 Рабочие скиллы модулей (referenced by execution profiles)

| skill | роль | модуль / task_kind | путь SKILL.md | установлен? |
|---|---|---|---|---|
| `saga-product` | Product Owner: PRD | formalization `formalization.prd` | `C:\Users\user\.zcode\skills\saga-product\SKILL.md` | ✅ |
| `saga-analyst` | Business Analyst: UC/AC | formalization `formalization.uc`, `formalization.ac` | `…\saga-analyst\SKILL.md` | ✅ |
| `saga-architect` | System Architect: SRS | formalization `formalization.srs` | `…\saga-architect\SKILL.md` | ✅ |
| `saga-reconciler` | формализация→planning reconciliation | formalization `formalization.reconciliation` | `…\saga-reconciler\SKILL.md` | ✅ |
| `saga-requirements-reviewer` | ревьюер PRD/UC/AC/reconciliation | formalization reviewSkill ×4 | `…\saga-requirements-reviewer\SKILL.md` | ✅ |
| `saga-architecture-reviewer` | ревьюер SRS | formalization reviewSkill (architect) | `…\saga-architecture-reviewer\SKILL.md` | ✅ |
| `saga-planner` | декомпозиция → task graph | development `planning.decomposition` | `…\saga-planner\SKILL.md` | ✅ |
| `saga-worker` | код, ревью, мерж, верификация | development `implementation.feature` + `verification.ac` | `…\saga-worker\SKILL.md` | ✅ |

### 1.2 Объявлены в модулях, НО не установлены (КРИТИЧНО — см. §КРИТ №2)

| skill | где объявлен | в репо? | установлен? |
|---|---|---|---|
| `saga-discovery-worker` | `discovery-process-module.ts:233` | ❌ | ❌ |
| `saga-discovery-normalizer` | `discovery-process-module.ts:257` | ❌ | ❌ |
| `saga-discovery-readiness-advisor` | `discovery-process-module.ts:275` | ❌ | ❌ |
| `saga-discovery-diagnosis-advisor` | `discovery-process-module.ts:293` | ❌ | ❌ |
| `saga-planning-reviewer` | `development-process-module.ts:388` | ✅ `skills/saga-planning-reviewer/` | ❌ |
| `saga-process-module-worker-protocol` | protocolSkill ВСЕХ модулей | ✅ `skills/saga-process-module-worker-protocol/` | ❌ |

### 1.3 Инфраструктурные/оркестраторские (НЕ модульные)

| skill | роль | используется модулями? | путь |
|---|---|---|---|
| `saga-orchestrator` | полный флоу Discovery→Delivery | ❌ legacy/external | `…\saga-orchestrator\SKILL.md` |
| `saga-dispatch` | цикл раздачи воркеров до пустой очереди | ❌ (используется только внутри saga-orchestrator SKILL body) | `…\saga-dispatch\SKILL.md` |
| `saga-tracker` | bootstrap доски + worker_next контракт | ❌ bootstrap | `…\saga-tracker\SKILL.md` |
| `saga-start` | старт/attach продукта | ❌ bootstrap | `…\saga-start\SKILL.md` |
| `saga-kickstart` | OLD discovery idea→brief→decision | ❌ superseded (модуль использует saga-discovery-*) | `…\saga-kickstart\SKILL.md` |
| `saga-patrol` | read-only снимок эпика | ❌ наблюдение | `…\saga-patrol\SKILL.md` |
| `saga-release` | release-checklist САМОГО saga-mcp | ❌ (не продукта) | `…\saga-release\SKILL.md` |

### 1.4 Существует, но НЕ привязан ни к одному модулю (orphan)

| skill | роль | почему orphan |
|---|---|---|
| `saga-verifier` | независимая L3-верификация AC | development прогоняет ВСЁ (impl+review+verify) через `saga-worker`; planner SKILL упоминает saga-verifier, но НИ ОДИН executionProfile не ставит `executionSkill: 'saga-verifier'`. Кандидат на отдельный профиль verification. |
| `senior-analyst` | методология requirements engineering | загружается saga-orchestrator на Complexity Gate; не модульный |
| `autonomous-recovery` | recovery loop (Cynefin+MCDA) | для recovery.heal задач; не привязан к executionProfile |

---

## 2. Карта подключения скиллов к цехам (execution profiles)

Источник: секции `executionProfiles:` в каждом `*-process-module.ts`.
Единый `protocolSkill = 'saga-process-module-worker-protocol'` (CONST `PROCESS_PROTOCOL_SKILL`).

### 2.1 Полная таблица профилей

| цех | profile.id (файл:строка) | task_kind | executionSkill | reviewSkill | executionMode | tracker |
|---|---|---|---|---|---|---|
| Discovery | `discovery-proposal-worker` `src/process-modules/modules/discovery/discovery-process-module.ts:233` | `discovery.work` | saga-discovery-worker ❌ | **(нет)** | tracker_only | proposal-stage-tracker.md |
| Discovery | `discovery-normalizer` `…:257` | `discovery.normalize` | saga-discovery-normalizer ❌ | **(нет)** | tracker_only | normalization-stage-tracker.md |
| Discovery | `discovery-readiness-advisor` `…:275` | `discovery.assess` | saga-discovery-readiness-advisor ❌ | **(нет)** | tracker_only | readiness-stage-tracker.md |
| Discovery | `discovery-diagnosis-advisor` `…:293` | `discovery.diagnose` | saga-discovery-diagnosis-advisor ❌ | **(нет)** | tracker_only | diagnosis-stage-tracker.md |
| Formalization | `formalization-product` `src/process-modules/modules/formalization/formalization-process-module.ts:315` | `formalization.prd` | saga-product ✅ | saga-requirements-reviewer ✅ | artifact_change | process-module-stage-tracker.md (общий) |
| Formalization | `formalization-use-cases` `…:335` | `formalization.uc` | saga-analyst ✅ | saga-requirements-reviewer ✅ | artifact_change | тот же |
| Formalization | `formalization-acceptance` `…:355` | `formalization.ac` | saga-analyst ✅ | saga-requirements-reviewer ✅ | artifact_change | тот же |
| Formalization | `formalization-reconciler` `…:375` | `formalization.reconciliation` | saga-reconciler ✅ | saga-requirements-reviewer ✅ | artifact_change | тот же |
| Formalization | `formalization-architect` `…:395` | `formalization.srs` | saga-architect ✅ | saga-architecture-reviewer ✅ | artifact_change | тот же |
| Development | `development-task-graph-planner` `src/process-modules/modules/development/development-process-module.ts:380` | `planning.decomposition` | saga-planner ✅ | saga-planning-reviewer ❌ | tracker_only | process-module-stage-tracker.md |
| Development | `development-implementation-worker` `…:432` | `implementation.feature` | saga-worker ✅ | saga-worker (self) ✅ | git_change | implementation-task-tracker.md |
| Delivery | **(нет профилей)** `src/process-modules/modules/delivery/delivery-process-module.ts:324` | — | — | — | детерминированный | — |

> ❌ = объявлен в профиле, но скилл НЕ установлен → рабочий упадёт.
> ✅ = установлен и работает.

### 2.2 LM-узлы Flow ↔ профили

| цех | LM-узлы (kind:'lm') | профиль без Flow-ноды? |
|---|---|---|
| Discovery | `src/process-modules/modules/discovery/discovery-process-module.ts:59,83,113` (3 узла) | **да**: `discovery-diagnosis-advisor` (адвизори, удалён из flow) |
| Formalization | `src/process-modules/modules/formalization/formalization-process-module.ts:58,74,90,106,131` (5 узлов) | нет — все 5 привязаны |
| Development | `src/process-modules/modules/development/development-process-module.ts:129` (1 узел plan-task-graph) | **да**: `development-implementation-worker` (worker_next-claimed) |
| Delivery | 0 LM-узлов (всё kernel + 1 human) | — |

> **Критично для ASSISTANCE HOOKS:** профили без Flow-ноды вызовут
> `AGENT_ASSISTANCE_NODE_AMBIGUOUS` в `resolveOwningNodeId`
> (`src/process-modules/application/pinned-workspace-materializer.ts:173`).

---

## 3. Plugin-скиллы (переиспользуемые в цехах)

Бандлы в `C:\Users\user\.zcode\cli\plugins\cache\zcode-plugins-official\`:
`document-skills`, `browser-use`, `skill-creator`, `zcode-guide`, **`superpowers`**, `android-emulator`, `ios-simulator`.

### 3.1 GENUINELY USEFUL для продуктовых цехов

| skill | роль в saga | лучший цех | путь SKILL.md | caveat |
|---|---|---|---|---|
| `document-skills:pdf` | рендеринг артефактов (spec→PDF, release notes, диаграммы) | Formalization, Delivery | `…\document-skills\0.1.0\skills\pdf\SKILL.md` | сильнейший фит: vector output + preflight + 4 pipeline |
| `document-skills:docx` | рендеринг (spec→DOCX с TOC/revisions) | Formalization | `…\document-skills\0.1.0\skills\docx\SKILL.md` | `postcheck.py` enforce качества |
| `browser-use:web-gui-tester` | AC-driven black-box GUI верификация | Development (verification) | `…\browser-use\0.1.0\skills\web-gui-tester\SKILL.md` | блок: `control-browser` main-agent-only — saga-verifier это subagent, конфликт |
| `skill-creator` | мета: авторинг НОВЫХ saga-скиллов | (мета) | `…\skill-creator\0.1.0\skills\skill-creator\SKILL.md` | для эволюции saga-skill suite |

### 3.2 Superpowers (11 скиллов — Development цех)

Все в `…\zcode-plugins-official\superpowers\5.1.0\skills\<name>\SKILL.md`.

| skill | применимость к цехам |
|---|---|
| `test-driven-development` | Development impl-worker — **сильный фит** как semantic-навык |
| `systematic-debugging` | Development impl-worker |
| `requesting-code-review` / `receiving-code-review` | Development review-loop |
| `verification-before-completion` | Development (worker_done gate) |
| `writing-plans` / `executing-plans` | Development planner + impl-worker |
| `subagent-driven-development` / `dispatching-parallel-agents` | Development dispatch-loop (concurrency) |
| `using-git-worktrees` | Development git_change |
| `finishing-a-development-branch` | Development integration |
| `brainstorming` | Discovery |
| `using-superpowers` / `writing-skills` | мета |

### 3.3 IRRELEVANT к продуктовым цехам (подтверждено)

`zcode-guide:diagnosing-*` (6 скиллов) — диагностика ZCode-клиента, 0 продуктовой семантики.
`android-emulator`, `ios-simulator` — платформо-специфичные.
`restore-legacy-sessions` — восстановление сессий ZCode.

---

## 4. Матрица асимметрий конвейерной механики (полная — 4-й агент)

| механика | discovery | formalization | development | delivery |
|---|---|---|---|---|
| protocolSkill | ✅ (4/4) НО скилл НЕ установлен | ✅ (5/5) НО скилл НЕ установлен | ✅ (2/2) НО скилл НЕ установлен | — (нет профилей) |
| tracker с feedback-first-rule | 3/4 YES; **diagnosis MISSING** | ✅ (rule 6: оба файла) | planner ✅; **impl PARTIAL** (только review-feedback, нет recovery-feedback) | — |
| tracker с assistance-rule | ❌ (НИ ОДИН не ссылается на agent-assistance.json) | ❌ | ❌ | ❌ |
| checklists | ✅ (4) | ✅ (1 общий) | ✅ (2) | ❌ (loose files, нет profile-binding) |
| call-templates | ✅ (4) | ✅ (3) | PARTIAL (1; **impl `callTemplates: []`**) | — |
| `assistance.ts` | ✅ `src/process-modules/modules/discovery/package/assistance.ts` | ❌ | ❌ | ❌ |
| assistance подключён в manifest | ✅ `src/process-modules/modules/discovery/package/manifest.ts:428` | ❌ | ❌ | ❌ |
| reviewSkill non-null | ❌ (НИ ОДИН профиль) | ✅ (5/5) | ✅ (2/2; impl reuses saga-worker) | — |

### Ключевые пробелы (выделенные):

1. **`agent-assistance.json` производится, но НИ ОДИН трекер/протокол не говорит рабочему его читать** — файл осиротел везде. Нужна правка `saga-process-module-worker-protocol` + трекеров.
2. `diagnosis-stage-tracker.md` — единственный discovery-трекер без rework-rules блока.
3. `implementation-task-tracker.md` — упоминает `review-feedback.json`, но НЕ `recovery-feedback.json` → gate-healer recovery не дойдёт до impl-рабочих.
4. `development-implementation-worker` — единственный профиль с пустым `callTemplates: []`.
5. Discovery — единственный модуль без reviewSkill (advisory by design).
6. Delivery — полностью детерминированный (нет worker-conveyor surface).

---

## 5. Выводы для следующих задач

### 5.1 ASSISTANCE HOOKS (ближайшая задача)

1. **Рантайм-механизм уже универсален** — `src/process-modules/application/pinned-workspace-materializer.ts:374-420` гидратирует `agent-assistance.json` из `manifest.assistance`. Не хватает только **данных** в formalization (5 узлов) и development (планнер + impl-worker).
2. **Delivery не нуждается** — 0 LM-узлов.
3. **2 flow-less профиля** требуют фикса `resolveOwningNodeId` (`pinned-workspace-materializer.ts:162-180`).
4. **Валидатор мёртв** — `validateAgentAssistanceDefinition` (`src/process-modules/domain/spi/agent-assistance.ts:268`) существует, но никто не вызывает; `validateProcessModuleManifest` игнорит `assistance`.
5. **Протокол НЕ говорит читать assistance** — нужно добавить в `skills/saga-process-module-worker-protocol/SKILL.md` правило "read agent-assistance.json beside tracker".

### 5.2 Скиллы-синхронизация (уточнено — НЕ критично)

1. **Пакетные скиллы РАБОТАЮТ** — `materializePinnedSkill` берёт из content-addressed
   store, `~/.zcode/skills/` для модулей не нужен.
2. **`~/.zcode/skills/` устарели** — влияет только на прямую ручную работу без модулей.
   Можно обновить позже (sync-скрипт или симлинки).
3. **`saga-verifier` orphan** — кандидат на отдельный executionProfile в development,
   либо подтверждение что `saga-worker` покрывает verification.
4. **Protocol skill** (`saga-process-module-worker-protocol`) — НЕ упоминает
   `agent-assistance.json` и `recovery-feedback.json` / `review-feedback.json`.
   Это **главная правка** для hooks-задачи: протокол должен учить рабочего читать
   хуки и фидбек, а не только трекер.

### 5.3 Plugin-усиление (опционально, позже)

1. `superpowers:test-driven-development` + `systematic-debugging` → semantic augmentation для development impl-worker.
2. `document-skills:pdf` / `docx` → рендеринг formalization/delivery артефактов.
3. `browser-use:web-gui-tester` → verification GUI-продуктов (требует решения main-agent-only конфликта).

---

## Ссылки-источники (кликабельные)

### Модули
- Discovery: `src/process-modules/modules/discovery/discovery-process-module.ts`
- Formalization: `src/process-modules/modules/formalization/formalization-process-module.ts`
- Development: `src/process-modules/modules/development/development-process-module.ts`
- Delivery: `src/process-modules/modules/delivery/delivery-process-module.ts`

### Assistance-механика
- SPI: `src/process-modules/domain/spi/agent-assistance.ts`
- Renderer: `src/process-modules/application/agent-assistance-renderer.ts`
- Materializer (гидратация): `src/process-modules/application/pinned-workspace-materializer.ts`
- Discovery assistance data (единственный): `src/process-modules/modules/discovery/package/assistance.ts`
- Discovery manifest (wiring): `src/process-modules/modules/discovery/package/manifest.ts`
- Manifest validator: `src/process-modules/domain/spi/module-manifest.ts`

### Скиллы (исходники в репо)
- Worker protocol: `skills/saga-process-module-worker-protocol/SKILL.md`
- Planning reviewer: `skills/saga-planning-reviewer/SKILL.md`
- Module designer: `skills/saga-process-module-designer/SKILL.md`
- Code reviewer: `skills/saga-code-reviewer/SKILL.md`

### Трекеры
- Discovery: `src/process-modules/modules/discovery/package/resources/*-stage-tracker.md`
- Formalization: `src/process-modules/modules/formalization/package/resources/process-module-stage-tracker.md`
- Development planner: `src/process-modules/modules/development/package/resources/process-module-stage-tracker.md`
- Development impl: `src/process-modules/modules/development/package/resources/implementation-task-tracker.md`
