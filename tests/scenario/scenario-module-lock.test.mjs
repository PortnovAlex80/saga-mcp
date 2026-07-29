// tests/scenario/scenario-module-lock.test.mjs
//
// W7-A2 — ScenarioModuleLock: exact module-lock resolution.
//
// Spec: docs/refactor-management/09-contracts/WAVE7-SCENARIO-SPEC.md
//       §0, §1 row W7-A2.
// Plan: §6.6-6.7 (scenario installation resolves module selectors to exact
//       InstalledProcessModule + writes scenario module lock; LifecycleRun pins
//       both at start).
// Task: docs/refactor-management/05-subagent-tasks/W07-a2.md.
//
// In-memory fakes are used for PackageRegistry (Wave 2 port) and the
// ScenarioInstallationStore (W7-A1 port, absent in this isolated worktree — the
// task file explicitly allows "fake + note"). The fakes faithfully mirror the
// frozen port surfaces so the lock resolver's trust assumptions are exercised.
//
// Coverage:
//   - Positive: single-stage scenario resolves to exact installed identity.
//   - Multi-stage: every stage pinned; pins sorted by stageId.
//   - Module reuse: two stages selecting the SAME module package resolve to the
//     SAME installation id (single scenario reuses a module — plan §6.8).
//   - Range resolution: a caret/tilde/wildcard selector resolves to ONE exact
//     version (the registry's pick); the pin records the EXACT version, not the
//     range.
//   - lockDigest is stable + content-addressed: same inputs → same digest;
//     any drift in any pin field changes the digest.
//   - Idempotent replay: writeScenarioModuleLock with the same inputs produces
//     the same lockDigest; the store sees the same digest.
//   - Negative: unresolvable selector → SCENARIO_MODULE_NOT_INSTALLED, carries
//     stageId + selector.
//   - Negative: empty stages → SCENARIO_HAS_NO_STAGES.
//   - Negative: duplicate stageId → SCENARIO_DUPLICATE_STAGE_ID.
//   - Negative: invalid scenarioInstallationId.
//   - verifyScenarioModuleLock: self-consistent lock verifies true; tampered
//     lock verifies false.
//   - StageRun/LifecycleRun projections: projectStageRunPin / projectLifecycleRunPin
//     produce the exact pin fields the runner writes.
//   - Determinism: stage bindings supplied in DIFFERENT orders produce the SAME
//     lockDigest (sort-by-stageId canonicalization).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCENARIO_MODULE_NOT_INSTALLED,
  SCENARIO_HAS_NO_STAGES,
  SCENARIO_DUPLICATE_STAGE_ID,
  ScenarioModuleNotInstalledError,
  resolveScenarioModuleLock,
  writeScenarioModuleLock,
  readScenarioModuleLock,
  verifyScenarioModuleLock,
  projectStageRunPin,
  projectLifecycleRunPin,
  getPinForStage,
} from '../../dist/process-modules/application/scenario-module-lock.js';
import { canonicalJson, sha256Hex } from '../../dist/process-modules/shared/canonical-json.js';

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

/**
 * In-memory PackageRegistry fake. Mirrors the Wave 2 port surface
 * (WAVE2-IMMUTABLE-INSTALLATION-SPEC §1 row 9): select() resolves a
 * ModuleSelector to a ModuleInstallationRecord, throwing on no match. The fake
 * stores records by exact `(name, version)` and resolves ranges with a tiny
 * inline matcher (same four-shape syntax the real registry supports).
 */
class FakePackageRegistry {
  constructor() {
    this._byExact = new Map(); // `${name}@${version}` -> record
  }

  register(record) {
    this._byExact.set(`${record.name}@${record.version}`, record);
  }

  select(selector) {
    const rec = this._selectOrNull(selector);
    if (!rec) {
      const err = new Error(
        `PACKAGE_NOT_INSTALLED: no active installation matches ` +
          `name=${JSON.stringify(selector.name)} ` +
          `versionRange=${JSON.stringify(selector.versionRange)}`,
      );
      err.code = 'PACKAGE_NOT_INSTALLED';
      err.selector = selector;
      throw err;
    }
    return rec;
  }

  has(selector) {
    return this._selectOrNull(selector) !== null;
  }

