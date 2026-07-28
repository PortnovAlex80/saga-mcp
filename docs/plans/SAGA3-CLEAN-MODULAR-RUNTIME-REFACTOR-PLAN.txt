SAGA 3 CLEAN MODULAR RUNTIME REFACTORING PLAN

Document date: 2026-07-28
Document status: implementation plan, not an implementation record
Primary objective: make Saga 3 reliably execute arbitrary Process Module packages and compose them into arbitrary Lifecycle Scenario packages without changing Runtime source code

0. PARALLEL EXECUTION ROADMAP

0.1. OPERATING MODEL

0.1.1. Use logical waves of no more than eight worker agents. The primary agent remains the architecture and integration owner and is not counted as a worker lane.

0.1.2. Every worker uses an isolated Git worktree, branch, build output, SQLite database, and generated workspace root.

0.1.3. Before a wave starts, the integrator publishes one frozen input commit containing the applicable contracts, a path-ownership table, accepted dependencies, test command, and exit gate.

0.1.4. Each file has one writer per wave. Agents may read another lane but may not edit its files, shared barrels, composition roots, generated snapshots, or migration bootstrap.

0.1.5. Each agent returns one architecture-focused commit, changed-file list, targeted test evidence, unresolved risks, and confirmation that it did not change a frozen contract.

0.1.6. Agents never merge their own branches. The integrator reviews and cherry-picks commits serially in dependency order, runs the wave gate after every pick, and creates one checkpoint commit before the next wave.

0.1.7. A required change to a frozen contract stops the affected lanes. The integrator resolves the contract centrally, publishes a new checkpoint, and restarts dependent work. Agents must not patch around a missing contract with metadata, fallback searches, aliases, or module-specific Runtime logic.

0.1.8. One persistence owner controls all SQL migration numbering and shared schema bootstrap changes in a wave.

0.1.9. Test agents report failures against the owning lane. They do not opportunistically edit another lane’s production files.

0.1.10. If the execution environment supports fewer than eight concurrent workers, keep these ownership lanes and execute them as smaller subwaves against the same frozen checkpoint.

0.1.11. An unused worker slot is safer than manufacturing work that crosses an ownership boundary.

0.2. PARALLELISM CLASSIFICATION

0.2.1. Safe in parallel after contracts are frozen: new adapters behind separate ports, separate repositories, isolated validators, package resources, module-local protocols, independent fixtures, architecture tests, conformance tests, and documentation.

0.2.2. Conditionally parallel: persistence and application services, Runtime services and their tests, or module manifest and module subtrees. These require frozen interfaces, disjoint paths, and one integration owner.

0.2.3. Serial by design: public SPI shape, canonical identity rules, package digest rules, migration ordering, edits to core executor hot files, lifecycle orchestrator adoption, MCP gateway adoption, composition cutover, and final legacy deletion.

0.2.4. Single-writer hot files include process-module.ts, generic-flow-executor.ts, lm-node-executor.ts, lifecycle-orchestrator.ts, lifecycle-router.ts, lifecycle-mapper.ts, tracker-view/claude-runner.mjs, src/index.ts, composition-root.ts, orchestrate-cli.ts, and shared SQLite migration files.

0.2.5. Protocol persistence must exist before tracker and hook conversion.

0.2.6. CallInstance identity must exist before MCP error-to-draft correlation.

0.2.7. Immutable package resolution and AgentLaunchSpec must exist before moving production skills and templates.

0.2.8. Explicit ModuleCompletion and exact products must exist before the new Lifecycle Scenario Runtime.

0.2.9. Formalization must pass the full vertical-slice gate before the remaining production modules migrate in parallel.

0.2.10. All production modules must pass the same conformance kit before Product Delivery cutover.

0.3. WAVE 0: BASELINE AND EXECUTABLE ARCHITECTURE RULES

0.3.1. Plan mapping: Phase 0 and Sections 13, 15, and 16.

0.3.2. W0-A1 owns repository-wide dependency and forbidden-import tests.

0.3.3. W0-A2 owns current execution-profile, reviewer-selection, runner, workspace, and hook characterization tests.

0.3.4. W0-A3 owns MCP catalog, authority, structured-error, and current actionable-hint characterization tests.

0.3.5. W0-A4 owns lifecycle routing, mapping, lock, cumulative-frame, restart, and transaction characterization tests.

0.3.6. W0-A5 owns package identity, version collision, resource mutation, installation pin, and replay characterization tests.

0.3.7. W0-A6 owns fixtures reproducing the 2026-07-28 context, provenance, receipt, acceptance, and recovery failures.

0.3.8. W0-A7 owns isolated synthetic LM, Kernel, Human, and External module and scenario fixtures.

0.3.9. W0-A8 owns architecture decisions, compatibility inventory, test grouping, and isolated test-runner configuration.

0.3.10. Serial gate: terminology, dependency direction, known-debt allowlist, current failure fixtures, and synthetic fixture boundaries are frozen without production behavior changes.

0.4. WAVE 1: PURE SPI VALIDATION AND PROOF

0.4.1. Plan mapping: Phase 1.

0.4.2. Serial precondition: the architecture owner alone publishes the pure SPI checkpoint for manifests, ContractRef, envelopes, ModuleCompletion, NodeProtocol, recovery, tools, assistance, generic commands, and identities.

0.4.3. W1-A1 owns canonical JSON validation, serialization, hashing, and negative value tests.

0.4.4. W1-A2 owns ProcessModuleManifest validation.

0.4.5. W1-A3 owns LifecycleScenarioManifest, stage, route, graph, and budget validation.

0.4.6. W1-A4 owns FlowDefinition and NodeProtocol validation, including rejected unsupported semantics.

0.4.7. W1-A5 owns ContractSchemaRegistry ports, in-memory codecs, and contract compatibility tests.

0.4.8. W1-A6 owns recovery, tool contribution, capability, guard, and assistance definition validation.

0.4.9. W1-A7 owns LegacyProcessModuleAdapter and legacy serialization isolation.

0.4.10. W1-A8 owns two unrelated package fixtures, one scenario fixture, round-trip tests, and cross-contract conformance tests.

0.4.11. Serial gate: all manifests round-trip through canonical JSON; functions, Maps, Sets, undefined values, non-enumerable behavior, ignored conditions, and unsupported retry semantics fail installation.

0.5. WAVE 2: IMMUTABLE INSTALLATION AND REGISTRIES

0.5.1. Plan mapping: Phases 2 and 3, excluding live LM driver migration.

0.5.2. Serial precondition: package identity, digest, store, installation, dependency-lock, and registry port contracts are frozen; one SQL owner reserves migrations.

0.5.3. W2-A1 owns ModulePackageStore and the content-addressed filesystem adapter.

0.5.4. W2-A2 exclusively owns module installation records, SQLite migration, repository, version immutability, and deletion restriction.

0.5.5. W2-A3 owns package installer, resource resolver, dependency lock, activation, corruption detection, and replay verification.

0.5.6. W2-A4 owns ProcessRun installation pinning and the explicit legacy nullable adapter.

0.5.7. W2-A5 owns PackageRegistry, InstalledProcessModule, and plugin binding.

0.5.8. W2-A6 owns handler, capability, schema, guard, tool, and AgentDriver registry implementations in separate new files.

0.5.9. W2-A7 owns resource traversal, symlink escape, hash mismatch, version collision, atomic installation, and source mutation tests.

0.5.10. W2-A8 owns third-package installation proof, registry collision tests, and reconciliation tests for the current package prototype.

0.5.11. Serial integration order: store, installer, installation persistence, ProcessRun pin, registries, tests.

0.5.12. Serial gate: installed bytes replay after source mutation or deletion, a released version cannot change digest, a pinned installation cannot be nullified, and a third module installs without a central catalog edit.

0.6. WAVE 3: DURABLE EXECUTION PRIMITIVES

0.6.1. Plan mapping: Phase 4.

0.6.2. Serial precondition: ExecutionContextEnvelope, receipt, production, product reference, ModuleCompletion, AgentDriverPort, and NodeRun v2 persistence contracts are frozen.

0.6.3. W3-A1 owns ProcessProductRepository and its adapters.

0.6.4. W3-A2 owns NodeRun v2 persistence for input hashes, predecessors, cursor, transition, definition digest, protocol digest, receipt, and production.

0.6.5. W3-A3 owns ExecutionContextAssembler and exact upstream product loading.

0.6.6. W3-A4 owns contract boundary decoding and validation services.

0.6.7. W3-A5 owns explicit ModuleCompletion and immutable module output persistence.

0.6.8. W3-A6 owns WorkerExecutionPort, driver-neutral receipt contracts, and Saga board compatibility adapter files outside the hot executors.

0.6.9. W3-A7 owns task metadata and legacy chain-binding projection adapters.

0.6.10. W3-A8 owns migration, hash, stale-state, exact-product, crash, and replay tests.

0.6.11. Serial integration: one core owner edits node-executor.ts and generic-flow-executor.ts; a second owner then edits lm-node-executor.ts; a third owner then activates exact AgentLaunchSpec resolution.

0.6.12. Serial gate: a crash after worker completion resumes from the exact receipt and product, with no latest-execution, process-scope, task-metadata, or magic-binding reconstruction.

0.7. WAVE 4: PROTOCOL AND UNIVERSAL RECOVERY

0.7.1. Plan mapping: Phase 5.

0.7.2. Serial precondition: protocol state, evidence, recovery, authority-intersection, and transition contracts are frozen.

0.7.3. W4-A1 exclusively owns ProtocolRun and ProtocolStepRun persistence and migrations.

0.7.4. W4-A2 owns the pure protocol transition state machine.

