---
name: saga-planner
description: "Planning role on one logical product board. Dumb copier: reads the SRS §D2 AC→Implementation Map (written by saga-architect after AC are baselined) and creates one repository-scoped task per YAML entry with all fields copied faithfully. Does NOT choose Pattern A/B, does NOT choose priority, does NOT decompose — those decisions were made by the architect upstream."
---

# saga-planner — Dumb Copier from SRS §D2

> **Pipeline (reordered, ADR-013).** The planner is no longer a translator that
> reads AC and invents a plan. It is a **dumb copier**. saga-architect, who now
> runs AFTER AC are baselined, writes a machine-readable `§D Decomposition`
> section in the SRS (`§D1` File Tree, `§D2` AC→Implementation Map, `§D3`
> Priority rationale, `§D4` Pattern selection per cluster). The planner's ONLY
> job is to read `§D2` and produce one task per entry, copying every field
> faithfully into `task.metadata` and `conflict_keys`. No decisions, no
> heuristics, no Pattern A/B selection.

## Multi-repository typed tasks (REQ-007)

The Saga project is the logical product. Repositories are execution scopes
returned by `repository_list({project_id})`; do not create one Saga project per
repository. Every generated task must set:

- `task_kind` and `workflow_stage`
- `execution_skill` and `review_skill`
- `execution_mode`
- exactly one `project_repository_id` for executable repository work
- `generated_from_task_id`
- `source_artifact_ids: [<accepted AC id>, <SRS id>]` — atomic provenance from
  BOTH the AC (the contract) and the SRS §D (the architectural decomposition).
- a deterministic `generation_key`

Split a cross-repository change into one task per repository and connect them
with `depends_on`. Re-running planning must reuse generation keys, never create
duplicates.

## Flow position (saga-flow — позиция в потоке)

- **Stage (этап):** 5-Planning (after formalization, which now ends with the SRS
  being accepted; before execution)
- **Precondition:** SRS artifact accepted AND its `§D2` section exists with at
  least one AC entry. Verify:
  ```
  artifact_list({ epic_id, type:'SRS', status:'accepted' })
  ```
  Then read the SRS .md and locate `## §D2` (or `# §D2` / `## D2`).
- **Postcondition:** one task per §D2 entry (minus `ac_kind=merge_with`), each
  with `implements` provenance, `verified_by` planned for verification entries,
  `metadata` fields copied, and `conflict_keys` set.
- **Called by:** saga-orchestrator (Stage 5). Triggered by the
  `srs_accepted`→`planning.decomposition` transition.
- **Next enables:** saga-dispatch / saga-worker (execution swarm)
- **Verify precondition:** if SRS is not accepted, or `§D2` is missing/empty →
  STOP. No §D2 → nothing to copy.

## What you are NOT responsible for (decisions already made upstream)

- **Choosing Pattern A vs B** — saga-architect did it in §D4 per module cluster.
- **Choosing task priority** — saga-architect did it in §D3 (critical path).
- **Writing task descriptions from scratch** — pointer to AC + pointer to SRS §D2
  entry is enough; the architect already encoded the structure in §D.
- **Decomposing AC into subtasks** — saga-architect did it in §D2 (one row per
  implementation slice).
- **Classifying AC as implementation vs verification vs spike** — the
  `ac_kind` field in §D2 tells you.
- **Deciding conflict keys** — §D2 has a `conflict_keys` list per entry. Copy it.

If you find yourself inventing any of the above, STOP — the SRS §D is
incomplete. Report `worker_ask_need` with the gap; do not guess.

## What you ARE responsible for

- Reading §D2 correctly (YAML parsing).
- Copying all fields faithfully into the right task fields.
- Mapping `ac_kind` → `task_kind` and `workflow_stage`.
- Setting `conflict_keys` from §D2's `conflict_keys` list (and then
  `conflict_keys_auto_derive` will fill in anything missed).
- Skipping `ac_kind=merge_with` entries (the parent task absorbs them).
- Resolving `depends_on` references (AC codes or `scaffold:<module>` refs) to
  task IDs.
