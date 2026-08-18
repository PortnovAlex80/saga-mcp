// tests/installation/handler-digest-rejection.test.mjs
//
// K3 commit 1/5 of the Saga Core Renewal program — the rejection theorem.
//
// A HandlerRef.digest of 'pending@wave-2' is an authoring-time placeholder.
// Resources may keep it (the installer stamps real bytes at install, Step
// 3.5); HANDLERS may not: the installed package must prove WHICH executable
// implementation it pins, and nothing may install a package whose handler
// identity is a placeholder. Before K3 the validator accepted any non-empty
// digest — this theorem pinned the prohibited behavior.
//
// Run: node --test tests/installation/handler-digest-rejection.test.mjs
// (after `npm run build` — imports are from dist/).

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

const { createProcessModuleManifest } = await import(
  '../../dist/process-modules/domain/spi/manifest-factory.js'
);
const {
  validateProcessModuleManifest,
  PENDING_DIGEST,
} = await import(
  '../../dist/process-modules/domain/spi/module-manifest.js'
);
const { default: lmMarketingModule } = await import(
  '../fixtures/synthetic-modules/lm-marketing/definition.mjs'
);

function realHandlerDigest(content = 'handler implementation bytes') {
  return createHash('sha256').update(content).digest('hex');
}

function buildManifestWithHandler(handlerDigest) {
  const baseline = createProcessModuleManifest(lmMarketingModule);
  return {
    ...baseline,
    handlerRefs: [
      { logicalId: 'draft-campaign-handler', version: '0.1.0', digest: handlerDigest },
    ],
  };
}

test('validateProcessModuleManifest rejects a placeholder handler digest', () => {
  const manifest = buildManifestWithHandler(PENDING_DIGEST);
  const validation = validateProcessModuleManifest(manifest);
  assert.equal(validation.ok, false, 'placeholder handler digest must not validate');
  const code = validation.errors?.find(e => e.code === 'HANDLER_DIGEST_PENDING');
  assert.ok(code, `expected HANDLER_DIGEST_PENDING among errors: ${JSON.stringify(validation.errors?.map(e => e.code))}`);
});

test('validateProcessModuleManifest accepts the same manifest with a real digest', () => {
  const manifest = buildManifestWithHandler(realHandlerDigest());
  const validation = validateProcessModuleManifest(manifest);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors?.map(e => `${e.code}:${e.message}`)));
});

test('placeholder handler digest is rejected regardless of position', () => {
  const manifest = buildManifestWithHandler(realHandlerDigest());
  manifest.handlerRefs = [
    { logicalId: 'handler-a', version: '0.1.0', digest: realHandlerDigest('a') },
    { logicalId: 'handler-b', version: '0.1.0', digest: PENDING_DIGEST },
  ];
  const validation = validateProcessModuleManifest(manifest);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors?.some(e => e.code === 'HANDLER_DIGEST_PENDING'));
});

test('resources may still carry the documented placeholder (installer stamps them)', () => {
  const manifest = buildManifestWithHandler(realHandlerDigest());
  manifest.resourceIndex = [
    { logicalId: 'semantic-skill', path: 'skills/s.md', kind: 'skill', digest: PENDING_DIGEST },
  ];
  const validation = validateProcessModuleManifest(manifest);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors?.map(e => `${e.code}:${e.message}`)));
});

// ---------------------------------------------------------------------------
// K5: rewritten handler under a stable logicalId must fail the install
// drift path with the typed restart-required error — never a silent retire.
// ---------------------------------------------------------------------------

test('K5: installer-classified rewritten handler drift surfaces as restart-required', async () => {
  const { classifyResumeCompatibility } = await import(
    '../../dist/process-modules/installation/domain/resume-compatibility-policy.js'
  );
  const digestA = 'a'.repeat(64);
  const digestB = 'b'.repeat(64);
  const record = {
    id: 1,
    name: 'solution-development',
    version: '1.0.0',
    packageDigest: 'old-pkg',
    manifestSnapshot: {
      manifestFormatVersion: '1.0.0',
      definition: { identity: { name: 'solution-development', version: '1.0.0', displayName: 'D', description: 'd' } },
      inputContractRef: { schemaId: 'in.v1', version: '1', digest: 'i'.repeat(64) },
      outputContractRef: { schemaId: 'out.v1', version: '1', digest: 'o'.repeat(64) },
      handlerRefs: [
        { logicalId: 'dev-kernel-1', version: '1.0.0', digest: digestA },
        { logicalId: 'dev-kernel-2', version: '1.0.0', digest: 'c'.repeat(64) },
      ],
      resourceIndex: [],
      nodeProtocols: [],
    },
    status: 'active',
    installedAt: '2026-08-01T00:00:00Z',
    storeLocation: '/tmp/pkg',
    resourceIndex: [],
    handlerRefs: [
      { logicalId: 'dev-kernel-1', version: '1.0.0', digest: digestA },
      { logicalId: 'dev-kernel-2', version: '1.0.0', digest: 'c'.repeat(64) },
    ],
    dependencyLock: { entries: [], lockDigest: 'lock' },
  };
  const attempted = JSON.parse(JSON.stringify(record.manifestSnapshot));
  attempted.handlerRefs[0].digest = digestB;

  const verdict = classifyResumeCompatibility(record, 'new-pkg', attempted);
  assert.equal(verdict.outcome, 'restart-required');
  assert.deepEqual(verdict.changedHandlerImplementations, [
    'dev-kernel-1: aaaaaaaaaaaa… → bbbbbbbbbbbb…',
  ]);
  assert.ok(verdict.reason.includes('rewritten'), `reason should name the rewrite: ${verdict.reason}`);
});
