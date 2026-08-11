import test from 'node:test';
import assert from 'node:assert/strict';

const { parseAtomicAcceptanceCriteria } = await import(
  '../../dist/modules/formalization/domain/acceptance-criterion-document.js'
);

test('accepted AC document is projected into stable atomic criterion members', () => {
  const content = [
    '# Acceptance Criteria',
    '',
    '## AC-1: Group heading is not an atomic member',
    '',
    '### AC-1.1: Valid input',
    'Given a value',
    'Then it is accepted',
    '',
    '### AC-1.2: Invalid input',
    'Given a bad value',
    'Then an error is shown',
  ].join('\n');

  const result = parseAtomicAcceptanceCriteria(content);
  assert.deepEqual(result.map(item => [item.code, item.title]), [
    ['AC-1.1', 'Valid input'],
    ['AC-1.2', 'Invalid input'],
  ]);
  assert.match(result[0].contentHash, /^[a-f0-9]{64}$/);
  assert.notEqual(result[0].contentHash, result[1].contentHash);
});

test('duplicate atomic codes fail closed before baseline freeze', () => {
  assert.throws(
    () => parseAtomicAcceptanceCriteria('### AC-1.1: One\nA\n### AC-1.1: Two\nB'),
    /duplicate atomic acceptance criterion/,
  );
});
