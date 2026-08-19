# RECYCLE RUN — рециклный прогон завода (E9)

Постановка (оператор, verbatim в ARCHITECT-HANDOVER-DRAFT.md §7): новый
прогон НЕ с нуля — «хук» в сессию завода: проект выпущен, есть недочёты,
это не вина завода; изучи текущий код и учти замечания. Вход — discovery и
формализация (управляющий вход разработки). Каждый воркер знает: код
СУЩЕСТВУЕТ — по каждому пункту с нуля vs read-and-reuse.

---

## Р1 (контракт, order-side): CHANGE-REQUEST КАК ПРИЛОЖЕНИЕ К ОРДЕРУ v2 ✅

Рекомендован **вариант A**: новая таблица `factory_order_change_requests` +
discovery-case v2.

- **Рецикл = новый FactoryOrder(change)** с типизированным
  change-request-приложением: `{baseOrderRef, baseProductRevisionRef,
  baseCommit, findings[], retiredRequirements[]}`.
- **Findings машиночитаемо** из четырёх источников с сохранением ID:
  BUG-DATABASE (B-001..), censuses (PREVENTIVE-HUNT F/C/X-коды),
  acceptance-отчёт, AC-drift реестры — контент-адресация (§9: никаких
  указателей на строки старого прогона).
- **Классификация NEW/MODIFY/REUSE — выход proposal-v2** с per-ID
  disposition-гейтом по образцу А1 ( obligation-bridge): discovery обязан
  отреагировать на каждый finding и каждую выжившую строку v1.
  **RETIRE — только оператор** (явный список retiredRequirements).
- **Discovery-case v2 = baseline + findings**; реестр constraints v2 =
  выжившие warrant-строки v1 ∪ findings ∪ восстановленные дрейф-строки
  (docker/TS/Chrome входят автоматически как восстановленные).
- **Blame-атрибуция** (вина/невина) остаётся provenance в BUG-DB — в
  нормативный реестр не входит: конвейер v2 получает «что чинить», не «кого
  винить».
- Отвергнуто: changeItems-в-ордере (ломает принцип «ордер — голос оператора,
  не ТЗ»; классификация — работа discovery, не оператора) и
  continuation-механика (продолжение живого рана ≠ переработка
  завершённого).

## Р2 (механика цехов, factory-side): RECYCLE = КОМПОЗИЦИЯ ТРЁХ СУЩЕСТВУЮЩИХ МЕХАНИК ✅

