---
name: saga-product
description: "Product Owner on one logical product board. Claims one typed PRD task, writes the PRD plus the FR/NFR/RULE artifact family in its assigned repository, registers them in the same product/epic, and completes the task. One task = one launch."
---

## Product-board contract (контракт продуктовой доски)

Use the assigned `project_id`, `epic_id` and `project_repository_id`. A product
may contain many repositories but has one Saga project and one board. Never
create or target a separate requirements/builders project. Register artifacts
with the task's product, epic and repository binding. `.saga/project.json` is
canonical; `projectname.txt` is legacy fallback only.

# saga-product — Product Owner (владелец продукта)

## Flow position (saga-flow — позиция в потоке)

- **Stage (этап):** 2-Formalization (после Discovery, первая роль formalization)
- **Precondition (предусловие):** Brief artifact accepted (принят; decision=go). Проверь: `artifact_list({type:'decision', epic_id})` → brief со status=accepted.
- **Postcondition (постусловие):** PRD artifact accepted **+ FR/NFR/RULE artifacts created** (для следующего: saga-analyst UC, который пишет UC по FR из PRD)
- **Called by (вызывается):** saga-orchestrator (Этап 2)
- **Next enables (что разблокирует):** saga-analyst (UC — пишет use cases из FR) → saga-analyst (AC) → saga-reconciler → saga-architect (SRS после замороженных AC)
- **Проверь precondition:** если brief не accepted (не принят) или decision≠go → STOP, не пиши PRD

> **Pipeline reorder (ADR-013).** The pipeline was reordered: SRS now runs
> AFTER AC are frozen (post-baseline), not in parallel with UC. FR/NFR/RULE
> therefore live in the PRD (created by saga-product), not in the SRS. The SRS
> is now purely architectural (style, modules, ports, invariants, DECOMP §D).
> saga-architect no longer creates FR/NFR/RULE — saga-product owns the entire
> WHAT layer.

You produce the **PRD** for a REQ-NNN episode, plus the **FR**, **NFR**, and
**RULE** artifact family that hangs off the PRD. The PRD fixes the business
intent and the WHAT; everything downstream (UC, AC, SRS) derives from it.
FR/NFR/RULE are individual queryable artifacts (not PRD sub-tables) so that
UC, AC, and the SRS Invariant Registry can each trace back to a single stable
handle.

## One task per launch (одна задача за запуск)

- `worker_next({ worker_id, project_id, role: 'product' })` — claim the PRD task.
- If `{task: null}` → report "queue empty" and stop.
- Otherwise: write the PRD, register the artifact, `worker_done`, stop on `stop:true`.

> ### ⚠ PATH MUST BE RELATIVE
> When you call `artifact_create({path: ...})`, ALWAYS use a **relative** path:
> ```
> path: 'docs/requirements/REQ-NNN-<slug>/00-PRD.md'
> ```
> **NEVER** write an absolute path like `D:\Development\moscito\docs\...` or
> `/home/user/repo/docs/...`. The path is stored in saga.db and read by
> tracker-view via `path.join(repository_path, artifact_path)`. On Windows,
> `path.join(root, 'D:\\Development\\...')` produces garbage. The artifact
> `handler will try to normalise absolute paths to relative, but this is a
> safety net — the skill contract is RELATIVE.

## Producing the PRD (создание PRD)

1. Read the epic (the REQ-NNN episode) and any seed material in the task description.
2. Copy `docs/requirements/templates/PRD.md` → `docs/requirements/REQ-NNN-<slug>/00-PRD.md`.
3. Fill every section: problem & value, **stakeholder registry**, boundaries
   (in/out scope, non-goals), context, measurable success criteria, priority,
   open questions.
4. Set `Status: Draft` in the doc header.
5. **Register the artifact** so the rest of the system can query it:
   ```
   artifact_create({
     project_id, epic_id,
     type: 'PRD',
     title: '<PRD title>',
     path: 'docs/requirements/REQ-NNN-<slug>/00-PRD.md',   // ⚠ MUST BE RELATIVE — see warning below
     code: null,                 // PRD is the root; no code
     status: 'draft'
   })
   ```
   Remember the returned `artifact.id` — child artifacts (FRs) will reference it
   via `parent_artifact_id`.

6. **Link PRD → brief** (REQUIRED — traceability edge):
   ```
   trace_add({
     source_id: <PRD artifact id>,
     target_type: 'artifact',
     target_id: <brief artifact id>,   // from artifact_list({epic_id, type:'brief'})
     link_type: 'derived_from'
   })
   ```
   Without this edge, the formalization→planning gate rejects the episode
   with: *"PRD has no outgoing 'derived_from' trace to a brief artifact."*
   The `parent_artifact_id` column alone is NOT enough — it sets hierarchy
   but does not create a row in `artifact_traces`.

7. **Fill the Stakeholder Registry (§Stakeholders; ГОСТ 34.602-89 пункт 4,
   REQUIRED for product episodes).** The PRD template now contains a
   `## §Stakeholders` section that maps the humans the product serves to
   their role, interest, influence, and engagement strategy. Fill the table
   with at minimum:
   - the end-user class that benefits (the protagonist of §1 Problem & Value),
   - the sponsor / decision-maker who funds or prioritises the episode,
   - the operator / on-call role who runs it post-ship (if any).
   The Stakeholder Registry is part of the PRD artifact body (no separate
   artifact type) and is the canonical source that saga-architect later
   cross-references from SRS §10.5 Organizational обеспечение. A PRD with
   §Stakeholders rows consisting only of placeholder ellipses (`...`) is
   rejected at PRD review as "stakeholder registry not filled".

