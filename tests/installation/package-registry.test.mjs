// tests/installation/package-registry.test.mjs
//
// W2-A5 — PackageRegistry PORT + InstallationBasedPackageRegistry adapter.
//
// Spec: docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md
//       §1 row 9, §2 (port ← adapter), §4 (identity rules).
// Task: docs/refactor-management/05-subagent-tasks/W02-A5-package-registry.md.
// Plan: §14.4.1 (registry replaces catalog), §14.4.5 (no prefix match / no
//       first-match; multiple matches → highest version deterministically),
//       §3.6 / C011 (NO module-name switching).
//
// In-memory fake `ModuleInstallationRepository` is used (W2-A2 sibling absent
// in this isolated worktree — task file explicitly allows "fake + note").
// The fake enforces the same UNIQUE-on-active `(name, version)` invariant the
// spec freezes for the real sqlite repo, so the registry's trust assumption
// is exercised faithfully.
//
// Coverage:
//   - Positive: register + select by exact version, `^`, `~`, `*`.
//   - Multiple-match determinism: same name, two active versions → highest wins.
//   - Negative: unknown name → PACKAGE_NOT_INSTALLED.
//   - Negative: range matching nothing → PACKAGE_NOT_INSTALLED.
//   - Negative: two active installations with same (name, version) cannot
//     coexist (fake repo enforces UNIQUE — registry trusts).
//   - has() / listSelectors() round-trip.
//   - Semver syntax table (positive + negative for each shape).
//   - Retired installations are NOT selectable (only active).
//   - Determinism: same query always returns same record (no order sensitivity).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PACKAGE_NOT_INSTALLED,
  PackageNotInstalledError,
  InstallationBasedPackageRegistry,
} from '../../dist/process-modules/installation/domain/package-registry.js';

// ---------------------------------------------------------------------------
// In-memory fake ModuleInstallationRepository.
//
// Mirrors the frozen port surface from W2-A2 (WAVE2-IMMUTABLE-INSTALLATION-SPEC
// §1 row 3, §4). Enforces:
//   - UNIQUE on (name, version) WHERE status === 'active'
//     (a second active insert with the same pair throws a sentinel error,
//     matching the sqlite repo's MODULE_INSTALLATION_VERSION_COLLISION).
//   - Only status='active' rows are returned by listActive().
//   - retire()/activate() flip status in-place.
//
// The fake is intentionally minimal — it does not implement markCorrupt beyond
// a status flip, and getById is unused by the registry. It exists only so the
// registry has something to select against.
// ---------------------------------------------------------------------------

const MODULE_INSTALLATION_VERSION_COLLISION = 'MODULE_INSTALLATION_VERSION_COLLISION';
const MODULE_INSTALLATION_NOT_FOUND = 'MODULE_INSTALLATION_NOT_FOUND';

function brandId(n) {
  // Mirror the branded `ModuleInstallationId` type from the domain file.
  // At runtime a branded number IS a plain number — the brand is type-only.
  return n;
}

class FakeModuleInstallationRepository {
  constructor() {
    this._rows = [];
    this._nextId = 1;
  }

  _clone(record) {
    return { ...record };
  }

  insert(record) {
    if (record.status === 'active') {
      const clash = this._rows.find(
        (r) =>
          r.status === 'active' &&
          r.name === record.name &&
          r.version === record.version,
      );
      if (clash !== undefined) {
        // Even an identical-digest re-insert is rejected here to mirror the
        // strict UNIQUE index the real repo creates. (The real repo may
        // choose idempotency for same-digest — documented in W2-A2 — but the
        // registry never relies on it.)
        const err = new Error(
          `${MODULE_INSTALLATION_VERSION_COLLISION}: active (${record.name}, ${record.version}) already installed`,
        );
        err.code = MODULE_INSTALLATION_VERSION_COLLISION;
        throw err;
      }
    }
    const id = brandId(this._nextId++);
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
    const r = this._rows.find(
      (x) => x.status === 'active' && x.name === name && x.version === version,
    );
    return r ? this._clone(r) : null;
  }

