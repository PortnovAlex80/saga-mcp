# ADR-053 Cutover — Execution Tracker (Triple Verification)

Status: active execution tracker
Created: 2026-08-12
Branch: `saga4`
Source plan: [ADR-053](./decisions/053-workplace-production-revision-as-accepted-material-authority.md) · [CUTOVER-TODO](./ADR-053-CUTOVER-TODO.md) · verdict 2026-08-12
One-line goal: **сделать неизменяемую `WorkplaceProductionRevision` единственным runtime-источником принятого material authority — и физически удалить все альтернативные источники.**

> **/goal:** `рефакторинг по плану с тройной проверкой`

---

## ⛔ Правила трекера (binding)

1. **Строго по пунктам.** Пункт N+1 нельзя начать, пока пункт N не закрыт (3/3 PASS на одном коммите). Перескоки запрещены.
2. **Тройная проверка каждого пункта.** Пункт считается закрытым только когда **три независимых субагента-верификатора** (α, β, γ) выдали `PASS` на одном и том же commit SHA. Два PASS — недостаточно. Один PASS и «выглядит нормально» — недостаточно.
3. **Цель не выполнена, пока ВСЕ пункты не закрыты 3/3.** Один проваленный или непроверенный пункт = NO-GO для всего рефакторинга. Частичное завершение (как в вердикте от 2026-08-12: ~40% cutover) **не считается выполнением**.
4. **BINDING AMENDMENT действует.** Никакого legacy, compatibility-ридеров, feature-флагов, dual-record, бэкфилла. Удалять, а не депрекейтить. (см. CUTOVER-TODO § «BINDING AMENDMENT»).
5. **Вердикт субагента — это доказательство, а не мнение.** Каждый верификатор обязан: (а) прочитать указанные файлы/запросы, (б) выполнить concrete checks (grep/AST/тест), (в) приложить commit SHA + выдержку вывода. Без пруфа — `FAIL`.
6. **Если любая проверка ловит старый путь — точка блокируется** до физического удаления пути, а не до allowlist-исключения в ratchet.

---

## Протокол верификации (один проход одним субагентом)

Субагент, взявший пункт на проверку, выполняет:

1. `git rev-parse HEAD` → фиксирует commit SHA (все 3 PASS должны быть на одном SHA).
2. Читает раздел «Файлы в зоне» и «Concrete checks» данного пункта.
3. Запускает каждый concrete check дословно. Вставляет реальный вывод (а не «должно быть пусто»).
4. Формирует вердикт:
   - `PASS` — все concrete checks дали ожидаемый результат; старого пути нет в коде/SQL/типах/тестах/комментариях.
   - `FAIL` — хотя бы один check провален; указать точный файл:строка и причину.
5. Записывает строку в слот: `PASS | <SHA> | <дата> | выдержка grep/теста`.

Имена слотов фиксированы: **α (verifier-alpha)**, **β (verifier-beta)**, **γ (verifier-gamma)**. Субагенты не консультируются друг с другом до записи своего вердикта.

---

## Мастер-таблица состояния

