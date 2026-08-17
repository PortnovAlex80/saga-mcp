// tests/architecture/package-identity-single-surface.test.mjs
//
// K4 commit 5/5 of the Saga Core Renewal program (ADR-077 §4).
//
// One compatibility surface: package identity is computed, compared, and
// rehydrated ONLY through the canonical installation-domain modules. This
// ratchet fails when:
//   - a second package-digest formula appears anywhere in src (the deleted
//     application/process-module-package.ts carried exactly such a parallel
//     formula with a DIFFERENT input shape);
//   - computePackageDigest / computeRuntimePackageFingerprint /
//     runtimeFingerprintOf are imported outside the installation domain and
//     its adapters (a private identity subset in the making);
//   - a compatibility decision is taken WITHOUT classifyResumeCompatibility
//     on a path that already knows about installations (the single lawful
//     decision entry point).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirnameOf(import.meta.url), '../..');

function dirnameOf(url) {
  return join(fileURLToPath(url), '..');
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

const srcFiles = walk(join(repoRoot, 'src')).map(p => relative(repoRoot, p).replace(/\\/g, '/'));
const content = new Map(srcFiles.map(f => [f, readFileSync(join(repoRoot, f), 'utf8')]));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('exactly ONE package-digest formula definition exists in src', () => {
  const definers = srcFiles.filter(f => /export function computePackageDigest/.test(content.get(f)));
  assert.deepEqual(
    definers,
    ['src/process-modules/installation/domain/package-store.ts'],
    `parallel identity formulas are the ADR-77-prohibited private surface: ${definers.join(', ')}`,
  );
});

test('fingerprint machinery is imported only inside the installation domain and its adapters', () => {
  const allowedPrefixes = [
    'src/process-modules/installation/',
    'src/process-modules/persistence/process-module-installation-record.ts',
  ];
  const canonical = [
    'computePackageDigest',
    'computeRuntimePackageFingerprint',
    'runtimeFingerprintOf',
  ];
  const offenders = [];
  for (const f of srcFiles) {
    if (allowedPrefixes.some(p => f.startsWith(p) || f === p)) continue;
    const code = stripComments(content.get(f));
    for (const name of canonical) {
      if (new RegExp(`\\b${name}\\b`).test(code)) offenders.push(`${f} references ${name}`);
    }
  }
  assert.deepEqual(offenders, [], 'ADR-77 s4: no private subset of package identity outside installation domain');
});

test('classifyResumeCompatibility remains the single compatibility decision entry point', () => {
  const definers = srcFiles.filter(f => /export function classifyResumeCompatibility/.test(content.get(f)));
  assert.deepEqual(definers, ['src/process-modules/installation/domain/resume-compatibility-policy.ts']);
});
