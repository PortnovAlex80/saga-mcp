import assert from 'node:assert/strict';
import test from 'node:test';

const {
  ExistingOrchestrationEngineAdapter,
  ProcessModuleRuntimeEngine,
} = await import('../../dist/process-modules/application/process-module-runtime-engine.js');
// Wave 13 removed modules/catalog.ts; build the registry inline.
const { ProcessModuleRegistry } = await import(
  '../../dist/process-modules/application/process-module-registry.js'
);
const { DISCOVERY_PROCESS_MODULE_REF, discoveryProcessModule } = await import(
  '../../dist/process-modules/modules/discovery/discovery-process-module.js'
);
function createBuiltInProcessModuleRegistry() {
  const registry = new ProcessModuleRegistry();
  registry.register(discoveryProcessModule);
  return registry;
}

function fakeResult() {
  return {
    projectId: 1,
    epicId: 2,
    finalStage: 'discovery',
    endedAt: '2026-07-26T00:00:00.000Z',
    reason: 'completed',
    cycles: 3,
    lastError: null,
    outcome: 'go',
    outcomeAuthority: 'discovery_settlement_policy',
    settlement: {
      status: 'issued',
      settlementId: 10,
      certificateId: 11,
      certificateHash: 'a'.repeat(64),
      policyVersion: '1.0.0',
      decision: 'go',
      reasonCodes: [],
      error: null,
    },
  };
}

test('runtime wrapper projects versioned module identity and local outcome', async () => {
  const registry = createBuiltInProcessModuleRegistry();
  const engine = { run: async () => fakeResult() };
  const adapter = new ExistingOrchestrationEngineAdapter(
    DISCOVERY_PROCESS_MODULE_REF,
    engine,
    (_module, result) => ({
      code: result.outcome,
      authority: result.outcomeAuthority,
      outputRef: `certificate:${result.settlement.certificateId}`,
    }),
  );
  const runtime = new ProcessModuleRuntimeEngine(
    registry,
    DISCOVERY_PROCESS_MODULE_REF,
    adapter,
  );

  const result = await runtime.run({ projectId: 1, epicId: 2 });
  assert.deepEqual(result.processModule, {
    name: 'product-discovery',
    version: '3.0.2',
    kind: 'discovery',
    ref: 'product-discovery@3.0.2',
  });
  assert.deepEqual(result.processOutcome, {
    code: 'go',
    authority: 'discovery_settlement_policy',
    outputRef: 'certificate:11',
  });
});

test('runtime wrapper rejects an adapter bound to another module', () => {
  const registry = createBuiltInProcessModuleRegistry();
  const engine = { run: async () => fakeResult() };
  const wrongAdapter = new ExistingOrchestrationEngineAdapter(
    { name: 'solution-formalization', version: '1.0.0' },
    engine,
  );
  assert.throws(
    () => new ProcessModuleRuntimeEngine(registry, DISCOVERY_PROCESS_MODULE_REF, wrongAdapter),
    /adapter mismatch/,
  );
});
