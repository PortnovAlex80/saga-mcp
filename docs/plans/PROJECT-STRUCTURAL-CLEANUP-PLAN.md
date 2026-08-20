# Project structural cleanup plan

Status: Proposed

Date: 2026-08-21

Audience: implementation agents, reviewers, and integrators

Decision: ADR-086

Related workshop plan: `docs/plans/WORKSHOP-MODULARIZATION-REFACTORING-PLAN.md`

## 1. Purpose

This plan removes the structural red flags outside the workshop trees and gives
agents a deterministic checklist for the work.

The target is not a new framework. The target is a repository in which every
important responsibility has:

1. one owner;
2. one canonical source location;
3. one public entrypoint;
4. one runtime execution path;
5. one test oracle;
6. no compatibility implementation beside it.

The plan covers all identified priorities:

- P0: remove database migration and compatibility sediment;
- P0: complete lifecycle authority cutover and delete dispatcher-owned state
  transitions;
- P1: establish one immutable composition root for every host;
- P1: repair architecture ratchets so they scan the real topology;
- P1: complete workshop co-location and infrastructure ownership from ADR-085;
- P2: split the largest files by responsibility;
- P2: remove ambiguous lifecycle naming and stale architectural documentation.

## 2. Starting assumptions

These assumptions are binding for this plan:

- There is no deployed production environment.
- There is no persistent production database.
- There is no customer data to preserve.
- There is no non-terminal run population to resume across the refactor.
- Test databases and repositories are disposable fixtures.
- There will be no database migration layer in this phase.
- ADR-082 admission remains closed until C12.

Therefore, do not implement:

- `ALTER TABLE` upgrade paths;
- data copy or table rebuild migrations;
- dual-read or dual-write logic;
- old-version readers;
- compatibility feature flags;
- historical executable registries;
- runtime fallbacks to old composition paths;
- long-lived re-export shims.

If any assumption becomes false, stop this plan and write a new ADR. Do not add
a migration framework locally as a precaution.

## 3. Current red flags and evidence

| Area | Evidence | Failure mode |
|---|---|---|
| Schema bootstrap | `src/db.ts`, `src/schema.ts`, repository `ensure*Schema` functions, 25 `ALTER TABLE` occurrences in 13 source files | Fresh-schema policy and compatibility behavior coexist |
| Lifecycle authority | `src/lifecycle/application-service.ts` lazy-loads `src/tools/dispatcher.ts`; dispatcher still owns task SQL | New command facade is not the real authority |
| Composition | `composition-root.ts`, `product-lifecycle-runtime.ts`, `factory-start.ts`, CLI and fresh harness assemble overlapping graphs | Hosts can execute different runtime compositions |
| Global side channels | `lastFactory*` handles, mutable registries and dispatcher route setters | Runtime behavior depends on process history |
| Workshop layout | `src/modules/<name>` and `src/process-modules/modules/<name>` | One workshop has two homes and multiple connection surfaces |
| Architecture tests | composition classifier points to a missing `src/process-modules/composition`; SQLite gate excludes `src/modules/*/infrastructure` | Green tests can miss the real violation |
| Large files | files between 1,000 and 3,124 lines mix coordination, policy, SQL and projections | Agents cannot change one responsibility safely |
| Lifecycle naming | `src/lifecycle` and `src/process-modules/lifecycles` mean different things | Agents cannot infer ownership from paths |

## 4. Governing decision: one atomic authority train

Schema bootstrap, lifecycle commands, tool completion, worker assignment and
composition form one connected authority graph. They cannot be merged as
independent final architectures.

The work is divided into reviewable work packets, but P0 and P1 authority work
has one merge gate:

```text
baseline
  -> target contracts and scaffolds
  -> fresh schema + repositories
  -> lifecycle command authority + tool gateway
  -> co-located workshops + closed catalog
  -> immutable composition
  -> delete all old paths
  -> full proof
  -> merge
```

Intermediate commits are allowed for review and local bisecting. They are not
supported runtime states and must not be merged separately into the target
branch.

After the authority train merges, P2 large-file extraction may proceed in
independent, behavior-preserving commits because the ownership boundaries are
then stable.

## 5. Target source topology

```text
src/
  app/
    runtime/
      factory-runtime.ts
      factory-composition.ts
      composition-fingerprint.ts
      build-persistence.ts
      build-lifecycle.ts
      build-process-runtime.ts
      build-quality-runtime.ts
      build-worker-runtime.ts
      build-recovery-runtime.ts
    commands/
      start-factory.ts
      resume-factory.ts
      abandon-factory.ts
      recover-factory.ts
    hosts/
      cli-host.ts
      mcp-host.ts
      scripted-host.ts

  lifecycle/
    LIFECYCLE.md
    index.ts
    task/
      domain/
      application/
        command-bus.ts
        commands/
          worker-next.ts
          worker-done.ts
          worker-ask-need.ts
          worker-ask-done.ts
          worker-merge-acquire.ts
          worker-merge-release.ts
      ports/
    product/
      definitions/
      application/
        start-lifecycle.ts
        route-stage-outcome.ts
        continue-lifecycle.ts
      ports/

  process-modules/
    domain/
    application/
      flow/
      production-cell/
      quality/
      effects/
      recovery/
    installation/
    persistence/                     # ports and universal repositories only

  modules/
    built-in-catalog.ts              # closed literal tuple before C12
    discovery/
    formalization/
    development/
    delivery/

  infrastructure/
    sqlite/
      open-database.ts
      schema/
        catalog.ts
        schema-identity.ts
        core.ts
        lifecycle.ts
        process-modules.ts
        workplaces.ts
        quality.ts
        effects.ts
        replay.ts
        workshop-installation.ts
      repositories/
        lifecycle/
        process-modules/
        workplace/
    process-modules/
      discovery/
      formalization/
      development/
      delivery/
    filesystem/
    git/
    process/
    model/

  tools/
    gateway/
      tool-gateway.ts
      tool-catalog.ts
      tool-definition.ts
      tool-authorization.ts
      tool-errors.ts
    adapters/
      worker-next-tool.ts
      worker-done-tool.ts
      worker-ask-need-tool.ts
      worker-ask-done-tool.ts
      worker-merge-tool.ts
      worker-health-query.ts
```

