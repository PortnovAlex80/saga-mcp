# Canonical Role Contract Specification (EK-1 admission spec, WP-16 part 2)

**Status:** frozen candidate for EK-1 admission. Any later semantic change to this
document, `canonical-role-contract.schema.json` or `role-contract-manifest.json`
REOPENS EK-1 and invalidates downstream qualification evidence (plan EK-1,
"Successor admission specifications").

**Work package:** WP-16 part 2 of 3 (role contract + manifest). Part 1 owns
`complexity-budget.json`; part 3 owns `prompt-budget-profile.schema.json`.

**Author role:** implementer (specification author). Barred from WP-05/WP-17/WP-18
implementation per the plan's EK-1 separation rule.

**Integration base SHA:** `21ba0816`. **Branch:** `ek1/wp16-role-contract`.

## 1. Inputs (read-only, frozen)

| Input | Identity |
|---|---|
| Plan, "Canonical role contract" section | `git:21ba0816:docs/plans/EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md#canonical-role-contract` |
| Frozen protocol decisions D1–D12 | `git:saga4@33bf1976:docs/refactoring/event-kernel/PROTOCOL-DECISIONS-FROZEN.md` |
| Transition universe (unified, post-reconciliation) | `git:ek1/graph-reconciliation@d41cebe0:docs/refactoring/event-kernel/reconciliation/transition-universe.json` |
| Authority census (role-resolution sites RR-1..RR-12) | `git:ek1/wp01-census@eaa07093:docs/refactoring/event-kernel/AUTHORITY-CENSUS.md` |

Key frozen anchors used below:

- Plan: "The protocol has only `author` and `reviewer` Workplace roles. Planner,
  implementer, reviewer and certifier are semantic profiles; repair is a
  transition/behavior, not another kernel role."
- Plan: `executorRoutePolicyRef` "is the sole provider/model selection authority …
  a finite declarative eligibility table, never executable code or hooks, and
  contains no task/status/workshop inference, transition, retry, tool, prompt or
  implicit-fallback semantics."
- Frozen D4: the terminal-claim verifier is `lifecycleRun.verifyTerminalClaims`
  (LifecycleRun-owned command); "verifier is not an author/reviewer kernel role".
- Transition universe: `workplace.admitWorkIntent` resolves the
  `InstalledWorkshopManifest` binding ONCE (FWD:F007) and pins
  `CanonicalRoleContractBinding (pinned ref+digest)` on the WorkIntent;
  `activityAttempt.create` copies and atomically verifies it and performs the
  single route-policy evaluation.

## 2. Deliverables

| File | Role |
|---|---|
| `canonical-role-contract.schema.json` | JSON Schema (draft 2020-12). Root validates one `CanonicalRoleContract`; `$defs` freeze the referenced-artifact shapes (skill, semantic profile, executor route policy table, tracker projection profile, completion command schema, certifier operator contract), the manifest binding rows and the complete manifest. |
| `role-contract-manifest.json` | The complete manifest table: 12 Workplace launch-kind bindings + 1 lifecycle operator binding, each mapped to exactly one content-addressed role-contract slot (pending placeholders until EK-8). `manifestDigest` `b1ef94c26e0d4b371f8385fb9f17bc075e81368320a19be76ca954c23edda58b`. |
| `validate-role-contract.mjs` | Deterministic, dependency-free validator (manifest admission rules + synthetic example + digest verification + four deliberate RED mutations). |
| `ROLE-CONTRACT-SPEC.md` | This narrative. |

## 3. The frozen contract shape

The plan's block is frozen VERBATIM — every field, in plan order. The schema
root's `properties`/`required`/`additionalProperties:false` implement exactly
this list and nothing else:

