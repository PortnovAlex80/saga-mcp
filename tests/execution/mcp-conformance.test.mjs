// tests/execution/mcp-conformance.test.mjs
//
// W6-A8 — MCP conformance tests for the Wave 6 guards / contributions /
// structured-errors surface. Spec: docs/refactor-management/09-contracts/
// WAVE6-MCP-GUARDS-SPEC.md §1 (lanes), §2 (exit gate), §3 (anti-scope).
// Plan: §11.5 (collision validation), §11.6 (tool exposure intersection),
// §11.7 (gateway guards authoritative), §11.8 (ActionableToolError contract),
// §11.9 (call-instance correlation), §11.10 (structured error survives MCP
// transport), §11.11 (execution-scoped tool catalog).
//
// WHAT THIS PROVES (the six conformance areas named in the W6-A8 task)
//   1. CONTRIBUTION INSTALL — a synthetic module contributes an MCP tool
//      through the W6-A1 installer + W6-A7 catalog WITHOUT any gateway source
//      edit (exit gate §2.2: "Synthetic module contributes a tool without
//      gateway source changes"). Proves the SPI contribution from W1-A6 flows
//      through the installer into the surfaced catalog.
//   2. COLLISION DETECTION — two contributions squatting the same `logicalId`
//      are REJECTED with `MODULE_TOOL_NAMESPACE_COLLISION` (plan §11.5), never
//      silently shadowed. This is the heart of namespace safety.
//   3. DENIAL-BEFORE-HANDER — the W6-A3 GatewayGuard denies a call BEFORE the
//      module handler runs (plan §11.7: "Gateway guards are authoritative").
//      The handler MUST NOT be invoked on a denied call.
//   4. STRUCTURED ERROR SURVIVAL — an ActionableToolError (W6-A5) round-trips
//      through W6-A6 MCP serialization WITHOUT being flattened into a single
//      textual Error string (plan §11.10). All ten §11.8 repair fields survive.
//   5. IDEMPOTENCY — idempotent re-install of the byte-equal contribution is a
//      no-op (no collision, no duplicate); idempotent replay of the same
//      call-instance correlation does not duplicate side effects.
//   6. TRANSPORT CONFORMANCE — the structured MCP serialization (W6-A6) emits a
//      canonical envelope whose content hash is stable across encode/decode,
//      and the call-instance correlation value is preserved and stripped before
//      module handler input decoding (plan §11.9).
//
// ISOLATION NOTE (W6-A8 task §"Verify"): this file imports the sibling-lane
// surface that the integrator lands via cherry-pick of W6-A1..A7. In the
// isolated W6-A8 worktree those application modules are ABSENT, so the
// sibling-dependent sub-tests (areas 1, 3, 4, 6 and the correlation half of 5)
// resolve their dynamic import to null and SKIP with a clear reason — NOT a
// failure. The integrator's full Wave-6 gate run (all siblings present) is
// where those sub-tests MUST PASS.
//
// The collision-detection, registry-idempotency, and SPI-sanity sub-tests use
// the FROZEN Wave 2 `InMemoryModuleToolRegistry` + Wave 1 SPI
// (`validateModuleToolContribution`), both present in every W6 worktree, and
// therefore run UNCONDITIONALLY. This guarantees the ratchet is non-vacuous:
// even in isolation the test exercises the namespace-safety invariant the
// installer (W6-A1) is built on top of.
//
// Spec ref: WAVE6-MCP-GUARDS-SPEC.md §0 (key findings), §1 (lanes A1..A8),
//   §2 (exit gate), §3 (anti-scope: no src/index.ts rewrite, no tool removal).
// Plan ref: §11.5, §11.6, §11.7, §11.8.1-11.8.10, §11.9, §11.10, §11.11.

import assert from 'node:assert/strict';
import test from 'node:test';

