# Process Module Definition and Delivery Checklist

This checklist is a mandatory gate for every new or changed Process Module.
It protects the central separation:

> The Process Module defines the content of work. The Runtime defines the physics of execution.

A module is not ready because its happy-path prompt works. It is ready only when
its contracts, Flow, WorkIntents, skills, hooks, external memory, materialized MCP
calls, authority, artifacts, validation and recovery form one coherent system.

---

## A. Module boundary

- [ ] Module has a versioned identity: `name@semver` and stable `kind`.
- [ ] Module has one independent domain goal.
- [ ] Module input contract is explicit and versioned.
- [ ] Module output contract is explicit and versioned.
- [ ] Local outcomes are finite, named and described.
- [ ] Every terminal outcome is emitted by a terminal Flow node.
- [ ] Module does not name, import, start or select its downstream Process Module.
- [ ] Lifecycle routing is defined only in a Stage Binding.
- [ ] Internal Flow can be replaced without changing the external module contract.

## B. Content versus execution physics

- [ ] Domain schemas, artifact meanings, policies, reason codes and invariants live in the module.
- [ ] WorkIntent lifecycle, worker spawn, execution fencing, heartbeat, timeout and persistence stay in Runtime.
- [ ] Tracker provisioning, workspace isolation, template materialization and recovery stay in Runtime.
- [ ] Module contributes execution profiles; it does not implement the worker substrate.
- [ ] Runtime core contains no imports from this module's domain package.
- [ ] Module does not write directly to Runtime persistence or select processes.

## C. Flow definition

- [ ] Entry node exists.
- [ ] Every node has a stable id, kind, purpose and input/output contract.
- [ ] Node kind is one of LM, Kernel, Human, External or Composite.
- [ ] Every transition has a source, target and named event/condition.
- [ ] Every node is reachable from the entry.
- [ ] Terminal nodes have no outgoing transitions.
- [ ] Fail, pause, retry and exhausted-budget routes are explicit.
- [ ] Authority-bearing decisions are Kernel or explicitly authorized Human nodes, never accidental LM outputs.

## D. LM Execution Cell

For every LM node:

- [ ] One WorkIntent kind and versioned WorkIntent schema are defined.
- [ ] One task kind and one execution skill are defined.
- [ ] Independent reviewer skill is declared when the task enters review.
- [ ] Artifact acceptance authority is explicit (`worker` or `kernel-gate`).
- [ ] Worker is single-use: one WorkIntent, one task, then exit.
- [ ] Allowed MCP tools are declared in the execution profile.
- [ ] The skill mirrors the allowlist exactly.
- [ ] Runtime gateway enforces the frozen allowlist per execution.
- [ ] `AUTHORITY_DENIED` handling is defined: record, do not repeat, continue or fail according to policy.
- [ ] Output schema is explicit.
- [ ] Retry budget and retryable error classes are explicit.
- [ ] Recovery policy defines checkpoint resume, WorkIntent reuse, accepted-output reuse and exhausted behavior.

## E. Machine-filled binding

- [ ] Process run id is machine-filled.
- [ ] Lifecycle run and Stage Binding ids are machine-filled when applicable.
- [ ] Node run id, WorkIntent id, task id, execution id and worker id are machine-filled.
- [ ] Project, epic and repository bindings are machine-filled.
- [ ] Schema versions are machine-filled.
- [ ] Immutable artifact ids, hashes and source snapshot refs are machine-filled.
- [ ] Authority scope and allowed tools are machine-filled.
- [ ] LLM produces only irreducibly semantic content.
- [ ] Tests fail if a worker must infer an id/hash/version already known by the kernel.

## F. External tracker and hooks

- [ ] A tracker template exists for every LM execution profile.
- [ ] Tracker contains machine binding, current step, attempt, errors, artifacts, traces and MCP calls.
- [ ] Startup hook injects identity, hard rules and the full skill into the worker prompt.
- [ ] Worker reads tracker before the first action.
- [ ] Skill requires tracker re-read before every consequential tool call.
- [ ] Worker updates tracker after every completed step.
- [ ] Error hook records error code, action and resume step.
- [ ] Pre-submit hook returns the worker to the tracker and checklist.
- [ ] Restart reuses the existing tracker rather than recreating it.
- [ ] Tracker is isolated per process/episode to prevent semantic cross-contamination.

## G. Skills

