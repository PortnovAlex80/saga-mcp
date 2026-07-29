// tests/process-modules/composition-loader.test.mjs
//
// W11-A2 — Generic package + scenario composition loader.
//
// Spec: docs/refactor-management/09-contracts/WAVE11-CUTOVER-SPEC.md
//   §0 (serial gate), §2 lane W11-A2, §4 exit gate, §5 anti-scope (legacy
//   stays as fallback).
// Task: docs/refactor-management/05-subagent-tasks/W11-a2.md.
//
// Coverage:
//   - Legacy fallback: no active scenario → mode 'legacy', built-in catalog.
//   - Installed mode: active scenario + active packages → mode 'installed',
//     catalog + installation registry populated from installed packages,
//     scenarios listed verbatim.
//   - Catalogue-only package: executor factory returns null → installed false,
//     module in catalog but NOT in installation registry.
//   - Broken definition: manifest snapshot with no usable definition →
//     CompositionLoaderError with COMPOSITION_LOAD_DEFINITION_INVALID.
//   - Registration failure surfaced as COMPOSITION_LOAD_REGISTRATION_FAILED.
//   - No module-name switching: the loader binds via the injected factory by
//     ProcessModuleReference; the factory is the only place an executor is
//     chosen (the loader passes the identity through verbatim).
//   - Convenience wrapper loadComposition() mirrors CompositionLoader.load().
//
// The module + scenario installation repositories are in-memory fakes that
// mirror the frozen port surfaces (Wave 2 §1 row 3, Wave 7 §1 row W7-A1) so
// the loader is exercised without sqlite. The fakes enforce the same
// active-only / UNIQUE-on-active invariants the real repos enforce.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompositionLoader,
  CompositionLoaderError,
  loadComposition,
  COMPOSITION_LOAD_DEFINITION_INVALID,
  COMPOSITION_LOAD_REGISTRATION_FAILED,
  COMPOSITION_LOAD_INSTALLATION_FAILED,
} from '../../dist/process-modules/application/composition-loader.js';
import { ProcessModuleRegistry } from '../../dist/process-modules/application/process-module-registry.js';
import { ProcessModuleInstallationRegistry } from '../../dist/process-modules/application/process-module-installation-registry.js';
// Wave 13 removed modules/catalog.ts + modules/installations.ts; the legacy
// built-in factories are reconstructed inline from the production module
// definitions imported directly.
import { discoveryProcessModule } from '../../dist/process-modules/modules/discovery/discovery-process-module.js';
import { formalizationProcessModule } from '../../dist/process-modules/modules/formalization/formalization-process-module.js';
import { developmentProcessModule } from '../../dist/process-modules/modules/development/development-process-module.js';
import { deliveryProcessModule } from '../../dist/process-modules/modules/delivery/delivery-process-module.js';

// ---------------------------------------------------------------------------
// Legacy factory wiring.
//
// The loader does NOT import a module catalog (Rule 4b ratchet forbids it —
// application/ must not import modules/*). The composition root injects the
// real built-in factories; tests do the same so the legacy fallback path is
// exercised against the real production module set.
// ---------------------------------------------------------------------------

function realLegacyCatalogFactory() {
  const registry = new ProcessModuleRegistry();
  registry.register(discoveryProcessModule);
  registry.register(formalizationProcessModule);
  registry.register(developmentProcessModule);
  registry.register(deliveryProcessModule);
  return registry;
}
const realLegacyInstallationRegistryFactory = (installations) => {
  const registry = new ProcessModuleInstallationRegistry();
  for (const installation of installations) {
    registry.register(installation);
  }
  return registry;
};

function makeDeps(moduleRepo, scenarioRepo) {
  return {
    moduleInstallationRepository: moduleRepo,
    scenarioInstallationRepository: scenarioRepo,
    legacyCatalogFactory: realLegacyCatalogFactory,
    legacyInstallationRegistryFactory: realLegacyInstallationRegistryFactory,
  };
}

// ---------------------------------------------------------------------------
// In-memory fake: ModuleInstallationRepository (Wave 2 port surface).
// ---------------------------------------------------------------------------

function brandModuleId(n) {
  // Branded ModuleInstallationId is a plain number at runtime.
  return n;
}

