/**
 * complexity.test.mjs - the deterministic EK-2 complexity checker: the
 * current vector satisfies every EK-1 cap that binds at EK-2, the vector is
 * byte-identical across runs, all 36 budget dimensions are accounted for,
 * and a widened registry turns it red (mutation l).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const checker = await import('../../../dist/workflow-kernel/domain/complexity-check.js');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const budget = JSON.parse(readFileSync(path.join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'complexity-budget.json'), 'utf8'));

test('the current vector is green: zero binding failures', () => {
  const vector = checker.measureComplexityVector();
  assert.deepEqual(vector.bindingFailures, []);
  assert.ok(vector.bindingEntries >= 15, `expected a substantive binding set, got ${vector.bindingEntries}`);
});

test('every one of the 36 budget dimensions is accounted for exactly once', () => {
  const vector = checker.measureComplexityVector();
  assert.equal(budget.dimensions.length, 36);
  assert.equal(vector.dimensions.length, 36);
  const ids = new Set(vector.dimensions.map((d) => d.id));
  for (const dim of budget.dimensions) {
    assert.ok(ids.has(dim.id), `${dim.id} present in the vector`);
  }
  assert.equal(ids.size, vector.dimensions.length, 'no duplicate dimension ids');
});

test('the vector is deterministic: two runs are byte-identical', () => {
  const a = checker.canonicalVectorJson(checker.measureComplexityVector());
  const b = checker.canonicalVectorJson(checker.measureComplexityVector());
  assert.equal(a, b);
});

test('the protocol vocabulary dimensions equal the frozen universe counts', () => {
  const vector = checker.measureComplexityVector();
  const byId = new Map(vector.dimensions.map((d) => [d.id, d]));
  assert.equal(byId.get('protocol.commandKinds').measured, 53);
  assert.equal(byId.get('protocol.eventKinds').measured, 52);
  assert.equal(byId.get('protocol.obligationKinds').measured, 49);
  assert.equal(byId.get('protocol.waitKinds').measured, 5);
  assert.equal(byId.get('protocol.proofKinds').measured, 28);
  assert.equal(byId.get('protocol.evidenceKinds').measured, 67);
});

test('the authority dimensions equal the frozen declarations (22 relations, 13 owner kinds)', () => {
  const vector = checker.measureComplexityVector();
  const byId = new Map(vector.dimensions.map((d) => [d.id, d]));
  assert.equal(byId.get('authority.authoritativeRelationKinds').measured, 22);
  assert.equal(byId.get('authority.mutableOwnerAggregates').measured, 13);
  assert.equal(byId.get('authority.mutableOwnerAggregates').status, 'BINDING-PASS');
});

test('the kernel has zero workshop-name literals (binding now for the kernel scope)', () => {
  const vector = checker.measureComplexityVector();
  const byId = new Map(vector.dimensions.map((d) => [d.id, d]));
  assert.equal(byId.get('workshops.nameBranchLiterals').measured, 0);
  assert.equal(byId.get('workshops.nameBranchLiterals').status, 'BINDING-PASS');
});

test('mutation l: a widened universe without an approved delta turns the checker red', () => {
  const widenedCommands = checker.measureComplexityVector({ commands: 54 });
  assert.deepEqual(widenedCommands.bindingFailures, ['protocol.commandKinds']);
  const widenedEvidence = checker.measureComplexityVector({ evidenceKinds: 68 });
  assert.deepEqual(widenedEvidence.bindingFailures, ['protocol.evidenceKinds']);
  const widenedObligations = checker.measureComplexityVector({ obligationKinds: 50 });
  assert.deepEqual(widenedObligations.bindingFailures, ['protocol.obligationKinds']);
});
