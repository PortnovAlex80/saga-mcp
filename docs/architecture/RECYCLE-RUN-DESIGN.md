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

## Р3 (authority и форма хука): ⏳

## Синтез: ⏳ после Р2+Р3
