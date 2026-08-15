import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLifecycleDefinitionCompatibility } from '../../dist/process-modules/application/lifecycle-definition-compatibility.js';

const base = {
  identity: { name: 'factory', version: '1', displayName: 'Factory', description: 'old' },
  entryStageId: 'a',
  stages: [{
    id: 'a', displayName: 'A', moduleRef: { name: 'm', version: '1' },
    inputMapping: { x: '$.x' }, outputMapping: { y: '$.y' },
    outcomeRoutes: { ok: { type: 'terminal', status: 'done' } },
    entryConditions: ['old note'], exitConditions: [],
  }],
};

test('definition compatibility accepts metadata-only edits', () => {
  const changed = structuredClone(base);
  changed.identity.description = 'new';
  changed.stages[0].displayName = 'Renamed';
  changed.stages[0].entryConditions = ['new note'];
  assert.equal(
    classifyLifecycleDefinitionCompatibility(JSON.stringify(base), JSON.stringify(changed)).classification,
    'metadata_only',
  );
});

test('definition compatibility rejects routing or mapping edits', () => {
  const changed = structuredClone(base);
  changed.stages[0].inputMapping = { x: '$.different' };
  assert.equal(
    classifyLifecycleDefinitionCompatibility(JSON.stringify(base), JSON.stringify(changed)).classification,
    'incompatible',
  );
});
