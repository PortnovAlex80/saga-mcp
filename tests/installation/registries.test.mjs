// tests/installation/registries.test.mjs
//
// W2-A6 — Generic registries + ProcessModulePlugin + InstalledProcessModule
// binding.
//
// Covers (per W02-A6 task §"Tests"):
//   - Each registry (Handler/Capability/ModuleTool/Guard/AgentDriver):
//       - register/resolve/has positive path.
//       - double-register behavior (documented: idempotent overwrite, except
//         ModuleToolRegistry which rejects namespace collision).
//       - resolve unknown → throws with the documented error token.
//   - ModuleToolRegistry: namespace collision (two contributions with the same
//     logicalId) → rejected with MODULE_TOOL_NAMESPACE_COLLISION.
//   - bindInstallation: valid plugin + record → InstalledProcessModule.
//   - bindInstallation: missing handler factory → INSTALLATION_BINDING_INCOMPLETE.
//   - bindInstallation: extra factory not declared on record → rejected with
//     INSTALLATION_BINDING_INCOMPLETE.
//   - bindInstallation: identity mismatch (plugin.installationId ≠ record.id)
//     → INSTALLATION_IDENTITY_MISMATCH.
//   - SchemaRegistry is the Wave 1 re-export (not redefined): verify the alias
//     resolves to InMemoryContractSchemaRegistry.
//
// Spec: docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md
//       §1 rows 10, 11, 12, §2 ports-vs-adapters.
// Task: docs/refactor-management/05-subagent-tasks/W02-A6-registries-plugin-binding.md

import assert from 'node:assert/strict';
import test from 'node:test';

// --- W2-A6 modules under test ------------------------------------------------
import {
  InMemoryHandlerRegistry,
  InMemoryCapabilityRegistry,
  InMemoryModuleToolRegistry,
  InMemoryGuardRegistry,
  InMemoryAgentDriverRegistry,
  InMemorySchemaRegistry,
  InMemoryContractSchemaRegistry,
  createInMemoryModuleRegistries,
  capabilityRegistryKey,
  guardRegistryKey,
  HANDLER_NOT_REGISTERED,
  CAPABILITY_NOT_REGISTERED,
  MODULE_TOOL_NOT_REGISTERED,
  MODULE_TOOL_NAMESPACE_COLLISION,
  GUARD_NOT_REGISTERED,
  AGENT_DRIVER_NOT_REGISTERED,
} from '../../dist/process-modules/installation/domain/registries.js';
import {
  isProcessModulePlugin,
} from '../../dist/process-modules/installation/domain/plugin.js';
import {
  bindInstallation,
  INSTALLATION_BINDING_INCOMPLETE,
  INSTALLATION_IDENTITY_MISMATCH,
} from '../../dist/process-modules/installation/domain/installation-binding.js';

// --- Wave 1 fixture builders (used to construct record + plugin shapes) ------
import {
  CONTRACT_REF_PENDING_DIGEST,
} from '../../dist/process-modules/domain/spi/index.js';

// ---------------------------------------------------------------------------
// Test helpers — build minimal shapes the registries/binder read.
// ---------------------------------------------------------------------------

/** A minimal HandlerRef with the given logicalId. */
function handlerRef(logicalId, version = '1.0.0', digest = 'd-' + logicalId) {
  return { logicalId, version, digest };
}

/** A minimal CapabilityRequirement. */
function capabilityRequirement(ref, version = '1.0.0', optional = false) {
  return { ref, version, optional };
}

/** A minimal GuardBinding. */
function guardBinding(ref, scope) {
  return { ref, scope };
}

/** A minimal ModuleToolContribution. */
function toolContribution(logicalId, opts = {}) {
  return {
    logicalId,
    version: opts.version ?? '1.0.0',
    inputContractRef: opts.inputContractRef ?? {
      schemaId: 'in.' + logicalId,
      version: '1.0.0',
      digest: 'din-' + logicalId,
    },
    outputContractRef: opts.outputContractRef ?? {
      schemaId: 'out.' + logicalId,
      version: '1.0.0',
      digest: 'dout-' + logicalId,
    },
    handlerRef: opts.handlerRef ?? 'h-' + logicalId,
    guardBindings: opts.guardBindings ?? [],
    idempotency: opts.idempotency ?? 'none',
    sideEffect: opts.sideEffect ?? 'read',
  };
}

