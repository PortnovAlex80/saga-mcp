# 02 — Master Execution Checklist (C001–C090)

Source: plan §19. Status legend: ` ` = PENDING · `🟡` = IN PROGRESS (wave active) · `✅` = DONE (evidence cited) · `⛔` = BLOCKED (see 08-RISK-REGISTER).

Update the right-hand column when a wave closes. Keep one-line evidence (commit/PR/test) per ✅.

## Foundations (every change)
- [ ] C001. Read this entire plan before changing code. *(integrator: done at refactor start, 2026-07-28)*
- [ ] C002. Inspect git status and preserve all unrelated user-owned changes. *(integrator: 2026-07-28 — staged refactor HQ under `docs/refactor-management/` only; untracked bootstrap-*.mjs and lifecycle-input-*.json left in place)*
- [ ] C003. Identify the current phase and do not implement later-phase dependencies early.
- [ ] C004. State the exact architecture rule served by the change.
- [ ] C005. Add or update a failing contract or architecture test before changing behavior.

## Pure SPI & serializability (Wave 1)
- [ ] C006. Keep manifests pure, serializable, canonical data.
- [ ] C007. Reject any proposed function or closure inside a persisted manifest.
- [ ] C008. Keep Runtime free of module names, kinds, reason codes, artifacts, and stage vocabulary.
- [ ] C009. Keep modules free of Runtime adapter and persistence implementation imports.
- [ ] C010. Keep scenarios free of module implementation imports.
- [ ] C011. Use exact package, node, profile, protocol, and tool identities; do not use prefix or first-match selection.
- [ ] C064. Validate every ContractRef through the pinned schema codec.
- [ ] C065. Reject ignored Flow conditions and unsupported retry declarations.

## Package installation (Wave 2)
- [ ] C012. Add every new package resource to the resource index and digest.
- [ ] C013. Store immutable package bytes before claiming replay safety.
- [ ] C014. Reject released name/version collisions with different digests.

## Identity pinning (Wave 2–3, 7)
- [ ] C015. Pin exact installation identity on every new ProcessRun.
- [ ] C016. Pin exact scenario and module lock on every new LifecycleRun.

## Execution envelope & products (Wave 3)
- [ ] C017. Separate execution receipt from domain production.
- [ ] C018. Persist exact production references and hashes before advancing.
- [ ] C019. Do not use task metadata as authoritative lineage.
- [ ] C020. Do not add latest-execution or process-scope fallback to repair a missing contract.
- [ ] C021. Model any missing cross-node value as a declared production field or product reference.
- [ ] C022. Model any missing cross-module value as a module output field and scenario mapping.
- [ ] C066. Emit terminal ModuleCompletion explicitly; do not interpret magic certificate bindings in Runtime.

## Node protocol (Wave 4)
- [ ] C023. Define every LM node internal action in NodeProtocol, not only in skill prose.
- [ ] C024. Give every protocol step stable identity, tools, evidence, resources, assistance, and guards.
- [ ] C025. Keep ProtocolRun state in Runtime persistence.
- [ ] C026. Verify evidence before advancing a protocol step.

## Tracker & agent assistance (Wave 5)
- [ ] C027. Generate tracker from Runtime state and do not require model-authored checkboxes.
- [ ] C031. Generate agent-assistance.json from authoritative state.
- [ ] C032. Keep Claude context hooks generic and package-configured.
- [ ] C033. Bound hook messages and deduplicate repeated state.
- [ ] C054. Test at least one weak-model execution with intensive assistance for each migrated LM module.

## Call instances (Wave 5)
- [ ] C028. Create a durable CallInstance before consequential tool submission.
- [ ] C029. Preserve the same failed call draft for progressive correction.
- [ ] C030. Seal successful call instances and attach exact receipts.
- [ ] C068. Correlate every consequential tool call with one durable CallInstance.

## MCP tools & guards (Wave 6)
- [ ] C034. Keep MCP transport and gateway in platform infrastructure.
- [ ] C035. Keep module-specific tool semantics in the owning module package.
- [ ] C036. Register shared tools through versioned Capability Packages.
- [ ] C037. Enforce effective allowed tools at the gateway.
- [ ] C038. Treat CLI PreToolUse denial as an optimization, not authority.
- [ ] C039. Return structured ActionableToolError with an exact repair path.
- [ ] C069. Persist structured errors without flattening them at the MCP boundary.

