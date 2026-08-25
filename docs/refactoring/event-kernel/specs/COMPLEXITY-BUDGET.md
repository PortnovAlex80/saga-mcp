# EK-1 Complexity Budget — the conjunctive successor-admission envelope (WP-16 part 1)

- **Work package:** WP-16, part 1 of 3 (specification author). This author is
  forbidden from later implementing WP-05, WP-17 or WP-18 (plan role rule).
- **Integration base SHA:** `21ba0816e38ec1492b3acb4d21e7ccea49c6f5df`
- **Branch:** `ek1/wp16-complexity-budget`
- **Budget revision:** **rev3** (`ek1/fix-complexity-residual-dims`, branched
  from `ek1/fix-complexity-measurer` @ `ef774386`, EK-1 stop-gate follow-up):
  the eight census-frozen dimensions left residual by rev2 (§7 item 4) are
  re-bound to successor-tree measurements via a new
  `kernelCompositionConvention` block — the same lawful/predecessor-mode
  discipline rev2 applied to the three SQL dimensions. Recorded in the budget
  JSON `revisions` array. Rev2 (`ek1/fix-complexity-measurer`, operator review
  items 3 + 4): (a) the three SQL-counting authority dimensions split into
  **lawful vs bypass** columns with a spec-frozen lawful-owner convention
  (`lawfulRepositoryConvention` in the budget JSON); (b)
  `structure.phaseCount` / `structure.topLevelPackageCount` changed from
  EXACT to MAXIMUM per the plan's own wording "capped at".
- **Machine artifact:** [`complexity-budget.json`](./complexity-budget.json)
  (36 dimensions, each with baseline, finite target, deterministic measurement
  command, rationale and accountable work package)
- **Measurement driver:** [`measure-complexity.mjs`](./measure-complexity.mjs)
- **Status:** FROZEN-CANDIDATE. Freezing completes in WP-16 part 3
  (`npm run validate:ek-admission-specs`, mutation corpus, independent-verifier
  receipt, `admissionContractDigest`). Any later semantic change reopens EK-1.

## 1. What this envelope is

The plan's law ("Bounded successor complexity"): *EK-1 must freeze a
machine-readable, conjunctive complexity envelope before EK-2 changes
production code. A single weighted score, line-count target or prose claim is
not an envelope: every dimension must pass independently.*

This budget is that envelope. Properties:

- **Conjunctive:** 36 dimensions; the tree passes only if every dimension
  passes. No weights, no compensations, no aggregate score.
- **Finite:** every target is a finite number or a closed string set
  (`max`, `exact`, `closed-set`, `subset-of-frozen`, `zero-after-phase`).
  Unbounded targets and waivers are structurally rejected by the driver.
- **No waivers.** `waivers.active = 0` and the validator rejects any nonzero
  value. Widening a target reopens EK-1 and invalidates downstream
  qualification evidence; tightening is allowed as a new budget revision.
- **The baseline is diagnostic, not an entitlement.** Predecessor numbers cite
  the WP-01 census and the frozen universe; they justify targets, never cap
  the successor at predecessor complexity.

## 2. Frozen inputs (read-only, digest-verified)

The budget and driver are self-contained via [`frozen-inputs/`](./frozen-inputs/)
(byte-copies; see [`FROZEN-INPUTS.json`](./frozen-inputs/FROZEN-INPUTS.json)):

| input | source | sha256 |
|---|---|---|
| `authority-census.json` | `ek1/wp01-census` @ `eaa07093` | `80883186…4810` |
| `transition-universe.json` | `ek1/graph-reconciliation` @ `d41cebe0` | `6429c8b7…f84` |
| `PROTOCOL-DECISIONS-FROZEN.md` | `integration/event-kernel-ek` @ `33bf1976` | `1f2275c9…a51` |

Every driver run re-verifies these digests and fails loudly on mismatch
(`FROZEN_INPUT_DIGEST_MISMATCH`). Editing a frozen artifact is an ABORT
condition, never a sync task. The universe numbers below already include the
twelve frozen protocol decisions D1–D12 (all adopted as recommended).

## 3. Dimension inventory (baseline → target)

### 3.1 Authority (census-grounded)

