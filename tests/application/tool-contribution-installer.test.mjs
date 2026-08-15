// tests/application/tool-contribution-installer.test.mjs
//
// W6-A1 — Module tool contribution installer (application layer).
//
// Spec: docs/refactor-management/09-contracts/WAVE6-MCP-GUARDS-SPEC.md
//       §1 row W6-A1, §2 exit gate, §3 anti-scope.
// Plan: §0.9.3, §11.4 (ModuleToolContribution), §11.5 (installation validates
//       tool collisions, handler coverage, capability dependencies, schema
//       availability, and resource availability), §14.8.1.
// Task: docs/refactor-management/05-subagent-tasks/W06-a1.md
//
// Coverage:
//   - Happy path: a valid batch installs into the registry, resolving handlers.
//   - Empty batch is a no-op (count 0).
//   - Structural defect (bad field) → MODULE_TOOL_INSTALL_FAILED with a reason.
//   - Namespace defect: missing namespace separator (bare tool name) → rejected.
//   - Namespace defect: bad alphabet (uppercase / space / slash) → rejected.
//   - Namespace defect: empty segment (.tool, ns., ns..tool) → rejected.
//   - Version defect: non-semver / range / prerelease → rejected.
//   - Handler coverage defect: handlerRef not registered → rejected.
//   - Batch atomicity: a batch with ANY defect installs NOTHING.
//   - All-defects-in-one-report: multiple defects surface together.
//   - Collision: a different contribution under the same logicalId is rejected
//     by the Wave 2 registry (MODULE_TOOL_NAMESPACE_COLLISION), surfaced on the
//     first colliding contribution during the register loop.
//   - Idempotent re-register: the exact same contribution + handler is a no-op
//     and is reported in result.idempotent (NOT result.installed).
//   - Error tokens are re-exported from the installer surface.
//   - Result is frozen (immutable).

import assert from 'node:assert/strict';
import test from 'node:test';

// --- Module under test ------------------------------------------------------
import {
  installModuleToolContributions,
  ModuleToolInstallError,
  MODULE_TOOL_INSTALL_FAILED,
  MODULE_TOOL_NAMESPACE_COLLISION,
  MODULE_TOOL_NOT_REGISTERED,
  HANDLER_NOT_REGISTERED,
} from '../../dist/application/tool-contribution-installer.js';

// --- Wave 2 registry layer (used to build the registries bundle) ------------
import {
  InMemoryModuleToolRegistry,
  InMemoryHandlerRegistry,
  createInMemoryModuleRegistries,
} from '../../dist/process-modules/installation/domain/registries.js';

// ---------------------------------------------------------------------------
// Fixture builders — minimal valid shapes.
// ---------------------------------------------------------------------------

/** A minimal valid ModuleToolContribution. */
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
    callTemplateRef: opts.callTemplateRef,
    checklistRef: opts.checklistRef,
    errorHintRef: opts.errorHintRef,
    guardBindings: opts.guardBindings ?? [],
    idempotency: opts.idempotency ?? 'none',
    sideEffect: opts.sideEffect ?? 'read',
  };
}

/** A minimal HandlerRef. */
function handlerRef(logicalId, version = '1.0.0', digest = 'd-' + logicalId) {
  return { logicalId, version, digest };
}

/** A no-op handler factory → handler instance. */
function noopHandler(name) {
  return () => 'noop:' + name;
}

/** Wire a fresh registries bundle and pre-register handlers for the contributions. */
function bundleWithHandlers(contributions) {
  const bundle = createInMemoryModuleRegistries();
  for (const c of contributions) {
    bundle.handlerRegistry.register(handlerRef(c.handlerRef), noopHandler(c.handlerRef));
  }
  return bundle;
}

// ===========================================================================
// Happy path.
// ===========================================================================