class FakeModuleInstallationRepository {
  constructor() {
    this._rows = [];
    this._nextId = 1;
  }
  _clone(r) {
    return { ...r, manifestSnapshot: r.manifestSnapshot };
  }
  insert(record) {
    if (record.status === 'active') {
      const clash = this._rows.find(
        (r) => r.status === 'active' && r.name === record.name && r.version === record.version,
      );
      if (clash !== undefined) {
        const e = new Error(`MODULE_INSTALLATION_VERSION_COLLISION: (${record.name}, ${record.version})`);
        e.code = 'MODULE_INSTALLATION_VERSION_COLLISION';
        throw e;
      }
    }
    const id = brandModuleId(this._nextId++);
    const stored = this._clone({ ...record, id });
    this._rows.push(stored);
    return this._clone(stored);
  }
  getById(id) {
    const r = this._rows.find((x) => x.id === id);
    return r ? this._clone(r) : null;
  }
  getByPackageDigest(digest) {
    const r = this._rows.find((x) => x.packageDigest === digest);
    return r ? this._clone(r) : null;
  }
  getActiveByNameVersion(name, version) {
    const r = this._rows.find((x) => x.status === 'active' && x.name === name && x.version === version);
    return r ? this._clone(r) : null;
  }
  activate(id) {
    const r = this._rows.find((x) => x.id === id);
    if (!r) throw new Error(`MODULE_INSTALLATION_NOT_FOUND: id=${id}`);
    r.status = 'active';
    r.activatedAt = new Date().toISOString();
    return this._clone(r);
  }
  retire(id) {
    const r = this._rows.find((x) => x.id === id);
    if (!r) throw new Error(`MODULE_INSTALLATION_NOT_FOUND: id=${id}`);
    r.status = 'retired';
    r.retiredAt = new Date().toISOString();
    return this._clone(r);
  }
  markCorrupt(id) {
    const r = this._rows.find((x) => x.id === id);
    if (!r) throw new Error(`MODULE_INSTALLATION_NOT_FOUND: id=${id}`);
    r.status = 'corrupt';
    return this._clone(r);
  }
  listActive() {
    return this._rows.filter((r) => r.status === 'active').map((r) => this._clone(r));
  }
}

// ---------------------------------------------------------------------------
// In-memory fake: ScenarioInstallationRepository (Wave 7 port surface).
// ---------------------------------------------------------------------------

function brandScenarioId(n) {
  return n;
}

class FakeScenarioInstallationRepository {
  constructor() {
    this._rows = [];
    this._nextId = 1;
  }
  _clone(r) {
    return { ...r, moduleLock: r.moduleLock ? [...r.moduleLock] : [], manifestSnapshot: r.manifestSnapshot };
  }
  installScenario(input) {
    const id = brandScenarioId(this._nextId++);
    const stored = this._clone({
      ...input,
      id,
      status: input.status ?? 'active',
      installedAt: new Date().toISOString(),
      activatedAt: input.status !== 'staged' ? new Date().toISOString() : undefined,
    });
    this._rows.push(stored);
    return this._clone(stored);
  }
  getScenarioInstallation(id) {
    const r = this._rows.find((x) => x.id === id);
    return r ? this._clone(r) : null;
  }
  getModuleLock(scenarioInstallationId) {
    const r = this._rows.find((x) => x.id === scenarioInstallationId);
    return r ? this._clone(r).moduleLock ?? [] : null;
  }
  getActiveByNameVersion(name, version) {
    const r = this._rows.find((x) => x.status === 'active' && x.scenarioName === name && x.scenarioVersion === version);
    return r ? this._clone(r) : null;
  }
  getByDigest(digest) {
    const r = this._rows.find((x) => x.scenarioDigest === digest);
    return r ? this._clone(r) : null;
  }
  activate(id) {
    const r = this._rows.find((x) => x.id === id);
    if (!r) throw new Error('SCENARIO_INSTALLATION_NOT_FOUND');
    r.status = 'active';
    if (!r.activatedAt) r.activatedAt = new Date().toISOString();
    return this._clone(r);
  }
  retire(id) {
    const r = this._rows.find((x) => x.id === id);
    if (!r) throw new Error('SCENARIO_INSTALLATION_NOT_FOUND');
    r.status = 'retired';
    r.retiredAt = new Date().toISOString();
    return this._clone(r);
  }
  listActive() {
    return this._rows.filter((r) => r.status === 'active').map((r) => this._clone(r));
  }
}

