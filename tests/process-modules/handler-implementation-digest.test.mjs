// tests/process-modules/handler-implementation-digest.test.mjs
//
// K3 commit 2/5 of the Saga Core Renewal program — reproducibility and
// sensitivity of the canonical handler-implementation digester.
//
// Invariants (ADR-076 closure evidence for the K3 family):
//   - checkout-independence: the same implementation file hashed from two
//     different directory roots yields the SAME digest;
//   - sensitivity: a one-byte change to the implementation changes the digest;
//   - fail-closed: a missing implementation file throws with the module label
//     and the resolved path, so a manifest can never load un-provably.
//
// Run: node --test tests/process-modules/handler-implementation-digest.test.mjs
// (after `npm run build` — imports are from dist/).

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handlerImplementationDigest } from '../../dist/process-modules/installation/domain/handler-implementation-digest.js';

function fixtureDir(root, name, content) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, 'impl'), { recursive: true });
  writeFileSync(path.join(dir, 'impl', 'installation.js'), content, 'utf8');
  return dir;
}

test('same implementation bytes hashed from different roots yield the SAME digest', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'k3-digest-'));
  try {
    const bytes = 'export function createHandlers() { return {}; }\n';
    const rootA = fixtureDir(root, 'checkout-a', bytes);
    const rootB = fixtureDir(root, 'deep/nested/checkout-b', bytes);
    const digestA = handlerImplementationDigest(rootA, path.join('impl', 'installation.js'), 'workshop-a');
    const digestB = handlerImplementationDigest(rootB, path.join('impl', 'installation.js'), 'workshop-b');
    assert.equal(digestA, digestB, 'digest must depend on bytes, not on checkout root or module label');
    assert.match(digestA, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a one-byte implementation change changes the digest', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'k3-digest-'));
  try {
    const dirA = fixtureDir(root, 'v1', 'export const V = 1;\n');
    const dirB = fixtureDir(root, 'v2', 'export const V = 2;\n');
    const digestA = handlerImplementationDigest(dirA, path.join('impl', 'installation.js'), 'w');
    const digestB = handlerImplementationDigest(dirB, path.join('impl', 'installation.js'), 'w');
    assert.notEqual(digestA, digestB);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing implementation file fails closed with label and resolved path', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'k3-digest-'));
  try {
    assert.throws(
      () => handlerImplementationDigest(root, path.join('impl', 'missing.js'), 'discovery'),
      (err) => err.message.includes('discovery')
        && err.message.includes('missing.js')
        && err.message.includes(root),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('timestamp changes alone do not change the digest (bytes are the only input)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'k3-digest-'));
  try {
    const dir = fixtureDir(root, 'ts', 'stable bytes\n');
    const first = handlerImplementationDigest(dir, path.join('impl', 'installation.js'), 'w');
    // Rewrite identical bytes (fresh mtime) and re-hash.
    writeFileSync(path.join(dir, 'impl', 'installation.js'), 'stable bytes\n');
    const second = handlerImplementationDigest(dir, path.join('impl', 'installation.js'), 'w');
    assert.equal(first, second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
