import test from 'node:test';
import assert from 'node:assert/strict';

const { parseAtomicAcceptanceCriteria, acceptanceCriteriaForArtifact } = await import(
  '../../dist/modules/formalization/domain/acceptance-criterion-document.js'
);

test('atomic artifact selects only its anchor from a shared AC document', () => {
  const content = [
    '## AC-1: First',
    'First body.',
    '## AC-2: Second',
    'Second body.',
  ].join('\n');
  assert.deepEqual(
    acceptanceCriteriaForArtifact(content, 'AC-2').map(item => item.code),
    ['AC-2'],
  );
  assert.deepEqual(
    acceptanceCriteriaForArtifact(content, 'AC').map(item => item.code),
    ['AC-1', 'AC-2'],
  );
});

test('atomic artifact fails closed when its shared document anchor is missing', () => {
  assert.throws(
    () => acceptanceCriteriaForArtifact('## AC-1: First\nBody', 'AC-2'),
    /no matching document heading/,
  );
});

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

test('level-two AC is atomic when it contains Scenario headings only', () => {
  const result = parseAtomicAcceptanceCriteria([
    '## AC-1: Mission input',
    '### Scenario: valid values',
    'Given valid values',
    '## AC-2: Comparison',
    '### Scenario: compare planets',
  ].join('\n'));
  assert.deepEqual(result.map(item => item.code), ['AC-1', 'AC-2']);
});

test('parent AC group is excluded when dotted child criteria exist', () => {
  const result = parseAtomicAcceptanceCriteria([
    '## AC-1: Input group',
    '### AC-1.1: Valid values',
    '### AC-1.2: Invalid values',
    '## AC-2: Standalone comparison',
  ].join('\n'));
  assert.deepEqual(result.map(item => item.code), ['AC-1.1', 'AC-1.2', 'AC-2']);
});
