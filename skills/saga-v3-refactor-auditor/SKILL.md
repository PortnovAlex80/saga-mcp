---
name: saga-v3-refactor-auditor
description: "Дотошный аудит кодовой базы против плана рефакторинга Saga 3.0 (docs/plans/SAGA-3-0-REFACTORING-PLAN.md). Проверяет КАЖДЫЙ пункт плана (разделы 3-21, гейты 0-10, инварианты, целевая архитектура, required ports, harness, scenario-паки). Read-only: ничего не пишет, не запускает npm install/build, не мутирует saga.db. Отдаёт таблицу 'пункт плана | статус | что не сделано | рекомендация'. Использовать когда пользователь просит 'проверить рефакторинг v3 / статус плана / что осталось сделать / аудит v3'."
---

# saga-v3-refactor-auditor — дотошная проверка плана рефакторинга v3

## Зачем этот скилл

План рефакторинга Saga 3.0 (`docs/plans/SAGA-3-0-REFACTORING-PLAN.md`, 22 раздела, 1163 строки)
задаёт ~200 конкретных требований: 15 инвариантов, 10 required ports, 17 domain-сущностей,
13 harness-модулей, 15 стадий scenario-паков, 20 concurrency-сценариев, 10 recovery-рангов,
10 гейтов с exit-критериями, 18 пунктов "definition of done". По ходу рефакторинга легко
потерять отдельные требования — например, завести 14 из 16 модулей `src/control/*` и забыть
про `budgets/` и `work-intents/`. Этот скилл — **машинальный, исчерпывающий сверщик**: он
проходит план раздел за разделом, пункт за пунктом, сверяет каждое требование с фактическим
кодом/тестами/документами и отдаёт таблицу пробелов.

Отличие от `saga-patrol`: patrol даёт **экспресс-срез живой доски** (что делает движок сейчас).
Этот скилл даёт **статический аудит соответствия плану** (выполнено ли требование N из документа).
Отличие от `saga-readiness-checker`: readiness проверяет **один эпизод перед разработкой**
(план→код). Этот скилл проверяет **сам рефакторинг saga-mcp** (мандат→реализация).

## Что считается источником правды

| Что | Где | Read-only? |
|---|---|---|
| План v3 (канон, истина последней инстанции) | `docs/plans/SAGA-3-0-REFACTORING-PLAN.md` | да |
| Мандат v3 | `docs/architecture/SAGA-3-0-MANDATE.md` | да |
| Замороженные интерфейсы / ADR-019 | `docs/architecture/SAGA-3-0-FREEZE.md`, `docs/architecture/decisions/019-*.md` | да |
| Журнал прогресса по гейтам | `docs/architecture/SAGA-3-0-PROGRESS.md` | да |
| Аудит Gate 0 | `docs/architecture/SAGA-3-0-AUDIT.md` | да |
| Исходный код control-plane | `src/control/**/*.ts` | да (только read/grep) |
| Жизненный цикл + schema | `src/lifecycle/**`, `src/schema.ts`, `src/db.ts` | да |
| Корень оркестрации | `src/orchestrate.ts`, `src/orchestrate-cli.ts` | да |
| Тесты гейтов и harness | `tests/v3/**` | да (только read) |
| package.json scripts (§19) | `package.json` → `scripts` | да (json read) |
| saga.db (если нужно сверить с таблицами) | `C:\Users\user\.zcode\saga.db` (readonly) | да |

**Скилл НИЧЕГО не запускает:** ни `npm test`, ни `npm run build`, ни `tsc`, ни миграции.
Он сверяет **наличие и структуру** артефактов плана, а не прогон тестов (это работа CI и
gate-коммитов, которые уже зафиксированы в PROGRESS.md). Если нужно подтвердить, что тесты
зелёные — это отдельный шаг пользователя.

## Когда использовать

- Пользователь спрашивает: «проверь рефакторинг v3», «что осталось от плана», «статус v3»,
  «какие пункты плана не сделаны», «доделан ли рефакторинг», «аудит v3».