/** A minimal ProcessModuleManifest with the given handlers + tools. */
function minimalManifest({ handlerRefs, toolContributions = [], resourceIndex = [] }) {
  return {
    manifestFormatVersion: '0.1.0',
    definition: {
      identity: { name: 'synthetic', version: '1.0.0' },
      inputContract: { schemaId: 'in', version: '1' },
      outputContract: { schemaId: 'out', version: '1' },
      flow: { nodes: [], edges: [] },
      outcomes: [],
      artifacts: [],
      policies: [],
      invariants: [],
      executionProfiles: [],
    },
    resourceIndex,
    handlerRefs,
    inputContractRef: { schemaId: 'manifest.in', version: '1.0.0', digest: 'md-in' },
    outputContractRef: { schemaId: 'manifest.out', version: '1.0.0', digest: 'md-out' },
    runtimeCompatibilityRange: '^3.0.0',
    toolContributions,
  };
}

/** A minimal ModuleInstallationRecord (matches the W2-A6 isolation alias shape). */
function installationRecord({ id, name, version, packageDigest, handlerRefs, toolContributions = [], resourceIndex = [] }) {
  return {
    id,
    name,
    version,
    packageDigest,
    manifestSnapshot: minimalManifest({ handlerRefs, toolContributions, resourceIndex }),
    handlerRefs,
  };
}

/** A no-op HandlerFactory. */
function noopFactory(name) {
  return () => () => 'noop:' + name;
}

// ===========================================================================
// HandlerRegistry
// ===========================================================================

test('HandlerRegistry: register/has/resolve positive path', () => {
  const reg = new InMemoryHandlerRegistry();
  const ref = handlerRef('kernel.settle');
  const factory = noopFactory('settle');
  assert.equal(reg.has(ref), false);
  reg.register(ref, factory);
  assert.equal(reg.has(ref), true);
  assert.equal(reg.resolve(ref), factory);
});

test('HandlerRegistry: double-register is idempotent overwrite (documented)', () => {
  const reg = new InMemoryHandlerRegistry();
  const ref = handlerRef('kernel.settle');
  const f1 = noopFactory('v1');
  const f2 = noopFactory('v2');
  reg.register(ref, f1);
  reg.register(ref, f2);
  // Latest binding wins; no error.
  assert.equal(reg.resolve(ref), f2);
});

test('HandlerRegistry: resolve unknown throws HANDLER_NOT_REGISTERED', () => {
  const reg = new InMemoryHandlerRegistry();
  const ref = handlerRef('missing');
  assert.equal(reg.has(ref), false);
  assert.throws(
    () => reg.resolve(ref),
    (err) => err instanceof Error && err.message.startsWith(HANDLER_NOT_REGISTERED),
  );
});

test('HandlerRegistry: indexes by logicalId only (digest/version ignored)', () => {
  const reg = new InMemoryHandlerRegistry();
  const f = noopFactory('h');
  reg.register(handlerRef('h', '1.0.0', 'd1'), f);
  // Same logicalId, different version/digest still resolves the same factory.
  assert.equal(reg.has(handlerRef('h', '2.0.0', 'd2')), true);
  assert.equal(reg.resolve(handlerRef('h', '2.0.0', 'd2')), f);
});

// ===========================================================================
// CapabilityRegistry
// ===========================================================================

test('CapabilityRegistry: register/has/resolve positive path', () => {
  const reg = new InMemoryCapabilityRegistry();
  const cap = capabilityRequirement('mcp.server', '1.0.0');
  const provider = { call: () => {} };
  assert.equal(reg.has(cap), false);
  reg.register(cap, provider);
  assert.equal(reg.has(cap), true);
  assert.equal(reg.resolve(cap), provider);
});