Опорный факт: continuation уже умеет «база = существующий код»
(`factory-continuation.ts:138-176` — expectedBaseCommit = head
integration-ветки + defectEvidence); `integratedRepoState` уже умеет
«увидеть весь код» детерминистически (`replan-case-builder.ts:148-196`);
patch-on-desk уже умеет «видеть, но не связан» (дерево #8). Критическая
лакуна: **формализация репо читать не может** (все профилы `tracker_only`,
`formalization-process-module.ts:301-317`; desk провижинится только на
`git_change`) — знание «что существует» приносится В кейс данными.

### Вариант 1 (рекомендованный): recycle-continuation + разметка как данные

- **Вход**: операторская команда в стиле continuation (`resumeStageId:
  'solution-formalization'`, `externalBaselineSnapshot = {head, findings,
  releasedBaselineRef}`); `buildReplancase` рефакторится — построение
  `integratedRepoState` в общий билдер; FormalizationCase += recycleContext.
- **AC-граф v2**: `implementationDisposition: new | modify-existing:{files}
  | verify-existing` — типизированное поле в том же baseline-payload, что
  `covered_constraint_ids` (один источник, три проекции, digest-pin
  бесплатен). Mapping предлагает AC-автор, гейт детерминирован:
  modify-файлы ∈ kernel-pinned fileTree; каждое замечание диспозировано ≥1
  AC (паттерн A1-obligation-bridge). Правдивость — вторая сеть:
  ревьюер-деск с перечнем ID.
- **Разработка**: провижининг не меняется структурно — worktree уже
  базируется на expectedBaseCommit (`development-schemas.ts:182`), recycle
  ставит его = HEAD релиза; код оказывается в worktree сам. Планировщик
  наследует диспозиции тем же каналом, что constraint-IDs
  (`development-check-providers.ts:1017-1025`): modify-existing →
  changeScopes = mappedFiles; verify-existing → только verificationItems.
- **«Прочитал прежде чем писать» — НЕ по логу сессии** (tool_use-захвата
  нет): результат карточки += типизированные `dispositions: [{path,
  reuse|rewrite|partial, why}]`; автор-гейт проверяет ФОРМУ диффа
  (modify-existing: diff ∩ mappedFiles ≠ ∅; new: diff ∩ fileTree = ∅ без
  явной диспозиции). Обобщение previous-attempt: patch-view кода вне scope
  воркера той же механикой #8.
- **Анкоринг-гард**: ревьюер-вердикт += anchoring-вопрос («реюз обоснован
  или патчение плохого?»); `recycleRounds` кэп 2 (паттерн REPLAN-CYCLE §6);
  «реюз как отговорка» ловится траекторией — байт-идентичный finding-set
  при чисто аддитивном патчинге = spinning → stop.

### Вариант 2: read-only repo desk для формализации

`tracker_only + readOnly` в recycle-прогонах — AC-автор читает реальный код.
Хорош как УСИЛЕНИЕ варианта 1 (для formalization-architect), не замена:
самый острый edge дезориентации (silent wrong-content reads), токен-цена,
недетерминизм — kernel-pinned fileTree остаётся authority, чтение advisory.

### Отвергнуто

Merge/inherit релиза в шаблон (тот же вердикт, что REPAIR-CODE-PRESERVATION
— anchoring bias + ломка frozen-base); только ре-верификация (нет мощности
изменения); гейт по Read-событиям (инфраструктуры нет, shim-трейсы advisory).

### Не покрывает

Правдивость mapping'а — суждение LLM (сети: ревьюер + форма диффа);
«частичный реюз» не типизирован; флип диспозиции (verify упал → modify)
требует пути через reconciliation-узел; качество чтения кода воркером —
только ревьюером; discovery-часть хука — вне угла (Р1).

## Р3 (authority и форма хука): CHANGE-ORDER ЧЕРЕЗ WIRED CONTROL-INTENT ✅

(дополнение про линейную версионность продукта — вторым заходом, ⏳)

- **Control intents — НЕ операторский канал** (это проекция внутренних задач
  воркеров, `sqlite-discovery-runtime.ts:862/973`); запись извне =
  вмешательство в живой прогон. Но `factory_discovery_diagnosis_control_
  intents` — правильно спроектированная ЗАГОТОВКА операторского входа
  (привязка к certificate/hash), schema-only: ни INSERT, ни ридера — её надо
  довести до wired.
- **Continuation нелегален и неверен**: v1 терминал `runnable-local` не
  проходит `isContinuableTerminal`; continuation ремонтирует тот же заказ,
  change — новая бизнес-воля.
- **§9-переживаемость находок**: materialized как immutable content-addressed
  продукты, digest находок + digest baseline входят в `semanticInputDigest`
  → затронутые ячейки дают capsule MISS (воркер осознанно решает с нуля vs
  reuse), нетронутые — легальный HIT (35 капсул v1 project-scoped
  переживают ран). Ссылки на строки v1 — только provenance.
- **Authority над кодом: та же ветка dev новыми карточками** (канонические
  рефы двигает только fenced-CAS-эффект; v1 sealed-рефы append-only).
  Форк легален, но плодит bindings и merge-back authority. Rebase на тег —
  ОТВЕРГНУТ: переписывает деревья под запечатлённым review, нарушение
  §18/§27. Владелец директорий изменений — planner (strict write authority
  в WorkIntent) + детерминированный Git Gate, не оператор и не воркер.
- **Бюджеты не наследуются** (workplace/obligation-scoped). Риск — не
  наказание v2, а КОНТАМИНАЦИЯ: ADR-053-швы (выборка задач по эпику без
  lifecycle-фильтра `sqlite-formalization-kernel.ts:308`; newest-wins
  капсульный биндер). **Precondition рецикла: lifecycle-точность
  baseline/binder.** «Не вина завода» = typed origin + ownership-классы;
  находки v1 = новые reason-ключи = работа, не спин.
- **Вариант A (рекомендован)**: `FactoryRequest(change)` — новый ордер+ран,
  source_kind `change`, baseline = sealed v1 (commit+tree digest), находки =
  typed operator-input продукты с per-ID диспозициями, вход через wired
  операторский control-intent (образец — discovery-diagnosis). Не покрывает
  anchoring bias — per-item «rebuild vs reuse» обязан быть явным typed
  продуктом карточки (закрыто Р2).

## Синтез трёх (предварительный, без версионности): ✅

Все трое независимо сходятся на одном стержне:

| Слой | Решение | Автор |
|---|---|---|
| Контракт | НОВЫй FactoryOrder(change) c ChangeRequestAppendix; findings типизированы, ID сохранены; RETIRE только оператор; монотонность реестра (v2 ⊇ выжившее v1) | Р1 |
| Канал | Wired операторский control-intent (довести discovery-diagnosis-заготовку); continuation отвергнут всеми тремя | Р3 |
| Семантика сессии | capsule MISS/HIT по semanticInputDigest — «код существует» переживает §9; integratedRepoState в кейсе | Р3+Р2 |
| Формализация | implementationDisposition на AC (new/modify/verify) + per-ID диспозиции + детерминированные гейты | Р2+Р1 |
| Разработка | worktree от HEAD релиза (паттерн continuation expectedBaseCommit — механика без канала), диспозиции → changeScopes карточек, форма диффа на гейтах | Р2 |
| Анкоринг/бюджет | anchoring-вопрос ревьюеру, recycleRounds кэп 2, траектория ловит «реюз-отговорку»; типизированная вина; precondition — lifecycle-точность binder'ов | Р2+Р3 |

⏳ ждёт: линейная версионность продукта (subversion-style ряд v1→v2→v3 как
first-class — дополнение Р3 в работе).

## Синтез: ⏳ после Р2+Р3