| id | baseline (census) | target | WP |
|---|---|---|---|
| `authority.mutableOwnerFanInFiles` | **25** writer files on one table (`tasks`; 64 writer statements) | max **1** writer module per mutable aggregate — successor binding (rev3): maximum per-aggregate distinct direct-SQL writer files in the live scan | WP-06 |
| `authority.mutableOwnerAggregates` | **16** fact families / 124 accessed tables, mixed ownership | exact **13** authority kinds (9 owner aggregates + 4 non-aggregate authorities, frozen universe) — successor binding (rev3): persistence `*-repository.ts` files + `authority:<Name>` literals in the declaration scope | WP-05 |
| `authority.authoritativeRelationKinds` | **1** generic obligation substrate (narrow, EC-8 only) | exact **22** — the plan's Target logical model relations (rev3; previously 54 = the 49 obligation + 5 wait kinds, which stay pinned by their own protocol dimensions) | WP-05 |
| `authority.decisionReaderStatements` | **1113** decision-path reads, all direct SQL — pre-kernel split: **bypass 1113 / lawful 0** (829 AUTH / 281 DELETE / 373 presentation overall) | max **0** — binds on the **bypass** column: direct-SQL reads of aggregate tables outside the owning repository | WP-06 |
| `authority.projectionAuthorityReads` | **281** DELETE-class decision reads (task-status scheduling, recency, MAX(id)) — pre-kernel split: **bypass 281 / lawful 0** | **0** (hard target, after EK-7) — binds on the **bypass** column: kernel-scope direct-SQL reads of declared projection tables; lawful is structurally 0 | WP-12 |
| `authority.decisionWriterStatements` | **524** direct writers (390 src / 104 scripts / 30 tracker-view; 171 retain / 256 rewrite / 97 delete) — pre-kernel split: **bypass 524 / lawful 0** | max **0** — binds on the **bypass** column: direct-SQL writes of aggregate tables outside the owning repository | WP-06 |

**Lawful/bypass split (rev2).** The operator review found the original
contract could not distinguish lawful SQL inside the owning repository from
forbidden bypass SQL once the new kernel exists — it counted all old-tree SQL
and could therefore never bind correctly. The amended contract
(`lawfulRepositoryConvention` in the budget JSON, re-proved against the frozen
inputs on every driver run):

- **Lawful-owner file convention:** the sole lawful home of direct SQL against
  an aggregate's tables is that aggregate's EK-3 sole-writer repository,
  `src/workflow-kernel/persistence/<aggregate>-repository.ts`
  (FactoryRun → `factory-run-repository.ts`, …).
- **Aggregate→table map (spec-frozen here):** each aggregate owns the tables
  whose names equal its snake_case prefix, the prefix + `s`, or the prefix +
  `_…` (`factory_run`, `factory_runs`, `factory_run_events` → FactoryRun).
  The aggregate set is exactly the frozen universe's nine aggregates; the
  projection-table set is exactly the census PROJECTION class — both
  equalities are enforced by the driver, so the map cannot drift.
- **Split columns:** every one of the three dimensions above emits
  `{lawful, bypass, total}` (plus per-aggregate and bypass-site detail).
  The **target binds on bypass == 0**; the lawful column is unconstrained by
  these dimensions — it is bounded instead by the repository-count dimensions
  (`authority.mutableOwnerFanInFiles` max 1 writer file per table,
  `authority.mutableOwnerAggregates` exact 13).
- **Pre-kernel honesty:** while `src/workflow-kernel/` is absent the vector
  already emits the split with **bypass = frozen-census total, lawful = 0**
  (no lawful owner exists on the predecessor tree), so `--check` binds on the
  bypass column the moment the kernel lands.
- **Successor-mode measurement:** once the kernel exists the dimensions scan
  the live tree (`src/**`, `scripts/**`, `tracker-view/**`; production
  sources only) with a deterministic SQL-literal lexer (reduced form of the
  WP-01 census scanner): reads count any statement whose extracted read
  tables belong to an aggregate (embedded `SELECT`s inside write statements
  included — a repository of A reading B's tables via SQL is a bypass read of
  B); writes count INSERT/UPDATE/DELETE/REPLACE whose write targets belong to
  an aggregate; DDL is out of scope (the EK-3 declarative bootstrap is a
  separate sanctioned surface). Presentation-scope direct reads of aggregate
  tables also count as bypass — outside the one repository there is no lawful
  direct-SQL read of authoritative tables regardless of consumer; projection
  reads are legal only outside the kernel.

Rationale in one line each: fan-in 25 is ADR-097 violation 6 made countable;
the 13-kind authority topology was derived twice and reconciled with zero
silent acceptance, so it is not a free variable; the predecessor's one generic
handoff substrate becomes exactly the 22 relations of the plan's Target
logical model (the 49 obligation + 5 wait kinds are pinned separately by
`protocol.obligationKinds` / `protocol.waitKinds`); every predecessor decision
read is a direct SQL statement and 281 of them select authority through
channels the target model deletes.

