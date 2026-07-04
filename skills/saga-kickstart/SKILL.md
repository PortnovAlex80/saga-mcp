---
name: saga-kickstart
description: |
  Discovery-phase skill: idea → brief → decision. Запускается оркестратором
  saga-флоу перед formalization (PRD/SRS/UC/AC). Проводит триаж (3 ассесора
  product/system/risk), completeness-gate по db.sqlite, decision-fork на
  развилках, verdict+override. Возвращает decision ∈ {go, fast-track,
  clarify, reject} + зарегистрированный brief-артефакт. Источник: SRS-004
  §2b.7, BRIEF-004.
---

# saga-kickstart

> Discovery-фаза saga-флоу. Принимает идею одной фразой, возвращает decision.
> Все секции ниже заполнены body-задачами REQ-004 (#219-224).

## Flow position (saga-flow)

- **Stage:** 1-Discovery (первая фаза, входная точка)
- **Precondition:** Идея от пользователя (одной фразой). Saga-mcp DB доступна.
  Epic REQ-NNN создан (или будет создан в процессе).
- **Postcondition:** Brief artifact accepted, decision ∈ {go, fast-track, clarify, reject}
- **Called by:** saga-orchestrator (Этап 1), либо напрямую пользователем
- **Next enables:**
  - decision=go → saga-product (PRD, Этап 2)
  - decision=fast-track → saga-planner (минуя formalization)
  - decision=clarify → стоп, вопросы пользователю
  - decision=reject → эпик закрыт
- **Проверь precondition:** если saga-mcp DB недоступна → STOP (Sign F3, failover)
- **ВНИМАНИЕ (Sign 005):** это SKILL в main-context, НЕ subagent. В subagent_child
  нет Agent/AskUser tools.

**Source of truth:**
- SRS-004 §2b.7 (artifact 79) — section list + saga-mcp tool calls.
- BRIEF-004 §2 (artifact 77) — 12-section brief layout.
- FR-1 — exact brief anchor names (contract, must not drift).

**saga-mcp tools this skill calls** (from SRS §2b.7; the tool surface itself
is scaffolded by the parallel saga-mcp SCAFFOLD task #215):
- `extractInputs` — via a helper, builds `00-inputs.md` from db.sqlite
  (PRIMARY) with fingerprint-idempotency and rollout-jsonl FALLBACK.
- `artifact_create({ type: 'brief' })` — persists the discovery brief as a
  saga artifact (carry state between sessions).
- `AskUser` — for completeness-gate mandatory override and verdict override
  (especially on `reject` / `clarify`).

---

<a id="decision-fork"></a>
## Decision-fork (rule №1)

> **Правило №1 скилла** (PRD-004 l.72, FR-6, UC-2). При любой неоднозначности,
> допускающей ≥2 валидных варианта (выбор topology / классификации / решение
> open-question), скилл **не угадывает молча**, а строит decision-matrix и
> решает её параллельными ассессорами. Это первое и обязательное правило —
> ниже всей остальной логики Discovery.

**Когда активируется.** Discovery (секция discovery-flow) столкнулся с
развилкой: brief несёт ≥2 равноправных направления, либо ассессоры WIDTH-триажа
(UC-1) разошлись в topology/classification, либо есть open-question, у которого
несколько валидных ответов. Триггер фиксированный — **≥2 валидных варианта**;
если из контекста реально вытекает только один путь, decision-fork **не**
запускается (не плодить матрицы ради матриц).

### Шаг 1 — построить матрицу (критерии × ≥3 варианта)

Скилл формулирует **decision-matrix** и кладёт её в секцию brief
`#decision-matrix` (контракт `BriefPayload.decision_matrix`, SRS §2b.2):

```
decision_matrix: {
  criteria: string[];                         // ≥2 строк (критерии)
  variants: { name: string; scores: Record<string, number> }[];  // ≥3 столбца
}
```

- **Критерии (≥2)** тянутся из самого brief, не придумываются: business-objectives
  (§1), complexity.risk_triggers (§3), affected-projects (§9),
  shared-mutation-risk (§12). Типичные: «соответствует бизнес-цели»,
  «риск shared-mutation», «трудоёмкость», «изолируемость в отдельный task».
- **Варианты (≥3)** — альтернативные направления раскрытия неоднозначности.
  Каждый вариант = осмысленная альтернатива (не соломенное чучело для разгрома).

**Жёсткий контракт (AC-3):** матрица обязана иметь **≥3 варианта × ≥2 критерия**.
Если валидных вариантов <3 — см. «Clarify» ниже: матрицу мельчить нельзя.

### Шаг 2 — решить матрицу

**(a) Субагенты доступны → ровно 3 параллельных ассессора** (`subagent-spawn`,
каждый в своей `subagent_child` сессии, UC-2 поток 2):

- assessor-1 — защищает вариант A;
- assessor-2 — защищает вариант B;
- assessor-3 — защищает вариант C (либо синтез/компромисс).

Каждый ассессор получает матрицу и свой вариант, возвращает обоснование по всем
критериям (`scores` по каждому критерию). Скилл дожидается **всех трёх**
(синхронное ожидание, SRS §2.2), затем синтезирует: сравнивает варианты по
матрице, считает суммарные/взвешенные оценки, выбирает recommendation.

**(b) Субагенты недоступны → degraded-режим** (UC-6 поток 1, FR-6):

- оркестратор/скилл **сам** генерирует 3 варианта по тем же критериям матрицы
  и **сам** проставляет `scores` (по правилу №1, но без давления независимых
  ассессоров);
- в brief ставится **`degraded: true`** (поле `BriefPayload.degraded`);
- спонсор информируется, что recommendation менее надёжна (нет трёх
  независимых защит — единая точка взгляда). При `completeness=low` это
  дополняется mandatory AskUser (см. Completeness-gate, UC-3/UC-6).

Degraded-режим **честен и мечен**, никогда не тихий (NFR-5): grep по
`degraded=true` обязан находить каждый такой случай.

### Шаг 3 — recommendation прослеживается до матрицы

Скилл записывает в секцию `#decision-matrix` полную матрицу (criteria + variants
+ scores), а в секцию `#decision` — выбранный вариант + `reasoning` (≥1 фраза).
**Recommendation обязана опираться на критерии матрицы**: reasoning указывает,
по каким критериям выиграл выбранный вариант (traceability до строк матрицы).
Не «выглядит лучше», а «победил по критериям X, Y». Это и есть проверяемость
AC-3: recommendation можно сверить с матрицей.

При `complexity ≥ L` либо расхождении verdict между ассессорами — второй раунд с
когнитивными фреймингами (risks / design / simplify) для напряжения выбора
(UC-2 поток 5); результат всё равно оседает в той же матрице.

### Clarify — когда матрицу построить нельзя (<3 валидных варианта)

Если из контекста вытекает **меньше 3 валидных вариантов**, скилл **не**
разбавляет матрицу соломенными/фиктивными вариантами и **не** делает тихий
fallback к одному варианту. Вместо этого — **эскалация `decision=clarify`**
(UC-2 постусловие-провал, UC-4):

- в секцию `#decision` пишется `decision: 'clarify'` + reasoning («менее 3
  валидных вариантов, матрица не строится — нужна ясность спонсора»);
- mandatory `AskUser` к спонсору (см. Verdict+override — цена ошибки при
  clarify максимальна, override обязателен);
- downstream formalization **не стартует** без ответа спонсора.

Тихий проход через <3-вариантную матрицу = нарушение правила №1. Лучше честный
clarify, чем поддельная матрица.

### След

Каждый запуск decision-fork оставляет наблюдаемый след (NFR-5): полная матрица
в `#decision-matrix`, `degraded`-флаг (если был), итоговый `decision` +
`reasoning` в `#decision`. Всёpersistируется через `artifact_create({type:'brief'})`
как часть brief-артефакта saga-mcp (каскад: `decision_matrix` persist в saga-mcp,
AC-1/#217).

<a id="completeness-gate"></a>
## Completeness-gate

> **Implements:** FR-8, FR-5 (failover), NFR-1 (no silent pass), SRS §3.3
> (AskUser format), UC-3. Inputs come from the `extractInputs` gate-helper
> (SRS §2b.4, saga-mcp AC-2/#t218) — this skill **calls the helper**, it does
> NOT re-run the SQL itself.

**Purpose.** Before any `decision` is formed, the brief must cover **100% of
the significant input replicas** of the parent session. A significant replica
is exactly what the helper's fixed SQL filter selects
(`role='user' AND synthetic IS NOT true AND part.type='text'
AND session_id=<parentSessionId>`, SRS §2b.4) — the skill never redefines
"significant" on its own. The gate is the hard boundary that keeps a replica
from being **silently dropped**: every `[I-NNN]` row of `00-inputs.md` must end
up either covered by a brief section or explicitly parked as an open question.

**Gate contract (deterministic, single rule).**

```
covered_count  = # of InputRows where  Covers = <brief-section-anchor>
                                        OR Status = open-question
total_count    = inputs.length          (all InputRows from 00-inputs.md)
coverage       = covered_count / total_count     (0..1; 1.0 iff total>0 and
                                                 every row is covered)
gate_passed    = (coverage === 1.0) AND (source === 'db.sqlite')
```

- `source` comes straight from the helper's `CompletenessResult.source`
  (`'db.sqlite'` PRIMARY | `'rollout-jsonl'` FALLBACK). On the FALLBACK path
  coverage cannot be honestly asserted, so the gate is **forced false** even if
  every row is nominally covered — this is the NFR-1 / FR-5 invariant: no silent
  `completeness=low` pass.
- `Covers=<brief-section-anchor>` references one of the 12 template anchors
  (`#business-objectives`, `#classification`, `#complexity`, `#hypotheses`,
  `#quality-gate-checklist`, `#open-questions`, `#decision-matrix`, `#decision`,
  `#affected-projects`, `#topology-hint`, `#scaffold-artifacts`,
  `#shared-mutation-risk`). `Status=open-question` routes the replica into the
  brief's `#open-questions` section — still counted as covered, but flagged for
  the sponsor.
- **Edge case `total_count === 0`:** there is nothing to cover. This is treated
  as `coverage = 1.0` (vacuously covered) **and** requires `source ===
  'db.sqlite'` to pass — i.e. an empty result from a readable DB passes, but an
  empty-looking result that actually came from the rollout fallback still fails
  the gate (you cannot prove "no inputs" from a degraded source).

**Procedure.**

1. **Invoke the helper.** Call `extractInputs(readSelfSessionId(), { dbPath,
   rolloutPath })` (SRS §2b.4). Read `source`, `inputs[]`, `covered_count`,
   `total_count`, `coverage` from the returned `CompletenessResult`. Do not
   compute coverage here — trust the helper, that is AC-2's contract.
2. **Compute the gate.** Apply the single rule above → `gate_passed`.
3. **Branch:**
   - **`gate_passed === true`** → continue the flow to the decision-fork /
     verdict. Emit the marker `GATE: passed (coverage=1.0, source=db.sqlite)` so
     the success path is grep-observable (NFR-5).
   - **`gate_passed === false`** → **do NOT proceed to `decision`.** Run the
     mandatory AskUser loop below. This is unconditional: no heuristic, no
     "looks mostly covered" shortcut, no best-effort continue.

**Mandatory AskUser on gate failure (FR-8 / §3.3 / UC-3).**

When the gate fails, block the flow and ask the sponsor with a structured
message. The body of the question lists **every uncovered replica** in the
canonical format from SRS §3.3:

```
COMPLETENESS-GATE: not passed
coverage = <covered>/<total> (source=<db.sqlite|rollout-jsonl>)
The following input replicas are not yet covered by the brief:

  [I-001] <text[:100]> → uncovered
  [I-007] <text[:100]> → uncovered
  ...

For each, either point it at a brief section (Covers=<anchor>) or mark it
Status=open-question. Until coverage reaches 1.0 (on source=db.sqlite) the
discovery cannot proceed to a decision.
```

Each line uses the helper's stable `i_id` (`[I-NNN]`) and a truncated replica
text — same identifiers as `00-inputs.md`, so the sponsor and the gate refer to
the same rows.

**Re-evaluation loop (UC-3 1a/1b).**

The sponsor's answer mutates the brief draft (adds `Covers=` / `Status=`
annotations on the relevant rows), then the gate is **recomputed** by re-invoking
the helper / recomputing `covered_count`. Loop until `gate_passed === true` OR an
escalation fires. Bound the loop at a small fixed number of iterations
(default 3) to avoid an open-ended AskUser ping-pong.

**Escalation to `decision=clarify` (never an auto-pass).**

- If the re-evaluation loop exhausts its iteration budget and the gate is still
  failing → **escalate** to `decision=clarify`. The uncovered replicas are moved
  into the brief's `#open-questions` section verbatim (they stay visible, not
  lost), and the discovery ends at `clarify` — downstream formalization is
  blocked per UC-4 / FR-10 until the sponsor answers.
- **It is forbidden to reach `decision=go` (or `fast-track`) with
  `gate_passed === false`.** The only exits from a failed gate are: (a) the
  sponsor's answers raise coverage to 1.0 on `source=db.sqlite` → gate passes →
  continue; (b) escalation to `decision=clarify`. There is no third path.

**No-silent-drop invariant.** Throughout, every `[I-NNN]` row carries one of
`Covers=<anchor>` or `Status=open-question` — a row is never both uncovered and
unasked. This is what "no significant replica is lost silently" operationalizes:
either it is covered, or it is an open question the sponsor was asked about.

**Grep markers (NFR-5 observability).** Emit one of these strings on the
non-default paths so the run is auditable:
- `GATE: passed (coverage=1.0, source=db.sqlite)` — success.
- `GATE: blocked → AskUser (coverage=<c>/<t>, source=<…>)` — gate failing,
  sponsor prompted.
- `GATE: escalate → decision=clarify (uncovered after <n> rounds)` — escalation.

**Cross-repo note.** The `extractInputs` / `readSelfSessionId` helpers live in
saga-mcp (AC-2/#t218). This skill imports/calls them by the contract in SRS
§2b.4 and must not duplicate the SQL or the fingerprint logic. Integration
testing with the real helper happens at INTEGRATE (#t227).

**Проверка (DoD — AC-4).** Two observable cases gate this behaviour:

| # | Setup | Assert |
|---|---|---|
| 1 | Brief with ≥1 uncovered significant replica (`source=db.sqlite`) | `gate_passed === false` **AND** an `AskUser` call is made whose body lists `[I-NNN] text → uncovered` for each uncovered row; flow does **not** reach `decision`. |
| 2 | Brief covers 100% of replicas (`covered_count === total_count`, `source=db.sqlite`) | `gate_passed === true`, flow proceeds to the decision-fork / verdict, **no** `AskUser` is issued. |

(Fallback-only coverage — `source=rollout-jsonl` — fails case 2 even when
`covered_count === total_count`, because the gate forces `gate_passed=false` off
the degraded source; this is the NFR-1 no-silent-pass check.)

<a id="verdict-override"></a>
## Verdict + override

> **Implements:** FR-10 (SRS §2b.1), FR-3 (id82), NFR-5 (observability),
> UC-7 (verdict + override), UC-4 (clarify), UC-5 (fast-track), BRIEF §8
> (rule-arbiter) + §10 (verdict block), SRS §3.3 (UX-контракты). The decision
> recommendation comes from the decision-fork (rule №1) above; this section is
> the ** fixation gate** — the last human checkpoint before a recommendation
> hardens into a recorded decision and downstream formalization may start.

**Purpose.** Nothing leaves Discovery as a committed `decision` without an
explicit verdict block in the output and (for `reject` / `clarify`, but
available for any outcome) a sponsor confirmation. Automation must never
silently turn a recommendation into a `reject` / `clarify` that blocks (or a
`go` / `fast-track` that launches) — the cost of an error is maximal there, so
the human override is the safety release.

**Block format (strict — FR-10 / SRS §3.3).** Immediately before fixation the
skill prints exactly this one line in `output` / main-context:

```
VERDICT: <decision> | REASONING: <1 фраза> | override? (y)
```

- `<decision>` ∈ `{go, fast-track, clarify, reject}` — the recommendation from
  the decision-fork, never blank, never a fifth literal.
- `<1 фраза>` = the reasoning from `BriefPayload.reasoning` (≥1 sentence,
  already required by `validateBrief`). It points at **which matrix criteria**
  the winning variant won on (traceability to `#decision-matrix`), not a
  free-form «looks better».
- `override? (y)` is the prompt — the skill **waits** for the sponsor's answer
  before doing anything downstream. No answer ⇒ no fixation, no downstream.

**When the block is mandatory vs available (FR-10).**

- **Always** when `decision ∈ {reject, clarify}` — these block or stall the
  episode, so the sponsor must confirm (or override) before the recommendation
  hardens.
- **Available** for `{go, fast-track}` too — the sponsor may still override a
  `go` into a `reject`, or a `fast-track` into a full `go` (see UC-5 alt-flow
  «complexity underestimated»). Emitting the block for every decision is the
  simplest correct implementation and keeps the run auditable.

### The four override branches (UC-7 main + alt + failure postconditions)

After the block, the sponsor's answer routes into exactly one of four branches.
Each leaves a distinct, grep-observable marker (NFR-5).

**Branch 1 — `override = no`** (UC-7 main flow 2). The recommendation is
**fixed as the decision** verbatim. No extra payload. Emit
`VERDICT-CONFIRMED: <decision> (recommendation accepted)` and proceed to the
downstream rule below.

**Branch 2 — `override = yes` + reason** (UC-7 main flow 3). The sponsor states
a **different** outcome **and a reason**. Both are required:

1. The new outcome (`<decision'>`) replaces the recommended one in
   `BriefPayload.decision`.
2. The reason is recorded — **in the output first**, not only in reasoning.
   Canonical marker:
   ```
   OVERRIDE: <decision> → <decision'> | REASON: <sponsor's reason, ≥1 фраза>
   ```
3. The reason is **persisted** into the brief artifact via
   `artifact_create({ type: 'brief', ..., metadata: { brief_payload: { ...,
   override: { from: <decision>, to: <decision'>, reason: <reason> } } } })`
   (FR-1 upsert-by-code; the override block rides inside
   `metadata.brief_payload` — the saga-mcp side of this contract is the
   `impact:saga-mcp` cascade tagged on AC-8). `artifact_get(brief)` then
   returns the override reason, so it survives across sessions.
4. If `<decision'>` is `clarify` / `reject`, the downstream-block rule (below)
   still applies to the **new** outcome.

**Branch 3 — `override = yes` without a reason** (UC-7 failure postcondition).
The gate **does not accept it** — fixation is refused:

- Emit `OVERRIDE: REJECTED — reason required (UC-7 postcondition)`.
- The gate stays open; the recommendation is **not** fixed; downstream is
  **not** started. Re-prompt the sponsor for the reason (bound the loop at a
  small fixed iteration count, default 3, matching the completeness-gate
  re-evaluation budget — after that, fall back to Branch 4's record-and-clarify
  or to the recommended decision as draft).

A reason is required for **any** override — including a `go`→`go` cosmetic
change — because an override with no stated reason is indistinguishable from a
misclick and defeats the audit trail (NFR-5).

**Branch 4 — override contradicts the rule-arbiter** (UC-7 alt-flow 3a). When
the sponsor's `<decision'>` contradicts the **rule-arbiter** (BRIEF §8), the
**higher rule wins** and the deviation is recorded — the skill does not blindly
honour the override:

> **Rule-arbiter (BRIEF §8, дословно):** при конфликте
> **безопасность > целостность данных проекта > архитектурный контракт >
> процессный протокол > предпочтения.** Отклонение от низшего правила ради
> высшего — допустимо, но **обязательно фиксируется в output ассессора/воркера,
> не только в reasoning.**

Examples of contradiction the skill must catch:
- An override to `go` on a brief whose `shared_mutation_risk: true` crosses a
  data-integrity line without a recorded mitigation → integrity > preference,
  the skill refuses the `go`, records the deviation.
- An override that would bypass `completeness=low`'s mandatory `AskUser` (AC-4)
  → completeness-gate is the **process protocol** rule; rule-arbiter does not
  let a preference override it silently.

On contradiction the skill:
1. Applies the **higher** rule's outcome (it may differ from both the
   recommendation and the sponsor's `<decision'>`).
2. Records the deviation verbatim —
   `RULE-ARBITER: override to <decision'> rejected — <higher rule> > <lower rule>; deviation recorded` —
   in the **output**, not only in reasoning (BRIEF §8 дословно).
3. Persists the deviation block into `metadata.brief_payload` (same channel as
   Branch 2's reason) so the audit trail is queryable via `artifact_get(brief)`.

### Downstream-block rule (FR-10 / UC-4 / UC-5)

Without an explicit sponsor confirmation at the verdict block, a `reject` or
`clarify` decision **never** starts downstream formalization:

- `decision=reject` unconfirmed ⇒ episode ends at `reject`, no formalization,
  no dev-tasks spawned (UC-4 failure postcondition: «защита от запуска вслепую»).
- `decision=clarify` unconfirmed ⇒ brief is saved as **`draft`** carry-state
  (FR-1 statuses `draft → in_review → accepted`), the open questions stay in
  `#open-questions`, and the episode resumes in the next session with the same
  questions. It is forbidden to escalate `clarify` to formalization on
  autopilot.
- Only after the sponsor answers the verdict block (Branch 1 confirming, or
  Branch 2/4 producing a confirmed `go` / `fast-track`) may downstream start —
  and even then, `completeness=low` still forces `clarify` (see
  `validateBrief`: `completeness=low` blocks `decision=go`).

### Grep markers (NFR-5 observability)

The override path is a non-default path, so every outcome leaves a marker in
the skill output (NFR-5: «100% non-default исходов имеют строку-маркер»):

- `VERDICT-CONFIRMED: <decision> (recommendation accepted)` — Branch 1.
- `OVERRIDE: <decision> → <decision'> | REASON: <reason>` — Branch 2.
- `OVERRIDE: REJECTED — reason required (UC-7 postcondition)` — Branch 3.
- `RULE-ARBITER: override to <decision'> rejected — <higher> > <lower>; deviation recorded` — Branch 4.

Every override marker (Branches 2–4) is also written into
`metadata.brief_payload` via `artifact_create`, so `artifact_get(brief)` is the
durable source of the override audit trail across sessions.

**Cross-repo note.** The override-reason persistence rides on the saga-mcp
`artifact_create({ type:'brief' })` contract (FR-1, SRS §2b.3). The skill
**writes** the override block into `metadata.brief_payload`; the saga-mcp side
validates and stores it (`impact:saga-mcp` cascade on AC-8). Integration with
the real `artifact_create` is exercised at INTEGRATE (#t227).

**Проверка (DoD — AC-8).** Four observable cases gate this behaviour:

| # | Setup | Assert |
|---|---|---|
| 1 | Recommendation ready, fixation imminent | The exact line `VERDICT: <decision> \| REASONING: <1 фраза> \| override? (y)` is present in `output` **before** the decision is fixed; for `reject`/`clarify` it is always present. |
| 2 | `override = yes` + reason | `OVERRIDE: … \| REASON: <reason>` is in `output` **and** `artifact_get(brief).metadata.brief_payload` carries the override reason (new outcome + reason). |
| 3 | `override = yes` without reason | `OVERRIDE: REJECTED — reason required`; gate stays open, recommendation **not** fixed, downstream **not** started. |
| 4 | Override contradicts rule-arbiter (e.g. `go` over a data-integrity line) | `RULE-ARBITER: …` marker; the **higher** rule's outcome is applied; the deviation is recorded in `output` and in `metadata.brief_payload`. |

(An unconfirmed `reject`/`clarify` additionally asserts: no formalization task
is spawned — covered jointly with UC-4 / AC-5.)

<a id="failover-table"></a>
## Failover-таблица

> **Implements:** AC-7 (degraded/fallback), FR-5/FR-6, NFR-1 (no silent pass),
> NFR-2/NFR-5 (observability), UC-6. Cross-cuts two repos: the **saga-mcp
> helper** (`extractInputs`/`readSelfSessionId`, AC-2/#t218 + AC-7/#t223) owns
> the db.sqlite→rollout fallback; this skill owns the brief-marking and the
> hard STOP on saga-mcp-tracker unavailability. See BRIEF §11.

**Разные «DB» — не путать.** В этой таблице два разных хранилища, и AC-7
обращается с ними по-разному:

| Хранилище | Что это | Кто читает | При недоступности |
|---|---|---|---|
| **`db.sqlite`** (zcode chat log) | `~/.zcode/cli/db/db.sqlite` — лог реплик сессии. Источник **входных данных** для `00-inputs.md`. | `extractInputs` (saga-mcp helper, AC-2/#t218) | **мягкий** fallback на rollout-jsonl → degraded brief (`completeness=low`). |
| **saga-mcp tracker DB** | sqlite saga-mcp (артефакты/задачи). Источник **персистентности brief** (`artifact_create({type:'brief'})`). | `artifact_create` (saga-mcp tool) | **жёсткий** `STOP + report`, **без retry-loop**, без создания brief. |

### Таблица failover (3 режима, UC-6 / AC-7 Then-1/2/3)

| # | Условие | Действие | Маркер (grep) | Исход |
|---|---|---|---|---|
| **F1** | Субагенты недоступны для decision-fork (нет `subagent-spawn`) | Оркестратор/скилл **сам** генерирует 3 варианта по матрице (правило №1), **сам** проставляет `scores`. В brief ставится `degraded=true`. Спонсор информирован: recommendation менее надёжна (нет 3 независимых защит). | `FAILOVER: assessors unavailable → degraded=true (orchestrator-generated 3 variants)` | decision формируется (не падает молча), но честно меченый. См. Decision-fork §(b). |
| **F2** | `db.sqlite` пуст/недоступен (open-fail или 0 строк по `parentSessionId`) | `extractInputs` читает последнюю строку `rollout/model-io-sess_<parent>.jsonl`, возвращает `source='rollout-jsonl'`, `gate_passed=false`, **`completeness='low'`**, **`degraded=true`**. Brief помечается `completeness=low` + `degraded=true`. | `FAILOVER: db.sqlite unavailable → source=rollout-jsonl, completeness=low` | **mandatory AskUser** (UC-3/UC-4) — спонсор подтверждает; gate насильно закрыт (NFR-1). См. Completeness-gate. |
| **F3** | **saga-mcp tracker DB** недоступна (невозможно `artifact_create`) | **`STOP + report`**. **Без retry-loop.** **Без создания brief.** Discovery не продолжается —persist-state некуда писать, continuance бессмысленен. | `FAILOVER: saga-mcp tracker DB unavailable → STOP, no retry, no brief` | жёсткая остановка; не лечится degraded-режимом (UC-6 альт-поток 1a). |

### Degraded-маркировка brief (F1/F2)

Degraded-прогон **обязан** оставить явные метки в brief — это контракт с
`BriefPayload` (SRS §2b.2, реализован AC-1/#t217 валидатором):

```
BriefPayload {
  ...
  completeness: 'low'   // из CompletenessResult.completeness (F2: rollout-jsonl)
  degraded:     true    // F1 (нет ассессоров) ИЛИ F2 (rollout-jsonl), или оба
}
```

- **`completeness`** — прямое отражение `CompletenessResult.completeness`
  (saga-mcp helper AC-7/#t223): `'high'` только для авторитетного `db.sqlite`,
  `'low'` для fallback. Валидатор (`validateBrief`, SRS §2b.2 Rule 3) **запрещает**
  `completeness='low'` + `decision='go'` → такой brief невалиден; разрешён только
  `clarify`/`reject`/`fast-track` при low.
- **`degraded`** — `true` для F1 и/или F2. `true` → спонсор информируется о
  пониженной надёжности в AskUser-сообщении.

Каскад маркеров: rollout-fallback (helper) `completeness=low` → brief
`completeness=low` → валидатор форсирует не-`go` → mandatory AskUser. Метки
**сквозные** — ни одно звено не «забывает» degraded-флаг.

### Mandatory AskUser при `completeness=low` (F2)

При F2 gate **закрыт насильно** (`gate_passed=false` на `source=rollout-jsonl`,
NFR-1) — см. Completeness-gate. Скилл **обязан** запросить спонсора (UC-3/UC-4):
формат AskUser — из SRS §3.3, тело содержит `source=rollout-jsonl`,
`coverage=<c>/<t>` и каждую непокрытую `[I-NNN]` реплику. **Тихой** генерации
brief с `completeness=low` без AskUser быть не может — это и есть инвариант
AC-7 / NFR-1: «Ни одного "тихого" прохода с completeness=low без явной метки в
brief».

### STOP при недоступности saga-mcp tracker DB (F3) — без retry

F3 — единственный **жёсткий** провал: скилл не может persistнуть brief, значит
discovery не имеет continuance-state. Поведение фиксировано (UC-6 альт-поток 1a):

1. **Не ретраить в цикле.** Никакого `while(!db) retry()` — saga-mcp tracker DB
   либо доступна, либо discovery честно останавливается. Retry-loop маскировал бы
   инфра-проблему и откладывал спонсора.
2. **Не создавать brief.** Без персистентности brief — это пустышка; артефакт
   не пишется (`artifact_create` не вызывается / падает явно).
3. **`STOP + report`** — скилл завершается с явным сообщением спонсору:
   `saga-mcp tracker DB unavailable; discovery halted (no retry, no brief).
   Restore DB connectivity and re-run kickstart.`

Это **не** degraded-режим: degraded (F1/F2) всё ещё выдаёт честно меченый
decision; F3 не выдаёт ничего, кроме отчёта. Разделение принципиальное — его
нельзя «сгладить» fallback'ом.

### Grep-маркеры (NFR-5 observability — совместно с AC-10)

Каждый не-дефолтный прогон оставляет один из маркеров (grep-аудит AC-10):

- `FAILOVER: assessors unavailable → degraded=true (orchestrator-generated 3 variants)` — F1.
- `FAILOVER: db.sqlite unavailable → source=rollout-jsonl, completeness=low` — F2.
- `FAILOVER: saga-mcp tracker DB unavailable → STOP, no retry, no brief` — F3.
- `GATE: passed (coverage=1.0, source=db.sqlite)` — норма (из Completeness-gate).

Дефолтный (авторитетный) прогон **не** мечен degraded — grep по `degraded=true`
находит **только** degraded-прогоны, никаких ложных срабатываний (контракт
`BriefPayload.degraded`).

**Проверка (DoD — AC-7).**

| # | Setup | Assert |
|---|---|---|
| 1 | `extractInputs(dbPath='nonexistent.db')` + валидный rollout-jsonl | `source='rollout-jsonl'`, `gate_passed=false` (saga-mcp unit-test, AC-7/#t223). |
| 2 | saga-mcp tracker DB недоступна во время discovery | **нет retry** и **нет артефакта brief** (интеграционный тест); скилл `STOP + report`. |
| 3 | любой fallback-прогон (F1/F2) | в выходе brief есть маркер `completeness=low` **и/или** `degraded=true` (grep-test). |
| 4 | авторитетный прогон (`source=db.sqlite`, ассессоры есть) | **нет** `completeness=low`/`degraded=true` (нет ложных degraded). |

<a id="discovery-flow"></a>
## Discovery-флоу

> **Implements:** FR-7, AC-6 (fast-track). Конвейер Discovery-фазы:
> `inputs-extract → brief-draft → WIDTH-триаж → completeness-gate → verdict`.
> На шаге verdict принимается один из исходов `decision ∈ {go, fast-track,
> clarify, reject}` (FR-7). Эта секция описывает **routing-ветку `fast-track`**
> (AC-6) — отдельный путь, минующий formalization.

### Decision-исходы (FR-7) — куда ведёт verdict

`verdict + override` фиксирует ровно один `decision` с `reasoning`. Дальнейший
routing определяется этим значением:

| decision | куда ведёт routing | downstream |
|---|---|---|
| `go` | → **formalization** (PRD/SRS/UC/AC ролей saga-product/architect/analyst) | carry-state: PRD следующего эпизода несёт `derived_from → brief` |
| `fast-track` | → **kanban напрямую**, минуя formalization (см. ниже) | dev-задача(и) с trace `brief ← derived_from ← dev-task` |
| `clarify` | → STOP, downstream заблокирован до ответа спонсора (FR-10) | open-questions вынесены в brief |
| `reject` | → STOP, тема закрыта, formalization не стартует | ничего |

### fast-track — условия срабатывания (AC-6)

**Rule (детерминированный, все четыре условия одновременно):**

```
decision = 'fast-track'  допустимо  iff
    classification === 'tech-task'
  AND complexity.tshirt ∈ {'XS', 'S'}
  AND affected_projects.length ≤ 1
  AND complexity.risk_triggers is empty   (risk-триггеры не активны)
```

- Это **быстрый канал для мелких тех-задач**: чистая, одиночная, низкорисковая
  задача не нуждается в полном formalization-цикле (PRD/SRS/UC/AC — оверкилл для
  XS/S tech-task). Скилл формирует `decision='fast-track'` + `reasoning` (≥1
  фраза: почему задача подходит под быстрый канал) и фиксирует verdict.
- **Если хотя бы одно условие не выполнено** — `fast-track` **недоступен**; тема
  идёт через `go` (→ formalization) или `clarify`/`reject`. Это не эвристика, а
  жёсткий контракт: нельзя пустить по быстрому каналу мульти-проектную или
  рисковую задачу.
- `validateBrief` уже принимает `decision: 'fast-track'` как валидный литерал
  (AC-1/#217, Rule 1). Никакой отдельной валидации условий fast-track в brief не
  закладывается: условия — это routing-правило скилла, а не поле brief'а.

### fast-track — routing в kanban, минуя formalization (AC-6)

После подтверждённого verdict `decision='fast-track'` скилл даёт оркестратору
сигнал «route в kanban, минуя formalization». Конкретно:

1. **Миновать formalization.** Никаких PRD/SRS/UC/AC артефактов по этой теме не
   создаётся — kickstart отдаёт `decision=fast-track` + brief, а формализация
   пропускается. Оркестратор не вызывает роли saga-product/architect/analyst.
2. **Создать dev-задачу(и) напрямую в kanban.** Оркестратор порождает dev-задачу
   (build-роль, kanban) из цели и affected-projects, видимых в brief'е. Цель
   задачи берётся из brief (business-objectives + hypothesis), affected-projects
   — из `brief.affected_projects`.
3. **Trace `brief ← derived_from ← dev-task` (обязательно).** Каждая
   порождённая dev-задача связывается с brief'ом ребром `derived_from` через
   `trace_add({ link_type: 'derived_from', from: dev_task, to: brief })`. Это
   гарантирует, что исполнитель dev-задачи видит цель и контекст (а не голую
   kanban-запись) — carry-state работает и для быстрого канала.

**Routing-точка в saga-mcp (AC-6 saga-mcp-сторона).** Сам routing (создание
dev-задачи + trace) живёт в saga-mcp planner как **отдельная функция**
`routeFastTrack(brief)` в `src/planner/fast-track.ts` (под сигнатурами SCAFFOLD
#215). Она НЕ трогает `applyImpactCascade` (его body — задача #225) и
`decideTopology` (body — #225): fast-track — отдельный сигнал = отдельная
функция (extension point SRS §2b.5). Это делает merge с параллельной задачей
#225 чистым (разные файлы / разная зона).

### fast-track — эскалация → `decision='go'` (AC-6)

Если в ходе работы по dev-задаче появляются **новые risk-триггеры** (недооценённая
сложность, всплыл второй affected-project, shared-mutation-risk и т.п.) —
срабатывает **эскалация**:

1. `decision` меняется с `fast-track` → **`go`** (тема возвращается в полный
   formalization-цикл: PRD/SRS/UC/AC).
2. В brief **фиксируется lesson** — что именно было недооценено (какой
   risk-триггер сработал, на каком шаге). Это сохраняет traceability: следующий
   раз та же ошибка не пустит задачу по быстрому каналу.
3. Downstream formalization стартует по обычному пути `decision=go`.

**Routing-точка эскалации в saga-mcp:** функция
`escalateFastTrack(brief, reason)` в `src/planner/fast-track.ts` возвращает brief
с `decision: 'go'` и дописанным `lesson`. Эскалация однонаправлена
(`fast-track → go`), обратного перехода нет.

**Проверка (DoD — AC-6).** Два наблюдаемых случая:

| # | Setup | Assert |
|---|---|---|
| 1 | tech-task, `tshirt='S'`, `affected_projects.length ≤ 1`, risk-триггеры пусты, verdict подтверждён | создаётся dev-задача напрямую в kanban (нет PRD/SRS/UC/AC); есть trace `brief ← derived_from ← dev-task`; `decision='fast-track'` |
| 2 | в ходе работы всплывает risk-триггер | `decision` становится `'go'`; в brief есть `lesson`; тема уходит в formalization |

<a id="clarify-flow"></a>
### Clarify-флоу (AC-5)

> **Implements:** UC-4 (полностью), FR-3 (id82), SRS FR-7, SRS FR-10.
> **Trigger:** `decision == 'clarify'` — неважно, откуда он пришёл:
> (а) Decision-fork (§[decision-fork](#decision-fork)) построил <3 валидных
> вариантов и эскалировал, **или** (б) Completeness-gate (§[completeness-gate]
> (#completeness-gate)) исчерпал бюджет итераций AskUser и эскалировал. Дальше
> поведение одно и то же — это **унифицированный clarify-обработчик**, он не
> различает источник.

**Суть (правило).** `clarify` = «тема потенциально ценна, но не хватает
критичной информации». Скилл не угадывает и не делает авто-проход, а
**выясняет у спонсора**, чего именно не хватает, вливает ответы в brief и
**перевычисляет** decision на обновлённом brief. У этого флоу ровно три исхода:
`go` / `reject` / повторный `clarify`. Четвёртого («зависший discovery») нет —
если ответа нет, эпизод честно ложится в `draft` carry-state.

**Шаг 1 — собрать open-questions.** Скилл формирует список того, что именно
мешает принять `go`/`reject`, и кладёт его в секцию brief
[`#open-questions`](../../../docs/requirements/templates/discovery-brief.md#open-questions)
(§6) в каноническом формате (см. формат секции там же). Каждый вопрос несёт
стабильный `[Q-NNN]`, целевой раздел brief (`target: §2/§4/§9 …`) и
`status: open`. Вопросы тянутся из реальных пробелов (непокрытые реплики из
gate, расхождения topology/classification из decision-fork), а не
придумываются.

**Шаг 2 — verdict-блок (FR-10).** Перед тем как спрашивать спонсора, скилл
печатает вердикт-блок в строгом формате контракта
[`#verdict-override`](#verdict-override):

```
VERDICT: clarify | REASONING: <1 фраза, почему не хватает данных> | override? (y)
```

При `clarify` цена ошибки максимальна, поэтому блок **обязателен** (FR-10:
«ВСЕГДА при reject/clarify»). Override обрабатывается по контракту
`#verdict-override` (AC-8/#224) — спонсор может форсировать исход, **но override
не отменяет Completeness-gate**: `gate_passed === false` остаётся блокирующим,
override лишь фиксирует вердикт, а не пропускает gate.

**Шаг 3 — AskUser спонсору (если override не сработал).** Если спонсор не
переопределил verdict, вопросы уходят ему через `AskUser` (UC-4 поток 3; формат
вопроса — SRS §3.3). Тело вопроса перечисляет **каждый** `[Q-NNN]` с целевым
разделом и подсказкой, какого ответа не хватает.

**Шаг 4 — merge ответов в brief.** Ответы спонсора вливаются в целевые разделы
brief (по `target` каждого вопроса): уточняются `#hypotheses` (§4),
`#classification` (§2), `#affected-projects` (§9). Вопросы, на которые получен
ответ, помечаются `status: answered` + `answer: <…>` в `#open-questions`
(вопросы остаются видимыми — не удаляются, это audit-trail). Persist — через
`artifact_create({ type: 'brief' })` **upsert по `code`** (FR-1, SRS §2b.3,
idempotent): тот же `code` в рамках эпизода обновляет brief, а не создаёт
дубликат.

**Шаг 5 — перевычисление decision.** На обновлённом brief скилл **заново
запускает Decision-fork** (§[decision-fork](#decision-fork)) и
**пере-проверяет Completeness-gate** (§[completeness-gate](#completeness-gate)).
Перевычисление — это полноценный повтор обоих, а не патч старого решения:
ответы могли изменить coverage, могли дать новые ≥3 варианта для матрицы. Итог
`decision ∈ {go, reject, clarify}` (UC-4 поток 5). При `go` — после verdict-блока
downstream formalization стартует (если `gate_passed === true`).

**AskUser-цикл и его граница.** Если перевычисление снова даёт `clarify`,
флоу возвращается к шагу 1 с обновлённым списком вопросов. Цикл ограничен
**малым фиксированным числом итераций (по умолчанию 3)** — тем же бюджетом, что
у Completeness-gate, чтобы не уходить в бесконечный AskUser ping-pong. После
исчерпания бюджета флоу идёт в исход «без ответа» (ниже).

**Исход «спонсор не ответил в пределах сессии» (UC-4 поток 4a) — draft
carry-state.** Если в пределах сессии спонсор не дал ответа (молчит, прервал,
исчерпан бюджет итераций) и override не зафиксирован:

- brief сохраняется со `status: 'draft'` (FR-7: «отсутствие или невалидное
  значение = brief в статусе `draft`») и с **зафиксированными** `[Q-NNN]` в
  `#open-questions` (`status: open`);
- `decision` остаётся `'clarify'`;
- это **carry-state**, а не «зависший»: эпизод возобновляется в следующей
  сессии с теми же вопросами (upsert по `code` восстанавливает контекст);
- **downstream formalization НЕ стартует** — нет spawn'а волны, нет
  dev-задач. Критичные вопросы без ответа и без override = hard-block (UC-4
  постусловие-провал).

**No-silent-pass (NFR-1).** Через флоу **невозможно** тихо проскочить в
formalization с незакрытыми критичными вопросами. Единственные выходы из
`clarify`: (1) ответы подняли coverage до 1.0 на `db.sqlite` **и** дали ≥3
варианта → `go`; (2) спонсор дал данные, показавшие нежизнеспособность →
`reject`; (3) override (но override ≠ обход gate); (4) честный `draft`. Третьего
«автомагического» пути в formalization нет.

**Каскад в saga-mcp.** Каждый merge ответов и каждое перевычисление persist'ит
brief через `artifact_create({ type:'brief' })` upsert — это и есть каскад
`impact:saga-mcp` (re-decision через artifact upsert). Поэтому
`artifact_get(brief)` после любого шага возвращает актуальный decision и
список open-questions.

**Grep markers (NFR-5 observability).** Каждый clarify-прогон оставляет
наблюдаемый след:
- `CLARIFY: questions→sponsor (n=<count>)` — вопросы ушли спонсору (шаг 3);
- `CLARIFY: re-decision → <go|reject|clarify>` — перевычисление (шаг 5);
- `CLARIFY: no answer in session → status=draft (carry-state, open=<count>)` —
  исход «без ответа».

**Проверка (DoD — AC-5).** Два наблюдаемых случая ограничивают поведение:

| # | Setup | Assert |
|---|---|---|
| 1 | `decision=clarify`, спонсор не дал ответа в пределах сессии, override отсутствует | `artifact_get(brief).status === 'draft'` **И** downstream formalization не стартовал (нет spawn'а волны, нет dev-задач); `#open-questions` несёт `[Q-NNN]` со `status: open`; в output есть маркер `CLARIFY: no answer in session → status=draft`. |
| 2 | `decision=clarify`, спонсор ответил через AskUser | ответы влиты в целевые секции (§2/§4/§9), `artifact_get(brief).decision ∈ {go, reject, clarify}` после перевычисления; `[Q-NNN]` со `status: answered`; в output есть маркер `CLARIFY: re-decision → <…>`. |

<!-- SCAFFOLD END — no content/logic below this line. Body-tasks fill sections above in place. -->