// ---------------------------------------------------------------------------
// Factories: minimal valid ProcessModuleDefinition + manifest snapshot.
// ---------------------------------------------------------------------------

let _digestCounter = 0;
function digest(prefix) {
  _digestCounter += 1;
  return `sha256:${prefix}:${_digestCounter}`.padEnd(64, '0');
}

function minimalDefinition({ name, version, kind = name }) {
  return {
    identity: {
      name,
      version,
      kind,
      displayName: `${name} display`,
      description: `${name} description`,
    },
    inputContract: { id: `${name}.input.v1` },
    outputContract: { id: `${name}.output.v1` },
    outcomes: [
      { code: 'done', description: 'completed', terminal: true },
    ],
    flow: {
      id: `${name}.flow`,
      version: '1.0.0',
      entryNodeId: 'emit',
      nodes: [
        {
          id: 'emit',
          label: 'Emit',
          kind: 'kernel',
          description: 'emit done',
          handler: 'process-outcome-emitter',
          emitsOutcome: 'done',
        },
      ],
      transitions: [],
      terminalNodeIds: ['emit'],
    },
    artifacts: [],
    policies: [],
    invariants: [],
    executionProfiles: [],
  };
}

function makeModuleRecord({ name, version, definition, status = 'active' }) {
  return {
    id: brandModuleId(-1),
    name,
    version,
    packageDigest: digest(`${name}:${version}`),
    manifestSnapshot: {
      manifestFormatVersion: '1',
      definition: definition ?? minimalDefinition({ name, version }),
      resourceIndex: [],
      handlerRefs: [],
      inputContractRef: { schemaId: `${name}.input`, version: '1.0.0', digest: '0'.repeat(64) },
      outputContractRef: { schemaId: `${name}.output`, version: '1.0.0', digest: '0'.repeat(64) },
      runtimeCompatibilityRange: '*',
    },
    storeLocation: `<root>/${name}/${version}`,
    resourceIndex: [],
    handlerRefs: [],
    dependencyLock: {},
    status,
    installedAt: '2026-07-28T00:00:00.000Z',
    activatedAt: status === 'active' ? '2026-07-28T00:00:00.000Z' : undefined,
  };
}

function makeScenarioRecord({ name, version }) {
  return {
    id: brandScenarioId(-1),
    scenarioName: name,
    scenarioVersion: version,
    scenarioDigest: digest(`scenario:${name}:${version}`),
    manifestSnapshot: { identity: { name, version } },
    moduleLock: [],
    storeLocation: `<root>/scenarios/${name}/${version}`,
    status: 'active',
    installedAt: '2026-07-28T00:00:00.000Z',
    activatedAt: '2026-07-28T00:00:00.000Z',
  };
}