0.7.5. W4-A3 owns standard evidence categories, package verifier binding, and before-complete gates.

0.7.6. W4-A4 owns RecoveryIssue, RecoveryDecision, RecoveryAction, and RecoveryFeedback services.

0.7.7. W4-A5 owns generic protocol checkpoint application service and tool contribution.

0.7.8. W4-A6 owns per-step authority intersection and stale-state rejection.

0.7.9. W4-A7 owns branch, repeat, retry, pause, resume, illegal-transition, and crash tests.

0.7.10. W4-A8 owns recovery conformance tests across two unrelated modules, including producer reentry, human action, escalation, exhaustion, and restart.

0.7.11. Serial gate: exact protocol resume works, required evidence cannot be skipped, and one recovery engine repairs unrelated modules without Runtime semantics.

0.8. WAVE 5: WORKSPACE, TRACKER, CALL INSTANCES, AND AGENT ASSISTANCE

0.8.1. Plan mapping: Phase 6.

0.8.2. Serial precondition: immutable resource resolution, ProtocolRun read model, CallInstance, AgentLaunchSpec, and AgentAssistanceSnapshot contracts are frozen.

0.8.3. W5-A1 owns pinned package resource resolution and WorkspaceProjection.

0.8.4. W5-A2 owns CallInstance repository, state machine, draft reuse, sealing, and receipt association.

0.8.5. W5-A3 owns deterministic TrackerRenderer.

0.8.6. W5-A4 owns AgentAssistanceSnapshot rendering, modes, budgets, escaping, and deduplication.

0.8.7. W5-A5 exclusively owns the structured Claude context-hook adapter and tracker-reminder replacement.

0.8.8. W5-A6 exclusively owns claude-runner integration with AgentLaunchSpec, package resources, and correct author or reviewer selection.

0.8.9. W5-A7 owns separation and enforcement of agent built-in capabilities from MCP grants.

0.8.10. W5-A8 owns workspace, call crash, tracker regeneration, cross-execution, hook security, context budget, and weak-model tests.

0.8.11. Serial integration order: ProtocolRun and CallInstance, workspace, projections, hook, runner, capability enforcement.

0.8.12. Serial gate: tracker and assistance regenerate from durable state, failed drafts remain repairable, successful drafts seal, and a weak model receives exact bounded guidance from pinned resources.

0.9. WAVE 6: MCP CONTRIBUTIONS, GUARDS, AND STRUCTURED ERRORS

0.9.1. Plan mapping: Phase 7.

0.9.2. Serial precondition: ModuleToolContribution, platform capability, ToolExecutionContext, CallInstance correlation, receipt, guard, and ActionableToolError contracts are frozen.

0.9.3. W6-A1 owns module tool contribution installation, namespace, alias, version, and collision validation.

0.9.4. W6-A2 owns versioned platform Capability Packages for shared tools.

0.9.5. W6-A3 owns the generic server-side GatewayGuard pipeline.

0.9.6. W6-A4 owns optional agent-side PreToolUse projection without authority semantics.

0.9.7. W6-A5 owns ActionableToolError, enrichment, escaping, and repair references.

0.9.8. W6-A6 owns call correlation, common receipt envelope, and structured MCP serialization.

0.9.9. W6-A7 owns execution-scoped tool catalog and generated descriptions from pinned contracts.

0.9.10. W6-A8 owns contribution, collision, denial-before-handler, structured error, idempotency, and transport conformance tests.

0.9.11. Serial integration: one gateway owner alone changes src/index.ts after all services merge.

0.9.12. Serial gate: a synthetic module contributes a tool, template, checklist, guard, and repair hint without gateway source changes, and structured errors survive transport.

0.10. WAVE 7: LIFECYCLE SCENARIO PACKAGE AND RUNTIME

0.10.1. Plan mapping: Phase 8.

0.10.2. Serial precondition: explicit ModuleCompletion, exact public products, scenario manifest, scenario lock, mapping, routing, and handoff contracts are frozen.

0.10.3. W7-A1 owns ScenarioPackageStore, installation service, installation persistence, and package replay.

0.10.4. W7-A2 owns exact module-lock resolution and StageRun or LifecycleRun pinning persistence under the single SQL owner.

0.10.5. W7-A3 owns scenario compiler and mapping contract type checking.

0.10.6. W7-A4 owns declarative predicate routing, graph validation, terminal outcomes, and explicit budgets.

0.10.7. W7-A5 owns content-addressed public stage outputs, lifecycle variables, and exact handoffs.

0.10.8. W7-A6 owns generic ScenarioInstaller and ScenarioRunner services outside existing orchestrator hot files.

0.10.9. W7-A7 owns scenario invalidity, lock, replay, upgrade, branching, repeated-module, and scaling tests.

0.10.10. W7-A8 owns the explicit legacy Product Delivery scenario adapter and compatibility tests.

0.10.11. Serial integration: one lifecycle owner alone changes lifecycle-orchestrator.ts, lifecycle-router.ts, lifecycle-mapper.ts, and their transaction wiring.

0.10.12. Serial gate: a scenario reorders and reuses modules, pins its complete lock at start, survives upgrades, stores each public output once, and contains no hidden executable routing.

0.11. WAVE 8: FORMALIZATION VERTICAL-SLICE PILOT

0.11.1. Plan mapping: Phase 9.

0.11.2. W8-A1 owns the Formalization package manifest, installation binding, public contracts, and package exports.

0.11.3. W8-A2 owns product-contract node protocols and package-local resources.

0.11.4. W8-A3 owns use-case node protocols and package-local resources.

0.11.5. W8-A4 owns acceptance and reconciliation node protocols and package-local resources.

0.11.6. W8-A5 owns architecture and recovery node protocols and package-local resources.

0.11.7. W8-A6 owns Formalization ports and handler adapters that remove global database and infrastructure access.

0.11.8. W8-A7 owns verifier, acceptance, exact product, output, reviewer, and recovery contributions.

0.11.9. W8-A8 owns author, review, kernel, retry, recovery, restart, settlement, and package isolation conformance tests.

0.11.10. Only W8-A1 edits the central Formalization manifest. Other lanes create isolated node or contribution subtrees and submit manifest entries to W8-A1.

0.11.11. Serial gate: Formalization runs completely through pinned package resources and standard interfaces with no fallback context, global resource lookup, or direct infrastructure dependency.

0.12. WAVE 9: REMAINING PRODUCTION MODULE MIGRATIONS

0.12.1. Plan mapping: Phases 10 and 11.

0.12.2. Serial precondition: Formalization has passed the complete vertical-slice and recovery conformance gates.

0.12.3. W9-A1 owns the Discovery manifest, package resources, NodeProtocols, and central package exports.

0.12.4. W9-A2 owns Discovery proposal, normalization, readiness, diagnosis, brief product, tool contributions, and legacy engine adapter subtrees without editing the central manifest.

0.12.5. W9-A3 owns the Development manifest, planning and verification protocols, resources, and central package exports.

0.12.6. W9-A4 owns Development child execution, provenance, port, handler, and product contribution subtrees without editing the central manifest.

0.12.7. W9-A5 owns the Delivery manifest, flow protocols, resources, and central package exports.

0.12.8. W9-A6 owns Delivery external effects, human approval, idempotency, ports, receipts, and contribution subtrees without editing the central manifest.

0.12.9. W9-A7 owns the shared module conformance runner and cross-module isolation checks.

0.12.10. W9-A8 owns migration compatibility, restart, recovery, exact-output, and package isolation integration tests.

0.12.11. No migration lane may modify Runtime, global registries, runner, gateway, lifecycle composition, or another module.

0.12.12. Serial gate: Discovery, Development, and Delivery independently pass the same installation, execution, review, recovery, restart, and output conformance kit as Formalization.

0.13. WAVE 10: ARBITRARY EXTENSIBILITY PROOF AND AUTHORING KITS

0.13.1. Plan mapping: Phase 12.

0.13.2. W10-A1 owns an LM Marketing package.

0.13.3. W10-A2 owns an External SEO or Analytics package.

0.13.4. W10-A3 owns a Human Director Approval package.

0.13.5. W10-A4 owns the Campaign Lifecycle Scenario using those packages.

0.13.6. W10-A5 owns Module Authoring Kit, package templates, and module validator CLI.

0.13.7. W10-A6 owns Scenario Authoring Kit, scenario templates, and scenario validator CLI.

0.13.8. W10-A7 owns package and scenario describe interfaces and generated architecture views.

0.13.9. W10-A8 owns genericity, repeated-module, conditional-route, restart, recovery, and no-Runtime-diff proof tests.

0.13.10. Serial gate: Marketing, SEO or Analytics, Director Approval, and Campaign install and execute without any Runtime, global runner, gateway, catalog, or existing-module source change.

0.14. WAVE 11: PRODUCT SCENARIO CUTOVER PREPARATION

0.14.1. Plan mapping: Phase 13 preparation only.

0.14.2. W11-A1 owns the installed Product Delivery Lifecycle Scenario package.

0.14.3. W11-A2 owns the generic package and scenario composition loader.

0.14.4. W11-A3 owns generic application command and result adapters.

0.14.5. W11-A4 owns CLI compatibility and scenario selection adapters.

0.14.6. W11-A5 owns legacy-run inventory, migration, rollback, and package-retention tooling.

0.14.7. W11-A6 owns real Product Delivery integration tests.

0.14.8. W11-A7 owns Campaign integration and coexistence tests.

0.14.9. W11-A8 owns tightened architecture checks and compatibility-usage reporting.

0.14.10. Serial cutover: one owner switches new runs to installed scenarios in a dedicated commit. No legacy code is deleted in that commit.

