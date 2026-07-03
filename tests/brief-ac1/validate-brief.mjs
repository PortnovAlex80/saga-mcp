// Unit tests for validateBrief (SRS-004 §2b.2, AC-1).
//
// Pure unit test — no database. Exercises every validation rule from the
// contract, plus the "collect all errors" behaviour and the 4 decision
// literals on the happy path. Run against the compiled JS in dist/.
//
// Usage:  node tests/brief-ac1/validate-brief.mjs
import { validateBrief } from '../../dist/validators/brief.js';
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}

// A payload that satisfies every rule. Each test clones it and mutates one
// field so the assertions stay focused and readable.
const validBase = {
  classification: 'product',
  complexity: { tshirt: 'M', risk_triggers: ['r1'] },
  hypotheses: ['h1'],
  quality_gate_checklist: ['q1'],
  open_questions: ['o1'],
  decision_matrix: { criteria: ['c1'], variants: [{ name: 'v1', scores: { c1: 3 } }] },
  decision: 'go',
  reasoning: 'because the market exists',
  affected_projects: [1],
  topology_hint: 'parallel-independent',
  scaffold_artifacts: ['docs/x.md'],
  shared_mutation_risk: false,
  completeness: 'high',
  degraded: false,
};
const clone = (o) => JSON.parse(JSON.stringify(o));

console.log('\n=== validateBrief — decision literal (Rule 1) ===');
test('valid: decision=go', () => {
  const r = validateBrief(clone(validBase));
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});
test('valid: decision=fast-track', () => {
  const p = clone(validBase); p.decision = 'fast-track';
  assert.equal(validateBrief(p).ok, true);
});
test('valid: decision=clarify', () => {
  const p = clone(validBase); p.decision = 'clarify';
  assert.equal(validateBrief(p).ok, true);
});
test('valid: decision=reject', () => {
  const p = clone(validBase); p.decision = 'reject';
  assert.equal(validateBrief(p).ok, true);
});
test('invalid: decision missing → ok:false with decision: invalid', () => {
  const p = clone(validBase); delete p.decision;
  const r = validateBrief(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('decision: invalid'), `errors were: ${JSON.stringify(r.errors)}`);
});
test('invalid: decision wrong literal → decision: invalid', () => {
  const p = clone(validBase); p.decision = 'maybe';
  const r = validateBrief(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('decision: invalid'));
});

console.log('\n=== validateBrief — reasoning non-empty (Rule 4) ===');
test('invalid: reasoning empty string', () => {
  const p = clone(validBase); p.reasoning = '';
  const r = validateBrief(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('reasoning:')), `errors: ${JSON.stringify(r.errors)}`);
});
test('invalid: reasoning whitespace-only', () => {
  const p = clone(validBase); p.reasoning = '   \t  ';
  assert.equal(validateBrief(p).ok, false);
});
test('invalid: reasoning missing', () => {
  const p = clone(validBase); delete p.reasoning;
  assert.equal(validateBrief(p).ok, false);
});

console.log('\n=== validateBrief — multi-project topology (Rule 2) ===');
test('valid: multi-project with sequence', () => {
  const p = clone(validBase); p.affected_projects = [1, 2]; p.topology_hint = 'sequence';
  assert.equal(validateBrief(p).ok, true);
});
test('valid: multi-project with scaffold-then-parallel', () => {
  const p = clone(validBase); p.affected_projects = [1, 2, 3]; p.topology_hint = 'scaffold-then-parallel';
  assert.equal(validateBrief(p).ok, true);
});
test('valid: single project with parallel-independent', () => {
  const p = clone(validBase); p.affected_projects = [1]; p.topology_hint = 'parallel-independent';
  assert.equal(validateBrief(p).ok, true);
});
test('invalid: multi-project + parallel-independent', () => {
  const p = clone(validBase); p.affected_projects = [1, 2]; p.topology_hint = 'parallel-independent';
  const r = validateBrief(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('topology_hint: multi-project requires sequence or scaffold-then-parallel'),
    `errors: ${JSON.stringify(r.errors)}`);
});

console.log('\n=== validateBrief — low completeness blocks go (Rule 3) ===');
test('invalid: completeness=low AND decision=go', () => {
  const p = clone(validBase); p.completeness = 'low'; p.decision = 'go';
  const r = validateBrief(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('completeness=low blocks decision=go; use clarify'),
    `errors: ${JSON.stringify(r.errors)}`);
});
test('valid: completeness=low with decision=clarify', () => {
  const p = clone(validBase); p.completeness = 'low'; p.decision = 'clarify';
  assert.equal(validateBrief(p).ok, true);
});
test('valid: completeness=high with decision=go', () => {
  const p = clone(validBase); p.completeness = 'high'; p.decision = 'go';
  assert.equal(validateBrief(p).ok, true);
});

console.log('\n=== validateBrief — error collection & robustness ===');
test('collects multiple errors in one pass', () => {
  const p = clone(validBase);
  p.decision = 'nope';        // rule 1
  p.reasoning = '';           // rule 4
  p.affected_projects = [1, 2]; // rule 2
  p.topology_hint = 'parallel-independent';
  p.completeness = 'low';     // (decision != go so rule 3 stays dormant)
  const r = validateBrief(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 3, `expected >=3 errors, got ${r.errors.length}: ${JSON.stringify(r.errors)}`);
  assert.ok(r.errors.includes('decision: invalid'));
  assert.ok(r.errors.some((e) => e.startsWith('reasoning:')));
  assert.ok(r.errors.includes('topology_hint: multi-project requires sequence or scaffold-then-parallel'));
});
test('non-object payload → ok:false', () => {
  const r = validateBrief(null);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].startsWith('brief_payload:'));
});
test('empty object → reports required fields (decision+reasoning)', () => {
  const r = validateBrief({});
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('decision: invalid'));
  assert.ok(r.errors.some((e) => e.startsWith('reasoning:')));
});

console.log(`\n=== validate-brief: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