test('happy path: a valid batch installs into the registry', async () => {
  const tools = [
    toolContribution('discovery.proposal_submit'),
    toolContribution('discovery.readiness_submit'),
  ];
  const bundle = bundleWithHandlers(tools);

  const result = await installModuleToolContributions(tools, bundle);

  assert.deepEqual([...result.installed].sort(), [
    'discovery.proposal_submit',
    'discovery.readiness_submit',
  ]);
  assert.deepEqual(result.idempotent, []);
  assert.equal(result.count, 2);
  // The registry now resolves both tools.
  assert.equal(bundle.moduleToolRegistry.has('discovery.proposal_submit'), true);
  assert.equal(bundle.moduleToolRegistry.has('discovery.readiness_submit'), true);
  // The bound handlers are the ones pre-registered under each handlerRef.
  const entry = bundle.moduleToolRegistry.resolve('discovery.proposal_submit');
  assert.equal(typeof entry.handler, 'function');
  assert.equal(entry.handler(), 'noop:h-discovery.proposal_submit');
});

test('happy path: deeply nested namespace prefix is accepted', async () => {
  const tool = toolContribution('factory.discovery.kernel.settle');
  const bundle = bundleWithHandlers([tool]);
  const result = await installModuleToolContributions([tool], bundle);
  assert.deepEqual(result.installed, ['factory.discovery.kernel.settle']);
  assert.equal(result.count, 1);
});

test('happy path: empty batch is a no-op returning count 0', async () => {
  const bundle = createInMemoryModuleRegistries();
  const result = await installModuleToolContributions([], bundle);
  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.idempotent, []);
  assert.equal(result.count, 0);
  assert.equal(bundle.moduleToolRegistry.list().length, 0);
});

test('happy path: tool with guard bindings installs', async () => {
  const tool = toolContribution('formalization.ac_create', {
    guardBindings: [{ ref: 'policy.submit', scope: 'call' }],
    idempotency: 'idempotent',
    sideEffect: 'write',
  });
  const bundle = bundleWithHandlers([tool]);
  const result = await installModuleToolContributions([tool], bundle);
  assert.deepEqual(result.installed, ['formalization.ac_create']);
  assert.equal(result.count, 1);
});

// ===========================================================================
// Result immutability.
// ===========================================================================

test('result is frozen (immutable value object)', async () => {
  const tool = toolContribution('discovery.proposal_submit');
  const bundle = bundleWithHandlers([tool]);
  const result = await installModuleToolContributions([tool], bundle);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.installed), true);
  assert.equal(Object.isFrozen(result.idempotent), true);
});

// ===========================================================================
// Namespace validation (plan §11.4.1: namespaced logical identifier).
// ===========================================================================

test('namespace: bare tool name with no separator is rejected', async () => {
  const tool = toolContribution('proposal_submit'); // no '.' at all
  const bundle = bundleWithHandlers([tool]);
  await assert.rejects(
    () => installModuleToolContributions([tool], bundle),
    (err) => {
      assert.ok(err instanceof ModuleToolInstallError, 'must be ModuleToolInstallError');
      assert.ok(err.message.startsWith(MODULE_TOOL_INSTALL_FAILED));
      const nsReason = err.reasons.find((r) => r.code === 'MISSING_NAMESPACE');
      assert.ok(nsReason, 'must report MISSING_NAMESPACE');
      assert.equal(nsReason.field, 'logicalId');
      return true;
    },
  );
  // Atomicity: nothing landed.
  assert.equal(bundle.moduleToolRegistry.list().length, 0);
});

test('namespace: uppercase alphabet is rejected', async () => {
  const tool = toolContribution('Discovery.proposal_submit');
  const bundle = bundleWithHandlers([tool]);
  await assert.rejects(
    () => installModuleToolContributions([tool], bundle),
    (err) => {
      const r = err.reasons.find((x) => x.code === 'BAD_NAMESPACE_ALPHABET');
      assert.ok(r, 'must report BAD_NAMESPACE_ALPHABET');
      return true;
    },
  );
});

test('namespace: space and slash are rejected', async () => {
  for (const bad of ['discovery .proposal', 'discovery/proposal', 'discovery,proposal']) {
    const tool = toolContribution(bad);
    const bundle = bundleWithHandlers([tool]);
    await assert.rejects(
      () => installModuleToolContributions([tool], bundle),
      (err) => {
        const r = err.reasons.find((x) => x.code === 'BAD_NAMESPACE_ALPHABET');
        assert.ok(r, `${bad} must report BAD_NAMESPACE_ALPHABET`);
        return true;
      },
    );
  }
});