0.14.11. Serial gate: all new Product Delivery and Campaign runs use installed scenarios while old pinned runs still replay through explicit compatibility adapters.

0.15. WAVE 12: END-TO-END AND FAULT-INJECTION HARDENING

0.15.1. Plan mapping: Phase 14.

0.15.2. All W12 lanes are test and diagnosis owners. They do not patch shared core files; failures return to the owning subsystem and fixes integrate serially.

0.15.3. W12-A1 owns package mutation, corruption, version upgrade, installation retention, and replay tests.

0.15.4. W12-A2 owns ProcessRun, NodeRun, receipt, and production crash-point tests.

0.15.5. W12-A3 owns ProtocolRun, Recovery, CallInstance, tool effect, and sealing crash-point tests.

0.15.6. W12-A4 owns lifecycle transition, mapping, lock, upgrade, cancellation, and restart fault tests.

0.15.7. W12-A5 owns invalid package, schema, capability, mapping, route, authority, and structured-error security tests.

0.15.8. W12-A6 owns intensive weak-model and assistance-budget scenario runs.

0.15.9. W12-A7 owns repeated real Product Delivery runs with product idea A and product idea B.

0.15.10. W12-A8 owns repeated Campaign runs and cross-scenario isolation.

0.15.11. Serial gate: both scenarios complete repeatedly across injected failures without manual database, metadata, tracker, workspace, or artifact repair.

0.16. WAVE 13: FINAL LEGACY REMOVAL

0.16.1. Plan mapping: final part of Phase 13 after Phase 14 hardening.

0.16.2. Serial precondition: the retention policy proves that no supported active or replayable run requires the target compatibility path.

0.16.3. W13-A1 owns central built-in catalog and task-kind resolution removal.

0.16.4. W13-A2 owns global skill, template, tracker, and workspace special-case removal.

0.16.5. W13-A3 owns routeResolver, product-specific lifecycle policy, and output payload registry removal.

0.16.6. W13-A4 owns latest-execution, process-scope, metadata, and chain-binding fallback removal.

0.16.7. W13-A5 owns old hook, stale workflow hint, and textual actionable-error removal.

0.16.8. W13-A6 owns obsolete composition-root, CLI branch, and product runtime wiring removal.

0.16.9. W13-A7 owns obsolete adapter, table, migration, and retained-package cleanup under the single persistence owner.

0.16.10. W13-A8 owns final dependency, dead-code, package isolation, replay, and end-to-end verification.

0.16.11. The integrator cherry-picks cleanup commits one at a time and reruns replay and architecture gates after every removal.

0.16.12. Final gate: no new-core architecture exceptions, hidden fallbacks, global module resources, hard-coded module composition, or unsupported legacy path remain.

1. BUSINESS OBJECTIVE

1.1. Saga 3 must move a subject through a declared sequence of module steps and across module boundaries without manual database repair, hidden context reconstruction, or module-specific Runtime patches.

1.2. A module may represent any bounded business capability. Examples include Discovery, Formalization, Development, Delivery, Marketing, SEO, Legal Review, Financial Approval, Director Approval, Research, Compliance, Incident Response, or a future capability not known when Runtime is built.

1.3. A Lifecycle Scenario is a separate versioned composition of module packages. It defines which modules participate, how outputs become downstream inputs, how outcomes route, and when the scenario terminates. A module never selects or starts its downstream module.

1.4. Success is not defined by isolated unit tests. Success requires repeated complete scenario runs, including restart and recovery, through the same generic Runtime.

2. ROOT PROBLEM

2.1. No complete production-like Lifecycle Scenario has yet run repeatedly from initial idea to final release without manual intervention. Therefore the current architecture has not proved its primary business purpose.

2.2. The failures reported on 2026-07-28 are not independent defects. Missing brief production, incomplete provenance, execution-scoped reads, lost receipts, no-op ports, mutable tracker state, null content hashes, skill drift, and retry inconsistencies are manifestations of unstable boundaries.

2.3. Module semantics and execution mechanics are only partially separated. Important facts travel through several competing channels: in-memory frame bindings, task metadata, execution identifiers, module tables, workspace files, and fallback database searches.

2.4. Module behavior is scattered across TypeScript definitions, global skills, global templates, global MCP tools, runner prompt code, tracker files, persistence adapters, and product-specific composition roots. An agent maintaining one module cannot inspect one local package and understand the complete contract.

2.5. Runtime still contains implicit module selection and product-specific composition. Adding a new module or scenario can require edits to catalogs, resolvers, runner logic, tool registration, output payload registration, and composition code.

2.6. Assistance for weak models is necessary but is not the root fix. Trackers, templates, context hooks, actionable errors, guards, and recovery must operate on top of correct module and Runtime contracts.

3. NON-NEGOTIABLE ARCHITECTURE RULES

3.1. Process Module Package owns the blueprint and semantics of one bounded capability.

3.2. Lifecycle Scenario Package owns cross-module composition and routing.

3.3. Runtime owns only generic execution physics.

3.4. Every boundary is represented by a serializable, versioned, validated contract.

3.5. No persisted definition contains a function, closure, class instance, non-enumerable behavior, or environment-dependent value.

3.6. Runtime never switches on module name, module kind, stage name, artifact type, reason code, or domain-specific field.

3.7. A module never imports Runtime adapters, Runtime persistence implementations, another module implementation, or a Lifecycle Scenario implementation.

3.8. A Lifecycle Scenario references module contracts and installed package identities, never module implementation classes.

3.9. Task metadata and workspace files are projections for workers. They are never the authoritative source of execution lineage or protocol state.

3.10. A completed action is represented by a durable receipt. A produced domain value is represented by a durable production envelope. Receipt and production are never overloaded into one object.

3.11. Released package identity is immutable. The same package name and version cannot be installed with different content in production mode.

3.12. Every run pins exact immutable package bytes, not only a name, version, or hash.

3.13. Compatibility code lives in explicit adapters outside the new core and is removed after migration.

3.14. The architecture is enforced by dependency tests and package validators, not only documentation.

3.15. Generic Runtime contracts are driver-neutral. WorkIntent, board task, epic, Claude Code, repository, and artifact graph identities belong to adapters or optional capability contracts, not the base Process Module SPI.

3.16. Module domain and application code depend only on ports. A module package may ship infrastructure adapters that implement those ports, but its domain logic never calls global database, filesystem, runner, or MCP singletons.

4. TARGET CLEAN ARCHITECTURE

4.1. Domain contract layer contains pure serializable value types:

4.1.1. ProcessModuleManifest.
4.1.2. LifecycleScenarioManifest.
4.1.3. FlowDefinition and standard node contracts.
4.1.4. NodeProtocolDefinition.
4.1.5. ExecutionContextEnvelope.
4.1.6. NodeExecutionReceipt.
4.1.7. NodeProductionEnvelope.
4.1.8. ProcessModuleOutputEnvelope.
4.1.9. RecoveryIssue and RecoveryFeedback.
4.1.10. ModuleToolContribution and CapabilityRequirement.
4.1.11. AgentAssistanceDefinition and GuardBinding.

4.2. Application layer contains generic use cases:

4.2.1. Install and validate a module package.
4.2.2. Install and validate a Lifecycle Scenario package.
4.2.3. Start, resume, and replay LifecycleRun.
4.2.4. Start, resume, and replay ProcessRun.
4.2.5. Execute a Flow node.
4.2.6. Execute a NodeProtocol step.
4.2.7. Materialize and seal a call instance.
4.2.8. Render tracker and agent-assistance projections.
4.2.9. Authorize and dispatch a tool call.
4.2.10. Record and route recovery.

4.3. Ports define required capabilities without infrastructure dependencies:

4.3.1. ModulePackageStore.
4.3.2. ModuleInstallationRepository.
4.3.3. ScenarioInstallationRepository.
4.3.4. ProcessRunRepository.
4.3.5. LifecycleRunRepository.
4.3.6. NodeRunRepository.
4.3.7. ProtocolRunRepository.
4.3.8. ProcessProductRepository.
4.3.9. CallInstanceRepository.
4.3.10. ToolReceiptRepository.
4.3.11. WorkerExecutionPort.
4.3.12. ToolGatewayPort.
4.3.13. WorkspaceProjectionPort.
4.3.14. AgentContextHookPort.
4.3.15. Clock, identifier, lease, and transaction ports.
4.3.16. ContractSchemaRegistry.
4.3.17. AgentDriverPort.

4.4. Adapters implement ports:

4.4.1. SQLite repositories.
4.4.2. Filesystem content-addressed package store.
4.4.3. Claude Code worker and context-hook adapter.
4.4.4. MCP server and gateway adapter.
4.4.5. Git and repository adapters.
4.4.6. Human interaction adapters.
4.4.7. External provider adapters.

4.5. Composition root installs packages, resolves dependencies, binds adapters, and starts scenarios. Product-specific composition is outside Runtime core.

5. PROCESS MODULE PACKAGE

5.1. Split structural manifest from executable installation binding.

5.1.1. ProcessModuleManifest is pure canonical data.
5.1.2. ProcessModulePlugin supplies trusted handler factories and adapter factories referenced by the manifest.
5.1.3. InstalledProcessModule binds the immutable package snapshot to resolved handler, tool, schema, protocol, and resource registrations.

5.2. ProcessModuleManifest contains:

5.2.1. Manifest format version.
5.2.2. Module identity: name, semantic version, display metadata, optional category.
5.2.3. Runtime compatibility range.
5.2.4. Input and output schema references.
5.2.5. Finite local outcomes.
5.2.6. Serializable internal FlowDefinition.
5.2.7. NodeProtocol definitions for LM-operated nodes.
5.2.8. Artifact and product contracts.
5.2.9. Policy, invariant, recovery, and acceptance definitions.
5.2.10. Required platform capability references.
5.2.11. Contributed tool contracts.
5.2.12. Resource index.
5.2.13. Handler references with exact versions.
5.2.14. Assistance and guard declarations.

5.3. Package resources are module-relative and co-located:

5.3.1. Semantic skills.
5.3.2. Node instruction fragments.
5.3.3. Reviewer skills.
5.3.4. Document templates.
5.3.5. MCP call templates.
5.3.6. Checklists.
5.3.7. JSON schemas.
5.3.8. Actionable error hints.
5.3.9. Generated module description.
5.3.10. Package-local tests and fixtures.

5.4. Recommended package source layout:

5.4.1. modules/<module-name>/manifest.
5.4.2. modules/<module-name>/flow.
5.4.3. modules/<module-name>/contracts.
5.4.4. modules/<module-name>/nodes/<node-id>/protocol.
5.4.5. modules/<module-name>/nodes/<node-id>/resources.
5.4.6. modules/<module-name>/tools.
5.4.7. modules/<module-name>/handlers.
5.4.8. modules/<module-name>/ports.
5.4.9. modules/<module-name>/adapters.
5.4.10. modules/<module-name>/tests.

5.5. Package installation rules:

5.5.1. Resolve every declared resource under the package root.
5.5.2. Reject absolute paths, path traversal, undeclared files needed at runtime, missing resources, duplicate logical identifiers, and hash mismatches.
5.5.3. Canonicalize the manifest and dependency lock.
5.5.4. Compute resource hashes and package digest.
5.5.5. Atomically copy the complete package into an immutable content-addressed store.
5.5.6. Persist installation identity, manifest snapshot, package digest, immutable store location, resource index, handler versions, dependency lock, and installation status.
5.5.7. Verify stored bytes against the digest before activation and replay.
5.5.8. Reject a different digest under an already released name and version. Development mode must use a prerelease version or explicit build identity.
5.5.9. Never use ON DELETE SET NULL for a package installation pinned by a run. Installed packages referenced by runs are immutable and deletion-restricted.
5.5.10. Bind handler and policy identities to actual packaged code or deployment bundle digests. Caller-declared version strings alone do not prove executable identity.

5.6. Current uncommitted package code is a prototype and must not be accepted as final until it stores immutable bytes, uses serializable records instead of Map as persisted contract data, enforces version immutability, and makes installation pinning mandatory for the new execution path.

6. LIFECYCLE SCENARIO PACKAGE

6.1. Lifecycle Scenario is a first-class versioned package, not a hard-coded application service.

6.2. LifecycleScenarioManifest contains:

6.2.1. Manifest format version.
6.2.2. Scenario identity and semantic version.
6.2.3. Input and final output contracts.
6.2.4. Entry stage.
6.2.5. Stage bindings.
6.2.6. Deterministic outcome routes.
6.2.7. Typed input and output mappings.
6.2.8. Typed entry, exit, and route guard references.
6.2.9. Terminal statuses.
6.2.10. Scenario-level retry, pause, cancellation, and escalation policy.
6.2.11. Required module selectors and capability requirements.
6.2.12. Explicit transition and reentry budgets.

6.3. StageBinding is a standard interface:

6.3.1. Stable stage identifier.
6.3.2. Exact or resolvable module requirement.
6.3.3. Input mapping from scenario root, prior stage outputs, and immutable runtime fields.
6.3.4. Output mapping from the standard ProcessModuleOutputEnvelope.
6.3.5. Complete route table for every declared module outcome.
6.3.6. Optional declarative predicates with deterministic priority.
6.3.7. Optional typed scenario guard references.

6.4. No LifecycleScenarioManifest may contain routeResolver or any executable closure.

6.5. Per-run routing choices use one of two clean mechanisms:

6.5.1. A small validated declarative predicate grammar over the immutable scenario frame.
6.5.2. An explicit decision Process Module stage for complex semantic routing.

6.6. Scenario installation resolves every module selector to an exact InstalledProcessModule and writes a scenario module lock.

6.7. LifecycleRun pins the exact scenario installation and the complete module lock at start. Installing a newer module while a scenario is running cannot alter later stages of that run.

6.8. A stage may use any module package and the same module may appear in multiple stages. Runtime must not derive a stage from module kind or task-kind prefix.

6.9. Scenario validation proves:

6.9.1. Entry stage exists.
6.9.2. All routes target existing stages or valid terminals.
6.9.3. Every module outcome has exactly one deterministic route.
6.9.4. All stages are reachable.
6.9.5. Mappings use safe own-property paths.
6.9.6. Mapped values satisfy downstream input schemas.
6.9.7. Output mappings reference fields exported by the module output contract.
6.9.8. Required package installations and capabilities exist.
6.9.9. Route predicates are serializable and deterministic.
6.9.10. Cycles have explicit budgets and cannot execute under an implicit stages-times-constant limit.

6.10. A scenario depends only on public module contracts and named output ports. It does not import a module settlement policy, repository, hash helper, or implementation-specific payload type.

6.11. Store each public stage output once. Store each downstream handoff as its own immutable mapped value. Do not copy the root input and all previous stage payloads into every transition.

6.12. Lifecycle Scenario Runtime uses a generic execution scope and input envelope. Project and epic identifiers remain optional compatibility scope fields, not mandatory lifecycle concepts.

7. STANDARD MODULE FLOW AND NODE INTERFACES

7.1. Every Flow node shares:

7.1.1. Stable identifier.
7.1.2. Node kind.
7.1.3. Versioned input contract.
7.1.4. Versioned output contract.
7.1.5. Declared runtime events.
7.1.6. Timeout, retry, recovery, and idempotency policy.
7.1.7. Exact executor or handler reference.

7.2. Supported node kinds remain generic: LM, Kernel, Human, External, and Composite.

7.3. Kind-specific definitions add data but do not change the common execution result interface.

7.4. LM nodes reference one explicit execution profile and one NodeProtocol. Profile selection by module-kind prefix or first matching profile is forbidden.

7.4.1. Contract references contain schema identity, version, and digest.
7.4.2. Module input, node input, node output, outcome output, and scenario handoff are decoded and validated at their boundaries.
7.4.3. A declared Flow transition condition must use a supported deterministic policy reference or predicate. Unsupported free-form condition strings are rejected at installation rather than silently ignored.

7.5. NodeExecutionResult contains separate fields:

7.5.1. runtimeEvent.
7.5.2. executionReceipt.
7.5.3. production, optional.
7.5.4. recoveryIssue, optional.
7.5.5. diagnostics, optional and non-authoritative.

7.5.6. Terminal module completion is an explicit standard ModuleCompletion envelope. GenericFlowExecutor must not extract certificate, authority, or output semantics from magic production binding keys.

7.6. NodeProductionEnvelope contains:

7.6.1. Schema identifier.
7.6.2. Stable product reference.
7.6.3. Content hash.
7.6.4. Canonical opaque payload or content-addressed payload reference.
7.6.5. Typed lineage references.
7.6.6. Module-owned opaque bindings only when declared by schema.

7.7. The next node receives an ExecutionContextEnvelope assembled from durable state, never a mutable in-memory frame:

7.7.1. Package, process, node, attempt, and execution identities.
7.7.2. Frozen authority.
7.7.3. Immutable ProcessRun input.
7.7.4. Exact declared upstream products.
7.7.5. Recovery feedback, when applicable.
7.7.6. Scenario and stage identities, when applicable.

7.8. Task metadata mirrors selected envelope fields for the worker but is not read as authoritative state by Runtime or module validators.

8. NODE PROTOCOL

8.1. Flow describes coarse business nodes. NodeProtocol describes ordered actions inside an LM node.

8.2. NodeProtocolDefinition contains:

8.2.1. Identifier and version.
8.2.2. Owning Flow node identifier.
8.2.3. Entry step, stable step identifiers, and deterministic step transitions. A linear protocol is the simplest valid graph, while declared branch and repeat transitions remain possible.
8.2.4. Per-step instructions and resources.
8.2.5. Per-step allowed tool references.
8.2.6. Per-step evidence requirements.
8.2.7. Per-step assistance configuration.
8.2.8. Per-step guard bindings.
8.2.9. Node completion evidence.
8.2.10. Explicit recovery entry steps.
8.2.11. Retry semantics that are either fully implemented by Runtime or rejected as unsupported during installation.

8.3. Runtime owns ProtocolRun and ProtocolStepRun state. Module code never updates protocol persistence directly.

8.4. Step completion occurs only after required durable evidence exists. Evidence may be a successful tool receipt, a produced artifact reference, a trace reference, a human receipt, an external receipt, or a module verifier receipt.

8.5. Runtime understands standard evidence categories but never domain meaning. Module-specific evidence is checked by a versioned verifier registered by the package.

8.6. If semantic work cannot be inferred from a tool receipt, the worker issues a generic protocol step completion command and Runtime verifies declared evidence before advancing.

8.7. Protocol state survives worker death, process restart, review retry, and recovery.

8.8. Recovery is one generic Runtime protocol used by every module and every node kind. A module declares recovery policy; it does not implement a private recovery engine.

8.9. A verifier, reviewer, guard, or executor reports a structured RecoveryIssue containing the failed contract and product references, producer node and attempt, verifier identity and digest, stable reason code, failed conditions, expected and actual evidence, repairable fields, and a human-readable explanation.