  activate(id) {
    const r = this._rows.find((x) => x.id === id);
    if (!r) throw notFound(id);
    // Activating would clash with another active (name, version)?
    const clash = this._rows.find(
      (x) =>
        x !== r &&
        x.status === 'active' &&
        x.name === r.name &&
        x.version === r.version,
    );
    if (clash !== undefined) throw collision(r.name, r.version);
    r.status = 'active';
    r.activatedAt = new Date().toISOString();
    return this._clone(r);
  }

  retire(id) {
    const r = this._rows.find((x) => x.id === id);
    if (!r) throw notFound(id);
    r.status = 'retired';
    r.retiredAt = new Date().toISOString();
    return this._clone(r);
  }

  markCorrupt(id) {
    const r = this._rows.find((x) => x.id === id);
    if (!r) throw notFound(id);
    r.status = 'corrupt';
    return this._clone(r);
  }

  listActive() {
    return this._rows.filter((r) => r.status === 'active').map((r) => this._clone(r));
  }
}

function notFound(id) {
  const e = new Error(`${MODULE_INSTALLATION_NOT_FOUND}: id=${id}`);
  e.code = MODULE_INSTALLATION_NOT_FOUND;
  return e;
}
function collision(name, version) {
  const e = new Error(
    `${MODULE_INSTALLATION_VERSION_COLLISION}: (${name}, ${version})`,
  );
  e.code = MODULE_INSTALLATION_VERSION_COLLISION;
  return e;
}

// ---------------------------------------------------------------------------
// Test record factory. Produces a minimal-but-shaped ModuleInstallationRecord.
// ---------------------------------------------------------------------------

let _digestCounter = 0;
function makeRecord({
  name,
  version,
  status = 'active',
  packageDigest,
}) {
  _digestCounter += 1;
  return {
    id: brandId(-1), // repo assigns the real id on insert
    name,
    version,
    packageDigest:
      packageDigest ?? `sha256:${name}:${version}:${_digestCounter}`.padEnd(64, '0'),
    manifestSnapshot: {
      manifestFormatVersion: '0.1.0',
      definition: {
        name,
        version,
        // Minimal stub: the registry never inspects definition internals.
      },
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

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test('select() returns the active installation matching an exact version', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'alpha', version: '1.0.0' }));

  const got = reg.select({ name: 'alpha', versionRange: '1.0.0' });
  assert.equal(got.name, 'alpha');
  assert.equal(got.version, '1.0.0');
  assert.equal(got.status, 'active');
});

test('select() supports the `*` wildcard range', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'beta', version: '2.3.4' }));

  const got = reg.select({ name: 'beta', versionRange: '*' });
  assert.equal(got.version, '2.3.4');
});

test('select() supports the empty-string range as a synonym for `*`', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'beta', version: '2.3.4' }));

  const got = reg.select({ name: 'beta', versionRange: '' });
  assert.equal(got.version, '2.3.4');
});

test('select() supports caret `^x.y.z` range', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'gamma', version: '1.2.0' }));
  reg.registerInstallation(makeRecord({ name: 'gamma', version: '1.9.9' }));

  // ^1.2.0 must match both 1.2.0 and 1.9.9 (same major) and pick the higher.
  const got = reg.select({ name: 'gamma', versionRange: '^1.2.0' });
  assert.equal(got.version, '1.9.9');
});

test('caret range does NOT cross major boundary (semver ^ semantics)', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'delta', version: '2.0.0' }));

  // ^1.0.0 should NOT match 2.0.0.
  assert.throws(
    () => reg.select({ name: 'delta', versionRange: '^1.0.0' }),
    (err) => err instanceof PackageNotInstalledError && err.code === PACKAGE_NOT_INSTALLED,
  );
});

test('caret on 0.x tightens to same minor (npm ^0.2.3 = 0.2.x)', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'eps', version: '0.3.0' }));

  // ^0.2.3 should NOT match 0.3.0 (different minor under major 0).
  assert.throws(
    () => reg.select({ name: 'eps', versionRange: '^0.2.3' }),
    (err) => err instanceof PackageNotInstalledError,
  );

  // But ^0.2.0 SHOULD match 0.2.9.
  reg.registerInstallation(makeRecord({ name: 'eps2', version: '0.2.9' }));
  const got = reg.select({ name: 'eps2', versionRange: '^0.2.0' });
  assert.equal(got.version, '0.2.9');
});