```text
CanonicalRoleContract {
  schemaVersion                     const ek.canonical-role-contract.ek1.v1
  roleContractRef                   ^sha256:[0-9a-f]{64}$ ; MUST equal "sha256:"+contractDigest
  protocolRole                      enum author | reviewer          (the plan's comment)
  semanticProfileRef                content-addressed (SemanticProfileArtifact)
  protocolSkillRef + digest         content-addressed pair (SkillArtifact)
  semanticSkillRef + digest         content-addressed pair (SkillArtifact)
  executorRoutePolicyRef + digest   content-addressed pair (ExecutorRoutePolicyTable)
  allowedCapabilityRefs[]           unique logical ids, >= 1
  allowedToolRefs[]                 unique logical ids, >= 1
  inputProductContracts[]           unique content-addressed, >= 1
  outputProductContracts[]          unique content-addressed, >= 1
  evidenceObligations[]             unique ^obligation:<kind>$, >= 1
  completionCommandSchemaRef + digest  content-addressed pair (CompletionCommandSchema)
  trackerProjectionProfileRef + digest  content-addressed pair (TrackerProjectionProfile)
  promptBudgetProfileRef + digest   content-addressed pair (shape frozen by WP-16 part 3)
  contractDigest                    ^[0-9a-f]{64}$ (slot fingerprint, section 6)
}
```

Reference-kind conventions:

- A **content-addressed ref** is `sha256:<64 lowercase hex>` — the address of the
  referenced artifact's canonical bytes.
- A **paired digest** is the bare 64-hex sha256 of the referenced artifact's
  canonical JSON. The pair `(ref, digest)` makes "point at X, verify X" one
  contract-level obligation; consumers verify equality (`ref === "sha256:"+digest`
  and `digest === sha256(canonicalJson(artifact))`).
- `allowedCapabilityRefs` and `allowedToolRefs` are logical identifiers (dotted
  kebab-case; optional `:`-namespaced tool ids). They are not separately
  content-addressed: the contract's own content address pins them transitively.
- `evidenceObligations` uses the transition universe's obligation-kind naming
  (`obligation:<name>`) so the EK-9 engine can check declared == demonstrated.

### Hard bans and where each is encoded

| Ban (plan law) | Encoding |
|---|---|
| No free-form metadata / extension bag; adding a field or reference kind reopens EK-1 | `additionalProperties: false` at the schema root and in every `$defs` sub-object except `$defs/CompletionCommandSchema`, which is itself a JSON Schema for the completion payload — its "additional" properties ARE schema keywords, and it still cannot smuggle policy into the contract (only `type: object` + draft identity are constrained there). The M3 mutation proves the closed-shape RED on the contract itself. |
| No inline transition policy / executable policy blob | The frozen field set contains no transition vocabulary; there is no field that can carry a policy blob, and `additionalProperties:false` blocks adding one. Role transitions remain Workplace-reducer-only. |
| Route policy must be a static declarative table, no code/hooks, no inference, sole selection authority | `executorRoutePolicyRef` is content-addressed; the referenced artifact must satisfy `$defs/ExecutorRoutePolicyTable` (section 7). |
| Tracker profile presentation-only; may not authorize work / select role, skill, tool, completion, budget | The referenced artifact must satisfy `$defs/TrackerProjectionProfile` whose entire field set is `display.label`, `display.boardColumn`, `display.detailSections` (section 8). |
| A skill contains cognition instructions only | `$defs/SkillArtifact` = `{schemaVersion, skillId, instructions}` with `additionalProperties:false` — transition, capability, tool, evidence and budget policy are structurally impossible. |
| No fallback to task status/tags, execution status, assignment.skill, roleFromTask, tracker state, global skill roots | Manifest `fallbackPolicy: "none"` + `forbiddenResolutionSources` (9 banned sources) + the binding rules in section 5; no manifest structure can express a conditional or default binding. |

## 4. Role universe (finite, three orthogonal dimensions)

- **protocolRole**: `author | reviewer` — the only Workplace roles.
- **semanticProfile**: `planner | implementer | reviewer | certifier`.
- **actorBehavior**: `compliant | repairing | adversarial | failed` — a test/actor
  dimension (the EK-9 engine enumerates a finer behavioral list); it NEVER
  selects a binding.

