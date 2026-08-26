// One-off WP-15 stamping utility (not part of any runtime path): writes the
// common scripts/build.mjs + scripts/package.mjs + product.json of one
// qualification product fixture. Deterministic, byte-stable templates.
import { mkdirSync, writeFileSync } from 'node:fs';

const NL = String.fromCharCode(10);
const ESC_N = String.fromCharCode(92) + 'n'; // the two-character escape sequence \n
const [name, inputsRaw] = process.argv.slice(2);
const inputs = JSON.parse(inputsRaw);
const root = `tools/qualify/fixtures/${name}`;
mkdirSync(`${root}/scripts`, { recursive: true });
/* The served families expose a start script over their server module; the
   CLI/lib families have none. */
const served = ['served-crud', 'webhook-receiver', 'metrics-dashboard', 'import-export', 'sqlite-inventory'].includes(name);
const cli = ['cli-stats', 'cli-transform', 'cli-linter', 'cli-packager'].includes(name);
const startScript = served ? `node ${inputs[0]}` : cli ? `node ${inputs[0]}` : undefined;
const testScript = `node --test test/`;

const build = [
  '/**',
  ` * ${name}/scripts/build.mjs - the deterministic build step: digests the`,
  ' * declared inputs into dist/build-manifest.json. Pure node:crypto/fs - no',
  ' * toolchain, no network, byte-identical on re-run.',
  ' */',
  "import { createHash } from 'node:crypto';",
  "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
  "import { dirname, join } from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  '',
  "const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');",
  `const INPUTS = ${JSON.stringify(inputs)};`,
  '',
  'const entries = [];',
  'for (const rel of INPUTS) {',
  '  const bytes = await readFile(join(ROOT, rel));',
  '  entries.push({ path: rel, bytes: bytes.byteLength, sha256: createHash(\'sha256\').update(bytes).digest(\'hex\') });',
  '}',
  'entries.sort((a, b) => (a.path < b.path ? -1 : 1));',
  'const buildDigest = createHash(\'sha256\').update(JSON.stringify(entries)).digest(\'hex\');',
  `const manifest = { kind: '${name}.build-manifest.v1', inputs: entries, buildDigest };`,
  '',
  "await mkdir(join(ROOT, 'dist'), { recursive: true });",
  "await writeFile(join(ROOT, 'dist', 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '" + ESC_N + "');",
  "process.stdout.write('" + name + " build: ' + buildDigest + '" + ESC_N + "');",
  '',
].join(NL);

const pkg = [
  '/**',
  ` * ${name}/scripts/package.mjs - the LOCAL packaging/delivery input:`,
  ' * assembles delivery/package-input.json (the exact bytes + digests the',
  ' * delivery stage consumes) into delivery/bundle/. No external deployment,',
  ' * no registry, no network.',
  ' */',
  "import { createHash } from 'node:crypto';",
  "import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';",
  "import { dirname, join } from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  '',
  "const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');",
  `const INPUTS = ${JSON.stringify(inputs)};`,
  '',
  'const entries = [];',
  'for (const rel of INPUTS) {',
  '  const bytes = await readFile(join(ROOT, rel));',
  '  entries.push({ path: rel, bytes: bytes.byteLength, sha256: createHash(\'sha256\').update(bytes).digest(\'hex\') });',
  '}',
  "const bundleDigest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');",
  `const input = { kind: '${name}.delivery-input.v1', entries, bundleDigest, externalDeployment: false };`,
  '',
  "await mkdir(join(ROOT, 'delivery', 'bundle'), { recursive: true });",
  'for (const entry of entries) {',
  "  await copyFile(join(ROOT, entry.path), join(ROOT, 'delivery', 'bundle', entry.path.replaceAll('/', '__')));",
  '}',
  "await writeFile(join(ROOT, 'delivery', 'package-input.json'), JSON.stringify(input, null, 2) + '" + ESC_N + "');",
  "process.stdout.write('" + name + " package: ' + bundleDigest + '" + ESC_N + "');",
  '',
].join(NL);

const productJson = `${JSON.stringify({ kind: 'ek-qualify-product-fixture.v1', product: name, description: `Qualification product fixture (${name}) - deterministic, zero runtime dependencies, verified hermetically on loopback/stdin only.`, inputs }, null, 2)}${NL}`;

const packageJson = `${JSON.stringify({
  name,
  version: '1.0.0',
  private: true,
  type: 'module',
  description: `The ${name} qualification product fixture (plan EK-11, WP-15). Zero runtime dependencies; verified hermetically.`,
  scripts: {
    build: 'node scripts/build.mjs',
    package: 'node scripts/package.mjs',
    smoke: 'node verify/smoke.mjs',
    ...(startScript !== undefined ? { start: startScript } : {}),
  },
}, null, 2)}${NL}`;

writeFileSync(`${root}/scripts/build.mjs`, build, 'utf8');
writeFileSync(`${root}/scripts/package.mjs`, pkg, 'utf8');
writeFileSync(`${root}/product.json`, productJson, 'utf8');
writeFileSync(`${root}/package.json`, packageJson, 'utf8');
writeFileSync(`${root}/.gitignore`, ['dist/', 'delivery/', 'data/', '*.tmp', ''].join(NL), 'utf8');
console.log(`stamped ${name}`);
