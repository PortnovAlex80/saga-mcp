// tests/process-modules/capability-enforcement.test.mjs
//
// W5-A7 — Capability enforcement tests (C067: enforce agent built-in
// capabilities separately from MCP tool grants).
//
// Spec:  docs/refactor-management/09-contracts/WAVE5-WORKSPACE-TRACKER-SPEC.md
//          §1 row W5-A7 + §3 exit-gate item 7.
// Task:  docs/refactor-management/05-subagent-tasks/W05-a7.md.
// Plan:  C067 in docs/refactor-management/00-PLAN.md.
//
// What this file proves:
//   1. Builtins and MCP grants are SEPARATED in the result (C067) — the
//      effective set is split into builtinTools + mcpTools, never merged.
//   2. Least privilege: the effective set is the INTERSECTION of (profile ∩
//      runtime grant), not the union. A grant the profile did not ask for is
//      dropped; a profile entry the runtime did not grant is dropped.
//   3. Builtins are gated by the profile declaration (driver builtin ∩
//      profile); a profile builtin the driver lacks is dropped, a driver
//      builtin the profile did not ask for is dropped.
//   4. MCP grants are matched on the UNPREFIXED tool name (the manifest
//      convention) against namespaced `mcp__<server>__<tool>` grants.
//   5. Determinism: two calls with the same inputs yield structurally-equal,
//      sorted sets, regardless of input ordering or duplicates.
//   6. Resilience: malformed input (null/undefined arrays, non-string entries,
//      blank strings, malformed MCP grants) is dropped, never widens the set.
//   7. The DEFAULT_AGENT_BUILTIN_CAPABILITIES list is frozen and matches the
//      pre-W5-A7 inline builtin set from claude-runner.mjs (the single source
//      of truth the C067 seam replaces).
//   8. The result is frozen (immutable) — a downstream consumer cannot mutate
//      the effective set.
//
// Run: `node --test tests/process-modules/capability-enforcement.test.mjs`
// (auto-discovered by tools/run-process-module-tests.mjs.)

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  DEFAULT_AGENT_BUILTIN_CAPABILITIES,
  MCP_TOOL_PREFIX,
  enforceCapabilitySet,
  parseMcpToolRef,
  isMcpToolGrant,
} = await import(
  '../../dist/process-modules/application/capability-enforcement.js'
);

// ---------------------------------------------------------------------------
// DEFAULT_AGENT_BUILTIN_CAPABILITIES — frozen, matches the pre-W5-A7 inline set.
// ---------------------------------------------------------------------------

test('DEFAULT_AGENT_BUILTIN_CAPABILITIES is frozen and matches the pre-W5-A7 inline builtin set', () => {
  assert.equal(Object.isFrozen(DEFAULT_AGENT_BUILTIN_CAPABILITIES), true);
  // The exact set previously inlined in tracker-view/claude-runner.mjs and
  // echoed in saga3-discovery-engine's DISCOVERY_ALLOWED_TOOLS file-tool rows.
  assert.deepEqual(
    [...DEFAULT_AGENT_BUILTIN_CAPABILITIES].sort(),
    ['Bash', 'Edit', 'Glob', 'Grep', 'MultiEdit', 'Read', 'Task', 'Write'],
  );
});

test('DEFAULT_AGENT_BUILTIN_CAPABILITIES contains no namespaced MCP names', () => {
  // Builtins are NEVER mcp__* — that is the whole point of the C067 split.
  for (const name of DEFAULT_AGENT_BUILTIN_CAPABILITIES) {
    assert.equal(
      name.startsWith(MCP_TOOL_PREFIX),
      false,
      `builtin '${name}' must not be an mcp__ grant`,
    );
  }
});

// ---------------------------------------------------------------------------
// parseMcpToolRef / isMcpToolGrant.
// ---------------------------------------------------------------------------

test('parseMcpToolRef parses canonical mcp__<server>__<tool> grants', () => {
  assert.deepEqual(parseMcpToolRef('mcp__saga__task_get'), {
    raw: 'mcp__saga__task_get',
    server: 'saga',
    tool: 'task_get',
  });
  assert.deepEqual(parseMcpToolRef('mcp__node_repl__js'), {
    raw: 'mcp__node_repl__js',
    server: 'node_repl',
    tool: 'js',
  });
});

test('parseMcpToolRef keeps __ inside the tool name intact', () => {
  // Everything after the SECOND mcp__ separator is the tool name, so a tool
  // whose own name contains __ survives.
  const parsed = parseMcpToolRef('mcp__saga__worker_done__v2');
  assert.equal(parsed.server, 'saga');
  assert.equal(parsed.tool, 'worker_done__v2');
});

