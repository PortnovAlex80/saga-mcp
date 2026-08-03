# Wave Log — Process Modules Refactoring History

This file is the consolidated home for the **history** of refactoring waves
that touched `src/process-modules/application/`. It exists so that the
chronicle of "Wave X did Y" is preserved without polluting the source files,
which every reader (human or agent) pays for on every read.

The source files now keep only behavioral documentation — comments that help
understand the CURRENT code. Anything that narrates WHEN something changed,
cites a wave number, commit hash, or a spec section the reader does not have,
lives here instead.

This document is **historical**, not normative. It describes how the current
state came to be; the source code is the source of truth for current behavior.

## Timeline (condensed)

### Wave 1 — pure SPI layer
Introduced the driver-neutral SPI types under `domain/spi/`:
`ExecutionContextEnvelope`, `ModuleCompletion`, `NodeProductionEnvelope`,
`ProductRef`, `DriverNeutralExecutionReceipt`. Pure data types (interfaces),
no runtime edge. These are the forward shapes the later waves migrate toward.

### Wave 3 (W3-A1 … W3-A7) — driver-neutral envelope path
The big one. Added an OPTIONAL v2 driver-neutral envelope path alongside the
legacy `restoreFrame()` + magic-bindings path in `generic-flow-executor.ts`.

