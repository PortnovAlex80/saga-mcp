// tools/module-authoring-kit/scaffold.test.mjs
//
// W10-A5 — Module Authoring Kit: scaffold round-trip tests.
//
// For each template node-kind: scaffold a package into a temp dir, assert the
// expected files exist, no {{PLACEHOLDER}} remains, and the scaffolded manifest
// passes BOTH `validate` and `conform`. This is the core authoring-loop proof:
// a developer runs `scaffold` then `conform` and gets a green, installable
// package with zero manual edits.
//
// Run: node --test tools/module-authoring-kit/scaffold.test.mjs
// (requires a prior `npm run build` so dist/ is present).

import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { scaffoldPackage, parseVars, TEMPLATE_KINDS, validateManifestFile } from './validator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Create a unique temp dir for a test; returns { dir, cleanup }. */
function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), `mak-${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Common vars used across all scaffolds. */
function baseVars(suffix) {
  return {
    MODULE_NAME: `kit-e2e-${suffix}`,
    MODULE_VERSION: '0.1.0',
    MODULE_KIND: `kind-${suffix}`,
    MODULE_DISPLAY_NAME: `Kit E2E ${suffix}`,
    MODULE_DESCRIPTION: `Scaffolded package for the ${suffix} authoring-loop test.`,
  };
}

for (const kind of TEMPLATE_KINDS) {
  test(`scaffold + conform round-trip for ${kind}`, () => {
    const { dir, cleanup } = tempDir(kind);
    try {
      const outDir = path.join(dir, 'pkg');
      const r = scaffoldPackage(kind, outDir, baseVars(kind));
      assert.equal(r.kind, kind);
      // Every template ships at least these three files.
      assert.ok(r.filesWritten.includes('manifest.json'), 'manifest.json missing');
      assert.ok(r.filesWritten.includes('definition.mjs'), 'definition.mjs missing');
      assert.ok(r.filesWritten.includes('package.json'), 'package.json missing');
      for (const f of r.filesWritten) {
        assert.ok(existsSync(path.join(outDir, f)), `scaffolded file missing: ${f}`);
      }
      // No placeholder may survive substitution.
      for (const f of r.filesWritten) {
        const content = readFileSync(path.join(outDir, f), 'utf8');
        const leftover = content.match(/{{[A-Z_]+}}/g);
        assert.equal(leftover, null, `file ${f} has leftover placeholders: ${leftover}`);
      }
      // The scaffolded manifest must validate AND conform.
      const manifestPath = path.join(outDir, 'manifest.json');
      const v = validateManifestFile(manifestPath);
      assert.equal(v.ok, true, `${kind} manifest invalid: ${JSON.stringify(v.errors)}`);
      // conform runs the extra resource-existence check; do it inline here by
      // invoking the validator's conform path via the file API (resources exist
      // on disk because scaffold copied them).
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      for (const entry of manifest.resourceIndex || []) {
        assert.ok(
          existsSync(path.join(outDir, entry.path)),
          `resource ${entry.logicalId} -> ${entry.path} not present after scaffold`,
        );
      }
    } finally {
      cleanup();
    }
  });
}

test('scaffold refuses to clobber a non-empty directory', () => {
  const { dir, cleanup } = tempDir('clobber');
  try {
    const outDir = path.join(dir, 'pkg');
    // Pre-create a file in the target so it is non-empty.
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'blocker'), 'x');
    assert.throws(
      () => scaffoldPackage('lm-node', outDir, baseVars('clobber')),
      /exists and is not empty/,
    );
  } finally {
    cleanup();
  }
});

test('scaffold rejects an unknown node kind', () => {
  const { dir, cleanup } = tempDir('badkind');
  try {
    assert.throws(
      () => scaffoldPackage('not-a-kind', path.join(dir, 'x'), baseVars('badkind')),
      /unknown node kind/,
    );
  } finally {
    cleanup();
  }
});

test('scaffold requires MODULE_NAME and MODULE_VERSION', () => {
  const { dir, cleanup } = tempDir('noargs');
  try {
    assert.throws(
      () => scaffoldPackage('lm-node', path.join(dir, 'x'), { MODULE_NAME: 'x' }),
      /MODULE_VERSION/,
    );
    assert.throws(
      () => scaffoldPackage('lm-node', path.join(dir, 'x'), { MODULE_VERSION: '1.0.0' }),
      /MODULE_NAME/,
    );
  } finally {
    cleanup();
  }
});

test('parseVars parses key=value entries and rejects malformed input', () => {
  assert.deepEqual(parseVars(['A=1', 'B=two']), { A: '1', B: 'two' });
  assert.deepEqual(parseVars([]), {});
  assert.throws(() => parseVars(['noequals']), /key=value/);
  assert.throws(() => parseVars(['=nokey']), /key=value/);
});

test('scaffold derives optional vars from MODULE_NAME when omitted', () => {
  const { dir, cleanup } = tempDir('defaults');
  try {
    const outDir = path.join(dir, 'pkg');
    scaffoldPackage('kernel-node', outDir, { MODULE_NAME: 'derived', MODULE_VERSION: '0.2.0' });
    const manifest = JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    // KIND defaults to name; DISPLAY_NAME defaults to name; DESCRIPTION is generated.
    assert.equal(manifest.definition.identity.kind, 'derived');
    assert.equal(manifest.definition.identity.displayName, 'derived');
    assert.ok(manifest.definition.identity.description.includes('derived'));
  } finally {
    cleanup();
  }
});
