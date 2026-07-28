# ADR-020: MCP tool ownership — platform gateway, versioned capabilities, module-contributed tools

**Status:** Accepted
**Date:** 2026-07-28
**Plan ref:** §11 (11.1–11.3, 11.6, 11.7, 11.11), §14.1.2

## Context

Today all Saga tools are registered in one flat `ALL_TOOLS` array in
`src/index.ts` (baseline §"src/index.ts — MCP gateway entry") — the concat of
every `definitions` export from `src/tools/*.ts` plus four
`createSaga3*Handlers()` factories. The single enforcement point is
`authorizeSagaToolCall({toolName, db})` inside the `CallToolRequestSchema`
handler — fail-closed for managed executions, compatibility-allowed for legacy
Saga 2 and non-managed calls. The `tracker-reminder.mjs` PostToolUse hook is
advisory only (ADR-019).

Three structural problems:

1. **No ownership boundary.** Discovery proposal/normalization/readiness/diagnosis
   tools live alongside platform tools (tasks, artifacts, repositories) in the
   same flat registry. Nothing records that `proposal_submit` belongs to the
   discovery module and `artifact_create` belongs to a platform capability. A new
   module's tools are added by editing `src/index.ts` and writing another
   `src/tools/*.ts` — the gateway knows about every module.

2. **Hard-coded Discovery workflow strings.** `src/tools/saga3-args.ts:223`
   appends `'[Workflow: Read your stage tracker docs/discovery/project-<N>-discovery-stage.md, …]'`
   and `src/tools/saga3-proposals.ts:176` carries the matching `_workflow_hint`
   (baseline §"src/tools/saga3-args.ts"; plan §13.13). These cannot serve
   arbitrary module tools.

3. **Authority lives only at the gateway.** The plan requires tool listing for a
   managed execution to be assembled from its pinned platform capabilities and
   module installation (plan §11.11), and gateway guards to be authoritative with
   the Claude Code PreToolUse hook as an optimization only (plan §11.7). Today
   the gateway is the sole enforcement point but it has no protocol-step or
   package-profile awareness.

Plan §11.1 makes MCP transport/gateway/execution fence/authority/audit/registry
platform responsibilities; §11.2 makes shared capabilities (tasks, artifact
graph, repository access, worker completion, protocol checkpointing) versioned
platform Capability Packages; §11.3 makes domain-specific tools module
contributions.

## Decision

Tool ownership is split into three tiers. The gateway is the authoritative
enforcer; the CLI PreToolUse hook is an optimization.

1. **Platform tier (plan §11.1).** MCP transport, the gateway, the execution
   fence, authority, audit, the tool registry, the common error envelope, and
   dispatch are platform responsibilities. They live in Runtime, not in modules.
   The single runtime enforcement point stays at the gateway
   (`authorizeSagaToolCall`), fail-closed for managed executions.

2. **Capability tier (plan §11.2).** Shared capabilities — tasks, artifact graph,
   repository access, worker completion, protocol checkpointing — are versioned
   **platform Capability Packages**, not module-owned. They contribute tools that
   any module may reference via `CapabilityRequirement`.

3. **Module tier (plan §11.3).** Domain-specific tools are **contributed by the
   owning Process Module Package**. Discovery proposal, normalization, readiness,
   and diagnosis tools are the canonical examples. A module declares each tool
   via `ModuleToolContribution` (plan §11.4): namespaced logical identifier +
   version; input/output schemas; handler reference; call template + checklist
   references; actionable error hint reference; guard bindings; idempotency +
   side-effect classification.

4. **Installation validates tool collisions, handler coverage, capability
   dependencies, schema availability, and resource availability** (plan §11.5).
   Two modules contributing the same logical tool id is a rejection, not a
   last-writer-wins.

5. **Runtime exposes only the tools permitted by the intersection of package
   profile, current protocol step, frozen execution authority, and platform
   policy** (plan §11.6). Tool listing for a managed execution is assembled from
   its pinned platform capabilities and module installation (plan §11.11).
   Operator and interactive catalogs are separate compatibility surfaces
   (ADR-021).