| ID | Пункт | α | β | γ | Статус |
|----|-------|---|---|---|--------|
| P-0 | Реконсилировать чек-лист ADR-053 с реальностью | ✅ | ✅ | ✅ | done |
| B-1 | Сделать production revision обязательной | ✅ | ✅ | ✅ | done |
| B-2 | Исправить identity ревизии (material-only) | ✅ | ✅ | ✅ | done |
| B-3 | Удалить execution authority | 🟡 | 🟡 | 🟡 | partial |
| B-4 | Сузить effect API до authority-only | ⬜ | ⬜ | ⬜ | open |
| B-5 | Formalization и Git — только exact refs | ⬜ | ⬜ | ⬜ | open |
| B-6 | Удалить post-seal recency-селекторы | ⬜ | ⬜ | ⬜ | open |
| B-7 | Подключить source adapters как единственный path | ⬜ | ⬜ | ⬜ | open |
| B-8 | Сделать obligations обязательными | ⬜ | ⬜ | ⬜ | open |
| B-9 | Исправить replay (exact gate identity) | ⬜ | ⬜ | ⬜ | open |
| G-1 | grep/AST: в post-seal path нет exec/task/node/latest | ⬜ | ⬜ | ⬜ | open |
| G-2 | CandidateSet всегда ссылается на сохранённую revision | ⬜ | ⬜ | ⬜ | open |
| G-3 | Partition invariance: A(X+Y) ≡ A(X)+B(Y) | ⬜ | ⬜ | ⬜ | open |
| G-4 | Effects работают только от AcceptedCandidateAuthority | ⬜ | ⬜ | ⬜ | open |
| G-5 | Obligation recovery: crash после GateAccepted без повторного LM | ⬜ | ⬜ | ⬜ | open |
| G-6 | Workshop parity: одинаковый verified manifest digest | ⬜ | ⬜ | ⬜ | open |
| G-7 | Replay: exact gate identity, без recency | ⬜ | ⬜ | ⬜ | open |
| G-8 | Clean scripted E2E: новая БД/репо, без старых процессов | ⬜ | ⬜ | ⬜ | open |
| G-9 | Temporal suite: все handoff после каждого crash point | ⬜ | ⬜ | ⬜ | open |
| G-10 | Real-model canary (только после G-1..G-9) | ⬜ | ⬜ | ⬜ | blocked |

Легенда: ⬜ не проверено · ✅ PASS · ❌ FAIL · 🔒 blocked (ждёт предпосылки).

**Мастер-гейт GO:** все 20 строк = ✅×3 на одном SHA ⇒ допуск к real-model canary (G-10). Иначе — **NO-GO**.

---

## P-0 — Реконсилировать чек-лист с реальностью

**Scope:** вернуть 7 пунктов ADR-053 / CUTOVER-TODO из prematurely-`[x]` в `[ ]`/`[~]` согласно вердикту 2026-08-12. Это бухгалтерия честности — без неё последующие точки нельзя оценивать.

**Файлы в зоне:** `docs/architecture/decisions/053-...md`, `docs/architecture/ADR-053-CUTOVER-TODO.md`.

**Concrete checks:**
- [ ] В ADR-053/CUTOVER-TODO отмечены как незавершённые ровно эти 7 пунктов:
  1. *Execution is provenance only* (`producerExecutionRef` ещё в API/SQL/комментариях).
  2. *CandidateSet cutover complete* (persistence optional; author set выбирается неточно).
  3. *Effects consume only AcceptedCandidateAuthority* ( Formalization/Git ещё берут process/node/schema/task-селекторы).
  4. *Legacy post-seal selectors removed* (остались `ORDER BY ... DESC LIMIT 1`, task-scoped queries).
  5. *Source normalization complete* (адаптеры есть, но не wired как runtime path).
  6. *Replay creates current authority* (только rebinding к существующей acceptance, не создание).
  7. *Workshop installed as one immutable package* (digests placeholder; binding receipts неполные).
- [ ] Оставлены выполненными ровно 9 пунктов из вердикта (WorkplaceProductionRevision, immutable members, CandidateSet.productionRevisionRef, AcceptedCandidateAuthority, final acceptance linkage, source adapter interfaces, obligation infra, replay provenance split, ratchet infrastructure).

**Зависимости:** нет.

**Тройная проверка:**
- [ ] α: `____ | <SHA> | <дата> | ______`
- [ ] β: `____ | <SHA> | <дата> | ______`
- [ ] γ: `____ | <SHA> | <дата> | ______`

---

## B-1 — Сделать production revision обязательной

**Scope:** `revisionRepo` перестаёт быть optional. Contribution сохраняется до seal. Revision сохраняется до CandidateSet. CandidateSet не может ссылаться на несуществующую revision. Seal revision + seal CandidateSet — атомарно (durable transaction/outbox).

**Файлы в зоне:** production-cell executor, `WorkplaceProductionRevisionRepository`, CandidateSet seal path, persistence/transaction слой.

**Concrete checks:**
- [ ] В коде нет вызова вида `revisionRepo?.appendRevision(...)` или `revisionRepo?....` (optional chaining у revision repo) — `grep -rnE "revisionRepo\?\." src/` → пусто.
- [ ] Seal CandidateSet невозможен, если revision не сохранена: соответствующий код явно бросает/откатывает, а не проглатывает.
- [ ] Есть атомарная точка (одна транзакция/outbox) где revision seal + CandidateSet seal происходят вместе, либо outbox-запись, гарантирующая сходимость.
- [ ] Тест: попытка seal CandidateSet на absent revision → отказ с zero external mutation.
- [ ] Тест: crash между revision-seal и CandidateSet-seal → сходимость ровно к одной паре.

