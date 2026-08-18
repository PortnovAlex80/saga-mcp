/**
 * Actionable-error contract tests for the saga3 MCP tool handlers.
 *
 * The first real E2E run on a weaker model (gemma-4-12b-qat) showed the cost of
 * diagnostic-only errors: the worker built a semantically-correct proposal but
 * failed proposal_submit 6+ times because it put top-level args inside `payload`,
 * and the short errors ("intent_id must be an integer") gave no expected shape
 * and no source for the correct value. These tests pin the actionable contract:
 * every argument error MUST contain the expected call shape, the value source,
 * and the offending value — so a weaker model can self-correct in one retry.
 *
 * These tests do NOT require a database: they call the arg validators directly
 * (imported from dist) and assert the error message shape. They also verify the
 * integer", "must be a non-empty string") remain substrings of the new messages,
 * so existing regex-based handler tests keep matching.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  argInt,
  argStr,
  actionableError,
  enrichPayloadErrors,
  FACTORY_TOOL_CALL_SHAPES,
  FACTORY_ARG_SOURCES,
} from '../../dist/tools/discovery-tool-args.js';

// ---- argInt: actionable + backward-compatible -------------------------------

test('argInt: error contains expected shape + source + got + unsupported phrase', () => {
  assert.throws(
    () => argInt('proposal_submit', { intent_id: 'not-an-int' }, 'intent_id',
      { source: FACTORY_ARG_SOURCES.intent_id, expected: FACTORY_TOOL_CALL_SHAPES.proposal_submit }),
    (err) => {
      const msg = err.message;
      assert.match(msg, /must be an integer/);
      // Actionable: expected shape.
      assert.match(msg, /Expected shape: proposal_submit\(/);
      // Actionable: source of the correct value.
      assert.match(msg, /Source: task_get/);
      // Actionable: the offending value echoed.
      assert.match(msg, /Got: "not-an-int"/);
      return true;
    },
  );
});

test('argInt: valid integer passes through', () => {
  assert.equal(argInt('t', { x: 42 }, 'x'), 42);
});

test('argInt: undefined value is reported in the diagnostic phrase', () => {
  // When the arg is absent (undefined), the helper reports "got undefined" in the
  // diagnostic phrase; the Got: section is omitted (JSON.stringify(undefined) is
  // undefined, which is not useful). The expected shape + source still guide the
  // worker to the correct value.
  assert.throws(
    () => argInt('readiness', {}, 'control_intent_id', { source: 'src', expected: 'shape' }),
    /got undefined.*Expected shape: shape.*Source: src/,
  );
});

// ---- argStr: actionable + backward-compatible -------------------------------

test('argStr: error contains expected shape + source + got + unsupported phrase', () => {
  assert.throws(
    () => argStr('proposal_submit', { execution_id: 123 }, 'execution_id',
      { source: FACTORY_ARG_SOURCES.execution_id, expected: FACTORY_TOOL_CALL_SHAPES.proposal_submit }),
    (err) => {
      const msg = err.message;
      assert.match(msg, /must be a non-empty string/);
      assert.match(msg, /Expected shape: proposal_submit\(/);
      assert.match(msg, /Source:/);
      assert.match(msg, /Got: 123/);
      return true;
    },
  );
});

test('argStr: empty string rejected (trim applied)', () => {
  assert.throws(
    () => argStr('t', { x: '   ' }, 'x'),
    /must be a non-empty string/,
  );
});

test('argStr: allowEmpty permits empty', () => {
  assert.equal(argStr('t', { x: '' }, 'x', { allowEmpty: true }), '');
});

// ---- actionableError builder ------------------------------------------------

test('actionableError: assembles tool + message + expected + source + got', () => {
  const err = actionableError('readiness', "'schema_version' must be a string",
    { field: 'schema_version', expected: 'readiness_submit({...})', source: 'top-level arg', got: 42 });
  assert.match(err.message, /readiness: 'schema_version' must be a string/);
  assert.match(err.message, /Expected shape: readiness_submit/);
  assert.match(err.message, /Source: top-level arg/);
  assert.match(err.message, /Got: 42/);
});

test('actionableError: omits missing sections gracefully', () => {
  const err = actionableError('t', 'something wrong');
  assert.equal(err.message, 't: something wrong');
});

// ---- shape registry: all 5 tools have a template ----------------------------

test('FACTORY_TOOL_CALL_SHAPES: every saga3 tool has an expected-shape entry', () => {
  const required = [
    'proposal_submit', 'readiness_get', 'readiness_submit',
    'normalization_get', 'normalization_submit',
  ];
  for (const name of required) {
    const shape = FACTORY_TOOL_CALL_SHAPES[name];
    assert.ok(shape, `missing shape for ${name}`);
    assert.match(shape, new RegExp(name));
  }
});

// ---- the exact mistake the gemma run made: intent_id inside payload ---------

test('regression (gemma E2E): intent_id nested in payload triggers actionable error', () => {
  // The worker sent { payload: { intent_id: 10217, task_id: 6218, ... }, execution_id, kind, schema_version }
  // with NO top-level intent_id. The handler's argInt must catch this and tell the
  // worker intent_id is a top-level arg sourced from task_get metadata.
  const argsWithoutIntentId = {
    task_id: 6218, execution_id: 'exec-1', kind: 'discovery',
    schema_version: 'factory.discovery-proposal.v1',
    payload: { intent_id: 10217, problem_statement: 'x', /* ... */ },
  };
  assert.throws(
    () => argInt('proposal_submit', argsWithoutIntentId, 'intent_id',
      { source: FACTORY_ARG_SOURCES.intent_id, expected: FACTORY_TOOL_CALL_SHAPES.proposal_submit }),
    (err) => {
      assert.match(err.message, /intent_id.*must be an integer/);
      assert.match(err.message, /top-level arg, NOT inside payload/);
      assert.match(err.message, /task_get → metadata\.work_intent_id/);
      return true;
    },
  );
});

