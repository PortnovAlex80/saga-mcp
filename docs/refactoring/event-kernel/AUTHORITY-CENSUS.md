# WP-01 Authority Census — every reader and writer of every conveyor fact

**Work package:** WP-01 (EK-1) — authority reader/writer census.
**Base SHA:** `21ba0816e38ec1492b3acb4d21e7ccea49c6f5df` (branch `ek1/wp01-census`).
**Machine artifact:** `docs/refactoring/event-kernel/authority-census.json`
(validated closed-vocabulary by
`docs/refactoring/event-kernel/tools/validate-census.mjs` — see
"Reproduction").
**Addendum (WP-01b, operator review item 7):** the non-SQL authority surfaces
(filesystem writes, process control, environment variables, in-memory
singletons, network/IPC) are machine-enumerated in
`docs/refactoring/event-kernel/authority-census-nonsql.json` — see §11.
**Role:** specification/analysis only. No production file under `src/**` was
modified, and no behavior changed.

---

## 1. Method — complete statements, not grep

The predecessor's Phase-3.3 scan (2026-08-25) parsed 1344 SQL literals to
verify the sealed ADR-053 material path. This census re-scans the EK-0 base
tree and goes deliberately broader: **every table, every verb, every writer
and reader enumerated, plus the WP-16 admission inputs** (role-resolution and
prompt/context assembly sites).

Mechanics (`docs/refactoring/event-kernel/tools/sql-literal-scanner.mjs`):

- a character-level lexer walks every file under `src/**`,
  `tracker-view/*.mjs` and `scripts/*.mjs`, extracting **complete** string and
  template literals (escape-aware; `${...}` substitutions captured as
  placeholders with their inner expression re-lexed, so SQL built through
  template concatenation is still attributed);
- literals carrying SQL are split into **complete statements** on top-level
  semicolons with SQL-quote and comment awareness;
- each statement is classified by verb (`SELECT` / `WITH_*` / `INSERT` /
  `UPDATE` / `DELETE` / DDL), by tables read and written, and by
  authority-selection markers: descending chronology (`ORDER BY ... DESC`),
  `MAX(...)`/`MIN(...)` aggregates, `LIMIT 1`, task-status predicates,
  execution-state predicates, `latest`/`newest` tokens and window ranking;
- repository-call attribution is file-level: each SQL statement belongs to a
  module, and the module's position relative to the table's owning repository
  decides writer disposition (see §4).

Scan totals on the base tree:

| Metric | Count |
|---|---|
| files scanned (src + tracker-view + scripts) | 563 |
| complete SQL statements parsed | 1802 |
| distinct tables with runtime access | 124 (of 129 declared; remainder inert — §6) |
| writer statements enumerated + classified | 524 |
| reader statements enumerated + classified | 1486 (1113 decision-path, 373 presentation) |
| authority-marker uses classified | 449 (128 DELETE / 207 AUTHORITATIVE / 114 DIAGNOSTIC) |

## 2. Classification semantics (closed vocabulary)

Every classification draws from a fixed enum recorded in the JSON
(`enums` + `classificationSemantics`):

- **AUTHORITATIVE** — a lawful current-authority access: exact-key reads of
  the owning aggregate, exact live-execution fence checks, the owner reading
  its own state machine, and owner-internal monotonic counter allocation
  (`COALESCE(MAX(ordinal),0)+1`, CAS-fence bumps). These move into the target
  owner commands.
- **DIAGNOSTIC** — presentation/telemetry only (operator lists, dashboards,
  logs, the MCP query surface). May explain authority; may never authorize.
- **DELETE** — the access selects or mutates authority through a channel the
  target model removes: task-status scheduling, projection-derived dependency
  state, newest-row-wins/recency selection of current state, MAX(id) adoption
  of run identity, direct writes to an aggregate outside its repository.

Disposition (what EK does with the site): **retain-and-move** (fact + owning
repository survive into the new kernel), **rewrite** (re-expressed: recency →
exact revision; direct SQL writer → typed owning command; journal →
event + obligation), **delete** (removed with the legacy composition at
EK-8).

Writer dispositions across the tree: 171 retain-and-move / 256 rewrite /
97 delete. Reader classes: 829 AUTHORITATIVE / 376 DIAGNOSTIC /
281 DELETE.

## 3. Headline findings

