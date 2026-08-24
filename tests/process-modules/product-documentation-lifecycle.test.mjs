// tests/process-modules/product-documentation-lifecycle.test.mjs
//
// Topology tests for the product-documentation lifecycle (mirrors the
// product-build lifecycle architecture test). Imports run against dist/.
//
// Coverage:
//   - productDocumentationLifecycle has exactly four stages and replaces the
//     delivery stage with documentation-release;
//   - Development `verified` routes to documentation-release (not delivery,
//     not terminal) — documentation is part of product construction;
//   - documentation `documented` terminates `runnable-local` (law 12:
//     documentation never releases), `blocked` terminates
//     `documentation-blocked` (continuable), `failed` terminates `failed`;
//   - every cross-stage inputMapping path references an existing stage (F2);
//   - the DEFAULT product-build lifecycle is untouched: three stages, no
//     documentation stage, verified → terminal runnable-local;
//   - the documentation profile assertion rejects malformed profiles.

import assert from 'node:assert/strict';
import test from 'node:test';

import { productDocumentationLifecycle } from '../../dist/process-modules/lifecycles/product-documentation-lifecycle.js';
import { assertProductDocumentationProfile } from '../../dist/process-modules/lifecycles/product-documentation-lifecycle.js';
import { productBuildLifecycle } from '../../dist/process-modules/lifecycles/product-build-lifecycle.js';

test('product-documentation replaces delivery with documentation-release', () => {
  const stageIds = productDocumentationLifecycle.stages.map(stage => stage.id);
  assert.deepEqual(stageIds, [
    'initial-discovery',
    'solution-formalization',
    'solution-development',
    'documentation-release',
  ]);
});

test('verified Development routes to documentation-release', () => {
  const development = productDocumentationLifecycle.stages
    .find(stage => stage.id === 'solution-development');
  assert.deepEqual(development.outcomeRoutes.verified, {
    type: 'stage',
    stageId: 'documentation-release',
  });
});

test('documentation outcomes terminate honestly', () => {
  const documentation = productDocumentationLifecycle.stages
    .find(stage => stage.id === 'documentation-release');
  assert.deepEqual(documentation.outcomeRoutes.documented, {
    type: 'terminal',
    status: 'runnable-local',
  });
  assert.deepEqual(documentation.outcomeRoutes.blocked, {
    type: 'terminal',
    status: 'documentation-blocked',
  });
  assert.deepEqual(documentation.outcomeRoutes.failed, {
    type: 'terminal',
    status: 'failed',
  });
});

test('documentation stage inputMapping references only existing stages', () => {
  const stageIds = new Set([
    ...productDocumentationLifecycle.stages.map(stage => stage.id),
    ...(productDocumentationLifecycle.inheritedStages ?? []).map(stage => stage.id),
  ]);
  const documentation = productDocumentationLifecycle.stages
    .find(stage => stage.id === 'documentation-release');
  for (const expression of Object.values(documentation.inputMapping)) {
    if (typeof expression !== 'string') continue;
    if (!expression.startsWith('$.stages.')) continue;
    const referenced = expression.slice('$.stages.'.length).split('.')[0];
    assert.ok(stageIds.has(referenced), `unknown stage reference ${referenced}`);
  }
  // The documentation profile is a required root-input member of the stage.
  assert.equal(documentation.inputMapping.documentKinds, '$.documentation.kinds');
  assert.equal(documentation.inputMapping.outputRoot, '$.documentation.outputRoot');
});

test('default product-build lifecycle is untouched', () => {
  const stageIds = productBuildLifecycle.stages.map(stage => stage.id);
  assert.deepEqual(stageIds, [
    'initial-discovery',
    'solution-formalization',
    'solution-development',
  ]);
  const development = productBuildLifecycle.stages
    .find(stage => stage.id === 'solution-development');
  assert.deepEqual(development.outcomeRoutes.verified, {
    type: 'terminal',
    status: 'runnable-local',
  });
});

test('documentation profile assertion rejects malformed profiles', () => {
  assert.throws(() => assertProductDocumentationProfile(null));
  assert.throws(() => assertProductDocumentationProfile({ kinds: [], outputRoot: '/tmp/x' }));
  assert.throws(() => assertProductDocumentationProfile({ kinds: ['user-manual'], outputRoot: ' ' }));
  assert.throws(() => assertProductDocumentationProfile({ kinds: ['user-manual'] }));
  assert.doesNotThrow(() => assertProductDocumentationProfile({
    kinds: ['user-manual', 'acceptance-report'],
    outputRoot: 'D:/tmp/docs',
  }));
});