- Перед релизом saga-mcp, чтобы увидеть реальные пробелы плана, а не «вроде всё готово».
- После длительного перерыва в работе над v3 — освежить картину, что сделано, что нет.
- Перед планированием следующей волны работ — понять, какие гейты/пункты ещё открыты.

**НЕ использовать:**
- Для проверки живой доски продукта (это `saga-patrol`).
- Для review одного эпизода/PR (это `saga-code-reviewer` / `saga-readiness-checker`).
- Для запуска тестов (это CI / ручной прогон `npm test:v3:*`).
- Для правки кода — скилл read-only, только отчёт.

## Порядок аудита (по разделам плана)

**Ключевое правило:** идти строго по плану раздел за разделом. Каждый раздел плана →
подраздел «Что проверить» ниже → конкретные команды проверки → запись в таблицу.
Не пропускать разделы «потому что и так ясно». Ценность скилла — в полноте.

В выводе используется следующая **шкала статусов** для каждого пункта:

| Статус | Значение |
|---|---|
| ✅ DONE | Требование выполнено и подтверждено артефактом/кодом/тестом |
| ⚠️ PARTIAL | Часть требования есть, часть отсутствует — указать чего именно не хватает |
| ❌ MISSING | Требование прямо не выполнено (нет файла/модуля/теста/сущности) |
| ❓ UNCLEAR | Не удалось однозначно подтвердить из доступных источников — требует ручной проверки |
| ➖ N/A | Неприменимо на текущей фазе (например, гейт дальше текущего) |

Обозначения для ссылки на источник в таблице: `план §N.M`, `PROGRESS.md Gate N`,
`src/...`, `tests/v3/...`, `ADR-019`.

### Шаг 0. Контекст и базовая линия

Перед аудитом собрать фактическую базовую линию (аналог Gate 0 §16):

```bash
cd "D:/Разработка/saga-mcp"
git rev-parse --abbrev-ref HEAD        # текущая ветка
git rev-parse HEAD                     # коммит
git status --short                     # грязный ли worktree
test -f docs/plans/SAGA-3-0-REFACTORING-PLAN.md && echo "PLAN: present"
test -f docs/architecture/SAGA-3-0-MANDATE.md && echo "MANDATE: present"
test -f docs/architecture/SAGA-3-0-AUDIT.md && echo "AUDIT(Gate0): present"
test -f docs/architecture/SAGA-3-0-FREEZE.md && echo "FREEZE: present"
test -f docs/architecture/SAGA-3-0-PROGRESS.md && echo "PROGRESS: present"
test -f docs/architecture/decisions/019-saga-3-0-episode-control-architecture.md && echo "ADR-019: present"
```

Если `SAGA-3-0-REFACTORING-PLAN.md` отсутствует — аудит невозможен, сообщить и выйти.
Записать базовую линию в начало отчёта (ветка, коммит, наличие канонических документов).

### Шаг 1. Инварианты (план §3, 15 штук)

15 инвариантов — это «non-negotiable». Проверить наличие механизма каждого в коде.
Большинство инвариантов нельзя проверить одним grep — их исполнение подтверждается
существованием соответствующих модулей, тестов-свойств и gate-тестов. Поэтому
для §3 сверять через: наличие модуля-владельца + наличие property-теста + gate.

