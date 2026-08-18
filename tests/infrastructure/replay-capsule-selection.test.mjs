import assert from 'node:assert/strict';
import test from 'node:test';

import { selectReplayCapsule } from '../../dist/infrastructure/replay/replay-capsule-selection.js';

test('replay aliases with equal payload select the NEWEST capsule (ADR-076 newest-wins)', () => {
  const aliases = [
    { capsule_ref: 'capsule:z', payload_hash: 'same' },
    { capsule_ref: 'capsule:a', payload_hash: 'same' },
  ];
  assert.equal(selectReplayCapsule('key', aliases)?.capsule_ref, 'capsule:a');
  assert.equal(selectReplayCapsule('key', [...aliases].reverse())?.capsule_ref, 'capsule:a');
});

test('replay aliases with divergent payloads resolve newest-wins (ADR-076: capsule exists = continue)', () => {
  const aliases = [
    { capsule_ref: 'capsule:a', payload_hash: 'hash:a' },
    { capsule_ref: 'capsule:b', payload_hash: 'hash:b' },
  ];
  // chronological order: the LAST capsule is the newest accepted material
  assert.equal(selectReplayCapsule('key:conflict', aliases)?.capsule_ref, 'capsule:b');
});

test('missing replay capsule remains a miss', () => {
  assert.equal(selectReplayCapsule('key:missing', []), undefined);
});