6. **Gateway guards are authoritative** (plan §11.7). The optional Claude Code
   PreToolUse guard only provides an earlier rejection and CANNOT replace server
   enforcement. The current `tracker-reminder.mjs` PostToolUse advisory remains a
   non-blocking optimization.

7. **Every consequential call carries a platform-owned call-instance correlation
   value** (plan §11.9). The gateway validates and strips it before module
   handler input decoding. Runtime never infers which workspace file produced an
   MCP argument object.

8. **All validation failures use `ActionableToolError`** (plan §11.8, §11.10),
   preserved as structured data across MCP serialization — never flattened into
   one textual Error string. (Today `friendlyError()` in `src/index.ts` partly
   does the opposite for SQLite constraint messages.)

## Consequences

**Positive:**

- A new module's tools register via its package contribution, not via an edit to
  `src/index.ts` — the gateway stops knowing about every module (plan §14.4.7).
- Tool/authority/protocol-step intersection is enforceable at the gateway, closing
  the "worker ran a tool outside its current step" failure mode (plan §11.6;
  ADR-019).
- The hard-coded Discovery workflow strings in `saga3-args.ts:223` and
  `saga3-proposals.ts:176` are replaced by per-module actionable error hint
  resources (plan §13.13) — listed as a Wave 6 removal surface in
  `COMPATIBILITY-INVENTORY.md`.
- CallInstance correlation (plan §11.9, §9.8) makes MCP error-to-draft
  correlation deterministic — a precondition called out by plan §0.2.6.

**Negative:**

- The flat `ALL_TOOLS` assembly in `src/index.ts` must be replaced by
   capability + module-contribution registries (Wave 3/10/12; plan §14.4.2).
   Until then the flat registry is retained behind a compatibility seam (ADR-021;
   plan §16.7 — "do not remove current tools before module tool aliases and
   replay behavior are verified").
- The four `createSaga3*Handlers()` factories couple the gateway to Discovery
   tooling today; they migrate behind the discovery module's contributions.
- CallInstance persistence (plan §9.8) does not exist today and is a Wave 5/10
   prerequisite for MCP error-to-draft correlation (plan §0.2.6).

## Current state (frozen-commit `fd26fd1`)

- 90 tools in the flat `ALL_TOOLS` registry (see `COMPATIBILITY-INVENTORY.md` for
  the pinned sorted list — the Wave 13 compatibility boundary).
- Single gateway enforcement point: `authorizeSagaToolCall({toolName, db})` in
  `src/index.ts` (fail-closed for managed execs).
- Hard-coded Discovery workflow strings at `src/tools/saga3-args.ts:223` and
  `src/tools/saga3-proposals.ts:176` (baseline §"src/tools/saga3-args.ts").
- `tracker-reminder.mjs` PostToolUse hook — advisory, non-blocking (baseline
  §"tracker-reminder.mjs"; ADR-019).
- No `CallInstance` persistence (baseline §"Missing aggregates").

## References

- Plan §11.1–11.3 (platform / capability / module tiers)
- Plan §11.4 (ModuleToolContribution), §11.5 (installation validation)
- Plan §11.6 (intersection exposure), §11.7 (gateway authoritative)
- Plan §11.8, §11.10 (ActionableToolError), §11.9 (call-instance correlation)
- Plan §11.11 (tool listing from pinned capabilities + installation)
- Plan §13.13 (parameterize hard-coded workflow strings), §13.5 (reminder hook)
- Plan §14.4.2 (registries), §16.7 (do not remove tools prematurely)
- Baseline §"src/index.ts — MCP gateway entry", §"src/tools/saga3-args.ts", §"tracker-reminder.mjs"
- Related: ADR-015 (package identity), ADR-019 (protocol state), ADR-021 (compatibility)