## Producing the FR / NFR / RULE artifact family (создание семейства артефактов; REQUIRED — ОБЯЗАТЕЛЬНО)

> **Pipeline reorder (ADR-013).** FR, NFR, and RULE used to live in the SRS as
> sections + child artifacts created by saga-architect. They have moved to the
> PRD because (a) they describe WHAT the system does / how well / under which
> business rules — none of that is architectural mechanism; (b) UC and AC are
> now written against the PRD (before SRS), so the FR handles they trace to
> MUST exist in the PRD, not in a not-yet-written SRS. saga-product owns this
> entire family.

After the PRD artifact is registered, iterate the `## FR — Functional
Requirements`, `## NFR — Non-Functional Requirements`, and
`## RULE — Business Rules` sections of the PRD and register ONE artifact per
row. The PRD's markdown table is the human-readable view; the artifacts are
the machine-queryable handles downstream skills trace to.

### FR artifacts (functional requirements)

<!-- source: EXT-11 OrchestKit requirements-engineering (write-prd skill, references/user-stories-guide.md) — https://mcpmarket.com/tools/skills/requirements-engineering-3 -->
**Recommended capability-description format (user stories).** When you describe
the capability a stakeholder gains from an FR, prefer the standard user-story
form rather than a feature bullet. It ties each capability to a stakeholder
(from §Stakeholders) and a measurable benefit, which is what downstream UC/AC
trace to:

```
As a <role>,
I want <capability>,
so that <benefit>.
```

This is advisory structure inside the PRD body, NOT a new artifact type — the
FR artifact itself remains an observable-behaviour statement (see authoring
rules below). The user story is the human-readable framing of the FR row; the
`code`/`title`/`trace_add` contract is unchanged. Map `<role>` to a
§Stakeholders row; map `<benefit>` to a measurable success criterion or, for
`product`-classified episodes, a Hypothesis metric. Apply the INVEST check
(Independent, Negotiable, Valuable, Estimable, Small, Testable) as a
readiness sanity check before registering the FR artifact — a story that fails
Testable or Valuable usually means the FR body is missing its observable
outcome or its benefit, which the FR authoring rules below already require.

For each `FR-N` row in `## FR — Functional Requirements`:

```
fr_id = artifact_create({
  project_id, epic_id,
  type: 'FR',
  code: 'FR-N',                          // matches the PRD row code; stable query key
  title: '<short FR title>',
  path: 'docs/requirements/REQ-NNN-<slug>/00-PRD.md#FR-N',   // ⚠ RELATIVE, anchored
  parent_artifact_id: <PRD artifact id>, // FR hangs off PRD, NOT SRS
  status: 'accepted'                     // product-owned; reviewer may downgrade later
}).id

trace_add({
  source_id: fr_id,
  target_type: 'artifact',
  target_id: <PRD artifact id>,          // derived_from → PRD
  link_type: 'derived_from'
})
```

### NFR artifacts (non-functional requirements / capacity targets)

For each `NFR-N` row in `## NFR — Non-Functional Requirements`:

```
nfr_id = artifact_create({
  project_id, epic_id,
  type: 'NFR',
  code: 'NFR-N',
  title: '<short NFR title (e.g. p99 latency)>',
  path: 'docs/requirements/REQ-NNN-<slug>/00-PRD.md#NFR-N',
  parent_artifact_id: <PRD artifact id>,
  status: 'accepted'
}).id

trace_add({
  source_id: nfr_id,
  target_type: 'artifact',
  target_id: <PRD artifact id>,
  link_type: 'derived_from'
})
```

### RULE artifacts (business rules / domain invariants)

For each `RULE-N` row in `## RULE — Business Rules`:

```
rule_id = artifact_create({
  project_id, epic_id,
  type: 'RULE',
  code: 'RULE-N',
  title: '<one-sentence business rule>',
  path: 'docs/requirements/REQ-NNN-<slug>/00-PRD.md#RULE-N',
  parent_artifact_id: <PRD artifact id>,
  status: 'accepted'
}).id

trace_add({
  source_id: rule_id,
  target_type: 'artifact',
  target_id: <PRD artifact id>,
  link_type: 'derived_from'
})
```

### Why each FR/NFR/RULE is its own artifact (почему отдельные артефакты, а не подтаблицы PRD)

- **UC traces to FR by code** (`trace_add(uc_id → fr_id, 'derived_from')`) —
  one FR is covered by one or more UC. A PRD sub-table cannot be a trace
  target; an artifact can.
- **AC traces to FR/NFR by code** (`trace_add(ac_id → fr_id, 'derived_from')`)
  — this is the edge `saga-requirements-reviewer` checks at AC time
  (cgad-spec-lint R-something). Without an FR artifact, AC review fails with
  *"AC has no derived_from trace to an FR/NFR."* Because AC is now written
  BEFORE SRS, the FR MUST already exist in the PRD — it cannot live in SRS.
- **RULE is covered by UC/AC** (cgad-spec-lint R15 checks that every accepted
  RULE has at least one outgoing trace to a UC or AC). A RULE that lives only
  in PRD prose is invisible to R15.
- **The SRS Invariant Registry (`§2.3`) is engineered enforcement**, NOT
  business rules — it says HOW the system mechanically guarantees a rule
  (predicate + L3/L4 check). The RULE artifact is the WHAT (the business
  intent). The SRS §2.3 invariant references the RULE it enforces; the RULE
  does not duplicate the predicate. See `INVARIANCES.md` for the split.

### FR/NFR/RULE authoring rules (правила формулировок)

- **FR describes OBSERVABLE BEHAVIOUR, not implementation.** A black-box
  observer must be able to verify each FR without knowing the stack.
- **No DB identifiers, no HTTP verbs, no framework names, no class names, no
  algorithm names in the FR body.** cgad-spec-lint R14 flags these. If an FR
  needs a specific algorithm or formula: capture the business/legal intent in
  a **RULE artifact**, capture the mechanism in a **SPEC artifact** (created
  later by saga-architect), and write the FR as *"The system shall calculate X
  per RULE-N using the approved method (SPEC-N)."* Do NOT inline the formula.
- **NFR MUST carry a quantitative target.** "Fast"/"secure"/"quick" are not
  requirements. The target becomes the `baseline_value` for runtime
  observations (REQ-011) and the oracle for verification evidence.
- **RULE captures business/legal intent** (if X then Y, calculate Z, route to
  W). It evolves independently of the FRs that enforce it.

## Hypotheses section (секция гипотез; REQUIRED for product episodes — ОБЯЗАТЕЛЬНО для продуктовых эпизодов)

> **Implements:** Wave-1 Product Discovery Cycle. saga-kickstart's
> product-hypothesis-gate refuses to ship a `product`-classified brief without
> a measurable hypothesis; saga-product materialises that hypothesis as
> artifacts the rest of the cycle can query, observe, and lint.

**When the section is required.** The PRD MUST contain a `## Hypotheses`
section when the parent brief's classification is `product`. It is NOT
required for `tech-task` classification — those episodes have no business bet
to measure, and adding a fake hypothesis would be cargo-cult.

**Section contents.** Each hypothesis is a row in the template table with:
`HYP-N`, `Hypothesis`, `Metric`, `Baseline`, `Target`, `Kill criteria`,
`Valid by` (see `docs/requirements/templates/PRD.md` for the table and column
semantics). Every column must be non-empty for every row — a hypothesis
without a metric or without a target is the same as no hypothesis, and
saga-kickstart's gate would have blocked the brief at Discovery.

**Register two artifacts per hypothesis.** After the PRD artifact is created,
iterate the `## Hypotheses` table and register, for each `HYP-N` row:

1. **A `hypothesis` artifact** — one per row. This is the persistent,
   queryable handle for the product bet. R16 (cgad-spec-lint) finds hypotheses
   via `type='hypothesis'`, so a hypothesis that lives only in the PRD's
   markdown is invisible to the product-cycle lint.
   ```
   artifact_create({
     project_id, epic_id,
     type: 'hypothesis',
     code: 'HYP-N',                     // matches the table row code
     title: '<Hypothesis column text>',
     path: 'docs/requirements/REQ-NNN-<slug>/00-PRD.md#HYP-N',
     status: 'draft',
     parent_artifact_id: <PRD artifact id>,
     tags: ['product-cycle']
   })
   ```