test('CapabilityRegistry: double-register is idempotent overwrite (documented)', () => {
  const reg = new InMemoryCapabilityRegistry();
  const cap = capabilityRequirement('mcp.server', '1.0.0');
  reg.register(cap, 'first');
  reg.register(cap, 'second');
  assert.equal(reg.resolve(cap), 'second');
});

test('CapabilityRegistry: resolve unknown throws CAPABILITY_NOT_REGISTERED', () => {
  const reg = new InMemoryCapabilityRegistry();
  const cap = capabilityRequirement('missing.cap', '1.0.0');
  assert.throws(
    () => reg.resolve(cap),
    (err) => err instanceof Error && err.message.startsWith(CAPABILITY_NOT_REGISTERED),
  );
});

test('CapabilityRegistry: same ref different version is distinct', () => {
  const reg = new InMemoryCapabilityRegistry();
  const v1 = capabilityRequirement('mcp.server', '1.0.0');
  const v2 = capabilityRequirement('mcp.server', '2.0.0');
  reg.register(v1, 'one');
  reg.register(v2, 'two');
  assert.equal(reg.resolve(v1), 'one');
  assert.equal(reg.resolve(v2), 'two');
  assert.equal(capabilityRegistryKey(v1), 'mcp.server@1.0.0');
  assert.equal(capabilityRegistryKey(v2), 'mcp.server@2.0.0');
});

// ===========================================================================
// ModuleToolRegistry
// ===========================================================================

test('ModuleToolRegistry: register/has/resolve/list positive path', () => {
  const reg = new InMemoryModuleToolRegistry();
  const tool = toolContribution('discovery.proposal_submit');
  const handler = () => {};
  assert.equal(reg.has(tool.logicalId), false);
  reg.register(tool, handler);
  assert.equal(reg.has(tool.logicalId), true);
  const entry = reg.resolve(tool.logicalId);
  assert.equal(entry.contribution, tool);
  assert.equal(entry.handler, handler);
  assert.equal(reg.list().length, 1);
});

test('ModuleToolRegistry: namespace collision (two contributions, same logicalId) is rejected', () => {
  const reg = new InMemoryModuleToolRegistry();
  const a = toolContribution('discovery.proposal_submit', { version: '1.0.0' });
  const b = toolContribution('discovery.proposal_submit', {
    version: '2.0.0',
    handlerRef: 'other-handler',
  });
  const ha = () => 'a';
  const hb = () => 'b';
  reg.register(a, ha);
  assert.throws(
    () => reg.register(b, hb),
    (err) => err instanceof Error && err.message.startsWith(MODULE_TOOL_NAMESPACE_COLLISION),
  );
  // The original registration is intact.
  assert.equal(reg.resolve(a.logicalId).contribution, a);
});

test('ModuleToolRegistry: namespace collision with same logicalId+version but different handler is rejected', () => {
  const reg = new InMemoryModuleToolRegistry();
  const tool = toolContribution('discovery.proposal_submit', { version: '1.0.0' });
  const h1 = () => 'h1';
  const h2 = () => 'h2';
  reg.register(tool, h1);
  assert.throws(
    () => reg.register(tool, h2),
    (err) => err instanceof Error && err.message.startsWith(MODULE_TOOL_NAMESPACE_COLLISION),
  );
});

test('ModuleToolRegistry: exact same contribution+handler is idempotent (no-op)', () => {
  const reg = new InMemoryModuleToolRegistry();
  const tool = toolContribution('discovery.proposal_submit');
  const handler = () => 'h';
  reg.register(tool, handler);
  // Re-registering the SAME contribution+handler does NOT throw.
  assert.doesNotThrow(() => reg.register(tool, handler));
  assert.equal(reg.list().length, 1);
});

test('ModuleToolRegistry: resolve unknown throws MODULE_TOOL_NOT_REGISTERED', () => {
  const reg = new InMemoryModuleToolRegistry();
  assert.throws(
    () => reg.resolve('missing.tool'),
    (err) => err instanceof Error && err.message.startsWith(MODULE_TOOL_NOT_REGISTERED),
  );
});

// ===========================================================================
// GuardRegistry
// ===========================================================================

