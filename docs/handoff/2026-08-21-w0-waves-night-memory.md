# W0-WAVES NIGHT MEMORY — крупными вехами (2026-08-20/21)

Локальная память рефакторинга на случай сжатия контекста. Живая позиция —
в туду агента; этот файл — вехи + указатели.

## Главные вехи (хронология)

1. **Чужой merge сломал 35 наборов** (heading-gate v1.2.0 `3cf4819a` +
   `e62a9e8a`): все scripted-актёры писали AC-документы с level-1 заголовком.
   **Вылечено всё, ни один гейт не ослаблен** (коммит `c5f7f7aa` на saga4):
   `tests/factory-contract/scenario-engine.mjs` (общий createArtifact → `## AC-x:`),
   фикстуры constraint-coverage/e-constraint-loss (реальные байты AC),
   ADR-084 в реестр закрытия (+K21), kernel-genericity регистр (+2 записи),
   redevelopment live-parent тест → честный skip (реальный stage-19 запуск
   поглотил фикстуру). Полный набор: **0 fail**.
2. **W0-1 canonical composition** (коммит `bae5ba9f` на saga4):
   `tests/factory-proof/canonical-proof-composition.mjs` — единственный вход
   для новых causal proofs: адаптер над `src/factory-e2e/fresh-harness.ts`,
   закрытый allowlist-tree на РЕАЛЬНОЙ композиции (Reference-политики
   передавать ЗАПРЕЩЕНО — их строит production-регистрация), fingerprint
   (lifecycle+modules+providers+фактический overlay), identity-проверки,
   ratchet против 3 старых поверхностей, MIGRATION-MAP.md. Приёмка 8/8.
3. **Ворктри** `D:\Development\saga-mcp-w02`, ветка **w0-waves** (база
   `0dba9639`): изолированные npm install + build + тесты, пока Элита работает
   на главной checkout (запрет build при живой фабрике обойдён легально).
4. **W0-2 ≈ K3** (коммит на w0-waves): `obligation-contracts.mjs` — 33
   версионированных AcceptanceObligationContract на ВСЮ установленную
   поверхность (18 check-provider + 3 effect + 5 handler + 7 payload);
   `mutation-algebra.mjs` — структурные (schema) + реляционные (constraint DSL)
   операторы → MutantCase с seedDigest; `installed-protection-reader.mjs` —
   set-equality в обе стороны + version-pin; kill matrix на РЕАЛЬНОМ
   acceptance-валидаторе v2.0.0 (каждый нарушающий мутант убит, позитивный
   контроль принят); self-proof принятого мутанта. 11/11.
5. **W0-3 ≈ K4-ядро** (коммит): `scenario-dsl.mjs` (валидатор
   CausalFaultScenario: fairness/budget/diagnosability обязательны; mutant-
   поля; REFERENCE_SCENARIO); `scripted-actor.mjs` (не-всеведущий актёр:
   visibleInputDigest→actorOutputDigest, attempt/scenario невидимы,
   counterfactual-квартет exact/absent/stale/corrupted — omniscient ловится);
   `trace-observer.mjs` (readonly, classifyPostDrainProgress: 4 lawful класса
   или ANONYMOUS-STALL). 7/7.
6. **W0-4 ≈ K5** (коммит): blocking-группа `factory-proof` в
   `tools/run-acceptance-matrix.mjs` (точный 5-файловый набор) + шаг в
   `.github/workflows/ci.yml`; `kernel-self-mutations.test.mjs` (S1 удаление
   контракта / S2 подмена id|version / S3 полнота операторов). Группа 29/29,
   coverage self-check зелёный.
7. **W1-1 в полёте** (`w1-1-fabricated-hash-drive.mjs` + `w1-1-fabricated-hash.test.mjs`,
   НЕ закоммичено): fabricated-derived-evidence через настоящий agentic loop
   (canonical composition + W9 handlers + acceptance-ячейка на актёре W0-3).
   **5/7 зелёные**: флагман negative-semantic+repair GREEN (typed
   ARTIFACT_CONTENT_HASH_UNVERIFIABLE → точный фидбек → ремонт в сессии →
   gate accepted) и counterfactual-тройка GREEN (причинность доказана).
   Остались: `positive` — capsuleHashes пустые `{}` (в payload капсулы поля
   называются НЕ acceptedHash/criterionHash — проверить реальные имена в
   `factory_formalization_acceptance_baselines.payload`) и `negative-shape`
   (фикс направления применён — БЕЗ файла, intake shape-check; ассерт
   выровнен — перепрогнать).

## Параллельный трек: Элита-завод (stage-20)

