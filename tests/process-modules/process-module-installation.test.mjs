// P1 tests: ProcessModuleDefinition ↔ ProcessModuleInstallation separation.
//
// Covers:
//   - ProcessModuleExecutor SPI (ProcessModuleRunResult contract)
//   - validateProcessModuleInstallation: definition↔executor ref match, kind
//   - ProcessModuleInstallationRegistry:
//       • valid Definition + matching executor → registered
//       • mismatched executor.moduleRef → rejected
//       • invalid kind → rejected
//       • re-registration of same ref → rejected
//       • catalogued-but-not-installed → require() throws "not installed"
//   - LegacyEngineExecutorAdapter: thin shim delegates to engine.run + projector
//   - Helpers: certificateOnlyResult, outputOnlyResult

import assert from 'node:assert/strict';
import test from 'node:test';

const { ProcessModuleInstallationRegistry } = await import(
  '../../dist/process-modules/application/process-module-installation-registry.js'
);
const { validateProcessModuleInstallation } = await import(
  '../../dist/process-modules/application/validate-process-module-installation.js'
);
const {
  LegacyEngineExecutorAdapter,
  certificateOnlyResult,
  outputOnlyResult,
} = await import(
  '../../dist/process-modules/application/legacy-engine-executor-adapter.js'
);
const { discoveryProcessModule } = await import(
  '../../dist/process-modules/modules/discovery/discovery-process-module.js'
);
const { formalizationProcessModule } = await import(
  '../../dist/process-modules/modules/formalization/formalization-process-module.js'
);

// --- Fixtures ---------------------------------------------------------------

function fakeExecutor({ moduleRef, kind = 'legacy-adapter' } = {}) {
  return {
    moduleRef,
    kind,
    async execute(_module, _ctx) {
      return { outcome: 'go', output: null, certificate: null, authority: null };
    },
  };
}

function fakeLegacyEngine(result) {
  return { run: async () => result };
}

const DISCOVERY_REF = { name: 'product-discovery', version: '3.0.0' };
const FORMALIZATION_REF = { name: 'solution-formalization', version: '1.0.0' };

// --- validateProcessModuleInstallation --------------------------------------

test('validateProcessModuleInstallation accepts a correctly bound installation', () => {
  const installation = {
    definition: discoveryProcessModule,
    executor: fakeExecutor({ moduleRef: DISCOVERY_REF }),
  };
  const result = validateProcessModuleInstallation(installation);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateProcessModuleInstallation rejects a mismatched executor ref', () => {
  const installation = {
    definition: discoveryProcessModule,
    // executor bound to formalization but definition is discovery
    executor: fakeExecutor({ moduleRef: FORMALIZATION_REF }),
  };
  const result = validateProcessModuleInstallation(installation);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => /installation binding mismatch/.test(e)));
});

test('validateProcessModuleInstallation rejects an invalid executor kind', () => {
  const installation = {
    definition: discoveryProcessModule,
    executor: fakeExecutor({ moduleRef: DISCOVERY_REF, kind: 'bogus' }),
  };
  const result = validateProcessModuleInstallation(installation);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => /executor kind 'bogus' is invalid/.test(e)));
});

// --- ProcessModuleInstallationRegistry --------------------------------------

test('Installation registry accepts a valid Definition + executor binding', () => {
  const registry = new ProcessModuleInstallationRegistry();
  registry.register({
    definition: discoveryProcessModule,
    executor: fakeExecutor({ moduleRef: DISCOVERY_REF }),
  });
  const got = registry.require(DISCOVERY_REF);
  assert.equal(got.definition.identity.name, 'product-discovery');
  assert.equal(got.executor.moduleRef.version, '3.0.0');
});

test('Installation registry re-validates the Definition at register time', () => {
  // If someone hands a structurally broken Definition (even with a matching
  // executor), registration must fail — the Installation never carries an
  // invalid Definition.
  const registry = new ProcessModuleInstallationRegistry();
  const broken = {
    ...discoveryProcessModule,
    identity: { ...discoveryProcessModule.identity, version: 'not-semver' },
  };
  assert.throws(
    () => registry.register({
      definition: broken,
      executor: fakeExecutor({ moduleRef: { name: 'product-discovery', version: 'not-semver' } }),
    }),
    /ProcessModuleInstallationRegistrationError/,
  );
});

