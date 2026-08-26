/**
 * tests/qualify/kinds-map.proof.mjs - the plan-table alignment proof of the
 * EK-11 qualification (WP-15): the corpus's twenty projects map 1:1 onto the
 * plan's twenty-product inventory (P01..P20, every plan id exactly once),
 * every mapped product fixture EXISTS with its build/smoke/package surfaces,
 * and every declared evidence profile is closed and complete (build +
 * package receipt + at least one smoke class - enforced by the descriptor
 * format contract, asserted here against the loaded corpus).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const moduleOf = (relative) => import(pathToFileURL(join(REPO_ROOT, relative)).href);

const { loadCorpus } = await moduleOf('tests/project-corpus/registry.mjs');
const { fixtureRootOf } = await moduleOf('tools/qualify/lib/product-evidence.mjs');

const corpus = await loadCorpus();
const planIds = corpus.map((descriptor) => descriptor.ek11.planId).sort();

test('the twenty corpus projects map 1:1 onto the plan inventory P01..P20', () => {
  assert.deepEqual(planIds, Array.from({ length: 20 }, (_, index) => `P${String(index + 1).padStart(2, '0')}`));
  assert.equal(new Set(planIds).size, 20, 'no plan id maps twice');
});

test('every ek11 alignment block is complete and closed (the format contract holds at load)', () => {
  for (const descriptor of corpus) {
    const ek11 = descriptor.ek11;
    assert.ok(ek11 !== undefined, `${descriptor.projectId} carries no ek11 block`);
    assert.match(ek11.planId, /^P[0-9]{2}$/, `${descriptor.projectId}: bad planId`);
    assert.ok(ek11.kind.length > 0, `${descriptor.projectId}: empty kind`);
    assert.match(ek11.fixture, /^(qual|repo):[a-z0-9-]+$/, `${descriptor.projectId}: bad fixture reference ${ek11.fixture}`);
    assert.ok(ek11.profile.includes('build'), `${descriptor.projectId}: profile lacks build`);
    assert.ok(ek11.profile.includes('package-receipt'), `${descriptor.projectId}: profile lacks package-receipt`);
    const smokes = ek11.profile.filter((entry) => ['browser-smoke', 'api-smoke', 'cli-smoke'].includes(entry));
    assert.ok(smokes.length >= 1, `${descriptor.projectId}: profile carries no smoke class`);
  }
});

test('every mapped product fixture exists with its build + smoke + packaging surfaces', () => {
  for (const descriptor of corpus) {
    const root = fixtureRootOf(descriptor.ek11.fixture);
    assert.ok(existsSync(root), `${descriptor.ek11.fixture} does not resolve (${root})`);
    assert.ok(existsSync(join(root, 'scripts', 'build.mjs')), `${descriptor.ek11.fixture}: no scripts/build.mjs`);
    const hasSmoke = existsSync(join(root, 'verify', 'smoke.mjs'))
      || (existsSync(join(root, 'verify', 'loopback.mjs')) && existsSync(join(root, 'verify', 'browser-smoke.mjs')))
      || descriptor.ek11.profile.includes('browser-smoke'); /* static products: the driver's served-static smoke */
    assert.ok(hasSmoke, `${descriptor.ek11.fixture}: no smoke surface`);
    const hasPackaging = existsSync(join(root, 'scripts', 'package.mjs')) || existsSync(join(root, 'product.json'));
    assert.ok(hasPackaging, `${descriptor.ek11.fixture}: neither its own packaging script nor product.json (driver-generic receipt inputs)`);
    if (descriptor.ek11.profile.includes('test')) {
      assert.ok(existsSync(join(root, 'test')), `${descriptor.ek11.fixture}: profile demands tests but there is no test/ dir`);
    }
  }
});

test('browser products demand browser smoke; non-browser products demand api/cli smoke (plan table law)', () => {
  const browserKinds = new Set([
    'served-hello-frontend-api', 'static-browser-counter', 'todo-crud-web-app', 'markdown-doc-site-generator',
    'read-only-metrics-dashboard', 'rest-service-with-operator-frontend', 'canvas-game-keyboard-browser-smoke',
    'full-stack-expense-tracker-persistence-tests', 'file-backed-notes-http-service',
  ]);
  for (const descriptor of corpus) {
    const isBrowser = browserKinds.has(descriptor.ek11.kind);
    const hasBrowser = descriptor.ek11.profile.includes('browser-smoke');
    assert.equal(isBrowser, hasBrowser, `${descriptor.ek11.planId} (${descriptor.ek11.kind}): browser-kind/browser-smoke mismatch`);
    if (!isBrowser) {
      assert.ok(descriptor.ek11.profile.includes('api-smoke') || descriptor.ek11.profile.includes('cli-smoke'), `${descriptor.ek11.planId}: non-browser product without api/cli smoke`);
    }
  }
});

test('the honest-failure projects still verify their plan products (product evidence is independent of the kernel verdict)', () => {
  const honest = corpus.filter((descriptor) => descriptor.projectKind === 'honest-failure');
  assert.deepEqual(honest.map((descriptor) => descriptor.ek11.planId).sort(), ['P14', 'P15']);
  for (const descriptor of honest) {
    assert.ok(descriptor.ek11.profile.includes('build') && descriptor.ek11.profile.includes('package-receipt'));
  }
});
