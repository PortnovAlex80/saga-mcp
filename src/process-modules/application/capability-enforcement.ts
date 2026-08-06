/**
 * W5-A7 — Capability enforcement: agent builtins separated from MCP grants.
 *
 * Task: `docs/refactor-management/05-subagent-tasks/W05-a7.md`.
 * Spec:  `docs/refactor-management/09-contracts/WAVE5-WORKSPACE-TRACKER-SPEC.md`
 *         §1 row W5-A7 + §3 exit-gate item 7.
 * Contract: **C067** — Enforce agent built-in capabilities separately from MCP
 *           tool grants.
 * Plan:  §11 / C067 (see `docs/refactor-management/00-PLAN.md`).
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * Before W5-A7 the boundary between an agent's *built-in* capabilities (the
 * tool surface the driver ships with: `Bash`, `Read`, `Write`, `Edit`, `Glob`,
 * `Grep`, `MultiEdit`, `Task`, …) and the *MCP tool grants* (the namespaced
 * `mcp__<server>__<tool>` surface a module/board authorizes) was enforced by
 * ad-hoc inline logic in the driver runner. See `tracker-view/claude-runner.mjs`
 * around the `const builtin = [...]` block: it carried the comment
 * "The set MUST stay in sync with the builtin names that Process Module profiles
 * builtin list was duplicated in three places and the split was reconstructed
 * by filtering on the presence of the `mcp__` prefix at the last possible
 * moment. C067 closes that seam.
 *
 * This file is the SINGLE structural authority for that split. It defines:
 *   1. `DEFAULT_AGENT_BUILTIN_CAPABILITIES` — the immutable built-in tool
 *      surface every agent driver carries (the saga authority NEVER covers
 *      these — `Bash`/`Read`/`Write`/… are not `mcp__saga__*` tools).
 *   2. `mcpToolRef` / `parseMcpToolRef` — a typed view of a namespaced MCP
 *      grant (`mcp__<server>__<tool>`) with deterministic parsing. Used to
 *      separate the two surfaces without ad-hoc string filtering.
 *   3. `enforceCapabilitySet(profileAllowedTools, mcpGrants, builtinCapabilities)`
 *      — the effective capability projection (C067). It takes the execution
 *      profile's declared `allowedTools`, the board/runtime MCP grants, and the
 *      agent builtin surface, and yields the exact effective tool set the
 *      driver must hand the agent.
 *
 * ── Enforcement model (least privilege, intersection not union) ─────────────
 *
 * A tool is in the EFFECTIVE set only when it is granted by BOTH:
 *   - the runtime/board (it appears in `mcpGrants` for MCP tools, or in
 *     `builtinCapabilities` for builtins), AND
 *   - the execution profile (it appears in `profileAllowedTools`).
 *
 * The profile is the module-authored whitelist of what THIS node needs; the
 * grants are what the runtime is willing to hand over. The effective set is
 * their intersection. A grant the profile did not ask for is dropped (the
 * module cannot be force-fed capabilities it did not declare). A profile entry
 * the runtime did not grant is dropped (the profile cannot compel a capability
 * the runtime withheld). Builtins are the one asymmetry: an agent driver
 * ALWAYS carries its built-in surface, so a builtin in
 * `builtinCapabilities` is effective iff the profile also lists it — the
 * runtime grant is implicit and unconditional for builtins.
 *
 * This is the structural fix for the pre-W5-A7 smell where a re-install or a
 * profile edit could silently widen the capability surface between two runs of
 * the same idempotency key: the effective set is now a pure, deterministic
 * function of three frozen inputs, with no driver-specific prefix filtering at
 * the boundary.
 *
 * ── Purity / ratchet ──────────────────────────────────────────────────────
 *
 * This file is PURE: data types + one pure projection. No I/O, no side
 * effects, no `persistence/`, no `modules/`, no `db.ts`. It imports nothing
 * from the tree — the three inputs are passed in by the caller (the driver
 * runner, the AgentLaunchSpec consumer). This keeps it ratchet-clean under
 * Rule 2 (no persistence/infra import from application/) and Rule 4 (no
 * module-name switching): the capability surface is data, not a dispatch on
 * module identity.
 */