test('GuardRegistry: register/has/resolve positive path', () => {
  const reg = new InMemoryGuardRegistry();
  const g = guardBinding('policy.submit', 'call');
  const impl = () => true;
  assert.equal(reg.has(g), false);
  reg.register(g, impl);
  assert.equal(reg.has(g), true);
  assert.equal(reg.resolve(g), impl);
  assert.equal(guardRegistryKey(g), 'policy.submit#call');
});

test('GuardRegistry: same ref different scope is distinct', () => {
  const reg = new InMemoryGuardRegistry();
  const callG = guardBinding('policy.submit', 'call');
  const submitG = guardBinding('policy.submit', 'submit');
  reg.register(callG, 'a');
  reg.register(submitG, 'b');
  assert.equal(reg.resolve(callG), 'a');
  assert.equal(reg.resolve(submitG), 'b');
});

test('GuardRegistry: double-register is idempotent overwrite (documented)', () => {
  const reg = new InMemoryGuardRegistry();
  const g = guardBinding('policy.x', 'call');
  reg.register(g, 'first');
  reg.register(g, 'second');
  assert.equal(reg.resolve(g), 'second');
});

test('GuardRegistry: resolve unknown throws GUARD_NOT_REGISTERED', () => {
  const reg = new InMemoryGuardRegistry();
  assert.throws(
    () => reg.resolve(guardBinding('missing', 'scope')),
    (err) => err instanceof Error && err.message.startsWith(GUARD_NOT_REGISTERED),
  );
});

// ===========================================================================
// AgentDriverRegistry
// ===========================================================================

test('AgentDriverRegistry: register/has/resolve positive path', () => {
  const reg = new InMemoryAgentDriverRegistry();
  const factory = () => ({ drive: () => {} });
  assert.equal(reg.has('saga-board-claude'), false);
  reg.register('saga-board-claude', factory);
  assert.equal(reg.has('saga-board-claude'), true);
  assert.equal(reg.resolve('saga-board-claude'), factory);
});

test('AgentDriverRegistry: double-register is idempotent overwrite (documented)', () => {
  const reg = new InMemoryAgentDriverRegistry();
  reg.register('test-driver', 'first');
  reg.register('test-driver', 'second');
  assert.equal(reg.resolve('test-driver'), 'second');
});

test('AgentDriverRegistry: resolve unknown throws AGENT_DRIVER_NOT_REGISTERED', () => {
  const reg = new InMemoryAgentDriverRegistry();
  assert.throws(
    () => reg.resolve('missing-driver'),
    (err) => err instanceof Error && err.message.startsWith(AGENT_DRIVER_NOT_REGISTERED),
  );
});

// ===========================================================================
// SchemaRegistry — RE-EXPORT contract (not redefined).
// ===========================================================================

test('SchemaRegistry: InMemorySchemaRegistry IS InMemoryContractSchemaRegistry (re-export, not redefine)', () => {
  // The alias must point at the Wave 1 class — same constructor, same instance
  // shape, NOT a redefinition.
  assert.equal(InMemorySchemaRegistry, InMemoryContractSchemaRegistry);
});

test('SchemaRegistry: createInMemoryModuleRegistries wires a working schema registry', () => {
  const bundle = createInMemoryModuleRegistries();
  assert.ok(bundle.schemaRegistry instanceof InMemoryContractSchemaRegistry);
  // Smoke-test that the re-exported registry still works the same as Wave 1.
  const ref = { schemaId: 's', version: '1', digest: CONTRACT_REF_PENDING_DIGEST };
  const codec = {
    encode: (v) => JSON.stringify(v),
    decode: (b) => JSON.parse(b),
    validateOrThrow: () => {},
  };
  bundle.schemaRegistry.register(ref, codec);
  assert.equal(bundle.schemaRegistry.has(ref), true);
  assert.equal(bundle.schemaRegistry.encode(ref, { a: 1 }), '{"a":1}');
});

// ===========================================================================
// createInMemoryModuleRegistries — bundle shape.
// ===========================================================================

