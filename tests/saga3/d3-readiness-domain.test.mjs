import assert from 'node:assert/strict';
import test from 'node:test';

const { validateReadinessAssessment, READINESS_DIMENSIONS } = await import(
  '../../dist/saga3/domain/discovery-readiness-assessment.js'
);

const PROPOSAL_ID = 42;
const PROPOSAL_HASH = 'a'.repeat(64);
// Allowed source refs the advisor may cite: proposal field paths + evidence literals.
const ALLOWED_REFS = [
  '$.problem_statement', '$.observed_context', '$.stakeholders_or_actors',
  '$.assumptions', '$.unknowns', '$.risks', '$.candidate_scope',
  '$.evidence_refs', '$.evidence_refs[0]', '$.evidence_refs[1]',
  '$.recommended_outcome', '$.rationale',
  'artifact:requirements-1', 'artifact:context-2',
  'proposal:42',
];

function validDimension(status = 'sufficient', ref = '$.problem_statement') {
  return { status, rationale: 'grounded', source_refs: [ref] };
}

function validAssessment(overrides = {}) {
  const dims = {};
  for (const d of READINESS_DIMENSIONS) dims[d] = validDimension();
  return {
    proposal_id: PROPOSAL_ID,
    proposal_content_hash: PROPOSAL_HASH,
    overall_readiness: 'ready',
    dimension_assessments: dims,
    blocking_gaps: [],
    non_blocking_gaps: [],
    recommended_next_action: 'proceed_to_settlement',
    confidence: 0.8,
    rationale: 'proposal is well-grounded',
    ...overrides,
  };
}

test('D3 domain: valid complete assessment passes', () => {
  const r = validateReadinessAssessment(validAssessment(), PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS);
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('D3 domain: missing dimension is rejected', () => {
  const a = validAssessment();
  delete a.dimension_assessments.problem_clarity;
  const r = validateReadinessAssessment(a, PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('dimension_assessments.problem_clarity must be an object')));
});

test('D3 domain: unknown dimension is rejected', () => {
  const a = validAssessment();
  a.dimension_assessments.bogus_dimension = validDimension();
  const r = validateReadinessAssessment(a, PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("unknown dimension 'bogus_dimension'")));
});

test('D3 domain: invalid overall_readiness enum is rejected', () => {
  const r = validateReadinessAssessment(
    validAssessment({ overall_readiness: 'maybe' }),
    PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS,
  );
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("'overall_readiness' must be one of")));
});

test('D3 domain: invalid recommended_next_action enum is rejected', () => {
  const r = validateReadinessAssessment(
    validAssessment({ recommended_next_action: 'ship_it' }),
    PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS,
  );
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("'recommended_next_action' must be one of")));
});

test('D3 domain: confidence below 0 is rejected', () => {
  const r = validateReadinessAssessment(
    validAssessment({ confidence: -0.1 }),
    PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS,
  );
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('confidence') && e.includes('[0, 1]')));
});

test('D3 domain: confidence above 1 is rejected', () => {
  const r = validateReadinessAssessment(
    validAssessment({ confidence: 1.5 }),
    PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS,
  );
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('confidence') && e.includes('[0, 1]')));
});

test('D3 domain: confidence exactly 0 and 1 are accepted (boundary)', () => {
  for (const c of [0, 1]) {
    const r = validateReadinessAssessment(
      validAssessment({ confidence: c }),
      PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS,
    );
    assert.equal(r.valid, true, `confidence ${c} should be valid`);
  }
});

test('D3 domain: NaN confidence is rejected', () => {
  const r = validateReadinessAssessment(
    validAssessment({ confidence: NaN }),
    PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS,
  );
  assert.equal(r.valid, false);
});

test('D3 domain: nonexistent source reference is rejected (anti-invent-evidence)', () => {
  const a = validAssessment();
  a.dimension_assessments.problem_clarity.source_refs = ['$.problem_statement', 'invented:ref'];
  const r = validateReadinessAssessment(a, PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("unresolved source reference 'invented:ref'")));
});