- Трекер: `docs/factory-run/stage20-elite/RUN-TRACKER.md`; запущен 20:51:50Z,
  HEAD `c5f7f7aa`, модель **glm-4.6** (agent-proxy → opencode →
  zai-coding-plan/glm-4.6), **рейтлимит 4** (controls подняты пост-стартом;
  на resume каталог КАСТРЯЛИТ обратно на 2 — переподнять).
- Двигалось: discovery закрыт (~25 мин), product-contract принят (rev 8),
  use-cases в работе. Watchdog 60с чист; settings sha `2d6176e8…` неизменен.
- Панель оператора: tracker-view **http://localhost:4321** (перезапущен с
  DB_PATH=elite-db). `paused` у lifecycle = typed wait, не смерть.
- Терминал → внешняя проверка метки (запустить продукт в браузере!),
  слить w0-waves → saga4, push.

## K-план (новый мастер, закоммичен)

`docs/plans/SAGA-KERNEL-CONFORMANCE-ENGINE-PLAN.md` — K0–K8, 279 пунктов,
координация с ADR-085 (ко-локация воркшопов) и ADR-086 (atomic cutover).
Сверка: **W0-1≈K1, W0-2≈K3, W0-3≈K4-ядро, W0-4≈K5** — готово на уровне
**canonical-fast**. Гэпы по K-плану (мои следующие шаги):
1. доказелить W1-1 (он же K1-C + референс K6);
2. **proof-mode метки** — все текущие драйвы = canonical-fast, НЕ strict L3;
3. **K0** — baseline + нормализованная authority-trace схема (evidence rail
   для ADR-085 P3);
4. **K2** — workerSpawn strict actor seam (настоящий strict L3).

## Дисциплина (не терять)

- Каждый бриф/K-стадия = отдельный коммит + отчёт (seams/oracle/команды/неизвестные).
- Запреты ADR-084: нет 4-го runtime; нет SQL-authority; норма не из production
  declarations; актёр не видит scenario/attempt; зелёный счётчик ≠ proof;
  Drake-файл оператора не коммитить (DRAGON-MAP.md обновлён по указанию —
  лежит незакоммиченным).
- Стройка: только в ворктри w02, пока жива Элита. Push saga4 — после
  слива веток. opencode shim only; settings.json только sha-трипваер.

## W1-4 ГОТОВ (commit 9 на w0-waves) — ADR-078 two-lifecycle proof

Драйв: два Formalization lifecycle на одном эпике через ДВЕ production-
launch (новый API `requestFreshHarnessLaunch` в fresh-harness.ts; драйв
получил `launchRef` + `stopOnStageOutcome`; heartbeat чинил продление
не того launch — FENCE_LOST). Пэк 3/3, группа factory-proof 45/45,
два детерминированных прогона.

Доказано и ЗАПИНЕНО (F-1/F-2 в шапке драйва + тесте):
- **F-2 кросс-lifecycle изоляция**: baseline A байт-идентичен до/после B;
  AC-1/AC-2 НЕ втянуты в капсулу B. SRS-гейт B биндится к СВОЕМУ
  замороженному baseline (по process_run_id), не к живому материалу.
- **F-1 внутри-lifecycle консервация**: freeze капсулы B втянул AC-DECOY —
  accepted AC, созданный product-contract ячейкой B (не acceptance!),
  полностью легитимный (FR+UC traces). Гейт acceptance при этом требует
  полной легитимности КАЖДОГО accepted AC эпика (epic-wide read), а §D2
  затем обязан декомпозировать все 4 критерия капсулы. Т.е. семантика =
  fail-closed conservation: ни один accepted AC не ускользает от
  замороженного контракта. Если архитектор признает sweeр дефектом —
  тест УЖИВАЕТСЯ (исключить AC-DECOY), не ослабляется.

Попутные находки: SUBMISSION_STASIS_IDENTICAL_BYTES парк (5 байт-
идентичных резабмитов → операторский парк + durable evidence) — система
честно ловила мои битые SRS (§12 4 колонки вместо 6; decoy без UC-trace).

## ЭЛИТА-1: TERMINAL FAILED 22:17Z — настоящий дефект производства пойман

Полная цепочка (RUN-TRACKER stage20-elite + elite-db): воркер принятия
трассировал 12 AC → RULE-1; гейт принял раунд 1; ревью-раунд 2 потребовал
ремонт; воркер ЗАКОННО удалил 6 трейсов (trace_delete, 21:54); гейт принял
починенный live-материал (21:58) — но перепечатка снапшота всё ещё заморозила
35 трейсов, потому что снапшот читает factory_managed_trace_productions, а
trace_delete туда НЕ писал. В 22:17 replay-сертификация сравнила замороженные
туплы с live → 6missing → lifecycle терминально failed.