test('namespace: leading dot (empty namespace segment) is rejected', async () => {
  const tool = toolContribution('.proposal_submit');
  const bundle = bundleWithHandlers([tool]);
  await assert.rejects(
    () => installModuleToolContributions([tool], bundle),
    (err) => {
      const r = err.reasons.find((x) => x.code === 'EMPTY_NAMESPACE_SEGMENT');
      assert.ok(r, '.proposal_submit must report EMPTY_NAMESPACE_SEGMENT');
      return true;
    },
  );
});

test('namespace: trailing dot (empty tool-name segment) is rejected', async () => {
  const tool = toolContribution('discovery.');
  const bundle = bundleWithHandlers([tool]);
  await assert.rejects(
    () => installModuleToolContributions([tool], bundle),
    (err) => {
      const r = err.reasons.find((x) => x.code === 'EMPTY_NAMESPACE_SEGMENT');
      assert.ok(r, 'discovery. must report EMPTY_NAMESPACE_SEGMENT');
      return true;
    },
  );
});

test('namespace: consecutive dots (empty middle segment) is rejected', async () => {
  const tool = toolContribution('discovery..proposal');
  const bundle = bundleWithHandlers([tool]);
  await assert.rejects(
    () => installModuleToolContributions([tool], bundle),
    (err) => {
      const r = err.reasons.find((x) => x.code === 'EMPTY_NAMESPACE_SEGMENT');
      assert.ok(r, 'discovery..proposal must report EMPTY_NAMESPACE_SEGMENT');
      return true;
    },
  );
});

// ===========================================================================
// Version validation (plan §11.4.1: exact semver).
// ===========================================================================

test('version: non-semver string is rejected', async () => {
  const tool = toolContribution('discovery.proposal_submit', { version: '1.0' });
  const bundle = bundleWithHandlers([tool]);
  await assert.rejects(
    () => installModuleToolContributions([tool], bundle),
    (err) => {
      const r = err.reasons.find((x) => x.code === 'BAD_TOOL_VERSION');
      assert.ok(r, 'version 1.0 must report BAD_TOOL_VERSION');
      return true;
    },
  );
});

test('version: range is rejected (exact semver only)', async () => {
  for (const bad of ['^1.0.0', '~1.0.0', '>=1.0.0', '1.0.0-beta', 'latest']) {
    const tool = toolContribution('discovery.proposal_submit', { version: bad });
    const bundle = bundleWithHandlers([tool]);
    await assert.rejects(
      () => installModuleToolContributions([tool], bundle),
      (err) => {
        const r = err.reasons.find((x) => x.code === 'BAD_TOOL_VERSION');
        assert.ok(r, `version '${bad}' must report BAD_TOOL_VERSION`);
        return true;
      },
    );
  }
});

// ===========================================================================
// Structural validation (Wave 1 SPI reused) + batch atomicity.
// ===========================================================================

test('structural: bad inputContractRef is reported with Wave 1 validation code', async () => {
  const tool = toolContribution('discovery.proposal_submit', {
    inputContractRef: { schemaId: '', version: '1.0.0', digest: 'd' },
  });
  const bundle = bundleWithHandlers([tool]);
  await assert.rejects(
    () => installModuleToolContributions([tool], bundle),
    (err) => {
      const r = err.reasons.find((x) => x.code === 'BAD_SCHEMA_ID');
      assert.ok(r, 'must surface the Wave 1 BAD_SCHEMA_ID code');
      assert.equal(r.field, 'inputContractRef.schemaId');
      return true;
    },
  );
  assert.equal(bundle.moduleToolRegistry.list().length, 0);
});