**Post-kernel binding for the census-frozen dimensions (rev3).** The rev2
residual list (§7 item 4) named eight dimensions that measured only the frozen
census/universe and therefore could never go green on a kernel tree. Rev3
re-binds all eight with the same discipline rev2 used for the SQL dimensions:
the frozen value stays the non-binding predecessor baseline column while
`src/workflow-kernel/` is absent (kernel-scope column 0/target-only — a
dimension whose measured artifact does not exist never silently passes), and a
live successor-tree measurement takes over the moment the kernel lands. The
binding conventions are spec-frozen in the budget JSON
(`kernelCompositionConvention`) and re-proved on every driver run:

- **Sole implementation stems:** the obligation consumer
  (`composition.obligationConsumerImplementations`, exact 1), the WP-17
  role-binding compiler (`roles.bindingAuthorities`, exact 1) and the WP-18
  assembler path (`prompts.assemblers`, exact 1) each live in exactly one
  production file under `src/workflow-kernel/**` whose basename stem is the
  frozen stem (`obligation-consumer`, `role-binding`, `assembler`); the
  measured value is the count of such files, so a duplicate implementation
  turns red.
- **Declarations in the kernel domain:** relation kinds
  (`relation:<PascalName>` literals in `src/workflow-kernel/domain/**`) pin
  `authority.authoritativeRelationKinds` to exactly the 22 names of the plan's
  Target logical model table; non-aggregate authority kinds
  (`authority:<PascalName>` literals) complete
  `authority.mutableOwnerAggregates` alongside the nine
  `lawfulRepositoryConvention` repository files (exact 13 = 9 + 4). The
  frozen relation list is re-proved against the plan document and
  cross-checked against the frozen universe (every universe aggregate except
  the sanctioned transport boundary CognitionTransport — "not an aggregate
  owner" per its own universe entry — must be one of the 22, and
  CognitionTransport must not); the non-aggregate authority list is re-proved
  to exactly equal the universe's `nonAggregateAuthorities`.
- **Aggregate writer fan-in:** `authority.mutableOwnerFanInFiles` becomes the
  maximum per-aggregate count of distinct direct-SQL writer files in the live
  scan (the same statement population the rev2 bypass columns use, write
  aspect) — the sole lawful writer is the owning repository, so max 1.
- **Scheduler pattern:** `workshops.ownedSchedulerImplementations` counts
  production files anywhere in `src/**`, `scripts/**`, `tracker-view/**`
  whose basename matches the frozen pattern
  `(scheduler|flow-executor|flow-engine|handler-registry)` — the
  predecessor-observed shapes `generic-flow-executor.ts` /
  `kernel-handler-registry.ts` included; max 0.
- **Deletion-manifest ratchet:** `debt.temporaryLegacySurfaces` counts the
  frozen census's delete-disposition writer statements (97 across 34 files at
  the freeze) whose file still exists under production paths — a monotone
  ratchet that reaches exactly 0 when the EK-8 legacy-zero deletion
  completes; pre-cutover it emits the manifest count as the non-binding
  diagnostic column.

### 3.2 Protocol vocabularies (universe-grounded, exact equality)

| id | baseline | target (frozen universe) | WP |
|---|---|---|---|
| `protocol.commandKinds` | **0** typed (raw SQL writers only) | exact **53** (incl. 1 transport) | WP-05 |
| `protocol.eventKinds` | **0** typed (nearest: `command_receipts` table) | exact **52** | WP-05 |
| `protocol.obligationKinds` | **1** generic | exact **49** | WP-05 |
| `protocol.waitKinds` | **0** typed | exact **5** | WP-07 |
| `protocol.proofKinds` | **0** typed (status-string terminality) | exact **28** (post-D7) | WP-05 |
| `protocol.evidenceKinds` | **5** named ADR-053 chain facts | exact **67** | WP-05 |

Exact equality — not "at most" — because more kinds means an unmeasured
orchestration path and fewer means an undeclared transition. The per-aggregate
command split (FactoryRun 7, LifecycleRun 6, StageRun 3, ProcessRun 5, NodeRun
8, WorkItem 1, Workplace 16, ActivityAttempt 6, CognitionTransport 1) is
recorded in the budget rationale for WP-05 to pin against.

### 3.3 Composition hard targets

| id | baseline | target | WP |
|---|---|---|---|
| `composition.orchestrationEntrypoints` | **18** orchestration modules under `src/app/` | max **1** production composition | WP-12 |
| `composition.obligationConsumerImplementations` | **4** non-ledger obligation sites (2 readers + operator-soft-stop + restore script) | exact **1** obligation-consumer protocol — successor binding (rev3): sole-stem file count in kernel scope | WP-07 |
| `roles.bindingAuthorities` | **12** role-resolution sites (6 DELETE / 4 REWRITE / 2 RETAIN-AND-MOVE) | exact **1** role-binding compilation path — successor binding (rev3): sole-stem file count in kernel scope | WP-17 |
| `prompts.assemblers` | **10** prompt/context assembly sites | exact **1** assembler — successor binding (rev3): sole-stem file count in kernel scope | WP-18 |
| `prompts.cumulativeAccountants` | **0** (SAGA_PROMPT_MAX_BYTES is opt-in, 0/unset = unlimited — the census-recorded insufficiency) | exact **1** cumulative context accountant | WP-18 |