This layout is a target ownership map, not permission to invent new generic
abstractions. Extract an interface only when a real caller and implementation
need it.

## 6. Global invariants

Every agent must preserve these invariants throughout the train:

- Domain code imports no SQLite, Node runtime, tools, app or infrastructure.
- Application code depends on domain and ports, never concrete adapters.
- Infrastructure implements ports and owns driver-specific SQL.
- Tools decode, authorize, call an application command/query and encode a
  result. Tools own no transition policy or SQL.
- Only app runtime builders may import multiple infrastructure implementations.
- Repositories never create or alter tables.
- Only the schema catalog executes DDL.
- Only one function constructs `FactoryRuntime`.
- No module-level mutable runtime handles exist.
- CLI, MCP, worker and scripted hosts receive the same composition object.
- Every authoritative table has one command-side repository owner.
- Every lifecycle mutation has a typed command, fence/CAS rule and durable
  receipt.
- Universal process-module code never branches on a workshop name.
- Before C12, built-ins come only from an explicit closed catalog.
- Test compositions may replace declared external ports only. They may not
  replace gates, settlement, routing or persistence ownership.
- Temporary exceptions have an owner, removal packet and decreasing budget.
- No temporary exception survives the final merge gate.

## 7. Agent execution protocol

### 7.1 Scaffold before parallel work

One integration agent creates the target directories, exported types, empty
assembly functions and architecture policy files first. Other agents start only
after those signatures are committed.

This follows GUARDRAILS Sign 002: contracts before parallel bodies.

### 7.2 Exclusive file ownership

Assign ownership before starting agents:

| Lane | Exclusive write scope | Must not edit |
|---|---|---|
| Baseline and policy | `tools/architecture/**`, new baseline fixtures, architecture tests | runtime source |
| Schema | `src/db.ts`, `src/schema.ts`, `src/infrastructure/sqlite/schema/**`, DDL in repositories | app composition, lifecycle commands |
| Lifecycle and tools | `src/lifecycle/**`, `src/tools/dispatcher.ts`, new tool adapters and lifecycle repositories | schema catalog, app composition |
| Workshops | paths named by ADR-085 and workshop plan | lifecycle, app composition |
| Composition integrator | `src/app/**`, `src/orchestrate-cli.ts`, `src/index.ts`, `src/factory-e2e/**`, shared barrels | implementation bodies owned by other lanes |
| Large-file extraction | one named large file and its new target directory per agent | any other large-file lane |

Only the composition integrator edits shared bootstrap files. If another lane
needs a composition change, it exports a typed contribution and sends the
required wiring contract to the integrator.

### 7.3 Commit rules

- Do not mix behavior changes with file extraction.
- Do not mix generated fixture updates with unrelated source edits.
- A deletion commit must include the ratchet that forbids restoration.
- Do not commit compatibility shims as a final packet result.
- Do not weaken tests to make a structural move green.
- Do not reduce test, scenario, edge or mutation floors.
- Do not add dependencies.
- Do not run a factory workload while another tracked factory run is active.

## 8. Work packet dependency graph

```text
WP-00 baseline and mutation oracle
  |
  +--> WP-01 target contracts and policy scaffolds
          |
          +--> WP-10 fresh schema -------------------+
          +--> WP-20 lifecycle command authority ----+--> WP-40 composition
          +--> WP-30 workshop clean break -----------+       |
          +--> WP-35 tool gateway -------------------+       v
                                                      WP-50 legacy-zero gate
                                                               |
                                                               v
                                                      WP-60 full proof and merge
                                                               |
                                                               v
                                                      WP-70 large-file splits
                                                               |
                                                               v
                                                      WP-80 final documentation
```

WP-10, WP-20, WP-30 and WP-35 may run in parallel after WP-01, using exclusive
file ownership. WP-40 is the only integration lane. WP-10 through WP-60 form
one atomic merge train.

## 9. WP-00: baseline and no-regression oracle

Owner: baseline and policy lane

Goal: record what must remain semantically identical before moving ownership.

### Tasks

- [ ] Record current commit and package lock digest.
- [ ] Export the complete fresh `sqlite_master` inventory:
      tables, columns, indexes, foreign keys, triggers, normalized SQL.
- [ ] Export public tool definitions:
      names, descriptions, JSON schemas, authority requirements and error codes.
- [ ] Export lifecycle command inputs and normalized results.
- [ ] Export workshop manifests, resources, handlers and binding digests.
- [ ] Export the current composition graph for CLI, MCP, worker and scripted
      hosts.
- [ ] Record canonical durable traces for:
      claim, completion, rejection, repair, human wait, merge lease, gate,
      effect, final acceptance, settlement and lifecycle routing.
- [ ] Record test-file, test-case, scenario and transition-edge floors.
- [ ] Define the nondeterminism ignore list. Allow only UUID, timestamp,
      absolute path, PID and database row ID normalization.
- [ ] Add baseline corruption self-tests so an empty or incomplete baseline
      cannot pass.

### Required mutants

Each mutation must make the oracle red:

- [ ] Change one tool input property.
- [ ] Remove one lifecycle result field.
- [ ] Change one table constraint.
- [ ] Remove one transition event.
- [ ] Change one handler digest.
- [ ] Skip one effect receipt.
- [ ] Remove one workshop from a host composition.
- [ ] Change an accepted product reference.

### Exit gate

- [ ] Baseline is reproducible from the current revision.
- [ ] Every required mutant fails.
- [ ] The ignore list is explicit and reviewed.
- [ ] No runtime source has changed.

## 10. WP-01: target contracts and architecture policy scaffolds

Owner: integration agent

Goal: freeze interfaces before parallel implementation.

### Create these contracts

```ts
interface FactoryRuntime {
  readonly commands: FactoryCommands;
  readonly lifecycle: LifecycleCommandBus;
  readonly processRuntime: ProcessRuntime;
  readonly queries: FactoryQueries;
  readonly compositionFingerprint: string;
  close(): void;
}

interface FactoryComposition {
  readonly schemaIdentity: string;
  readonly workshopCatalogDigest: string;
  readonly toolCatalogDigest: string;
  readonly roleBindingDigests: Readonly<Record<ProcessRole, string>>;
}

interface LifecycleCommandBus {
  execute<C extends LifecycleCommand>(command: C): ResultFor<C>;
}

interface SchemaCatalog {
  readonly identity: string;
  readonly createSql: string;
  verify(db: SqliteDatabase): void;
}
```

### Create architecture policy inputs

- `tools/architecture/topology.json`
- `tools/architecture/table-ownership.json`
- `tools/architecture/file-budgets.json`
- `tools/architecture/legacy-denylist.json`

Policy files must refer to paths that exist. CI must fail if a configured root
is absent, empty or scans fewer files than its non-vacuity floor.

### Exit gate

- [ ] Contracts compile with placeholder implementations.
- [ ] No global singleton is part of a target interface.
- [ ] Policy scanners fail on missing roots.
- [ ] Parallel lanes have non-overlapping write scopes.
- [ ] The integration agent owns every shared barrel and composition file.

## 11. WP-10: fresh schema and database bootstrap

Owner: schema lane

Goal: one fresh schema, one DDL executor, zero migration behavior.

### Target rules

- `src/infrastructure/sqlite/schema/catalog.ts` is the only DDL executor.
- Schema fragments are pure strings plus ownership metadata.
- Fragment order is deterministic and dependency checked.
- Repositories assume the current schema and never call `ensure*Schema`.
- An empty database receives the complete current schema in one transaction.
- A database with the exact current schema identity opens without mutation.
- Any other schema identity fails with `DATABASE_SCHEMA_IDENTITY_MISMATCH` and
  an instruction to recreate the disposable database.
- There is no migration runner directory in runtime source.

### Extraction order

1. Move DDL verbatim from `schema.ts` into domain-owned fragments.
2. Move repository-local `CREATE TABLE` statements into the catalog.
3. Generate one normalized aggregate SQL snapshot.
4. Compare old and new fresh `sqlite_master` output.
5. Switch `open-database.ts` to the new catalog.
6. Delete `ensure*Schema` calls and implementations.
7. Delete every runtime `ALTER TABLE`, table rebuild and legacy column probe.
8. Rewrite migration-only test cases in place as fresh-schema identity refusal
   tests. Do not delete test files without explicit human approval.
9. Reduce `src/schema.ts` and `src/db.ts` to deleted files or thin canonical
   exports with no DDL logic. Prefer deletion when all imports are moved.

### Checklist

- [ ] `rg -n "ALTER TABLE" src` returns zero.
- [ ] `rg -n "ensure.*Schema" src` returns zero runtime schema helpers.
- [ ] Repository constructors contain no `CREATE TABLE`, `CREATE INDEX`,
      `CREATE TRIGGER` or `PRAGMA table_info` compatibility checks.
- [ ] Fresh schema contains every required table, index, FK and trigger.
- [ ] Schema identity is deterministic across two fresh creations.
- [ ] Schema creation is transactional.
- [ ] Foreign key check passes.
- [ ] A mutated or old identity fails without modifying the database.
- [ ] No test expects an old schema to upgrade.
- [ ] `src/db.ts` no longer initializes application registries.

### Tests

- fresh empty database bootstrap;
- exact-current reopen without DDL writes;
- wrong-identity fail-closed behavior;
- fragment dependency cycle rejection;
- duplicate table ownership rejection;
- normalized `sqlite_master` parity;
- transaction rollback after injected DDL failure;
- repository construction performs zero DDL.

### Exit gate

- [ ] New fresh schema matches the approved target inventory.
- [ ] Runtime migration and compatibility code count is zero.
- [ ] All schema mutants fail.

## 12. WP-20: lifecycle command authority

Owner: lifecycle lane

Goal: application commands own every lifecycle mutation; tools own none.

### Command set

Implement typed commands for:

- `WorkerNext`;
- `WorkerDone`;
- `WorkerAskNeed`;
- `WorkerAskDone`;
- `WorkerMergeAcquire`;
- `WorkerMergeRelease`.

Treat worker health as a query unless it performs a mutation. If it mutates,
split the observation query from an explicit reconciliation command.

### Per-command structure

```text
decode tool input
  -> construct typed command
  -> authorize actor and fence
  -> execute one application use case
  -> call domain transition policy
  -> commit through repository ports in one transaction
  -> write idempotency/command receipt
  -> return typed result
  -> encode tool output
```

### Required ports

- TaskLifecycleRepository
- WorkerExecutionRepository
- CommandReceiptRepository
- LifecycleEventRepository
- HumanInteractionRepository
- RepositoryLeaseRepository
- TransactionPort
- ClockPort only where time is a real input

Do not expose a generic database handle through these ports.

### Cutover checklist