test('createInMemoryModuleRegistries: returns fresh independent adapters', () => {
  const a = createInMemoryModuleRegistries();
  const b = createInMemoryModuleRegistries();
  // Different instances.
  assert.notEqual(a.handlerRegistry, b.handlerRegistry);
  assert.notEqual(a.moduleToolRegistry, b.moduleToolRegistry);
  // Each field is the expected adapter class.
  assert.ok(a.handlerRegistry instanceof InMemoryHandlerRegistry);
  assert.ok(a.capabilityRegistry instanceof InMemoryCapabilityRegistry);
  assert.ok(a.moduleToolRegistry instanceof InMemoryModuleToolRegistry);
  assert.ok(a.guardRegistry instanceof InMemoryGuardRegistry);
  assert.ok(a.agentDriverRegistry instanceof InMemoryAgentDriverRegistry);
  assert.ok(a.schemaRegistry instanceof InMemorySchemaRegistry);
});

// ===========================================================================
// isProcessModulePlugin — structural guard.
// ===========================================================================

test('isProcessModulePlugin: accepts a minimal well-formed plugin', () => {
  const plugin = {
    installationId: 1,
    handlerFactories: { 'h1': noopFactory('h1') },
  };
  assert.equal(isProcessModulePlugin(plugin), true);
});

test('isProcessModulePlugin: rejects malformed shapes', () => {
  assert.equal(isProcessModulePlugin(null), false);
  assert.equal(isProcessModulePlugin({}), false);
  assert.equal(isProcessModulePlugin({ installationId: 'x', handlerFactories: {} }), false);
  assert.equal(isProcessModulePlugin({ installationId: 1, handlerFactories: null }), false);
  assert.equal(
    isProcessModulePlugin({ installationId: 1, handlerFactories: { h: 'not-a-fn' } }),
    false,
  );
});

// ===========================================================================
// bindInstallation — happy path + fail-fast negatives.
// ===========================================================================

test('bindInstallation: valid plugin + record → InstalledProcessModule', () => {
  const bundle = createInMemoryModuleRegistries();
  const refA = handlerRef('h.a');
  const refB = handlerRef('h.b');
  // Pre-register the plugin's factories into the handler registry (this is the
  // composition root's job; bindInstallation reads them back via .resolve()).
  const fA = noopFactory('a');
  const fB = noopFactory('b');
  bundle.handlerRegistry.register(refA, fA);
  bundle.handlerRegistry.register(refB, fB);

  const record = installationRecord({
    id: 42,
    name: 'synthetic',
    version: '1.0.0',
    packageDigest: 'sha256:abc',
    handlerRefs: [refA, refB],
    toolContributions: [
      toolContribution('synthetic.tool1'),
      toolContribution('synthetic.tool2'),
    ],
    resourceIndex: [
      { logicalId: 'skill-1', path: 'skills/s1.md', kind: 'skill', digest: 'd-s1' },
    ],
  });
  const plugin = {
    installationId: 42,
    handlerFactories: { 'h.a': fA, 'h.b': fB },
  };

  const installed = bindInstallation(record, plugin, bundle);

  // Record carried through.
  assert.equal(installed.record, record);
  // Handlers resolved to the registry-bound factories.
  assert.equal(installed.resolvedHandlers['h.a'], fA);
  assert.equal(installed.resolvedHandlers['h.b'], fB);
  // Tools copied off the manifest snapshot.
  assert.equal(installed.resolvedTools.length, 2);
  assert.deepEqual(
    installed.resolvedTools.map((t) => t.logicalId).sort(),
    ['synthetic.tool1', 'synthetic.tool2'],
  );
  // Resources copied off the manifest snapshot.
  assert.equal(installed.resolvedResources.length, 1);
  assert.equal(installed.resolvedResources[0].logicalId, 'skill-1');
  // Schemas: manifest in/out + each tool's in/out, de-duped by schemaId@version.
  // Here every schemaId is unique → 2 (manifest) + 2*2 (tools) = 6.
  assert.equal(installed.resolvedSchemas.length, 6);
});

