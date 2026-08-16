import assert from 'node:assert/strict';
import test from 'node:test';

import { selectReplayCapsule } from '../../dist/infrastructure/replay/replay-capsule-selection.js';

test('replay aliases with equal payload select a stable capsule independent of row order', () => {
  const aliases = [
    { capsule_ref: 'capsule:z', payload_hash: 'same' },
    { capsule_ref: 'capsule:a', payload_hash: 'same' },
  ];
  assert.equal(selectReplayCapsule('key', aliases)?.capsule_ref, 'capsule:a');
  assert.equal(selectReplayCapsule('key', [...aliases].reverse())?.capsule_ref, 'capsule:a');
});

test('replay aliases with divergent payloads fail closed', () => {
  assert.throws(
    () => selectReplayCapsule('key:conflict', [
      { capsule_ref: 'capsule:a', payload_hash: 'hash:a' },
      { capsule_ref: 'capsule:b', payload_hash: 'hash:b' },
    ]),
    /REPLAY_KEY_PAYLOAD_CONFLICT:key:conflict/,
  );
});

test('missing replay capsule remains a miss', () => {
  assert.equal(selectReplayCapsule('key:missing', []), undefined);
});
