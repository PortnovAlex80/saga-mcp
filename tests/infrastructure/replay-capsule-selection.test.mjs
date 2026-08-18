import assert from 'node:assert/strict';
import test from 'node:test';

import { selectReplayCapsule } from '../../dist/infrastructure/replay/replay-capsule-selection.js';

test('equal payloads under one semantic key are aliases and resolve deterministically', () => {
  const aliases = [
    { capsule_ref: 'capsule:z', payload_hash: 'same' },
    { capsule_ref: 'capsule:a', payload_hash: 'same' },
  ];
  const forward = selectReplayCapsule('key', aliases);
  const reversed = selectReplayCapsule('key', [...aliases].reverse());
  assert.equal(forward.outcome, 'hit');
  assert.equal(forward.capsule.capsule_ref, 'capsule:a');
  // Insertion order must NOT change the answer: selection is by stable ref,
  // never by rowid/recency (CONVEYOR §9, DRAGON law #1).
  assert.deepEqual(reversed, forward);

  const single = selectReplayCapsule('key', aliases.slice(0, 1));
  assert.equal(single.outcome, 'hit');
  assert.equal(single.capsule.capsule_ref, 'capsule:z');
});

test('divergent payloads under one semantic key are a typed conflict, never newest-wins', () => {
  const aliases = [
    { capsule_ref: 'capsule:a', payload_hash: 'hash:a' },
    { capsule_ref: 'capsule:b', payload_hash: 'hash:b' },
  ];
  const selection = selectReplayCapsule('key:conflict', aliases);
  // NOT 'hit' on the newest row: recency is not material authority. The caller
  // records ADR-080 §2 invalidation evidence and degrades to a normal miss.
  assert.equal(selection.outcome, 'conflict');
  assert.deepEqual(
    selection.capsules.map(capsule => capsule.capsule_ref).sort(),
    ['capsule:a', 'capsule:b'],
  );
  // Order-independent: a conflict is a property of the key, not of arrival order.
  assert.equal(selectReplayCapsule('key:conflict', [...aliases].reverse()).outcome, 'conflict');
});

test('missing replay capsule remains a miss', () => {
  assert.deepEqual(selectReplayCapsule('key:missing', []), { outcome: 'miss' });
});