test('caret on 0.0.x is exact (npm ^0.0.3 = exactly 0.0.3)', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'zeta', version: '0.0.4' }));

  // ^0.0.3 should NOT match 0.0.4.
  assert.throws(
    () => reg.select({ name: 'zeta', versionRange: '^0.0.3' }),
    (err) => err instanceof PackageNotInstalledError,
  );
});

test('select() supports tilde `~x.y.z` range (same major.minor, patch>=base)', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'eta', version: '2.3.5' }));
  reg.registerInstallation(makeRecord({ name: 'eta', version: '2.3.9' }));
  reg.registerInstallation(makeRecord({ name: 'eta', version: '2.4.0' }));

  // ~2.3.4 matches 2.3.x >= 2.3.4 — picks the higher of {2.3.5, 2.3.9}.
  const got = reg.select({ name: 'eta', versionRange: '~2.3.4' });
  assert.equal(got.version, '2.3.9');
});

test('tilde does NOT cross minor boundary', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'theta', version: '2.4.0' }));

  // ~2.3.0 should NOT match 2.4.0.
  assert.throws(
    () => reg.select({ name: 'theta', versionRange: '~2.3.0' }),
    (err) => err instanceof PackageNotInstalledError,
  );
});

test('multiple active versions: select() returns the HIGHEST semver deterministically', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'iota', version: '1.0.0' }));
  reg.registerInstallation(makeRecord({ name: 'iota', version: '1.2.0' }));
  reg.registerInstallation(makeRecord({ name: 'iota', version: '1.10.0' }));
  reg.registerInstallation(makeRecord({ name: 'iota', version: '1.2.5' }));

  // `*` matches all four; highest is 1.10.0 (NOT 1.2.5 — string sort would lie).
  const got = reg.select({ name: 'iota', versionRange: '*' });
  assert.equal(got.version, '1.10.0');

  // Same query, same answer — deterministic, no order sensitivity.
  const got2 = reg.select({ name: 'iota', versionRange: '*' });
  assert.equal(got2.version, '1.10.0');
  assert.equal(got.id, got2.id);
});

test('multiple active versions: caret range picks the highest matching semver', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'kappa', version: '1.0.0' }));
  reg.registerInstallation(makeRecord({ name: 'kappa', version: '1.5.0' }));
  reg.registerInstallation(makeRecord({ name: 'kappa', version: '2.0.0' }));

  // ^1.2.0 matches {1.5.0} (1.0.0 too low, 2.0.0 wrong major).
  const got = reg.select({ name: 'kappa', versionRange: '^1.2.0' });
  assert.equal(got.version, '1.5.0');
});

test('negative: select() unknown name throws PackageNotInstalledError', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'lambda', version: '1.0.0' }));

  const selector = { name: 'mu', versionRange: '*' };
  assert.throws(
    () => reg.select(selector),
    (err) => {
      assert.ok(err instanceof PackageNotInstalledError);
      assert.equal(err.code, PACKAGE_NOT_INSTALLED);
      assert.deepEqual(err.selector, selector);
      assert.match(err.message, /PACKAGE_NOT_INSTALLED/);
      assert.match(err.message, /"mu"/);
      return true;
    },
  );
});

test('negative: select() range matching nothing throws PackageNotInstalledError', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'nu', version: '1.0.0' }));
  reg.registerInstallation(makeRecord({ name: 'nu', version: '1.5.0' }));

  // ^2.0.0 matches neither (1.x only).
  assert.throws(
    () => reg.select({ name: 'nu', versionRange: '^2.0.0' }),
    (err) => err instanceof PackageNotInstalledError,
  );
  // exact 9.9.9 matches nothing.
  assert.throws(
    () => reg.select({ name: 'nu', versionRange: '9.9.9' }),
    (err) => err instanceof PackageNotInstalledError,
  );
});