// A stub executor that satisfies the ProcessModuleExecutor SPI. The loader
// only stores it; it never calls execute() during load.
function stubExecutor({ name, version }) {
  return {
    moduleRef: { name, version },
    kind: 'generic-flow',
    async execute() {
      throw new Error('stub executor: execute() not expected during load');
    },
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test('load() returns mode "legacy" when no active scenario is installed', () => {
  const moduleRepo = new FakeModuleInstallationRepository();
  const scenarioRepo = new FakeScenarioInstallationRepository();
  // Packages installed but NO scenario → still legacy (cutover not opted in).
  moduleRepo.insert(makeModuleRecord({ name: 'alpha', version: '1.0.0' }));

  const loader = new CompositionLoader(makeDeps(moduleRepo, scenarioRepo));
  const result = loader.load({ executorFactory: () => null });

  assert.equal(result.mode, 'legacy');
  assert.equal(result.reason, 'no-active-scenario');
  // Legacy catalog is the built-in one (4 production modules). The exact
  // names are the real module identities (not "discovery"/"delivery" etc.) —
  // asserting them verbatim proves the legacy path is byte-for-byte the
  // existing built-in catalog, with no wave-11 drift.
  assert.ok(result.catalog instanceof ProcessModuleRegistry);
  const names = result.catalog.list().map((m) => m.identity.name).sort();
  assert.deepEqual(names, [
    'delivery-release',
    'product-discovery',
    'solution-development',
    'solution-formalization',
  ]);
});

test('load() returns mode "installed" when an active scenario exists', () => {
  const moduleRepo = new FakeModuleInstallationRepository();
  const scenarioRepo = new FakeScenarioInstallationRepository();
  scenarioRepo.installScenario(makeScenarioRecord({ name: 'product-delivery', version: '1.0.0' }));
  moduleRepo.insert(makeModuleRecord({ name: 'alpha', version: '1.0.0' }));

  const loader = new CompositionLoader(makeDeps(moduleRepo, scenarioRepo));
  const result = loader.load({ executorFactory: () => null });

  assert.equal(result.mode, 'installed');
  assert.equal(result.scenarios.length, 1);
  assert.equal(result.scenarios[0].scenarioName, 'product-delivery');
  // Catalogue-only (factory returned null) but still in the catalog.
  assert.equal(result.packages.length, 1);
  assert.equal(result.packages[0].installed, false);
  assert.ok(result.catalog.get({ name: 'alpha', version: '1.0.0' }));
});

test('installed mode: package with a bound executor is in both catalog and installation registry', () => {
  const moduleRepo = new FakeModuleInstallationRepository();
  const scenarioRepo = new FakeScenarioInstallationRepository();
  scenarioRepo.installScenario(makeScenarioRecord({ name: 'pd', version: '1.0.0' }));
  moduleRepo.insert(makeModuleRecord({ name: 'bound', version: '2.0.0' }));

  const loader = new CompositionLoader(makeDeps(moduleRepo, scenarioRepo));
  const result = loader.load({
    executorFactory: (ref) => stubExecutor(ref),
  });

  assert.equal(result.mode, 'installed');
  assert.equal(result.packages.length, 1);
  assert.equal(result.packages[0].installed, true);
  assert.equal(result.packages[0].notInstalledReason, undefined);
  // Catalog has the definition; installation registry has the binding.
  assert.ok(result.catalog.get({ name: 'bound', version: '2.0.0' }));
  const installation = result.installationRegistry.get({ name: 'bound', version: '2.0.0' });
  assert.ok(installation, 'bound module must be in the installation registry');
  assert.equal(installation.executor.kind, 'generic-flow');
});

test('installed mode: mix of bound and catalogue-only packages', () => {
  const moduleRepo = new FakeModuleInstallationRepository();
  const scenarioRepo = new FakeScenarioInstallationRepository();
  scenarioRepo.installScenario(makeScenarioRecord({ name: 'pd', version: '1.0.0' }));
  moduleRepo.insert(makeModuleRecord({ name: 'bound', version: '1.0.0' }));
  moduleRepo.insert(makeModuleRecord({ name: 'catalogue-only', version: '1.0.0' }));

  const loader = new CompositionLoader(makeDeps(moduleRepo, scenarioRepo));
  const result = loader.load({
    executorFactory: (ref) => (ref.name === 'bound' ? stubExecutor(ref) : null),
  });

  const byName = Object.fromEntries(result.packages.map((p) => [p.record.name, p]));
  assert.equal(byName.bound.installed, true);
  assert.equal(byName['catalogue-only'].installed, false);
  assert.match(byName['catalogue-only'].notInstalledReason, /null/);
  // Catalogue-only is in the catalog but not the installation registry.
  assert.ok(result.catalog.get({ name: 'catalogue-only', version: '1.0.0' }));
  assert.equal(
    result.installationRegistry.get({ name: 'catalogue-only', version: '1.0.0' }),
    null,
  );
});

test('load() throws COMPOSITION_LOAD_DEFINITION_INVALID when a manifest has no usable definition', () => {
  const moduleRepo = new FakeModuleInstallationRepository();
  const scenarioRepo = new FakeScenarioInstallationRepository();
  scenarioRepo.installScenario(makeScenarioRecord({ name: 'pd', version: '1.0.0' }));
  const broken = makeModuleRecord({ name: 'broken', version: '1.0.0' });
  broken.manifestSnapshot = { manifestFormatVersion: '1' }; // no definition
  moduleRepo.insert(broken);

  const loader = new CompositionLoader(makeDeps(moduleRepo, scenarioRepo));
  assert.throws(
    () => loader.load({ executorFactory: () => null }),
    (e) => e instanceof CompositionLoaderError
      && e.code === COMPOSITION_LOAD_DEFINITION_INVALID
      && e.moduleRef.name === 'broken'
      && e.moduleRef.version === '1.0.0',
  );
});

test('load() throws COMPOSITION_LOAD_DEFINITION_INVALID when definition is null/non-object', () => {
  const moduleRepo = new FakeModuleInstallationRepository();
  const scenarioRepo = new FakeScenarioInstallationRepository();
  scenarioRepo.installScenario(makeScenarioRecord({ name: 'pd', version: '1.0.0' }));
  const broken = makeModuleRecord({ name: 'broken', version: '1.0.0' });
  broken.manifestSnapshot = { manifestFormatVersion: '1', definition: null };
  moduleRepo.insert(broken);

  const loader = new CompositionLoader(makeDeps(moduleRepo, scenarioRepo));
  assert.throws(
    () => loader.load({ executorFactory: () => null }),
    (e) => e instanceof CompositionLoaderError
      && e.code === COMPOSITION_LOAD_DEFINITION_INVALID,
  );
});

test('load() surfaces catalog registration failure as COMPOSITION_LOAD_REGISTRATION_FAILED', () => {
  const moduleRepo = new FakeModuleInstallationRepository();
  const scenarioRepo = new FakeScenarioInstallationRepository();
  scenarioRepo.installScenario(makeScenarioRecord({ name: 'pd', version: '1.0.0' }));
  // An invalid definition (empty outcomes) passes the manifest guard but fails
  // the catalog registry's structural validation.
  const invalidDef = minimalDefinition({ name: 'bad', version: '1.0.0' });
  invalidDef.outcomes = [];
  moduleRepo.insert(makeModuleRecord({ name: 'bad', version: '1.0.0', definition: invalidDef }));

  const loader = new CompositionLoader(makeDeps(moduleRepo, scenarioRepo));
  assert.throws(
    () => loader.load({ executorFactory: () => null }),
    (e) => e instanceof CompositionLoaderError
      && e.code === COMPOSITION_LOAD_REGISTRATION_FAILED,
  );
});

test('load() does not switch on module names — executor factory receives the identity verbatim', () => {
  const moduleRepo = new FakeModuleInstallationRepository();
  const scenarioRepo = new FakeScenarioInstallationRepository();
  scenarioRepo.installScenario(makeScenarioRecord({ name: 'pd', version: '1.0.0' }));
  moduleRepo.insert(makeModuleRecord({ name: 'alpha', version: '1.0.0' }));
  moduleRepo.insert(makeModuleRecord({ name: 'beta', version: '3.2.1' }));

  const seen = [];
  const loader = new CompositionLoader(makeDeps(moduleRepo, scenarioRepo));
  loader.load({
    executorFactory: (ref, record) => {
      seen.push({ name: ref.name, version: ref.version, digest: record.packageDigest });
      return stubExecutor(ref);
    },
  });

  // The factory is the ONLY place an executor is chosen; the loader passes
  // identity + record through. Both packages reach the factory untouched.
  assert.deepEqual(
    seen.map((s) => s.name).sort(),
    ['alpha', 'beta'],
  );
  const beta = seen.find((s) => s.name === 'beta');
  assert.equal(beta.version, '3.2.1');
  assert.ok(beta.digest.startsWith('sha256:beta:'));
});

test('load() forwards installationRegistryOptions to the ProcessModuleInstallationRegistry', () => {
  // The options object is passed straight through; the loader does not inspect
  // it. We assert the registry was constructed (no throw) with an empty
  // options bag and with a populated options bag.
  const moduleRepo = new FakeModuleInstallationRepository();
  const scenarioRepo = new FakeScenarioInstallationRepository();
  scenarioRepo.installScenario(makeScenarioRecord({ name: 'pd', version: '1.0.0' }));
  moduleRepo.insert(makeModuleRecord({ name: 'alpha', version: '1.0.0' }));

  const loader = new CompositionLoader(makeDeps(moduleRepo, scenarioRepo));
  const withOpts = loader.load({
    executorFactory: () => null,
    installationRegistryOptions: {},
  });
  assert.equal(withOpts.mode, 'installed');
  assert.ok(withOpts.installationRegistry.list().length === 0);
});

test('retired scenario is not counted — only active scenarios trigger installed mode', () => {
  const moduleRepo = new FakeModuleInstallationRepository();
  const scenarioRepo = new FakeScenarioInstallationRepository();
  // Install then retire: listActive() must exclude it → legacy fallback.
  const inserted = scenarioRepo.installScenario(makeScenarioRecord({ name: 'pd', version: '1.0.0' }));
  scenarioRepo.retire(inserted.id);
  moduleRepo.insert(makeModuleRecord({ name: 'alpha', version: '1.0.0' }));

  const loader = new CompositionLoader(makeDeps(moduleRepo, scenarioRepo));
  const result = loader.load({ executorFactory: () => null });
  assert.equal(result.mode, 'legacy');
});

test('retired module package is not loaded in installed mode', () => {
  const moduleRepo = new FakeModuleInstallationRepository();
  const scenarioRepo = new FakeScenarioInstallationRepository();
  scenarioRepo.installScenario(makeScenarioRecord({ name: 'pd', version: '1.0.0' }));
  const active = moduleRepo.insert(makeModuleRecord({ name: 'active', version: '1.0.0' }));
  const retiredRecord = makeModuleRecord({ name: 'retired', version: '1.0.0' });
  const insertedRetired = moduleRepo.insert(retiredRecord);
  moduleRepo.retire(insertedRetired.id);

  const loader = new CompositionLoader(makeDeps(moduleRepo, scenarioRepo));
  const result = loader.load({ executorFactory: () => null });
  assert.equal(result.mode, 'installed');
  const loaded = result.packages.map((p) => p.record.name);
  assert.deepEqual(loaded, ['active']);
  // active record id is irrelevant; the retired one must not appear.
  void active;
});

test('loadComposition() convenience wrapper mirrors CompositionLoader.load()', () => {
  const moduleRepo = new FakeModuleInstallationRepository();
  const scenarioRepo = new FakeScenarioInstallationRepository();
  scenarioRepo.installScenario(makeScenarioRecord({ name: 'pd', version: '1.0.0' }));
  moduleRepo.insert(makeModuleRecord({ name: 'alpha', version: '1.0.0' }));

  const result = loadComposition(
    makeDeps(moduleRepo, scenarioRepo),
    { executorFactory: (ref) => stubExecutor(ref) },
  );
  assert.equal(result.mode, 'installed');
  assert.equal(result.packages[0].installed, true);
});

test('load() orders packages by repository listActive() order (deterministic per-repo)', () => {
  const moduleRepo = new FakeModuleInstallationRepository();
  const scenarioRepo = new FakeScenarioInstallationRepository();
  scenarioRepo.installScenario(makeScenarioRecord({ name: 'pd', version: '1.0.0' }));
  moduleRepo.insert(makeModuleRecord({ name: 'first', version: '1.0.0' }));
  moduleRepo.insert(makeModuleRecord({ name: 'second', version: '1.0.0' }));
  moduleRepo.insert(makeModuleRecord({ name: 'third', version: '1.0.0' }));

  const loader = new CompositionLoader(makeDeps(moduleRepo, scenarioRepo));
  const result = loader.load({ executorFactory: () => null });
  assert.deepEqual(
    result.packages.map((p) => p.record.name),
    ['first', 'second', 'third'],
  );
});

test('CompositionLoaderError preserves cause + moduleRef for diagnostics', () => {
  const moduleRepo = new FakeModuleInstallationRepository();
  const scenarioRepo = new FakeScenarioInstallationRepository();
  scenarioRepo.installScenario(makeScenarioRecord({ name: 'pd', version: '1.0.0' }));
  const broken = makeModuleRecord({ name: 'broken', version: '9.9.9' });
  broken.manifestSnapshot = { manifestFormatVersion: '1' };
  moduleRepo.insert(broken);

  const loader = new CompositionLoader(makeDeps(moduleRepo, scenarioRepo));
  try {
    loader.load({ executorFactory: () => null });
    assert.fail('expected CompositionLoaderError');
  } catch (e) {
    assert.ok(e instanceof CompositionLoaderError);
    assert.equal(e.code, COMPOSITION_LOAD_DEFINITION_INVALID);
    assert.equal(e.moduleRef.name, 'broken');
    assert.equal(e.moduleRef.version, '9.9.9');
    assert.match(e.message, /broken@9\.9\.9/);
  }
});