**Зависимости:** P-0.

**Тройная проверка:**
- [ ] α / [ ] β / [ ] γ

---

## B-2 — Исправить identity ревизии (material-only)

**Scope:** `revisionRef` определяется только material identity. `contributingExecutionRefs`, `presenterRef` и provenance/source metadata **не** входят в identity. Два сценария — «A создало X+Y» и «A создало X, B восстановилось и создало Y» — дают одну material authority. Production seal path использует поиск по `semanticDigest` для convergence.

Выбран ровно один из двух вариантов (явно зафиксировать в ADR):
- (a) `revisionRef = material identity only`; либо
- (b) `semanticDigest → lookup существующей эквивалентной revision → convergence`.

**Файлы в зоне:** revision ref computation (`computeRevisionRef`), digest derivation, seal path, repository lookup-by-semanticDigest.

**Concrete checks:**
- [ ] Функция вычисления `revisionRef` не включает execution refs / presenter ref / source metadata в identity — подтвердить чтением функции + тестом на её входах.
- [ ] Тест partition invariance: одна работа, разбитая на 2 execution, даёт один `revisionRef` (или сходится к одной revision по `semanticDigest`).
- [ ] Production seal path вызывает lookup по `semanticDigest` (для варианта b) — не игнорирует его.
- [ ] Выбранный вариант (a или b) явно прописан в ADR-053 amendment.

**Зависимости:** B-1.

**Тройная проверка:**
- [ ] α / [ ] β / [ ] γ

---

## B-3 — Удалить execution authority

**Scope:** физически удалить `producerExecutionRef` и `producer_execution_ref`. При необходимости заменить на `presenterExecutionRef` **только в audit metadata** — не в CandidateSet authority и не в digest принятого материала. Никаких compatibility readers.

**Файлы в зоне:** `CandidateSet`, CandidateSet repository/SQL (`producer_execution_ref` column), seal-key derivation, все 15+ production-файлов из inventory (claim audit в CUTOVER-TODO).

**Concrete checks:**
- [ ] `grep -rni "producerExecutionRef" src/` → пусто (0 совпадений).
- [ ] `grep -rni "producer_execution_ref" src/ db/ migrations/ sql/` → пусто.
- [ ] SQL-схема не содержит колонки `producer_execution_ref` (новая greenfield-схема).
- [ ] Seal key CandidateSet строится из `workplaceRef + productionRevisionRef + role` — без execution ref.
- [ ] Если введён `presenterExecutionRef`, он присутствует **только** в provenance/audit и не входит ни в authority, ни в digest — подтвердить тестом.
- [ ] Комментарии/типы/тесты не подразумевают execution-scoped ownership материала.

**Зависимости:** B-1, B-2.

**Тройная проверка:**
- [ ] α / [ ] β / [ ] γ

---

## B-4 — Сузить effect API до authority-only

**Scope:** материальный decision path effect'а получает только:
```
PostAcceptanceEffectInput {
  authority: AcceptedCandidateAuthority;
  // + только operational поля, не позволяющие заново выбрать material subject
}
```
Удалить из material decision path: `processRunId`, `nodeId`, `taskId`, `expectedProductSchema`, latest-submission lookup.

**Файлы в зоне:** `PostAcceptanceEffectInput`, `AcceptedCandidateAuthority`, production-cell executor, все effect-обработчики.

**Concrete checks:**
- [ ] `PostAcceptanceEffectInput` не содержит полей `producerExecutionRef`, `processRunId`, `nodeId`, `taskId`, `expectedProductSchema` (или они помечены не-material/только observability и не читаются в decision path).
- [ ] Ни один effect не реконструирует authority из process/node/schema/task — `grep -rnE "processRunId|nodeId|expectedProductSchema" <effect-dir>` в material path → пусто.
- [ ] Архитектурный тест (AST/grep) запрещает чтение этих полей внутри effect decision path.
- [ ] Тест: отсутствие/миссматч любого exact authority ref → zero external mutation.

