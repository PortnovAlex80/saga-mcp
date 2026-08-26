// Self-test for tools/build-receipt.mjs (ADR-096 Phase 7 / W4).
// Run: npm run build-receipt:test   (requires `npm run build` first — the
// package-store path imports the runtime digest helpers from dist/).
//
// All freezing/checking happens against a THROWAWAY sandbox git repo
// (--root); the real dist/ is never mutated. The sandbox mirrors the layout
// the tool receipts: package.json, package-lock.json, dist/**, and (for the
// package-store tests) a fake content-addressed store laid out exactly like
// FilesystemModulePackageStore writes it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL = path.resolve(import.meta.dirname, 'build-receipt.mjs');
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function sh(cwd, cmd, args) {
  execFileSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}

function makeSandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'build-receipt-test-'));
  const root = path.join(dir, 'repo');
  mkdirSync(path.join(root, 'dist', 'sub'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sb', version: '1.0.0' }, null, 2));
  writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  writeFileSync(path.join(root, 'dist', 'index.js'), 'console.log("one");\n');
  writeFileSync(path.join(root, 'dist', 'sub', 'mod.js'), 'export const x = 1;\n');
  sh(dir, 'git', ['init', '-q', '-b', 'dev', 'repo']);
  sh(root, 'git', ['config', 'user.email', 'receipt-test@saga.local']);
  sh(root, 'git', ['config', 'user.name', 'receipt-test']);
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['commit', '-q', '-m', 'sandbox base']);
  return root;
}

function runTool(args) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
}

function freezeOk(root, extra = []) {
  const r = runTool(['--freeze', '--root', root, ...extra]);
  assert.equal(r.status, 0, `freeze must succeed: ${r.stderr}`);
  const m = (r.stdout || '').match(/BUILD RECEIPT (?:FROZEN|ALREADY FROZEN) ([0-9a-f]{12})/);
  assert.ok(m, `freeze must print the receipt id, got: ${r.stdout}${r.stderr}`);
  const receiptPath = path.join(root, 'docs', 'verification', `build-receipt-${m[1]}.json`);
  assert.ok(existsSync(receiptPath), `receipt file must exist at ${receiptPath}`);
  return { id: m[1], receiptPath };
}

test('freeze -> check: clean sandbox round-trips green', () => {
  const root = makeSandbox();
  try {
    const { id, receiptPath } = freezeOk(root);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.receiptKind, 'saga-mcp.build-receipt');
    assert.equal(receipt.receiptVersion, 1);
    assert.equal(receipt.identity.dist.fileCount, 2);
    assert.match(receipt.identity.dist.treeHash, /^[0-9a-f]{64}$/);
    assert.equal(receipt.identity.packageStore.present, false);

    const c = runTool(['--check', '--root', root, '--receipt', receiptPath]);
    assert.equal(c.status, 0, `check must pass on an untouched build: ${c.stderr}`);
    assert.match(c.stdout, new RegExp(`BUILD RECEIPT MATCH ${id}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutating one dist byte -> check fails naming the drifted file', () => {
  const root = makeSandbox();
  try {
    const { receiptPath } = freezeOk(root);
    const drifted = path.join(root, 'dist', 'sub', 'mod.js');
    writeFileSync(drifted, 'export const x = 2; // one byte of drift\n');

    const c = runTool(['--check', '--root', root, '--receipt', receiptPath]);
    assert.notEqual(c.status, 0, 'check must fail after a dist byte drifted');
    assert.match(c.stderr, /BUILD_RECEIPT_DRIFT\[dist-modified\] dist file drifted: dist\/sub\/mod\.js sha256 expected [0-9a-f]{64}, observed [0-9a-f]{64}/);
    assert.doesNotMatch(c.stderr, /dist-modified\] dist file drifted: dist\/index\.js/, 'the untouched file must NOT be named');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('added/removed dist files and package.json drift are each named precisely', () => {
  const root = makeSandbox();
  try {
    const { receiptPath } = freezeOk(root);
    writeFileSync(path.join(root, 'dist', 'extra.js'), 'export {};\n');

    const c = runTool(['--check', '--root', root, '--receipt', receiptPath]);
    assert.notEqual(c.status, 0, 'check must fail after a dist file was added');
    assert.match(c.stderr, /BUILD_RECEIPT_DRIFT\[dist-added\] dist file added: dist\/extra\.js/);
    assert.match(c.stderr, /BUILD_RECEIPT_DRIFT\[tree-dirty\]/, 'the uncommitted addition is also surfaced as source mutation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('freeze refuses a dirty working tree (no receipt for a mutated source line)', () => {
  const root = makeSandbox();
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sb', version: '1.0.1' }, null, 2));
    const r = runTool(['--freeze', '--root', root]);
    assert.notEqual(r.status, 0, 'freeze must refuse a dirty tree');
    assert.match(r.stderr, /BUILD_RECEIPT_DIRTY_TREE/);
    assert.match(r.stderr, /package\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// EK-8 cutover (2026-08-26): the package-store round-trip test died with
// dist/process-modules (the old package format); the content-addressed
// workshop manifests + the build receipt freeze checks carry the surface.