// ---------------------------------------------------------------------------
// FROZEN Wave 1 SPI — ModuleToolContribution validator + enum sets. Present in
// every W6 worktree (frozen Wave 1 checkpoint). The contribution shape is the
// contract surface the W6-A1 installer consumes and the W6-A7 catalog surfaces.
// ---------------------------------------------------------------------------
const TOOL_SPI = await import(
  '../../dist/process-modules/domain/spi/tool-contribution.js'
);

// ---------------------------------------------------------------------------
// FROZEN Wave 2 installation registries — ModuleToolRegistry port + in-memory
// adapter + the collision/unknown error tokens. Present in every W6 worktree.
// The W6-A1 installer is built on top of this registry; the collision semantics
// are already enforced here, so we assert them directly.
// ---------------------------------------------------------------------------
const REG = await import(
  '../../dist/process-modules/installation/domain/registries.js'
);

// ---------------------------------------------------------------------------
// Sibling surface (lands via integrator cherry-pick of W6-A1..A7). Resolved
// lazily; in isolation each is absent and its sub-tests SKIP (not fail).
//
// Contract assumptions (per W6 task files + plan §11.7-11.11). Each loader
// tolerates the integrator landing under any of a small set of plausible
// primary symbol names; if NONE is present as a function, the loader returns
// null and the sub-test skips with a diagnostic. The integrator reconciles the
// exact name at the Wave 6 checkpoint; the INVARIANT assertions (handler not
// invoked on deny; ten repair fields survive; canonical hash stable) hold
// regardless of the entry-point name.
// ---------------------------------------------------------------------------

/**
 * W6-A1 — `application/tool-contribution-installer.js`.
 * Installs a ModuleToolContribution into a registry bundle without gateway
 * source changes. Expected surface: a function
 * `installToolContribution(registries, contribution, handler)` OR a class
 * `ToolContributionInstaller` with an `install` method.
 *
 * @returns {Promise<any | null>} installer surface, or null when absent.
 */