8.10. Module policy maps a RecoveryIssue to one standard RecoveryAction: retry current node, return to a declared producer node, enter a declared recovery node, request human action, pause for an external condition, escalate, or terminate with a declared outcome.

8.11. Runtime validates the declared recovery target, persists the issue and decision, opens a new attempt, and supplies RecoveryFeedback together with the original immutable inputs, accepted predecessor products, and failed product. Prior attempts and products are never overwritten.

8.12. The repairing worker receives the exact failed artifact or product, exact verifier feedback, original acceptance contract, relevant prior receipts, and the package-pinned resources for the target step. It never has to infer why the previous attempt failed from logs or task status.

8.13. Positive acceptance is also generic. A package-declared verifier or acceptance capability emits a typed acceptance receipt; Runtime atomically records that receipt and advances the declared transition. Runtime does not know what SRS, proposal, SEO report, release candidate, or director approval means.

8.14. Recovery stays inside a Process Module until that module emits a public outcome or exhausts its declared policy. A Lifecycle Scenario may then route that public outcome, but it does not inspect or repair module-internal state.

9. AUTHORITATIVE STATE AND PERSISTENCE

9.1. Add or finalize immutable package installation storage.

9.2. Add scenario installation storage and scenario module locks.

9.3. Require module installation identity on new ProcessRuns.

9.4. Require scenario installation identity on new LifecycleRuns.

9.5. Pin module installation identity on every StageRun and ProcessRun.

9.6. Persist NodeRun input envelope hash, execution receipt, production envelope, recovery issue, and protocol identity separately.

9.7. Add ProtocolRun and ProtocolStepRun persistence with explicit state transitions.

9.8. Add CallInstance persistence with:

9.8.1. Tool contract reference and version.
9.8.2. Protocol step reference.
9.8.3. Attempt.
9.8.4. Workspace path.
9.8.5. Draft content hash.
9.8.6. State: materialized, edited, validated, submitted, succeeded, failed, sealed, abandoned.
9.8.7. Last structured error.
9.8.8. Successful tool receipt reference.

9.9. Store call payload files in the execution workspace, but keep their authoritative identity, hashes, state, and receipt in Runtime persistence.

9.10. Add ProcessProductRepository as the standard query path for products emitted by nodes.

9.11. Remove resolver logic that searches by latest execution, falls back from execution scope to process scope, or reconstructs production from incidental artifacts. A resolver receives exact product references from the execution envelope.

9.12. Preserve current tables during migration with additive schema changes and explicit compatibility adapters.

9.13. Add LifecycleVariableStore or equivalent content-addressed public output store so mappings resolve only declared stage values instead of rebuilding a cumulative lifecycle frame.

9.14. Persist explicit transition cursor, predecessor NodeRun references, selected transition, node definition digest, protocol digest, and input envelope hash. Resume loads the persisted cursor rather than recomputing the next node from the latest completed row.

10. LM EXECUTION CELL AND WEAK-MODEL SUPPORT

10.1. The standard assistance stack is:

10.1.1. Startup prompt and resolved semantic skill.
10.1.2. Runtime-rendered tracker.
10.1.3. Materialized document and call templates.
10.1.4. Checklists.
10.1.5. Claude Code Agent Context Assistance hook.
10.1.6. Structured actionable MCP errors.
10.1.7. Tool allowlist and gateway guards.
10.1.8. Kernel verification and durable recovery.

10.2. Tracker is a read-only projection generated from package manifest, Flow, NodeProtocol, ProcessRun, NodeRun, ProtocolRun, products, receipts, and recovery state.

10.3. The model does not mark steps complete, author machine bindings, maintain artifact registers, or reconstruct errors in the tracker.

10.4. Runtime writes a structured agent-assistance projection next to the tracker. The Claude hook reads this exact execution-scoped file instead of parsing Markdown or scanning directories.

10.5. Agent assistance is module-configurable content executed by one platform hook adapter.

10.6. Assistance events are step-enter, post-tool-success, post-tool-error, before-submit, recovery-enter, and resume.

10.7. Assistance rendering uses bounded semantic blocks: goal, current step, next action, exact resource paths, allowed tools, completion criteria, last error, repair fields, and retry instruction.

10.8. Assistance modes are compact, guided, and intensive. Runtime selects effective intensity from module recommendation, model capability, and operator policy.

10.9. Repeated hook messages use deduplication keys, state versions, once-per-attempt controls, and character or token budgets.

10.10. Full template contents are not repeated after every tool call. The hook normally supplies exact paths and a short action. Detailed cards appear on step entry, error, recovery, and submit.

10.11. Call instance lifecycle is template to working draft to validation to tool receipt to sealed instance. An error preserves the same working draft for progressive correction.

10.12. Runtime emits an exact AgentLaunchSpec containing installation ID, package digest, node ID, execution profile ID, NodeProtocol ID, resolved resource digests, effective capability set, author or reviewer role, and driver configuration.

10.13. The agent runner consumes AgentLaunchSpec and never re-resolves a profile or skill from task kind.

10.14. Agent execution receipts are driver-neutral. Saga board WorkIntent, task, worker, and execution IDs are adapter data inside the receipt, not mandatory base fields.

10.15. Author and reviewer launches resolve distinct package-pinned skills. Reviewer selection must not be overwritten by the author semantic skill.

10.16. Separate agent capabilities such as workspace read, workspace edit, repository search, and command execution from MCP tool grants. Per-step MCP restriction does not automatically restrict Claude built-in tools; the agent driver or sandbox must enforce its own capability set.

11. MCP TOOL OWNERSHIP

11.1. MCP transport, gateway, execution fence, authority, audit, registry, common error envelope, and dispatch are platform responsibilities.

11.2. Shared capabilities such as tasks, artifact graph, repository access, worker completion, and protocol checkpointing are versioned platform Capability Packages.

11.3. Domain-specific tools are contributed by the owning Process Module Package. Discovery proposal, normalization, readiness, and diagnosis tools are examples.

11.4. ModuleToolContribution declares:

11.4.1. Namespaced logical identifier and version.
11.4.2. Input and output schemas.
11.4.3. Handler reference.
11.4.4. Call template and checklist references.
11.4.5. Actionable error hint reference.
11.4.6. Guard bindings.
11.4.7. Idempotency and side-effect classification.

11.5. Installation validates tool collisions, handler coverage, capability dependencies, schema availability, and resource availability.

11.6. Runtime exposes only the tools permitted by the intersection of package profile, current protocol step, frozen execution authority, and platform policy.

11.7. Gateway guards are authoritative. Optional Claude Code PreToolUse guards only provide an earlier rejection and cannot replace server enforcement.

11.8. All validation failures use ActionableToolError:

11.8.1. Stable code.
11.8.2. Human-readable message.
11.8.3. Field path.
11.8.4. Expected and actual values.
11.8.5. Source of the correct value.
11.8.6. Exact call instance reference.
11.8.7. Checklist reference.
11.8.8. Tracker reference.
11.8.9. Resume step.
11.8.10. Retry permission.

11.9. Every consequential call carries a platform-owned call-instance correlation value that the gateway validates and strips before module handler input decoding. Runtime must never infer which workspace file produced an MCP argument object.

11.10. The gateway preserves ActionableToolError as structured data across MCP serialization. It must not flatten the repair contract into one textual Error string.

11.11. Tool listing for a managed execution is assembled from its pinned platform capabilities and module installation. Operator and interactive catalogs are separate compatibility surfaces.

12. MODULE AND SCENARIO DISCOVERABILITY

12.1. Each installed package exposes a generated read-only description containing contracts, Flow, NodeProtocols, resources, capabilities, tools, outcomes, and recovery paths.

12.2. Each installed Lifecycle Scenario exposes its stage graph, exact package lock, mappings, routes, and terminal statuses.

12.3. Add read-only describe interfaces for agents and operators. An agent maintaining one module must not need a repository-wide search to discover its architecture.

12.4. Generate documentation and tracker route summaries from manifests. Do not duplicate authoritative architecture manually in skills.

12.5. Provide a Module Authoring Kit and Scenario Authoring Kit with validators, fixtures, contract tests, and package templates.

13. CURRENT CODE FINDINGS THAT DRIVE THE REFACTOR

13.1. src/process-modules/domain/process-module.ts uses global skill names and workspace-relative resource paths rather than package-local immutable resources.

13.2. src/process-modules/application/execution-profile-resolver.ts imports the built-in catalog and contains prefix and first-profile selection heuristics.

13.3. src/process-modules/application/process-execution-workspace.ts resolves resources against the entire project workspace and treats Markdown tracker state as worker-maintained.

13.4. tracker-view/claude-runner.mjs resolves skills through one global skill root and assembles module semantics inside a platform runner.

13.5. tracker-reminder.mjs is a real Claude Code PostToolUse context hook, but it parses Markdown and injects only a generic reminder.

13.6. src/process-modules/application/node-executors/lm-node-executor.ts uses task and WorkIntent projection as part of execution context and still carries compatibility assumptions from Discovery.

13.7. src/process-modules/application/generic-flow-executor.ts carries mutable frame and binding behavior that has already caused receipt and restart ambiguity.

13.8. src/process-modules/domain/lifecycle.ts permits a non-serializable routeResolver function.

13.9. src/process-modules/lifecycles/product-delivery-lifecycle.ts imports concrete module schemas and policies and embeds product-specific validation and route behavior.

13.10. src/process-modules/composition/product-lifecycle-runtime.ts manually wires all module runtimes, handlers, adapters, output resolvers, and providers.

13.11. src/process-modules/application/lifecycle-orchestrator.ts hashes only the serializable portion of a lifecycle definition and resolves the current installation at stage execution time instead of pinning the complete module set at LifecycleRun start.