| Инвариант | Где искать подтверждение |
|---|---|
| 1. LM proposes, controller authorizes, evidence determines | `src/control/controller.ts`, `src/control/proposals/`, `tests/v3/properties/` |
| 2. Активный эпизод не ждёт человека | `src/control/cutover.ts` (`v3TerminalInsteadOfPause`, `auditV3NoHumanPaths`), grep `needs-human\|waiting_human\|ParkForHuman\|RecordHumanAnswer` под `if (isV3Authority)` |
| 3. LM-ответ не меняет condition/budget/policy напрямую | `src/control/conditions/`, `src/control/proposals/proposal-validator.ts` |
| 4. Эффект не выполняется без durable authorization | `src/control/effects/effect-state-machine.ts`, `tests/v3/gate-7-effects.test.mjs` |
| 5. Stale generation/lease/fencing не мутирует state | `src/worker/worker-executions.ts`, fencing-тесты |
| 6. Blocker True только с current trusted evidence | `src/control/evidence/`, gate-8 |
| 7. Неизменный transient-failure не повторяется | `src/control/incidents/incident-authority.ts`, gate-6 |
| 8. Один retry authority на episode generation | `src/control/incidents/`, cutover (legacy → emit-only) |
| 9. Один controller version на episode generation | `src/control/cutover.ts` (`readControllerVersion`) |
| 10. Shadow не диспатчит/не резервирует/не мутирует | `src/control/reconcile/shadow-observer.ts`, `shadow-reconciler.ts`, gate-4 |
| 11. Бюджет атомарно резервируется, не сбрасывается generation'ом | `src/control/` (ищи `budget`, `reservation`, `carry-forward`) |
| 12. Terminal outcome absorbing после certification | `src/control/completion/certification.ts` |
| 13. Concurrency не меняет policy/evidence/completion semantics | `tests/v3/concurrency/` (сценарий 20) |
| 14. Корректность при concurrency=1 | `tests/v3/concurrency/` |
| 15. Unknown write scope сериализуется по умолчанию | `src/control/resources/admission.ts` |

Команды проверки (типовые):
```bash
# Наличие модуля-владельца
ls src/control/{conditions,effects,evidence,incidents,completion,reconcile,resources,proposals}/ 2>&1
# Функции cutover (инварианты 2, 9)
grep -nE "isV3Authority|readControllerVersion|v3TerminalInsteadOfPause|auditV3NoHumanPaths" src/control/cutover.ts src/orchestrate.ts
# Что v3-пути НЕ достигают human-флагов (инвариант 2)
grep -rnE "needs-human|waiting_human|ParkForHuman|RecordHumanAnswer" src/control/ src/orchestrate.ts
# Бюджет/резервация (инвариант 11)
grep -rniE "budget|reservation|carry.?forward" src/control/ | head -20
# Тесты свойств (инварианты как properties)
ls tests/v3/properties/
```

Для каждого из 15 инвариантов — отдельная строка в итоговой таблице.

### Шаг 2. Целевая архитектура и source layout (план §5, §18)

§18 задаёт 14 директорий `src/control/*`. Проверить наличие каждой:

```bash
for d in domain policy conditions reconcile incidents budgets work-intents resources \
         effects evidence proposals completion ports adapters; do
  if [ -d "src/control/$d" ]; then echo "✅ $d"; else echo "❌ $d MISSING"; fi
done
```

§5: два вложенных цикла (commissioning + delivery) и ядро жизненного цикла.
Проверить:
- `src/control/controller.ts` существует (delivery-loop pump).
- `src/control/reconcile/` содержит reconcile + shadow (delivery cycle).
- `src/control/policy/` (constitution, governance — commissioning).
- `src/lifecycle/domain/*` сохранён как ядро (НЕ заменён вторым state machine).

```bash
ls src/lifecycle/domain/ 2>&1
# Подтверждение, что НЕ создан второй lifecycle-kernel:
find src/control -name "*.ts" | xargs grep -lnE "state machine|StateMachine" 2>/dev/null
```

§5: "`src/orchestrate.ts` should gradually become a composition root and pump" —
проверить, что orchestrate.ts действительно делегирует в `src/control/*`, а не владеет
логикой policy/retry/watchdog напрямую:

```bash
grep -nE "from ['\"]\\.\\./?control/|from ['\"]\\./control/" src/orchestrate.ts | head
```

### Шаг 3. Required ports (план §7, 11 интерфейсов)

11 портов должны существовать как интерфейсы ДО глубокой переделки оркестратора:

```bash
# ports.ts должен декларировать все 11
grep -nE "interface (ModelPort|OraclePort|EffectPort|RepositoryPort|ProcessPort|DurableStore|SchedulerPort|Clock|IdSource|RandomSource|FaultInjector)" src/control/ports/ports.ts
```

Production-адаптеры (через те же интерфейсы):
```bash
ls src/control/adapters/
grep -nE "implements (ModelPort|Clock|IdSource|RepositoryPort|DurableStore|RandomSource|FaultInjector)" src/control/adapters/*.ts
```

§7 (последний абзац): "Production adapters and test adapters must pass through the same
proposal parser, policy authorization, incident authority, evidence recorder, and effect
state machine." Проверить, что тестовый harness использует те же:
```bash
grep -nE "import .* from ['\"].*control/(proposals|policy|incidents|evidence|effects)" tests/v3/harness/*.mjs
```

### Шаг 4. Domain-сущности и persistence (план §8, 17 сущностей)

17 сущностей §8.1. Проверить каждую в `src/control/domain/types.ts` и/или `src/schema.ts`:

```bash
for e in PlatformPolicy ProductConstitution GovernancePolicy EpisodeSpec \
         EpisodeCondition ConditionDependency TaskConditionLink WorkIntent \
         ResourceClaim BudgetLedgerEntry ControlIncident RecoveryAttempt \
         LMProposal ControlDecision ControlEffectIntent EpisodeControlEvent \
         OutcomeCertificate; do
  c=$(grep -rniE "$e" src/control/domain/types.ts src/schema.ts 2>/dev/null | wc -l)
  echo "$e : $c совпадений"
done
```

§8.2: поле условия обязано иметь минимум 16 полей (сверить с `src/control/conditions/conditions.ts`).
§8.3: work-intent identity — deterministic uniqueness key (episode, generation, target condition, scope, strategy).
§8.4: budget ledger — atomic reservation before dispatch (см. инвариант 11).
§8.5: evidence identity — oracle_id/version, trust, generation, source/env fingerprint, freshness. Убедиться, что `human_audit` удалён из active v3 oracle examples.
§8.6: lease/fencing — расширенные worker_executions/work_attempts.
§8.7: effect semantics — durable intent + effectively-once, `EXTERNAL_STATE_UNKNOWN`.

```bash
# §8.5 — human_audit не должен быть активным v3 oracle
grep -rniE "human_audit" src/control/ src/schema.ts
# §8.7 — EXTERNAL_STATE_UNKNOWN присутствует
grep -rniE "EXTERNAL_STATE_UNKNOWN" src/control/ src/orchestrate.ts
# 16 полей условия
grep -nE "episode_spec_id|obligation_id|scope_type|observed_generation|source_fingerprint|environment_fingerprint|projection_version|invalidation_reason" src/control/conditions/conditions.ts
```

### Шаг 5. Parallel runtime (план §9, admission/scopes/invalidation/fan-in/backpressure)

§9.1 admission rules, §9.2 resource scopes (расширенный каталог ≥15 типов),
§9.3 invalidation, §9.4 fan-in/integration (CAS against expected head),
§9.5 backpressure/fairness.

```bash
# §9.2 — расширенный каталог conflict-скопов (план перечисляет: file path, schema,
# public protocol, integration branch, capability, invariant, aggregate, data owner,
# migration, security boundary, benchmark env, runtime resource, provider capacity,
# external-effect target)
grep -rniE "file_path|schema|public_protocol|integration_branch|capability|invariant|aggregate|data_owner|migration|security_boundary|benchmark|runtime_resource|provider_capacity|external_effect" src/control/resources/ src/control/domain/types.ts
# §9.4 — integration compare-and-swap на expected target head
grep -rniE "expected.*target.*head|compare.?and.?swap|merge.?coordination|target_head" src/control/effects/ src/control/reconcile/ src/worker/
# §9.5 — WIP limits / capacity pools / fairness
grep -rniE "wip.?limit|capacity.?pool|fairness|backpressure|starvation" src/control/
```

### Шаг 6. Deterministic simulation harness (план §11)

