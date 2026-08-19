# E9 RESERVE — не удалять (карта резерва рецикл-прогона)

Архитектор отложил E9 (recycle-run) 2026-08-19: «проектировать переиспользование
прогона до того, как завод честно доедет хотя бы раз, — преждевременно».
**Отложено ≠ отменено.** Дизайн готов (`RECYCLE-RUN-DESIGN.md`, синтез Р1+Р2+Р3
с версионным рядом) и опирается на код-резерв, который обязан пережить
ночные смены, гигиену и волны мержа. Этот файл — карта резерва для агентов:
**ничего из перечисленного не удалять и не «чистить» как мёртвое.**

## Резерв (где лежит и зачем)

| Код/механизм | Где | Роль в E9 |
|---|---|---|
| Constraint register (типизированный реестр ордера) | `src/shared/constraint-register.ts` (ветка repair/ac-drift-remedy, protective header `be0690e1`) | baseline честного прогона: реестр v2 = выжившие строки v1 ∪ findings ∪ восстановленный дрейф |
| warrantRef-стык (сетка А3, stub) | formalization settlement + `VerificationWarrantRef` в development-schemas (та же ветка) | каноническая ссылка «реестр+диспозиции» для сертификатора рецикла |
| `integratedRepoState` (headCommit/fileTree/moduleBoundaries) | replan-case-builder (влито) | «код существует» — входит в recycle-кейс; Р3 рекомендовал общий билдер |
| previous-attempt.{json,patch} на desk | repair/blindsight-reconciliation (дерево #8) | обобщение с repair-раундов до read-and-reuse视图 v2 |
| Capsule MISS/HIT по semanticInputDigest | существующая replay-механика | §9-переживаемость findings: затронутые ячейки MISS, нетронутые HIT |
| Wired операторский control-intent (заготовка discovery-diagnosis) | schema-only таблица | форма «двери завода» для FactoryRequest(change) — довести до wired |

## Правило для ночных агентов

Гигиена (stage-12 task 3) удаляет только безымянные скрэтч-артефакты
(`_ke.ps1` и родня). Всё из таблицы выше — **именованный резерв с
документированным назначением**: удаление любого элемента = уничтожение
базовой линии будущего честного прогона. Сомневаешься — эскалируй, не удаляй.

Контекст решений: ARCHITECT-HANDOVER-DRAFT.md §7/E9; STAGE-12-AGENT-BRIEF.md
«Ratified decisions» (E9 deferred); RECYCLE-RUN-DESIGN.md (полный дизайн).