test('negative: malformed version on the installed record is treated as non-matching', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  // Bypass the factory to inject a malformed version the registry cannot parse.
  const rec = makeRecord({ name: 'xi', version: 'IGNORED' });
  rec.version = 'not-a-version';
  repo.insert(rec);

  assert.throws(
    () => reg.select({ name: 'xi', versionRange: '*' }),
    (err) => err instanceof PackageNotInstalledError,
  );
});

test('negative: malformed range never matches (no prefix / no OR / no ranges)', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'omicron', version: '1.2.3' }));

  for (const badRange of ['1.x', '1.2.x', '>=1.0.0', '1.0.0 - 2.0.0', '1.0.0 || 2.0.0', '~1']) {
    assert.throws(
      () => reg.select({ name: 'omicron', versionRange: badRange }),
      (err) => err instanceof PackageNotInstalledError,
      `expected ${badRange} to match nothing`,
    );
  }
});

test('negative: two active installations with same (name, version) cannot coexist', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);

  reg.registerInstallation(
    makeRecord({ name: 'pi', version: '1.0.0', packageDigest: 'a'.repeat(64) }),
  );

  // Second active (pi, 1.0.0) with a different digest is rejected by the repo.
  assert.throws(
    () =>
      reg.registerInstallation(
        makeRecord({ name: 'pi', version: '1.0.0', packageDigest: 'b'.repeat(64) }),
      ),
    (err) => err.code === MODULE_INSTALLATION_VERSION_COLLISION,
  );
});

test('retired installations are NOT selectable (only active)', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);

  // Insert as staged, then activate, then retire.
  const staged = repo.insert(
    makeRecord({ name: 'rho', version: '1.0.0', status: 'staged' }),
  );
  assert.equal(staged.status, 'staged');
  // Not active yet — not selectable.
  assert.throws(
    () => reg.select({ name: 'rho', versionRange: '*' }),
    (err) => err instanceof PackageNotInstalledError,
  );

  const active = repo.activate(staged.id);
  assert.equal(active.status, 'active');
  // Now selectable.
  const got = reg.select({ name: 'rho', versionRange: '*' });
  assert.equal(got.id, staged.id);

  // Retire it — should become unselectable again.
  repo.retire(staged.id);
  assert.throws(
    () => reg.select({ name: 'rho', versionRange: '*' }),
    (err) => err instanceof PackageNotInstalledError,
  );
});

test('select() reflects later activate/retire transitions (no caching)', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);

  const staged = repo.insert(
    makeRecord({ name: 'sigma', version: '1.0.0', status: 'staged' }),
  );
  assert.throws(
    () => reg.select({ name: 'sigma', versionRange: '1.0.0' }),
    (err) => err instanceof PackageNotInstalledError,
  );

  repo.activate(staged.id);
  const got = reg.select({ name: 'sigma', versionRange: '1.0.0' });
  assert.equal(got.id, staged.id);
});

test('has() returns true iff select() would succeed', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'tau', version: '1.0.0' }));
  reg.registerInstallation(makeRecord({ name: 'tau', version: '2.0.0' }));

  assert.equal(reg.has({ name: 'tau', versionRange: '*' }), true);
  assert.equal(reg.has({ name: 'tau', versionRange: '^1.0.0' }), true);
  assert.equal(reg.has({ name: 'tau', versionRange: '~1.0.0' }), true);
  assert.equal(reg.has({ name: 'tau', versionRange: '1.0.0' }), true);
  assert.equal(reg.has({ name: 'tau', versionRange: '^2.0.0' }), true);
  // Mismatched major:
  assert.equal(reg.has({ name: 'tau', versionRange: '^3.0.0' }), false);
  // Unknown name:
  assert.equal(reg.has({ name: 'upsilon', versionRange: '*' }), false);
});