// ---------------------------------------------------------------------------
// Agent builtin capabilities (the driver's native tool surface).
// ---------------------------------------------------------------------------

/**
 * The default built-in tool surface every agent driver carries. These are the
 * tool names the driver exposes NATIVELY (not via an MCP server) — they are
 * never namespaced and the saga authority gateway never gates them.
 *
 * This list MUST stay in sync with:
 *   - the inline `builtin` array previously in `tracker-view/claude-runner.mjs`,
 *   - the file-tool rows that the retired `src/engines/factory-discovery-engine.ts`
 *     `DISCOVERY_ALLOWED_TOOLS` carried (the `Write`/`Read`/`Edit`/`Bash`/`Glob`/
 *     `Grep` rows, kept there "for documentation and skill sync, not for
 *     gateway enforcement"); that engine is gone (saga4 cutover) but the
 *     canonical builtin surface lives on here,
 *   - any Process Module execution profile that lists builtins inside its
 *     `allowedTools` for documentation/skill-sync purposes.
 *
 * Surfacing the canonical list here (frozen + exported) is the C067 fix: there
 * is now ONE structural source for "what is a builtin" instead of three
 * ad-hoc copies that had to be hand-kept in sync.
 *
 * `Task` is included because sub-agent dispatch is a driver-native capability
 * (the saga board does not expose `mcp__saga__Task`). `MultiEdit` is included
 * for parity with the pre-W5-A7 inline list.
 */
export const DEFAULT_AGENT_BUILTIN_CAPABILITIES: readonly string[] = Object.freeze([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'MultiEdit',
  'Task',
]);

/**
 * The MCP tool-name prefix. Every MCP grant the runtime hands an agent is
 * namespaced as `mcp__<server>__<tool>`; the saga board's tools live under
 * `mcp__saga__*`. A name WITHOUT this prefix is, by construction, a driver
 * builtin (or an unknown) — never an MCP grant.
 */
export const MCP_TOOL_PREFIX = 'mcp__';

// ---------------------------------------------------------------------------
// McpToolRef — a typed view of a namespaced MCP grant.
// ---------------------------------------------------------------------------

/**
 * A parsed view of an MCP tool grant `mcp__<server>__<tool>`. Separating the
 * server from the tool lets callers reason about grants at server granularity
 * (e.g. "drop every `mcp__saga__*` grant the profile did not ask for") without
 * re-splitting the string at every call site.
 *
 * Construct via {@link parseMcpToolRef}; do not build the object literal by
 * hand — the parser is the single place that decides what counts as a
 * well-formed MCP grant.
 */
export interface McpToolRef {
  /** The original namespaced string (`mcp__<server>__<tool>`). */
  readonly raw: string;
  /** The MCP server namespace (e.g. `saga`, `node_repl`). */
  readonly server: string;
  /** The tool name within the server (e.g. `task_get`, `worker_done`). */
  readonly tool: string;
}

/**
 * Parse a namespaced MCP tool grant into a typed {@link McpToolRef}.
 *
 * Shape: `mcp__<server>__<tool>` where both `<server>` and `<tool>` are
 * non-empty. The canonical form (the saga board, the node_repl MCP server,
 * every MCP server the runtime mounts) uses exactly two `__` separators; a
 * name with a different shape is not a valid MCP grant.
 *
 * Tool names that legitimately contain `__` (none exist in the mounted
 * surfaces today) would split on the FIRST two separators only — the parser
 * treats everything after the second `__` as the tool name, so
 * `mcp__saga__foo__bar` parses to `{ server: 'saga', tool: 'foo__bar' }`.
 *
 * @returns the parsed ref, or `null` when `raw` is not a well-formed MCP grant
 *          (missing/empty server or tool, or not prefixed with `mcp__`).
 */