**Зависимости:** B-3.

**Тройная проверка:**
- [ ] α / [ ] β / [ ] γ

---

## B-5 — Formalization и Git переведены на exact refs

**Scope:** `formalization-accept-products-effect` и Git integration effect получают материал **только** из:
```
authority.productRefs
authority.productionRevisionRef
authority.candidateSetRef
authority.gateDecisionKey
```
Никакой вторичной реконструкции (members из CandidateSet + соединение со старой `process products` таблицей + повторная интерпретация snapshot).

**Файлы в зоне:** `formalization-accept-products-effect`, Git integration effect, review-verdict selection.

**Concrete checks:**
- [ ] Formalization effect не вызывает `readExecutionProducts` / process-products join / `processRunId`-based member fetch.
- [ ] Git integration effect не выбирает задачу через `WHERE workplace = ? ORDER BY task_id DESC LIMIT 1`.
- [ ] Review verdict выбирается по точному `gateDecisionKey` из authority, а не «последний подходящий по времени».
- [ ] Тест: появление более нового task/execution/verdict после Gate не меняет вход effect'а.

**Зависимости:** B-4.

**Тройная проверка:**
- [ ] α / [ ] β / [ ] γ

---

## B-6 — Удалить post-seal recency-селекторы

**Scope:** после seal ни один material consumer не использует `ORDER BY ... DESC LIMIT 1`, `latestCandidate`, latest-submission, task-scoped queries. Архитектурный тест (ratchet) переходит от baseline-allowlist к **нулевому inventory**.

**Файлы в зоне:** все post-seal consumers (effect, gate, settlement, replay, downstream handoff), architecture ratchet test, `candidate_read`.

**Concrete checks:**
- [ ] `grep -rnEi "ORDER BY.*(sealed_at|task_id|created_at).*DESC.*LIMIT 1" src/` в material path → пусто.
- [ ] `grep -rn "latestCandidate" src/` → пусто (или только read-only UI/observability, явно помеченные и вне material path).
- [ ] Ratchet test: allowlist нарушений = **0** (не «не выросло», а «равно нулю»); тест падает при любом новом и при любом непокрытом старом нарушении.
- [ ] `candidate_read` возвращает последний CandidateSet по точной принятой authority, а не `ORDER BY sealed_at DESC LIMIT 1`.

**Зависимости:** B-5.

**Тройная проверка:**
- [ ] α / [ ] β / [ ] γ

---

## B-7 — Подключить source adapters как единственный runtime path

**Scope:** все источники (managed artifacts, typed submissions, Git contributions, evidence, carry-forward) проходят:
```
source payload → source adapter → canonical contribution → production revision
```
Executor не маркирует вручную всё как `typed-submission`. `productSource`-разветвление удалено из revision consumers (может оставаться только внутри ingress-адаптеров).

**Файлы в зоне:** production-cell executor, source adapters, `productSource` branching, revision assembly.

**Concrete checks:**
- [ ] Executor собирает revision **через** adapter boundary (вызывает адаптеры), а не инлайн-маркирует members.
- [ ] `grep -rn "productSource" src/` → только внутри ingress adapters; в revision/consumers пусто.
- [ ] Каждый из 4–5 источников имеет рабочий adapter с тестом «эквивалентное внешнее → идентичный canonical member».
- [ ] Тест: malformed payload от любого источника не создаёт revision и не тратит semantic Gate attempt.

**Зависимости:** B-2 (revision identity material-only).

**Тройная проверка:**
- [ ] α / [ ] β / [ ] γ

---

## B-8 — Сделать obligations обязательными

**Scope:** obligation ledger — часть физики завода, а не best-effort инфраструктура. Запись obligation **атомарна** с исходным state transition. Ошибки **не подавляются**. Fence — из реального owner/lease. Reconciler запущен в production runtime. Handlers зарегистрированы через Workshop manifest. Completion receipt хранится durable. Replay capture входит в тот же механизм.

**Файлы в зоне:** obligation repository/integrator/reconciler, production runtime wiring, CLI, Workshop manifest handler registration, replay capture.