1. **All five ADR-097 violations are present at the base SHA** (pre-classified
   in `predecessorInputs.adr097Violations`): the task-status read that seeds
   authoritative Workplace state (`src/application/conveyor-runtime.ts:404`),
   task-status admission (`src/lifecycle/work-assignment-core.ts`, admission
   statement recorded at `:464`, predicate at `:483-503`), task-row dependency
   readiness with direct block/unblock (`src/tools/tasks.ts:322-376`), the
   lossy `done|failed|cancelled → done` projection map
   (`src/infrastructure/projections/workplace-projector.ts:66-75`), and
   `status='done'` generation/progress decisions
   (`src/infrastructure/persistence/sqlite-factory-runtime-repositories.ts:167-303`).
2. **Violation 6 (second writers) is larger than the ADR list**: beside the
   four external `factory_workplaces` writers the ADR names (lifecycle
   burial, operator soft-stop, Development supersession, settlement drain),
   `scripts/restore-from-checkpoint.mjs` is the broadest direct-SQL recovery
   surface in the tree — it INSERTs/UPDATEs `factory_workplaces`,
   `worker_executions`, `factory_lifecycle_runs` and DELETEs
   `factory_transition_obligations` and `factory_accepted_authority_head`
   rows (restore-by-row-rewrite, not by events). All classified rewrite.
