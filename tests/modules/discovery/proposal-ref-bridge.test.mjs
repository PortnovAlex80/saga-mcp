/**
 * ProposalRefBridge tests (Conveyor v4, step 3.B.1).
 *
 * Target contract: REG-11 (proposal reference on the desk).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROPOSAL_REF_SCHEMA,
  buildProposalProductRef,
  parseProposalProductRef,
  proposalHashMatchesRef,
} from '../../../dist/modules/discovery/domain/proposal-ref-bridge.js';

const HASH = 'b'.repeat(64);

test('REG-11: buildProposalProductRef produces factory.discovery-proposal-ref.v1', () => {
  const ref = buildProposalProductRef({ proposalId: 7, contentHash: HASH });
  assert.equal(ref.schemaId, PROPOSAL_REF_SCHEMA);
  assert.equal(ref.ref, `proposal:7#${HASH}`);
  assert.equal(ref.digest, HASH);
});

test('REG-11: parseProposalProductRef round-trips', () => {
  const ref = buildProposalProductRef({ proposalId: 42, contentHash: HASH });
  const parsed = parseProposalProductRef(ref);
  assert.equal(parsed.proposalId, 42);
  assert.equal(parsed.contentHash, HASH);
});

test('REG-11: build rejects bad proposalId', () => {
  assert.throws(() => buildProposalProductRef({ proposalId: 0, contentHash: HASH }), /positive integer/);
});

test('REG-11: build rejects bad hash', () => {
  assert.throws(() => buildProposalProductRef({ proposalId: 1, contentHash: 'x' }), /64-char/);
});

test('REG-11: parse rejects wrong schema', () => {
  assert.throws(
    () => parseProposalProductRef({ schemaId: 'other', ref: 'x', digest: 'd' }),
    /expected schema/,
  );
});

test('REG-11-AC-02: proposalHashMatchesRef true/false/null', () => {
  const ref = buildProposalProductRef({ proposalId: 1, contentHash: HASH });
  assert.equal(proposalHashMatchesRef(HASH, ref), true);
  assert.equal(proposalHashMatchesRef('c'.repeat(64), ref), false);
  assert.equal(proposalHashMatchesRef(null, ref), false);
});