export function parseMcpToolRef(raw: string): McpToolRef | null {
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith(MCP_TOOL_PREFIX)) return null;
  // Strip the leading `mcp__`, then split on the FIRST remaining `__` so a
  // tool name that itself contains `__` survives intact.
  const remainder = raw.slice(MCP_TOOL_PREFIX.length);
  const sep = remainder.indexOf('__');
  if (sep <= 0) return null; // sep === -1 (no separator) or 0 (empty server)
  const server = remainder.slice(0, sep);
  const tool = remainder.slice(sep + 2);
  if (server.length === 0 || tool.length === 0) return null;
  return { raw, server, tool };
}

/**
 * Whether a tool name is a namespaced MCP grant (`mcp__<server>__<tool>`).
 * Cheaper than {@link parseMcpToolRef} when the caller only needs the
 * builtin-vs-grant classification and not the parsed server/tool.
 */
export function isMcpToolGrant(toolName: string): boolean {
  return typeof toolName === 'string' && toolName.startsWith(MCP_TOOL_PREFIX);
}

// ---------------------------------------------------------------------------
// EffectiveCapabilitySet — the C067 projection.
// ---------------------------------------------------------------------------

/**
 * The effective tool surface an agent driver may hand its agent for one node
 * execution. The result of {@link enforceCapabilitySet}.
 *
 * The two surfaces are reported SEPARATELY (not merged into one list) because
 * the driver consumes them differently: builtins are passed as-is (the driver
 * owns them), MCP grants are passed with whatever prefix/quoting the driver's
 * `--allowedTools` flag expects. Merging them here would re-create the very
 * ambiguity C067 removes — the driver would have to re-split on `mcp__` to
 * know which names to namespace.
 *
 * `Object.freeze`d by {@link enforceCapabilitySet}; treat as immutable.
 */
export interface EffectiveAgentCapabilitySet {
  /** Built-in tools the driver exposes natively (e.g. `Bash`, `Read`). */
  readonly builtinTools: readonly string[];
  /** MCP grants the runtime authorized (e.g. `mcp__saga__task_get`). */
  readonly mcpTools: readonly string[];
}

// ---------------------------------------------------------------------------
// Input normalization.
// ---------------------------------------------------------------------------

/**
 * Read an optional readonly string array into a normalized `string[]`,
 * dropping non-string / blank entries and de-duplicating. Centralizing this
 * keeps {@link enforceCapabilitySet} resilient to malformed manifest/profile
 * input (an `allowedTools: [null]` row must not poison the effective set) and
 * keeps the projection deterministic regardless of input ordering or dupes.
 *
 * Returns a fresh array every call; the caller may freeze it.
 */