3. **The tasks table is the single largest authority defect**: 64 writer
   statements across 26 files (16 sanctioned by the
   `tests/lifecycle/architecture.test.mjs` ratchet — the "growing writer
   list" ADR-097 finding 7), 190 reader statements, 73 DELETE-class
   projection touches on decision paths. Disposition of every `tasks` writer:
   delete (the scheduling projection dies at EK-7); the immutable sealed
   graph tables (`factory_workplace_graphs/items/dependencies`) are the
   planning facts that retain-and-move as WorkItem/WorkItemDependency.
4. **Recency selection is systemic, not residual**: 128 DELETE-class marker
   uses concentrate in workitem-task (73), execution-attempt (28), material
   (28), project-order-run (25) and process (18) families. The
   `factory-start.ts` resume/adoption path selects run identity by MAX(id)
   joins (`:316`, `:760`) — authority by maximum ID, exactly the EK-1
   prohibited class.
5. **The obligation ledger is real but narrow**: `factory_transition_obligations`
   has exactly one production writer family (the ledger, 11 statements, plus
   an operator-soft-stop release) and 3 reader files — the EC-8 five-handoff
   integrator. The EK target generalizes this substrate to every cross-owner
   edge; the census confirms the substrate exists, is fenced, and has no
   rogue writers.
6. **Owner-internal counter allocation is lawful and distinguishable**: 207
   AUTHORITATIVE marker uses include stage/effect/protocol ordinal+attempt
   allocators and CAS-fence bumps inside owning repositories — the census
   separates these (rule 4/4b) from genuine newest-row-wins selection, which
   is the class EK deletes.

## 4. Fact families (16 records; full detail in the JSON `factFamilies`)

| Family | Tables | Writers | Readers (decision) | Disposition | Target owner |
|---|---:|---:|---:|---|---|
| project-order-run | 14 | 127 | 273 (138) | rewrite | FactoryRun + ProtocolMetadata |
| lifecycle | 5 | 40 | 87 (61) | rewrite | LifecycleRun aggregate |
| stage | 3 | 13 | 49 (44) | rewrite | StageRun aggregate |
| process | 9 | 31 | 105 (96) | rewrite | ProcessRun aggregate |
| node | 3 | 10 | 40 (33) | rewrite | NodeRun aggregate; WorkIntent immutable |
| workitem-task | 8 | 79 | 223 (155) | **delete** | WorkItem + WorkItemDependency (immutable); KanbanCard projection |
| workplace | 10 | 28 | 92 (83) | retain-and-move | Workplace aggregate (CAS) |
| execution-attempt | 4 | 34 | 110 (91) | retain-and-move | ActivityAttempt (lease/provenance/context counters) |
| material | 29 | 62 | 319 (255) | retain-and-move | WorkplaceProductionRevision / CandidateSet / AcceptedCandidateAuthority chain |
| gate | 5 | 11 | 62 (59) | retain-and-move | GateDecision over exact CandidateSet+CheckPlan |
| effect | 5 | 12 | 23 (23) | retain-and-move | EffectReceipt (idempotent) |
| terminal-acceptance | 2 | 3 | 14 (13) | retain-and-move | TerminalProof |
| obligation | 4 | 18 | 16 (16) | retain-and-move | TransitionObligation (core target mechanism) |
| recovery | 12 | 18 | 26 (24) | rewrite | obligations + TypedWait over owning aggregates |
| checkpoint | 1 | 1 | 4 (4) | rewrite | event-position snapshot + typed restore |
| projection-diagnostic | 8 | 24 | 31 (8) | retain-and-move | rebuildable projections / telemetry |

Each JSON family record carries the full contract: current owner claimed by
documentation, every production writer, decision readers with the decision
each feeds, current linearization point, target owner + command, target
event/obligation/wait/proof, disposition, positive proof and a deliberate
mutation suggestion.

## 5. Pre-classified predecessor inputs (carried, not re-litigated)

- **ADR-097 violations 1–6** — all PRESENT at base (§3.1); classifications
  DELETE/rewrite per site.
- **ADR-053 closure-matrix nine seams** — all nine carried with census class:
  pre-seal SRS newest-row validator; newest brief metadata reads (2 sites);
  newest accepted SRS policy hint; task-local newest rejected-attempt VIEW;
  dormant `listArtifactsForNodeInEpic`; unpinned legacy WorkIntents skipping
  payload-contract validation; in-run latest-row-wins reprojection;
  latest-order launch fallback; `pending@wave-2` placeholder digests. All
  DELETE-class; dispositions rewrite or delete with the legacy paths.
- **Development universe 34/40** (ADR-096 gate item 1 PARTIAL) — recorded as
  the exact EK-13 blocking remainder (6 structural Development residues +
  delivery K4 crash-after-effect + restart idempotent-settlement); imported
  per the EK-0 gate, not re-audited here.
- **Frozen recency allowlist** (12 files, `legacy-allowlist.json` @
  `c33ee9e2`) — census class DELETE for the recency-selection class; the
  files are exactly where EK-2..EK-6 rewrite recency into exact revisions.
- **Sanctioned task-writer set** (16 files) — documented as the ratcheted
  writer list whose existence is ADR-097 finding 7; EK-7 deletes the table.

## 6. Inert and foreign surfaces

- `integration_intents` — declared in the family map with **zero** runtime SQL
  statements in scanned scopes: an inert table (classified, `inert: true`).
- The ten retired Discovery tables named by the predecessor scan exist only
  in old databases (no src DDL, no access): inert history for the deletion
  manifest (WP-04), out of this census's live-access scope.
- `src/helpers/completeness.ts` reads `message`/`part` tables that do not
  exist in the production schema (Discovery analysis over a foreign chat-DB
  shape) — classified DIAGNOSTIC; flagged for the deletion manifest as
  dead-or-tooling surface.

## 7. WP-16 admission inputs

### 7.1 Role-resolution sites (12 records; `roleResolutionSites`)

The production role/skill selection chain today:

1. `skillForTask(task, sourceStatus)` — `src/lifecycle/work-assignment-core.ts:51-71`:
   `tasks.execution_skill`/`review_skill` columns → `skill:`/`review-skill:`/`role:`
   tags → hardcoded `saga-reviewer`/`saga-developer`. The exact task-status/tags
   fallback the CanonicalRoleContract law forbids. DELETE.
2. Claim-time use `work-assignment-core.ts:996` and dispatcher use
   `src/tools/dispatcher.ts:444` (`skillForTask(task, task.status)` — role
   **from task status**). DELETE.
3. `roleFromTask(task, fallbackSkill)` — `tracker-view/claude-runner.mjs:73-78`
   (tags → fallback skill string → `developer`), plus `isReview` from
   `task.status` at `:163-167`. DELETE.
4. `pickLaunchSpecSkillName(launchSpec, isReview)` —
   `tracker-view/claude-runner.mjs:107-116`: pinned-installation skills, but
   the review flag still comes from task status. REWRITE (correct seed,
   wrong input).
5. `resolveExecutionProfile(taskKind)` —
   `src/process-modules/application/execution-profile-resolver.ts:41-95`:
   exact task_kind match over hard-imported modules (allowlisted catalog
   import). REWRITE into the WP-17 contract compiler.
6. `resolveAgentLaunchSpec` —
   `src/process-modules/application/agent-launch-spec.ts`: pinned
   installation + digest verification → role block
   (protocol/semantic/reviewer skills, allowedToolIds). RETAIN-AND-MOVE —
   the closest existing analogue of the target binding path.
7. `ExecutionRouteResolver` —
   `src/application/routing/execution-route-resolver.ts`: provider/model/effort
   selection by declarative route policy. RETAIN-AND-MOVE as
   `executorRoutePolicyRef` (must become the sole authority, evaluated once at
   attempt creation).
8. Replay claim binder role input, worker-launcher status synthesis, and the
   `task.review_skill` review-routing branch (`dispatcher.ts:904-912`) —
   full list with verdicts in the JSON.

### 7.2 Prompt/context assembly sites (10 records; `promptAssemblySites`)

1. `buildPrompt()` — `tracker-view/claude-runner.mjs:140-590`: THE initial
   prompt. Layers: identity block, hard rules, protocol skill inlined,
   semantic/reviewer skill inlined, bounded recovery memory
   (`MAX_INLINE_PREVIOUS_FAILURES=5`), prior-deaths list, recovery-feedback
   loud block, previous-attempt patch pointer, write-authority block, full
   task-projection JSON. The single largest assembler → WP-18 one-assembler +
   cumulative accountant.
2. `SAGA_PROMPT_MAX_BYTES` — `claude-runner.mjs:560-590`: opt-in cap where
   0/unset means **unlimited** (the EK-0-recorded baseline insufficiency).
   REWRITE to mandatory positive-finite PromptBudgetProfile.
3. MCP config (tool schemas) — `claude-runner.mjs:860-963` + spawn flags
   `:1376-1482` (`--strict-mcp-config`, `--allowedTools`, `--disallowedTools`).
4. `structured-context-hook.mjs` — PostToolUse `additionalContext`, bounded
   (4000 chars default, per-block 800, stateVersion dedup, fail-closed `{}`).
   The bounded-hook pattern survives; its output must appear in the exact
   next pre-send receipt.
5. Episodic task recovery memory — `src/lifecycle/task-recovery-memory.ts`
   (attempt_count / previous_failures materialized into mutable task
   metadata): REWRITE to content-addressed references.
6. Process workspace block — `process-execution-workspace.ts` /
   `pinned-workspace-materializer.ts` (the Elite-3 436 KB planner-request
   failure class).
7. Desk provisioning prompt block —
   `src/infrastructure/workers/claude-worker-executor-factory.ts:520-570`.
8. Execution tool catalog — `src/application/execution-tool-catalog.ts`:
   deterministic, contract-derived tool listing (retain-and-move shape).

## 8. Residual risks (also in the JSON)

1. Reader/writer attribution is statement- and file-level; a method-precise
   call graph would refine decision-reader lists without changing any
   classification.
2. Non-SQL authority surfaces were originally carried only qualitatively in
   family records (the WP-01 residual named by operator review item 7). The
   WP-01b addendum (§11) upgrades the five non-SQL surface classes to
   machine-classified rows; the remaining qualitative boundary of that
   addendum is stated precisely in §11.7.
3. Engine supervisor and factory scripts are included as production operator
   surfaces; testbed/bootstrap harness scripts are out of scope (diagnostic
   tooling).
4. WP-16 site lists are complete for the production worker path;
   conformance/test harnesses contain additional test-only role usages.
5. `helpers/completeness.ts` foreign-table reads (see §6) may be dead code;
   WP-04 decides deletion.

## 9. Reproduction

```bash
# standalone tokenizer scan (writes a report; the builder does not depend on it)
node docs/refactoring/event-kernel/tools/sql-literal-scanner.mjs --root . --out .ek-tmp/sql-scan.json

# rebuild the census JSON (self-contained: runs the tokenizer scan itself)
node docs/refactoring/event-kernel/tools/census-builder.mjs

# closed-vocabulary + zero-unclassified gate (re-scans the tree fresh)
node docs/refactoring/event-kernel/tools/validate-census.mjs

# non-SQL addendum (§11): five scripted surface sweeps, self-validating
node docs/refactoring/event-kernel/tools/census-nonsql-builder.mjs
```

The census build is deterministic: two consecutive `census-builder.mjs` runs
produce a byte-identical `authority-census.json`
(sha256 `8088318628f0fd0c03cec19e2846b5df569ba94e2d4ace0dc26fd4d7095b4810` at
the base SHA). The validator re-scans the tree fresh and requires every
table-touch of every complete SQL statement to be enumerated and classified in
the census (2041 table-touch checks at the base SHA), every enum field to draw
from the fixed vocabulary, all 16 family records to carry the full contract
field set, and the predecessor inputs (6 ADR-097 anchors, 9 seams, 34/40,
12-file recency allowlist, 16-file sanctioned writers) plus the WP-16 site
lists to be present. Exit 0 on the base tree.

## 10. Verdict

What is machine-proven at this SHA, jointly by the two artifacts:

1. **SQL surface (this census, `authority-census.json`):** zero unclassified
   SQL readers or writers — every table-touch of every complete SQL statement
   in the scanned scopes is enumerated and classified (2041 fresh-scan
   table-touch checks), across all WP-01 fact families.
2. **Non-SQL surface classes (§11 addendum,
   `authority-census-nonsql.json`):** zero unclassified sites in the five
   scripted classes — filesystem writes (165 rows), process control (131),
   environment variables (71), in-memory singletons (61), network/IPC (163) —
   every sweep hit classified from the closed vocabulary.

What is **not** claimed: method-precise call-graph attribution (statement-
and file-level here); closure- or instance-scoped persistent state beyond the
declared rows of §11.4; the one CLI-supplied dynamic env indirection of
§11.6; and the out-of-scope exclusions of §11.5 (browser client assets,
one-shot script state, frozen constant vocabularies, `dist/` build output).
These boundaries are enumerated, not glossed.

The machine artifact is the EK-1/EK-13 re-runnable baseline: the same
commands must later yield one owner per mutable fact and no unclassified
decision read.

---

## 11. Addendum (WP-01b) — non-SQL authority surfaces, machine-classified

**Work package:** WP-01b (EK-1 stop-gate) — closes operator review item 7:
"census is complete only for found SQL constructs; filesystem, processes,
environment, in-memory state, singletons/caches stayed qualitative —
'zero unclassified authority access' is stronger than the proof."
**Machine artifact:** `docs/refactoring/event-kernel/authority-census-nonsql.json`
**Pipeline (re-runnable):**
`docs/refactoring/event-kernel/tools/census-nonsql-builder.mjs` +
`census-nonsql-overlays.mjs`. The same scopes as the SQL census
(`src/**`, `tracker-view/**`, `scripts/**`, 563 files) are swept by five
scripted extractors; every raw hit is classified by ordered closed-vocabulary
rules; an unmatched hit fails the build with exit 1.

### 11.1 The five classes and their EK target mapping

| Class | Rows | EK target mapping (disposition summary) |
|---|---:|---|
| filesystem-write | 165 | repo/worktree/desk/workspace writes → RepositoryDesk effect-owned commands; package store → installed-manifest content (retain); engine log/heartbeat → supervisor-owned launch markers; journals stay diagnostic |
| process-control | 131 | engine spawn/brake/watchdog → engine supervisor observe-only + typed StartEngine/stop commands; git invocations → RepositoryDesk git effects; worker spawn/termination → ActivityAttempt lifecycle commands |
| env-var | 71 | decision-altering names (41) → pinned build manifest / installed composition / PromptBudgetProfile / route policy; operational names (22) stay host parameters; exported-to-child (8) → per-attempt pinned launch manifest |
| in-memory-singleton | 61 | effect registry + registries → installed-manifest content; composition/DB/route handles → composition-owned; id allocation → aggregate-owned counters |
| network-ipc | 163 | POST write gateways (tracker + docs-graph) → typed kernel ingress; GET routes → diagnostic query surface; LM Studio probe → pinned route policy; hook stdio → bounded hook receipt |

### 11.2 Method

Comment-aware code-line extraction (a char-walk sibling of the SQL scanner's
lexer: comments dropped, string literals preserved, line numbers kept), then
per class:

- **filesystem writes:** every `node:fs` / `node:fs/promises` mutating API,
  attributed through each file's real import bindings (a local helper named
  `truncate` is not an fs write); `openSync` counts only with a write-flag
  literal (`'w'`, `'wx'`, `'a'`, …) on the line.
