# EK-1 Complexity Budget — the conjunctive successor-admission envelope (WP-16 part 1)

- **Work package:** WP-16, part 1 of 3 (specification author). This author is
  forbidden from later implementing WP-05, WP-17 or WP-18 (plan role rule).
- **Integration base SHA:** `21ba0816e38ec1492b3acb4d21e7ccea49c6f5df`
- **Branch:** `ek1/wp16-complexity-budget`
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
| `authority.mutableOwnerFanInFiles` | **25** writer files on one table (`tasks`; 64 writer statements) | max **1** writer module per mutable aggregate | WP-06 |
| `authority.mutableOwnerAggregates` | **16** fact families / 124 accessed tables, mixed ownership | exact **13** authority kinds (9 owner aggregates + 4 non-aggregate authorities, frozen universe) | WP-05 |
| `authority.authoritativeRelationKinds` | **1** generic obligation substrate (narrow, EC-8 only) | exact **54** (49 obligation kinds + 5 wait kinds, frozen universe) | WP-05 |
| `authority.decisionReaderStatements` | **1113** decision-path reads, all direct SQL (829 AUTH / 281 DELETE / 373 presentation overall) | max **0** decision reads bypassing the owning repository | WP-06 |
| `authority.projectionAuthorityReads` | **281** DELETE-class decision reads (task-status scheduling, recency, MAX(id)) | **0** (hard target, after EK-7) | WP-12 |
| `authority.decisionWriterStatements` | **524** direct writers (390 src / 104 scripts / 30 tracker-view; 171 retain / 256 rewrite / 97 delete) | max **0** writes outside a typed owning command | WP-06 |

Rationale in one line each: fan-in 25 is ADR-097 violation 6 made countable;
the 13-kind authority topology was derived twice and reconciled with zero
silent acceptance, so it is not a free variable; the predecessor's one generic
handoff substrate becomes exactly the 54 reconciled relation kinds; every
predecessor decision read is a direct SQL statement and 281 of them select
authority through channels the target model deletes.

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
| `composition.obligationConsumerImplementations` | **4** non-ledger obligation sites (2 readers + operator-soft-stop + restore script) | exact **1** obligation-consumer protocol | WP-07 |
| `roles.bindingAuthorities` | **12** role-resolution sites (6 DELETE / 4 REWRITE / 2 RETAIN-AND-MOVE) | exact **1** role-binding compilation path | WP-17 |
| `prompts.assemblers` | **10** prompt/context assembly sites | exact **1** assembler | WP-18 |
| `prompts.cumulativeAccountants` | **0** (SAGA_PROMPT_MAX_BYTES is opt-in, 0/unset = unlimited — the census-recorded insufficiency) | exact **1** cumulative context accountant | WP-18 |

### 3.4 Workshops, dependencies, debt

| id | baseline | target | WP |
|---|---|---|---|
| `workshops.nameBranchLiterals` | **62** quoted workshop-name literals in 29 kernel-scope files (src minus `src/modules`) | **0** (hard target) | WP-12 |
| `workshops.ownedSchedulerImplementations` | **27** module-flow edges executed by workshop-owned flow logic (R17) | **0** (hard target; flows become kernel `obligation:advanceProcessFlow`) | WP-07 |
| `deps.runtimeDependencySet` | 5 deps (@modelcontextprotocol/sdk, better-sqlite3, dejavu-fonts-ttf, pdfkit, zod) | subset-of-frozen — **0 new** runtime dependencies | WP-12 |
| `debt.temporaryLegacySurfaces` | **97** delete-disposition writers (+12-file recency allowlist + ratcheted sanctioned task-writer set) | **0 after EK-8** (hard target; legacy-zero ratchet) | WP-12 |

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
| `structure.phaseCount` | **14** (`## Phase EK-…` headers parsed from the plan document) | exact **14** (EK-0..EK-13) | WP-16 |
| `structure.topLevelPackageCount` | **24** (`\| WP-…` rows parsed from the plan's table) | exact **24** | WP-16 |

The measurement parses the governing plan document itself, so adding a phase
or a 25th top-level package turns the checker red mechanically.

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
  measurement implementations). Structural defects exit 1.