13.12. ProcessOutputPayloadRegistry allows Lifecycle Runtime to reopen module-specific storage after completion. A complete immutable module output envelope should cross the boundary instead.

13.13. src/tools/saga3-args.ts has useful Discovery actionable errors but also a hard-coded tracker workflow and cannot serve arbitrary module tools.

13.14. Existing architecture boundary tests scan a small handpicked list of files and do not enforce the dependency graph repository-wide.

13.15. The in-progress package prototype adds digests and installation rows but currently hashes mutable source files without preserving immutable package bytes and allows multiple digests under the same released version.

13.16. The current base LM executor requires epic scope, assumes an objective-shaped input, understands preparation binding names, and emits a board-specific receipt. These belong behind a SagaBoard AgentDriver adapter.

13.17. The runner currently grants a fixed set of Claude built-in tools even when a profile declares a narrower set.

13.18. Reviewer skill declarations exist, but runner prompt assembly resolves the profile semantic skill before considering the review assignment.

13.19. SchemaReference currently carries only an unchecked ID, output schema mismatch may be treated as a warning, and free-form Flow transition conditions are not executed.

13.20. GenericFlowExecutor interprets module certificate and authority fields from production bindings and accepts an unversioned resolveOutput closure.

13.21. Lifecycle handoff currently rebuilds and persists a cumulative frame for every transition, which grows poorly and exposes unrelated prior stage data.

13.22. Current generic application commands and results still contain mandatory project, epic, and Discovery-oriented fields. These require outer compatibility adapters around a generic scenario command and result.

13.23. ExactCandidateAcceptance is wired directly into the generic kernel executor. It should be an optional capability or gate contribution so non-artifact modules do not inherit artifact-specific physics.

13.24. Several declared retry and recovery fields are not fully implemented. Installation must reject unsupported semantics until Runtime implements them.

13.25. Preserve the useful generic foundations already present: StageBinding refers to a module rather than calling it directly, LifecycleOrchestrator uses a registry and common executor interface, and the mapper intentionally restricts property access instead of executing arbitrary mapping code.

13.26. Preserve durable lifecycle and stage snapshots, hashes, leases, and restart mechanics while changing what identities and payloads they pin.

13.27. Preserve transactional stage completion and next-stage creation. Extend the transaction to exact package locks, immutable output envelopes, mapped handoffs, and transition receipts rather than replacing the transaction boundary.

13.28. Preserve the common ProcessModuleExecutor shape as a compatibility seam, then narrow its core contract to the driver-neutral envelopes defined here.

13.29. Existing mocked lifecycle tests remain useful characterization tests for orchestration persistence, but they do not constitute a real end-to-end proof.

13.30. Existing restricted mapping, lease, idempotency, and hash mechanisms should be evolved behind ports. Rewriting proven generic mechanics without a failing architectural reason is outside this refactor.

14. IMPLEMENTATION PHASES

14.1. PHASE 0: BASELINE, DECISIONS, AND CHARACTERIZATION

14.1.1. Record the current pipeline stop points and known failures as explicit test fixtures.
14.1.2. Add architecture decision records for package identity, scenario identity, dependency direction, execution envelopes, protocol state, tool ownership, and compatibility policy.
14.1.3. Add repository-wide dependency tests before moving code.
14.1.4. Add minimal synthetic modules for LM, Kernel, Human, and External node contract tests.
14.1.5. Freeze current public tool names and persistence migrations that require compatibility.
14.1.6. Exit gate: the intended dependency graph is executable as tests and known current violations are listed.

14.2. PHASE 1: PURE SERIALIZABLE SPI

14.2.1. Introduce ProcessModuleManifest, LifecycleScenarioManifest, NodeProtocolDefinition, ExecutionContextEnvelope, NodeExecutionReceipt, NodeProductionEnvelope, ProcessModuleOutputEnvelope, ModuleToolContribution, CapabilityRequirement, AgentAssistanceDefinition, and GuardBinding.
14.2.2. Require canonical JSON compatibility for every manifest type.
14.2.3. Reject functions, Maps, Sets, class instances, undefined values, non-finite numbers, and non-enumerable behavior from persisted manifests.
14.2.4. Keep existing ProcessModuleDefinition behind a LegacyProcessModuleAdapter.
14.2.5. Add validators and negative contract tests.
14.2.6. Exit gate: two unrelated synthetic packages validate using the same SPI without Runtime changes.
14.2.7. Introduce ContractRef with identity, version, digest, and registered codec.
14.2.8. Introduce generic RunLifecycleScenarioCommand and LifecycleExecutionResult; retain project/epic compatibility outside the core.

14.3. PHASE 2: IMMUTABLE PACKAGE INSTALLATION

14.3.1. Define ModulePackageStore port and filesystem content-addressed adapter.
14.3.2. Correct and complete process module installation persistence.
14.3.3. Copy complete package bytes atomically into immutable storage.
14.3.4. Persist canonical manifest, dependency lock, resources, handler versions, and store location.
14.3.5. Enforce production version immutability and replay verification.
14.3.6. Add installation state: staged, validated, active, retired, corrupt.
14.3.7. Make installation ID mandatory for new ProcessRuns while retaining a legacy nullable path only in the adapter.
14.3.8. Exit gate: modifying source package files after installation cannot alter or prevent replay of an existing run.

14.4. PHASE 3: GENERIC REGISTRIES AND INSTALLATION BINDINGS

14.4.1. Replace built-in catalog lookups with injected PackageRegistry.
14.4.2. Add CapabilityRegistry, ModuleToolRegistry, HandlerRegistry, SchemaRegistry, GuardRegistry, and ScenarioRegistry.
14.4.3. Bind handler factories through ProcessModulePlugin at composition time.
14.4.4. Validate every manifest reference against the installation binding.
14.4.5. Remove prefix and first-profile resolution. Resolve exact package, node, profile, and protocol identities from the execution envelope.
14.4.6. Add AgentDriverRegistry and place the existing WorkIntent, task board, and Claude runner behind a SagaBoardClaudeDriver adapter.
14.4.7. Exit gate: installing a third synthetic module requires only package registration, not edits to Runtime or a central catalog.

14.5. PHASE 4: DURABLE EXECUTION ENVELOPE AND PRODUCTS

14.5.1. Introduce ProcessProductRepository and exact product references.
14.5.2. Refactor NodeExecutor to consume ExecutionContextEnvelope.
14.5.3. Refactor NodeExecutionResult into separate receipt, production, issue, and diagnostics.
14.5.4. Persist exact NodeRun input and output envelope hashes.
14.5.5. Make task metadata a one-way projection from authoritative Runtime state.
14.5.6. Replace generic-flow mutable chain bindings with durable product references.
14.5.7. Replace execution-scoped and process-scoped fallback searches with exact product queries.
14.5.8. Generalize LmNodeExecutionPersistence into WorkerExecutionPort and remove Discovery-specific construction from the generic LM executor.
14.5.9. Replace magic terminal certificate and output bindings with explicit ModuleCompletion.
14.5.10. Validate all module and node boundary payloads through ContractSchemaRegistry.
14.5.11. Exit gate: crash after worker completion but before kernel verification resumes with the same receipt and exact production without searching by latest execution.

14.6. PHASE 5: PROTOCOL RUNTIME

14.6.1. Add ProtocolRun, ProtocolStepRun, evidence, and transition persistence.
14.6.2. Add generic ProtocolRuntime service.
14.6.3. Implement step start, evidence verification, completion, retry, pause, resume, and recovery transitions.
14.6.4. Add generic protocol checkpoint tool where explicit semantic completion is required.
14.6.5. Intersect per-step tools with frozen execution authority.
14.6.6. Add before-node-complete evidence gate.
14.6.7. Implement declared branch and repeat transitions plus stale-state rejection.
14.6.8. Implement the generic RecoveryIssue, RecoveryDecision, RecoveryAction, and RecoveryFeedback state machine.
14.6.9. Ensure a rejected product can return to any declared producer or recovery node with exact feedback while preserving all prior attempts.
14.6.10. Exit gate: a worker restart resumes the exact last incomplete step, cannot skip required evidence, and the same recovery engine repairs failures in two unrelated synthetic modules without module-specific Runtime code.

14.7. PHASE 6: WORKSPACE, TRACKER, CALL INSTANCES, AND CONTEXT ASSISTANCE

14.7.1. Resolve all skills and assets from the pinned immutable package.
14.7.2. Replace mutable tracker templates with Runtime TrackerRenderer.
14.7.3. Add authoritative CallInstance records and execution-scoped draft files.
14.7.4. Seal successful call instances and preserve failed drafts for correction.
14.7.5. Generate agent-assistance.json from ProtocolRun state.
14.7.6. Replace Markdown parsing in tracker-reminder with one generic structured context hook.
14.7.7. Implement compact, guided, and intensive assistance modes with deduplication and budgets.
14.7.8. Update runner prompt assembly to accept resolved package resources rather than global skill names.
14.7.9. Fix author versus reviewer resource resolution through AgentLaunchSpec.
14.7.10. Enforce agent built-in capabilities separately from MCP grants.
14.7.11. Exit gate: a weak-model fixture receives the exact current step, files, allowed tools, completion criteria, and repair action without module-specific runner code.

14.8. PHASE 7: TOOL CONTRIBUTIONS, GUARDS, AND ACTIONABLE ERRORS