Две рассинхронизированные власти: live artifact_traces vs managed ledger.
Фикс (коммит на saga4 после мержа): handleTraceDelete зеркалит удаление в
ledger той же транзакцией; будущие печати консистентны live; запечатанное
остаётся замороженным; fail-closed сертификация не тронута. Регрессионный
тест tests/factory/trace-delete-managed-ledger-mirror.test.mjs (3/3):
mirror/no-op/re-add через реальные tool handlers с live provenance.

Значение для K-плана: это ровно аргумент ЗА real-model canaries (K8) —
скриптованные актёры никогда не делают trace_delete после печати; дефект
класса "законный ремонт между печатями" ловится только живой моделью.
W1-х сценарий на этот класс (repair-between-seals) — кандидат в корпус K6.

## K2-A ГОТОВ (commit 10 на w0-waves) — strict workerSpawn seam

Скриптованный ребёнок вместо CLI при ПОЛНОСТЬЮ продуктовом executor:
`buildCanonicalProofComposition({workerSpawn})` (взаимоисключающ с
in-process fast lane; allowlist расширен осознанно) + лифт workerSpawn в
fresh-harness (без лифта раннер запускал НАСТОЯЩИЙ shim — 600с зависания,
наш spawn-override не вызывался — проверено).

Ребёнок (k2-scripted-child.mjs): argv-совместим (—mcp-config, stdin-prompt),
неомнищиентен (task_id из промпта по объявленному паттерну; ids из СВОЕГО
task_get; никаких DB/attempt), настоящий MCP-клиент (ndjson JSON-RPC) к
СЕРВЕРУ из per-execution конфига, типизированные exit-коды (0/3/4).

Проба: discovery-proposal ячейка done+accepted через живой ребёнок (3.4с),
worker_done = durable MCP receipt, продукт запечатан, 0 in-process
инференций. Гейт "claude CLI запрещён" НЕ ослаблен — тест объявляет тот же
легальный agent-proxy маршрут, seam подменяет исполняемый файл ПОСЛЕ гейта.
Группа 46/46. CanonicalSpawn floor держится до K2-B (strict repair
counterfactuals): программа с repair-веткой по фидбеку из промпта + steps
{write} + '$fileHash:<path>' плейсхолдер — вотчина следующей смены.

Элита-2: discovery закрыт (обе ячейки accepted), formalization
product-contract на ревью — идёт к acceptance-минному полю Элиты-1.

## УТРО 2026-08-21: Волны 0–1 ГОТОВЫ (план: docs/plans/KERNEL-CONFORMANCE-WAVE-SCHEDULE.md)

Волна 0: K2-A влит в saga4; полный прогон в ворктри = **tests=4258 pass=4226
fail=0 skipped=32, EXIT=0** (475 файлов) — подтверждение после починки
ADR-реестра.

Волна 1 (K2-B/C/D) — СТРОГАЯ L3 ВЕРТИКАЛЬ ГОТОВА (e16ef75a, влито b3e05745):
- Ребёнок v2: программы-модули .mjs; диспетчер ячейки по metadata.process_node_id
  СВОЕГО task_get; ревьюер по semantic_skill=*reviewer из шапки промпта;
  project_id/ids ТОЛЬКО из production-visible шапки промпта (project_list
  вне whitelist — AUTHORITY_DENIED, проверено); witness-рельса для intake-
  отказов (они не пишут DB — свойство W1-1); запись только внутри cwd.
- Корпус: ВСЕ ячейки discovery→formalization через настоящий MCP.
- Пак 6/6 + негатив: positive → formalized (36 спавнов, 0 in-process);
  fabricated-exact → типизированный ремонт → accepted; absent/stale/corrupt
  → bounded stasis (5 durable rejections), lifecycle НЕ умирает;
  no-mcp-config → отказ ДО хендлера (exit 3).
- K2-C растчетка: ребёнок/корпус импортируют только node:*.
- Floor CanonicalSpawn ПЕРЕВЁРНУТ: proof-claims теперь ТРЕБУЮТ strict claim.
- Группа factory-proof: 53/53. Дисциплина удержана: гейт claude-CLI и
  whitelist инструментов не тронуты — они честно ловили мои ошибки.

Элита-2: 9 ячеек done, implementation-ячейки идут (одна в repair_wait —
нормальный цикл), парков нет. Следующие: Волна 2 (W1-2 Run B/C, W1-3
Delivery released).

## ПАУЗА (утро 2026-08-21, ~07:00 local): промежуточный статус

### Влито и запушено (fact check粘贴-ревью оператора местами устарел):
- saga4 HEAD **b3e05745** = K2-B/C/D ВЛИТЫЙ (ревью видело 7ac703b4 — до
  мержа). Строгая L3 вертикаль ЗАКОММИЧЕНА (e16ef75a), группа 53/53 дважды,
  floor CanonicalSpawn перевёрнут, всё запушено. Так что пункты ревью
  «незакоммичено / нет повторного прогона» — уже закрыты.