### 3.4 Workshops, dependencies, debt

| id | baseline | target | WP |
|---|---|---|---|
| `workshops.nameBranchLiterals` | **62** quoted workshop-name literals in 29 kernel-scope files (src minus `src/modules`) | **0** (hard target) | WP-12 |
| `workshops.ownedSchedulerImplementations` | **27** module-flow edges executed by workshop-owned flow logic (R17) | **0** (hard target; flows become kernel `obligation:advanceProcessFlow`) — successor binding (rev3): schedulerFilePattern count anywhere | WP-07 |
| `deps.runtimeDependencySet` | 5 deps (@modelcontextprotocol/sdk, better-sqlite3, dejavu-fonts-ttf, pdfkit, zod) | subset-of-frozen — **0 new** runtime dependencies | WP-12 |
| `debt.temporaryLegacySurfaces` | **97** delete-disposition writers (+12-file recency allowlist + ratcheted sanctioned task-writer set) | **0 after EK-8** (hard target; legacy-zero ratchet) — successor binding (rev3): deletion-manifest statements on still-present files | WP-12 |

### 3.5 Route policy (executorRoutePolicyRef shape)

| id | baseline | target | WP |
|---|---|---|---|
| `route.declarativeRuleCount` | **0** rules (default-only policy; selection lives in code) | max **32** | WP-17 |
| `route.conditionKeyUniverse` | `{cell, executionProfile, module, role}` + forbidden inference sources (tasks.status/tags/skill columns) | closed-set exactly `{protocolRole, semanticProfile}` | WP-17 |
| `route.imperativeBranchSites` | **53** (28 if + 25 ternary in execution-route-resolver.ts) | max **0** (pure table + default) | WP-17 |
| `route.serializedPolicyBytes` | **105** bytes (`factory-execution-routes.json`) | max **16384** | WP-17 |

### 3.6 Contract shape (target-only until WP-16 part 2 schemas exist)

| id | target | WP |
|---|---|---|
| `contract.roleContractFieldCount` | exact **16** named fields (22 physical with digest companions) — the plan's frozen block | WP-17 |
| `contract.promptBudgetProfileFieldCount` | exact **14** named entries (17 physical) | WP-18 |
| `contract.schemaAlternatives` | max **0** oneOf/anyOf | WP-16 |
| `contract.maxReferenceFanOut` | max **16** refs per array / 16 reference-valued fields per record | WP-17 |
| `contract.maxNestingDepth` | max **3** | WP-16 |
| `contract.policyReferenceKinds` | closed-set of exactly **10** kinds (`…Ref` suffixes enumerated in the budget) | WP-17 |
| `contract.arbitraryMetadataFields` | max **0** (no metadata/extension bag; `additionalProperties` closed) | WP-17 |

These are the dimensions whose measured artifact (the two admission schemas)
does not exist before WP-16 part 2. In the full vector they emit
`TARGET-ONLY-UNTIL-ADMISSION-SCHEMAS`; their single-dimension measurement
command **fails loudly** today (exit 2,
`COMPLEXITY_DIMENSION_UNMEASURABLE_BEFORE_KERNEL`) — see §5.

### 3.7 Prompt bytes

| id | baseline | target | WP |
|---|---|---|---|
| `prompts.staticPromptAssetMaxBytes` | **70219** bytes (largest `skills/*/SKILL.md`, saga-kickstart) | max **32768** per static inlined asset | WP-18 |
| `prompts.staticPromptAssetTotalBytes` | **506773** bytes across 23 skills | max **65536** per role contract's static set | WP-18 |

### 3.8 Execution structure