14.8.1. Add ModuleToolContribution installation and namespaced registration.
14.8.2. Convert shared tools into versioned platform Capability Packages.
14.8.3. Add generic GatewayGuard pipeline.
14.8.4. Add optional CLI PreToolUse projection for early denial.
14.8.5. Add universal ActionableToolError and error-to-call-instance association.
14.8.6. Generate tool descriptions and expected shapes from the registered contract.
14.8.7. Remove hard-coded tracker and template paths from tool handlers.
14.8.8. Add explicit call-instance correlation and preserve structured errors through MCP transport.
14.8.9. Exit gate: a synthetic module contributes a new tool, template, checklist, guard, and error hints without editing MCP gateway source.

14.9. PHASE 8: LIFECYCLE SCENARIO SPI

14.9.1. Add immutable Lifecycle Scenario package installation and storage.
14.9.2. Add exact scenario module lock resolution.
14.9.3. Require LifecycleRun to pin scenario installation and module lock at start.
14.9.4. Replace routeResolver with serializable predicates or explicit decision modules.
14.9.5. Validate all stage mappings against installed module contracts.
14.9.6. Make StageRun pin exact module installation.
14.9.7. Make module completion expose a complete immutable output envelope, eliminating module-specific payload reopen logic in Lifecycle Runtime.
14.9.8. Replace product-specific lifecycle composition with generic ScenarioInstaller and ScenarioRunner composition.
14.9.9. Replace cumulative handoff frames with content-addressed public stage outputs and exact mapped handoffs.
14.9.10. Add explicit transition and reentry budgets.
14.9.11. Exit gate: a new scenario can reorder or reuse installed modules without Runtime changes and replays identically after package upgrades.

14.10. PHASE 9: FORMALIZATION PILOT MIGRATION

14.10.1. Move Formalization skills, templates, checklists, schemas, protocols, and module-owned resources into its package.
14.10.2. Define exact NodeProtocols for every Formalization LM node.
14.10.3. Replace artifact discovery and execution fallback with exact product contracts.
14.10.4. Register kernel handlers, policies, guards, reviewers, and output contract through the package installation.
14.10.5. Remove direct database access from Formalization application handlers by injecting module ports.
14.10.6. Run author, review, kernel acceptance, retry, recovery, restart, and settlement contract tests.
14.10.7. Exit gate: Formalization runs entirely through the new package path with no global skill or template lookup.

14.11. PHASE 10: DISCOVERY MIGRATION

14.11.1. Move all Discovery resources into its package.
14.11.2. Move proposal, normalization, readiness, and diagnosis tool semantics into module tool contributions.
14.11.3. Express brief production as an explicit declared module product, not a hidden legacy side effect.
14.11.4. Replace ensureDiscoveryWorkspace with generic workspace projection.
14.11.5. Replace Discovery-specific actionable error helper with package hints plus universal ActionableToolError.
14.11.6. Remove legacy engine context bridges after parity tests.
14.11.7. Exit gate: Discovery installs, executes, recovers, and emits its immutable output through only standard interfaces.

14.12. PHASE 11: DEVELOPMENT AND DELIVERY MIGRATION

14.12.1. Package Development planner, implementation coordination, verification, integration, policies, resources, and ports.
14.12.2. Ensure nested implementation work uses explicit child execution contracts and exact provenance.
14.12.3. Remove no-op and implicit default ports from production composition.
14.12.4. Package Delivery external actions, human approval interactions, observation, settlement, policies, and resources.
14.12.5. Verify external effects through the standard idempotent effect ledger and receipts.
14.12.6. Exit gate: both modules run through the same Runtime interfaces used by Formalization and Discovery.

14.13. PHASE 12: ARBITRARY MODULE AND SCENARIO PROOF

14.13.1. Create contract-test fixture packages representing an LM Marketing module, an External Analytics or SEO module, and a Human Director Approval module.
14.13.2. Compose them into a Campaign Lifecycle Scenario.
14.13.3. Install packages and scenario without changing Runtime source.
14.13.4. Prove multiple uses of one module, conditional routing, terminal routing, restart, and recovery.
14.13.5. Deliver Module Authoring Kit, Scenario Authoring Kit, package validator, scenario validator, and describe commands.
14.13.6. Exit gate: arbitrary capability and scenario extensibility is demonstrated, not only claimed.

14.14. PHASE 13: CUTOVER AND COMPATIBILITY HOLD

14.14.1. Install Product Delivery as a Lifecycle Scenario package.
14.14.2. Switch only new Product Delivery runs to installed scenario and module packages.
14.14.3. Keep explicit compatibility adapters for supported legacy runs, but make them inaccessible to the new execution path.
14.14.4. Record every compatibility-path use and define the retention condition required before its removal.
14.14.5. Verify rollback by selecting the preceding immutable scenario installation rather than editing installed bytes.
14.14.6. Tighten architecture tests for the new core while keeping only documented legacy exceptions.
14.14.7. Exit gate: all new runs use installed packages and old pinned runs still replay through explicit adapters.

14.15. PHASE 14: END-TO-END HARDENING

14.15.1. Run the full Product Delivery scenario repeatedly with at least two different product ideas.
14.15.2. Inject process termination before and after every durable boundary.
14.15.3. Verify exact replay after Runtime restart.
14.15.4. Verify active runs remain pinned while new package versions are installed.
14.15.5. Verify invalid packages, missing capabilities, invalid mappings, ambiguous routes, stale hashes, and unauthorized tools fail before semantic work begins.
14.15.6. Run the scenario with intensive assistance on a weak model.
14.15.7. Run the unrelated Campaign scenario repeatedly with restart and recovery.
14.15.8. Exit gate: both scenarios reach valid terminal outcomes without manual DB, metadata, tracker, workspace, or artifact repair.

14.16. PHASE 15: FINAL LEGACY REMOVAL

14.16.1. Prove through retention records that no supported active or replayable run requires each target compatibility path.
14.16.2. Remove central built-in module selection and task-kind profile fallback.
14.16.3. Remove global module skill and template resolution.
14.16.4. Remove manual tracker mutation protocol and old workspace or hook special cases.
14.16.5. Remove routeResolver, product-specific lifecycle policy, and output payload registry paths.
14.16.6. Remove execution, process, metadata, and chain-binding fallback context reconstruction.
14.16.7. Remove obsolete product composition and CLI branches.
14.16.8. Remove obsolete adapters and tables only after data migration, package retention, and replay proof.
14.16.9. Run final architecture, replay, package isolation, Product Delivery, and Campaign gates after every cleanup group.
14.16.10. Exit gate: repository-wide dependency checks show no forbidden new-core imports, hidden fallback paths, or unsupported legacy execution paths.

15. TEST STRATEGY

15.1. Pure contract tests validate canonical serialization, schema compatibility, graph structure, route determinism, and package references.

15.2. Architecture tests scan complete source subtrees and enforce import directions.

15.3. Package tests verify immutable storage, digest correctness, version collision rejection, resource traversal rejection, handler coverage, and dependency locking.

15.4. Runtime tests verify leases, idempotency, receipts, exact products, protocol transitions, call instances, and recovery.

15.5. Scenario tests verify mapping, routing, module locks, replay, pause, cancellation, and terminal settlement.

15.6. Adapter tests verify SQLite migration, filesystem atomicity, Claude hook projections, MCP guard behavior, and external effect replay.

15.7. Module conformance tests are generated from one shared kit and run against every installed module.

15.8. Scenario conformance tests are generated from one shared kit and run against every installed scenario.

15.9. End-to-end tests use real worker execution only after deterministic contract slices pass.

15.10. Keep test groups bounded and observable. Run architecture and new SPI tests first, then persistence, then one migrated module, then scenario tests, and only then the complete legacy suite.

15.11. Add exact launch tests with two modules and two versions sharing one task kind; the pinned installation must always select the correct profile, author or reviewer skill, protocol, and resources.

15.12. Add schema boundary tests for malformed module input, node input, node production, module completion, and scenario handoff.

15.13. Add protocol branch, repeat, stale state, illegal transition, and unsupported retry-policy tests.

15.14. Add call-instance crash tests between external effect, receipt persistence, protocol advancement, and tracker regeneration.

15.15. Add assistance security tests for untrusted error escaping, size limits, state-version deduplication, and cross-execution event rejection.

15.16. Add scenario scaling tests proving a long scenario does not duplicate the complete cumulative frame at every stage.

15.17. Add universal recovery tests for reviewer rejection, verifier rejection, producer reentry, recovery-node entry, human escalation, exhaustion, restart, stale decision, and preservation of accepted predecessor products.

15.18. Run the same recovery conformance suite against at least two unrelated module packages.

16. MIGRATION AND ROLLBACK POLICY

16.1. Use additive database migrations until final cutover.

16.2. Do not reinterpret old rows as new contracts. Mark legacy rows and route them through explicit adapters.

16.3. Introduce one compatibility seam per old subsystem and delete it immediately after the owning module migrates.

16.4. Do not move module resources before immutable package resolution works.

16.5. Do not make tracker read-only before ProtocolRun is authoritative.

16.6. Do not enable per-step tool restrictions before protocol step identity is live and tested.

16.7. Do not remove current tools before module tool aliases and replay behavior are verified.

16.8. Do not cut Product Delivery to the new scenario engine until all four current modules pass conformance tests.

16.9. Each phase must leave the repository buildable and the previous production path runnable unless that phase explicitly performs cutover.

16.10. Rollback selects the previous installation or scenario package; it never edits an immutable installed package.

17. PRIMARY RISKS AND CONTROLS

17.1. Risk: over-generalizing the SPI. Control: prove each abstraction with at least two unrelated module kinds and reject fields used by only one module from Runtime contracts.

17.2. Risk: moving domain semantics into Runtime evidence logic. Control: Runtime understands evidence shape; module verifiers understand meaning.

