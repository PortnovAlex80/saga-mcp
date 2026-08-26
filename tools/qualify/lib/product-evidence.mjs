/**
 * tools/qualify/lib/product-evidence.mjs - the per-kind ACTUAL PRODUCT OUTPUT
 * verification of the EK-11 qualification (WP-15). For every plan product
 * kind the driver stages the declared product fixture into a FRESH product
 * repository (the run's own tree, never the source checkout) and executes
 * the kind's evidence profile against the staged product:
 *
 *   build            - scripts/build.mjs (digest emitted, manifest written);
 *   determinism      - a second build must reproduce the same digest;
 *   test             - the product's own unit tests (node --test test/);
 *   browser-smoke    - the product's browser contract (fixture smoke hook,
 *                      or the driver's served-static smoke for static
 *                      products, or the WP-08 acceptance layer for the
 *                      canonical served product);
 *   api-smoke /
 *   cli-smoke        - the fixture's smoke hook over the real runtime
 *                      (loopback sockets / real CLI child processes);
 *   persistence      - asserted inside the fixture smoke (restart + state
 *                      survival) - listed when the kind demands it;
 *   recovery         - asserted inside the fixture smoke (corruption +
 *                      restore path);
 *   package-receipt  - the LOCAL Delivery/package effect receipt
 *                      (scripts/package.mjs, or the driver's generic
 *                      delivery-input assembly when the product has no
 *                      packaging script of its own - recorded as such).
 *
 * Everything runs inside the staged fresh repository; stdout/stderr of every
 * step is captured as evidence; nothing writes into the source checkout.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const QUAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(QUAL_ROOT, '..', '..');

/** Fixture reference resolution: 'qual:<name>' -> tools/qualify/fixtures,
 *  'repo:<name>' -> the repo's own product fixtures. The resolved root must
 *  EXIST (an unknown or missing fixture refuses, typed). */
export function fixtureRootOf(reference) {
  const [scope, name] = reference.split(':');
  let root = null;
  if (scope === 'qual') root = join(QUAL_ROOT, 'fixtures', name);
  else if (scope === 'repo') {
    if (name === 'simple-server') root = join(REPO_ROOT, 'tests', 'workflow-kernel', 'development', 'fixtures', 'simple-server');
    else if (name === 'static-site' || name === 'batch-report') root = join(REPO_ROOT, 'tests', 'project-corpus', 'fixtures', name);
  }
  if (root === null || !existsSync(root)) {
    throw new Error(`QUALIFY_FIXTURE_UNKNOWN: fixture reference "${reference}" does not resolve to an existing product fixture`);
  }
  return root;
}

/** Stage one fixture into a FRESH product repository (caller guarantees the
 *  path is fresh; gitignore'd artefacts are not copied). */
export function stageProductRepo(reference, targetDir) {
  const root = fixtureRootOf(reference);
  if (!existsSync(root)) throw new Error(`QUALIFY_FIXTURE_MISSING: ${root} does not exist`);
  mkdirSync(targetDir, { recursive: true });
  cpSync(root, targetDir, { recursive: true, force: true, filter: (source) => {
    const relative = source.slice(root.length).replaceAll('\\', '/');
    return !/^\/(dist|delivery|data|release)(\/|$)/.test(relative);
  } });
  return { repo: targetDir, fixtureRoot: root, fixture: reference };
}

const digestIn = (stdout, label) => {
  const match = new RegExp(`${label}: ([0-9a-f]{64})`).exec(stdout);
  return match === null ? undefined : match[1];
};