§11.1 — 13 файлов harness + папка scenarios:
```bash
for f in scripted-model virtual-clock deterministic-ids fake-oracles fake-effects \
         fake-repository fake-process-runtime fault-injector fault-injecting-store \
         seeded-scheduler scenario-runner reference-model invariant-probe trace-recorder; do
  test -f "tests/v3/harness/$f.mjs" && echo "✅ $f" || echo "❌ $f MISSING"
done
test -d tests/v3/scenarios && echo "✅ scenarios/" || echo "❌ scenarios/ MISSING"
```

§11.1: "existing `tests/mock-claude.mjs` may remain ... but must not be the only simulator."
```bash
test -f tests/mock-claude.mjs && echo "mock-claude present (ok as compat)"
test -f tests/v3/harness/scripted-model.mjs && echo "in-process scripted model present"
```

§11.2 — scripted LM behavior catalog (≥19 случаев из плана). Проверить, что scripted-model
поддерживает required виды: malformed JSON, timeout, refusal, repeated proposal, false done,
hallucinated evidence, stale-generation, prompt injection, unauthorized file/tool и т.д.
```bash
grep -nE "malformed|timeout|refusal|hallucinat|stale.?generation|prompt.?injection|unauthorized|rate.?limit|truncat" tests/v3/harness/scripted-model.mjs
```

§11.3 — scenario declaration fields (initial PlatformPolicy, scripted LM sequence, oracle
sequence, fault injection points, clock seed, expected/forbidden actions, expected outcome).
§11.4 — virtual time (никаких real sleeps в детерминированных тестах):
```bash
# Ни один v3-тест не должен звать реальный sleep
grep -rnE "setTimeout|sleep\(|new Promise.*resolve.*setTimeout" tests/v3/ | grep -v harness/virtual-clock
```
§11.5 — crash boundaries (≥15 точек инъекции). Проверить fault-injector + fault-injecting-store.

### Шаг 7. Stage scenario packs (план §12, 15 стадий)

15 стадий, каждая требует ≥5 классов сценариев (happy / recoverable / truthful-terminal /
stale-or-concurrent / adversarial). Проверить наличие scenario-файлов:
```bash
ls tests/v3/scenarios/
```
План перечисляет: commissioning, discovery, formalization, feasibility, governance,
policy-freeze, solution-architecture, planning, development, verification, integration,
runtime-validation, release, observation, outcome-certification. Сверить поимённо.

### Шаг 8. Property/model-based tests (план §13)

§13 перечисляет ≥17 свойств (No effect without authorization; no stale generation mutates
state; exactly one execution per epoch; budgets never increase except from frozen reserve;
no duplicated work intent; etc.) + **independent reference state machine** (§13, последний
абзац) + `fast-check`/seeded generator with shrinking.

```bash
ls tests/v3/properties/
grep -nE "fast-check|fc\.|reference.?model|state.?machine|shrink|seed" tests/v3/properties/properties.test.mjs tests/v3/harness/reference-model.mjs
# Независимый reference-model НЕ должен переиспользовать production reducer как свой oracle
grep -nE "import .* from ['\"].*src/control" tests/v3/harness/reference-model.mjs
```

### Шаг 9. Concurrency scenario pack (план §14, 20 сценариев)

20 конкретных interleaving-сценариев. Проверить, что concurrency-пак покрывает их по смыслу:
```bash
ls tests/v3/concurrency/
grep -nEi "two workers.*one task|one deficit.*one work intent|same write scope|disjoint write scope|unknown write scope|multi.?repo.*deadlock|dependency cycle|fan.?in|optional.*block.*mandatory|upstream.*supersed|unrelated branch|final.*budget|429|provider|backlog|wip|integration lease|head changes|crash after git merge|self.?certif|low.?priority|concurrency one" tests/v3/concurrency/concurrency-pack.test.mjs | head -40
```

### Шаг 10. Recovery ladder (план §15, R0-R9)