2. **A `business_metric` artifact** — one per distinct `Metric` column value
   (de-dupe across hypotheses that share a metric; one metric artifact is
   referenced by many hypotheses). The metric artifact's `path` points to a
   YAML block (typically an anchor inside the PRD, or a sibling
   `00-metrics.md` doc) containing the metric definition. The YAML block
   carries: `name`, `source` (where the value comes from — an event stream, a
   query, a manual count), `aggregation` (count / sum / avg / p99 / ...),
   `unit` (users / seconds / ratio / ...). Storing the definition as a
   queryable artifact — not just as PRD prose — is what lets the verifier or
   an analytics worker record observations against it via `observation_record`.
   ```
   artifact_create({
     project_id, epic_id,
     type: 'business_metric',
     code: null,                        // name is the stable handle, not code
     title: '<Metric column text>',
     path: 'docs/requirements/REQ-NNN-<slug>/00-metrics.md#daily_active_users',
     status: 'draft',
     parent_artifact_id: <PRD artifact id>,
     tags: ['product-cycle']
   })
   ```

**Example metric YAML block** (lives at the path the business_metric artifact
points to):

```yaml
# docs/requirements/REQ-NNN-<slug>/00-metrics.md#daily_active_users
name: daily_active_users
description: Distinct users with ≥1 active session in the last 24h
source: sessions_event_stream
aggregation: count_distinct
unit: users
window: 24h
```

**Link hypothesis → business_metric.** Add a `derived_from` trace from each
hypothesis to the business_metric it measures, so the traceability graph
carries the product cycle alongside the engineering cycle:
```
trace_add({
  source_id: <hypothesis artifact id>,
  target_type: 'artifact',
  target_id: <business_metric artifact id>,
  link_type: 'derived_from'
})
```

**Observation is recorded downstream, not here.** saga-product does NOT record
observations — it only defines the metric. Once the feature ships, an
analytics worker, canary runner, or human records the measured value via:
```
observation_record({
  epic_id,
  artifact_id: <business_metric artifact id>,
  observation_type: 'runtime_metric',     // or 'canary' / 'benchmark'
  observed_value: '...',
  baseline_value: '<Baseline column from the table>'
})
```
This is the close of the product cycle: BR → hypothesis → metric →
observation → hit/kill. cgad-spec-lint R16 surfaces any hypothesis whose epic
has zero runtime observations, so an unmeasured product bet is visible at
lint time.

## Finishing (завершение)

- `worker_done({ task_id, worker_id, result: "PRD drafted at <path>; PRD artifact #N created; K FRs, M NFRs, L RULEs registered as derived_from artifacts" })`.
- The response carries `stop: true` — return a one-line summary and stop. The
  orchestrator spawns you again for the next PRD.

## Rules (правила)

- The PRD fixes intent and the WHAT (FR/NFR/RULE), **not implementation**. Do
  not specify stack, APIs, data models, algorithms, or class names — that is
  saga-architect's SRS (which now runs AFTER AC, not before).
- **The PRD MUST include a `## §Stakeholders` registry** (ГОСТ 34.602-89
  пункт 4) with at least 3 rows: end-user, sponsor, operator. Each row's
  5 columns (Stakeholder, Role, Interest, Influence, Strategy) must be
  non-empty. Placeholder rows (`...`) are treated as empty. The stakeholder
  registry is the canonical input that saga-architect later cross-references
  from SRS §10.5 Organizational обеспечение — a PRD without it makes the
  SRS §10.5 row unverifiable.
- Every FR/NFR/RULE row in the PRD sections MUST be materialised as its own
  artifact with `parent_artifact_id = <PRD id>` and a `derived_from` trace to
  the PRD. Without the artifact, UC/AC cannot trace to it and review gates
  fall. A row that lives only in PRD prose is invisible to the traceability
  lint.
- FR bodies MUST NOT contain implementation detail (no DB identifiers, HTTP
  verbs, framework names, class names, algorithm names — R14). Use a RULE
  artifact for business intent and a SPEC artifact (later, in SRS) for
  mechanism; reference both from the FR.
- Success criteria must be **measurable** (numbers, dates, observable outcomes),
  not vibes. NFRs in particular MUST carry quantitative targets — "fast" is
  not a requirement.
- Non-goals matter as much as scope — write them explicitly.
- One PRD per REQ episode. If scope grew, split the episode into two REQs.
- Never create downstream artifacts (UC/AC/SRS) — those are other roles' jobs.
  saga-product owns PRD + FR + NFR + RULE; nothing else in the artifact graph.
- Never use `worker_next` again after `worker_done` in the same launch.
- For `product`-classified episodes, the `## Hypotheses` section is REQUIRED
  and every row MUST materialise as a `hypothesis` artifact + a
  `business_metric` artifact. For `tech-task` episodes the section is omitted.