| id | baseline | target | WP |
|---|---|---|---|
| `structure.phaseCount` | **14** (`## Phase EK-…` headers parsed from the plan document) | max **14** (EK-0..EK-13) | WP-16 |
| `structure.topLevelPackageCount` | **24** (`\| WP-…` rows parsed from the plan's table) | max **24** | WP-16 |

The measurement parses the governing plan document itself, so adding a phase
or a 25th top-level package turns the checker red mechanically. Both caps are
**maxima, not exact equalities** (rev2, operator review item 4): the plan's
own wording is *"The execution structure is **capped at** the 14 named phases
EK-0 through EK-13 and the 24 top-level work packages listed below"* — an
upper bound whose replacement/merge clause explicitly contemplates the count
going down (a merge leaving 13 phases / 23 packages is a structural
simplification inside the envelope, not a deviation).

## 4. The measurement driver contract

```
node docs/refactoring/event-kernel/specs/measure-complexity.mjs                # full vector JSON
node docs/refactoring/event-kernel/specs/measure-complexity.mjs --out f.json  # full vector to file
node docs/refactoring/event-kernel/specs/measure-complexity.mjs --dimension <id>
node docs/refactoring/event-kernel/specs/measure-complexity.mjs --check
node docs/refactoring/event-kernel/specs/measure-complexity.mjs --selftest
```

- **Every run** first verifies the three frozen-input digests, then validates
  the budget structure (required keys, unique ids, finite targets,
  measurement commands, mandated-dimension coverage, no waivers, no orphan
  measurement implementations, and — since rev2 — the
  `lawfulRepositoryConvention` map against the frozen universe aggregate set
  and the frozen census PROJECTION class, and — since rev3 — the
  `kernelCompositionConvention` lists against the plan's Target logical
  model table and the frozen universe, the mandated sole-implementation
  stems, and the exact-target/list-length equalities). Structural defects
  exit 1.
- **Baseline dimensions** are measured now from the frozen census/universe
  plus deterministic tree scans (sorted iteration only).
- **Split dimensions** (`authority.decisionReaderStatements`,
  `authority.decisionWriterStatements`,
  `authority.projectionAuthorityReads`): the measured value the target binds
  on is the **bypass** column. Pre-kernel the split is emitted from the
  frozen census (bypass = total, lawful = 0); post-kernel from a live
  deterministic direct-SQL scan (see §3.1).
- **Re-bound census dimensions (rev3)** (`authority.mutableOwnerFanInFiles`,
  `authority.mutableOwnerAggregates`,
  `authority.authoritativeRelationKinds`,
  `composition.obligationConsumerImplementations`,
  `roles.bindingAuthorities`, `prompts.assemblers`,
  `workshops.ownedSchedulerImplementations`,
  `debt.temporaryLegacySurfaces`): pre-kernel each emits the frozen
  census/universe value as the non-binding baseline column with the
  kernel-scope column 0/target-only; post-kernel the same commands measure
  the live tree per `kernelCompositionConvention` (see §3.1).
- **Target-only dimensions** (`contract.*`): `--dimension` fails loudly with
  exit 2 `COMPLEXITY_DIMENSION_UNMEASURABLE_BEFORE_KERNEL` until the admission
  schemas exist — they never silently pass. (The schemas exist on this tree
  since WP-16 part 2; the loud-failure path was re-proven by temporarily
  hiding one schema — see §5.) The full-vector run emits them
  with status `TARGET-ONLY-UNTIL-ADMISSION-SCHEMAS` and `measured: null`
  when they are absent.
- **Binding semantics:** while `src/workflow-kernel/` is absent the vector is
  `predecessor-baseline-tree` and targets are explicitly non-binding
  (diagnostic evidence). Once the kernel exists the same command produces
  `successor-kernel-tree` with `binding: true`, and `--check` exits 1 on any
  violation or unmeasured dimension. This is the seed of the EK-2/EK-13
  complexity checker (`test:workflow-complexity`).

## 5. Determinism evidence (plan-required two-run proof)

Command sequence (Windows, Git Bash, this tree, budget revision rev3 @
`ek1/fix-complexity-residual-dims` from `ek1/fix-complexity-measurer`
`ef774386`):

```
$ node docs/refactoring/event-kernel/specs/measure-complexity.mjs --out .ek-tmp/vector-run1.json
$ node docs/refactoring/event-kernel/specs/measure-complexity.mjs --out .ek-tmp/vector-run2.json
$ cmp .ek-tmp/vector-run1.json .ek-tmp/vector-run2.json && echo IDENTICAL
IDENTICAL
$ sha256sum .ek-tmp/vector-run*.json
2bd8529f64ffce82ea80db2173527437d7f857e9b6c24027a2f1b0bdddc6971a  vector-run1.json
2bd8529f64ffce82ea80db2173527437d7f857e9b6c24027a2f1b0bdddc6971a  vector-run2.json
```

Byte-identical. The driver contains no clock, no randomness, no absolute paths
in output; every directory iteration is sorted; output is canonical 2-space
JSON with a trailing newline. Vector summary at this tree:
**36 dimensions — 36 measured, 0 target-only** (the admission schemas exist
since WP-16 part 2; schema version `ek1.complexity-vector.v3` — rev3 added
the successor-binding detail columns and the kernelCompositionConvention
verification). The three split dimensions emit
`bypass = census total, lawful = 0` and the eight re-bound dimensions emit
their frozen census/universe baselines on this pre-kernel tree; every
pre-kernel measured value is unchanged from rev2 (all 36 values byte-equal
against the rev2 vector).

**Kernel-mode binding + determinism proof (rev3).** Because this work
package forbids touching production `src/`, the synthetic-kernel proof runs
the driver on a scratch copy of the repo skeleton (`.ek-tmp/scratch/`:
frozen inputs + budget + driver + plan document + route policy +
`package.json`, a synthetic branchless route resolver with exactly the two
frozen condition keys, empty `skills/`, and a minimal fake
`src/workflow-kernel/` — nine convention repositories with one lawful
FactoryRun SQL read/write, the 22 `relation:` + 4 `authority:` literals in
`domain/`, and the three sole-stem files). On that tree all eight re-bound
dimensions measured green in `successor-tree-live-scan` mode:
`mutableOwnerFanInFiles` 1 ≤ 1, `mutableOwnerAggregates` 13 = 13,
`authoritativeRelationKinds` 22 = 22, `obligationConsumerImplementations` 1,
`bindingAuthorities` 1, `assemblers` 1, `ownedSchedulerImplementations` 0,
`temporaryLegacySurfaces` 0 (none of the 34 deletion-manifest files exist on
the scratch tree). `--check` correctly exits 1
(`COMPLEXITY_CHECK_RED`) — the stop-gate binds — with the remaining
violations being the scratch tree's honest gaps (the six protocol
vocabularies, `prompts.cumulativeAccountants`, `deps.runtimeDependencySet`
and three `contract.*` shape checks; see §7 item 9). Two runs on the
synthetic tree were byte-identical (`d6581d1f…97fc`).