### Из ревью оператора — честные оставшиеся гэпы K2 (взято в план):
1. spawned actor не пишет visibleInputDigest → actorOutputDigest (K2-B
   evidence-гэп; добавить в ребёнка: дайджест промпта+task_get → дайджест
   последовательности вызовов, в witness-рельсу).
2. tool-permission negative (сделан только MCP-config negative) — изъятие
   инструмента из whitelist → AUTHORITY_DENIED до семантики.
3. K4 (fault scheduler/evidence bundle/minimizer) и K7/K8 — не начаты.

### W1-2 WIP (НЕЗАКОММИЧЕНО в ворктри, файлы на месте):
- tests/factory-e2e/scripted-inference.mjs — ПЕРЕПРОВЕРИТЬ ПЕРЕД СБОРКОЙ:
  добавлен production replay-порт (hasFrozenCapsule → runFrozenCapsuleReplay,
  observer.onReplay/getReplayCount). Run A проверен: 20 вызовов, 0 replay,
  терминал — дрейфа нет.
- tests/factory-proof/w1-2-factory-restart-drive.mjs — новый, ТРИ lifecycle
  (A cold / B same-idea replay / C incompatible-idea miss).
- ДИАГНОЗ-ТОЧКА: Run B виснет в initial-discovery. Последнее наблюдение:
  execution B с привязанным capsule `replay-capsule:92b8…` state='exited',
  task status='in_progress' — replay ВЫПОЛНИЛСЯ, но task не дошёл до done
  (worker_done после replay? смотреть runFrozenCapsuleReplay — в эталоне
  scenario-scripted-executor ПОСЛЕ executeCapsuleReplay зовёт
  handlers.worker_done(...) явно — МОЙ ПОРТ НЕ ЗОВЁТ; вот причина: реплей
  восстанавливает products, но завершение исполнения — отдельный шаг).
  Чинить: добавить worker_done-вызов в порт + state→'exited' после него.
- После фикса: Run C упрётся в LIFECYCLE_SCOPE_ALREADY_ACTIVE, пока B не
  дойдёт до терминала (scope-guard) — это ОЖИДАЕМО и корректно.
- Затем: тест w1-2-factory-restart.test.mjs (identity disjointness,
  invocations B < A, replays B ≥ 1, C cold 0 replays, capsule-bound счёт),
  регистрация в группе, убрать выключенный Run B из golden-path.test.mjs.

### Завод: Элита-2 жива (Development, 9/19 ячеек done, ревью идёт, парков
нет, watchdog чист, сэмплы свежие). Трекер :4321.

## W1-2: слитие + две системные находки (коммит 0ea72bf7 на w0-waves, RED/WIP)

Ветви: всё зелёное влито в saga4 (b3e05745). W1-2 закоммичен ОТДЕЛЬНЫМ
WIP-коммитом на w0-waves (0ea72bf7) — НЕ влит (drive красный by design).

Доказано до стопа: Run A cold (20 вызовов, терминал) → Run B (новый Factory
Start, та же semantic input) — **10 ячеек replay с НУЛЁМ scripted-вызовов**
(свойство §16 zero-call работает), затем стоп на ОДНОМ ревью-силе.

F-R1 (продакшн-дефект захвата): ревью-капсула несёт авторские subject-продукты
  (review-verdict + reconciliation-report в одном payload). Реплей её в
  ревью-WorkIntent падает типизированно (MANAGED_NODE_SUBMISSION_SCHEMA_
  MISMATCH) — fail-closed сработал. Проектная recuperación: ineligible →
  следующий execution — обычный miss.
F-R2 (открытый вопрос конвейера): этот «следующий execution» не приходит —
  после провала in-process replay ревью-workplace висит running, repair-
  машинерия не перекидывает в очеред за 40 циклов. Диагноз: производство
  supervision/reconcile для lost in-process replay executions (spawn-based
  терминализируется через releaseExecutionAtomically — проверить, чего
  не хватает in-process пути).

Порядок доводки W1-2 (следующая сессия): фикс F-R2 → B терминальна → C
  стартует (scope-guard уже правильный) → тест (disjoint identities,
  invocations B=0/replays≥10, C cold) → регистрация → убрать выключенный
  Run B из golden-path → merge.

Завод: на официальном soft-stop (paused-кнопка ≠ стоп — движок продолжал
  раздавать; `factory.mjs stop` затормозил корректно: engine dead,
  controls stopped, executions 0). Resume: `factory.mjs resume` + поднять
  model_concurrency_limit=4.
