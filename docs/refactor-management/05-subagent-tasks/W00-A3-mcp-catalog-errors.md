# W0-A3 — Characterization: MCP catalog, authority, structured errors

**Wave:** 0 · **Lane:** A3 · **Plan ref:** §0.3.4, §13.13, §11
**Frozen input commit:** `eb35510935f2317bc1bc7eb8e0b35f943bb0fadd`
**Branch to create:** `refactor/w0-a3`

## Context

- Plan: `docs/refactor-management/00-PLAN.md` §11 (MCP Tool Ownership), §13.13 (`saga3-args.ts` hard-coded tracker workflow).
- Baseline: `01-CODEBASE-BASELINE.md` sections `src/index.ts`, `src/tools/saga3-args.ts`.

## Architecture rule served

Lock the current MCP gateway behavior — tool catalog shape, authority
enforcement, structured-error format, and the actionable-hint surface — so
Wave 6 can replace it with module-contributed tools + generic guards without
silent regressions.

## What you OWN

- `tests/characterization/mcp-catalog-authority-errors.test.mjs` — NEW, single file.

## What to characterize

1. **Tool catalog** (`src/index.ts` `ALL_TOOLS`):
   - Import the `definitions` arrays from each `src/tools/*.ts` and from the four `createSaga3*Handlers` factories (or however the test can access the assembled `ALL_TOOLS`). Assert the catalog is a flat array of tool descriptors with `name`, `description`, `inputSchema`.
   - Pin the exact set of tool names exposed today (snapshot as a sorted array constant). This becomes the compatibility surface Wave 6 must preserve or explicitly migrate.
   - Assert no duplicate names.

2. **Authority** (`authorizeSagaToolCall` from `src/saga3/authority/authorize-saga-tool-call.ts`):
   - For a managed execution (`SAGA_MANAGED_EXECUTION=1` with a frozen `execution_context.authority.allowed_saga_tools`), a tool NOT in the allow set → denied. A tool in the set → allowed.
   - For a non-managed execution, legacy tools are allowed (compatibility).
   - Pin the deny decision shape (what fields the deny result carries).

3. **Identity guard** (`assertManagedExecutionIdentity` in `src/index.ts` or its module):
   - Mismatched `SAGA_MANAGED_EXECUTION` / `SAGA_EXECUTION_ID` → throws `AUTHORITY_CONTEXT_INVALID` (or equivalent). Pin the error code.

4. **Structured errors** (`src/tools/saga3-args.ts` `actionableError` + `SAGA3_TOOL_CALL_SHAPES` + `PAYLOAD_FIELD_SOURCES`):
   - Pin the shape of an `actionableError(...)`: fields produced (code, message, field path, expected/actual, source-of-correct-value, etc.).
   - Pin the hard-coded Discovery workflow hint string appended by `enrichPayloadErrors` (the `'[Workflow: Read your stage tracker docs/discovery/project-<N>-discovery-stage.md, ...]'` literal). This is exactly what Wave 6 must parameterize — lock it so the change is visible.
   - Pin the `PAYLOAD_FIELD_SOURCES.proposal_submit.recommended_outcome` and `readiness_submit.recommended_next_action` enumerated value lists (Discovery decision vocabulary baked into the gateway).

5. **Error normalization** (`friendlyError` in `src/index.ts` or its module):
   - A thrown SQLite UNIQUE error → normalized to a specific shape. Pin the mapping for UNIQUE / NOT NULL / FK / no-such-table.

## Anti-scope

- Do NOT edit production source.
- Do NOT remove the hard-coded Discovery workflow string (that is Wave 6's job).
- Do NOT touch other lanes' files.

## Exit criteria

- [ ] Test file passes today.
- [ ] Each of the 5 areas has at least one assertion.
- [ ] The pinned tool-name set is a sorted constant in the test (so additions/removals are visible diffs).
- [ ] No production source modified.

## Return to integrator

1. Branch name.
2. `git diff --stat`.
3. Passing test summary.
4. The pinned sorted tool-name list (so the integrator can record the compatibility surface in the Wave 6 file).
5. Confirmation.