// ---- enrichPayloadErrors: payload-validator errors get Source hints --------

test('enrichPayloadErrors: readiness hash error gets readiness_get source; forbidden proposal_id gets none', () => {
  const raw = [
    "field 'proposal_id' must not appear in the payload: bind to the proposal via 'proposal_content_hash' only (physical ids are kernel provenance, not semantic content)",
    "field 'proposal_content_hash' must be a lowercase SHA-256 hex string",
  ];
  const enriched = enrichPayloadErrors('readiness_submit', raw);
  // Forbidden-field error: raw phrase preserved, NO source hint (the field has
  // no valid source anymore).
  assert.match(enriched[0], /field 'proposal_id' must not appear/);
  assert.doesNotMatch(enriched[0], /Source: readiness_get → proposal_id/);
  // Hash error keeps its source hint.
  assert.match(enriched[1], /Source: readiness_get → proposal_content_hash/);
  // Expected shape appended once at end.
  assert.match(enriched[enriched.length - 1], /\[Expected readiness_submit shape:/);
});

test('enrichPayloadErrors: source_refs failure gets allowed_source_refs hint', () => {
  const enriched = enrichPayloadErrors('readiness_submit', ["dimension_assessments.evidence_grounding cites an unresolved source reference 'the proposal'"]);
  assert.match(enriched[0], /Source: use ONLY refs from the allowed_source_refs list returned by readiness_get/);
});

test('enrichPayloadErrors: empty array returns empty (no shape appended)', () => {
  assert.deepEqual(enrichPayloadErrors('readiness_submit', []), []);
});

test('enrichPayloadErrors: unknown tool returns errors unchanged (no crash)', () => {
  const enriched = enrichPayloadErrors('nonexistent_tool', ['some error']);
  assert.deepEqual(enriched, ['some error']);
});

test('enrichPayloadErrors: proposal unknowns-as-string gets array hint', () => {
  const enriched = enrichPayloadErrors('proposal_submit', ["field 'unknowns' must be an array of strings"]);
  assert.match(enriched[0], /Source: array of strings \(NOT a JSON string — an actual array\)/);
});
