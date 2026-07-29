# Wave 6 — MCP Contributions, Guards, Structured Errors Frozen Spec

> Frozen on `e16630d` (Wave 5 checkpoint). Plan §0.9 / Phase 7.

## 0. Key findings
- `src/index.ts` (299 lines) hardcodes ALL_TOOLS + ALL_HANDLERS. Gateway dispatch via `authorizeSagaToolCall`.
- `src/tools/saga3-args.ts` has hard-coded Discovery workflow strings.
- Wave 1 SPI has `ModuleToolContribution`, `GuardBinding`, `ActionableToolError` types.
- Wave 2 has `ModuleToolRegistry` port + adapter.
- No generic GatewayGuard pipeline exists.

## 1. Lanes (8) — all parallel

| Lane | Owns |
|---|---|
| **W6-A1** | `application/tool-contribution-installer.ts` (NEW: install module tool contributions, namespace/alias/version/collision validation) |
| **W6-A2** | `application/capability-packages.ts` (NEW: versioned platform Capability Packages for shared tools — tasks, artifact graph, repository, worker completion, protocol checkpointing) |
| **W6-A3** | `application/gateway-guard.ts` (NEW: generic server-side GatewayGuard pipeline — authority, fence, validation, audit) |
| **W6-A4** | `application/pretooluse-projection.ts` (NEW: optional agent-side PreToolUse projection without authority semantics — early denial optimization) |
| **W6-A5** | `application/actionable-tool-error.ts` (NEW: universal ActionableToolError with enrichment, escaping, repair references — replaces hard-coded Discovery strings) |
| **W6-A6** | `application/call-correlation.ts` (NEW: call-instance correlation, common receipt envelope, structured MCP serialization) |
| **W6-A7** | `application/execution-tool-catalog.ts` (NEW: execution-scoped tool catalog + generated descriptions from pinned contracts) |
| **W6-A8** | Tests: contribution/collision/denial-before-handler/structured-error/idempotency/transport conformance |

## 2. Exit gate (§0.9.12)
1. Build green. 2. Synthetic module contributes a tool without gateway source changes. 3. Structured errors survive MCP transport. 4. Collision detection works. 5. Gateway guard authoritative. 6. Ratchet green. 7. Wave 0-5 regression green.

## 3. Anti-scope
- No `src/index.ts` rewrite (Wave 11 cutover). New services exposed via barrel; integrator wires at checkpoint.
- No removal of existing tools (Wave 13).
- No module migration (Wave 8/9).