10 позиций R0..R9. Проверить, что incident-authority знает все ранги и правило
«repetition requires causally changed input»:
```bash
grep -nE "R0|R1|R2|R3|R4|R5|R6|R7|R8|R9|reobserve|transient.?retry|checkpoint.?restart|recreate.?environment|diagnos|diversif|replan|rollback|degradation|terminal.?disposition" src/control/incidents/incident-authority.ts
grep -nEi "causally changed|unchanged.*retry|new evidence" src/control/incidents/
```

### Шаг 11. Implementation gates 0-10 (план §16)

Для каждого гейта проверить: deliverables + exit gate. Главный источник правды о том,
что уже сделано — `docs/architecture/SAGA-3-0-PROGRESS.md`. Прочитать его целиком.
Затем сверить каждое exit-условие с фактическим кодом/тестом.

| Gate | Deliverable-маркер (файл/тест) |
|---|---|
| 0 | `SAGA-3-0-AUDIT.md`, `ADR-019`, freeze-документ, characterization-тесты |
| 1 | `tests/v3/gate-1-seam.test.mjs`, harness-файлы §11 |
| 2 | `tests/v3/gate-2-schema.test.mjs`, schema round-trip/CAS/migration-тесты |
| 3 | `tests/v3/gate-3-policy.test.mjs`, policy compiler + freeze |
| 4 | `tests/v3/gate-4-shadow.test.mjs`, shadow reconcile (no effects) |
| 5 | `tests/v3/gate-5-parallel.test.mjs`, full DAG + resource claims |
| 6 | `tests/v3/gate-6-incidents.test.mjs`, R0-R9, single retry authority |
| 7 | `tests/v3/gate-7-effects.test.mjs`, crash matrix, EXTERNAL_STATE_UNKNOWN |
| 8 | `tests/v8/gate-8-evidence.test.mjs`, adversarial LM suite, independent verification |
| 9 | `tests/v3/gate-9-certification.test.mjs`, all 9 terminal predicates |
| 10 | `tests/v3/gate-10-*.test.mjs`, `cutover-suites/`, real cutover in orchestrate.ts |

```bash
ls tests/v3/gate-*.test.mjs
ls tests/v3/cutover-suites/
# Реальный cutover в production pump (Gate 10)
grep -nE "isV3Authority|v3TerminalInsteadOfPause|auditV3NoHumanPaths" src/orchestrate.ts
```

Для каждого гейта — строка в таблице со статусом (DONE/PARTIAL/MISSING) и ссылкой
на commit в PROGRESS.md.

### Шаг 12. Migration/coexistence (план §17)

Три режима: `v2`, `v3_shadow`, `v3`. Проверить, что controller_version поддерживает их,
что shadow не имеет эффектов, что legacy readable + mode explicit.
```bash
grep -rniE "controller_version|v3_shadow|'v3'|\"v3\"|legacy.*readable|drain" src/control/cutover.ts src/orchestrate.ts
```

### Шаг 13. Test commands (план §19)

8 обязательных скриптов npm: `test:v3:unit`, `test:v3:scenario`, `test:v3:properties`,
`test:v3:crash`, `test:v3:parallel`, `test:v3:compat`, `test:v3:shadow` (+ `--stage`).
```bash
node -e "const s=require('./package.json').scripts; ['test:v3:unit','test:v3:scenario','test:v3:properties','test:v3:crash','test:v3:parallel','test:v3:compat','test:v3:shadow'].forEach(k=>console.log((s[k]?'\u2705':'\u274c')+' '+k + (s[k]?' => '+s[k]:'')))"
```

§19 также требует: три CI-скопа (PR/nightly/release), leak detection, no flaky/no real sleep,
mutation testing. Это harder to verify statically — отметить как UNCLEAR если нет явных
CI-конфигов/скриптов, и указать где искать.

### Шаг 14. Definition of done (план §21, 18 пунктов)

18 пунктов DoD. Пройти по списку и для каждого дать статус. Это финальный чек.
Большинство пунктов уже покрыты шагами 1-13; здесь — агрегированная сверка.
Не подменять детальные шаги сводным «вроде done».

