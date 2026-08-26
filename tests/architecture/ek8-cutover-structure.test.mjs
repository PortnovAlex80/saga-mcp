// tests/architecture/ek8-cutover-structure.test.mjs
//
// EK-8 HARD CUTOVER structure ratchet (WP-12, 2026-08-26).
//
// The successor of the deleted dependency-direction / factory-only /
// single-surface ratchets, re-frozen over the post-cutover tree:
//
//   S1  the production tree is the kernel ONLY — every tracked src/ file is
//       under src/workflow-kernel/** (the deleted spine may not return in
//       new clothing; legacy-zero L1 guards the manifest paths, this guards
//       the DIRECTORY LAW);
//   S2  exactly ONE production entrypoint: package.json main/bin/start
//       route to the composition package and nothing else;
//   S3  kernel dependency direction — a FROZEN package-edge set over
//       src/workflow-kernel/* (a new edge is a deliberate architectural
//       act; update the frozen set in the same commit with justification);
//   S4  the sole DDL owner is src/workflow-kernel/persistence/** (the
//       declarative fresh schema; architecture-level twin of legacy-zero L5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tracked = () => execSync('git -c core.quotepath=false ls-files', { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);

test('S1: every tracked production source is kernel source (src/workflow-kernel/** only)', () => {
  const outside = tracked().filter((f) => f.startsWith('src/') && !f.startsWith('src/workflow-kernel/'));
  assert.deepEqual(outside, [],
    `production files outside the kernel tree: ${outside.join(', ')} — the legacy spine was deleted at EK-8 and may not return`);
});

test('S2: exactly ONE production entrypoint — package.json routes to the composition', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'dist/workflow-kernel/composition/index.js', 'package.json main must be the composition barrel');
  assert.deepEqual(pkg.bin, { 'saga-mcp': 'dist/workflow-kernel/composition/entry.js' }, 'package.json bin must be the composition entry only');
  assert.match(pkg.scripts.start, /workflow-kernel\/composition\/entry\.js/, 'npm start must route to the composition entry');
});

// --- S3: kernel dependency direction ----------------------------------------

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

const KERNEL = path.join(REPO_ROOT, 'src', 'workflow-kernel');
const PACKAGE_OF = (abs) => path.relative(KERNEL, abs).split(path.sep)[0];

function importEdges() {
  const edges = new Set();
  for (const abs of walk(KERNEL)) {
    const from = PACKAGE_OF(abs);
    const src = readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
      const resolved = path.normalize(path.join(path.dirname(abs), m[1]));
      const rel = path.relative(KERNEL, resolved).split(path.sep).join('/');
      if (rel.startsWith('..')) continue; // escapes the kernel (nothing does today)
      const to = rel.split('/')[0];
      if (to !== from) edges.add(`${from}->${to}`);
    }
  }
  return [...edges].sort();
}

// Frozen at the EK-8 cutover over the landed kernel (WP-05..WP-13 waves).
// A new edge is an architectural act: add it here in the same commit with a
// justification note. Removals also update this set.
const FROZEN_KERNEL_PACKAGE_EDGES = [
  'application->domain',
  'application->persistence',
  'composition->application',
  'composition->context-envelope',
  'composition->development',
  'composition->domain',
  'composition->persistence',
  'composition->projection',
  'composition->roles',
  'composition->workshops',
  'context-envelope->domain',
  'development->application',
  'development->context-envelope',
  'development->domain',
  'development->persistence',
  'development->roles',
  'persistence->domain',
  'planning->application',
  'planning->domain',
  'planning->persistence',
  'planning->roles',
  'projection->application',
  'projection->development',
  'projection->domain',
  'projection->persistence',
  'projection->planning',
  'roles->domain',
  'testing->application',
  'testing->context-envelope',
  'testing->domain',
  'testing->persistence',
  'workshops->application',
  'workshops->context-envelope',
  'workshops->development',
  'workshops->domain',
  'workshops->persistence',
  'workshops->planning',
  'workshops->roles'
];

test('S3: the kernel package dependency graph equals the frozen edge set (no new direction without this file changing)', () => {
  const actual = importEdges();
  assert.deepEqual(actual, [...FROZEN_KERNEL_PACKAGE_EDGES].sort(),
    `kernel dependency-direction drift.\nnew edges (deliberate? update FROZEN_KERNEL_PACKAGE_EDGES in the same commit with justification): ${actual.filter((e) => !FROZEN_KERNEL_PACKAGE_EDGES.includes(e)).join(', ')}\nremoved edges: ${FROZEN_KERNEL_PACKAGE_EDGES.filter((e) => !actual.includes(e)).join(', ')}`);
});

test('S4: the sole DDL owner is the kernel persistence package (fresh declarative schema)', () => {
  const ddlOwners = [];
  for (const abs of walk(KERNEL)) {
    const rel = path.relative(REPO_ROOT, abs).replaceAll('\\', '/');
    const src = readFileSync(abs, 'utf8');
    if (/CREATE\s+TABLE/.test(src) && !rel.startsWith('src/workflow-kernel/persistence/')) {
      ddlOwners.push(rel);
    }
  }
  assert.deepEqual(ddlOwners, [],
    `CREATE TABLE outside src/workflow-kernel/persistence/**: ${ddlOwners.join(', ')}`);
});