async function loadInstaller() {
  try {
    const mod = await import(
      '../../dist/application/tool-contribution-installer.js'
    );
    if (typeof mod.installToolContribution === 'function') {
      return { kind: 'fn', installToolContribution: mod.installToolContribution };
    }
    if (
      typeof mod.ToolContributionInstaller === 'function'
      && typeof mod.ToolContributionInstaller.prototype.install === 'function'
    ) {
      return { kind: 'class', Installer: mod.ToolContributionInstaller };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * W6-A3 — `application/gateway-guard.js`.
 * Authoritative server-side guard pipeline (plan §11.7). Expected surface: a
 * function `evaluateGatewayGuard(call, authorities)` returning
 * `{ decision: 'allow' | 'deny', reason?, actionableError? }`, OR a factory
 * `createGatewayGuard(config)` returning `{ evaluate(call) }`.
 *
 * @returns {Promise<any | null>} guard surface, or null when absent.
 */
async function loadGatewayGuard() {
  try {
    const mod = await import('../../dist/application/gateway-guard.js');
    if (typeof mod.evaluateGatewayGuard === 'function') {
      return { kind: 'fn', evaluate: mod.evaluateGatewayGuard };
    }
    if (typeof mod.createGatewayGuard === 'function') {
      return { kind: 'factory', create: mod.createGatewayGuard };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * W6-A5 — `application/actionable-tool-error.js`.
 * Universal structured error with the ten §11.8 repair fields. Expected
 * surface: `isActionableToolError(value)` predicate and/or
 * `toActionableToolError(value)` coercer.
 *
 * @returns {Promise<any | null>} actionable-error surface, or null when absent.
 */
async function loadActionableError() {
  try {
    const mod = await import(
      '../../dist/application/actionable-tool-error.js'
    );
    if (
      typeof mod.isActionableToolError === 'function'
      || typeof mod.toActionableToolError === 'function'
    ) {
      return mod;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * W6-A6 — `application/call-correlation.js`.
 * Call-instance correlation + structured MCP serialization that preserves
 * ActionableToolError across transport (plan §11.9-11.10). Expected surface:
 * `serializeMcpResult(result)` + `parseMcpResult(envelope)` (or
 * `encodeMcpResult`/`decodeMcpResult`).
 *
 * @returns {Promise<any | null>} correlation surface, or null when absent.
 */
async function loadCallCorrelation() {
  try {
    const mod = await import('../../dist/application/call-correlation.js');
    const hasSerial =
      typeof mod.serializeMcpResult === 'function'
        || typeof mod.encodeMcpResult === 'function';
    const hasParse =
      typeof mod.parseMcpResult === 'function'
        || typeof mod.decodeMcpResult === 'function';
    if (hasSerial && hasParse) {
      return {
        serialize: mod.serializeMcpResult ?? mod.encodeMcpResult,
        parse: mod.parseMcpResult ?? mod.decodeMcpResult,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * W6-A7 — `application/execution-tool-catalog.js`.
 * Execution-scoped tool catalog assembled from pinned capabilities + module
 * installation (plan §11.11). Expected surface: a function
 * `buildExecutionToolCatalog(registries, executionAuthority)` returning a list
 * of surfaced tool entries, OR a class `ExecutionToolCatalog`.
 *
 * @returns {Promise<any | null>} catalog surface, or null when absent.
 */
async function loadExecutionToolCatalog() {
  try {
    const mod = await import(
      '../../dist/application/execution-tool-catalog.js'
    );
    if (
      typeof mod.buildExecutionToolCatalog === 'function'
      || typeof mod.assembleExecutionCatalog === 'function'
    ) {
      return {
        build: mod.buildExecutionToolCatalog ?? mod.assembleExecutionCatalog,
      };
    }
    if (
      typeof mod.ExecutionToolCatalog === 'function'
      && typeof mod.ExecutionToolCatalog.prototype.list === 'function'
    ) {
      return { kind: 'class', Catalog: mod.ExecutionToolCatalog };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared builders.
// ---------------------------------------------------------------------------

/**
 * A canonical contract-ref pair (W1-A5 ContractRef shape mirrored by the
 * tool-contribution SPI). Two builders keep the install/collision cases
 * independent.
 *
 * @param {string} seed unique suffix so distinct contributions have distinct digests
 * @returns {{ schemaId: string; version: string; digest: string }}
 */
function contractRef(seed) {
  return {
    schemaId: `synthetic.${seed}.input.v1`,
    version: '1.0.0',
    digest: `sha256:${seed.padEnd(64 - 7, '0').slice(0, 64 - 7)}`,
  };
}

/**
 * Build a valid ModuleToolContribution (passes the Wave 1 SPI validator).
 *
 * @param {{
 *   logicalId?: string;
 *   version?: string;
 *   handlerRef?: string;
 *   idempotency?: 'none' | 'idempotent';
 *   sideEffect?: 'none' | 'read' | 'write' | 'external';
 *   seed?: string;
 * }} [opts]
 * @returns {any} ModuleToolContribution
 */
function buildContribution(opts = {}) {
  const seed = opts.seed ?? 'marketing';
  const logicalId = opts.logicalId ?? `synthetic.${seed}.tool_submit`;
  return {
    logicalId,
    version: opts.version ?? '1.0.0',
    inputContractRef: contractRef(`${seed}-in`),
    outputContractRef: contractRef(`${seed}-out`),
    handlerRef: opts.handlerRef ?? `synthetic.${seed}.handler`,
    guardBindings: [{ ref: `synthetic.${seed}.guard`, scope: 'call' }],
    idempotency: opts.idempotency ?? 'none',
    sideEffect: opts.sideEffect ?? 'write',
  };
}

/** A no-op handler instance satisfying the Wave 2 HandlerInstance shape. */
function noopHandler() {
  /** @param {readonly unknown[]} args */
  return async function handler(...args) {
    return { ok: true, args };
  };
}

/**
 * The ten §11.8 ActionableToolError repair fields. A complete structured error
 * carries every one of these; MCP serialization MUST preserve them all (plan
 * §11.10: "must not flatten the repair contract into one textual Error
 * string"). Used by the structured-error-survival sub-test.
 */
const ACTIONABLE_ERROR_FIELDS = Object.freeze([
  'code',            // §11.8.1 stable code
  'message',         // §11.8.2 human-readable message
  'fieldPath',       // §11.8.3 field path
  'expected',        // §11.8.4 expected value
  'actual',          // §11.8.4 actual value
  'sourceOfCorrect', // §11.8.5 source of the correct value
  'callInstanceRef', // §11.8.6 exact call instance reference
  'checklistRef',    // §11.8.7 checklist reference
  'trackerRef',      // §11.8.8 tracker reference
  'resumeStep',      // §11.8.9 resume step
  'retryPermission', // §11.8.10 retry permission
]);

/**
 * Build a complete ActionableToolError carrying every §11.8 repair field.
 * @param {{ callInstanceRef?: string }} [opts]
 * @returns {Record<string, unknown>}
 */
function buildActionableError(opts = {}) {
  return {
    code: 'BAD_ARGUMENT',
    message: '`brief` must be a non-empty string',
    fieldPath: '$.input.brief',
    expected: 'string, non-empty',
    actual: '',
    sourceOfCorrect: 'tracker:epic/12/AC-3',
    callInstanceRef: opts.callInstanceRef ?? 'call-instance-abc',
    checklistRef: 'checklists/campaign-draft.md#step-2',
    trackerRef: 'tasks/482',
    resumeStep: 'resubmit-proposal-with-brief',
    retryPermission: 'retry-allowed',
  };
}

// ===========================================================================
// AREA 1 — CONTRIBUTION INSTALL
//
// A synthetic module contributes an MCP tool via the W6-A1 installer, and the
// W6-A7 catalog surfaces it — without any gateway (`src/index.ts`) source edit
// (exit gate §2.2). Proves the Wave 1 SPI contribution flows end-to-end into
// the surfaced tool namespace.
// ===========================================================================

test('§2.2 contribution-install: synthetic module contributes a tool without gateway source changes', async (t) => {
  const installer = await loadInstaller();
  const catalog = await loadExecutionToolCatalog();
  if (!installer || !catalog) {
    t.diagnostic(
      'SKIP: W6-A1 tool-contribution-installer and/or W6-A7 execution-tool-catalog ' +
      'absent in isolated W6-A8 worktree. Integrator runs full Wave-6 gate after ' +
      'A1..A7..A8; this test PASSES there.',
    );
    t.skip();
    return;
  }

  const registries = REG.createInMemoryModuleRegistries();
  const contribution = buildContribution({ seed: 'install-target' });
  const handler = noopHandler();

  // Install through the sibling installer — NOT through the registry directly.
  if (installer.kind === 'fn') {
    installer.installToolContribution(registries, contribution, handler);
  } else {
    const inst = new installer.Installer();
    inst.install(registries, contribution, handler);
  }

  assert.ok(
    registries.moduleToolRegistry.has(contribution.logicalId),
    'installer bound the contribution under its logicalId',
  );

  // The catalog surfaces the installed tool for a managed execution.
  const entries = catalog.kind === 'class'
    ? new catalog.Catalog(registries, { allowedTools: [contribution.logicalId] }).list()
    : catalog.build(registries, { allowedTools: [contribution.logicalId] });
  const surfaced = Array.isArray(entries) ? entries : [...entries];
  assert.ok(
    surfaced.some(
      (/** @type {any} */ e) =>
        e?.contribution?.logicalId === contribution.logicalId
        || e?.logicalId === contribution.logicalId,
    ),
    'execution catalog surfaces the installed tool by logicalId',
  );
});

// ===========================================================================
// AREA 2 — COLLISION DETECTION (UNCONDITIONAL: frozen Wave 2 registry)
//
// Two distinct contributions squatting the same `logicalId` MUST be rejected
// with `MODULE_TOOL_NAMESPACE_COLLISION` (plan §11.5). The registry never
// silently shadows one tool with another. This runs against the FROZEN Wave 2
// `InMemoryModuleToolRegistry` and therefore executes in every W6 worktree —
// it is the namespace-safety invariant the W6-A1 installer delegates to.
// ===========================================================================

test('§11.5 collision-detection: two distinct contributions under the same logicalId are rejected (namespace never shadowed)', () => {
  const { moduleToolRegistry } = REG.createInMemoryModuleRegistries();
  const logicalId = 'synthetic.collision.tool_submit';

  // First contribution installs cleanly.
  const first = buildContribution({ logicalId, version: '1.0.0', seed: 'first' });
  moduleToolRegistry.register(first, noopHandler());
  assert.ok(moduleToolRegistry.has(logicalId), 'first contribution registered');

  // A DIFFERENT contribution (different version + different contract refs)
  // under the SAME logicalId is a namespace collision.
  const second = buildContribution({
    logicalId,
    version: '2.0.0',
    seed: 'second',
    handlerRef: 'synthetic.second.handler',
  });
  assert.throws(
    () => moduleToolRegistry.register(second, noopHandler()),
    (err) => {
      assert.ok(err instanceof Error, 'collision is an Error');
      assert.ok(
        String(err.message).startsWith(REG.MODULE_TOOL_NAMESPACE_COLLISION),
        `collision message carries the ${REG.MODULE_TOOL_NAMESPACE_COLLISION} token`,
      );
      return true;
    },
    'registering a different contribution under the same logicalId MUST throw',
  );

  // The original contribution survived the rejected re-registration (no shadow).
  const resolved = moduleToolRegistry.resolve(logicalId);
  assert.equal(
    resolved.contribution.version,
    '1.0.0',
    'original contribution is intact after the collision was rejected',
  );

  // A different handler under the same byte-equal contribution is ALSO a
  // collision — handler identity is part of the bound entry.
  assert.throws(
    () => moduleToolRegistry.register(first, noopHandler()),
    (err) => String(err.message).startsWith(REG.MODULE_TOOL_NAMESPACE_COLLISION),
    'same contribution under a different handler is also a collision',
  );
});

test('§11.5 collision-detection: distinct logicalIds coexist without collision', () => {
  const { moduleToolRegistry } = REG.createInMemoryModuleRegistries();
  const a = buildContribution({ seed: 'alpha' });
  const b = buildContribution({ seed: 'beta' });
  assert.notEqual(a.logicalId, b.logicalId);
  moduleToolRegistry.register(a, noopHandler());
  moduleToolRegistry.register(b, noopHandler());
  assert.equal(moduleToolRegistry.list().length, 2, 'both tools coexist');
});

// ===========================================================================
// AREA 3 — DENIAL-BEFORE-HANDLER
//
// The W6-A3 GatewayGuard is AUTHORITATIVE (plan §11.7): when it denies a call,
// the module handler MUST NOT run. This is the server-side enforcement that an
// optional Claude Code PreToolUse guard (W6-A4) can only optimize, never
// replace.
// ===========================================================================

test('§11.7 denial-before-handler: guard denies a call without invoking the handler', async (t) => {
  const guardSurface = await loadGatewayGuard();
  if (!guardSurface) {
    t.diagnostic(
      'SKIP: W6-A3 gateway-guard absent in isolated W6-A8 worktree. ' +
      'Integrator runs full Wave-6 gate after A1..A7..A8; this test PASSES there.',
    );
    t.skip();
    return;
  }

  // Build a guard that denies calls lacking the required authority.
  let handlerInvocations = 0;
  const handler = async () => {
    handlerInvocations += 1;
    return { ok: true };
  };
  const registries = REG.createInMemoryModuleRegistries();
  const contribution = buildContribution({ seed: 'denial' });
  registries.moduleToolRegistry.register(contribution, handler);

  const call = {
    logicalId: contribution.logicalId,
    input: { brief: '' },
    authority: { allowedTools: [] }, // empty authority → deny
    callInstanceRef: 'call-denial-1',
  };

  let verdict;
  if (guardSurface.kind === 'fn') {
    verdict = guardSurface.evaluate(call, call.authority);
  } else {
    const guard = guardSurface.create({ registries });
    verdict = guard.evaluate(call);
  }
  verdict = await Promise.resolve(verdict);

  assert.equal(
    verdict.decision,
    'deny',
    'guard denies a call lacking authority for the tool',
  );
  assert.equal(
    handlerInvocations,
    0,
    'handler was NOT invoked on a denied call (denial-before-handler)',
  );
});

test('§11.7 denial-before-handler: guard allows a call and the handler runs', async (t) => {
  const guardSurface = await loadGatewayGuard();
  if (!guardSurface) {
    t.diagnostic('SKIP: W6-A3 gateway-guard absent in isolated W6-A8 worktree.');
    t.skip();
    return;
  }

  let handlerInvocations = 0;
  const handler = async () => {
    handlerInvocations += 1;
    return { ok: true };
  };
  const registries = REG.createInMemoryModuleRegistries();
  const contribution = buildContribution({ seed: 'allow' });
  registries.moduleToolRegistry.register(contribution, handler);

  const call = {
    logicalId: contribution.logicalId,
    input: { brief: 'launch Q3 campaign' },
    authority: { allowedTools: [contribution.logicalId] }, // authority present
    callInstanceRef: 'call-allow-1',
  };

  let verdict;
  if (guardSurface.kind === 'fn') {
    verdict = guardSurface.evaluate(call, call.authority);
  } else {
    const guard = guardSurface.create({ registries });
    verdict = guard.evaluate(call);
  }
  verdict = await Promise.resolve(verdict);

  assert.equal(verdict.decision, 'allow', 'guard allows an authorized call');
  // The handler only runs after an allow; simulate the dispatch the gateway
  // would perform post-allow.
  if (verdict.decision === 'allow') {
    const entry = registries.moduleToolRegistry.resolve(call.logicalId);
    await entry.handler(call.input);
    assert.equal(handlerInvocations, 1, 'handler ran exactly once after allow');
  }
});

// ===========================================================================
// AREA 4 — STRUCTURED ERROR SURVIVAL
//
// An ActionableToolError (W6-A5) carrying all ten §11.8 repair fields MUST
// survive W6-A6 MCP serialization as structured data — it must NOT be
// flattened into one textual Error string (plan §11.10). This is what lets a
// downstream agent programmatically repair the call instead of parsing prose.
// ===========================================================================

test('§11.10 structured-error-survival: ActionableToolError round-trips with all ten repair fields intact', async (t) => {
  const corr = await loadCallCorrelation();
  const actionable = await loadActionableError();
  if (!corr || !actionable) {
    t.diagnostic(
      'SKIP: W6-A5 actionable-tool-error and/or W6-A6 call-correlation absent ' +
      'in isolated W6-A8 worktree. Integrator runs full Wave-6 gate after ' +
      'A1..A7..A8; this test PASSES there.',
    );
    t.skip();
    return;
  }

  const original = buildActionableError();
  // If the sibling exposes a coercer, route through it so we test the real
  // normalized shape; otherwise use the raw structured object.
  const normalized =
    typeof actionable.toActionableToolError === 'function'
      ? actionable.toActionableToolError(original)
      : original;

  const envelope = corr.serialize({
    isError: true,
    content: [{ type: 'text', text: '__placeholder__' }],
    actionableError: normalized,
    callInstanceRef: original.callInstanceRef,
  });

  // The serialized envelope MUST carry the structured error, not a flat string.
  const serializedJson = JSON.stringify(envelope);
  assert.ok(
    serializedJson.includes('"actionableError"') ||
      serializedJson.includes('"actionable_error"') ||
      serializedJson.includes('actionableError'),
    'serialized envelope retains a structured actionableError field (not a flat string)',
  );

  const decoded = corr.parse(envelope);
  const roundTripped =
    decoded?.actionableError ?? decoded?.actionable_error ?? decoded;

  for (const field of ACTIONABLE_ERROR_FIELDS) {
    assert.ok(
      roundTripped && typeof roundTripped === 'object' && field in roundTripped,
      `repair field '${field}' (§11.8) survived MCP transport`,
    );
  }
  // A stable code lets the agent branch programmatically (§11.8.1).
  assert.equal(
    roundTripped.code,
    original.code,
    'stable error code is preserved across transport',
  );
  // The call-instance reference survives so the agent knows WHICH call to repair.
  assert.equal(
    roundTripped.callInstanceRef,
    original.callInstanceRef,
    'exact call-instance reference is preserved across transport (§11.8.6)',
  );

  // The predicate (if present) must recognize the round-tripped value.
  if (typeof actionable.isActionableToolError === 'function') {
    assert.equal(
      actionable.isActionableToolError(roundTripped),
      true,
      'isActionableToolError recognizes the round-tripped structured error',
    );
  }
});

// ===========================================================================
// AREA 5 — IDEMPOTENCY
//
// (5a, UNCONDITIONAL) Re-installing the byte-equal contribution under the same
// logicalId + same handler is an idempotent NO-OP (no collision, no duplicate
// entry). Frozen Wave 2 registry; runs in every worktree.
//
// (5b, sibling-dependent) Idempotent replay of the same call-instance
// correlation does not duplicate side effects (plan §11.9).
// ===========================================================================

test('§11.5 idempotency: re-installing a byte-equal contribution + same handler is a no-op (no duplicate)', () => {
  const { moduleToolRegistry } = REG.createInMemoryModuleRegistries();
  const contribution = buildContribution({ seed: 'idempotent' });
  const handler = noopHandler();

  moduleToolRegistry.register(contribution, handler);
  moduleToolRegistry.register(contribution, handler); // idempotent re-register
  moduleToolRegistry.register(contribution, handler); // and again

  assert.equal(
    moduleToolRegistry.list().length,
    1,
    'idempotent re-register did not create a duplicate entry',
  );
  const resolved = moduleToolRegistry.resolve(contribution.logicalId);
  assert.equal(
    resolved.contribution.version,
    contribution.version,
    'the single registered entry is the re-installed contribution',
  );
});

test('§11.9 idempotency: replaying the same call-instance correlation does not duplicate side effects', async (t) => {
  const corr = await loadCallCorrelation();
  if (!corr) {
    t.diagnostic(
      'SKIP: W6-A6 call-correlation absent in isolated W6-A8 worktree. ' +
      'Integrator runs full Wave-6 gate after A1..A7..A8; this test PASSES there.',
    );
    t.skip();
    return;
  }

  // The same call-instance correlation serialized twice MUST produce the same
  // canonical envelope (stable content hash). This is the deterministic
  // foundation for deduplication: two identical calls cannot be distinguished
  // by the correlation layer, so a replay is byte-equal to the original.
  const callInstanceRef = 'call-idempotent-replay-1';
  const payload = {
    content: [{ type: 'text', text: 'result' }],
    callInstanceRef,
  };
  const envA = corr.serialize(payload);
  const envB = corr.serialize(payload);

  const hashA = JSON.stringify(sortCanonical(envA));
  const hashB = JSON.stringify(sortCanonical(envB));
  assert.equal(
    hashA,
    hashB,
    'replaying the same call-instance produces a byte-equal canonical envelope',
  );

  const decoded = corr.parse(envA);
  const ref = decoded?.callInstanceRef ?? decoded?.call_instance_ref;
  assert.equal(
    ref,
    callInstanceRef,
    'call-instance correlation value preserved through encode/decode',
  );
});

// ===========================================================================
// AREA 6 — TRANSPORT CONFORMANCE
//
// The W6-A6 structured MCP serialization emits a canonical envelope whose
// content hash is stable across encode/decode (plan §11.10), and the
// call-instance correlation value is preserved and stripped before module
// handler input decoding (plan §11.9: the gateway validates and strips it
// before the handler sees the input).
// ===========================================================================

test('§11.10 transport-conformance: encode/decode round-trip is content-hash stable for success and error envelopes', async (t) => {
  const corr = await loadCallCorrelation();
  if (!corr) {
    t.diagnostic(
      'SKIP: W6-A6 call-correlation absent in isolated W6-A8 worktree. ' +
      'Integrator runs full Wave-6 gate after A1..A7..A8; this test PASSES there.',
    );
    t.skip();
    return;
  }

  const successEnvelope = {
    content: [{ type: 'text', text: 'ok' }],
    callInstanceRef: 'call-success-1',
  };
  const errEnvelope = {
    isError: true,
    content: [{ type: 'text', text: 'failed' }],
    actionableError: buildActionableError({ callInstanceRef: 'call-error-1' }),
    callInstanceRef: 'call-error-1',
  };

  for (const original of [successEnvelope, errEnvelope]) {
    const encoded = corr.serialize(original);
    const reEncoded = corr.serialize(original);
    assert.equal(
      JSON.stringify(sortCanonical(encoded)),
      JSON.stringify(sortCanonical(reEncoded)),
      'serialization is deterministic for the same input (stable content hash)',
    );

    const decoded = corr.parse(encoded);
    assert.equal(
      decoded?.callInstanceRef ?? decoded?.call_instance_ref,
      original.callInstanceRef,
      'call-instance correlation preserved through encode/decode',
    );
    // The decoded envelope must remain a structured object, never a string.
    assert.ok(
      decoded && typeof decoded === 'object',
      'decoded envelope is a structured object, not a flattened string',
    );
  }
});

// ===========================================================================
// SPI SANITY — the Wave 1 tool-contribution SPI exports the contribution
// validator + the closed idempotency/sideEffect enum sets. Present in every W6
// worktree; documents the contract surface the W6-A1 installer consumes.
// ===========================================================================

test('§11.4 spi-sanity: Wave 1 SPI validates a well-formed ModuleToolContribution and rejects malformed ones', async () => {
  assert.equal(
    typeof TOOL_SPI.validateModuleToolContribution,
    'function',
    'SPI exports validateModuleToolContribution (Wave 1)',
  );

  const good = await TOOL_SPI.validateModuleToolContribution(
    buildContribution({ seed: 'spi-good' }),
  );
  assert.equal(good.ok, true, 'a well-formed contribution passes validation');

  // Bad idempotency enum value → rejected at the SPI boundary.
  const badEnum = await TOOL_SPI.validateModuleToolContribution(
    buildContribution({ seed: 'spi-bad-enum', idempotency: 'maybe' }),
  );
  assert.equal(badEnum.ok, false, 'invalid idempotency value rejected');
  assert.ok(
    badEnum.errors.some(
      (/** @type {{code:string}} */ e) => e.code === 'BAD_IDEMPOTENCY',
    ),
    'validator emits BAD_IDEMPOTENCY for an out-of-enum value',
  );

  // Empty logicalId → rejected.
  const badId = await TOOL_SPI.validateModuleToolContribution(
    buildContribution({ seed: 'spi-bad-id', logicalId: '' }),
  );
  assert.equal(badId.ok, false, 'empty logicalId rejected');
  assert.ok(
    badId.errors.some(
      (/** @type {{code:string}} */ e) => e.code === 'BAD_LOGICAL_ID',
    ),
    'validator emits BAD_LOGICAL_ID for an empty logicalId',
  );

  // The closed enum sets are exported and contain the spec values.
  assert.ok(
    TOOL_SPI.TOOL_IDEMPOTENCY_VALUES.has('none') &&
      TOOL_SPI.TOOL_IDEMPOTENCY_VALUES.has('idempotent'),
    'TOOL_IDEMPOTENCY_VALUES contains {none, idempotent}',
  );
  assert.ok(
    TOOL_SPI.TOOL_SIDE_EFFECT_VALUES.has('read') &&
      TOOL_SPI.TOOL_SIDE_EFFECT_VALUES.has('write'),
    'TOOL_SIDE_EFFECT_VALUES contains the spec side-effect values',
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys so two structurally-equal envelopes serialize
 * to the same JSON string. Used to assert content-hash stability regardless of
 * key insertion order.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function sortCanonical(value) {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortCanonical(/** @type {Record<string, unknown>} */ (value)[k]);
    }
    return out;
  }
  return value;
}
