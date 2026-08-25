/**
 * acceptance.test.mjs - WP-08 deliverable 6: the canonical simple product
 * (the corpus target) - dependency-light server, /healthz, /api/message,
 * served HTML+JS frontend, package/build/start commands, unit + loopback +
 * browser-smoke hooks, local packaging - verified against the acceptance
 * contract that owns browser entry, static assets, bootstrap, build/start
 * wiring and frontend/backend integration.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_ROOT } from './support.mjs';

const acceptance = await import('../../../dist/workflow-kernel/development/product-acceptance.js');

test('the acceptance contract loads and owns every integration surface', () => {
  const loaded = acceptance.loadAcceptanceContract(FIXTURE_ROOT);
  assert.equal(loaded.refused, undefined, JSON.stringify(loaded));
  const contract = loaded.contract;
  assert.equal(contract.product, 'simple-server');
  assert.equal(contract.browserEntry, 'public/index.html');
  assert.deepEqual([...contract.staticAssets], ['public/app.js']);
  assert.deepEqual(contract.apiSurfaces.map((surface) => surface.route).sort(), ['/api/message', '/healthz']);
  assert.equal(contract.bootstrap.buildCommand, 'npm run build');
  assert.equal(contract.bootstrap.startCommand, 'npm run start');
  assert.equal(contract.integration.rendersInto, '#message');
  assert.equal(contract.packaging.externalDeployment, false, 'no external deployment');
  // Every contract-owned surface exists in the product tree.
  assert.deepEqual(acceptance.missingIntegrationSurfaces(FIXTURE_ROOT, contract), []);
});

test('the product verifies end to end: build + loopback HTTP + smoke + packaging', async () => {
  const check = await acceptance.checkProductAcceptance(FIXTURE_ROOT);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual([...check.verified], ['surfaces', 'build', 'loopback', 'smoke', 'packaging']);
  assert.match(check.buildDigest, /^[0-9a-f]{64}$/, 'the deterministic build digest');
  assert.match(check.evidenceDigest, /^sha256:/);
});

test('the unit verification hook runs green (node:test, zero dependencies)', async () => {
  const { spawn } = await import('node:child_process');
  const contract = acceptance.loadAcceptanceContract(FIXTURE_ROOT).contract;
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(FIXTURE_ROOT, contract.verification.unit)], { cwd: FIXTURE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
});

test('mutation: a missing integration surface is refused typed, naming the exact surface', async () => {
  const broken = mkdtempSync(join(tmpdir(), 'ek-wp08-broken-'));
  try {
    cpSync(FIXTURE_ROOT, broken, { recursive: true });
    rmSync(join(broken, 'public', 'app.js'));
    const check = await acceptance.checkProductAcceptance(broken);
    assert.equal(check.refused, true);
    assert.equal(check.reason, 'MISSING_INTEGRATION_SURFACE');
    assert.deepEqual([...check.surfaces], ['public/app.js']);
    assert.match(check.detail, /public\/app\.js/);
  } finally {
    rmSync(broken, { recursive: true, force: true });
  }
});

test('mutation: a broken deterministic API surface is refused typed at loopback', async () => {
  const broken = mkdtempSync(join(tmpdir(), 'ek-wp08-broken-'));
  try {
    cpSync(FIXTURE_ROOT, broken, { recursive: true });
    const serverPath = join(broken, 'src', 'server.js');
    const original = (await import('node:fs')).readFileSync(serverPath, 'utf8');
    (await import('node:fs')).writeFileSync(serverPath, original.replace("'hello from simple-server', code: 7", "'MUTATED', code: 13"));
    const check = await acceptance.checkProductAcceptance(broken);
    assert.equal(check.refused, true);
    assert.equal(check.reason, 'PRODUCT_LOOPBACK_FAILED');
    assert.match(check.detail, /\/api\/message|MUTATED/);
  } finally {
    rmSync(broken, { recursive: true, force: true });
  }
});

test('mutation: a missing browser-entry integration is refused typed', async () => {
  const broken = mkdtempSync(join(tmpdir(), 'ek-wp08-broken-'));
  try {
    cpSync(FIXTURE_ROOT, broken, { recursive: true });
    const indexPath = join(broken, 'public', 'index.html');
    const original = (await import('node:fs')).readFileSync(indexPath, 'utf8');
    (await import('node:fs')).writeFileSync(indexPath, original.replace('src="/app.js"', 'src="/gone.js"'));
    const check = await acceptance.checkProductAcceptance(broken);
    assert.equal(check.refused, true);
    assert.ok(check.reason === 'MISSING_INTEGRATION_SURFACE' || check.reason === 'PRODUCT_LOOPBACK_FAILED' || check.reason === 'PRODUCT_SMOKE_FAILED', JSON.stringify(check));
  } finally {
    rmSync(broken, { recursive: true, force: true });
  }
});