### Шаг 15. Risk register (план §20)

14 рисков с митигациями. Не «выполнимость», а **наличие митигации в коде/тестах**.
Например, «Generation churn resets budgets → append-only ledger + carry-forward» —
проверить, что carry-forward реально есть (см. шаг 1, инвариант 11). Для каждого риска —
строка со ссылкой на место митигации или MISSING.

## Формат вывода

Финальный отчёт — markdown с обязательными секциями. Без воды, каждая находка
должна ссылаться на конкретный пункт плана и конкретный файл/тест.

### Заголовок отчёта

```markdown
# 🔍 Аудит Saga 3.0 против плана рефакторинга — <YYYY-MM-DD>

**Ветка:** <branch> @ <short-sha> (worktree <clean/dirty>)
**Канон:** docs/plans/SAGA-3-0-REFACTORING-PLAN.md (REVISED DRAFT, 2026-07-22)
**Прогресс-журнал:** docs/architecture/SAGA-3-0-PROGRESS.md
**Базовые документы:** MANDATE / AUDIT(Gate0) / FREEZE / ADR-019 — <все/частично/отсутствуют>
**Метод:** статическая сверка read-only (без прогона npm test/build)
```

### Сводная таблица

Одна строка на пункт плана. Колонки: **Пункт плана | Статус | Что проверено | Что не сделано / рекомендация**.

Пример (фрагмент):

```markdown
## Сводная таблица соответствия плану

| Пункт плана | Статус | Что проверено | Что не сделано / рекомендация |
|---|---|---|---|
| §3 инв.1 LM proposes/controller authz/evidence | ✅ DONE | controller.ts, proposals/, properties/ | — |
| §3 инв.2 v3 не ждёт человека | ✅ DONE | cutover.ts, orchestrate.ts guards, gate-10-canary | — |
| §3 инв.11 бюджет атомарный, не сбрасывается | ⚠️ PARTIAL | grep budget/reservation → 0 совпадений в src/control | Нет выделенного budget-модуля; см. §8.4. Реком.: завести src/control/budgets/ + BudgetLedgerEntry |
| §7 ModelPort | ✅ DONE | ports.ts: interface ModelPort | — |
| §11.1 harness scripted-model.mjs | ✅ DONE | tests/v3/harness/scripted-model.mjs | — |
| §18 src/control/budgets/ | ❌ MISSING | dir absent | Завести директорию (план §18 явно перечисляет) |
| §18 src/control/work-intents/ | ❌ MISSING | dir absent | Завести директорию (план §18) |
| §16 Gate 10 real cutover | ✅ DONE | orchestrate.ts guards, gate-10-*.test.mjs, PROGRESS commit 9e55bce | — |
| §19 test:v3:compat | ✅ DONE | package.json scripts | — |
| §19 mutation testing | ❓ UNCLEAR | нет явного скрипта | Проверить CI-конфиг на presence mutation-раннера |
```

### Детализация по разделам

После сводной таблицы — раскрытие каждого статуса ≠ ✅. Для каждого ⚠️/❌/❓:
- Цитата требования из плана (одна строка).
- Что нашли при проверке (команда + результат).
- Конкретная рекомендация (что завести/дописать/уточнить), со ссылкой на файл.

### Сводка по гейтам

Отдельная компактная таблица только по §16 (гейты 0-10), со ссылкой на commit из PROGRESS.md:

```markdown
## Статус гейтов (план §16)

| Gate | Статус | Commit (PROGRESS.md) | Открытые пункты |
|---|---|---|---|
| 0 | ✅ DONE | — | — |
| 1 | ✅ DONE | — | — |
| … | … | … | … |
| 10 | ✅ DONE | 9e55bce | — |
```

### Итоговый вердикт

Финальный блок — 3-5 предложений:
- Сколько пунктов ✅ / ⚠️ / ❌ / ❓ из общего числа.
- Топ-3 самых крупных пробела (по влиянию на Definition of Done §21).
- Явно ли выполнен §21 (Definition of done) целиком — да/нет/частично с причинами.
- Что рекомендуется сделать в первую очередь.

