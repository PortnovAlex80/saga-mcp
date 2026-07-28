# W2-A6 — Generic registries + ProcessModulePlugin + InstalledProcessModule binding

**Wave:** 2 · **Lane:** A6 · **Spec:** §1 rows 10,11,12 · **Frozen input commit:** `15d931a`
**Branch:** `refactor/w2-a6` · **Worktree:** `.worktrees/w2-a6`

## Read first
1. `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md` (full — esp. §1 rows 10,11,12, §2 ports).
2. Wave 1 barrel: `ModuleToolContribution`, `CapabilityRequirement`, `GuardBinding`, `ContractSchemaRegistry` (re-export, don't redefine).
3. W2-A2 task: `ModuleInstallationRecord`.

## Own (only you)
- `src/process-modules/installation/domain/registries.ts`
- `src/process-modules/installation/domain/plugin.ts`
- `src/process-modules/installation/domain/installation-binding.ts`
- `tests/installation/registries.test.mjs`

## What to build (spec §1 rows 10,11,12, plan §14.4.2, §14.4.3, §5.1.3)
### `registries.ts` (ports + in-memory adapters)
- `HandlerRegistry` PORT: `register(ref: HandlerRef, factory: HandlerFactory)`, `resolve(ref): HandlerFactory`, `has(ref)`. `HandlerFactory = (ctx) => HandlerInstance` (a function type — runtime, not persisted). In-memory adapter `InMemoryHandlerRegistry`.
- `CapabilityRegistry` PORT: `register(ref, provider)`, `resolve(ref)`, `has(ref)`. In-memory adapter.
- `ModuleToolRegistry` PORT: `register(contribution: ModuleToolContribution, handler)`, `resolve(logicalId)`, `list()`. In-memory adapter. Validates namespace collision at register (plan §11.5).
- `SchemaRegistry` — RE-EXPORT `ContractSchemaRegistry` from Wave 1 (do NOT redefine). Add `InMemorySchemaRegistry` as an alias if helpful, else just re-export `InMemoryContractSchemaRegistry`.
- `GuardRegistry` PORT: `register(ref: GuardBinding, guard)`, `resolve(ref)`. In-memory adapter.
- `AgentDriverRegistry` PORT: `register(name, driverFactory)`, `resolve(name)`. In-memory adapter. (The SagaBoardClaudeDriver adapter is Wave 3 — Wave 2 only defines the port.)

### `plugin.ts` (pure binding contract)
- `ProcessModulePlugin` interface: `{ installationId: ModuleInstallationId; handlerFactories: Readonly<Record<string, HandlerFactory>>; adapterFactories?: Readonly<Record<string, unknown>>; capabilityProviders?: readonly { ref: CapabilityRequirement; provider: unknown }[] }`. The composition-root-facing binding contract (plan §14.4.3). Pure value shape (the factories are functions, but the plugin object itself is a runtime binding, not persisted).

### `installation-binding.ts` (pure value object)
- `InstalledProcessModule` — binds an immutable `ModuleInstallationRecord` to resolved registrations (plan §5.1.3): `{ record: ModuleInstallationRecord; resolvedHandlers: Readonly<Record<string, HandlerFactory>>; resolvedTools: readonly ModuleToolContribution[]; resolvedSchemas: readonly ContractRef[]; resolvedResources: readonly ResourceIndexEntry[] }`. Pure value object (no live executor — composition root activates it).
- `bindInstallation(record, plugin, registries): InstalledProcessModule` — validates every `plugin.handlerFactories` key matches a `record.handlerRefs` logicalId; validates every `record.handlerRefs` has a factory (fail-fast, plan §5.5.2); resolves tools/schemas/resources from the record. Throws `INSTALLATION_BINDING_INCOMPLETE` on missing coverage.

## Tests (`tests/installation/registries.test.mjs`)
- Each registry: register/resolve/has positive; double-register (idempotent or error — document); resolve unknown → throws.
- `ModuleToolRegistry`: namespace collision (two contributions same logicalId) → rejected.
- `bindInstallation`: valid plugin + record → `InstalledProcessModule`; missing handler factory → `INSTALLATION_BINDING_INCOMPLETE`; extra factory not in record → rejected.

## Cross-lane imports
- `ModuleInstallationRecord` from `installation/domain/installation.js` (W2-A2).
- `HandlerRef`, `ModuleToolContribution`, `CapabilityRequirement`, `GuardBinding`, `ContractRef`, `ContractSchemaRegistry`, `InMemoryContractSchemaRegistry`, `ResourceIndexEntry` from `domain/spi/index.js` (Wave 1).

## Anti-scope
- Do NOT implement the SagaBoardClaudeDriver (Wave 3).
- Do NOT wire into composition root (integrator at checkpoint).
- Do NOT edit `domain/spi/*`.

## Verify
```
cd .worktrees/w2-a6 && npm run build && node --test tests/installation/registries.test.mjs && node --test tests/architecture/dependency-direction.test.mjs
```
PASS + ratchet GREEN.

## Commit
`feat(installation): W2-A6 generic registries + ProcessModulePlugin + InstalledProcessModule binding`.

## Return
1. Branch + sha. 2. diff --stat. 3. test result. 4. Exported symbols (composition root integrator imports these). 5. Confirmation.
