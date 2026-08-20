// tests/factory-proof/canonical-composition.test.mjs
//
// W0-1 acceptance — the canonical proof composition is the ONE composition
// authority for new causal proofs (ADR-084; GRAPH-TEST-STRATEGY W0-1):
//
//   A. Overlay allowlist on the REAL composition: an unannounced override key
//      (including re-passed Reference policies) makes the proof red.
//   B. Installed production identity: removing or mutating a module/package
//      identity row changes the fingerprint AND makes the proof red
//      (assertInstalledIdentity). Fingerprint covers actual overlay keys.
//   C. One minimal scripted happy path drives through the canonical adapter
//      over REAL assignment/MCP/Gate — in an isolated child process.
//
// The ratchet forbidding imports of the three legacy composition surfaces from
// factory-proof lives in import-ratchet.test.mjs (same directory).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const {
  buildCanonicalProofComposition,
  assertCanonicalOverlay,
  readInstalledIdentity,
  assertInstalledIdentity,
  computeCanonicalProofFingerprint,
  createScriptedObserver,
  CANONICAL_TEST_PROVIDERS,
} = await import('./canonical-proof-composition.mjs');

const { bootstrapFreshHarness } = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href
);

function canonicalFixture(bootstrap) {
  const observer = createScriptedObserver();
  const composition = buildCanonicalProofComposition({
    observer,
    repoPath: bootstrap.repoPath,
    sagaRepoRoot: bootstrap.sagaRepoRoot,
  });
  return { observer, composition };
}

// ---------------------------------------------------------------------------
// A — overlay allowlist on the REAL composition object.
// ---------------------------------------------------------------------------

test('A1: canonical composition carries only allowlisted keys (no policy mirrors)', async () => {
  const bootstrap = await bootstrapFreshHarness({ repoRoot: REPO_ROOT });
  try {
    const { composition } = canonicalFixture(bootstrap);
    // The REAL object — not a synthetic safe fixture.
    assert.doesNotThrow(() => assertCanonicalOverlay(composition));
    // Structural: development is absent entirely (production default `{}`),
    // delivery carries ONLY providers.
    assert.equal(composition.development, undefined,
      'canonical composition must NOT pass development policies — production '
      + 'registration constructs Reference defaults when omitted');
    assert.deepEqual(Object.keys(composition.delivery), ['providers']);
  } finally {
    bootstrap.cleanup();
  }
});

test('A2: unannounced override keys on the REAL composition make the proof red', async () => {
  const bootstrap = await bootstrapFreshHarness({ repoRoot: REPO_ROOT });
  try {
    const { composition } = canonicalFixture(bootstrap);

    const cases = [
      {
        name: 'top-level unknown key',
        inject: c => { c.persistence = { episodes: 'fake' }; },
        expect: 'persistence',
      },
      {
        name: 're-passed Reference development settlement policy (mirror override)',
        inject: c => {
          c.development = { settlementPolicy: { evaluate() { return null; } } };
        },
        expect: 'development',
      },
      {
        name: 're-passed Reference delivery preflight policy (mirror override)',
        inject: c => {
          c.delivery.preflightPolicy = { evaluate() { return null; } };
        },
        expect: 'delivery.preflightPolicy',
      },
      {
        name: 'delivery runtime replacement (fourth-runtime risk)',
        inject: c => {
          c.delivery.runtime = { execute() { return null; } };
        },
        expect: 'delivery.runtime',
      },
      {
        name: 'settlement-state port replacement',
        inject: c => {
          c.delivery.settlementState = { read() { return null; } };
        },
        expect: 'delivery.settlementState',
      },
    ];

    for (const { name, inject, expect } of cases) {
      const tainted = canonicalFixture(bootstrap).composition;
      inject(tainted);
      assert.throws(
        () => assertCanonicalOverlay(tainted),
        err => err.code === 'CANONICAL_COMPOSITION_OVERLAY_VIOLATION'
          && err.violations.includes(expect),
        `${name}: overlay violation must name '${expect}'`,
      );
    }
  } finally {
    bootstrap.cleanup();
  }
});

// ---------------------------------------------------------------------------
// B — installed production identity + real fingerprint.
// ---------------------------------------------------------------------------

test('B1: fingerprint covers lifecycle identity, modules, providers, actual overlay', async () => {
  const bootstrap = await bootstrapFreshHarness({ repoRoot: REPO_ROOT });
  try {
    const { composition } = canonicalFixture(bootstrap);
    const identity = await readInstalledIdentity(bootstrap);
    assertInstalledIdentity(bootstrap, identity);

    assert.match(identity.lifecycle.id, /^product-build@\d+\.\d+\.\d+$/);
    // product-build = discovery → formalization → development (delivery-release
    // is a separate request); the stage set is exactly this shape.
    assert.deepEqual(
      identity.lifecycle.stages.map(s => s.stageId),
      ['initial-discovery', 'solution-formalization', 'solution-development'],
      'lifecycle definition must carry the product-build stage set',
    );
    assert.ok(identity.modules.length >= 6,
      'the six production workshop packages must be installed');
    assert.ok(identity.providers.length >= 3,
      'bootstrap trusted providers must be registered');

    const fp = computeCanonicalProofFingerprint(bootstrap, composition, identity);
    assert.match(fp.fingerprint, /^[0-9a-f]{64}$/, 'fingerprint is sha256 hex');
    assert.deepEqual(fp.overlayKeys, [
      'delivery.providers', 'resolveWorkerContext', 'workerExecutorFactory',
    ], 'fingerprint reflects the ACTUAL overlay keys of this composition');

    // The test-provider identities are visibly doubles, never "production".
    assert.equal(CANONICAL_TEST_PROVIDERS.preflight.role, 'test-double');
    assert.equal(CANONICAL_TEST_PROVIDERS.deployment.role, 'test-double');
    assert.equal(CANONICAL_TEST_PROVIDERS.preflight.name, 'fresh-harness-preflight');
  } finally {
    bootstrap.cleanup();
  }
});