17.3. Risk: hash pinning without replayable bytes. Control: immutable content-addressed package storage is mandatory.

17.4. Risk: hidden behavior omitted from digests. Control: manifests are pure canonical data; all handlers and policies are explicit versioned references.

17.5. Risk: scenario updates change active runs. Control: pin scenario installation and complete module lock at LifecycleRun start.

17.6. Risk: call files remain an untracked second source of truth. Control: persist call identity, state, hashes, errors, and receipts.

17.7. Risk: context hooks flood weak-model context. Control: structured projections, event-specific renderers, deduplication, and budgets.

17.8. Risk: arbitrary module code is unsafe. Control: first release supports trusted installed plugins; untrusted code sandboxing is a separate explicitly scoped capability.

17.9. Risk: big-bang migration. Control: compatibility adapters and one-module-at-a-time cutover.

17.10. Risk: architecture documentation drifts. Control: generate descriptions from manifests and enforce dependency rules in tests.

18. DEFINITION OF DONE

18.1. A new Process Module Package can be installed without editing Runtime source, the global runner, a central module catalog, or another module.

18.2. A new Lifecycle Scenario Package can be installed without editing Runtime source or module packages.

18.3. Runtime core contains no imports from concrete module or scenario implementations.

18.4. Modules contain no imports from other module implementations or Runtime adapters.

18.5. Every active run is pinned to immutable scenario and module package bytes.

18.6. Every module boundary passes a complete immutable output envelope and exact lineage.

18.7. Restart and recovery use durable receipts and products, not latest-execution or metadata fallback.

18.8. Tracker and agent assistance are generated from authoritative protocol state.

18.9. Module-specific MCP tools, skills, templates, checklists, guards, and error hints ship with the owning package.

18.10. Product Delivery and the arbitrary Campaign fixture both complete through the same Runtime.

18.11. Full scenarios complete repeatedly without manual database, metadata, tracker, or artifact edits.

18.12. Any declared node may reject work with structured feedback and route it to a declared repair target through the same Runtime recovery mechanism used by every other module.

19. AGENT EXECUTION CHECKLIST

C001. PENDING. Read this entire plan before changing code.
C002. PENDING. Inspect git status and preserve all unrelated user-owned changes.
C003. PENDING. Identify the current phase and do not implement later-phase dependencies early.
C004. PENDING. State the exact architecture rule served by the change.
C005. PENDING. Add or update a failing contract or architecture test before changing behavior.
C006. PENDING. Keep manifests pure, serializable, canonical data.
C007. PENDING. Reject any proposed function or closure inside a persisted manifest.
C008. PENDING. Keep Runtime free of module names, kinds, reason codes, artifacts, and stage vocabulary.
C009. PENDING. Keep modules free of Runtime adapter and persistence implementation imports.
C010. PENDING. Keep scenarios free of module implementation imports.
C011. PENDING. Use exact package, node, profile, protocol, and tool identities; do not use prefix or first-match selection.
C012. PENDING. Add every new package resource to the resource index and digest.
C013. PENDING. Store immutable package bytes before claiming replay safety.
C014. PENDING. Reject released name/version collisions with different digests.
C015. PENDING. Pin exact installation identity on every new ProcessRun.
C016. PENDING. Pin exact scenario and module lock on every new LifecycleRun.
C017. PENDING. Separate execution receipt from domain production.
C018. PENDING. Persist exact production references and hashes before advancing.
C019. PENDING. Do not use task metadata as authoritative lineage.
C020. PENDING. Do not add latest-execution or process-scope fallback to repair a missing contract.
C021. PENDING. Model any missing cross-node value as a declared production field or product reference.
C022. PENDING. Model any missing cross-module value as a module output field and scenario mapping.
C023. PENDING. Define every LM node internal action in NodeProtocol, not only in skill prose.
C024. PENDING. Give every protocol step stable identity, tools, evidence, resources, assistance, and guards.
C025. PENDING. Keep ProtocolRun state in Runtime persistence.
C026. PENDING. Verify evidence before advancing a protocol step.
C027. PENDING. Generate tracker from Runtime state and do not require model-authored checkboxes.
C028. PENDING. Create a durable CallInstance before consequential tool submission.
C029. PENDING. Preserve the same failed call draft for progressive correction.
C030. PENDING. Seal successful call instances and attach exact receipts.
C031. PENDING. Generate agent-assistance.json from authoritative state.
C032. PENDING. Keep Claude context hooks generic and package-configured.
C033. PENDING. Bound hook messages and deduplicate repeated state.
C034. PENDING. Keep MCP transport and gateway in platform infrastructure.
C035. PENDING. Keep module-specific tool semantics in the owning module package.
C036. PENDING. Register shared tools through versioned Capability Packages.
C037. PENDING. Enforce effective allowed tools at the gateway.
C038. PENDING. Treat CLI PreToolUse denial as an optimization, not authority.
C039. PENDING. Return structured ActionableToolError with an exact repair path.
C040. PENDING. Keep kernel verification authoritative after all worker assistance.
C041. PENDING. Route semantic failure through standard durable RecoveryIssue and RecoveryFeedback.
C042. PENDING. Preserve accepted products and successful receipts during recovery.
C043. PENDING. Ensure every module outcome has one deterministic scenario route.
C044. PENDING. Validate scenario input and output mappings against module schemas.
C045. PENDING. Replace complex route logic with declarative predicates or an explicit decision module.
C046. PENDING. Never introduce a hidden route resolver outside the scenario digest.
C047. PENDING. Add repository-wide dependency enforcement for each new boundary.
C048. PENDING. Run targeted new tests before broader groups.
C049. PENDING. Test restart immediately before and after every new durable transition.
C050. PENDING. Test idempotent replay of every consequential side effect.
C051. PENDING. Test package mutation after installation.
C052. PENDING. Test package upgrade while an older run remains active.
C053. PENDING. Test invalid resources, handlers, schemas, capabilities, routes, and mappings fail at install time.
C054. PENDING. Test at least one weak-model execution with intensive assistance for each migrated LM module.
C055. PENDING. Migrate one module completely before partially migrating all modules.
C056. PENDING. Remove the owning compatibility seam after module cutover.
C057. PENDING. Do not declare a phase complete while a hidden fallback remains.
C058. PENDING. Keep each commit architecture-focused and independently buildable.
C059. PENDING. Update this checklist status and record evidence after each phase.
C060. PENDING. Do not declare the refactor complete until both Product Delivery and an unrelated arbitrary scenario pass repeated end-to-end runs.
C061. PENDING. Keep base agent execution independent of board, task, epic, and Claude-specific identities.
C062. PENDING. Launch agents only from an exact persisted AgentLaunchSpec.
C063. PENDING. Resolve the reviewer skill separately from the author skill.
C064. PENDING. Validate every ContractRef through the pinned schema codec.
C065. PENDING. Reject ignored Flow conditions and unsupported retry declarations.
C066. PENDING. Emit terminal ModuleCompletion explicitly; do not interpret magic certificate bindings in Runtime.
C067. PENDING. Enforce agent built-in capabilities separately from MCP tool grants.
C068. PENDING. Correlate every consequential tool call with one durable CallInstance.
C069. PENDING. Persist structured errors without flattening them at the MCP boundary.
C070. PENDING. Store each public stage output once and avoid cumulative frame duplication.
C071. PENDING. Use explicit scenario transition and reentry budgets.
C072. PENDING. Treat artifact acceptance as an optional capability, not mandatory kernel behavior.
C073. PENDING. Emit every semantic or technical rejection as a durable structured RecoveryIssue.
C074. PENDING. Route recovery only through a package-declared standard RecoveryAction.
C075. PENDING. Supply the repair attempt with the exact failed product, feedback, original contract, and accepted predecessors.
C076. PENDING. Never overwrite a failed attempt or accepted predecessor during recovery.
C077. PENDING. Keep module-internal recovery inside the module boundary until a public outcome is emitted.
C078. PENDING. Run the shared recovery conformance suite against two unrelated modules.
C079. PENDING. Start a parallel wave only from its frozen checkpoint and satisfied preconditions.
C080. PENDING. Give every worker an isolated worktree, branch, build output, database, and generated workspace.
C081. PENDING. Assign disjoint path ownership before spawning workers.
C082. PENDING. Stop and escalate any required change to a frozen contract instead of patching around it.
C083. PENDING. Use one migration and schema-bootstrap writer per wave.
C084. PENDING. Use one writer for every declared core hot file.
C085. PENDING. Require one focused commit, changed-file list, test evidence, and risk report from every worker.
C086. PENDING. Let only the integrator cherry-pick and merge wave results.
C087. PENDING. Run the targeted gate after every cherry-pick and create a checkpoint before the next wave.
C088. PENDING. Keep test-only agents from changing production code outside an explicit reassignment.
C089. PENDING. Complete cutover and hardening before deleting compatibility paths.
C090. PENDING. Preserve ownership lanes and integration order when a wave must run in smaller concurrency subwaves.

20. RECOMMENDED FIRST IMPLEMENTATION SLICE

20.1. Review the current uncommitted package prototype against Sections 3, 5, and 6.

20.2. Preserve useful digest and repository work, but correct immutable byte storage, version collision policy, serializable manifest types, and installation deletion semantics before merging it.

20.3. Add pure ProcessModuleManifest and LifecycleScenarioManifest contracts plus canonical serialization tests.

20.4. Add repository-wide dependency tests that expose current violations without immediately moving all code.

20.5. Add two tiny unrelated synthetic module packages and one tiny scenario as the first proof target.

20.6. Do not move production skills, implement ProtocolRun, or replace hooks until the package installation and pure SPI foundation passes its exit gate.