test('structural: bad idempotency enum is reported', async () => {
  const tool = toolContribution('discovery.proposal_submit', { idempotency: 'bogus' });
  const bundle = bundleWithHandlers([tool]);
  await assert.rejects(
    () => installModuleToolContributions([tool], bundle),
    (err) => {
      const r = err.reasons.find((x) => x.code === 'BAD_IDEMPOTENCY');
      assert.ok(r);
      return true;
    },
  );
});

test('atomicity: one bad contribution in a batch installs NOTHING', async () => {
  const good = toolContribution('discovery.proposal_submit');
  const badNs = toolContribution('baretool'); // missing namespace
  const bundle = bundleWithHandlers([good, badNs]);
  await assert.rejects(
    () => installModuleToolContributions([good, badNs], bundle),
    (err) => err instanceof ModuleToolInstallError,
  );
  // Neither contribution landed.
  assert.equal(bundle.moduleToolRegistry.has('discovery.proposal_submit'), false);
  assert.equal(bundle.moduleToolRegistry.list().length, 0);
});

test('atomicity: all defects in a batch surface in one report', async () => {
  // a: lowercase bare name (MISSING_NAMESPACE) + bad version (BAD_TOOL_VERSION).
  // Using a lowercase name isolates the namespace defect: an uppercase name
  // would be caught by the alphabet check (BAD_NAMESPACE_ALPHABET) first.
  const a = toolContribution('baretool', { version: 'bad' });
  // b: valid namespace + version, but no handler registered → HANDLER_NOT_FOUND.
  const b = toolContribution('discovery.tool_b', { version: '1.0.0' });
  const bundle = createInMemoryModuleRegistries();
  // Register handler only for a (so a's defects are isolated to ns+version);
  // b deliberately has no handler → handler-coverage defect.
  bundle.handlerRegistry.register(handlerRef(a.handlerRef), noopHandler(a.handlerRef));
  await assert.rejects(
    () => installModuleToolContributions([a, b], bundle),
    (err) => {
      const codes = err.reasons.map((r) => r.code).sort();
      // a contributes MISSING_NAMESPACE + BAD_TOOL_VERSION; b contributes HANDLER_NOT_FOUND.
      assert.ok(codes.includes('MISSING_NAMESPACE'), 'a namespace defect');
      assert.ok(codes.includes('BAD_TOOL_VERSION'), 'a version defect');
      assert.ok(codes.includes('HANDLER_NOT_FOUND'), 'b handler-coverage defect');
      return true;
    },
  );
});

// ===========================================================================
// Handler coverage (plan §11.5).
// ===========================================================================

test('handler coverage: handlerRef with no registered handler is rejected', async () => {
  const tool = toolContribution('discovery.proposal_submit');
  const bundle = createInMemoryModuleRegistries();
  // Deliberately do NOT register a handler under tool.handlerRef.
  await assert.rejects(
    () => installModuleToolContributions([tool], bundle),
    (err) => {
      const r = err.reasons.find((x) => x.code === 'HANDLER_NOT_FOUND');
      assert.ok(r, 'must report HANDLER_NOT_FOUND');
      assert.ok(r.message.includes(tool.handlerRef), 'must name the missing handlerRef');
      return true;
    },
  );
  assert.equal(bundle.moduleToolRegistry.list().length, 0);
});

// ===========================================================================
// Collision detection — delegated to the Wave 2 ModuleToolRegistry.
// ===========================================================================

test('collision: a different contribution under the same logicalId is rejected', async () => {
  // First, install a tool into the registry directly.
  const bundle = createInMemoryModuleRegistries();
  const original = toolContribution('discovery.proposal_submit', { version: '1.0.0' });
  bundle.handlerRegistry.register(handlerRef(original.handlerRef), noopHandler('h1'));
  bundle.moduleToolRegistry.register(original, noopHandler('h1'));

  // Now attempt to install a DIFFERENT contribution (different version + handlerRef)
  // under the same logicalId via the installer. The registry must reject it.
  const different = toolContribution('discovery.proposal_submit', {
    version: '2.0.0',
    handlerRef: 'h-other',
  });
  bundle.handlerRegistry.register(handlerRef(different.handlerRef), noopHandler('h2'));

  await assert.rejects(
    () => installModuleToolContributions([different], bundle),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.startsWith(MODULE_TOOL_NAMESPACE_COLLISION),
        `must surface MODULE_TOOL_NAMESPACE_COLLISION, got: ${err.message}`,
      );
      return true;
    },
  );
  // The original registration is intact.
  const entry = bundle.moduleToolRegistry.resolve('discovery.proposal_submit');
  assert.equal(entry.contribution, original);
});

