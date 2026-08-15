import assert from 'node:assert/strict';
import test from 'node:test';

import {
  developmentVerificationContinuationProcessModule as module,
} from '../../dist/process-modules/modules/development/development-verification-continuation-process-module.js';

test('verification continuation cannot repeat Development production', () => {
  assert.equal(module.flow.entryNodeId, 'adopt-verification-baseline');
  const nodeIds = new Set(module.flow.nodes.map(node => node.id));
  assert.ok(nodeIds.has('verify-acceptance'));
  assert.ok(nodeIds.has('settle-development'));
  for (const forbidden of [
    'plan-task-graph',
    'resolve-task-graph',
    'implement-work-items',
    'freeze-integrated-candidate',
  ]) assert.equal(nodeIds.has(forbidden), false, forbidden);
  assert.deepEqual(
    module.executionProfiles.map(profile => profile.id),
    ['development-verification-worker'],
  );
  assert.equal(
    module.flow.nodes.some(node =>
      node.kind === 'production-cell'
      && node.cellDefinition?.postAcceptanceEffect === 'git-integration'),
    false,
  );
});

test('verification continuation topology has no route back into production', () => {
  const allowed = new Set(module.flow.nodes.map(node => node.id));
  for (const transition of module.flow.transitions) {
    assert.ok(allowed.has(transition.from), transition.from);
    assert.ok(allowed.has(transition.to), transition.to);
  }
});
