---
name: saga-process-module-designer
description: "Designs or reviews one Saga Process Module. Separates process content from Runtime execution physics, defines contracts/Flow/profiles/assets, applies the mandatory checklist, and stops without implementing unrelated downstream modules."
---

# saga-process-module-designer

You design **exactly one** Process Module or review one proposed module change.

The governing rule is:

> The Process Module defines the content of work. The Runtime defines the physics of execution.

Do not move worker spawning, execution fencing, heartbeat, persistence, tracker provisioning,
MCP gateway enforcement, retries or recovery into a domain module. Do not move domain schemas,
policies, reason codes, artifacts, skills or semantic checklists into the generic Runtime.

## Mandatory source of truth

Read before doing any design work:

1. `docs/saga3/process-modules/ARCHITECTURE.md`
2. `docs/saga3/process-modules/PROCESS-MODULE-CHECKLIST.md`
3. `src/process-modules/domain/process-module.ts`
4. `src/process-modules/application/validate-process-module.ts`

Maintain an external design tracker. Do not hold module decisions only in conversation memory.
Use the Process Module checklist as the tracker backbone and mark each section pass/fail with evidence.

## Workflow

### Step 1 — Define the black-box process contract

Write:

- versioned module identity;
- independent domain goal;
- input contract;
- output certificate/result contract;
- finite local outcomes;
- authority owner of the final result.

Reject a design that names its downstream Process Module. The module returns a local outcome;
a Stage Binding routes it.

### Step 2 — Separate content from execution physics

Create two explicit lists.

**Module content:** schemas, artifact meanings, policies, invariants, reason codes, Flow,
skills, templates, checklists and validators.

**Runtime physics:** WorkIntent lifecycle, Process Run, Node Run, task projection, execution
identity, worker spawn, tracker provisioning, hooks, capability sandbox, materialized MCP calls,
validation ladder, retries, recovery, persistence and routing mechanics.

Every proposed responsibility must appear in exactly one list.

### Step 3 — Define the Flow

For every node specify:

- stable id;
- kind: LM, Kernel, Human, External or Composite;
- input and output schema;
- authority;
- transition events;
- failure/retry/pause routes.

Every node must be reachable. Every terminal node emits one declared local outcome.
An LM node may propose or advise; an authoritative decision requires Kernel or explicitly
authorized Human settlement.

### Step 4 — Define each LM Execution Cell

For every LM node define an execution profile containing:

- WorkIntent kind and schema;
- task kind;
- execution skill;
- allowed MCP tools;
- external tracker template;
- workspace templates;
- materialized MCP call templates;
- pre-submit checklist;
- output schema;
- retry policy;
- recovery policy.

The tracker must contain a program counter, machine-filled binding, artifacts, traces,
materialized calls, errors, attempt and resume checkpoint.

### Step 5 — Enforce machine-filled binding

The kernel must fill all values it already knows:

- process/lifecycle/stage/node run ids;
- WorkIntent, task, execution and worker ids;
- project, epic and repository ids;
- schema versions;
- immutable artifact ids/hashes;
- authority scope and allowed tools.

The LM produces only irreducibly semantic content. Never ask it to remember or infer known ids.

### Step 6 — Define skills, hooks and MCP materialization

For each skill:

- inline the full skill at worker startup;
- read tracker before every consequential action;
- update tracker after every step;
- copy templates rather than recreating calls;
- read call JSON back;
- apply the checklist;
- invoke exact MCP names and parameters;
- stop on exhausted policy rather than fake completion;
- call `worker_done` once and exit.

Hooks must return the worker to the tracker at startup, before submit, after error and after restart.
The Runtime MCP gateway enforces the allowlist; prompt discipline alone is insufficient.

### Step 7 — Define artifacts, provenance and settlement

Every artifact declares schema and authority. Every output binds to Process Run, Node Run,
WorkIntent and Execution. Source refs come only from an allowed source set. Advisory artifacts
cannot mutate authoritative artifacts. Settlement records exact inputs and policy version/hash.

### Step 8 — Apply the mandatory checklist

Run every section of `PROCESS-MODULE-CHECKLIST.md` and attach evidence paths/tests.
Do not mark a section passed because the prompt says so; point to code, schema, skill,
template, MCP enforcement, test or smoke result.

### Step 9 — Validate and test

Required minimum:

- `validateProcessModuleDefinition` passes;
- referenced skills/templates/checklists exist;
- Runtime core has no module-semantic imports;
- module has no downstream-module imports;
- every outcome is routed by a sample or production Stage Binding;
- restart, authority, machine-filled provenance and materialized-call path are tested;
- real LM smoke is listed as required evidence if not yet run.

## Output

Produce or update:

1. Process Module definition;
2. Flow and execution profiles;
3. schemas/policies/invariants;
4. tracker, MCP call templates and checklists;
5. skills;
6. Stage Binding example;
7. automated tests;
8. design document with unresolved implementation gaps.

Then stop. Do not implement another Process Module unless it is explicitly part of the task.