- **Baseline dimensions** are measured now from the frozen census/universe
  plus deterministic tree scans (sorted iteration only).
- **Target-only dimensions** (`contract.*`): `--dimension` fails loudly with
  exit 2 `COMPLEXITY_DIMENSION_UNMEASURABLE_BEFORE_KERNEL` until the admission
  schemas exist — they never silently pass. The full-vector run emits them
  with status `TARGET-ONLY-UNTIL-ADMISSION-SCHEMAS` and `measured: null`.
- **Binding semantics:** while `src/workflow-kernel/` is absent the vector is
  `predecessor-baseline-tree` and targets are explicitly non-binding
  (diagnostic evidence). Once the kernel exists the same command produces
  `successor-kernel-tree` with `binding: true`, and `--check` exits 1 on any
  violation or unmeasured dimension. This is the seed of the EK-2/EK-13
  complexity checker (`test:workflow-complexity`).

## 5. Determinism evidence (plan-required two-run proof)

Command sequence (Windows, Git Bash, this tree):

```
$ node docs/refactoring/event-kernel/specs/measure-complexity.mjs --out .ek-tmp/vector-run1.json
$ node docs/refactoring/event-kernel/specs/measure-complexity.mjs --out .ek-tmp/vector-run2.json
$ cmp .ek-tmp/vector-run1.json .ek-tmp/vector-run2.json && echo IDENTICAL
IDENTICAL
$ sha256sum .ek-tmp/vector-run*.json
ba9b66c9674343952a61919ceb2dba3b3c6b57e469bd38d151239ebc86dc84cb  vector-run1.json
ba9b66c9674343952a61919ceb2dba3b3c6b57e469bd38d151239ebc86dc84cb  vector-run2.json
```

Byte-identical. The driver contains no clock, no randomness, no absolute paths
in output; every directory iteration is sorted; output is canonical 2-space
JSON with a trailing newline. Vector summary at the base tree:
**36 dimensions — 29 measured, 7 target-only** (the 7 are exactly the
contract-shape schema dimensions).

Loud-failure evidence (placeholder command run before the kernel exists):

```
$ node docs/refactoring/event-kernel/specs/measure-complexity.mjs --dimension contract.schemaAlternatives
COMPLEXITY_DIMENSION_UNMEASURABLE_BEFORE_KERNEL: the admission schemas … do not
exist on this tree. … This dimension deliberately FAILS LOUDLY instead of
silently passing; the EK-1 target is frozen in complexity-budget.json.
(exit code 2)
```

Mutation-resistance evidence (seed of the WP-16 part 3 corpus): deleting the
`protocol.waitKinds` dimension from the budget turns `--selftest` red with two
problems (mandated dimension missing; orphan measurement implementation),
exit 1. The same mechanism makes "remove a complexity dimension" red, as the
plan demands.

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
   temporary legacy/replacement debt, 14 phases, 24 top-level packages.
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
   targets are the plan's named counts (16 / 14).
2. **WP-05** should register the typed vocabularies so `countKernelVocab`
   enumerates real declarations; until then the equality targets (53/52/49/5/
   28/67) are pinned by this budget against the frozen universe.
3. **WP-16 part 3** folds `--selftest`/`--check` into
   `npm run validate:ek-admission-specs` and the mutation corpus (the
   remove-dimension red path demonstrated in §5 is the first corpus entry).
4. The `admissionContractDigest` (plan EK-1) must include the digest of
   `complexity-budget.json` and of `measure-complexity.mjs` — both are inputs
   to the admission contract, and the vector JSON records the budget's sha256
   for exactly that purpose.
5. Determinism of the driver depends on sorted iteration and the frozen
   inputs only; if a future dimension needs environment data (e.g. provider
   limits), it must enter via a frozen, digest-verified artifact — never via
   ambient state.