- [ ] Replace `LifecycleCommandResult.reply: unknown` with a discriminated
      `ResultFor<Command>` mapping.
- [ ] Move transaction ownership into each application command.
- [ ] Move SQL into concrete lifecycle repository adapters.
- [ ] Preserve stable command IDs and idempotency behavior.
- [ ] Preserve execution fences and CAS predicates.
- [ ] Preserve durable rejection and retry feedback.
- [ ] Preserve same-Workplace repair behavior.
- [ ] Make every caller use the command bus.
- [ ] Delete the lazy dispatcher import from lifecycle application code.
- [ ] Delete dispatcher lifecycle handler bodies.
- [ ] Delete temporary lifecycle writer exceptions.
- [ ] Forbid direct lifecycle SQL in tools, app and domain.

### Transition tests

For every command, test:

- legal transition;
- every illegal source state;
- stale execution fence;
- duplicate command ID;
- transaction failure before the first write;
- failure after each durable write boundary;
- retry after failure;
- concurrent attempts;
- terminal immutability;
- exact event and receipt sequence;
- typed error code and public tool response.

### Exit gate

- [ ] Every mutation is reachable only through the command bus.
- [ ] Dispatcher contains no lifecycle SQL or handler implementation.
- [ ] There is no lifecycle-to-dispatcher import.
- [ ] Base and candidate normalized command traces are equal.
- [ ] Direct-SQL and command-bypass mutants fail.

## 13. WP-30: workshop and module ownership

Owner: workshop lane

Goal: execute ADR-085 without introducing a second composition mechanism.

Follow `docs/plans/WORKSHOP-MODULARIZATION-REFACTORING-PLAN.md` exactly, with
these integration constraints:

- all four workshops move in the same authority train;
- `src/process-modules/modules/**` is deleted before merge;
- concrete SQLite adapters live under `src/infrastructure/process-modules`;
- workshop ports and contracts live under `src/modules/<workshop>`;
- `built-in-catalog.ts` is a closed literal tuple;
- the catalog does not discover packages from files or configuration;
- the catalog exports pure contributions for the composition integrator;
- no workshop calls a process-global registrar;
- all factual `WORKSHOP.md` inventories are generated and checked.

### Additional checklist

- [ ] Extract the shared acceptance-code parser so Development does not import
      Formalization implementation code.
- [ ] Remove the final cross-workshop implementation allowlist entry.
- [ ] Move all module-owned resource paths and regenerate digests.
- [ ] Update authoring kit output to the target layout.
- [ ] Make conformance scan only `src/modules/<workshop>`.
- [ ] Keep ADR-082 admission projections explicit and closed.
- [ ] Export contributions instead of mutating registries.
- [ ] Verify every process role resolves the same workshop binding digest.

### Exit gate

- [ ] Each workshop has one home and one public `index.ts`.
- [ ] Legacy workshop path count is zero.
- [ ] Cross-workshop implementation import count is zero.
- [ ] Closed catalog parity is exact for all roles.

## 14. WP-35: tool gateway

Owner: lifecycle and tools lane

Goal: replace the god dispatcher with a universal gateway and focused adapters.

### Gateway responsibilities

The gateway may only:

- resolve a stable tool ID;
- decode the declared input schema;
- obtain causal and execution context;
- enforce declared authorization;
- invoke the installed handler;
- normalize errors;
- emit telemetry;
- encode the declared output.

The gateway may not:

- execute SQL;
- choose lifecycle transitions;
- infer authority from latest rows;
- construct repositories;
- import workshop implementations;
- contain a switch on workshop name;
- register handlers after runtime construction.

### Adapter checklist

- [ ] One adapter file per lifecycle command or cohesive query family.
- [ ] Tool definitions and handlers are separate values.
- [ ] Existing tool names and JSON schemas remain byte-equivalent unless a
      separately approved behavior change is required.
- [ ] Authority requirements are explicit data.
- [ ] Handler identities and implementation digests are cataloged.
- [ ] Catalog registration is immutable after bootstrap.
- [ ] `src/tools/dispatcher.ts` is deleted before merge.
- [ ] No compatibility barrel keeps dispatcher import paths alive.

### Exit gate

- [ ] Tool golden snapshot is equal to baseline.
- [ ] All lifecycle tools invoke typed commands.
- [ ] Gateway contains no domain policy or SQL.
- [ ] Missing, duplicate and unauthorized contribution mutants fail.

## 15. WP-40: immutable canonical composition

Owner: composition integrator

Goal: one host-neutral runtime object consumed everywhere.

### Required constructor

```ts
function createFactoryRuntime(
  config: FactoryRuntimeConfig,
  adapters: FactoryRuntimeAdapters,
): FactoryRuntime
```

The constructor builds in this order:

1. validate config;
2. open and verify the fresh schema identity;
3. construct repository adapters;
4. install the closed workshop catalog;
5. install the immutable tool catalog;
6. construct lifecycle command bus;
7. construct process-module runtime;
8. construct quality and effect runtime;
9. construct worker runtime;
10. construct recovery commands;
11. validate exact binding coverage;
12. compute the composition fingerprint;
13. return explicit handles and `close()`.

### Composition checklist

- [ ] CLI receives `FactoryRuntime`; it constructs no repositories.
- [ ] MCP host receives `FactoryRuntime`; it mutates no global route table.
- [ ] Worker host receives declared capabilities from the same composition.
- [ ] Scripted host replaces only declared external ports and inference.
- [ ] Fresh harness does not rebuild registries independently.
- [ ] `product-lifecycle-runtime.ts` becomes focused assembly functions or is
      deleted.
- [ ] `composition-root.ts` becomes the one constructor or is deleted in favor
      of `createFactoryRuntime`.
