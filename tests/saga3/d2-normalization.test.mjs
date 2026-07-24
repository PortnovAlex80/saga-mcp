import assert from 'node:assert/strict';
import test from 'node:test';

const { normalizeDiscoveryProposalInput } = await import('../../dist/saga3/domain/discovery-normalization.js');
const { validateDiscoveryNormalizationProposal } = await import('../../dist/saga3/domain/discovery-normalization-proposal.js');

function canonical(overrides = {}) {
  return {
    problem_statement: 'p',
    observed_context: 'c',
    stakeholders_or_actors: ['u'],
    assumptions: ['a'],
    unknowns: ['q'],
    risks: ['r'],
    candidate_scope: 's',
    evidence_refs: ['doc:1'],
    recommended_outcome: 'go',
    rationale: 'because',
    ...overrides,
  };
}

test('D2 deterministic: canonical object is accepted without LM', () => {
  const result = normalizeDiscoveryProposalInput(canonical());
  assert.equal(result.disposition, 'accepted');
  assert.deepEqual(result.trace, ['direct_object']);
});

test('D2 deterministic: fence and supported aliases are normalized', () => {
  const source = {
    problem: 'p', context: 'c', stakeholders: ['u'], assumption: ['a'], questions: ['q'],
    risk: ['r'], scope: 's', evidence: ['doc:1'], outcome: 'ready', reasoning: 'because',
  };
  const result = normalizeDiscoveryProposalInput('```json\n' + JSON.stringify(source) + '\n```');
  assert.equal(result.disposition, 'accepted');
  assert.ok(result.trace.includes('markdown_fence_removed'));
  assert.ok(result.trace.includes('supported_aliases_applied'));
  assert.equal(result.normalized_payload.recommended_outcome, 'go');
});

test('D2 deterministic: schema ambiguity requests LM', () => {
  const result = normalizeDiscoveryProposalInput({ problem: 'p', context: 'c' });
  assert.equal(result.disposition, 'needs_lm');
  assert.equal(result.normalized_payload, null);
});

test('D2 deterministic: invalid JSON is rejected without LM', () => {
  const result = normalizeDiscoveryProposalInput('{"problem_statement":"p",}');
  assert.equal(result.disposition, 'rejected_syntax');
});

test('D2 deterministic: canonical/alias conflict requests LM', () => {
  const result = normalizeDiscoveryProposalInput(canonical({ problem: 'different' }));
  assert.equal(result.disposition, 'needs_lm');
  assert.ok(result.alias_conflicts.includes('problem_statement<->problem'));
});

test('D2 LM proposal cannot invent evidence', () => {
  const source = canonical();
  const fieldMap = Object.fromEntries(Object.keys(source).map(key => [key, [`$.${key}`]]));
  const value = {
    source_submission_id: 1,
    source_raw_hash: 'a'.repeat(64),
    normalized_payload: canonical({ evidence_refs: ['invented'] }),
    source_field_map: fieldMap,
    notes: [],
  };
  const result = validateDiscoveryNormalizationProposal(value, source, ['doc:1']);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(';'), /invents evidence/);
});
