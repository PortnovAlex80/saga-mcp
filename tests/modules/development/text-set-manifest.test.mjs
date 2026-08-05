/**
 * TextSetManifest tests (Conveyor v4, step 3.C.1).
 *
 * Target contract: REG-11-AC-05 (TextSet paths/modes/rename/delete + digest).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEXT_SET_SCHEMA,
  computeTextSetDigest,
  buildTextSetProductRef,
  assertValidTextSetEntry,
  assertValidTextSetManifest,
} from '../../../dist/modules/development/domain/text-set-manifest.js';

const DIGEST = 'a'.repeat(64);

test('REG-11-AC-05: digest is order-independent (entries sorted by path)', () => {
  const m1 = {
    entries: [
      { path: 'src/b.ts', operation: 'create', blobRef: 'blob-b', digest: DIGEST },
      { path: 'src/a.ts', operation: 'create', blobRef: 'blob-a', digest: DIGEST },
    ],
  };
  const m2 = {
    entries: [
      { path: 'src/a.ts', operation: 'create', blobRef: 'blob-a', digest: DIGEST },
      { path: 'src/b.ts', operation: 'create', blobRef: 'blob-b', digest: DIGEST },
    ],
  };
  assert.equal(computeTextSetDigest(m1), computeTextSetDigest(m2));
});

test('REG-11-AC-05: different content → different digest', () => {
  const m1 = { entries: [{ path: 'a.ts', operation: 'create', blobRef: 'x', digest: DIGEST }] };
  const m2 = { entries: [{ path: 'a.ts', operation: 'create', blobRef: 'y', digest: DIGEST }] };
  assert.notEqual(computeTextSetDigest(m1), computeTextSetDigest(m2));
});

test('REG-11: buildTextSetProductRef produces saga3.text-set.v1', () => {
  const m = { entries: [{ path: 'a.ts', operation: 'create', blobRef: 'b', digest: DIGEST }] };
  const ref = buildTextSetProductRef(m);
  assert.equal(ref.schemaId, TEXT_SET_SCHEMA);
  assert.ok(ref.ref.startsWith('text-set:'));
  assert.equal(ref.digest, computeTextSetDigest(m));
});

test('REG-11-AC-05: create without blobRef rejected', () => {
  assert.throws(
    () => assertValidTextSetEntry({ path: 'a.ts', operation: 'create' }),
    /blobRef/,
  );
});

test('REG-11-AC-05: create without digest rejected', () => {
  assert.throws(
    () => assertValidTextSetEntry({ path: 'a.ts', operation: 'create', blobRef: 'b' }),
    /digest/,
  );
});

test('REG-11-AC-05: rename without fromPath rejected', () => {
  assert.throws(
    () => assertValidTextSetEntry({ path: 'b.ts', operation: 'rename' }),
    /fromPath/,
  );
});

test('REG-11-AC-05: delete with blobRef rejected', () => {
  assert.throws(
    () => assertValidTextSetEntry({ path: 'a.ts', operation: 'delete', blobRef: 'b', digest: DIGEST }),
    /delete must not carry/,
  );
});

test('REG-11-AC-05: path escape (..) rejected', () => {
  assert.throws(
    () => assertValidTextSetEntry({ path: '../escape.ts', operation: 'delete' }),
    /\.\./,
  );
});

test('REG-11-AC-05: absolute path rejected', () => {
  assert.throws(
    () => assertValidTextSetEntry({ path: '/abs.ts', operation: 'delete' }),
    /relative/,
  );
});

test('REG-11: duplicate path in manifest rejected', () => {
  assert.throws(
    () => assertValidTextSetManifest({
      entries: [
        { path: 'a.ts', operation: 'delete' },
        { path: 'a.ts', operation: 'delete' },
      ],
    }),
    /duplicate/,
  );
});

test('REG-11: empty manifest rejected', () => {
  assert.throws(() => assertValidTextSetManifest({ entries: [] }), /non-empty/);
});

test('REG-11: valid manifest with all four operations passes', () => {
  assert.doesNotThrow(() => assertValidTextSetManifest({
    entries: [
      { path: 'new.ts', operation: 'create', blobRef: 'b1', digest: DIGEST, mediaType: 'text/x-typescript' },
      { path: 'mod.ts', operation: 'modify', blobRef: 'b2', digest: DIGEST },
      { path: 'old.ts', operation: 'rename', fromPath: 'older.ts' },
      { path: 'gone.ts', operation: 'delete' },
    ],
  }));
});