- [ ] Skill states the module, node, local goal and owned output.
- [ ] Skill states exact preconditions and postconditions.
- [ ] Skill contains ordered steps and bounded exploration limits.
- [ ] Skill names canonical templates; it forbids recreating calls from memory.
- [ ] Skill names every allowed MCP tool and exact parameter names for critical calls.
- [ ] Skill separates worker proposal/advice from kernel authority.
- [ ] Skill forbids lifecycle transition and downstream module selection.
- [ ] Skill defines truthfulness, provenance and no-fabricated-evidence rules.
- [ ] Skill defines retry and terminal behavior.
- [ ] Skill requires exit after `worker_done`.

## H. Materialized MCP calls

- [ ] Every consequential MCP write has a canonical JSON call template.
- [ ] Runtime creates an execution-scoped copy.
- [ ] Kernel fills known ids, hashes, versions and immutable constants.
- [ ] LLM fills only semantic payload fields.
- [ ] A pre-submit checklist exists for each call family.
- [ ] Skill requires reading the JSON back after editing.
- [ ] No `FILL_` placeholders may remain.
- [ ] Types, enums and nullable fields are verified.
- [ ] Tool and parameter names match the MCP schema exactly.
- [ ] MCP gateway records execution provenance.
- [ ] Exact replay is idempotent or explicitly rejected.

## I. Artifacts and lineage

- [ ] Every artifact type has a schema and authority owner.
- [ ] Input snapshot is immutable and hash-bound.
- [ ] Output artifacts identify producing Process Run, Node Run, WorkIntent and Execution.
- [ ] Required trace relations are enumerated.
- [ ] Worker cannot invent source refs outside the allowed source set.
- [ ] Accepted output is reusable on restart.
- [ ] Drift rules are explicit.
- [ ] Authoritative certificate/result is immutable.
- [ ] Advisory artifacts cannot mutate authoritative artifacts.

## J. Validation and settlement

- [ ] Local checklist validation exists.
- [ ] Syntax validation exists.
- [ ] Schema validation exists.
- [ ] Provenance validation exists.
- [ ] Authority validation exists.
- [ ] Policy evaluation is versioned and deterministic where required.
- [ ] Missing/unknown/error evidence fails closed.
- [ ] Settlement records exact input snapshot and policy version/hash.
- [ ] Certificate issuance is atomic and idempotent.
- [ ] Worker success is not confused with process settlement.

## K. Recovery

- [ ] WorkIntent is durable and restart-safe.
- [ ] Task projection is idempotent.
- [ ] Existing live execution prevents duplicate launch.
- [ ] Completed task without accepted output is treated as failure or recoverable gap, not success.
- [ ] Accepted output prevents duplicate worker launch.
- [ ] Interrupted control/advisor nodes resume from durable state.
- [ ] Retry attempts and reasons are durable.
- [ ] A recoverable verifier uses the common `RecoveryIssue` adapter and
  declares its verifier/repair route in `flow.recovery`.
- [ ] Recovery feedback identifies exact subjects, findings, acceptance
  criteria and allowed changes.
- [ ] The repair node has authority for every allowed change; otherwise the
  issue pauses for the owning stage/human instead of wasting attempts.
- [ ] Timeout, crash, rejected payload and silent loop are distinguishable.
- [ ] Recovery never fabricates completion evidence.
- [ ] External side effects are never auto-repeated merely because an LM-style
  recovery policy exists.
- [ ] Exhausted policy routes to fail, pause or escalation explicitly.

## L. Stage Binding and Lifecycle

- [ ] Stage Binding references a registered module version.
- [ ] Input mapping is explicit.
- [ ] Output mapping is explicit where needed.
- [ ] Every declared module outcome has a route.
- [ ] Routes reference existing stages or terminal lifecycle states.
- [ ] Module does not know its Stage Binding id or downstream target semantically.
- [ ] Same module can be mounted in another lifecycle/stage without changing module code.

## M. Automated enforcement

- [ ] Module definition passes `validateProcessModuleDefinition`.
- [ ] Lifecycle passes `validateLifecycleDefinition`.
- [ ] Static test proves Runtime core does not import module semantics.
- [ ] Static test proves module does not import downstream modules.
- [ ] Asset test proves every referenced skill/template/checklist exists.
- [ ] Tests cover missing execution profile, unreachable node and missing outcome route.
- [ ] Tests cover restart/resume and idempotent projection.
- [ ] Tests cover authority denial and forbidden MCP tools.
- [ ] Tests cover machine-filled binding and provenance.
- [ ] Real LM smoke validates the complete tracker → template → checklist → MCP path.

---

## Definition of Done

A Process Module is ready only when:

1. Its content is independently defined and versioned.
2. Its execution physics are supplied by the universal Runtime.
3. Every LM node is a bounded, recoverable LM Execution Cell.
4. Every authoritative result is settled outside the LM.
5. Lifecycle composition occurs only through Stage Binding.
6. The automated tests above prevent architectural regression.