test('parseMcpToolRef returns null for non-MCP / malformed names', () => {
  assert.equal(parseMcpToolRef('Bash'), null); // builtin, not a grant
  assert.equal(parseMcpToolRef('task_get'), null); // unprefixed saga tool
  assert.equal(parseMcpToolRef('mcp__saga'), null); // no tool separator
  assert.equal(parseMcpToolRef('mcp____task_get'), null); // empty server
  assert.equal(parseMcpToolRef('mcp__saga__'), null); // empty tool
  assert.equal(parseMcpToolRef(''), null);
  // Non-string handled defensively (the parser is also called from
  // normalizeToolList-fed loops, but assert the contract directly).
  assert.equal(parseMcpToolRef(/** @type {unknown} */ ('123')), null);
});

test('isMcpToolGrant classifies only mcp__-prefixed names as grants', () => {
  assert.equal(isMcpToolGrant('mcp__saga__task_get'), true);
  assert.equal(isMcpToolGrant('mcp__node_repl__js'), true);
  assert.equal(isMcpToolGrant('Bash'), false);
  assert.equal(isMcpToolGrant('task_get'), false);
});

// ---------------------------------------------------------------------------
// enforceCapabilitySet — the C067 projection.
// ---------------------------------------------------------------------------

test('enforceCapabilitySet separates builtins from MCP grants (C067 core invariant)', () => {
  // Profile mixes builtins and unprefixed saga tools (the manifest convention).
  const profile = ['Bash', 'Read', 'Write', 'task_get', 'worker_done'];
  // Runtime grants the namespaced saga surface.
  const grants = ['mcp__saga__task_get', 'mcp__saga__worker_done', 'mcp__saga__worker_next'];

  const effective = enforceCapabilitySet(profile, grants);

  // Builtins effective = driver builtins ∩ profile, sorted.
  assert.deepEqual(effective.builtinTools, ['Bash', 'Read', 'Write']);
  // MCP grants effective = grants whose unprefixed name is in the profile.
  // worker_next was granted but NOT asked for by the profile → dropped.
  assert.deepEqual(effective.mcpTools, ['mcp__saga__task_get', 'mcp__saga__worker_done']);
});

test('enforceCapabilitySet is least-privilege: drops unrequested grants and ungranted profile entries', () => {
  const profile = ['task_get']; // asks for ONE saga tool
  const grants = [
    'mcp__saga__task_get',
    'mcp__saga__epic_create', // granted but profile did not ask → drop
    'mcp__saga__note_search', // granted but profile did not ask → drop
  ];

  const effective = enforceCapabilitySet(profile, grants);

  assert.deepEqual(effective.mcpTools, ['mcp__saga__task_get']);
  // No builtins asked for → empty builtin surface.
  assert.deepEqual(effective.builtinTools, []);
});

test('enforceCapabilitySet drops a profile MCP tool the runtime never granted', () => {
  const profile = ['task_get', 'worker_done'];
  // Runtime grants ONLY task_get — worker_done is requested but withheld.
  const grants = ['mcp__saga__task_get'];

  const effective = enforceCapabilitySet(profile, grants);

  assert.deepEqual(effective.mcpTools, ['mcp__saga__task_get']);
});

test('enforceCapabilitySet gates builtins on the profile declaration', () => {
  // Driver carries Bash/Read/Write/Edit but profile lists only Read.
  const profile = ['Read', 'task_get'];
  const grants = ['mcp__saga__task_get'];

  const effective = enforceCapabilitySet(profile, grants);

  // Only Read survives the builtin intersection.
  assert.deepEqual(effective.builtinTools, ['Read']);
  assert.deepEqual(effective.mcpTools, ['mcp__saga__task_get']);
});

test('enforceCapabilitySet drops a profile builtin the driver does not carry', () => {
  // Profile asks for a builtin the (overridden) driver surface lacks.
  const profile = ['Bash', 'Read', 'ExoticBuiltin'];
  const builtinSurface = ['Bash', 'Read']; // no ExoticBuiltin

  const effective = enforceCapabilitySet(profile, [], builtinSurface);

  assert.deepEqual(effective.builtinTools, ['Bash', 'Read']);
});