- [ ] Remove `getLastFactoryWorkAssignment`.
- [ ] Remove `getLastFactoryWorkerExecutorFactory`.
- [ ] Remove `getLastFactoryEpisodeRuntimeRepository`.
- [ ] Remove dispatcher route setters and other post-construction mutation.
- [ ] Remove competing manifest arrays and schema resolver maps.
- [ ] Close order is explicit and idempotent.
- [ ] Composition fingerprint includes schema, tools, workshops, handlers,
      checks, effects and role bindings.

### Tests

- every host has the same composition fingerprint;
- missing adapter fails before issuing work;
- missing or extra binding fails before issuing work;
- duplicate tool or handler ID fails before issuing work;
- `close()` releases every owned resource once;
- a second runtime in one process has no shared mutable state;
- test overrides outside the declared allowlist fail;
- removing a built-in makes it unavailable in every host.

### Exit gate

- [ ] Exactly one runtime constructor exists.
- [ ] Exactly one closed built-in catalog exists.
- [ ] No module-global mutable composition handle exists.
- [ ] CLI, MCP, worker and scripted hosts have equal fingerprints.

## 16. WP-50: architecture ratchet repair

Owner: baseline and policy lane, integrated after final paths exist

Goal: make green architecture tests prove the real target topology.

### Replace path assumptions

- [ ] Remove `src/process-modules/composition` from classifiers unless it
      actually exists in the target.
- [ ] Scan the real `src/app/runtime` composition root.
- [ ] Treat only `src/modules/<name>` as workshop code.
- [ ] Scan every module subdirectory, including `infrastructure`, for forbidden
      driver imports.
- [ ] Fail if a configured root does not exist.
- [ ] Fail if a scan finds fewer files than its baseline floor.
- [ ] Delete dual-root same-module exceptions.
- [ ] Delete sanctioned dispatcher lifecycle writer exceptions.

### Positive ownership checks

Do not rely only on forbidden regexes. Add positive checks:

- every authoritative table has exactly one owner;
- every tool has one definition and one handler;
- every lifecycle command has one application owner;
- every workshop contribution appears in every required role projection;
- every host receives the canonical composition fingerprint;
- every schema fragment appears in the schema catalog;
- every `WORKSHOP.md` generated inventory matches code;
- every architecture policy root exists and is non-empty.

### Mutation self-tests

- [ ] Point the composition scanner at a missing directory.
- [ ] Put SQLite in `src/modules/x/infrastructure`.
- [ ] Add a second runtime constructor.
- [ ] Add a direct dispatcher handler.
- [ ] Add a second table owner.
- [ ] Omit a workshop from the worker role.
- [ ] Add an undeclared tool handler.
- [ ] Add a cross-workshop import.
- [ ] Add a module-name branch in universal runtime.
- [ ] Reduce a test/scenario floor.

### Exit gate

- [ ] All self-test mutants fail.
- [ ] Exception and allowlist count is zero for the targeted red flags.
- [ ] No test description names a removed path as the current architecture.

## 17. WP-60: atomic legacy-zero merge gate

Owner: composition integrator

The authority train is mergeable only when every item is true.

### Source deletion checklist

- [ ] Zero `ALTER TABLE` in runtime source.
- [ ] Zero repository-local schema creation.
- [ ] Zero lifecycle-to-dispatcher imports.
- [ ] Zero lifecycle SQL in tool files.
- [ ] Zero `src/tools/dispatcher.ts` implementation or shim.
- [ ] Zero mutable `lastFactory*` handles.
- [ ] Zero competing runtime constructors.
- [ ] Zero competing built-in workshop arrays.
- [ ] Zero `src/process-modules/modules/**` files.
- [ ] Zero cross-workshop implementation imports.
- [ ] Zero compatibility feature flags introduced by this train.
- [ ] Zero test-only composition roots.

### Behavioral checklist

- [ ] Fresh schema identity and catalog snapshot pass.
- [ ] Tool definition golden snapshot passes.
- [ ] Lifecycle command/result snapshots pass.
- [ ] Workshop manifest and role binding parity pass.
- [ ] Base/candidate normalized durable trace diff is zero.
- [ ] All crash and duplicate-delivery schedules converge.
- [ ] Test/scenario/edge floors are unchanged or higher.
- [ ] Every required mutation is killed.

### Merge policy

- Tag or record the pre-cutover commit.
- Merge the complete authority graph as one unit.
- If the gate fails, fix the train or revert the whole train.
- Do not restore a compatibility path to make one failing test pass.
- Recreate disposable local databases after merge.

## 18. WP-70: large-file decomposition

Owner: one agent per file family after WP-60

Goal: split by responsibility, not by line count alone.

### 18.1 Universal split procedure

For every large file:

1. List its public exports and all importers.
2. List responsibilities using verbs, not code regions.
3. Identify transaction and authority boundaries.
4. Write characterization tests for each public behavior.
5. Define target modules and dependency direction.
6. Move pure types and pure functions first.
7. Move one application responsibility at a time.
8. Keep a thin coordinator that only sequences dependencies.
9. Move SQL only to the owning repository adapter.
10. Delete the old implementation in the same extraction commit.
11. Run import-cycle, behavior, temporal and mutation tests.
12. Tighten the file budget after the split.

Do not create files named `helpers.ts`, `utils.ts`, `common.ts` or `misc.ts`
unless the contents are genuinely domain-neutral and have at least two proven
consumers.

### 18.2 File budgets

Budgets are smoke alarms, not substitutes for design review:

- coordinator or runtime builder: maximum 400 handwritten lines;
- application use case: maximum 300 handwritten lines;
- repository facade: maximum 400 handwritten lines;
- individual function: maximum 120 handwritten lines;
- new general source file: maximum 600 handwritten lines;
- files above 800 lines require an expiring exception with owner and removal
  packet;