- **process control:** `child_process` APIs attributed through import
  bindings plus inline `require('node:child_process')` (so `db.exec` never
  matches); OS kill primitives (`process.kill`, `taskkill`, `SIGKILL`) and
  detach markers (`detached: true`, `.unref()`).
- **environment variables:** `process.env.NAME`, dynamic
  `process.env[CONST]` (resolved through a same-file const map),
  helper-mediated reads (a local function indexing `process.env[param]`
  called with a literal), parameterized `env.NAME` loader reads, and
  child-env writes (`childEnv.NAME = …`). One row per NAME with every read
  site attached and an envRole split (41 decision-altering / 22 operational /
  8 exported-to-child).
- **in-memory singletons:** column-0 module-level mutable `let` handles,
  empty mutable `Map`/`Set` containers (generics-aware), class-instance
  singletons, `globalThis` writes; frozen literal-initialized constant
  vocabularies are machine-separated into a per-file aggregate (39 containers
  in 28 files) as non-state.
- **network/IPC:** HTTP servers and every router literal (method+pathname
  pairs in both routers, including method-unspecified branches), server-side
  HTTP clients, spawn `stdio` pipe options, `process.stdin/stdout` surfaces,
  MCP `type:'stdio'` server declarations.

### 11.3 Named surfaces the qualitative census only mentioned — now rows