## Recovery (Wave 4)
- [ ] C040. Keep kernel verification authoritative after all worker assistance.
- [ ] C041. Route semantic failure through standard durable RecoveryIssue and RecoveryFeedback.
- [ ] C042. Preserve accepted products and successful receipts during recovery.
- [ ] C073. Emit every semantic or technical rejection as a durable structured RecoveryIssue.
- [ ] C074. Route recovery only through a package-declared standard RecoveryAction.
- [ ] C075. Supply the repair attempt with the exact failed product, feedback, original contract, and accepted predecessors.
- [ ] C076. Never overwrite a failed attempt or accepted predecessor during recovery.
- [ ] C077. Keep module-internal recovery inside the module boundary until a public outcome is emitted.
- [ ] C078. Run the shared recovery conformance suite against two unrelated modules.

## Lifecycle scenario (Wave 7)
- [ ] C043. Ensure every module outcome has one deterministic scenario route.
- [ ] C044. Validate scenario input and output mappings against module schemas.
- [ ] C045. Replace complex route logic with declarative predicates or an explicit decision module.
- [ ] C046. Never introduce a hidden route resolver outside the scenario digest.
- [ ] C070. Store each public stage output once and avoid cumulative frame duplication.
- [ ] C071. Use explicit scenario transition and reentry budgets.
- [ ] C072. Treat artifact acceptance as an optional capability, not mandatory kernel behavior.

## Architecture enforcement (Wave 0 onward)
- [ ] C047. Add repository-wide dependency enforcement for each new boundary.

## Test discipline (every wave)
- [ ] C048. Run targeted new tests before broader groups.
- [ ] C049. Test restart immediately before and after every new durable transition.
- [ ] C050. Test idempotent replay of every consequential side effect.
- [ ] C051. Test package mutation after installation.
- [ ] C052. Test package upgrade while an older run remains active.
- [ ] C053. Test invalid resources, handlers, schemas, capabilities, routes, and mappings fail at install time.

## Migration discipline (Waves 8–13)
- [ ] C055. Migrate one module completely before partially migrating all modules.
- [ ] C056. Remove the owning compatibility seam after module cutover.
- [ ] C057. Do not declare a phase complete while a hidden fallback remains.

## Commits & waves (every wave)
- [ ] C058. Keep each commit architecture-focused and independently buildable.
- [ ] C059. Update this checklist status and record evidence after each phase.
- [ ] C079. Start a parallel wave only from its frozen checkpoint and satisfied preconditions.
- [ ] C080. Give every worker an isolated worktree, branch, build output, database, and generated workspace.
- [ ] C081. Assign disjoint path ownership before spawning workers.
- [ ] C082. Stop and escalate any required change to a frozen contract instead of patching around it.
- [ ] C083. Use one migration and schema-bootstrap writer per wave.
- [ ] C084. Use one writer for every declared core hot file.
- [ ] C085. Require one focused commit, changed-file list, test evidence, and risk report from every worker.
- [ ] C086. Let only the integrator cherry-pick and merge wave results.
- [ ] C087. Run the targeted gate after every cherry-pick and create a checkpoint before the next wave.
- [ ] C088. Keep test-only agents from changing production code outside an explicit reassignment.
- [ ] C089. Complete cutover and hardening before deleting compatibility paths.
- [ ] C090. Preserve ownership lanes and integration order when a wave must run in smaller concurrency subwaves.

## Agent launch & driver (Wave 3, 5)
- [ ] C061. Keep base agent execution independent of board, task, epic, and Claude-specific identities.
- [ ] C062. Launch agents only from an exact persisted AgentLaunchSpec.
- [ ] C063. Resolve the reviewer skill separately from the author skill.
- [ ] C067. Enforce agent built-in capabilities separately from MCP tool grants.

## Definition of Done (Wave 13+)
- [ ] C060. Do not declare the refactor complete until both Product Delivery and an unrelated arbitrary scenario pass repeated end-to-end runs.

---

## Progress counters

- Total items: 90
- Done: 0 · In progress: 0 · Blocked: 0 · Pending: 90
