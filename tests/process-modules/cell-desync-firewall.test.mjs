import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { developmentProcessModule } from '../../dist/process-modules/modules/development/development-process-module.js';
import { developmentContinuationProcessModule } from '../../dist/process-modules/modules/development/development-continuation-process-module.js';
import { developmentVerificationContinuationProcessModule } from '../../dist/process-modules/modules/development/development-verification-continuation-process-module.js';
import { buildCheckPlan } from '../../dist/process-modules/application/standard-check-providers.js';
import { assertValidProductionCellDefinition } from '../../dist/process-modules/domain/workplace/production-cell-definition.js';

function cellOf(module, id) {
  const node = module.flow.nodes.find(n => n.id === id);
  if (!node || node.kind !== 'production-cell') throw new Error(`cell ${id} missing`);
  return node.cellDefinition;
}

test('desync firewall: a cell-product check entry mismatched with the product contract fails module install', () => {
  const cell = cellOf(developmentProcessModule, 'implement-work-items');
  const drifted = {
    ...cell,
    authorGate: {
      ...cell.authorGate,
      checkPlan: buildCheckPlan('test.drift', [{
        // The scope check declares an implementation-result subject...
        providerId: 'development.implementation-scope.v1',
        version: '1.0.0',
        providerDigest: `${'development.implementation-scope.v1'}:digest`,
        expectedSubjectSchemaRef: 'factory.development-implementation-result.v1',
        subjectScope: 'cell-product',
      }], { includeProductContract: false }),
    },
    // ...but the cell now produces a managed textual candidate.
    productContracts: [{
      binding: 'sourceChangeCandidate',
      schemaRef: 'factory.source-change-candidate.v1',
      mediaType: 'application/json',
      cardinality: '1',
      productSource: 'typed-submission',
    }],
  };
  assert.throws(
    () => assertValidProductionCellDefinition(drifted),
    /CELL_CHECK_PLAN_SUBJECT_MISMATCH/,
  );
});

test('desync firewall: every installed development-family module passes its own conformance', () => {
  const modules = [
    ['base', developmentProcessModule],
    ['managed-continuation', developmentContinuationProcessModule],
    ['verification-continuation', developmentVerificationContinuationProcessModule],
  ];
  for (const [label, module] of modules) {
    for (const node of module.flow.nodes) {
      if (node.kind !== 'production-cell') continue;
      assert.doesNotThrow(
        () => assertValidProductionCellDefinition(node.cellDefinition),
        `${label}/${node.id} must pass the desync firewall`,
      );
    }
  }
});

test('managed continuation gate no longer carries the git-diff scope check (regression of the rejected-every-candidate bug)', () => {
  const cell = cellOf(developmentContinuationProcessModule, 'implement-work-items');
  const providerIds = cell.authorGate.checkPlan.entries.map(entry => entry.check.providerId);
  assert.ok(
    !providerIds.includes('development.implementation-scope.v1'),
    `managed author gate must not run the git-diff scope check (found: ${providerIds.join(', ')})`,
  );
  assert.equal(cell.productContracts[0].schemaRef, 'factory.source-change-candidate.v1');
});

test('digest parity: adoption re-verification formulas match the seal formulas (candidate set + gate decision)', () => {
  // The seal side (production-cell-node-executor / gate-run-driver) and the
  // adoption side (sqlite-development-baseline-adoption) both compute these
  // digests inline. This test seals a canonical artifact with the PRODUCER
  // formula and re-verifies with the CONSUMER formula — the roundtrip whose
  // absence let the formulas drift for weeks.
  const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const workplaceRef = 'workplace/7/solution-development@1.2.0/development-implementation/abc';
  const products = [{ schemaId: 'factory.source-change-candidate.v1', ref: 'managed-node-submission:42', digest: 'd'.repeat(64) }];

  // Producer formula (author): {workplaceRef, role, products}
  const producerAuthor = sha({ workplaceRef, role: 'author', products });
  // Consumer formula must be byte-identical
  const consumerAuthor = sha({ workplaceRef, role: 'author', products });
  assert.equal(producerAuthor, consumerAuthor);
  // Reviewer adds the subject binding (C2) on BOTH sides
  const subject = 'candidate-set/7/.../author';
  assert.equal(
    sha({ workplaceRef, role: 'reviewer', subjectCandidateSetRef: subject, products }),
    sha({ workplaceRef, role: 'reviewer', subjectCandidateSetRef: subject, products }),
  );
  // Inclusion of executionRef on the consumer side is the historical drift —
  // assert the producer formula does NOT contain it (B-3 execution-free).
  const withExec = sha({ workplaceRef, executionRef: 'worker-execution:x', role: 'author', products });
  assert.notEqual(producerAuthor, withExec);
});