- generated schema snapshots and generated catalogs are exempt;
- after WP-70, handwritten runtime files above 1,000 lines must be zero.

The budget scanner ignores blank lines and comments. Exception budgets may only
shrink.

### 18.3 `production-cell-node-executor.ts`

Current problem: coordination, Workplace materialization, candidate authority,
quality gates, effects, recovery and settlement share one file.

Target split:

```text
src/process-modules/application/production-cell/
  production-cell-executor.ts          # thin coordinator
  prepare-node-run.ts
  materialize-workplaces.ts
  reconcile-workplaces.ts
  execute-author-attempt.ts
  seal-candidate-set.ts
  execute-quality-gate.ts
  apply-acceptance-effects.ts
  record-final-acceptance.ts
  settle-production-cell.ts
  recover-production-cell.ts
  production-cell-dependency-graph.ts
  production-cell-semantic-input.ts
  production-cell-ports.ts
```

Verification:

- [ ] Coordinator contains no SQL.
- [ ] Coordinator contains no workshop-name branch.
- [ ] Candidate sealing owns exact product and revision identity.
- [ ] Gate driver cannot select by recency.
- [ ] Effect driver consumes exact accepted authority.
- [ ] Recovery preserves Workplace and production revision lineage.
- [ ] Fault tests cover every durable boundary.

### 18.4 `generic-flow-executor.ts`

Target split:

```text
src/process-modules/application/flow/
  flow-executor.ts                      # thin coordinator
  prepare-flow-run.ts
  load-flow-frame.ts
  bind-node-input.ts
  schedule-flow-node.ts
  execute-flow-node.ts
  advance-flow-transition.ts
  checkpoint-flow-frame.ts
  settle-flow-outcome.ts
  resume-flow-run.ts
  flow-recovery.ts
```

Verification:

- [ ] Flow graph walking is a pure function where possible.
- [ ] Durable cursor/frame logic has one owner.
- [ ] Node dispatch does not know workshop names.
- [ ] Resume uses exact stored frame identity.
- [ ] Terminal settlement is idempotent.
- [ ] Every legal and illegal flow edge is tested.

### 18.5 `schema.ts` and `db.ts`

These files are handled by WP-10, not by arbitrary line splitting.

Target split:

```text
src/infrastructure/sqlite/
  open-database.ts
  schema/catalog.ts
  schema/schema-identity.ts
  schema/core.ts
  schema/lifecycle.ts
  schema/process-modules.ts
  schema/workplaces.ts
  schema/quality.ts
  schema/effects.ts
  schema/replay.ts
  schema/workshop-installation.ts
```

Verification:

- [ ] One aggregate schema identity.
- [ ] One DDL executor.
- [ ] No application initialization in database bootstrap.
- [ ] No compatibility DDL.
- [ ] Exact fresh schema snapshot.

### 18.6 `tools/dispatcher.ts`

This file is deleted by WP-20 and WP-35.

Target split:

```text
src/tools/gateway/
  tool-gateway.ts
  tool-catalog.ts
  tool-authorization.ts
  tool-errors.ts

src/tools/adapters/
  worker-next-tool.ts
  worker-done-tool.ts
  worker-ask-need-tool.ts
  worker-ask-done-tool.ts
  worker-merge-tool.ts
  worker-health-query.ts
```

Verification:

- [ ] Gateway owns no business rule.
- [ ] Adapter owns no SQL.
- [ ] Tool schema snapshots remain equal.
- [ ] Lifecycle command bus is the only mutation path.

### 18.7 `factory-start.ts`

Current problem: parsing, start/resume selection, recovery cases, orchestration
and response projection are combined.

Target split:

```text
src/app/commands/
  decode-factory-start.ts
  start-factory.ts
  resume-factory.ts
  abandon-factory.ts
  recover-orphaned-launch.ts
  recover-missing-product.ts
  recover-failed-gate.ts
  recover-paused-workplace.ts
  recover-worker-loss.ts
  factory-command-results.ts
```

Verification:

- [ ] Decoder performs no reads or writes.
- [ ] Each recovery class has one typed command.
- [ ] Recovery evidence is exact, not latest-by-time.
- [ ] Commands receive repositories through `FactoryRuntime`.
- [ ] No command constructs a runtime or database.

### 18.8 `product-lifecycle-runtime.ts`

Current problem: repository creation, quality providers, effects, workshop
registration, output resolvers and lifecycle engine assembly are combined.

Target split:

```text
src/app/runtime/
  factory-runtime.ts
  factory-composition.ts
  build-persistence.ts
  build-workshops.ts
  build-quality-runtime.ts
  build-process-runtime.ts
  build-lifecycle-runtime.ts
  build-worker-runtime.ts
  build-recovery-runtime.ts
  composition-fingerprint.ts
```

Verification:

- [ ] Builders only construct and bind objects.
- [ ] Builders contain no domain decisions.
- [ ] Output routing comes from typed lifecycle mappings.
- [ ] Workshop capabilities come from the closed catalog.
- [ ] All builders feed one `FactoryRuntime` constructor.

### 18.9 `development-check-providers.ts`

Split one provider per file:

```text
src/modules/development/application/checks/
  task-graph-check.ts
  scope-check.ts
  claim-monotonicity-check.ts
  verification-check.ts
  readiness-check.ts
  integration-check.ts
  candidate-reader.ts
  finding-normalizer.ts
  development-check-catalog.ts
```

Verification:

- [ ] Each provider declares inputs and trusted evidence.
- [ ] Shared readers are read-only and exact-ref based.
- [ ] Catalog has exact manifest parity.
- [ ] Provider tests include false-positive and false-negative cases.