test('bindInstallation: missing handler factory → INSTALLATION_BINDING_INCOMPLETE', () => {
  const bundle = createInMemoryModuleRegistries();
  const refA = handlerRef('h.a');
  const refB = handlerRef('h.b');
  bundle.handlerRegistry.register(refA, noopFactory('a'));
  // Deliberately do NOT register refB and do NOT include it in the plugin.

  const record = installationRecord({
    id: 1,
    name: 'synthetic',
    version: '1.0.0',
    packageDigest: 'd',
    handlerRefs: [refA, refB],
  });
  const plugin = {
    installationId: 1,
    handlerFactories: { 'h.a': noopFactory('a') }, // missing h.b
  };

  assert.throws(
    () => bindInstallation(record, plugin, bundle),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.startsWith(INSTALLATION_BINDING_INCOMPLETE), err.message);
      assert.ok(err.message.includes('h.b'), 'must name the missing handler');
      return true;
    },
  );
});

test('bindInstallation: extra factory not declared on manifest → INSTALLATION_BINDING_INCOMPLETE', () => {
  const bundle = createInMemoryModuleRegistries();
  const refA = handlerRef('h.a');
  bundle.handlerRegistry.register(refA, noopFactory('a'));
  // The plugin carries an extra key not present on the manifest.
  const fExtra = noopFactory('extra');
  bundle.handlerRegistry.register(handlerRef('h.extra'), fExtra);

  const record = installationRecord({
    id: 1,
    name: 'synthetic',
    version: '1.0.0',
    packageDigest: 'd',
    handlerRefs: [refA],
  });
  const plugin = {
    installationId: 1,
    handlerFactories: { 'h.a': noopFactory('a'), 'h.extra': fExtra },
  };

  assert.throws(
    () => bindInstallation(record, plugin, bundle),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.startsWith(INSTALLATION_BINDING_INCOMPLETE), err.message);
      assert.ok(err.message.includes('h.extra'), 'must name the extra handler');
      return true;
    },
  );
});

test('bindInstallation: identity mismatch (plugin.installationId ≠ record.id) → INSTALLATION_IDENTITY_MISMATCH', () => {
  const bundle = createInMemoryModuleRegistries();
  const ref = handlerRef('h.a');
  bundle.handlerRegistry.register(ref, noopFactory('a'));

  const record = installationRecord({
    id: 1,
    name: 'synthetic',
    version: '1.0.0',
    packageDigest: 'd',
    handlerRefs: [ref],
  });
  // Plugin declares a different installationId than the record.
  const plugin = {
    installationId: 999,
    handlerFactories: { 'h.a': noopFactory('a') },
  };

  assert.throws(
    () => bindInstallation(record, plugin, bundle),
    (err) => err instanceof Error && err.message.startsWith(INSTALLATION_IDENTITY_MISMATCH),
  );
});

test('bindInstallation: empty handlerRefs + empty handlerFactories is valid (handler-less module)', () => {
  const bundle = createInMemoryModuleRegistries();
  const record = installationRecord({
    id: 7,
    name: 'passive',
    version: '1.0.0',
    packageDigest: 'd',
    handlerRefs: [],
  });
  const plugin = { installationId: 7, handlerFactories: {} };
  const installed = bindInstallation(record, plugin, bundle);
  assert.deepEqual(installed.resolvedHandlers, {});
});

test('bindInstallation: result is frozen (immutable value object)', () => {
  const bundle = createInMemoryModuleRegistries();
  const ref = handlerRef('h.a');
  bundle.handlerRegistry.register(ref, noopFactory('a'));
  const record = installationRecord({
    id: 1,
    name: 'synthetic',
    version: '1.0.0',
    packageDigest: 'd',
    handlerRefs: [ref],
  });
  const plugin = { installationId: 1, handlerFactories: { 'h.a': noopFactory('a') } };
  const installed = bindInstallation(record, plugin, bundle);
  assert.equal(Object.isFrozen(installed), true);
  assert.equal(Object.isFrozen(installed.resolvedHandlers), true);
  assert.equal(Object.isFrozen(installed.resolvedTools), true);
  assert.equal(Object.isFrozen(installed.resolvedSchemas), true);
  assert.equal(Object.isFrozen(installed.resolvedResources), true);
});