test('Installation registry rejects re-registration of the same module ref', () => {
  const registry = new ProcessModuleInstallationRegistry();
  registry.register({
    definition: discoveryProcessModule,
    executor: fakeExecutor({ moduleRef: DISCOVERY_REF }),
  });
  assert.throws(
    () => registry.register({
      definition: discoveryProcessModule,
      executor: fakeExecutor({ moduleRef: DISCOVERY_REF }),
    }),
    /already registered/,
  );
});

test('require() throws for a catalogued-but-not-installed module', () => {
  // Formalization is catalogued (Definition exists) but in P1 has no executor.
  // require() must surface this clearly so the Runtime can refuse start.
  const registry = new ProcessModuleInstallationRegistry();
  registry.register({
    definition: discoveryProcessModule,
    executor: fakeExecutor({ moduleRef: DISCOVERY_REF }),
  });
  assert.throws(
    () => registry.require(FORMALIZATION_REF),
    /not installed/,
  );
  // get() returns null instead of throwing (read-only lookup).
  assert.equal(registry.get(FORMALIZATION_REF), null);
});

test('list() returns all registered installations', () => {
  const registry = new ProcessModuleInstallationRegistry();
  registry.register({
    definition: discoveryProcessModule,
    executor: fakeExecutor({ moduleRef: DISCOVERY_REF }),
  });
  registry.register({
    definition: formalizationProcessModule,
    executor: fakeExecutor({ moduleRef: FORMALIZATION_REF }),
  });
  assert.equal(registry.list().length, 2);
});

// --- LegacyEngineExecutorAdapter --------------------------------------------

test('LegacyEngineExecutorAdapter is a thin shim: delegates to engine.run + projector', async () => {
  const engineResult = {
    projectId: 1, epicId: 2, finalStage: 'discovery', endedAt: 'now',
    reason: 'completed', cycles: 3, lastError: null,
    outcome: 'go', outcomeAuthority: 'discovery_settlement_policy',
    settlement: {
      status: 'issued', settlementId: 10, certificateId: 11,
      certificateHash: 'a'.repeat(64), policyVersion: '1.0.0',
      decision: 'go', reasonCodes: [], error: null,
    },
  };
  const adapter = new LegacyEngineExecutorAdapter({
    moduleRef: DISCOVERY_REF,
    engine: fakeLegacyEngine(engineResult),
    translateCommand: (_module, ctx) => ({
      projectId: ctx.projectId, epicId: ctx.epicId ?? 0,
    }),
    projectOutcome: (_module, result, _ctx) => certificateOnlyResult(
      'go',
      {
        schema: 'saga3.discovery-outcome-certificate.v1',
        certificateRef: `certificate:${result.settlement.certificateId}`,
        certificateHash: result.settlement.certificateHash,
      },
      'discovery_settlement_policy',
    ),
  });
  assert.equal(adapter.kind, 'legacy-adapter');
  const runResult = await adapter.execute(discoveryProcessModule, {
    projectId: 1, epicId: 2, processRunId: 99,
    inputPayload: {}, inputHash: '0'.repeat(64), initiatedBy: 'test',
  });
  assert.equal(runResult.outcome, 'go');
  assert.equal(runResult.certificate?.certificateRef, 'certificate:11');
  assert.equal(runResult.authority, 'discovery_settlement_policy');
  assert.equal(runResult.output, null);
});

// --- Result helpers ---------------------------------------------------------

test('certificateOnlyResult and outputOnlyResult shape the RunResult correctly', () => {
  const cert = certificateOnlyResult(
    'accepted',
    { schema: 's', certificateRef: 'c:1', certificateHash: 'h' },
    'formalization_settlement_policy',
  );
  assert.equal(cert.output, null);
  assert.equal(cert.certificate?.certificateRef, 'c:1');

  const out = outputOnlyResult(
    'completed',
    { schema: 's', artifactRef: 'a:1', contentHash: 'h' },
    null,
  );
  assert.equal(out.certificate, null);
  assert.equal(out.output?.artifactRef, 'a:1');
});