The process-global effect registry
(`src/process-modules/application/post-acceptance-effects.ts:313`,
AUTHORITATIVE-WRITE → effect kernel EffectReceipts), the composition-root
handles (`src/app/composition-root.ts:247-249`), the process-global DB handle
(`src/db.ts:16`), the per-runtime DB cache
(`src/worker-executions.ts:118`), the dispatcher's injected route resolver
(`src/tools/dispatcher.ts:53` — the WP-16 site-7 spawn-side authority), the
in-process execution-id counter
(`src/process-modules/application/execution-context-assembler.ts:436`,
AUTHORITATIVE-WRITE → aggregate-owned counter), the workshop binding cache,
the supervision single-flight guard, and the LM Studio route-table state.

### 11.4 Sweep boundary: closure- and instance-scoped state

The singleton sweep is column-0 (module level). Persistent state hidden in
closures or instance fields is enumerated **by declaration** (rows with
`origin: "declared"`): the LM Studio model/online state
(`tracker-view/model-management.mjs:162-163`), the worker-launcher
reservation→pid idempotency map
(`src/infrastructure/workers/claude-worker-launcher.ts:37`), and the engine
administration liveness cache
(`src/infrastructure/engine/engine-administration.ts:73`). Beyond these
declared rows, undiscovered closure state remains the one qualitative
residue of this class; the EK-8 legacy-zero ratchet still owns the final
check.