test('listSelectors() returns every active installation as (name, exact-version)', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'phi', version: '1.0.0' }));
  reg.registerInstallation(makeRecord({ name: 'phi', version: '2.0.0' }));
  reg.registerInstallation(makeRecord({ name: 'chi', version: '0.4.1' }));

  const selectors = reg.listSelectors();
  // Three active installations → three selectors.
  assert.equal(selectors.length, 3);
  // Each selector round-trips through select().
  for (const s of selectors) {
    const got = reg.select(s);
    assert.equal(got.name, s.name);
    assert.equal(got.version, s.versionRange);
  }
  // Verify presence regardless of repo order.
  const key = (s) => `${s.name}@${s.versionRange}`;
  const keys = new Set(selectors.map(key));
  assert.ok(keys.has('phi@1.0.0'));
  assert.ok(keys.has('phi@2.0.0'));
  assert.ok(keys.has('chi@0.4.1'));
});

test('listSelectors() excludes non-active installations', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  const staged = repo.insert(
    makeRecord({ name: 'psi', version: '1.0.0', status: 'staged' }),
  );
  const active = repo.insert(makeRecord({ name: 'psi', version: '2.0.0' }));
  repo.retire(active.id);

  // Only `staged` remains and it isn't active.
  assert.equal(reg.listSelectors().length, 0);

  // Activate the staged one — it should now appear.
  repo.activate(staged.id);
  assert.equal(reg.listSelectors().length, 1);
  assert.equal(reg.listSelectors()[0].name, 'psi');
  assert.equal(reg.listSelectors()[0].versionRange, '1.0.0');
});

test('listSelectors() returns a defensive copy (mutation does not affect registry)', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  reg.registerInstallation(makeRecord({ name: 'omega', version: '1.0.0' }));

  const snapshot = reg.listSelectors();
  // Mutate the returned array AND its element — registry must be unaffected.
  snapshot.length = 0;
  assert.doesNotThrow(() => reg.select({ name: 'omega', versionRange: '1.0.0' }));
  assert.equal(reg.listSelectors().length, 1);
});

test('registerInstallation() delegates to the repository (single source of truth)', () => {
  const repo = new FakeModuleInstallationRepository();
  const reg = new InstallationBasedPackageRegistry(repo);
  const rec = makeRecord({ name: 'alpha2', version: '3.1.4' });
  reg.registerInstallation(rec);

  // The repo now holds the record.
  const fromRepo = repo.getActiveByNameVersion('alpha2', '3.1.4');
  assert.ok(fromRepo !== null);
  assert.equal(fromRepo.name, 'alpha2');
  assert.equal(fromRepo.version, '3.1.4');
});

test('determinism: select() with same name + multiple versions is order-independent', () => {
  // Two registries with INSERTED IN REVERSE order should produce the same answer.
  const r1 = new FakeModuleInstallationRepository();
  const reg1 = new InstallationBasedPackageRegistry(r1);
  r1.insert(makeRecord({ name: 'x', version: '1.0.0' }));
  r1.insert(makeRecord({ name: 'x', version: '1.10.0' }));
  r1.insert(makeRecord({ name: 'x', version: '1.2.0' }));

  const r2 = new FakeModuleInstallationRepository();
  const reg2 = new InstallationBasedPackageRegistry(r2);
  r2.insert(makeRecord({ name: 'x', version: '1.2.0' }));
  r2.insert(makeRecord({ name: 'x', version: '1.10.0' }));
  r2.insert(makeRecord({ name: 'x', version: '1.0.0' }));

  const a = reg1.select({ name: 'x', versionRange: '*' });
  const b = reg2.select({ name: 'x', versionRange: '*' });
  assert.equal(a.version, b.version);
  assert.equal(a.version, '1.10.0');
});

test('PackageNotInstalledError is a real Error subclass with correct prototype', () => {
  const e = new PackageNotInstalledError({ name: 'n', versionRange: '*' });
  assert.ok(e instanceof Error);
  assert.ok(e instanceof PackageNotInstalledError);
  assert.equal(e.code, PACKAGE_NOT_INSTALLED);
  assert.equal(e.name, 'PackageNotInstalledError');
  assert.deepEqual(e.selector, { name: 'n', versionRange: '*' });
});