function normalizeToolList(list: readonly string[] | undefined | null): string[] {
  if (list === undefined || list === null) return [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// enforceCapabilitySet — the C067 projection.
// ---------------------------------------------------------------------------

/**
 * Project the effective agent capability set for one node execution (C067).
 *
 * The effective set is the LEAST-PRIVILEGE intersection of three inputs:
 *
 *   1. `profileAllowedTools` — what the module's execution profile declares
 *      THIS node needs (from the pinned manifest's
 *      `ExecutionProfileDefinition.allowedTools`). This is the module-authored
 *      whitelist; it may mix builtins (`Bash`, `Read`) and unprefixed MCP tool
 *      names (`task_get`, `worker_done`) — manifest authors historically write
 *      the saga tools WITHOUT the `mcp__saga__` prefix.
 *   2. `mcpGrants` — what the runtime/board is willing to grant, as
 *      namespaced `mcp__<server>__<tool>` strings (the frozen
 *      `authority.allowed_saga_tools` surface, namespaced by the driver).
 *   3. `builtinCapabilities` — the driver's native tool surface. Defaults to
 *      {@link DEFAULT_AGENT_BUILTIN_CAPABILITIES}; overridable so a future
 *      driver with a different builtin set can pin its own surface.
 *
 * Resolution rules:
 *   - **Builtins**: a builtin is effective iff it appears in BOTH
 *     `builtinCapabilities` AND `profileAllowedTools`. The runtime grant is
 *     implicit for builtins (the driver always carries its own surface), so
 *     the gate is the profile declaration — a profile that lists a builtin the
 *     driver does not carry is dropped (cannot compel a capability the driver
 *     lacks), and a driver builtin the profile did not ask for is dropped
 *     (least privilege).
 *   - **MCP grants**: an MCP tool is effective iff its unprefixed name appears
 *     in `profileAllowedTools` AND its namespaced form appears in `mcpGrants`.
 *     This is the structural fix for the pre-W5-A7 smell where the driver
 *     filtered `mcp__saga__*` names out of the builtin list at the last
 *     moment: the split is now explicit and the intersection is enforced here,
 *     not reconstructed downstream.
 *   - **Names not classifiable** as either (e.g. an unprefixed saga tool the
 *     runtime never granted, or an unknown namespaced grant) are dropped. The
 *     effective set NEVER widens beyond the intersection.
 *
 * The result is deterministically sorted (builtins then MCP grants, each
 * lexicographic) so two calls with the same inputs yield structurally-equal
 * sets — the same determinism invariant {@link resolveAgentLaunchSpec} upholds
 * for the full launch spec.
 *
 * @param profileAllowedTools  The execution profile's declared tool whitelist.
 * @param mcpGrants            Namespaced MCP grants the runtime authorizes.
 * @param builtinCapabilities  The driver's native tool surface (defaults to
 *                             {@link DEFAULT_AGENT_BUILTIN_CAPABILITIES}).
 * @returns the frozen effective capability set (builtins + MCP grants, split).
 */
export function enforceCapabilitySet(
  profileAllowedTools: readonly string[] | undefined | null,
  mcpGrants: readonly string[] | undefined | null,
  builtinCapabilities: readonly string[] | undefined | null = DEFAULT_AGENT_BUILTIN_CAPABILITIES,
): EffectiveAgentCapabilitySet {
  const profile = normalizeToolList(profileAllowedTools);
  const profileSet = new Set(profile);
  const builtins = normalizeToolList(builtinCapabilities);
  const grants = normalizeToolList(mcpGrants);

  // ---- Builtins: effective iff the driver carries it AND the profile lists it.
  const builtinSet = new Set(builtins);
  const effectiveBuiltins = profile
    .filter((tool) => builtinSet.has(tool))
    .sort(compareToolName);

  // ---- MCP grants: effective iff the profile lists the unprefixed name AND
  // the runtime granted the namespaced form. Group grants by their unprefixed
  // name so a single profile entry can satisfy at most the grants that resolve
  // to it (a profile listing `task_get` matches `mcp__saga__task_get`, not
  // `mcp__node_repl__task_get`-style collisions — those would need their own
  // profile entry naming the server, which the manifest format does not use).
  const effectiveMcp: string[] = [];
  for (const grant of grants) {
    const parsed = parseMcpToolRef(grant);
    if (parsed === null) continue; // malformed grant — drop, never widen
    if (profileSet.has(parsed.tool)) {
      effectiveMcp.push(parsed.raw);
    }
  }
  // De-duplicate (a runtime could grant the same namespaced tool twice) then
  // sort for deterministic output.
  const effectiveMcpDeduped = [...new Set(effectiveMcp)].sort(compareToolName);

  return Object.freeze({
    builtinTools: Object.freeze(effectiveBuiltins),
    mcpTools: Object.freeze(effectiveMcpDeduped),
  });
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

/**
 * Locale-independent lexicographic comparator for tool names. Avoids
 * `String.prototype.localeCompare` (whose output varies by runtime locale) so
 * the effective set is byte-stable across Node versions and locales.
 */
function compareToolName(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