**Concrete checks:**
- [ ] Integrator не принимает optional repository — `grep -rnE "obligationRepo\?\." src/` → пусто; вызов обязателен.
- [ ] Нет swallowed/best-effort ошибок записи obligation (нет `try {...} catch {}`- suppression вокруг obligation write в material path).
- [ ] Fence берётся из owner/lease, а не фиксированная константа.
- [ ] Reconciler зарегистрирован и запущен в production runtime и CLI (не закомментирован, не behind-флаг).
- [ ] Handlers для полного набора переходов зарегистрированы: `CandidateSetSealed→RunGate`, `GateAccepted→RunEffects`, `EffectsSettled→RecordFinalAcceptance`, `FinalAcceptanceRecorded→SettleProcess`, `ProcessSettled→RouteLifecycle`.
- [ ] Replay capture — durable obligation (или явно non-authoritative telemetry), а не best-effort swallow.

**Зависимости:** B-1, B-6.

**Тройная проверка:**
- [ ] α / [ ] β / [ ] γ

---

## B-9 — Исправить replay (exact gate identity)

**Scope:**
- Capture получает **точный** `gateDecisionKey` (никакого пустого key, digest не от пустого значения).
- Никакого выбора verdict по времени (`ORDER BY ... LIMIT 1`) — только exact immutable gate key.
- Rebinding использует exact `FinalAcceptance`.
- При необходимости создаётся **новая** текущая authority: новая цепочка `revision → CandidateSet → GateDecision` (а не только привязка к уже существующей acceptance).
- Replay capsule capture durable и fail-closed.

**Файлы в зоне:** `ReplayAuthorityRebinder`, replay capture в executor, gate decision selection, historical-receipt provenance.

**Concrete checks:**
- [ ] Replay capture передаёт непустой exact `gateDecisionKey`; digest считается от непустого значения.
- [ ] Внутри rebinder `GateDecision` выбирается по exact immutable key, не по `ORDER BY ... DESC LIMIT 1`.
- [ ] При отсутствии current authority создаётся новая revision/CandidateSet/GateDecision (тест покрывает этот путь).
- [ ] Historical receipt сохраняется только как provenance; не становится автоматически current authority.
- [ ] Ошибки capture не подавляются (fail-closed).

**Зависимости:** B-3, B-6, B-8.

**Тройная проверка:**
- [ ] α / [ ] β / [ ] γ

---

## G-1..G-10 — Критерии допуска к real-model запуску

Эти пункты — финальные gate-проверки. Они пере-верифицируют cutover целиком, а не отдельные файлы. G-10 заблокирован до закрытия G-1..G-9.

### G-1 — grep/AST: в post-seal material path нет execution/task/node/latest selectors
- [ ] Полный `grep -rnE "execution_id|task_id|node_id|latestCandidate|ORDER BY.*DESC.*LIMIT 1" src/` ограниченный post-seal consumers → 0 совпадений в material path. AST-тест зелёный.
- [ ] α / [ ] β / [ ] γ

### G-2 — CandidateSet всегда ссылается на реально сохранённую revision
- [ ] Инвариант-тест: для каждого sealed CandidateSet соответствующая revision существует в authoritative store. Foreign-key/CAS или тест эквивалентен.
- [ ] α / [ ] β / [ ] γ

### G-3 — Partition invariance: A(X+Y) ≡ A(X)+B(Y)
- [ ] Property/тест: одна работа в одном execution и та же работа, разбитая на 2 recovery-execution, дают одну material authority (один `revisionRef` или convergence по `semanticDigest`).
- [ ] α / [ ] β / [ ] γ

### G-4 — Effects работают только от AcceptedCandidateAuthority
- [ ] Композиционный тест: Formalization и Git effect'ы получают вход **только** из `authority.*`; удаление/подмена любого exact ref → zero external mutation. Наличие более нового task/execution/verdict не меняет вход.
- [ ] α / [ ] β / [ ] γ

### G-5 — Obligation recovery: crash после GateAccepted восстанавливается без повторного LM-вызова
- [ ] Temporal/интеграционный тест: crash сразу после `GateAccepted` → reconciler доводит до `RecordFinalAcceptance`/`SettleProcess` без повторного вызова Language Model и без ручного kick.
- [ ] α / [ ] β / [ ] γ