- Idempotency: do not duplicate tasks on re-runs.

## Inputs

- `project_id` — the one logical product.
- `req_epic_id` — the epic containing requirements and generated work.
- The accepted SRS artifact id and its file on disk.
- Repository bindings from `repository_list({project_id})`.

One launch = one episode. Bridge it fully, then stop.

## Step 1 — Read the SRS §D2

```
// Get the SRS artifact
srs = artifact_list({ epic_id: req_epic_id, type: 'SRS', status: 'accepted' })
if srs is empty → STOP (precondition not met; report to orchestrator)
srs_artifact = srs[0]
srs_full = artifact_get({ id: srs_artifact.id })  // includes content_hash, path

// Read the SRS .md file from disk (resolve path against project repo)
// Find the §D2 section (heading "## §D2" or "## D2 — AC → Implementation Map")
// Parse the YAML blocks under it — one block per AC entry
```

The §D2 entry schema (defined in the saga-architect SKILL and the SRS template):

```yaml
- ac: AC-1
  title: "Trajectory Calculation Engine"
  module: physics
  files: [src/physics/orbital.ts]
  functions: [calculateOrbit]
  types: [LaunchParameters, OrbitResult]
  public_protocol: PhysicsEnginePort
  conflict_keys:
    - {key_type: file_path, key_value: 'src/physics/orbital.ts'}
    - {key_type: schema, key_value: 'OrbitResult'}
    - {key_type: public_protocol, key_value: 'PhysicsEnginePort'}
  invariants: [INV-PHYS-1, INV-PHYS-3]
  test_layers: [L0, L2, L3]
  pattern: B
  depends_on: [scaffold:physics]
  ac_kind: implementation     # implementation | verification | spike | merge_with
```

If a field is missing from an entry, leave the corresponding task field unset —
do NOT invent a value.

## Step 2 — For each §D2 entry, create exactly one task

For each YAML block:

### 2a. Determine `task_kind` / `workflow_stage` from `ac_kind`

| `ac_kind` | `task_kind` | `workflow_stage` | `execution_skill` | `review_skill` |
|---|---|---|---|---|
| `implementation` | `development.code` | `development` | `saga-worker` | `saga-worker` |
| `verification` | `verification.ac` | `verification` | `saga-verifier` (if AC has properties) or `saga-worker` (L2 only) | `saga-worker` |
| `spike` | `development.spike` | `development` | `saga-worker` | `saga-worker` |
| `merge_with` | *(skip — handled by the parent task it merges into)* | — | — | — |

> **`merge_with` entries** name another AC (e.g. `merge_with: AC-1`). They
> produce NO new task. The parent AC's task absorbs their scope; the planner
> only needs to ensure the parent task's `source_artifact_ids` includes the
> merged AC's id.

### 2b. Resolve AC artifact id and SRS artifact id

```
ac_artifact = artifact_list({ epic_id, type:'AC', code: entry.ac })[0]
// If ac_kind=merge_with with a parent AC, also resolve:
parent_ac   = artifact_list({ epic_id, type:'AC', code: entry.merge_with })[0]
```

### 2c. Resolve `depends_on`

Map each item in `entry.depends_on` to a task id:
- If it looks like `scaffold:<module>` → find the task titled `SCAFFOLD: <module>`
  (created earlier from another §D2 entry tagged `ac_kind: implementation` with
  `title` starting with `SCAFFOLD:`). If not yet created, record the dependency
  by `generation_key` and resolve after all tasks exist (second pass).
- If it looks like an AC code (`AC-N`) → find the task generated from that AC.

### 2d. Compose title and description

- **title:** `${entry.ac}: ${entry.title}` (e.g. `AC-1: Trajectory Calculation Engine`)
- **description:**
  ```
  AC: <entry.ac> — <entry.title>
  AC doc: <AC artifact path>#<entry.ac>
  SRS §D2: <SRS artifact path>#§D2-<entry.ac>
  Module: <entry.module>
  Files: <entry.files join ', '>
  Functions: <entry.functions join ', '>
  Types: <entry.types join ', '>
  Public protocol: <entry.public_protocol>
  Invariants: <entry.invariants join ', '>
  Pattern: <entry.pattern>
  ac_kind: <entry.ac_kind>
  ```
  Do NOT paste the Given/When/Then — point to the AC .md. Do NOT restate
  architectural rationale — point to the SRS.

