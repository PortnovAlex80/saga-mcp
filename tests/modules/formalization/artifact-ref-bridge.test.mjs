/**
 * ArtifactRefBridge tests (Conveyor v4, step 3.A.1).
 *
 * Target contract: REG-11 (Изделие — artifact reference on the desk).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARTIFACT_REF_SCHEMA,
  buildArtifactProductRef,
  parseArtifactProductRef,
  artifactHashMatchesRef,
} from '../../../dist/modules/formalization/domain/artifact-ref-bridge.js';

const HASH = 'a'.repeat(64);

test('REG-11: buildArtifactProductRef produces factory.artifact-ref.v1', () => {
  const ref = buildArtifactProductRef({ artifactId: 42, contentHash: HASH });
  assert.equal(ref.schemaId, ARTIFACT_REF_SCHEMA);
  assert.equal(ref.ref, `artifact:42#${HASH}`);
  assert.equal(ref.digest, HASH);
});

test('REG-11: parseArtifactProductRef round-trips', () => {
  const ref = buildArtifactProductRef({ artifactId: 99, contentHash: HASH });
  const parsed = parseArtifactProductRef(ref);
  assert.equal(parsed.artifactId, 99);
  assert.equal(parsed.contentHash, HASH);
});

test('REG-11: buildArtifactProductRef rejects bad artifactId', () => {
  assert.throws(
    () => buildArtifactProductRef({ artifactId: 0, contentHash: HASH }),
    /positive integer/,
  );
  assert.throws(
    () => buildArtifactProductRef({ artifactId: -1, contentHash: HASH }),
    /positive integer/,
  );
});

test('REG-11: buildArtifactProductRef rejects bad hash', () => {
  assert.throws(
    () => buildArtifactProductRef({ artifactId: 1, contentHash: 'short' }),
    /64-char/,
  );
});

test('REG-11: parseArtifactProductRef rejects wrong schema', () => {
  assert.throws(
    () => parseArtifactProductRef({ schemaId: 'other', ref: 'x', digest: 'd' }),
    /expected schema/,
  );
});

test('REG-11: parseArtifactProductRef rejects malformed ref', () => {
  assert.throws(
    () => parseArtifactProductRef({ schemaId: ARTIFACT_REF_SCHEMA, ref: 'not-an-artifact', digest: HASH }),
    /does not match/,
  );
});

test('REG-11-AC-02: artifactHashMatchesRef returns true on match', () => {
  const ref = buildArtifactProductRef({ artifactId: 1, contentHash: HASH });
  assert.equal(artifactHashMatchesRef(HASH, ref), true);
});

test('REG-11-AC-02: artifactHashMatchesRef returns false on drift', () => {
  const ref = buildArtifactProductRef({ artifactId: 1, contentHash: HASH });
  assert.equal(artifactHashMatchesRef('b'.repeat(64), ref), false);
});

test('REG-11-AC-02: artifactHashMatchesRef returns false on null hash', () => {
  const ref = buildArtifactProductRef({ artifactId: 1, contentHash: HASH });
  assert.equal(artifactHashMatchesRef(null, ref), false);
});