### 18.10 `scenario-runner.ts`

Target split:

```text
src/process-modules/application/scenario/
  compile-scenario.ts
  validate-scenario.ts
  install-scenario.ts
  lock-scenario.ts
  start-scenario.ts
  resume-scenario.ts
  route-scenario-stage.ts
  project-scenario-result.ts
  scenario-runner.ts
```

Verification:

- [ ] Compiler and validator are pure.
- [ ] Installation and locking have separate ports.
- [ ] Runner is a thin coordinator.
- [ ] Resume and stage routing have deterministic tests.

### 18.11 Large SQLite repositories

Apply this split pattern to repositories above 800 lines:

```text
<bounded-context>/
  <name>-repository.ts                  # port-facing facade
  <name>-commands.ts                    # writes and CAS statements
  <name>-queries.ts                     # exact reads
  <name>-row-codec.ts                   # row to domain conversion
  <name>-statements.ts                  # SQL constants
```

Schema DDL does not live beside repositories after WP-10.

Candidates include:

- `sqlite-development-settlement-state.ts`;
- `sqlite-discovery-runtime.ts`;
- `sqlite-lifecycle-run-repository.ts`;
- `sqlite-production-cell-projection-persistence.ts`;
- `sqlite-replay-capsule-repository.ts`.

Verification:

- [ ] Command and query responsibilities are separated.
- [ ] Row codecs are pure and exhaustively tested.
- [ ] Writes use exact identity and CAS where required.
- [ ] No query selects authority by recency.
- [ ] Repository facade contains no schema creation.

### 18.12 `local-runnability-check-provider.ts`

Target split:

```text
src/infrastructure/verification/local-runnability/
  local-runnability-provider.ts
  resolve-check-command.ts
  execute-check-process.ts
  collect-runnability-evidence.ts
  evaluate-runnability-policy.ts
  build-runnability-receipt.ts
  local-runnability-types.ts
```

Verification:

- [ ] Command resolution is deterministic and separately tested.
- [ ] Process execution is behind a port/fake.
- [ ] Evidence collection cannot decide acceptance.
- [ ] Policy is pure and consumes explicit evidence.
- [ ] Receipt contains exact command, environment and result identity.

### 18.13 `development-settlement-policy.ts`

Target split:

```text
src/modules/development/domain/settlement/
  settlement-decision.ts
  task-graph-evidence.ts
  integration-evidence.ts
  verification-evidence.ts
  readiness-evidence.ts
  settlement-reasons.ts
  development-settlement-policy.ts
```

Verification:

- [ ] Evidence predicates are pure.
- [ ] One decision table defines precedence.
- [ ] Reason rendering is separate from decision logic.
- [ ] Every combination has an expected decision or lawful open state.

## 19. WP-80: lifecycle naming and documentation closure

Owner: documentation/integration agent

Goal: remove ambiguous roots and make the repository agent-readable.

### Tasks

- [ ] Move task assignment lifecycle code under `src/lifecycle/task`.
- [ ] Move product lifecycle definitions from
      `src/process-modules/lifecycles` to `src/lifecycle/product`.
- [ ] Add `src/lifecycle/LIFECYCLE.md` explaining both subdomains.
- [ ] Make `src/lifecycle/index.ts` the only cross-subdomain public surface.
- [ ] Delete stale references to missing lifecycle ADR/doc paths.
- [ ] Regenerate architecture topology documentation from policy inputs.
- [ ] Add owner, purpose, public API, tables, commands and tests for each major
      context to its README or context document.
- [ ] Check every documentation path and command in CI.

### Exit gate

- [ ] No ambiguous `lifecycles` root remains under process modules.
- [ ] An agent can distinguish task lifecycle from product lifecycle from paths
      alone.
- [ ] Documentation contains no missing local links.

## 20. No-regression test ladder

### L0: static architecture and contract proof

- TypeScript build and lint.
- Import dependency direction.
- Real topology root existence and non-vacuity.
- One schema DDL owner.
- One table owner per authoritative table.
- One runtime constructor.
- One closed workshop catalog.
- One lifecycle command owner per mutation.
- No global runtime state.
- No old path or compatibility symbol.
- Public tool and manifest snapshots.
- File and function budgets.

### L1: pure domain and application behavior

- Lifecycle transition matrices.
- Command authorization and result mapping.
- Flow walking and node scheduling.
- Candidate/gate/effect/recovery policies.
- Settlement decision tables.
- Schema fragment dependency ordering.
- Tool input decoding and error normalization.

### L2: disposable SQLite durability

- Fresh schema creation and exact identity.
- Transaction rollback.
- CAS/fence races.
- Idempotent command receipts.
- Atomic claim and execution creation.
- Terminal immutability.
- Exact accepted-material reads.
- Exactly-once effect receipts.
- Second runtime isolation in one process.

### L3: canonical composition

Use `createFactoryRuntime` and replace inference/external process ports only.

Prove:

- every host has the same composition fingerprint;
- worker termination returns to the kernel;
- CandidateSet, gate, effect, final acceptance, settlement and route occur in
  the exact order;
- reject-to-repair stays on the same Workplace;
- all built-in workshops are available through the same catalog;
- deleting one catalog entry removes it from every role.

### L4: temporal and fault schedule

Crash before and after:

1. task claim;
2. WorkerExecution creation;
3. product submission;
4. completion receipt;
5. ProductionRevision;
6. CandidateSet;
7. CheckReceipt;
8. GateDecision;
9. required effect;
10. final acceptance;
11. ProcessRun settlement;
12. product lifecycle route.

Every case must converge to progress, a typed wait or a terminal typed incident
without duplicate effects or accepted products.