## Что скилл НЕ делает никогда

- ❌ Не запускает `npm install`, `npm test`, `npm run build`, `tsc`, миграции БД.
- ❌ Не мутирует saga.db (если к ней обращается — только `sqlite3 -readonly`).
- ❌ Не вызывает MCP write-tools (`task_update`, `worker_*`, `episode_*`, `artifact_*`).
- ❌ Не правит код, тесты, документацию, package.json.
- ❌ Не выдаёт вердикт «всё готово» без явной сверки каждого пункта §21.
- ❌ Не пропускает разделы плана «потому что видно, что done» — каждый пункт отдельно.
- ❌ Не подменяет PROGRESS.md — сверяет его утверждения с фактическим кодом (журнал
  может отставать или опережать реальность; скилл показывает расхождения).

## Правила

- Идти строго по разделам плана 3 → 21. Не переупорядочивать.
- Каждый пункт плана получает ровно одну строку в сводной таблице. Если пункт
  состоит из подпунктов (например, 17 сущностей §8.1) — либо одна строка с
  детализацией «N/M сделано», либо дочерние строки с отступом; консистентно по всему отчёту.
- Статус ✅ требует **конкретного доказательства** (файл + строка или имя теста).
  «Наверное есть» — это ❓ UNCLEAR, не ✅.
- Статус ❌ MISSING требует, чтобы требование было **явно в плане** (цитата §N).
- Рекомендация должна быть **конкретной и исполняемой** («завести X», «дописать тест Y
  покрывающий Z»), не абстрактной («улучшить»).
- Если PROGRESS.md утверждает DONE, а код не подтверждает — ставить ⚠️ PARTIAL с пометкой
  «PROGRESS говорит DONE, но <файл/тест> отсутствует — расхождение журнала и кода».
- Если пункт плана нельзя проверить статически (например, «shadow comparison against
  representative v2 episodes» — нужны реальные данные) — ставить ❓ UNCLEAR и объяснять,
  какая ручная проверка нужна.
- Базовая линия (ветка/коммит/наличие канон-документов) обязательна в начале отчёта.

## Примеры типовых находок

- **§18 src/control/budgets/ MISSING** — план явно перечисляет 14 директорий, двух нет.
  Реком.: завести `src/control/budgets/` + BudgetLedgerEntry (см. §8.4), либо задокументировать,
  почему budget living в другом модуле (если так — проверить §8.4 там).
- **§3 инв.11 PARTIAL** — grep `budget|reservation|carry-forward` по `src/control/` пуст.
  Реком.: реализовать atomic reservation + carry-forward (§8.4); без этого §21 DoD-пункт
  «Budgets are reserved and consumed atomically and never reset» невыполним.
- **§11.4 UNCLEAR** — проверить отсутствие real sleeps в `tests/v3/` вне virtual-clock.
  Если найден `setTimeout` в детерминированном тесте → ❌ MISSING (план: «No deterministic
  test may wait for real time to pass»).
- **§16 Gate 8 self-certification** — проверить, что gate-8-evidence.test.mjs содержит
  кейс «verifier cannot certify execution it implemented». Если кейса нет → ⚠️ PARTIAL.

## Границы скилла

- Статическая сверка не доказывает **корректность** реализации — только наличие
  структуры/теста. Семантическая правильность — через прогон `npm test:v3:*` (отдельный шаг).
- Не оценивает производительность/UX продукта saga-mcp — только соответствие плану.
- Не видит приватных веток/feature-флагов вне текущего worktree.
- PROGRESS.md может содержать утверждения, которые скилл не сможет опровергнуть без прогона
  (он отметит расхождение, но финальное слово — за CI/ручным прогоном).
- Размер плана (≈200 пунктов) означает, что полный прогон аудита занимает много tool-call'ов;
  не пытаться ускорить, пропуская разделы.