// ===========================================================================
// Idempotent re-register — exact same contribution + handler is a no-op.
// ===========================================================================

test('idempotent: exact same contribution + handler is a no-op', async () => {
  const tool = toolContribution('discovery.proposal_submit');
  const bundle = bundleWithHandlers([tool]);
  const handler = bundle.handlerRegistry.resolve(handlerRef(tool.handlerRef));

  // First install.
  const r1 = await installModuleToolContributions([tool], bundle);
  assert.deepEqual(r1.installed, ['discovery.proposal_submit']);
  assert.deepEqual(r1.idempotent, []);
  assert.equal(r1.count, 1);

  // Re-run the same batch. The registry sees the same contribution + same
  // resolved handler (handlerRef resolves to the identical function object) and
  // treats it as idempotent.
  const r2 = await installModuleToolContributions([tool], bundle);
  assert.deepEqual(r2.installed, []);
  assert.deepEqual(r2.idempotent, ['discovery.proposal_submit']);
  assert.equal(r2.count, 1);
  assert.equal(bundle.moduleToolRegistry.list().length, 1);
  // Same handler identity preserved.
  assert.equal(bundle.moduleToolRegistry.resolve('discovery.proposal_submit').handler, handler);
});

// ===========================================================================
// Error surface — token exports + error class shape.
// ===========================================================================

test('error surface: tokens are re-exported as the Wave 2 literals', () => {
  assert.equal(MODULE_TOOL_INSTALL_FAILED, 'MODULE_TOOL_INSTALL_FAILED');
  assert.equal(MODULE_TOOL_NAMESPACE_COLLISION, 'MODULE_TOOL_NAMESPACE_COLLISION');
  assert.equal(MODULE_TOOL_NOT_REGISTERED, 'MODULE_TOOL_NOT_REGISTERED');
  assert.equal(HANDLER_NOT_REGISTERED, 'HANDLER_NOT_REGISTERED');
});

test('error surface: ModuleToolInstallError carries non-empty reasons and a descriptive message', async () => {
  const tool = toolContribution('bare'); // missing namespace
  const bundle = bundleWithHandlers([tool]);
  try {
    await installModuleToolContributions([tool], bundle);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ModuleToolInstallError);
    assert.ok(err.reasons.length >= 1);
    assert.ok(err.message.startsWith(MODULE_TOOL_INSTALL_FAILED));
    assert.ok(err.message.includes('reason(s)'), err.message);
    assert.equal(err.name, 'ModuleToolInstallError');
  }
});

// ===========================================================================
// Uses Wave 2 ModuleToolRegistry: confirms the installer talks to the
// installation-layer registry (not a re-implemented one).
// ===========================================================================

test('uses Wave 2 registry: an InMemoryModuleToolRegistry is accepted directly', async () => {
  // Build the registries bundle manually from the Wave 2 in-memory adapters to
  // prove the installer depends on the Wave 2 PORT, not a concrete duplicate.
  const moduleToolRegistry = new InMemoryModuleToolRegistry();
  const handlerRegistry = new InMemoryHandlerRegistry();
  const tool = toolContribution('delivery.merge_release');
  handlerRegistry.register(handlerRef(tool.handlerRef), noopHandler(tool.handlerRef));

  const result = await installModuleToolContributions([tool], {
    moduleToolRegistry,
    handlerRegistry,
  });

  assert.deepEqual(result.installed, ['delivery.merge_release']);
  assert.equal(moduleToolRegistry.has('delivery.merge_release'), true);
  // The registry's own resolve/list still work — proving we registered into the
  // Wave 2 registry, not a shadow copy.
  assert.equal(moduleToolRegistry.list().length, 1);
});