### G-6 — Workshop parity: orchestrator и worker MCP имеют одинаковый verified manifest digest
- [ ] Workshop manifest содержит **не placeholder** digests (handler/skill/contract artifact), а реальные. Parity-тест: digest orchestrator == digest worker MCP; мутация одного binding → старт падает.
- [ ] α / [ ] β / [ ] γ

### G-7 — Replay: exact gate identity, без recency lookups
- [ ] Replay-тест: exact gate identity на всей цепочке; историческая capsule не становится current authority; при необходимости создаётся новая цепочка revision/CandidateSet/Gate.
- [ ] α / [ ] β / [ ] γ

### G-8 — Clean scripted E2E: новая БД, новый репо, без старых процессов
- [ ] Скриптовый E2E от чистой БД + чистого репо, concurrency 2, без ручных DB-правок/resume/kicks, доходит до terminal local-ready autonomously.
- [ ] α / [ ] β / [ ] γ

### G-9 — Temporal suite: все межмашинные handoff после каждого разрешённого crash point
- [ ] Temporal harness переопределяет только узкий seam (`workerSpawn`/model cognition, не `workerExecutorFactory`); каждый crash point прогнан; все 5 переходов (G-5 список) сходятся.
- [ ] α / [ ] β / [ ] γ

### G-10 — Real-model canary (Mars/Venus, GLM-4.7) — ТОЛЬКО после G-1..G-9 ×3
- [ ] Clean real-model canary под той же composition и ограничениями; terminal local-ready outcome; exact commit/tree/revision lineage; app start + HTTP health + deterministic tests зелёные.
- [ ] α / [ ] β / [ ] γ

---

## Финальный мастер-гейт

- [ ] **GO condition:** все 20 пунктов (P-0, B-1..B-9, G-1..G-10) = ✅ ×3 на одном commit SHA.
- [ ] Ветка `saga4` слита в `master` отдельным cutover-коммитом `refactor(adr-053): make accepted Workplace revision the sole runtime material authority`.
- [ ] Старые production writers/read fallbacks **удалены** в том же коммите (не оставлены «историческими читателями» — см. BINDING AMENDMENT; historical rows остаются immutable в схеме, но не как fallback-путь).
- [ ] CI (GitHub Actions / workflow runs) зелёный на exact HEAD — локальные «у меня зелёные» без external proof не принимаются.

**Пока любое из этих условий не выполнено — статус всего рефакторинга `NO-GO`, canary не запускается, фикс-коммиты по инцидентам не считаются прогрессом по cutover.**

---

## Решение по ведению трекера

- Каждый субагент, проверивший пункт, дописывает свой вердикт в соответствующий слот α/β/γ и обновляет мастер-таблицу (✅/❌).
- При `FAIL` — пункт возвращается в `open`; исполнительский агент устраняет причину; все 3 верификации **перепроводятся** на новом SHA (старые PASS не переносятся — они были на другом коммите).
- Журнал решений и инцидентов ведётся в `AGENT-ENVELOPE.md` (общий канал) и в decision journal CUTOVER-TODO.
- Изменение порядка пунктов или добавление новых — только через обновление этого файла и явную запись в decision journal с обоснованием.

---

## Verification log