test('enforceCapabilitySet defaults builtinCapabilities to the standard surface', () => {
  const profile = ['Bash', 'Read', 'Write'];
  // builtinCapabilities omitted → DEFAULT_AGENT_BUILTIN_CAPABILITIES.
  const effective = enforceCapabilitySet(profile, []);
  assert.deepEqual(effective.builtinTools, ['Bash', 'Read', 'Write']);
});

test('enforceCapabilitySet matches MCP grants on the unprefixed tool name, across servers', () => {
  // Two grants for tools with the same local name on different servers. The
  // profile lists the unprefixed name; both servers' grants are effective
  // because the manifest format does not namespace profile entries by server.
  const profile = ['js', 'task_get'];
  const grants = ['mcp__node_repl__js', 'mcp__saga__task_get', 'mcp__other__js'];

  const effective = enforceCapabilitySet(profile, grants);

  assert.deepEqual(effective.mcpTools, [
    'mcp__node_repl__js',
    'mcp__other__js',
    'mcp__saga__task_get',
  ]);
});

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------

test('enforceCapabilitySet is deterministic regardless of input ordering or duplicates', () => {
  const profileA = ['Write', 'Bash', 'Bash', 'Read', 'task_get'];
  const profileB = ['Read', 'Bash', 'Write', 'task_get', 'Write'];
  const grantsA = ['mcp__saga__task_get', 'mcp__saga__task_get', 'mcp__saga__worker_done'];
  const grantsB = ['mcp__saga__worker_done', 'mcp__saga__task_get'];

  const a = enforceCapabilitySet(profileA, grantsA);
  const b = enforceCapabilitySet(profileB, grantsB);

  // Both yield the same, sorted, de-duplicated effective set.
  assert.deepEqual(a.builtinTools, ['Bash', 'Read', 'Write']);
  assert.deepEqual(a.mcpTools, ['mcp__saga__task_get']);
  assert.deepEqual(a, b);
});

test('enforceCapabilitySet output is frozen (immutable)', () => {
  const effective = enforceCapabilitySet(['Bash'], ['mcp__saga__task_get']);
  assert.equal(Object.isFrozen(effective), true);
  assert.equal(Object.isFrozen(effective.builtinTools), true);
  assert.equal(Object.isFrozen(effective.mcpTools), true);
  assert.throws(() => {
    // @ts-expect-error mutating a frozen array
    effective.builtinTools.push('Edit');
  }, TypeError);
});

// ---------------------------------------------------------------------------
// Input resilience — malformed input never widens the set.
// ---------------------------------------------------------------------------

test('enforceCapabilitySet tolerates null/undefined arrays', () => {
  const effective = enforceCapabilitySet(undefined, undefined, undefined);
  assert.deepEqual(effective.builtinTools, []);
  assert.deepEqual(effective.mcpTools, []);
});

test('enforceCapabilitySet drops non-string, blank, and whitespace entries', () => {
  // @ts-expect-error intentionally malformed input
  const profile = ['Bash', '', '   ', null, 42, 'Read', 'task_get'];
  const effective = enforceCapabilitySet(profile, ['mcp__saga__task_get']);
  assert.deepEqual(effective.builtinTools, ['Bash', 'Read']);
  assert.deepEqual(effective.mcpTools, ['mcp__saga__task_get']);
});

test('enforceCapabilitySet drops malformed MCP grants rather than widening', () => {
  // A grant missing the tool separator must not be matched against a profile
  // entry that happens to share a substring — it is dropped entirely.
  const profile = ['saga', 'task_get'];
  const grants = ['mcp__saga', 'mcp__saga__task_get', 'not-a-grant'];
  const effective = enforceCapabilitySet(profile, grants);
  // Only the well-formed, profile-matched grant survives.
  assert.deepEqual(effective.mcpTools, ['mcp__saga__task_get']);
});

test('enforceCapabilitySet keeps builtin and MCP buckets separate even on a name collision', () => {
  // The profile lists 'Read'. It is BOTH a driver builtin AND happens to match
  // a namespaced grant 'mcp__saga__Read' (a shadow). The projection must put
  // the builtin form in builtinTools and the namespaced form in mcpTools, in
  // separate buckets — never merged. This is the C067 boundary.
  const profile = ['Read'];
  const grants = ['mcp__saga__Read'];
  const effective = enforceCapabilitySet(profile, grants);
  assert.deepEqual(effective.builtinTools, ['Read']);
  assert.deepEqual(effective.mcpTools, ['mcp__saga__Read']);
  assert.ok(
    !effective.builtinTools.includes('mcp__saga__Read'),
    'namespaced grant must not leak into the builtin bucket',
  );
});