**Red-trigger battery (rev3, each mutation applied to the scratch copy,
measured, then reverted with a green re-measurement):**

| # | mutation | dimension | measured | pass |
|---|---|---|---|---|
| R1 | second writer file for `factory_run` tables (`src/app/legacy-factory-writer.ts`) | `mutableOwnerFanInFiles` | 2 | RED |
| R2 | rogue `persistence/audit-log-repository.ts` | `mutableOwnerAggregates` | 14 | RED |
| R3 | 23rd `relation:RogueRelation` literal | `authoritativeRelationKinds` | 23 | RED |
| R4 | duplicate `obligation-consumer-v2.ts` | `obligationConsumerImplementations` | 2 | RED |
| R5 | second `role-binding-resolver.ts` | `bindingAuthorities` | 2 | RED |
| R6 | second `prompt-assembler.ts` | `assemblers` | 2 | RED |
| R7 | workshop-owned `src/modules/development/flow-scheduler.ts` | `ownedSchedulerImplementations` | 1 | RED |
| R8 | resurrected deletion-manifest file (`src/app/operator-soft-stop.ts`) | `temporaryLegacySurfaces` | 2 | RED |

Eight of eight re-bound dimensions have a demonstrated red trigger; every
revert restored the green measurement. (R1 additionally turned
`decisionWriterStatements`' bypass column red, as designed.)

**Kernel-mode binding + determinism proof (rev2, historical).** With a scratch
`src/workflow-kernel/` containing one lawful repository read/write, one
cross-aggregate read inside a repository, one app-script bypass read, one
scripts bypass write, one kernel-scope projection read and one presentation
tracker-view aggregate read, the live scan classified every site correctly
(reads: lawful 1 / bypass 3; writes: lawful 1 / bypass 2; projection reads:
bypass 1 — plus one real legacy statement,
`src/process-modules/persistence/sqlite-lifecycle-run-repository.ts:1254`
writing `factory_run_terminal_event_receipts`, correctly claimed by the
`factory_run` prefix as transitional bypass). Two runs on that tree were
byte-identical (`8b5f3b80…1db3`), and `--check` exited 1
(`COMPLEXITY_CHECK_RED`) with all three split dimensions among the binding
violations — the stop-gate binds on the bypass column the moment
`src/workflow-kernel` lands. The scratch tree was then removed and the
vector reverted byte-identically to the pre-kernel digest above. (The rev3
proof above deliberately did NOT repeat the in-tree scratch-kernel step:
this work package forbids touching production `src/`, so the synthetic
kernel lives in a scratch repo copy instead — the driver is path-relative
and the binding logic exercised is identical.)

Loud-failure evidence (re-proven at rev2 and rev3 by temporarily hiding one
admission schema; restore is immediate):

```
$ node docs/refactoring/event-kernel/specs/measure-complexity.mjs --dimension contract.schemaAlternatives
COMPLEXITY_DIMENSION_UNMEASURABLE_BEFORE_KERNEL: the admission schemas … do not
exist on this tree. … This dimension deliberately FAILS LOUDLY instead of
silently passing; the EK-1 target is frozen in complexity-budget.json.
(exit code 2)
```

Mutation-resistance evidence (seed of the WP-16 part 3 corpus):

- deleting the `protocol.waitKinds` dimension from the budget turns
  `--selftest` red with two problems (mandated dimension missing; orphan
  measurement implementation), exit 1 — unchanged from rev1, re-proven at
  rev3 (mutation M1);
- deleting `CognitionTransport` from
  `lawfulRepositoryConvention.aggregateTablePrefixes` turns `--selftest` red
  (declared aggregates ≠ frozen universe aggregates), exit 1;
- deleting `templates` from `lawfulRepositoryConvention.projectionTables`
  turns `--selftest` red (declared projections ≠ frozen census PROJECTION
  class), exit 1;
- rev3 additions (all re-proven at exit 1, restored to exit 0):
  dropping `KanbanCard` from `kernelCompositionConvention.relationNames`
  (M2: declared relations ≠ the plan's Target logical model table, and the
  relationKinds target no longer equals the list length); dropping
  `Planning` from `nonAggregateAuthorityNames` (M3: declared authorities ≠
  frozen universe, and the mutableOwnerAggregates target no longer equals
  9 + the list length); setting the `authoritativeRelationKinds` target to
  23 (M4: target ≠ frozen list length); deleting the
  `roles.bindingAuthorities` stem (M5: mandated sole-implementation stem
  missing).

The same mechanism makes "remove a complexity dimension", "silently
re-scope the lawful-owner map" and "silently re-scope the relation or
authority lists" red, as the plan demands.

## 6. What EK-13 re-measures

At EK-13 the same driver runs on the final tree in binding mode:

1. **Every dimension measured** — zero `TARGET-ONLY` entries, zero `null`
   measurements ("EK-13 permits no active complexity waiver and no unmeasured
   dimension").
2. **Every conjunctive check green** — all 36 dimensions pass independently,
   including the hard targets: one production composition, one
   obligation-consumer protocol, one role-binding compilation path, one
   cumulative context accountant, zero projection-authority reads, zero
   workshop-owned schedulers, zero workshop-name kernel branches, zero
   temporary legacy/replacement debt, at most 14 phases, at most 24
   top-level packages. The three split dimensions pass with
   **bypass == 0**; their lawful columns (the SQL inside the sole-writer
   repositories) are bounded by the repository-count dimensions, not zeroed.
   Since rev3 every hard-target dimension above is measured against the live
   tree (sole-stem file counts, scheduler pattern, deletion-manifest
   ratchet), so the EK-13 verdict no longer depends on frozen-census
   quotations that cannot change.
3. **Two-run determinism re-proven** on the final tree (same byte-identity
   requirement; the vector JSON is part of the qualification evidence).
4. **Frozen-input digests still verified** — the census/universe/decisions
   artifacts must remain byte-identical to the EK-1 freeze; any drift is an
   abort, not a re-baseline.

The EK-13 verdict "final measured structure satisfies every finite EK-1
complexity cap" is therefore a machine check, not a prose claim.

## 7. Residuals and handoff

1. **Parts 2–3 of WP-16** must author `canonical-role-contract.schema.json`,
   `prompt-budget-profile.schema.json` and the validator/mutation corpus; the
   seven `contract.*` dimensions then flip from target-only to measured and
   their `--dimension` commands stop failing. The field-count measurement
   collapses digest/version companions onto their `…Ref` sibling, so the exact
   targets are the plan's named counts (16 / 14). *(Parts 2 schemas and the
   unified validator exist on this tree; part 3's mutation corpus remains.)*
2. **WP-05** should register the typed vocabularies so `countKernelVocab`
   enumerates real declarations; until then the equality targets (53/52/49/5/
   28/67) are pinned by this budget against the frozen universe.
3. **WP-06/EK-3** must name each aggregate's physical tables with the frozen
   prefix of `lawfulRepositoryConvention.aggregateTablePrefixes`
   (`factory_run…`, `lifecycle_run…`, `stage_run…`, `process_run…`,
   `node_run…`, `workplace…`, `activity_attempt…`, `work_item…`,
   `cognition_transport…`) and place their direct SQL only in
   `src/workflow-kernel/persistence/<aggregate>-repository.ts`; anything else
   the scan sees is bypass and red. Renaming a prefix is a budget revision
   requiring an independent-verifier-approved measured complexity delta; adding
   an aggregate or prefix reopens EK-1.
4. **RESOLVED at rev3** (was: census-frozen dimensions remain permanently red
   on any kernel tree): `authority.mutableOwnerFanInFiles` (25),
   `authority.mutableOwnerAggregates` (16), `authority.authoritativeRelationKinds`
   (1), `composition.obligationConsumerImplementations` (4),
   `roles.bindingAuthorities` (12), `prompts.assemblers` (10),
   `workshops.ownedSchedulerImplementations` (27) and
   `debt.temporaryLegacySurfaces` (97) — the eight dimensions that measured
   only the frozen census/universe inputs — are re-bound to live
   successor-tree measurements via `kernelCompositionConvention` (§3.1,
   "Post-kernel binding for the census-frozen dimensions"). All eight
   measured green on the synthetic kernel tree and all eight have a
   demonstrated red trigger (§5). WP-05/06/07/17/18 implementers must follow
   the frozen conventions: relation/authority kind literals in
   `src/workflow-kernel/domain/**`, the three sole-implementation stems, and
   repository files under `src/workflow-kernel/persistence/`; renames are
   budget revisions, additions reopen EK-1.
5. **Split-measurement edges (deliberate, documented):** presentation-scope
   direct reads of aggregate tables count as bypass (no lawful direct-SQL read
   of authoritative tables exists outside the one repository); a `DELETE FROM
   <aggregate table>` outside its repository is counted in both the read and
   write bypass columns; DDL is out of scope for the ownership scan (the EK-3
   declarative bootstrap is sanctioned); cross-aggregate reads embedded in
   write statements are caught by the read aspect; bypass-site lists in the
   vector are capped at 50 sorted sites per dimension (`bypassSitesTruncated`
   flags overflow).
6. **WP-16 part 3** folds `--selftest`/`--check` into
   `npm run validate:ek-admission-specs` and the mutation corpus (the
   remove-dimension and convention-drift red paths demonstrated in §5 are the
   first corpus entries).
7. The `admissionContractDigest` (plan EK-1) must include the digest of
   `complexity-budget.json` and of `measure-complexity.mjs` — both are inputs
   to the admission contract, and the vector JSON records the budget's sha256
   for exactly that purpose. Rev2 changed both digests
   (`complexity-budget.json` → `1e22a3d3…3b2e`,
   `measure-complexity.mjs` → `d7e00b4c…0800b` at the rev2 commit); rev3
   changed both again (`complexity-budget.json` → `f9da8b1a…e91a`,
   `measure-complexity.mjs` → `88af3676…ccec` at the rev3 commit); the
   digest rotation is itself evidence of the sanctioned amendment.
8. Determinism of the driver depends on sorted iteration and the frozen
   inputs only; if a future dimension needs environment data (e.g. provider
   limits), it must enter via a frozen, digest-verified artifact — never via
   ambient state.
9. **Newly discovered residuals of the same defect class (rev3 finding, NOT
   fixed — outside this work package's sanctioned eight):** five more
   dimensions cannot go green on a kernel tree as measured today.
   `prompts.cumulativeAccountants` (exact 1) filters the frozen census for a
   retain-and-move accountant — a value that is structurally 0 forever; it
   needs a successor-tree measurement (e.g. a sole-stem `accountant` file
   count, mirroring the rev3 stem convention). `deps.runtimeDependencySet`
   (subset-of-frozen) measures `.length` — a number compared against the
   frozen string array, which can never satisfy the subset predicate; it
   must measure the sorted dependency ARRAY. Three `contract.*` shape checks
   measure the existing WP-16 part 2 schemas red
   (`contract.maxNestingDepth` 5 > 3, `contract.policyReferenceKinds` 20
   kinds ≠ the frozen 10, `contract.arbitraryMetadataFields` 24 > 0) —
   either the schemas must be amended to the frozen targets or the targets
   revised with an independent-verifier-approved delta. The synthetic-kernel
   `--check` in §5 lists exactly these as its remaining violations.
10. **`validate-ek-admission-specs` ACD bug (rev3 finding, NOT fixed — the
    validator is coordinator-owned tooling):** the admissionContractDigest
    printed by `tools/validate-ek-admission-specs.mjs` does NOT include the
    specification digests. Its canonicalization passes
    `Object.keys({digests, validator}).sort()` as the JSON.stringify
    replacer whitelist — a top-level key list — so every nested key of
    `digests` is dropped and the hashed canonical form is literally
    `{"digests":{},"validator":"<validator file path>"}` (proved at rev3:
    the printed ACD `93874042…b4cf8` is byte-identical to rev2's despite the
    budget and driver digests rotating, and hand-hashing
    `{"digests":{},"validator:…"}` reproduces it; substituting any digest
    value leaves it unchanged). The ACD is therefore content-insensitive to
    ALL nine specification files and sensitive only to the validator's own
    path. This contradicts §7 item 7 and the plan's EK-1 receipt requirement;
    the one-line fix (serialize the digests without the whitelist) is a
    coordinator action that will rotate the ACD — a deliberate
    admission-contract event, not something this work package may do
    implicitly. Interim evidence: the `specificationDigests` block printed
    by the same command DID rotate correctly at rev3
    (`complexityBudget` → `f9da8b1a…e91a`, `complexityDriver` →
    `88af3676…ccec`).