const runNode = (cwd, args, label) => {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 180000 });
  return { label, args, code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

/** The driver's served-static browser smoke (for static products whose
 *  browser entry has no server of its own): serve the declared public root
 *  over loopback and assert the entry + asset contract. */
async function servedStaticSmoke(repo, publicDir, entry, asset) {
  const mime = (name) => (name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
  const server = createServer((request, response) => {
    const name = request.url === '/' ? entry : request.url.slice(1);
    const file = join(repo, publicDir, name);
    if (!existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': mime(name) });
    response.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const html = await (await fetch(`${base}/`)).text();
    const js = await (await fetch(`${base}/${asset}`)).text();
    if (!/id="static-root"|id="board"|id="md-root"|id="message"/.test(html)) throw new Error('the browser entry declares no render target');
    if (!html.includes(`/${asset}`)) throw new Error('the browser entry does not reference its asset');
    if (js.trim().length === 0) throw new Error('the asset is empty');
    return `served static smoke green: / + /${asset} over 127.0.0.1 (render target present)`;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** The generic LOCAL delivery-input receipt for products without their own
 *  packaging script: assemble delivery/package-input.json over the
 *  product's declared input files (product.json inputs, or - for products
 *  that declare none - the product's own source/public tree), honest and
 *  driver-assembled - recorded as such in the receipt. */
function genericPackageReceipt(repo) {
  const productJsonPath = join(repo, 'product.json');
  let inputs = [];
  let productName = 'unknown-product';
  if (existsSync(productJsonPath)) {
    const productJson = JSON.parse(readFileSync(productJsonPath, 'utf8'));
    productName = productJson.product ?? productName;
    inputs = Array.isArray(productJson.inputs) ? productJson.inputs : [];
  }
  if (inputs.length === 0) {
    /* Fallback: the delivered material is the product's own tree (source +
     * public assets), excluding build/delivery/runtime artefacts. */
    const excluded = new Set(['dist', 'delivery', 'data', 'release', 'node_modules', 'test', 'verify', 'scripts']);
    const walk = (dir, prefix = '') => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (prefix === '' && excluded.has(entry.name)) continue;
        if (entry.name === '.gitignore') continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), rel);
        else if (entry.isFile()) inputs.push(rel);
      }
    };
    walk(repo);
  }
  if (inputs.length === 0) throw new Error('QUALIFY_PACKAGE_INPUTS_EMPTY: the product tree carries no deliverable inputs');
  const entries = inputs.map((rel) => {
    const bytes = readFileSync(join(repo, rel));
    return { path: rel, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  }).sort((a, b) => (a.path < b.path ? -1 : 1));
  const bundleDigest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  const input = { kind: 'driver-generic.delivery-input.v1', product: productName, entries, bundleDigest, externalDeployment: false, receiptOwner: 'qualify-driver (the product ships no packaging script)' };
  mkdirSync(join(repo, 'delivery', 'bundle'), { recursive: true });
  for (const entry of entries) copyFileSync(join(repo, entry.path), join(repo, 'delivery', 'bundle', entry.path.replaceAll('/', '__')));
  writeFileSync(join(repo, 'delivery', 'package-input.json'), `${JSON.stringify(input, null, 2)}\n`, 'utf8');
  return bundleDigest;
}

/**
 * Run one kind's evidence profile over a staged fresh product repository.
 * Returns { ok, steps, buildDigests, packageDigest, packageReceiptOwner, failure }.
 */
export async function runProductEvidence(kind, profile, repo, options = {}) {
  const steps = [];
  const buildDigests = [];
  let packageDigest;
  let packageReceiptOwner = 'product (scripts/package.mjs)';
  const fail = (step, detail) => ({ ok: false, steps, buildDigests, packageDigest, packageReceiptOwner, failure: `${step}: ${detail}` });

  /* 1. Build. */
  const build1 = runNode(repo, ['scripts/build.mjs'], 'build#1');
  steps.push(build1);
  const digest1 = digestIn(build1.stdout, 'build');
  if (build1.code !== 0 || digest1 === undefined) return fail('build', build1.stderr.trim() || build1.stdout.trim() || 'no digest emitted');
  buildDigests.push(digest1);

  /* 2. Determinism. */
  if (profile.includes('determinism')) {
    const build2 = runNode(repo, ['scripts/build.mjs'], 'build#2-determinism');
    steps.push(build2);
    const digest2 = digestIn(build2.stdout, 'build');
    if (build2.code !== 0 || digest2 !== digest1) return fail('determinism', `second build digest ${String(digest2)} != ${digest1}`);
  }

  /* 3. The product's own tests (default discovery over the staged repo's
   *    test/ tree - node --test resolves the directory itself; a positional
   *    directory argument is NOT a supported discovery form). */
  if (profile.includes('test')) {
    if (!existsSync(join(repo, 'test'))) return fail('test', 'the product declares no test/ directory');
    const test = runNode(repo, ['--test'], 'unit-tests');
    steps.push(test);
    if (test.code !== 0) return fail('test', test.stderr.trim().slice(0, 400) || 'tests failed');
  }

  /* 4. The WP-08 acceptance layer (the canonical served product only). */
  if (kind === 'served-hello-frontend-api') {
    const { pathToFileURL } = await import('node:url');
    const acceptance = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'development', 'product-acceptance.js')).href);
    const check = await acceptance.checkProductAcceptance(repo);
    steps.push({ label: 'wp08-acceptance-layer', args: ['checkProductAcceptance'], code: check.ok ? 0 : 1, stdout: JSON.stringify(check), stderr: '' });
    if (!check.ok) return fail('wp08-acceptance-layer', `${check.reason}: ${check.detail}`);
  }

  /* 5. The smoke hook (browser/api/cli/persistence/recovery classes). */
  const smokeClasses = profile.filter((entry) => ['browser-smoke', 'api-smoke', 'cli-smoke', 'persistence', 'recovery'].includes(entry));
  if (smokeClasses.length > 0) {
    if (existsSync(join(repo, 'verify', 'smoke.mjs'))) {
      const smoke = runNode(repo, ['verify/smoke.mjs'], `smoke(${smokeClasses.join('+')})`);
      steps.push(smoke);
      if (smoke.code !== 0) return fail('smoke', smoke.stderr.trim().slice(0, 400) || 'smoke failed');
    } else if (existsSync(join(repo, 'verify', 'loopback.mjs'))) {
      const loopback = runNode(repo, ['verify/loopback.mjs'], `loopback(${smokeClasses.join('+')})`);
      steps.push(loopback);
      const browser = runNode(repo, ['verify/browser-smoke.mjs'], `browser-smoke(${smokeClasses.join('+')})`);
      steps.push(browser);
      if (loopback.code !== 0) return fail('loopback', loopback.stderr.trim().slice(0, 400) || 'loopback failed');
      if (browser.code !== 0) return fail('browser-smoke', browser.stderr.trim().slice(0, 400) || 'browser smoke failed');
    } else {
      /* Static products: the driver's own served-static browser smoke. */
      const staticDetail = await servedStaticSmoke(repo, options.publicDir ?? 'public', options.entry ?? 'index.html', options.asset ?? 'app.js');
      steps.push({ label: `served-static-smoke(${smokeClasses.join('+')})`, args: [], code: 0, stdout: staticDetail, stderr: '' });
    }
  }

  /* 6. The local Delivery/package effect receipt. */
  if (profile.includes('package-receipt')) {
    if (existsSync(join(repo, 'scripts', 'package.mjs'))) {
      const pkg = runNode(repo, ['scripts/package.mjs'], 'package-receipt');
      steps.push(pkg);
      packageDigest = digestIn(pkg.stdout, 'package');
      if (pkg.code !== 0 || packageDigest === undefined) return fail('package-receipt', pkg.stderr.trim() || pkg.stdout.trim() || 'no package digest emitted');
    } else {
      packageDigest = genericPackageReceipt(repo);
      packageReceiptOwner = 'qualify-driver (the product ships no packaging script)';
      steps.push({ label: 'package-receipt', args: ['driver-generic'], code: 0, stdout: `driver-generic delivery receipt: ${packageDigest}`, stderr: '' });
    }
    const receipt = JSON.parse(readFileSync(join(repo, 'delivery', 'package-input.json'), 'utf8'));
    if (receipt.externalDeployment !== false) return fail('package-receipt', 'the delivery receipt does not prove local-only deployment');
  }

  return { ok: true, steps, buildDigests, packageDigest, packageReceiptOwner, failure: undefined };
}

/** List the fixture families available (for the kinds-map proof). */
export function availableQualFixtures() {
  return readdirSync(join(QUAL_ROOT, 'fixtures'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