  _selectOrNull(selector) {
    const candidates = [];
    for (const rec of this._byExact.values()) {
      if (rec.name !== selector.name) continue;
      if (satisfiesRange(rec.version, selector.versionRange)) {
        candidates.push(rec);
      }
    }
    if (candidates.length === 0) return null;
    // Highest semver wins (deterministic).
    candidates.sort(compareSemverDesc);
    return candidates[0];
  }
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function compareSemverDesc(a, b) {
  const pa = parseSemver(a.version);
  const pb = parseSemver(b.version);
  if (!pa || !pb) return 0;
  if (pa[0] !== pb[0]) return pb[0] - pa[0];
  if (pa[1] !== pb[1]) return pb[1] - pa[1];
  return pb[2] - pa[2];
}
function satisfiesRange(version, range) {
  const v = parseSemver(version);
  if (!v) return false;
  const r = String(range).trim();
  if (r === '' || r === '*') return true;
  if (r.startsWith('^')) {
    const base = parseSemver(r.slice(1));
    if (!base) return false;
    if (cmp(v, base) < 0) return false;
    if (base[0] > 0) return v[0] === base[0];
    if (base[1] > 0) return v[0] === 0 && v[1] === base[1];
    return v[0] === 0 && v[1] === 0 && v[2] === base[2];
  }
  if (r.startsWith('~')) {
    const base = parseSemver(r.slice(1));
    if (!base) return false;
    if (cmp(v, base) < 0) return false;
    return v[0] === base[0] && v[1] === base[1];
  }
  const exact = parseSemver(r);
  return exact !== null && cmp(v, exact) === 0;
}
function cmp(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

/**
 * In-memory ScenarioInstallationStore fake. Mirrors the W7-A1 port: writes are
 * keyed by scenarioInstallationId and replay-safe on same-digest (returns the
 * existing row). A different digest for the same scenario installation is
 * rejected (lock immutability — plan §6.6).
 */
class FakeScenarioInstallationStore {
  constructor() {
    this._rows = new Map(); // scenarioInstallationId -> record
    this.writeCount = 0;
  }

  writeModuleLock({ scenarioInstallationId, lockDocument, lockDigest, pinnedAt }) {
    const existing = this._rows.get(scenarioInstallationId);
    if (existing) {
      if (existing.lockDigest !== lockDigest) {
        const err = new Error(
          `SCENARIO_MODULE_LOCK_IMMUTABLE: scenario installation ` +
            `${scenarioInstallationId} already pinned with digest ` +
            `'${existing.lockDigest}' (received '${lockDigest}')`,
        );
        err.code = 'SCENARIO_MODULE_LOCK_IMMUTABLE';
        throw err;
      }
      // Idempotent replay: return existing row, do not bump writeCount.
      return existing;
    }
    this.writeCount += 1;
    const row = {
      scenarioInstallationId,
      lockDocument,
      lockDigest,
      pinnedAt,
    };
    this._rows.set(scenarioInstallationId, row);
    return row;
  }

  readModuleLock(scenarioInstallationId) {
    return this._rows.get(scenarioInstallationId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Fixture factories.
// ---------------------------------------------------------------------------

let _digestCounter = 0;
function makeInstallationRecord({ name, version, packageDigest }) {
  _digestCounter += 1;
  const digest =
    packageDigest ??
    `sha256:${name}:${version}:${_digestCounter}`.padEnd(64, '0').slice(0, 64);
  const manifestSnapshot = {
    manifestFormatVersion: '0.1.0',
    definition: { name, version },
    resourceIndex: [],
    handlerRefs: [],
    inputContractRef: { schemaId: `${name}.input`, version: '1.0.0', digest: '0'.repeat(64) },
    outputContractRef: { schemaId: `${name}.output`, version: '1.0.0', digest: '0'.repeat(64) },
    runtimeCompatibilityRange: '*',
  };
  return {
    id: _digestCounter, // branded number is a plain number at runtime
    name,
    version,
    packageDigest: digest,
    manifestSnapshot,
    storeLocation: `<root>/${name}/${version}`,
    resourceIndex: [],
    handlerRefs: [],
    dependencyLock: {},
    status: 'active',
    installedAt: '2026-07-28T00:00:00.000Z',
    activatedAt: '2026-07-28T00:00:00.000Z',
  };
}

/** Minimal ScenarioStageBinding-shaped object (carries id + moduleSelector). */
function makeStageBinding(stageId, selector, extra = {}) {
  return {
    id: stageId,
    displayName: stageId,
    moduleRef: { name: selector.name, version: '1.0.0' },
    moduleSelector: selector,
    inputMapping: {},
    outputMapping: {},
    outcomeRoutes: {},
    entryConditions: [],
    exitConditions: [],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tests: positive resolution.
// ---------------------------------------------------------------------------

test('single-stage scenario resolves to the exact installed identity', () => {
  const reg = new FakePackageRegistry();
  const rec = makeInstallationRecord({ name: 'alpha', version: '1.2.3' });
  reg.register(rec);

  const stages = [makeStageBinding('s1', { name: 'alpha', versionRange: '^1.0.0' })];
  const lock = resolveScenarioModuleLock(stages, reg);

  assert.equal(lock.pins.length, 1);
  const pin = lock.pins[0];
  assert.equal(pin.stageId, 's1');
  assert.equal(pin.installationId, rec.id);
  assert.equal(pin.moduleName, 'alpha');
  assert.equal(pin.resolvedVersion, '1.2.3');
  assert.equal(pin.packageDigest, rec.packageDigest);
  // selector carried verbatim
  assert.deepEqual(pin.selector, { name: 'alpha', versionRange: '^1.0.0' });
  // manifestDigest is sha256 of canonical manifestSnapshot
  assert.equal(pin.manifestDigest, sha256Hex(canonicalJson(rec.manifestSnapshot)));
});

test('multi-stage scenario pins every stage', () => {
  const reg = new FakePackageRegistry();
  const a = makeInstallationRecord({ name: 'alpha', version: '1.0.0' });
  const b = makeInstallationRecord({ name: 'beta', version: '2.0.0' });
  const c = makeInstallationRecord({ name: 'gamma', version: '3.0.0' });
  reg.register(a);
  reg.register(b);
  reg.register(c);

  const stages = [
    makeStageBinding('s3', { name: 'gamma', versionRange: '*' }),
    makeStageBinding('s1', { name: 'alpha', versionRange: '1.0.0' }),
    makeStageBinding('s2', { name: 'beta', versionRange: '^2.0.0' }),
  ];
  const lock = resolveScenarioModuleLock(stages, reg);

  // Pins are sorted by stageId regardless of input order.
  assert.deepEqual(
    lock.pins.map((p) => p.stageId),
    ['s1', 's2', 's3'],
  );
  assert.equal(lock.pins[0].moduleName, 'alpha');
  assert.equal(lock.pins[1].moduleName, 'beta');
  assert.equal(lock.pins[2].moduleName, 'gamma');
});

test('module reuse: two stages selecting the same package pin the same installation id', () => {
  const reg = new FakePackageRegistry();
  const shared = makeInstallationRecord({ name: 'shared', version: '1.4.0' });
  reg.register(shared);

  const stages = [
    makeStageBinding('first', { name: 'shared', versionRange: '^1.0.0' }),
    makeStageBinding('second', { name: 'shared', versionRange: '^1.0.0' }),
  ];
  const lock = resolveScenarioModuleLock(stages, reg);

  assert.equal(lock.pins.length, 2);
  // Both stages resolved to the SAME installation — a single scenario reuses a
  // module package (plan §6.8).
  assert.equal(lock.pins[0].installationId, lock.pins[1].installationId);
  assert.equal(lock.pins[0].installationId, shared.id);
  assert.equal(lock.pins[0].resolvedVersion, lock.pins[1].resolvedVersion);
});

test('range selector resolves to ONE exact version (pin records exact, not range)', () => {
  const reg = new FakePackageRegistry();
  // Multiple active versions of the same module — registry picks the highest.
  reg.register(makeInstallationRecord({ name: 'multi', version: '1.0.0' }));
  reg.register(makeInstallationRecord({ name: 'multi', version: '1.5.0' }));
  reg.register(makeInstallationRecord({ name: 'multi', version: '1.9.0' }));

  const stages = [makeStageBinding('s1', { name: 'multi', versionRange: '^1.0.0' })];
  const lock = resolveScenarioModuleLock(stages, reg);

  // The selector is a RANGE; the pin records the EXACT resolved version.
  assert.equal(lock.pins[0].selector.versionRange, '^1.0.0');
  assert.equal(lock.pins[0].resolvedVersion, '1.9.0');
});

test('wildcard `*` selector resolves to the highest installed version', () => {
  const reg = new FakePackageRegistry();
  reg.register(makeInstallationRecord({ name: 'wild', version: '2.0.0' }));
  reg.register(makeInstallationRecord({ name: 'wild', version: '2.4.1' }));

  const lock = resolveScenarioModuleLock(
    [makeStageBinding('s1', { name: 'wild', versionRange: '*' })],
    reg,
  );
  assert.equal(lock.pins[0].resolvedVersion, '2.4.1');
});

// ---------------------------------------------------------------------------
// Tests: lockDigest stability + content addressing.
// ---------------------------------------------------------------------------

test('lockDigest is stable: same inputs produce the same digest', () => {
  // Replaying the SAME registry (same installed rows, same DB-assigned ids)
  // produces the same lock digest. This is the replay-safety guarantee: a
  // scenario re-installed against an unchanged package set re-derives an
  // identical lock.
  const reg = new FakePackageRegistry();
  reg.register(
    makeInstallationRecord({ name: 'x', version: '1.0.0', packageDigest: '1'.repeat(64) }),
  );
  reg.register(
    makeInstallationRecord({ name: 'y', version: '1.0.0', packageDigest: '2'.repeat(64) }),
  );

  const stages = [
    makeStageBinding('a', { name: 'x', versionRange: '*' }),
    makeStageBinding('b', { name: 'y', versionRange: '*' }),
  ];

  const lock1 = resolveScenarioModuleLock(stages, reg);
  const lock2 = resolveScenarioModuleLock(stages, reg);
  assert.equal(lock1.lockDigest, lock2.lockDigest);
  assert.ok(lock1.lockDigest.length === 64, 'sha256 hex digest');
});

test('lockDigest is independent of input stage order (canonical sort)', () => {
  const reg = new FakePackageRegistry();
  reg.register(makeInstallationRecord({ name: 'x', version: '1.0.0' }));
  reg.register(makeInstallationRecord({ name: 'y', version: '1.0.0' }));
  reg.register(makeInstallationRecord({ name: 'z', version: '1.0.0' }));

  const forward = resolveScenarioModuleLock(
    [
      makeStageBinding('a', { name: 'x', versionRange: '*' }),
      makeStageBinding('b', { name: 'y', versionRange: '*' }),
      makeStageBinding('c', { name: 'z', versionRange: '*' }),
    ],
    reg,
  );
  const reverse = resolveScenarioModuleLock(
    [
      makeStageBinding('c', { name: 'z', versionRange: '*' }),
      makeStageBinding('b', { name: 'y', versionRange: '*' }),
      makeStageBinding('a', { name: 'x', versionRange: '*' }),
    ],
    reg,
  );
  assert.equal(forward.lockDigest, reverse.lockDigest);
});

test('lockDigest changes when the resolved version drifts', () => {
  // Same scenario, but the active installation is upgraded between resolves.
  const reg = new FakePackageRegistry();
  reg.register(makeInstallationRecord({ name: 'drift', version: '1.0.0' }));
  const stages = [makeStageBinding('s1', { name: 'drift', versionRange: '*' })];

  const lockV1 = resolveScenarioModuleLock(stages, reg);

  // Upgrade: retire old, register new higher version.
  const reg2 = new FakePackageRegistry();
  reg2.register(makeInstallationRecord({ name: 'drift', version: '1.0.0' }));
  reg2.register(makeInstallationRecord({ name: 'drift', version: '2.0.0' }));
  const lockV2 = resolveScenarioModuleLock(stages, reg2);

  assert.notEqual(lockV1.lockDigest, lockV2.lockDigest);
  assert.equal(lockV1.pins[0].resolvedVersion, '1.0.0');
  assert.equal(lockV2.pins[0].resolvedVersion, '2.0.0');
});

test('lockDigest changes when the package digest of the resolved record drifts', () => {
  // Two registries, same name+version but DIFFERENT package digests (e.g. a
  // re-pack). The pin's packageDigest field differs, so the lock digest differs.
  const reg1 = new FakePackageRegistry();
  reg1.register(
    makeInstallationRecord({ name: 'p', version: '1.0.0', packageDigest: 'a'.repeat(64) }),
  );
  const reg2 = new FakePackageRegistry();
  reg2.register(
    makeInstallationRecord({ name: 'p', version: '1.0.0', packageDigest: 'b'.repeat(64) }),
  );

  const stages = [makeStageBinding('s1', { name: 'p', versionRange: '1.0.0' })];
  const l1 = resolveScenarioModuleLock(stages, reg1);
  const l2 = resolveScenarioModuleLock(stages, reg2);
  assert.notEqual(l1.lockDigest, l2.lockDigest);
});

// ---------------------------------------------------------------------------
// Tests: writeScenarioModuleLock + readScenarioModuleLock (persistence).
// ---------------------------------------------------------------------------

test('writeScenarioModuleLock resolves + persists via the store', () => {
  const reg = new FakePackageRegistry();
  const rec = makeInstallationRecord({ name: 'alpha', version: '1.0.0' });
  reg.register(rec);
  const store = new FakeScenarioInstallationStore();

  const record = writeScenarioModuleLock(
    42,
    [makeStageBinding('s1', { name: 'alpha', versionRange: '*' })],
    reg,
    store,
    '2026-07-29T00:00:00.000Z',
  );

  assert.equal(record.scenarioInstallationId, 42);
  assert.equal(record.pinnedAt, '2026-07-29T00:00:00.000Z');
  assert.equal(store.writeCount, 1);
  // lockDigest on the row matches the lock document's digest.
  assert.equal(record.lockDigest, record.lockDocument.lockDigest);
});

test('writeScenarioModuleLock is idempotent on same inputs (replay safety)', () => {
  const reg = new FakePackageRegistry();
  reg.register(makeInstallationRecord({ name: 'alpha', version: '1.0.0' }));
  const store = new FakeScenarioInstallationStore();

  const stages = [makeStageBinding('s1', { name: 'alpha', versionRange: '*' })];
  const r1 = writeScenarioModuleLock(7, stages, reg, store);
  const r2 = writeScenarioModuleLock(7, stages, reg, store);

  // Same digest → store treats as replay; writeCount stays at 1.
  assert.equal(r1.lockDigest, r2.lockDigest);
  assert.equal(store.writeCount, 1);
});

test('readScenarioModuleLock returns the persisted lock (LifecycleRun start path)', () => {
  const reg = new FakePackageRegistry();
  reg.register(makeInstallationRecord({ name: 'alpha', version: '1.0.0' }));
  const store = new FakeScenarioInstallationStore();

  writeScenarioModuleLock(
    99,
    [makeStageBinding('s1', { name: 'alpha', versionRange: '*' })],
    reg,
    store,
  );

  const read = readScenarioModuleLock(99, store);
  assert.ok(read !== null);
  assert.equal(read.scenarioInstallationId, 99);
  assert.equal(read.lockDocument.pins.length, 1);
});

test('readScenarioModuleLock returns null for an unknown scenario installation', () => {
  const store = new FakeScenarioInstallationStore();
  assert.equal(readScenarioModuleLock(404, store), null);
});

test('writeScenarioModuleLock rejects an invalid scenarioInstallationId', () => {
  const reg = new FakePackageRegistry();
  const store = new FakeScenarioInstallationStore();
  assert.throws(
    () =>
      writeScenarioModuleLock(
        0,
        [makeStageBinding('s1', { name: 'x', versionRange: '*' })],
        reg,
        store,
      ),
    (err) => /SCENARIO_MODULE_LOCK_INVALID_ID/.test(err.message),
  );
  assert.throws(
    () =>
      writeScenarioModuleLock(
        -1,
        [makeStageBinding('s1', { name: 'x', versionRange: '*' })],
        reg,
        store,
      ),
    (err) => /SCENARIO_MODULE_LOCK_INVALID_ID/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Tests: negatives.
// ---------------------------------------------------------------------------

test('unresolvable selector throws ScenarioModuleNotInstalledError carrying stageId + selector', () => {
  const reg = new FakePackageRegistry();
  // Nothing registered for 'missing'.
  const stages = [makeStageBinding('stage-X', { name: 'missing', versionRange: '*' })];

  assert.throws(
    () => resolveScenarioModuleLock(stages, reg),
    (err) => {
      assert.ok(err instanceof ScenarioModuleNotInstalledError);
      assert.equal(err.code, SCENARIO_MODULE_NOT_INSTALLED);
      assert.equal(err.stageId, 'stage-X');
      assert.deepEqual(err.selector, { name: 'missing', versionRange: '*' });
      assert.match(err.message, /SCENARIO_MODULE_NOT_INSTALLED/);
      assert.match(err.message, /"stage-X"/);
      return true;
    },
  );
});

test('unresolvable selector in a MULTI-stage scenario aborts the whole lock', () => {
  const reg = new FakePackageRegistry();
  reg.register(makeInstallationRecord({ name: 'present', version: '1.0.0' }));
  const stages = [
    makeStageBinding('s1', { name: 'present', versionRange: '*' }),
    makeStageBinding('s2', { name: 'absent', versionRange: '*' }),
  ];
  assert.throws(
    () => resolveScenarioModuleLock(stages, reg),
    (err) => err instanceof ScenarioModuleNotInstalledError && err.stageId === 's2',
  );
});

test('empty stageBindings throws SCENARIO_HAS_NO_STAGES', () => {
  const reg = new FakePackageRegistry();
  assert.throws(
    () => resolveScenarioModuleLock([], reg),
    (err) => err.message.includes(SCENARIO_HAS_NO_STAGES),
  );
});

test('duplicate stageId throws SCENARIO_DUPLICATE_STAGE_ID', () => {
  const reg = new FakePackageRegistry();
  reg.register(makeInstallationRecord({ name: 'x', version: '1.0.0' }));
  const stages = [
    makeStageBinding('dup', { name: 'x', versionRange: '*' }),
    makeStageBinding('dup', { name: 'x', versionRange: '*' }),
  ];
  assert.throws(
    () => resolveScenarioModuleLock(stages, reg),
    (err) => err.message.includes(SCENARIO_DUPLICATE_STAGE_ID),
  );
});

test('ScenarioModuleNotInstalledError preserves the registry cause', () => {
  const reg = new FakePackageRegistry();
  const err = new ScenarioModuleNotInstalledError(
    's1',
    { name: 'missing', versionRange: '*' },
    new Error('PACKAGE_NOT_INSTALLED: underlying'),
  );
  assert.ok(err.cause instanceof Error);
  assert.match(err.cause.message, /PACKAGE_NOT_INSTALLED/);
});

test('ScenarioModuleNotInstalledError is a real Error subclass', () => {
  const e = new ScenarioModuleNotInstalledError('s1', { name: 'n', versionRange: '*' });
  assert.ok(e instanceof Error);
  assert.ok(e instanceof ScenarioModuleNotInstalledError);
  assert.equal(e.name, 'ScenarioModuleNotInstalledError');
  assert.equal(e.code, SCENARIO_MODULE_NOT_INSTALLED);
});

// ---------------------------------------------------------------------------
// Tests: verifyScenarioModuleLock (replay verification).
// ---------------------------------------------------------------------------

test('verifyScenarioModuleLock returns true for a self-consistent lock', () => {
  const reg = new FakePackageRegistry();
  reg.register(makeInstallationRecord({ name: 'x', version: '1.0.0' }));
  reg.register(makeInstallationRecord({ name: 'y', version: '1.0.0' }));
  const lock = resolveScenarioModuleLock(
    [
      makeStageBinding('a', { name: 'x', versionRange: '*' }),
      makeStageBinding('b', { name: 'y', versionRange: '*' }),
    ],
    reg,
  );
  assert.equal(verifyScenarioModuleLock(lock), true);
});

test('verifyScenarioModuleLock returns false for a tampered digest', () => {
  const reg = new FakePackageRegistry();
  reg.register(makeInstallationRecord({ name: 'x', version: '1.0.0' }));
  const lock = resolveScenarioModuleLock(
    [makeStageBinding('a', { name: 'x', versionRange: '*' })],
    reg,
  );
  // Tamper with the digest.
  const tampered = { ...lock, lockDigest: '0'.repeat(64) };
  assert.equal(verifyScenarioModuleLock(tampered), false);
});

test('verifyScenarioModuleLock returns false when a pin field is mutated after hashing', () => {
  const reg = new FakePackageRegistry();
  reg.register(makeInstallationRecord({ name: 'x', version: '1.0.0' }));
  const lock = resolveScenarioModuleLock(
    [makeStageBinding('a', { name: 'x', versionRange: '*' })],
    reg,
  );
  // Mutate a pin's resolvedVersion after the fact — pins array is frozen at
  // construction in resolveScenarioModuleLock, so this simulates a corrupted
  // read by building a fresh (un-frozen) lock object.
  const corruptedPin = { ...lock.pins[0], resolvedVersion: '9.9.9' };
  const corrupted = {
    pins: [corruptedPin],
    lockDigest: lock.lockDigest,
  };
  assert.equal(verifyScenarioModuleLock(corrupted), false);
});

// ---------------------------------------------------------------------------
// Tests: StageRun / LifecycleRun pin projections.
// ---------------------------------------------------------------------------

test('projectStageRunPin returns the exact pin fields for a stage', () => {
  const reg = new FakePackageRegistry();
  const rec = makeInstallationRecord({ name: 'alpha', version: '1.2.3' });
  reg.register(rec);
  const lock = resolveScenarioModuleLock(
    [makeStageBinding('s1', { name: 'alpha', versionRange: '^1.0.0' })],
    reg,
  );

  const pin = projectStageRunPin(lock, 's1');
  assert.deepEqual(pin, {
    stageId: 's1',
    installationId: rec.id,
    resolvedVersion: '1.2.3',
    packageDigest: rec.packageDigest,
  });
});

test('projectStageRunPin returns null for an unknown stage', () => {
  const reg = new FakePackageRegistry();
  reg.register(makeInstallationRecord({ name: 'alpha', version: '1.0.0' }));
  const lock = resolveScenarioModuleLock(
    [makeStageBinding('s1', { name: 'alpha', versionRange: '*' })],
    reg,
  );
  assert.equal(projectStageRunPin(lock, 'nope'), null);
});

test('projectLifecycleRunPin returns lockDigest + every stage pin', () => {
  const reg = new FakePackageRegistry();
  const a = makeInstallationRecord({ name: 'alpha', version: '1.0.0' });
  const b = makeInstallationRecord({ name: 'beta', version: '2.0.0' });
  reg.register(a);
  reg.register(b);
  const lock = resolveScenarioModuleLock(
    [
      makeStageBinding('s1', { name: 'alpha', versionRange: '*' }),
      makeStageBinding('s2', { name: 'beta', versionRange: '*' }),
    ],
    reg,
  );

  const runPin = projectLifecycleRunPin(lock);
  assert.equal(runPin.lockDigest, lock.lockDigest);
  assert.equal(runPin.stagePins.length, 2);
  assert.deepEqual(
    runPin.stagePins.map((p) => p.stageId),
    ['s1', 's2'],
  );
  // Each stage pin carries exactly the StageRun fields (no selector/manifestDigest).
  for (const sp of runPin.stagePins) {
    assert.ok(typeof sp.stageId === 'string');
    assert.ok(typeof sp.installationId === 'number');
    assert.ok(typeof sp.resolvedVersion === 'string');
    assert.ok(typeof sp.packageDigest === 'string');
    assert.equal('selector' in sp, false);
    assert.equal('manifestDigest' in sp, false);
  }
});

test('getPinForStage returns the full pin (with selector) for diagnostics', () => {
  const reg = new FakePackageRegistry();
  reg.register(makeInstallationRecord({ name: 'alpha', version: '1.0.0' }));
  const lock = resolveScenarioModuleLock(
    [makeStageBinding('s1', { name: 'alpha', versionRange: '^1.0.0' })],
    reg,
  );
  const pin = getPinForStage(lock, 's1');
  assert.ok(pin);
  assert.deepEqual(pin.selector, { name: 'alpha', versionRange: '^1.0.0' });
  assert.equal(getPinForStage(lock, 'missing'), undefined);
});

// ---------------------------------------------------------------------------
// Test: end-to-end install → read → verify (the LifecycleRun start path).
// ---------------------------------------------------------------------------

test('end-to-end: write → read → verify detects no drift (happy path)', () => {
  const reg = new FakePackageRegistry();
  reg.register(makeInstallationRecord({ name: 'alpha', version: '1.0.0' }));
  reg.register(makeInstallationRecord({ name: 'beta', version: '2.0.0' }));
  const store = new FakeScenarioInstallationStore();

  writeScenarioModuleLock(
    5,
    [
      makeStageBinding('s1', { name: 'alpha', versionRange: '*' }),
      makeStageBinding('s2', { name: 'beta', versionRange: '*' }),
    ],
    reg,
    store,
  );

  // LifecycleRun start: read the lock back and verify integrity.
  const read = readScenarioModuleLock(5, store);
  assert.ok(read);
  assert.equal(verifyScenarioModuleLock(read.lockDocument), true);

  // Project the run pin — what the LifecycleRun writes on its root row.
  const runPin = projectLifecycleRunPin(read.lockDocument);
  assert.equal(runPin.stagePins.length, 2);
});
