import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSemanticReview } from './semantic-review.mjs';

const request = {
  stage: {
    condition: 'ConstitutionReady',
    semanticChecks: ['Mission is concrete', 'Users are explicit', 'Constraints are explicit'],
  },
  artifacts: [{ path: '/tmp/brief.md' }],
  logs: ['/tmp/engine.log', '/tmp/worker.jsonl'],
};

function validReview() {
  return {
    stage: 'ConstitutionReady',
    verdict: 'pass',
    summary: 'The brief is coherent, grounded in the mandate, and sufficient for formalization.',
    confidence: 0.9,
    inspectedArtifacts: [{ path: '/tmp/brief.md', assessment: 'Content is specific and internally consistent.', findings: [] }],
    inspectedLogs: [
      { path: '/tmp/engine.log', assessment: 'No hidden retries or fatal errors were observed.' },
      { path: '/tmp/worker.jsonl', assessment: 'The worker used the assigned skill and completed once.' },
    ],
    requirementsCoverage: request.stage.semanticChecks.map((requirement) => ({
      requirement,
      status: 'covered',
      evidence: 'Supported by the reviewed brief.',
    })),
    defects: [],
  };
}

test('semantic review contract accepts a complete agent review', () => {
  assert.deepEqual(validateSemanticReview(validReview(), request), []);
});

test('semantic review contract rejects uninspected artifacts and unsupported pass verdicts', () => {
  const review = validReview();
  review.inspectedArtifacts = [];
  review.requirementsCoverage[0].status = 'missing';
  review.defects.push({ severity: 'high', description: 'The mission contradicts the mandate.', evidence: 'brief.md section 1' });
  const errors = validateSemanticReview(review, request);
  assert.ok(errors.some((error) => error.includes('artifact was not reviewed')));
  assert.ok(errors.some((error) => error.includes('missing semantic checks')));
  assert.ok(errors.some((error) => error.includes('critical/high defects')));
});