Finiteness law (frozen in the manifest's `roleUniverse.dimensionalityLaw`):
only the tuple `(workshop, cellKind, protocolRole, semanticProfile)` selects a
binding; actor behaviors never select a binding; repair is a transition
(`workplace.enterRepairWait` / requeue obligations), so repair launches REUSE
the same launch kind — there are deliberately no "repair role" rows.

The manifest cross-product is NOT the full 5x2x4 cartesian product. The
binding universe is the set of launch kinds the target protocol actually has
(section 5), and the validator proves exact set equality against the
independently derivable expectation (workshops x {implementation.author,
implementation.reviewer} + planningCellWorkshops x {planning.author,
planning.reviewer} + one operator binding).

## 5. The complete manifest table

### Binding rules (frozen)

1. **One row per launch kind.** A launch kind is a `<workshop>.<cellKind>.<protocolRole>`
   identity; the schema's `launchKind` pattern and the composition rule
   `launchKind === workshop.cellKind.protocolRole` are both enforced.
2. **Zero fallback.** Rows are unconditional; there is no default row, no
   ordering, no specificity ranking, no "else". A launch kind outside the table
   has no contract and cannot be admitted — typed refusal, never inference.
3. **Zero duplicate binding.** `launchKind`, the dimension tuple, and the slot
   ref are each globally unique (validator checks all three).
4. **Semantic-profile consistency** is frozen per (cellKind, protocolRole):
   `implementation.author -> implementer`, `implementation.reviewer -> reviewer`,
   `planning.author -> planner`, `planning.reviewer -> reviewer`.
5. **Slots are content-addressed placeholders until EK-8.** Every slot is exactly
   `roleContractRef = "ek8:pending:<launchKind>"`, `contractDigest = "pending-ek8"`.
   The deterministic derivation makes accidental duplicate or crossed
   pre-binding detectable now; EK-8 replaces both values with the authored
   artifact's real address and digest (section 9).

### The 13 rows

| # | launchKind | protocolRole | semanticProfile | Notes |
|---|---|---|---|---|
| 1 | `discovery.implementation.author` | author | implementer | proposal production |
| 2 | `discovery.implementation.reviewer` | reviewer | reviewer | author-gate/reviewer-desk side |
| 3 | `formalization.implementation.author` | author | implementer | PRD/SRS/UC/AC production |
| 4 | `formalization.implementation.reviewer` | reviewer | reviewer | |
| 5 | `development.planning.author` | author | planner | `workItem.planGraph` cognition |
| 6 | `development.planning.reviewer` | reviewer | reviewer | plan review |
| 7 | `development.implementation.author` | author | implementer | cell material production |
| 8 | `development.implementation.reviewer` | reviewer | reviewer | |
| 9 | `delivery.implementation.author` | author | implementer | packaging/delivery |
| 10 | `delivery.implementation.reviewer` | reviewer | reviewer | |
| 11 | `documentation.implementation.author` | author | implementer | docs rewrite |
| 12 | `documentation.implementation.reviewer` | reviewer | reviewer | |
| 13 | `lifecycle.certification.certifier` | — (no protocol role) | certifier | D4 operator contract, see below |

### Frozen decisions recorded in this table

- **D4 — certifier binding (the explicit decision this spec was asked to make).**
  Per the frozen protocol decision D4, `lifecycleRun.verifyTerminalClaims` is a
  LifecycleRun-owned command and the verifier "is not an author/reviewer kernel
  role". Therefore the certifier semantic profile is NOT bound through
  `protocolRole` at all: it is admitted as exactly one `lifecycleOperator`
  binding (row 13) whose slot pins a `CertifierOperatorContract`
  (`$defs/CertifierOperatorContract`): owned command
  `lifecycleRun.verifyTerminalClaims`, owner aggregate `LifecycleRun`,
  content-addressed `executableVerifierRefs`, TerminalLifecycleClaim /
  ConstructionSurface inputs, ExecutableVerifierResult output, and the same
  digest discipline. It is resolved by its owning obligation
  (`obligation:verifyTerminalClaims`), not by `workplace.admitWorkIntent`.
  This keeps the protocol role universe at exactly two Workplace roles without
  losing the certifier dimension, and adding a third protocolRole value remains
  a schema impossibility.
- **Planning cells exist only in Development.** Evidence: D10 freezes
  `workItem.planGraph` as the single planning-facts consumption point; the
  planner skills (`saga-planner`, `saga-planning-reviewer`) live only in the
  development module package (`src/process-modules/modules/development/package/
  resources/skills/`); EK-6 gives planner attempts the same admission rules as
  every other profile through the same Workplace path. Discovery unknowns
  become `obligation:openUnknownObligation` work items at `workItem.planGraph`
  (D10), not a Discovery planner role.
- **Reviewer uniformity across all five workshops.** The Workplace owns the
  author/reviewer/repair loop universally; EK-8 converts every workshop onto
  the same semantic interface. The legacy `reviewSkill: null` in the
  documentation module is a legacy representation detail, not a protocol fact.
  Freezing all five reviewer rows now is what makes "one role-binding source
  covers every launch kind" provable at EK-8.

## 6. Slot-fingerprint rule (contractDigest)

This is the value WorkIntent and ActivityAttempt pin as `roleContractDigest`;
scripted, replay and real actors observe the same digest.

Canonicalization (identical discipline to the repo's existing
`execution-route-resolver.ts` `digestPolicy`, retained deliberately):

1. Take the contract as an in-memory JSON value (after parsing; whitespace and
   key order of the stored file are irrelevant).
2. Remove the top-level `contractDigest` property AND the top-level
   `roleContractRef` property. `roleContractRef` is DERIVED from the digest
   (`"sha256:" + contractDigest`), so it cannot be covered by it — excluding the
   derived self-address is the standard non-circular self-addressing pattern.
   No other field is excluded.
3. Recursively sort object keys lexicographically (UTF-16 code-unit order, i.e.
   JavaScript's default `Array.prototype.sort` on the key strings). Arrays keep
   their order — array order is semantic.
4. Serialize with `JSON.stringify` (compact: no whitespace). The schema's
   patterns guarantee strings are plain, numbers are absent, and no
   `NaN`/`Infinity` can occur.
5. UTF-8 encode, sha256, lowercase hex.

Then `roleContractRef := "sha256:" + contractDigest`.

The same rule with the analogous exclusion (`operatorContractRef`) applies to
the `CertifierOperatorContract`, and to the manifest top level with the single
exclusion `manifestDigest` (the manifest has no derived self-address field):

- `manifestDigest = sha256(canonicalJson(manifest minus manifestDigest))`
  = `b1ef94c26e0d4b371f8385fb9f17bc075e81368320a19be76ca954c23edda58b`
  over the current pending-slot content.

WP-05 implements this rule once in the pure kernel as the canonical
serialization/digest primitive; WP-17's compiler emits contracts whose digest
verifies under it; nothing else may invent a second fingerprint rule.

Reference values from the synthetic example (recomputed by the validator on
every run):

```text
example contract (discovery.implementation.author)
  contractDigest  323d15a14284bd8418d6243565e598e1ff399644b3d1e9397d5686ad3bebb868
  roleContractRef sha256:323d15a14284bd8418d6243565e598e1ff399644b3d1e9397d5686ad3bebb868
example certifier operator contract
  contractDigest  ee494ea89bcf089a241181eeca0eb81ae485ecb2921a3c526c175e02562787d3
```

## 7. Executor route policy (declarative eligibility table)

The artifact named by `executorRoutePolicyRef` must satisfy
`$defs/ExecutorRoutePolicyTable`:

```text
{ schemaVersion, tableId, rules: [ { when: {launchKind? protocolRole? semanticProfile?},
                                     route: {transportKind provider model effort?} } ] }
```

- **Closed condition-key enum**: `launchKind`, `protocolRole`,
  `semanticProfile` — three static protocol facts already pinned on the
  contract. `tasks.status`, tags, execution status, assignment skill, tracker
  state, workshop-name inference and chronology are not keys and cannot be
  added (`additionalProperties:false`).
- **No executable semantics**: no `code`, `hook`, `command`, `resolver` key can
  exist; `transportKind` is frozen to the single production cognition transport
  `opencode` (WP-18 instrumented transport; the claude CLI is forbidden by repo
  law — AGENTS.md).
- **No default/fallback rule, no priority/rank/order field**: structurally
  impossible; the legacy resolver's `default` route and specificity ranking are
  explicitly NOT carried over.
- **Exactly-one-match selection law** (semantic; decidable because the
  launch-kind universe is finite): evaluating a table for one launch kind must
  yield EXACTLY ONE matching rule. Zero matches or two matches is a typed
  admission failure at `activityAttempt.create` — never a fallback, never a
  ranking. The selected provider/model/version is stored once as
  `ProviderRoutePin` attempt evidence; dispatcher, runner, limit lookup and
  retry paths may not reselect it.

The validator demonstrates the law on the synthetic table (1 matching rule for
`discovery.implementation.author`); EK-8's real tables are checked the same way.

## 8. Tracker projection profile (presentation only)

`$defs/TrackerProjectionProfile` admits exactly `{schemaVersion, profileId,
display: {label, boardColumn ∈ {todo,in-progress,review,repair,waiting,terminal},
detailSections[]}}`. The boardColumn enum mirrors the plan's human-view columns;
the tracker displays pinned contract and prompt-receipt references
(`detailSections`) and can never carry cognition, tool, completion, transition
or budget instructions — there is no field for them.

## 9. EK-8 conversion obligations (what fills the slots)

At the workshop conversion (EK-8 / WP-11*) each `ek8:pending:<launchKind>` slot
is replaced by the real content address and digest of the authored contract
artifact. Frozen conversion rules:

1. The row count, launch kinds, dimension tuples and binding rules NEVER change;
   only the two slot values change. Any other manifest edit reopens EK-1.
2. Every authored contract must validate against the schema root, verify under
   the slot-fingerprint rule, and reference an
   `ExecutorRoutePolicyTable`/`TrackerProjectionProfile`/`SkillArtifact`/
   `SemanticProfileArtifact`/`CompletionCommandSchema` that validates against
   its `$def`.
3. The certifier slot is filled with a `CertifierOperatorContract`, not a
   `CanonicalRoleContract`.
4. `manifestDigest` is recomputed after conversion; the change from
   `b1ef94c2…` is the conversion receipt's manifest delta.
5. `npm run validate:ek-admission-specs` (coordinator-composed; package.json is
   coordinator-owned) must include this validator. The standalone command today:
   `node docs/refactoring/event-kernel/specs/validate-role-contract.mjs`.

## 10. Legacy role-resolution disposition (census RR-1..RR-12)

| Site | Legacy | Disposition -> target |
|---|---|---|
| RR-1 | `skillForTask(task, sourceStatus)` task columns/tags/hardcoded skills | DELETE -> WorkIntent pins roleContractRef+digest; dispatcher transports |
| RR-2 | claim-time role selection from mutable task columns | DELETE -> claim returns the WorkIntent-pinned contract |
| RR-3 | dispatcher `skillForTask(task, task.status)` | DELETE -> contract copied from WorkIntent at activityAttempt.create |
| RR-4 | `roleFromTask(task, fallbackSkill)` | DELETE -> protocolRole from the pinned contract only |
| RR-5 | `pickLaunchSpecSkillName` isReview-from-status | DELETE (role from projection status) -> profile from contract |
| RR-6 | pinned-installation skill block, wrong isReview input | REWRITE -> CanonicalRoleContract consumer (contract is the seed) |
| RR-7 | `resolveExecutionProfile(taskKind)` second compilation site | REWRITE -> WP-17 compiler over THIS manifest (one compilation path) |
| RR-8 | `resolveAgentLaunchSpec` pinned+digest-verified launch spec | RETAIN-AND-MOVE -> WorkIntent/ActivityAttempt contract pinning |
| RR-9 | worker-launcher status synthesis | REWRITE -> transport carries the contract; no status synthesis |
| RR-10 | `ExecutionRouteResolver` (default route + specificity rank + env override) | RETAIN-AND-MOVE -> `executorRoutePolicyRef` declarative table, sole authority, evaluated once, no default/rank/env |
| RR-11 | replay claim binder role input | RETAIN-AND-MOVE -> role flows from the same pinned contract |
| RR-12 | `task.review_skill` review-routing branch | DELETE -> Workplace transition decides the reviewer pass |

The manifest's `legacyResolutionDisposition` array carries these twelve
verdicts in machine-readable form; EK-8's `test:legacy-zero` consumes them.

## 11. Validation evidence (executed 2026-08-24)

Commands (from the repo root, plain `node`, zero dependencies):

```bash
node docs/refactoring/event-kernel/specs/validate-role-contract.mjs            # GREEN, run twice
node docs/refactoring/event-kernel/specs/validate-role-contract.mjs --mutations # all four RED, run twice
```

- Green run: `manifest errors: 0`, `example errors: 0`, `RESULT: GREEN`,
  exit 0. Two consecutive runs produced byte-identical output (no timestamps,
  no absolute paths, no randomness) — the determinism requirement.
- Mutations (all four executed, all four RED — requirement was at least two):

| Mutation | Applied as | RED trigger (first error) |
|---|---|---|
| M1 remove a manifest row | delete `documentation.implementation.reviewer` row, manifestDigest recomputed | `coverage: launch kind "documentation.implementation.reviewer" is required by the declared universe but has no binding row` |
| M2 duplicate a binding | second `development.planning.author` row, digest recomputed | `uniqueness: duplicate binding for launch kind "development.planning.author"` |
| M3 arbitrary contract field | `metadata: {note: "extension bag"}` on the example contract | `example.contract: additional property "metadata" is forbidden (closed shape; adding fields reopens EK-1)` |
| M4 executable route rule | `route.code = "module.exports = (ctx) => pickByStatus(ctx.task.status)"` | `example.routePolicyTable.rules[0].route: additional property "code" is forbidden (closed shape; adding fields reopens EK-1)` |

M1/M2 recompute the manifest digest before validating, so the kill is caused by
the admission rule itself, not by a stale digest.

## 12. Residual risks and assumptions

1. The five-workshop set and the development-only planning-cell freeze are the
   two judgment calls in the row universe. Both cite frozen inputs (D10,
   package locations, EK-6); if EK-8 discovers a genuine sixth workshop or a
   Formalization planning cell, that is an EK-1 reopening with a measured
   complexity delta, not a manifest edit.
2. The synthetic example's provider/model/tool strings are placeholders proving
   shape and digest discipline only; real values are EK-8 content.
3. The validator implements the draft-2020-12 subset actually used by the
   schema (documented keyword list in the script header). It is not a general
   JSON Schema engine; the schema deliberately avoids keywords outside that
   subset so the normative reading is unambiguous.
4. `prompt-budget-profile.schema.json` (paired ref/digest slots in the
   contract) is frozen by WP-16 part 3; this spec only pins the pairing shape.
5. `package.json` wiring of `validate:ek-admission-specs` is
   coordinator-owned; this package ships the standalone entry point.

## 13. Handoff (template)

- **Work package:** WP-16 part 2 of 3 — role contract schema + manifest + validator.
- **Role:** implementer (spec author; barred from WP-05/WP-17/WP-18).
- **Integration base SHA:** `21ba0816`; branch `ek1/wp16-role-contract`.
- **Files added:** `docs/refactoring/event-kernel/specs/canonical-role-contract.schema.json`,
  `docs/refactoring/event-kernel/specs/role-contract-manifest.json`,
  `docs/refactoring/event-kernel/specs/validate-role-contract.mjs`,
  `docs/refactoring/event-kernel/specs/ROLE-CONTRACT-SPEC.md`.
- **Files deleted:** none. Production `src/**` untouched; frozen inputs untouched.
- **Commands run:** validator green x2 (byte-identical), mutations x2 (all four
  RED), exit codes recorded in section 11.
- **Deliberate RED:** all four mutations executed and killed (section 11).
- **Key digests:** manifest `b1ef94c26e0d4b371f8385fb9f17bc075e81368320a19be76ca954c23edda58b`;
  example contract `323d15a14284bd8418d6243565e598e1ff399644b3d1e9397d5686ad3bebb868`;
  example operator contract `ee494ea89bcf089a241181eeca0eb81ae485ecb2921a3c526c175e02562787d3`.
- **No oracle weakened:** the plan's contract block is frozen verbatim; no
  schema constraint is looser than the plan law it encodes.