Key W3-A sub-steps referenced by the old source comments:
- **W3-A1** (spec §3/§4): the v2 envelope path wiring on
  `GenericFlowExecutorOptions.v2`. Activates only when v2 wiring is supplied
  AND the NodeRun repo exposes the v2 methods (`startV2` / `completeV2` /
  `readByExactCursor`). ADDITIVE — legacy runs execute the byte-identical
  `restoreFrame()` + magic-bindings path. Characterization tests proved no
  regression (the old plan's §16.9 dual-write guarantee).
- **W3-A3**: surface `installationId` / `packageDigest` on ProcessRunRecord.
  Until it landed, callers passed `null` and the assembler emitted the
  `'legacy:unpinned'` sentinel.
- **W3-A4**: `persistence/process-product-repository-v2.ts` — the exact-by-
  `(schemaId, ref, digest)` ProductRef port (spec §7). Replaced
  `listArtifactsForNodeInEpic` (the §9.11 "latest in run" imprecision).
- **W3-A5**: `execution-context-assembler.ts::assembleExecutionContext` —
  the immutable, no-fallback envelope assembler. Throws
  `UPSTREAM_PRODUCT_NOT_FOUND` on a missing declared predecessor; there is
  NO epic-scope / latest-in-run fallback (spec §9.11).
- **W3-A6**: the v2 NodeRun contract — `inputEnvelopeHash` / production
  envelope / transition cursor columns, dual-written by `startV2`/`completeV2`.
- **W3-A7**: the ContractBoundaryDecoder (shipped later; Wave 5 wired it in).

The v2 path also persisted the explicit `ModuleCompletion` column on NodeRun
so crash-resume could rebuild `NodeExecutionResult.completion` and settlement
could read the explicit certificate ref instead of falling back to magic
bindings.

### FU-A Wave 3 — crash-resume completion restore
Prefer the v2-shaped read (`readLastCompletedV2`) when the v2 channel is
active so the persisted `completion` column is visible to `restoreNodeResult`.
Without it, crash-resume after a terminal node would lose the certificate and
silently fall back to magic bindings. The §0.6.12 contract: a crash AFTER a
terminal node wrote its completion MUST be resumable with the completion intact.

### Wave 4 — settlement kernels emit explicit completion
The four module settlement kernels were migrated to emit
`completion: ModuleCompletion` in their `KernelHandlerResult`, rather than
encoding the certificate envelope into opaque `production.bindings`.

### Wave 4.5 — "Uncle Bob bridge": executor-side completion tracking
Side-channel for the LAST non-terminal `ModuleCompletion` seen across the
node chain. The terminal node (`complete-<code>`) is served by the
runtime-owned `process-outcome-emitter`, which does NOT emit a completion
(it is generic — forwards upstream bindings, not the typed completion
envelope). Without this bridge, `terminal.result.completion` was undefined,
the explicit certificate ref branch at `execute()` did not engage, and the
certificate resolved via magic bindings — which made Wave 5 (magic-bindings
deletion) unsafe.

The fix: track the LAST non-terminal completion as a side-channel (NOT
through `chainInput` — completion is a settlement-time concern, not a
data-chain value) and merge it onto `terminal.result.completion` when the
terminal emitter produced none. This was the linchpin Wave 5 needed.

`restoreLastNonTerminalCompletion` converges crash-resume and fresh runs on
the same `terminal.result.completion`.

### Wave 5 — magic-bindings deletion
Deleted the legacy magic-bindings fallback branch. After Wave 4 + Wave 4.5,
`completion` is the SOLE certificate channel — a terminal run without one is
a hard error (`SETTLEMENT_COMPLETION_MISSING`), not silent degradation.

### WAVE 6 (fourth audit, 2026-08-02) — restoreFrame retirement
The audit demanded: "Define a retention policy for legacy NodeRun rows,
perform migration or an explicit compatibility adapter at the boundary, then
remove restoreFrame + magic bindings from generic-flow-executor. Add
restoreFrame to a forbidden fallback ratchet."

Outcome:
- **Retention policy**: legacy NodeRun rows (written by the pre-Wave-3
  `nodeRunRepo.start`/`complete` path, or by the v2 path's dual-write of the
  legacy columns) carry the data the executor needs to reconstruct a
  NodeExecutionFrame: `outputRef`/`outputSchema`/`outputHash`/`outputBindings`
  → production, `executionReceipt` → receipt. These columns are RETAINED
  (dual-written by the v2 path) precisely so the boundary adapter can read
  them.
- **Boundary adapter**: `assembleFrameFromDurableNodeRuns` reads durable
  NodeRun rows DIRECTLY into a `NodeExecutionFrame` — the same shape
  `restoreFrame` produced — without the legacy mutable-bag reconstruction.
  It is the LIVE data source for every node executor's `ctx.frame`, AND for
  `declareUpstreamRefs` (v2 ProductRef derivation), AND for `mergeLegacyFrame`.
- `restoreFrame` was FULLY REMOVED: `walk()` calls the adapter by name, and
  `restoreFrame` is now in the forbidden-fallback gate
  (`no-execution-scoped-lookup.test.mjs`).

### Wave 8 — production-v2 blockers + mandatory completion
Resolved 8 production-v2 blockers. Notable for this module:

- **Wave 8 BLOCKER 1**: removed the former `runHasV2Marker` helper. It had
  gated v2 activation on a pre-existing v2-marker NodeRun row, which created
  a chicken-and-egg: a fresh run had no such row, so the first node used the
  legacy `start` path and the marker was never written — production never
  entered the v2 path. v2 now activates UNCONDITIONALLY when wiring is
  present. The marker columns (`inputEnvelopeHash` / `productionEnvelope`)
  are still WRITTEN by `startV2`/`completeV2` and still READ by the resume
  path; they just no longer gate activation.
- **Wave 8 HIGH 3** (mandatory completion): the certificate resolution is a
  SINGLE path AND a terminal run MUST produce an explicit `ModuleCompletion`.
  A terminal node that reaches settlement WITHOUT a completion is a CONTRACT
  VIOLATION — the kernel forgot to emit completion (a bug), or the
  failure-path swallowed a certificate-issuance error (HIGH 3 also removed
  those swallows). The executor MUST NOT silently degrade to
  `certificate = null`: that is silent data loss. Throw loudly. (A terminal
  completion WITHOUT `certificateRef` is still valid — non-certified
  outcome.)
- **Wave 8 HIGH 4**: `assertExplicitModuleCompletion` validates the
  completion envelope — terminal flag must be true at settlement, and when
  `certificateRef` is present its shape must be a valid content-addressed
  `ProductRef` (schemaId/ref/digest all non-empty strings).

### Wave 8.5 — mandatory terminal completion + integrity digest
The last 2 audit points. Finalized mandatory terminal completion and added
the integrity digest.

## Waves touching the scenario / protocol / cutover surface

The waves below touched the lifecycle-scenario manifest surface (Wave 1), the
Wave 2 immutable-installation layer, the Wave 4 protocol-recovery service, the
Wave 6 platform capability packages + tool-contribution installer, the Wave 7
scenario runtime (install + lock + runner), the Wave 11 cutover (installed
scenario package + legacy-run inventory), and the Wave 13 legacy-removal
preparation (composition relocation). The source files for these lanes were
stripped of their lane-banner + spec-section commentary and now keep only
behavioral docs.

### Wave 1 (W1-A3) — LifecycleScenarioManifest aggregate
`domain/spi/scenario-manifest.ts` introduced the one genuinely new domain
aggregate of Wave 1: a frozen, declarative, route-resolver-free description of
a multi-stage lifecycle scenario. Wave 1 only DEFINED + VALIDATED the manifest;
the scenario runtime (install + execute) was Wave 7. The manifest deliberately
REUSES the existing pure lifecycle types via import (`LifecycleIdentity`,
`StageBinding`, `TransitionTarget`, `LifecycleMappingExpression` from
`domain/lifecycle.ts`) rather than redefining them.

Two structural rules came from the Wave 1 spec:
- §6.4 — the type is structurally incapable of carrying an executable
  `routeResolver`. Routes are a declarative static `outcomeRoutes` table only.
  The validator additionally rejects any object that has a `routeResolver`
  own key.
- §3.5 — every field is plain canonical-serializable data. `validateLifecycle-
  ScenarioManifest` calls `assertCanonicalSerializable` first (rejecting
  functions/Maps/Sets/Symbols/undefined-in-arrays/class-instances/non-finite-
  numbers) before the structural rules.

Sibling dependencies the Wave 1 lanes owned: `canonical-serialization.js`
(W1-A1, `assertCanonicalSerializable`), `contract-ref.js` (W1-A5,
`ContractRef`), `tool-contribution.js` (W1-A6, `CapabilityRequirement`).

Mapping paths are dotted own-property traversals; `__proto__`, `prototype`,
and `constructor` are forbidden segments (validated by `isSafeMappingPath`,
plan §6.9.5) so a manifest path cannot enable a prototype-pollution read/write
when later dereferenced against a runtime frame.

### Wave 2 (W2-A1..W2-A5) — immutable-installation layer
Introduced the `installation_id` + `package_digest` columns on
`saga3_process_runs` (W2-A2 owns the SQL writer, C083 idempotent ALTERs in
`db.ts`), plus the canonical `ModuleInstallationRecord` (W2-A2), the
`PackageRegistry` port (W2-A5), and the per-run `PinnedInstallation` value
type (W2-A4). Pre-Wave-2 runs have BOTH columns NULL; a legacy nullable
adapter (plan §14.3.7) resolves their installation by `module_name`+
`module_version` through an injected fallback registry. Wave 13 was scheduled
to remove the nullable path entirely once all runs were pinned at start.

The W2-A4 adapter (`installation/persistence/process-run-installation-adapter
.ts`) reads/writes the two columns via RAW SQL rather than extending
`SqliteProcessRunRepository` so the existing hot file was untouched (spec §5
anti-scope) and no new composition-root Rule 6 edge was introduced. A row with
exactly one of the two columns NULL is treated as corrupt and throws
`PROCESS_RUN_PIN_PARTIAL` — the schema invariant is "both set or both NULL".

### Wave 4 (W4-A1..W4-A5) — generic protocol recovery
The protocol-recovery lane introduced the `protocol_step_complete` MCP tool a
Runtime contributes on behalf of every managed NodeProtocol. The application
service (`application/protocol-checkpoint-service.ts`, W4-A5) is the ONLY
place that loads the active ProtocolRun + canonical NodeProtocolDefinition,
runs the before-complete evidence gate, delegates the transition decision to
the pure W4-A2 ProtocolRuntime state machine, persists the completed step +
advances the run inside one atomic port call, and returns a typed receipt.

Sibling lanes: W4-A1 owns `persistence/protocol-run.ts` (the
ProtocolRunRepository port + types + sqlite adapter), W4-A2 owns
`application/protocol-runtime.ts` (the pure transition state machine), W4-A3
owns `application/protocol-evidence.ts` (evidence categories + verifier
registry `verifyStepEvidence`). These files were NOT present in the isolated
W4-A5 worktree; W4-A5 declared LOCAL STRUCTURAL PORT INTERFACES (marked
`LOCAL_ISOLATION_ALIAS`) mirroring the spec verbatim so the file compiled in
isolation. At cherry-pick the integrator either swapped the aliases for the
real imports or left them in place (both compile because the shapes are
identical).

The default Runtime evidence verifier (`defaultEvidenceVerifier`) requires
each required `EvidenceRequirement` to be matched by a submitted evidence
item with the same category and matching contractRef; optional requirements
are not enforced. A module verifier that needs stricter semantics replaces it
via the `StepEvidenceVerifierRegistry`. The replay path returns a replay
receipt for an already-terminal step row (plan §8.7: a resumed worker re-
submitting a checkpoint must not error even if the run has since advanced past
it); this check runs BEFORE the stale-step check so a crash between persist
and worker-receipt never blocks the resume.

### Wave 6 (W6-A1, W6-A2) — contributable MCP tool surface
Removed the hand-maintained `ALL_TOOLS` array in `src/index.ts` by introducing
a contributable surface: a module can register a tool without the gateway
source changing.

- W6-A1 (`src/application/tool-contribution-installer.ts`) — the single
  application-layer entry point that validates each `ModuleToolContribution`
  structurally (reusing the Wave 1 SPI validator), validates the namespaced
  `logicalId` (at least one namespace separator, alphabet-restricted), the
  exact semver `version`, resolves each handler from a `HandlerRegistry`, and
  registers each `(contribution, handler)` into the `ModuleToolRegistry`. A
  batch with ANY defect installs NOTHING and throws `MODULE_TOOL_INSTALL_FAILED`
  carrying every reason (fail-fast over the whole batch).
- W6-A2 (`application/capability-packages.ts`) — the five versioned PLATFORM
  Capability Packages the Runtime contributes on its own behalf:
  `platform.tasks`, `platform.artifact-graph`, `platform.repository`,
  `platform.worker-completion`, `platform.protocol-checkpoint` (the last re-
  uses the W4-A5 contribution verbatim). The W6-A1 installer runs them
  through the SAME namespace/collision pipeline as module-contributed tools.

Note (conveyor-wave-review ПОВТОРНАЯ ПРОВЕРКА 2026-08-02): `worker_next` is
intentionally EXCLUDED from the worker-completion package. "One launch = one
card": an assigned worker that already holds a card must not re-enter the
dispatch queue. The dispatcher (`saga-dispatch`) invokes `worker_next` as a
raw MCP tool, not through this package; the server-side fence rejection in
`handleWorkerNext` is the hard guarantee.

### Wave 7 (W7-A1..W7-A6) — generic scenario runtime
The scenario runtime that consumes a `LifecycleScenarioManifest` end to end
WITHOUT touching the legacy `lifecycle-orchestrator.ts` (Wave 11 owned the
cutover; Wave 13 owned cumulative-frame removal). The new runtime composes
the SAME injected ports the legacy orchestrator already uses
(`ProcessModuleExecutor`, `ProcessRunRepository`, `LifecycleRunRepository`)
plus new sibling ports: `ScenarioModulePackageRegistry`,
`ScenarioModuleLockStore`, `ScenarioOutputStore`, `ScenarioRouter`.

- W7-A1 owns the `saga3_scenario_module_locks` table + the
  `ScenarioInstallationStore` port (`installation/scenario-store.ts`).
- W7-A2 (`application/scenario-module-lock.ts`) — resolves a scenario's
  `ModuleSelector`s to exact installed module identities at install time
  against the Wave 2 `PackageRegistry`, producing an immutable content-
  addressed `ScenarioModuleLock` (one `PinnedScenarioModule` per stage). The
  `lockDigest = sha256Hex(canonicalJson(pins))` (pins deterministically sorted
  by `stageId`) makes any drift detectable at LifecycleRun start.
- W7-A3 — the pure scenario-compiler port (validates manifest shape +
  mapping type-checking + route completeness + graph reachability + terminal
  coverage + budget validation).
- W7-A4 — the declarative `ScenarioRouter`. Resolves the next transition
  target by looking it up in the manifest's STATIC `outcomeRoutes` table
  (there is NO `routeResolver` function anywhere). May also enforce
  transition + reentry budgets and throw `ScenarioBudgetExhaustedError`.
- W7-A5 — the `ScenarioOutputStore`. Persists each public stage output ONCE,
  keyed by `(scenarioRunId, stageId, contentHash)`. Exposes the run's
  lifecycle variables so mappings resolve `{ runtime: ... }` expressions
  WITHOUT a cumulative frame (replaces the legacy monolithic frame that re-
  persisted every prior stage on every transition).
- W7-A6 (`application/scenario-runner.ts`) — `ScenarioInstaller` +
  `ScenarioRunner`. The runner is stateless; lease / watchdog / failure
  handling mirror the legacy orchestrator's proven implementation. The
  genuinely new behavior is (a) no `routeResolver`, (b) per-stage public
  output storage instead of a cumulative frame, and (c) complete lock pinning
  at start.

Sibling-port declaration policy: the Wave 7 lanes were built in parallel
worktrees off the SAME frozen commit; the sibling ports did NOT exist in this
worktree yet. To build in isolation against the frozen contract, the sibling
ports were declared in the consumer file as structural interfaces, mirroring
`installation/domain/installer.ts`'s policy of "STRUCTURAL consumer-side
declarations". TypeScript structural typing makes them assignment-compatible
with the canonical declarations at integration time.

### Wave 11 (W11-A1, W11-A2, W11-A5) — cutover preparation
Wave 11 is PREPARATION only — no legacy code deletion, no NOT NULL enforcement
on `installation_id`, no removal of the built-in catalog (those are Wave 13).

- W11-A1 (`installation/product-delivery-scenario-package.ts`) — the INSTALLED
  Product Delivery Lifecycle Scenario package: the single artifact that turns
  Wave 7's scenario runtime into a scenario the cutover can switch NEW runs
  onto. It is the canonical home of the Product Delivery scenario manifest
  (built directly from the frozen `productDeliveryLifecycle` definition — pure
  data, no `routeResolver`). The legacy compatibility bridge re-exports these
  manifests under the legacy names. The legacy per-run `discoveryGate` flag is
  encoded as TWO distinct manifests (permissive = every Discovery outcome
  forwards to Formalization; strict = non-go outcomes terminate).
- W11-A2 — the composition-loader seam. New runs with an active scenario
  installation route through the loader's `installed` branch; legacy runs
  keep using the legacy composition wiring. Both paths coexist.
- W11-A5 (`application/legacy-run-inventory.ts`) — the four legacy-run tools:
  INVENTORY (`LegacyRunInventory`, an append-only ledger recording every
  compatibility-path use), MIGRATION (`planLegacyRunMigration`, pure planner),
  ROLLBACK (`planLegacyRunRollback`, pure inverse planner), and PACKAGE-
  RETENTION (`evaluatePackageRetentionCondition`, the single pure predicate
  that gates Wave 13 removal: zero un-migrated runs, zero recent compatibility
  uses, rollback grace elapsed, no blocking runs). The `legacy-engine-
  executor` adapter was RETIRED in the saga4 cutover (Phase 3 deleted the dead
  code) but is kept in the `COMPATIBILITY_PATHS` enum as a HISTORICAL record
  so the append-only ledger can still classify old uses.

### Wave 13 (W13-A6) — composition relocation (Rule 6 ratchet convergence)
The concrete manual wiring for the Product Delivery lifecycle USED TO live in
`composition/product-lifecycle-runtime.ts` (the source of all 34 Rule 6
edges). W13-A6 moved it to `src/app/product-lifecycle-runtime.ts` so the
`composition/` directory no longer carries Rule 6 edges (R6: 34 → 0). `src/
app/` is NOT Rule-6-scanned and is NOT in the W11 cutover NEW_CORE set, so
the wiring's `modules/*` and `persistence/sqlite-*` imports are the legitimate
legacy composition surface Wave 13 was ratcheting down. The composition root
now consumes the wiring through the W11-A2 composition-loader seam. Behaviour
was preserved unchanged (Wave 13 anti-scope §4: "NO behavior changes — legacy
paths are already dead"); the historical import path is kept via a thin re-
export shim.

The Product Delivery wiring carries two notable production fixes preserved as
inline context:
- **Wave 8 BLOCKER 1** — the v2 driver-neutral envelope path was ADDITIVE in
  Wave 3 but never ACTIVATED in production (the four executors were
  constructed without `v2:` options, so `v2ChannelFor` returned null and
  every ProcessRun ran the legacy `start`/`complete` path). The fix wired v2
  into all four executors. The W3-A4 `SqliteProcessProductRepositoryV2` is
  bridged to the W3-A5 assembler's `ProcessProductRepository` port with a
  fallback to durable NodeRun rows when the content-addressed product store
  does not contain a product (settlement productions live on NodeRun
  `output_*` columns, not in the product store).
- **WAVE-3 / Wave 4 / Wave 4.5 / Wave 5** — the four settlement kernels
  (discovery, formalization, development, delivery) were migrated to emit
  their own `ProcessOutcomeCertificate` + explicit `ModuleCompletion`, then
  the magic-bindings fallback branch was deleted (Wave 5). Each kernel's
  `certificateRepo` is wired here so the kernel AUTHORS its own certificate.

## Where each piece of removed history now lives

For traceability, the major comment blocks that were removed from the source
files and condensed into the timeline above:

- `generic-flow-executor.ts` — "W3-A1 (spec §3/§4)" import-block banner;
  the `v2` option's "byte-identical to the pre-Wave-3 executor ...
  characterization tests prove no regression (plan §16.9)" paragraph; the
  "WAVE 5 CUTOVER + WAVE 8 HIGH 3" settlement comment; the "WAVE 8 HIGH 3
  (mandatory completion)" block; the "W3-A1 + Wave 8 BLOCKER 1: chicken-and-
  egg" block; the "WAVE 6 (fourth audit 2026-08-02) — restoreFrame fully
  retired" block; the "Wave 4.5 bridge" paragraphs; the "FU-A Wave 3"
  resume-read comment; the "FU-A Wave 3: persist the explicit
  ModuleCompletion" completeV2 comment; the "W3-A1 (spec §3/§4): dual-write"
  comment; the "WAVE 6 AUDIT" multi-paragraph banner above
  `assembleFrameFromDurableNodeRuns`; the "W3-A1 v2 path helpers" banner;
  the "Wave 8 BLOCKER 1: former runHasV2Marker removed" NOTE; the
  "W3-A1 + WAVE 8 HIGH 4" `assertExplicitModuleCompletion` banner; the
  "WAVE 8 HIGH 4" inline assertions.
- `node-executor.ts` — the "Wave 3 (W3-A1)" SPI-type import comment; the
  "W3-A1 — v2 driver-neutral executor SPI (spec §3)" banner; the
  "W3-A1 (spec §3)" optional-envelope field comments; the "W3-A1 (spec §3/§4)"
  completion field comment.
- `execution-context-assembler.ts` — the "W3-A5" header block; the "WAVE 6
  STATUS" block; the "ISOLATION NOTE — W3-A4 port" block; the "W3-A4 port
  shape" banner; the various "W3-A3" / "Wave 5 migrates" / "plan §X"
  references throughout the pin-resolver and option comments.

### Scenario / protocol / cutover surface (Wave 1 / 2 / 4 / 6 / 7 / 11 / 13)

- `process-modules/application/scenario-runner.ts` (W7-A6) — the "W7-A6 —
  ScenarioInstaller + ScenarioRunner services" header block citing the
  WAVE7-SCENARIO-SPEC §1/§2/§3, the W07-a6 task path, and the "Wave 11
  cutover owns the rewrite; Wave 13 owns cumulative-frame removal" forward
  references; the "Sibling-port declaration policy" block referencing
  parallel worktrees off frozen commit `174a757`, plan §0.5.2 serial
  integration, and `installation/domain/installer.ts`; the per-interface
  "W7-A2/A3/A4/A5" lane citations and "Wave 2 ModuleInstallationId" pinning
  notes; the "Sibling-port declarations (W7-A2/A3/A4/A5)" banner; the
  "Wave 11 cutover" / "Wave 13 deletes the legacy path" forward references in
  the `ScenarioExecutionResult` / `ScenarioRunner` JSDoc; the step comments
  citing "W7-A3 compiler", "W7-A2 lock", "W3-A3 / spec §6" ProcessRun pin,
  "W7-A4 router", "W7-A5 store (NO cumulative frame, spec §13.21)"; the
  `withStageOutput` "W0-A7 campaign fixture and W7-A5" note; the
  `mapLifecycleValues` "At Wave 11 cutover the integrator MAY replace this"
  comment.
- `process-modules/application/protocol-checkpoint-service.ts` (W4-A5) — the
  "W4-A5 — Generic protocol checkpoint application service" header citing
  WAVE4-PROTOCOL-RECOVERY-SPEC §1/§3, ADR-019 §3, plan §8.3/§8.4/§8.6/§8.7/
  §9.7, and the W04-a5 task path; the "OWNED FILE" enumeration block; the
  "Isolation (parallel lane)" block listing W4-A1/W4-A2/W4-A3 sibling owners
  and the "Wave 1 lanes used applies here" reference; the
  "LOCAL_ISOLATION_ALIAS" markers on `ProtocolRunRecord`,
  `ProtocolStepRunRecord`, `EvidenceVerificationResult`,
  `ProtocolTransitionDecision`, `StepEvidenceVerifier`,
  `ProtocolRunRepository`, `NodeProtocolResolver`,
  `ProtocolTransitionResolver`, `StepEvidenceVerifierRegistry`; the
  `domain/spi/tool-contribution.ts (W1-A6)` parallel pattern reference; the
  `PROVISIONAL_CONTRACT_DIGEST` "until W1-A5 ContractSchemaRegistry pins them"
  note; the per-error "ADR-019 §3 / plan §8.7" citations; the per-step "plan
  §8.4 / C026", "W4-A2 ProtocolRuntime", "W4-A3 verifier" citations in
  `applyCheckpoint`; the `buildProtocolStepCompleteToolContribution` "Wave 4
  registration time" / "W4-A6 attaches the authority guard when it lands"
  notes.
- `process-modules/application/scenario-module-lock.ts` (W7-A2) — the
  "W7-A2 — ScenarioModuleLock" header citing WAVE7-SCENARIO-SPEC §0/§1 and
  the W07-a2 task path; the "What this module owns" + "Purity + dependency
  direction (Rule 5 / Rule 2)" + "Cross-lane isolation (INTEGRATION NOTE)"
  blocks referencing plan §6.3.2/§6.6/§6.7, W0-A1, W2-A5, W2-A2, W7-A1; the
  "Wave 1 pure-SPI barrel" / "Wave 2 installation layer" / "Frozen canonical
  primitives" import-section banners; the "INTEGRATION NOTE (integrator,
  Wave 7 cherry-pick): ScenarioInstallationStore" block referencing the
  "W7-A1-OWNED" search marker and WAVE7-SCENARIO-SPEC §1 row W7-A1; the
  per-symbol "plan §6.6-6.7, §4 identity rules", "W2-A4 PinnedInstallation
  analogue", "Wave 2 ModuleInstallationId" citations; the "resolveScenario-
  ModuleLock — the pure resolution core / heart of W7-A2" banner; the "Wave 7
  ScenarioInstaller (W7-A6) calls at install time, after W7-A3 validates and
  W7-A1 inserts the row" banner; the "LifecycleRun (W7-A6 ScenarioRunner)"
  banner; the "Type re-exports" block.
- `app/product-lifecycle-runtime.ts` (W13-A6) — the "W13-A6 — Concrete Product
  Delivery lifecycle wiring (composition-loader seam)" header citing
  WAVE13-LEGACY-REMOVAL-SPEC lane W13-A6 §5, the W13-a6 task path, plan
  §0.16/§0.16.11/§18; the "What this file owns" / "Why src/app/ is the
  correct home" / "Why a separate file" / "Dependency direction (ratchet,
  W0-A1)" / "The W11-A2 composition-loader seam" / "Purity" blocks; the
  `ProductLifecycleRuntimeOptions.packageInstallation` "W13-AUDIT §18.5/§18.9"
  JSDoc; the "W13-A6: this body was relocated verbatim from composition/"
  JSDoc on `createProductLifecycleRuntime`; the "Wave 8 BLOCKER 1 —
  production v2 cutover wiring" inline block; the "Wave 8 BLOCKER 1: bridge
  the W3-A4 ... to the W3-A5 assembler" inline block; the "Wave 7: inject the
  concrete process-product repository" / "Wave 8 BLOCKER 1: reuse the shared
  processProductRepo" comments; the "Uncle Bob Wave 4" / "Wave 5 deletes
  that branch" certificateRepo notes on each kernel handler; the "CONVEYOR
  Wave 7: injected concrete adapters" / "CONVEYOR Wave 7: injected brief-
  provisioning port" / "CONVEYOR-MENTAL-MODEL (doc line 291)" comments; the
  "Wave 8 MEDIUM 7" settlementService note; the "W13-AUDIT §18.5 / §18.9: the
  production module packages were installed by the composition loader"
  comment; the "W13-A3: ProcessOutputPayloadRegistry replaced" / "W13-AUDIT
  §18.5: pin each ProcessRun" comments.
- `process-modules/domain/spi/scenario-manifest.ts` (W1-A3) — the "W1-A3 —
  LifecycleScenarioManifest" header citing plan §1/§3.5/§6.2/§6.3.2/§6.4/
  §6.9.5/§0.4.11; the "Purity contract (plan §3.5)" enumeration; the "Sibling
  dependencies (built in parallel Wave 1 lanes)" block; the "Anti-scope:
  Wave 1 only DEFINES + VALIDATES ... Wave 7" note; the per-section
  "ModuleSelector (plan §6.2, §6.3.2)", "ScenarioStageBinding (plan §6.3.2)",
  "Policies (plan §6.2.7)", "Budgets (plan §6.2.10, §6.2.11)",
  "LifecycleScenarioManifest (plan §6.2)", "ValidationResult (mirrors the
  Wave 1 SPI validator contract, §2)", "isSafeMappingPath (plan §6.9.5)",
  "validateLifecycleScenarioManifest (plan §6.2, §6.4, §3.5, §0.4.11)"
  banners; the per-field "Wave 7" forward references; the inline "plan §6.4"
  citations on the routeResolver absence checks and error messages.
- `process-modules/application/capability-packages.ts` (W6-A2) — the "W6-A2 —
  Versioned platform Capability Packages" header citing WAVE6-MCP-GUARDS-SPEC
  lane W6-A2 §1/§2, plan §0.9 / Phase 7, §0 key finding; the "OWNED FILE"
  block; the "What a Capability Package is" / "Why these five packages" /
  "Dependency direction (Rule 4b ratchet)" blocks; the per-section "Wave 6
  uses '0.1.0', mirroring ... W1-A2", "Wave 6 platform capability package ...
  W6-A1 catches", "Wave 1 SPI ToolIdempotency", "W4-A5 buildProtocolStep-
  CompleteToolContribution", "gateway guard (W6-A3)", "contribution installer
  (W6-A1)" citations; the "WAVE-3 (conveyor-wave-review ПОВТОРНАЯ ПРОВЕРКА
  2026-08-02)" block on `worker_next` exclusion; the "Wave 6 contribution
  installer (W6-A1) installs every package" / "Wave 11 cutover" / "W2-A6
  ModuleToolRegistry" citations in the catalog section; the "Wave 1
  ValidationError" / "Wave 1 SPI validator" / "Wave 6 contribution installer
  relies on this property" citations in the validation section.
- `application/tool-contribution-installer.ts` (W6-A1) — the "W6-A1 — Module
  tool contribution installer" header citing WAVE6-MCP-GUARDS-SPEC §1/§2/§3,
  plan §0.9.3/§11.4/§11.5/§14.8.1, the W06-a1 task path; the "Anti-scope
  (frozen spec §3)" block referencing "Wave 11 cutover", "Wave 13", "Wave
  8/9"; the "Dependency direction (W0-A1 ratchet)" block; the "Wave 2 registry
  collision/lookup tokens" / "Wave 1 SPI validator" / "Wave 2 ModuleTool-
  Registry" citations; the per-section "Namespace alphabet + shape validation
  (plan §11.4.1)", "Validate the namespaced shape of a tool logicalId (plan
  §11.4.1)", "Validate a tool version is an exact semver (plan §11.4.1)",
  "Reduce a Wave 1 ValidationResult" banners; the install JSDoc's "Wave 1
  SPI, reused", "Wave 2 ModuleToolRegistry", "plan §11.5 placement of
  collision detection at installation" citations.
- `process-modules/installation/persistence/process-run-installation-adapter.ts`
  (W2-A4) — the "ProcessRunInstallationAdapter" header citing WAVE2-IMMUTABLE-
  INSTALLATION-SPEC §1/§3/§4/§5, plan §14.3.7, C083, and the W13-A6
  allowlist-removal note; the "Why raw SQL instead of extending Sqlite-
  ProcessRunRepository" enumeration; the "Legacy nullable adapter (plan
  §14.3.7)" block; the "INTEGRATION NOTE (integrator, Wave 2 cherry-pick):
  ModuleInstallationRecord and LegacyInstallationResolver are defined here
  ONLY because W2-A4 runs in isolation and W2-A2/W2-A5 have not landed"
  block; the "LegacyInstallationResolver — the fallback port ... Structural
  subset of W2-A5's PackageRegistry" banner; the "ModuleInstallationRecord
  (local isolation copy — canonical owner is W2-A2)" banner; the per-method
  "spec W2-A4", "spec §4, §14.3.7", "Wave 13 removes this method entirely"
  citations.
- `process-modules/application/legacy-run-inventory.ts` (W11-A5) — the
  "W11-A5 — Legacy-run inventory, migration, rollback, package-retention"
  header citing WAVE11-CUTOVER-SPEC §0/§2/§3/§4 and the W11-a5 task path; the
  "WHAT THIS FILE OWNS" enumeration; the "WHY THIS FILE IS A NEW, PURE
  APPLICATION FILE (spec §3 anti-scope)" block referencing "Wave 13"; the
  "PURITY / DEPENDENCY TIER" block; the per-enum-member "W7-A8", "RETIRED in
  the saga4 cutover (Phase 3 deleted the adapter)", "W2-A4 §14.3.7", "Wave 13
  removes it" citations on COMPATIBILITY_PATHS; the "Wave 13" forward
  references throughout the migration/rollback/retention sections; the
  "Persistence port (consumer-side structural declaration) ... Mirrors the
  sibling-port declaration policy in scenario-runner.ts" banner.
- `process-modules/installation/product-delivery-scenario-package.ts`
  (W11-A1) — the "W11-A1 — Installed Product Delivery Lifecycle Scenario
  package" header citing WAVE11-CUTOVER-SPEC §2, plan §0.14/§0.14.11, the
  W11-a1 task path; the "What this file owns" block referencing "Wave 7's
  scenario runtime", "Wave 11 cutover", "W10-A4 campaign package", and the
  four production modules; the "Canonical manifest producer (cutover ratchet
  rule 1)" block citing the cutover ratchet tests and plan §6.4; the
  per-lane "W7-A6 ScenarioInstaller", "W7-A2 + W7-A1 per-stage exact-pin"
  citations; the "Dependency direction (ratchet, W0-A1)" + "Purity /
  serializability" blocks; the per-section "Wave 1 froze the shape", "plan
  §6.4", "Wave 7 ScenarioInstaller resolves each selector", "Wave 7 binds
  kind to a registered strategy" citations; the "Discovery gate selection
  (plan §6.4)" banner; the "Install entry point" block's per-step "W7-A3
  compiler port", "W7-A2 lock-resolver port", "W7-A2 lock-store port" 
  citations; the "Wave 11 W11-A2 composition loader wires the concrete
  sqlite-backed ports" note.