test('B2: removing a production module identity changes the fingerprint and fails the proof', async () => {
  const bootstrap = await bootstrapFreshHarness({ repoRoot: REPO_ROOT });
  try {
    const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
    const db = getDb();
    const { composition } = canonicalFixture(bootstrap);

    const before = assertInstalledIdentity(bootstrap, await readInstalledIdentity(bootstrap));
    const fpBefore = computeCanonicalProofFingerprint(bootstrap, composition, before);

    // Simulate removal of one installed production module identity. This is
    // the per-run TEST DB (composition/package surface — factory_module_
    // installations is NOT an authority table; the harness authority list is
    // factory_workplaces/candidate_sets/gate_decisions/accepted_authority_
    // heads). The point is fingerprint sensitivity, not outcome manufacture.
    const victim = db.prepare(
      `SELECT name, version FROM factory_module_installations
        WHERE status='active' ORDER BY name LIMIT 1`,
    ).get();
    db.prepare(
      `UPDATE factory_module_installations SET status='retired' WHERE name=? AND version=?`,
    ).run(victim.name, victim.version);

    const after = await readInstalledIdentity(bootstrap);
    const fpAfter = computeCanonicalProofFingerprint(bootstrap, composition, after);
    assert.notEqual(fpAfter.fingerprint, fpBefore.fingerprint,
      'module identity removal MUST change the composition fingerprint');

    // And the proof itself must refuse to run on a partial factory.
    assert.throws(
      () => assertInstalledIdentity(bootstrap, after),
      /CANONICAL_PROOF_IDENTITY_INCOMPLETE/,
    );
  } finally {
    bootstrap.cleanup();
  }
});

test('B3: mutating an installed package digest fails the proof', async () => {
  const bootstrap = await bootstrapFreshHarness({ repoRoot: REPO_ROOT });
  try {
    const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
    const db = getDb();
    db.prepare(
      `UPDATE factory_module_installations
          SET package_digest='0'||substr(package_digest,2)
        WHERE name=(SELECT name FROM factory_module_installations WHERE status='active' LIMIT 1)`,
    ).run();
    const mutated = await readInstalledIdentity(bootstrap);
    assert.throws(
      () => assertInstalledIdentity(bootstrap, mutated),
      /CANONICAL_PROOF_IDENTITY_MUTATED/,
      'digest mutation must fail the proof with the typed MUTATED code',
    );
  } finally {
    bootstrap.cleanup();
  }
});

// ---------------------------------------------------------------------------
// C — one minimal scripted happy path through the canonical adapter.
// Isolated child process (composition-root singletons must not leak).
// ---------------------------------------------------------------------------

test('C1: canonical happy drive passes REAL assignment/MCP/Gate to runnable-local', () => {
  const drive = path.resolve(REPO_ROOT, 'tests/factory-proof/canonical-happy-drive.mjs');
  const result = spawnSync(process.execPath, [drive], {
    cwd: REPO_ROOT,
    env: { ...process.env, CANONICAL_DRIVE_LABEL: 'w0-1-acceptance' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `canonical happy drive exited ${result.status}\n`
      + `stderr: ${(result.stderr || '').slice(-3000)}\n`
      + `stdout: ${(result.stdout || '').slice(-1000)}`,
    );
  }
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
  const evidence = JSON.parse(lines[lines.length - 1]);

  // Real machinery: authority rows appeared NATURALLY through the production
  // runtime — assignment (workplaces/executions), MCP (command receipts),
  // gates (decisions, accepted verdicts, authority heads).
  assert.ok(evidence.gateDecisions >= 3, `gate decisions (got ${evidence.gateDecisions})`);
  assert.ok(evidence.acceptedGates >= 1, `accepted gate verdicts (got ${evidence.acceptedGates})`);
  assert.ok(evidence.workplaces >= 1, `workplaces (got ${evidence.workplaces})`);
  assert.ok(evidence.acceptedHeads >= 1, `accepted authority heads (got ${evidence.acceptedHeads})`);
  assert.ok(evidence.commandReceipts >= 1, `MCP command receipts (got ${evidence.commandReceipts})`);

  // The run converged through the canonical composition.
  assert.equal(evidence.reachedRunnableLocal, true, 'development outcome=verified');
  assert.equal(evidence.strandedActiveExecutions, 0, 'no stranded executions');
  assert.ok(evidence.scriptedInvocationCount >= 10, 'scripted inference carried the run');

  // Composition discipline held inside the drive.
  assert.match(evidence.lifecycleIdentity, /^product-build@/);
  assert.ok(evidence.moduleCount >= 6);
  assert.deepEqual(evidence.overlayKeys.sort(), [
    'delivery.providers', 'resolveWorkerContext', 'workerExecutorFactory',
  ]);
  assert.match(evidence.compositionFingerprint, /^[0-9a-f]{64}$/);
}, { timeout: 200_000 });
