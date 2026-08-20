/**
 * Heading-resolution gate (acceptance-contract validator v1.2.0) + freeze
 * resolver diagnostics.
 *
 * Defect class 2026-08-17..20 — four terminal failures (sudoku, tetris,
 * sheets, counter) with ALL formalization tasks done: the freeze kernel
 * resolved an AC artifact code against document headings, found no exact
 * match, and failed the whole run with a one-line error and no repair path:
 *   - sudoku: registry 'AC-1' vs heading 'AC-01' (zero-padding drift)
 *   - counter: registry container row 'AC-Doc' (names the document itself)
 * The v1.2.0 gate rejects such bundles at worker_done with a repair recipe;
 * the kernel error now lists the parsed headings and both legal repairs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acceptanceCriteriaForArtifact,
  parseAtomicAcceptanceCriteria,
} from '../../../dist/modules/formalization/domain/acceptance-criterion-document.js';
import {
  acHeadingResolutionSubmissionGaps,
  ACCEPTANCE_CONTRACT_VALIDATOR_VERSION,
} from '../../../dist/modules/formalization/application/acceptance-contract-validator.js';

const DOC = [
  '# Acceptance Criteria',
  '',
  '## AC-1: Grid renders 9x9',
  'body',
  '## AC-2: Reset zeroes the count',
  'body',
  '## AC-10: Step selector offers 1/5/10',
  'body',
].join('\n');

test('version is bumped for the heading-resolution gate', () => {
  assert.equal(ACCEPTANCE_CONTRACT_VALIDATOR_VERSION, '1.2.0');
});

test('resolver: exact code resolves to exactly one leaf', () => {
  const resolved = acceptanceCriteriaForArtifact(DOC, 'AC-1');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].code, 'AC-1');
});

test('resolver: container row AC-Doc still fails closed — but with parsed headings + both repairs', () => {
  assert.throws(
    () => acceptanceCriteriaForArtifact(DOC, 'AC-Doc'),
    (error) => {
      assert.match(error.message, /^atomic acceptance artifact 'AC-Doc' has no matching document heading/);
      assert.match(error.message, /parsed headings: \[AC-1, AC-2, AC-10\]/);
      assert.match(error.message, /remove that artifact row/);
      assert.match(error.message, /add\/rename the heading/);
      return true;
    },
  );
});

test('resolver: zero-padding near-miss (sudoku) still fails closed with diagnostics', () => {
  const zeroPadded = DOC.replace('## AC-1:', '## AC-01:');
  assert.throws(
    () => acceptanceCriteriaForArtifact(zeroPadded, 'AC-1'),
    /parsed headings: \[AC-01, AC-2, AC-10\]/,
  );
});

test('resolver: bare AC container grammar keeps all-leaf semantics', () => {
  const resolved = acceptanceCriteriaForArtifact(DOC, 'AC');
  assert.equal(resolved.length, 3);
});

test('gate: container row AC-Doc produces a repair-recipe gap', () => {
  const contents = new Map([[15, DOC]]);
  const gaps = acHeadingResolutionSubmissionGaps(
    [{ id: 15, code: 'AC-Doc' }],
    id => contents.get(id),
  );
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].artifactCode, 'AC-Doc');
  assert.equal(gaps[0].missing.relation, 'heading');
  assert.match(gaps[0].message, /parsed headings: \[AC-1, AC-2, AC-10\]/);
  assert.match(gaps[0].message, /remove that artifact row/);
});

test('gate: zero-padding near-miss (sudoku) produces a gap', () => {
  const zeroPadded = DOC.replace('## AC-1:', '## AC-01:');
  const contents = new Map([[1, zeroPadded]]);
  const gaps = acHeadingResolutionSubmissionGaps(
    [{ id: 1, code: 'AC-1' }],
    id => contents.get(id),
  );
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].message, /AC-01/);
});

test('gate: clean atomic rows pass with no gaps', () => {
  const contents = new Map([[1, DOC], [2, DOC], [10, DOC]]);
  const gaps = acHeadingResolutionSubmissionGaps(
    [{ id: 1, code: 'AC-1' }, { id: 2, code: 'AC-2' }, { id: 10, code: 'AC-10' }],
    id => contents.get(id),
  );
  assert.equal(gaps.length, 0);
});

test('gate: bare AC container code is legal and unchecked (all-leaf grammar)', () => {
  const contents = new Map([[7, DOC]]);
  const gaps = acHeadingResolutionSubmissionGaps(
    [{ id: 7, code: 'AC' }],
    id => contents.get(id),
  );
  assert.equal(gaps.length, 0);
});

test('gate: unreadable content becomes a fail-closed gap, not a throw', () => {
  const gaps = acHeadingResolutionSubmissionGaps(
    [{ id: 9, code: 'AC-3' }],
    () => { throw new Error('FORMALIZATION_ARTIFACT_CONTENT_UNAVAILABLE: 9'); },
  );
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].message, /could not be read/);
  assert.match(gaps[0].message, /FORMALIZATION_ARTIFACT_CONTENT_UNAVAILABLE/);
});

test('gate: heading list in the message is capped at 25 codes', () => {
  const many = ['# AC', ''];
  for (let i = 1; i <= 30; i += 1) many.push(`## AC-${i}: criterion ${i}`, 'body');
  const contents = new Map([[1, many.join('\n')]]);
  const gaps = acHeadingResolutionSubmissionGaps(
    [{ id: 1, code: 'AC-Doc' }],
    id => contents.get(id),
  );
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].message, /AC-25/);
  assert.match(gaps[0].message, /\(\+5\)/);
  assert.ok(!gaps[0].message.includes('AC-26:'));
});