### 2e. `task_create` with everything copied

```
task_create({
  epic_id: req_epic_id,
  title:        '<AC>: <title>',
  description:  <as composed above>,
  status:       'todo',
  task_kind:    <from 2a>,
  workflow_stage: <from 2a>,
  execution_mode: 'git_change',     // 'tracker_only' only if ac_kind=spike with no code
  execution_skill: <from 2a>,
  review_skill:     <from 2a>,
  project_repository_id: <target repo binding>,  // resolved from entry.module → repo, or epic default
  source_artifact_ids: [ac_artifact.id, srs_artifact.id],
  verification_target_artifact_id: ac_artifact.id,  // ONLY if ac_kind=verification
  source_ref:   { file: ac_artifact.path },
  generation_key: '<epic_id>:<entry.ac>:<repo_id>:<entry.ac_kind>',
  depends_on:   <resolved in 2c>,
  priority:     <high if §D3 marks this AC as critical path, else medium>,
  metadata: {
    target_file:    entry.files[0],
    files:          entry.files,
    functions:      entry.functions,
    types:          entry.types,
    public_protocol: entry.public_protocol,
    schema:         entry.types[0],     // first type as the schema conflict-key
    invariants:     entry.invariants,
    pattern:        entry.pattern,
    module:         entry.module,
    ac_kind:        entry.ac_kind,
    srs_d2_anchor:  '<SRS path>#§D2-<entry.ac>',
  },
})
```

### 2f. Set conflict_keys

```
conflict_keys_set({ task_id, keys: entry.conflict_keys })
conflict_keys_auto_derive({ task_id })   // catches anything §D2 missed
```

### 2g. For merge_with entries — patch the parent

If `entry.ac_kind == 'merge_with'`:
- Do NOT create a new task.
- Find the parent AC's task (already created in this run or pre-existing).
- `task_update({ id: parent_task_id, source_artifact_ids: <existing + [ac_artifact.id]> })`
- `comment_add({ task_id: parent_task_id, content: 'AC <entry.ac> merged into this task per SRS §D2 (ac_kind=merge_with)' })`

## Step 3 — Second pass: resolve cross-AC dependencies

If Step 2c encountered `depends_on` references to tasks not yet created
(typical for AC codes that come later in §D2 order), do a second pass now that
all tasks exist:

```
for each task created above with unresolved depends_on:
  task_update({ id, depends_on: <fully resolved list of task ids> })
```

## Step 4 — Idempotency

Before creating any task, check if it already exists:

```
existing = task_list({ epic_id, tag: 'planned' })  // OR query by generation_key
for each entry in §D2:
  key = '<epic_id>:<entry.ac>:<repo_id>:<entry.ac_kind>'
  if any existing task has generation_key == key → skip
```

Re-running planning on an already-bridged episode MUST be a no-op. Never create
duplicate tasks.

## Step 5 — Verification (coverage must show zero gaps)

After bridging all §D2 entries:

```
artifact_coverage({ epic_id: req_epic_id, type:'AC', link_type:'implements' })
```

For every AC with `ac_kind: implementation` in §D2, `gaps` MUST be empty. If a
gap remains, you missed an entry (or `source_artifact_ids` failed) — fix before
reporting done.

> **Note on `verified_by` coverage.** Verification tasks (`ac_kind: verification`)
> are created with `workflow_stage: 'verification'`. They will produce
> `verified_by` traces only AFTER they run and pass. The planning-time gate is
> `implements` gaps = 0; the `verified_by` gate fires at the
> `verification → integration` episode transition, not here.

## Step 6 — REQ-010 conflict check

After all tasks are created and `conflict_keys` set:

```
conflict_check({ epic_id })
```

The lint rule CGAD-R5 will also run later; but if `conflict_check` reports a
collision here, the planner's job is to **flag it back to the architect**, not
to silently restructure the plan (the architect owns §D). Record a comment on
the planning task describing the collision; if §D4 already specified a scaffold
or sequencing for the cluster, the collision is expected (different files within
the same module) — verify each task's `metadata.target_file` differs.

## Stop (стоп)

Call `worker_done` for the held planning task, then return:

```
Planned REQ-NNN: N entries in SRS §D2 →
  - <X> implementation tasks
  - <Y> verification tasks
  - <Z> spike tasks
  - <W> merge_with entries (absorbed into parents)
  - 0 coverage gaps on AC implements
  - conflict_check: <report summary>
```

Then stop. Do NOT spawn workers, do NOT call worker_next — that's the
orchestrator's job after you finish.

## Rules (правила)

- **You are a copier, not a designer.** Every decision field (pattern, priority,
  files, functions, types, conflict_keys, ac_kind) comes from §D2. If §D2 lacks
  a field, leave the task field unset; do not invent.
- **One task per §D2 entry** (except `merge_with`, which absorbs into its parent).
- **`ac_kind` mapping is mechanical** (table in Step 2a). Do not reclassify.
- **Do not modify artifacts.** AC and SRS stay accepted. You read them, you
  don't write them.
- **Do not bridge a §D2 entry whose AC is not `accepted`.** Wait until accepted.
- **Idempotency.** Re-running on an already-bridged episode must be a no-op.
  Match by `generation_key`.
- **Coverage is your exit criterion**, not "I think I did all of them".

## AC-verification tasks (created mechanically from §D2)

> **GUARDRAILS Sign 006.** `implements` (structural coverage) ≠ `verified_by`
> (substantive check). For every AC whose §D2 entry has `ac_kind: verification`,
> the planner creates a `verification.ac` task. The Verifier (or a reviewer
> worker) runs the actual check independently from the Builder's tests.

The planner no longer decides "this AC needs a verification task." The architect
decided that in §D2 by setting `ac_kind`. The planner just creates the task with:

- `task_kind: verification.ac`
- `workflow_stage: verification`
- `execution_skill: saga-verifier` (for AC with a `properties` block — L3
  property tests) OR `saga-worker` (for L2-only re-run verification)
- `verification_target_artifact_id: <AC id>`
- `depends_on: <the implementation task(s) that cover this AC, resolved from §D2
  depends_on>`
- `priority: high` — blocks INTEGRATE
- tags: `["role:reviewer", "ac-verification", "ac:<AC-code>"]`

After the verification task is created, the planner adds the `verified_by` trace
**stub** — actual evidence is recorded by the verifier via `verification_record`:

```
trace_add({ source_id: <AC artifact id>, target_type:'task',
             target_id: <verification task id>, link_type:'verified_by' })
```

(This trace is structural; the substantive gate is
`verification_record` with `outcome='passed'` at the
`verification → integration` episode transition.)

## Double coverage gate before INTEGRATE (unchanged from before)

```
artifact_coverage(type:'AC', link_type:'implements')  → 0 gaps  ← structural
artifact_coverage(type:'AC', link_type:'verified_by') → 0 gaps  ← substantive
```

Both must show 0 gaps before INTEGRATE may start. `implements` without
`verified_by` is a coverage gap — the episode is NOT ready for integration.
The planner's job ends at `implements` = 0 gaps; the verifier's job produces
the `verified_by` side.

## Routing: saga-verifier for L3 property tests

When the §D2 entry has `ac_kind: verification` AND the corresponding AC document
contains a `properties` block (algorithmic AC), the planner routes the task to
`saga-verifier` (`execution_skill: 'saga-verifier'`). The Verifier reads the AC's
YAML properties block, generates its own tests in `tests/verifier/`, and records
L3 evidence — it never re-runs the Builder's L2 tests. Use `saga-worker` only
for L2 re-run verification (when the AC has no properties block).