test('D3 domain: vague source reference "the proposal" is rejected', () => {
  const a = validAssessment();
  a.dimension_assessments.scope_boundedness.source_refs = ['the proposal'];
  const r = validateReadinessAssessment(a, PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("unresolved source reference 'the proposal'")));
});

test('D3 domain: invented evidence literal not in allowed set is rejected', () => {
  const a = validAssessment();
  // 'artifact:fake-99' is NOT in ALLOWED_REFS.
  a.dimension_assessments.evidence_grounding.source_refs = ['artifact:fake-99'];
  const r = validateReadinessAssessment(a, PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('artifact:fake-99')));
});

test('D3 domain: evidence literal from allowed set is accepted', () => {
  const a = validAssessment();
  a.dimension_assessments.evidence_grounding.source_refs = ['artifact:requirements-1'];
  const r = validateReadinessAssessment(a, PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS);
  assert.equal(r.valid, true);
});

test('D3 domain: proposal_id mismatch is rejected (immutable target binding)', () => {
  // expectedProposalId=999 but payload says 42 → must report the mismatch.
  const r = validateReadinessAssessment(validAssessment(), 999, PROPOSAL_HASH, ALLOWED_REFS);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("'proposal_id' must be 999, got 42")));
});

test('D3 domain: proposal_content_hash mismatch is rejected (immutable target binding)', () => {
  const r = validateReadinessAssessment(
    validAssessment(), PROPOSAL_ID, 'b'.repeat(64), ALLOWED_REFS,
  );
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("'proposal_content_hash' does not match")));
});

test('D3 domain: malformed proposal_content_hash is rejected', () => {
  const r = validateReadinessAssessment(
    validAssessment({ proposal_content_hash: 'not-a-hash' }),
    PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS,
  );
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("'proposal_content_hash' must be a lowercase SHA-256")));
});

test('D3 domain: duplicate gap code within blocking_gaps is rejected', () => {
  const a = validAssessment();
  a.blocking_gaps = [
    { code: 'G1', description: 'gap one', source_refs: ['$.unknowns'] },
    { code: 'G1', description: 'dup', source_refs: ['$.unknowns'] },
  ];
  const r = validateReadinessAssessment(a, PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("duplicate ('G1')")));
});

test('D3 domain: same gap code across blocking and non_blocking is rejected', () => {
  const a = validAssessment();
  a.blocking_gaps = [{ code: 'G2', description: 'blocking', source_refs: ['$.risks'] }];
  a.non_blocking_gaps = [{ code: 'G2', description: 'non-blocking', source_refs: ['$.risks'] }];
  const r = validateReadinessAssessment(a, PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("appears in both blocking_gaps and non_blocking_gaps")));
});

test('D3 domain: empty gap code is rejected', () => {
  const a = validAssessment();
  a.blocking_gaps = [{ code: '  ', description: 'whitespace code', source_refs: ['$.risks'] }];
  const r = validateReadinessAssessment(a, PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('code must be a non-empty string')));
});

test('D3 domain: dimension rationale empty is rejected', () => {
  const a = validAssessment();
  a.dimension_assessments.problem_clarity.rationale = '   ';
  const r = validateReadinessAssessment(a, PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('problem_clarity.rationale must be a non-empty string')));
});

test('D3 domain: invalid dimension status enum is rejected', () => {
  const a = validAssessment();
  a.dimension_assessments.problem_clarity.status = 'great';
  const r = validateReadinessAssessment(a, PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('problem_clarity.status must be one of')));
});

test('D3 domain: empty top-level rationale is rejected', () => {
  const r = validateReadinessAssessment(
    validAssessment({ rationale: '' }),
    PROPOSAL_ID, PROPOSAL_HASH, ALLOWED_REFS,
  );
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("'rationale' must be a non-empty string")));
});