### 11.5 Closed exclusions (reviewable, in the JSON `exclusions`)

Browser client assets (embedded `fetch` in HTML templates and `public/*.js`
— client code, relative-URL targets); one-shot script module state; frozen
constant-vocabulary containers (see the per-file aggregate in the JSON);
`dist/` build output (written by the build, not by scanned production
sources; the runtime-consumed `dist/orchestrate-cli.js` spawn target is
covered by the engine-spawn rows and pinned by the EK-11 build digest).

### 11.6 Known dynamic-env residue

Exactly one `process.env[variable]` read whose name is not statically
resolvable: `src/checkpoints/capture-cli.ts:71` (CLI-supplied env
indirection). Recorded in the JSON `unresolvedDynamicEnvReads`, classified as
operator tooling input.

### 11.7 What this addendum does and does not prove

Proven: within the scanned scopes, every swept non-SQL site of the five
classes is enumerated and classified — `counts.unclassified === 0` — and the
build is deterministic (two consecutive runs produce a byte-identical JSON,
sha256 recorded in §11.8). Not proven: completeness for state shapes outside
the sweep grammar (closure/instance state beyond the declared rows), and any
surface outside the three scopes (e.g. `tools/`, ELITE9, host-level
tooling). Those boundaries are stated here rather than absorbed into the
"zero unclassified" claim.

### 11.8 Reproduction

```bash
# rebuild the non-SQL census (self-validating: closed vocabulary + zero unclassified)
node docs/refactoring/event-kernel/tools/census-nonsql-builder.mjs

# raw sweep hits for review
node docs/refactoring/event-kernel/tools/census-nonsql-builder.mjs --dump-sweeps
```

Deterministic: two consecutive runs produce a byte-identical
`authority-census-nonsql.json`
(sha256 `c3077d3d2dc7fd67723e7d5a2c623a30cb1ab44c9750305b31482e8efc65ad22`
at the addendum SHA; base `65e11f1478c3caede383408d5562dc808808645d`). Totals:
165 filesystem-write rows, 131 process-control
rows, 71 env-var rows (49 DECISION-INPUT / 22 DIAGNOSTIC), 61
in-memory-singleton rows, 163 network-ipc rows — 591 classified rows, 0
unclassified.