### L5: fresh local product E2E

- Create a fresh disposable database and repository.
- Construct the canonical runtime.
- Install all four workshops.
- Run the full scripted lifecycle.
- Run same-project A then B behavior.
- Prove the final product is externally runnable.
- An optional local real-model smoke may follow deterministic proof, but it is
  not a structural acceptance gate.

### S: satisfiability

- Run general gate-conjunction satisfiability.
- Run workshop scope/artifact/environment conjunctions.
- Reject zero-edge and vacuously terminal scenarios.
- Require a proof, lawful exit or honestly open state for every contradiction.

### Differential proof

Run base and candidate revisions separately with identical scripted inputs and
disposable fixtures. Compare:

- products and exact refs;
- Workplace and ProductionRevision lineage;
- CandidateSets;
- receipts and decisions;
- effects;
- settlement and routing;
- lifecycle events and reason sequence;
- public tool outputs;
- terminal outcome.

Ignore only the nondeterminism approved in WP-00.

## 21. Required mutation suite

The final suite must fail if any mutation is introduced:

- add a runtime `ALTER TABLE`;
- add repository-local schema creation;
- add lifecycle SQL to a tool;
- bypass the lifecycle command bus;
- restore lifecycle-to-dispatcher delegation;
- add a second runtime constructor;
- add a mutable `lastFactory*` handle;
- add a second built-in catalog;
- omit a workshop capability from one process role;
- add a test-private composition;
- point a scanner at a missing root;
- exclude module infrastructure from dependency scanning;
- add a cross-workshop implementation import;
- add a workshop-name switch to universal code;
- select accepted authority using `latest` or execution identity;
- remove a fence, CAS predicate or idempotency receipt;
- remove a fault boundary scenario;
- reduce a non-vacuity floor;
- add a handwritten file above budget without an exception;
- leave an exception after its removal packet completes.

## 22. Commands and CI gates

Existing mandatory commands:

```text
npm run build
npm run lint
npm run test:architecture
npm run test:process-modules
npm run test:factory-contract
npm run test:factory-temporal
npm run test:golden-path
npm run test:acceptance-matrix
npm test
```

Commands to add during WP-00 and WP-50:

```text
npm run architecture:inventory -- --check
npm run architecture:mutants
npm run schema:snapshot -- --check
npm run composition:fingerprint -- --check-all-hosts
npm run lifecycle:contract -- --check
npm run structural:diff -- --base <ref> --candidate <ref>
npm run file-budgets -- --check
```

The new commands must fail on missing fixtures, empty scans and zero-test
execution. A command that silently skips its target is a failing command.

## 23. Reviewer checklist

### Authority

- [ ] Does the change reduce authority paths to one?
- [ ] Is the old implementation deleted in the same completed packet/train?
- [ ] Is every command, table, tool and catalog entry owned exactly once?
- [ ] Are exact refs used instead of latest/execution/task lookup?
- [ ] Are fences, CAS and idempotency preserved?

### Boundaries

- [ ] Does domain remain pure?
- [ ] Does application depend only on domain and ports?
- [ ] Does infrastructure own driver-specific details?
- [ ] Are tools thin adapters?
- [ ] Is composition the only layer importing multiple concrete contexts?
- [ ] Did the extraction introduce a circular or lazy import?

### Greenfield policy

- [ ] Was any migration or compatibility code added?
- [ ] Was an old schema shape retained without a current consumer?
- [ ] Does wrong schema identity fail with recreate guidance?
- [ ] Are all test databases disposable and fresh?

### Tests

- [ ] Does the test use canonical composition?
- [ ] Does it assert semantic output, not only a success label?
- [ ] Does it cover negative and crash behavior?
- [ ] Would the corresponding mutant make it fail?
- [ ] Did any test/scenario/count floor decrease?
- [ ] Does every scanner prove its root exists and is non-empty?

### Large-file extraction

- [ ] Are modules split by reasons to change?
- [ ] Is the coordinator thin?
- [ ] Is policy separated from I/O?
- [ ] Is SQL separated from row codecs and application policy?
- [ ] Did public behavior remain equal?
- [ ] Did the old implementation disappear?
- [ ] Did file and function budgets tighten?

## 24. Final definition of done

The project cleanup is complete only when every statement is true:

- [ ] The fresh schema has one identity and one DDL executor.
- [ ] Runtime source contains no migration or compatibility DDL.
- [ ] Repositories create no tables.
- [ ] Lifecycle application commands own every mutation.
- [ ] Tools contain no transition SQL or domain decisions.
- [ ] `dispatcher.ts` is deleted.
- [ ] All hosts consume one immutable `FactoryRuntime` composition.
- [ ] No mutable composition side channel exists.
- [ ] Workshops have one home and one closed catalog.
- [ ] Architecture tests scan the actual target paths and prove non-vacuity.
- [ ] Targeted exception lists are empty.
- [ ] Handwritten runtime files above 1,000 lines are zero.
- [ ] Coordinators and functions satisfy the file budgets.
- [ ] Task lifecycle and product lifecycle have unambiguous paths.
- [ ] Local documentation links and commands are valid.
- [ ] Base/candidate semantic diff is zero.
- [ ] L0 through L5, S and mutation gates are green.
- [ ] No production deployment, data migration or backward compatibility claim
      was introduced.

## 25. Stop conditions

Stop the train and write a new decision if:

- a persistent environment or external consumer appears;
- a behavior change is required to complete a structural extraction;
- ADR-082 admission must be opened;
- a target command cannot preserve its fence/transaction semantics;
- the differential oracle reveals an intentional semantic difference;
- the target authority graph requires a second live path to function.

Do not solve a stop condition by adding a hidden compatibility mechanism.
