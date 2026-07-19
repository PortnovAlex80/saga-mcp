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

console.log('\n=== validateBrief — low completeness blocks go (Rule 3, agent-first revision) ===');

// Agent-first path: completeness=low + decision=go is ALLOWED when the agent
// has resolved every open_question itself AND built a real decision_matrix.
// These tests pin the new contract boundary.

test('invalid: completeness=low AND decision=go WITHOUT agent-resolve preconditions', () => {
  // validBase.open_questions is a string array ['o1'] — old shape, no
  // status/answer. Without agent-resolve preconditions, the rule fires.
  const p = clone(validBase); p.completeness = 'low'; p.decision = 'go';
  const r = validateBrief(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.startsWith('completeness=low blocks decision=go')),
    `errors: ${JSON.stringify(r.errors)}`);
});

test('valid: completeness=low AND decision=go WITH agent-resolved open_questions + matrix + recommended_variant', () => {
  const p = clone(validBase);
  p.completeness = 'low';
  p.decision = 'go';
  // ≥3 variants in the matrix
  p.decision_matrix = {
    criteria: ['business_value', 'technical_risk'],
    variants: [
      { name: 'A: MVP', scores: { business_value: 5, technical_risk: 3 } },
      { name: 'B: Full', scores: { business_value: 5, technical_risk: 2 } },
      { name: 'C: Lite', scores: { business_value: 3, technical_risk: 5 } },
    ],
  };
  p.recommended_variant = 'A: MVP';
  // open_questions as objects with status='answered' + non-empty answer
  p.open_questions = [
    { id: 'Q-001', question: 'which metric?', status: 'answered', answer: 'mean_session_seconds' },
    { id: 'Q-002', question: 'standalone or backend?', status: 'answered', answer: 'standalone HTML' },
  ];
  assert.equal(validateBrief(p).ok, true,
    'agent-first path: low completeness + go is valid when agent resolved all questions');
});

test('invalid: completeness=low AND decision=go WITH matrix but ONE open_question still status=open', () => {
  const p = clone(validBase);
  p.completeness = 'low';
  p.decision = 'go';
  p.decision_matrix = {
    criteria: ['c1'],
    variants: [
      { name: 'A', scores: { c1: 3 } },
      { name: 'B', scores: { c1: 3 } },
      { name: 'C', scores: { c1: 3 } },
    ],
  };
  p.recommended_variant = 'A';
  p.open_questions = [
    { id: 'Q-001', question: 'q1', status: 'answered', answer: 'a1' },
    { id: 'Q-002', question: 'q2', status: 'open' },  // ← still open
  ];
  const r = validateBrief(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.startsWith('completeness=low blocks decision=go')),
    'must reject when any open_question is still status=open');
});

test('invalid: completeness=low AND decision=go WITH answered questions but only 2 variants', () => {
  const p = clone(validBase);
  p.completeness = 'low';
  p.decision = 'go';
  p.decision_matrix = {
    criteria: ['c1'],
    variants: [
      { name: 'A', scores: { c1: 3 } },
      { name: 'B', scores: { c1: 3 } },
      // only 2 — matrix below the ≥3 threshold
    ],
  };
  p.recommended_variant = 'A';
  p.open_questions = [
    { id: 'Q-001', question: 'q1', status: 'answered', answer: 'a1' },
  ];
  const r = validateBrief(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.startsWith('completeness=low blocks decision=go')),
    'must reject when matrix has <3 variants (no real decision was made)');
});

test('invalid: completeness=low AND decision=go WITH matrix+answered but missing recommended_variant', () => {
  const p = clone(validBase);
  p.completeness = 'low';
  p.decision = 'go';
  p.decision_matrix = {
    criteria: ['c1'],
    variants: [
      { name: 'A', scores: { c1: 3 } },
      { name: 'B', scores: { c1: 3 } },
      { name: 'C', scores: { c1: 3 } },
    ],
  };
  // recommended_variant omitted
  p.open_questions = [
    { id: 'Q-001', question: 'q1', status: 'answered', answer: 'a1' },
  ];
  const r = validateBrief(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.startsWith('completeness=low blocks decision=go')),
    'must reject when recommended_variant is missing (no commitment to a specific variant)');
});

test('valid: completeness=low with decision=clarify (unchanged fallback)', () => {
  const p = clone(validBase); p.completeness = 'low'; p.decision = 'clarify';
  assert.equal(validateBrief(p).ok, true);
});
test('valid: completeness=high with decision=go (unchanged)', () => {
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
