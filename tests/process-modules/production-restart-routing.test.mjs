// tests/process-modules/production-restart-routing.test.mjs
//
// K5 commit 4/6 of the Saga Core Renewal program — explicit routing of the
// rewritten-handler refusal at the production boot path.
//
// Theorem: installModulePackages (the same path the composition root uses
// for the four built-in modules) fails with the TYPED
// PRODUCTION_RESUME_RESTART_REQUIRED refusal — naming the module and the
// pinned package — when a boot re-install carries rewritten handler
// implementations under stable logicalIds. The first (v1) installation
// remains active and untouched: terminal/accepted history is never mutated,
// and each pinned run needs an explicit new lifecycle.
//
// Run: node --test tests/process-modules/production-restart-routing.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const { installModulePackages } = await import(
  '../../dist/process-modules/installation/production-install.js'
);
const { createProcessModuleManifest } = await import(
  '../../dist/process-modules/domain/spi/manifest-factory.js'
);
const { default: lmMarketingModule } = await import(
  '../fixtures/synthetic-modules/lm-marketing/definition.mjs'
);

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function buildRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'k5-routing-'));
  mkdirSync(path.join(root, 'skills'), { recursive: true });
  writeFileSync(path.join(root, 'skills', 's.md'), 'skill bytes', 'utf8');
  const resourceDigest = sha(new TextEncoder().encode('skill bytes'));
  const handlerV1 = sha(new TextEncoder().encode('handler implementation v1'));
  const handlerV2 = sha(new TextEncoder().encode('handler implementation v2 REWRITTEN'));

  const manifestFor = (handlerDigest) => {
    const baseline = createProcessModuleManifest(lmMarketingModule);
    return {
      ...baseline,
      resourceIndex: [
        { logicalId: 'semantic-skill', path: 'skills/s.md', kind: 'skill', digest: resourceDigest },
      ],
      handlerRefs: [
        { logicalId: 'draft-campaign-handler', version: '0.1.0', digest: handlerDigest },
      ],
    };
  };
  return { root, manifestFor, handlerV1, handlerV2 };
}

test('K5: boot re-install with rewritten handler routes to PRODUCTION_RESUME_RESTART_REQUIRED', async () => {
  const { root, manifestFor, handlerV1, handlerV2 } = buildRoot();
  const db = new Database(':memory:');
  try {
    const v1 = await installModulePackages(db, root, [manifestFor(handlerV1)]);
    assert.ok(v1.records.size >= 1, 'v1 installs');

    await assert.rejects(
      () => installModulePackages(db, root, [manifestFor(handlerV2)]),
      (err) => {
        assert.equal(err.code, undefined); // plain typed-refusal Error, cause carries installer code
        assert.match(err.message, /PRODUCTION_RESUME_RESTART_REQUIRED/);
        assert.match(err.message, /handler implementations/);
        assert.match(err.message, /draft-campaign-handler|non-terminal/);
        assert.equal(err.cause?.code, 'MODULE_INSTALLATION_RESTART_REQUIRED');
        return true;
      },
      'the boot path must route the refusal explicitly, not crash raw',
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('K5: identical re-install (no rewrite) stays idempotent at the boot path', async () => {
  const { root, manifestFor, handlerV1 } = buildRoot();
  const db = new Database(':memory:');
  try {
    const a = await installModulePackages(db, root, [manifestFor(handlerV1)]);
    const b = await installModulePackages(db, root, [manifestFor(handlerV1)]);
    const name = lmMarketingModule.identity.name;
    assert.equal(
      a.records.get(name).packageDigest,
      b.records.get(name).packageDigest,
      'same manifest re-installs to the same pinned package',
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