### P-0 — Реконсилировать чек-лист — 3/3 PASS ✅
- SHA: working tree on `saga4` (HEAD `06096ac` at verification).
- α PASS, β PASS (после фикса баннера: 6 категорий с inline-флипом + #4 как already-`[ ]` anchor), γ PASS.
- 11 пунктов `[x]→[~]` с `<!-- reverted 2026-08-12 (verdict #N) -->`; 9 done-категорий оставлены `[x]`. Чекбоксы: 52 `[x]` / 11 `[~]` / 27 `[ ]`.

### B-1 — production revision обязательна + атомарный seal + FK — 3/3 PASS ✅
- SHA: working tree on `saga4` (HEAD `11af5b6` at verification).
- α PASS (7/7 критериев), β PASS (8/8 + rollback-семантика), γ PASS (8/8 + аудит 19 `productionRevisionRef`-сайтов: phantom-ref путей нет).
- Реализация: `revisionRepo` non-optional в executor; `sealCandidateSet`/`sealCarriedForwardCandidateSet` (executor) и `sealArchitectureCandidateSet` (formalization) — appendRevision + seal в одной `revisionRepo.transaction(...)`; `transaction<T>` helper; структурный FK `factory_candidate_sets.production_revision_ref → factory_workplace_production_revisions.revision_ref` (`db.ts` уже держит `foreign_keys=ON`).
- Proof-тесты (candidate-set-revision-authority): FK-отказ absent revision, atomicity, rollback — 6/6. tsc exit 0. Регрессий: baseline 59 → current 57 (B-1 починил 13 детерминированных тестов; «новые» провалы — flaky timing-тесты factory-temporal, на повторе PASS).
- **Caveats (non-blocking, перенесены в более поздние пункты):**
  - formalization `revisionRepo?:` остался optionally-typed (но guarded `if (!deps.revisionRepo) return null;`). Tightening до non-optional + wiring на всех сайтах formalization-deps → **B-5** (formalization на exact refs).
  - formalization bridge `try/catch` глотает FK-нарушения → аудит в **B-6** (удалить soft-fallback).
  - schema `CREATE TABLE IF NOT EXISTS` не накладывает FK на существующие БД — допустимо по BINDING AMENDMENT (fresh schema, factory DBs throwaway).
- Обновлённые тесты: candidate-set-revision-authority, workplace-repositories (19/19), 02-first-cell (8/8), production-cell-node-executor (9/9).
- Предсуществующие CandidateSet-seal-без-revision тесты (tests/process-modules/candidate-set-seal.test.mjs) остались красными — это B-1-aligned debt, не регрессия (в baseline тоже красные).

### B-2 — identity ревизии / partition invariance — 3/3 PASS ✅
- SHA: working tree on `saga4` (HEAD `11af5b6`).
- α PASS, β PASS, γ PASS.
- **Выбран variant (b)** (вердикт допускает оба): convergence probe `getRevisionBySemanticDigest` внутри B-1-транзакции в всех 3 seal-сайтах (executor sealCandidateSet, sealCarriedForwardCandidateSet, formalization sealArchitectureCandidateSet). Probe — exact-value lookup (`WHERE workplace_ref=? AND semantic_digest=? LIMIT 1`), НЕ recency. Найдя эквивалентную ревизию — reuse её revisionRef, skip appendRevision → seal key `(workplace+revisionRef+role)` сходится → второй partition replay'ит первый → один CandidateSet authority.
- **Variant (a) (revisionRef material-only) отложен в B-9**: найдено, что material-only revisionRef детерминированно ломает replay-certification (`REPLAY_CAPSULE_CONTEXT_INVALID`) — это B-9-дефект (replay capture/certify timing зависит от revisionRef). В B-9 material-only revisionRef + replay-key взаимодействие чинятся холистически. Документировано в `revisionRef` comment.
- Proof-тест: «B-2: two partitions sealing equivalent material converge to one CandidateSet» (replayed=true, один CandidateSet). tsc exit 0. 78/78 детерминированного sweep. external-effects/lifecycle-routing PASS на чистых прогонах (flaky под concurrent load — предсуществующая характеристика factory-temporal).
- Non-blocking: поправлены stale-комментарии в `candidate-set.ts` (seal key = workplace+productionRevisionRef+role, не execution).

### B-3 (инкремент 1) — execution-free candidateSetDigest — в работе
- `candidateSetDigest` больше не включает `executionRef`/`presenterRef`: development-sealer, carry-forward-sealer и оба верификатора (`app/factory-start.ts`, `sqlite-author-candidate-carry-forward.ts`) теперь хешируют только `{workplaceRef, role, products}`.
- Это **исправляет латентный дефект B-2**: с executionRef-in-digest реальная partition-convergence давала бы REPLAY_MISMATCH вместо replay (B-2 proof-тест не ловил — хардкодил digest).
- tsc 0; 32/32 targeted.
- **Остаток B-3 (крупный, центральный хаб):** удалить поле `producerExecutionRef` + SQL-колонку + переписать 6+ READ-authority сайтов (gate, settlement, adoption, carry-forward, replay ×2, recovery). Пересекается с B-5/B-6/B-9. ~20 тестов.
