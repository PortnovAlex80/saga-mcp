import { test } from 'node:test';
import assert from 'node:assert/strict';

import { submissionValidatorCheckProvider } from '../../dist/process-modules/application/submission-validator-check-provider.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';

const candidate = {
  candidateSetRef: 'candidate-set/test/author',
  workplaceRef: { processRunId: 2, moduleRef: 'solution-formalization@1.0.0' },
  productionRevisionRef: 'production-revision:test',
  role: 'author',
};

function providerDb({ hasProduction = false } = {}) {
  return {
    prepare(sql) {
      if (sql.includes('factory_workplace_production_revisions')) {
        return { get: () => ({ presenter_ref: 'worker-execution:repair-2' }) };
      }
      if (sql.includes('factory_managed_artifact_productions')) {
        return { get: () => hasProduction ? { present: 1 } : undefined };
      }
      if (sql.includes('factory_managed_trace_productions')) {
        return { get: () => undefined };
      }
      if (sql.includes('FROM worker_executions')) {
        return { get: () => ({ task_id: 3, epic_id: 1, project_id: 1 }) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

function runProvider({ hasProduction = false, validationResult }) {
  const provider = submissionValidatorCheckProvider({
    db: providerDb({ hasProduction }),
    candidateSets: { read: ref => ref === candidate.candidateSetRef ? candidate : null },
    validator: {
      validatorId: 'formalization.product-contract.v1',
      validatorVersion: '1.0.0',
      validate: () => validationResult,
    },
    nodeId: 'define-product-contract',
    requireManagedProduction: true,
  });
  return provider.run({
    subjectCandidateSetRef: candidate.candidateSetRef,
    parameters: { processRunId: 2, moduleRef: 'solution-formalization@1.0.0' },
    environmentRef: null,
    candidateSnapshot: {},
  });
}

test('Gate reports an actionable diagnostic when only prior execution production exists', () => {
  const result = runProvider({
    hasProduction: false,
    validationResult: { accepted: true, receipt: {} },
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.evidenceRefs.length, 1);
  const diagnostic = decodeCheckDiagnostic(result.evidenceRefs[0]);
  assert.equal(diagnostic.code, 'MANAGED_PRODUCTION_REQUIRED');
  assert.match(diagnostic.message, /artifact_update/);
  assert.match(diagnostic.message, /Prior execution ledger rows cannot satisfy/);
});

test('validator gaps survive the Gate as content-addressed recovery diagnostics', () => {
  const result = runProvider({
    hasProduction: true,
    validationResult: {
      accepted: false,
      code: 'FORMALIZATION_CONTRACT_INCOMPLETE',
      gaps: [{
        artifactId: 7,
        artifactCode: 'FR-2',
        artifactType: 'FR',
        existingTargets: [],
        missing: { relation: 'derived_from', requiredTargetTypes: ['PRD'], minimum: 1 },
        message: 'FR-2 must derive from the exact PRD.',
      }],
    },
  });
  assert.equal(result.outcome, 'failed');
  const diagnostic = decodeCheckDiagnostic(result.evidenceRefs[0]);
  assert.equal(diagnostic.code, 'FORMALIZATION_CONTRACT_INCOMPLETE:1');
  assert.equal(diagnostic.message, 'FR-2 must derive from the exact PRD.');
  assert.equal(diagnostic.subjectRef, 'artifact:7');
});
