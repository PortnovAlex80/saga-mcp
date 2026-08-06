// tests/execution/call-correlation.test.mjs
//
// W6-A6 — §11.9-11.10 contract tests for src/application/call-correlation.ts.
// Spec: docs/refactor-management/09-contracts/WAVE6-MCP-GUARDS-SPEC.md
//       + plan §0.9.8, §11.9 (correlation), §11.10 (structured-error survival).
//
// WHAT THIS PROVES
//   §11.9 — Every consequential call carries a platform-owned call-instance
//           correlation value that the gateway validates and STRIPS before
//           module handler input decoding. Runtime must never infer which
//           workspace file produced an MCP argument object.
//   §11.10 — The gateway preserves ActionableToolError as structured data
//           across MCP serialization. It must NOT flatten the repair contract
//           into one textual Error string.
//
// These are CONTRACT tests for the transport boundary, exercised through the
// compiled dist/ (the same surface the Wave 11 gateway cutover will call).
// They import only W6-A6's own surface — no sibling-lane skip is needed.

import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CALL_CORRELATION_KEY,
  CALL_CORRELATION_PREFIX,
  SERIALIZED_ERROR_KIND,
  mintCorrelationId,
  isValidCorrelationId,
  readCorrelationId,
  stripCorrelation,
  detectInferredProvenance,
  isActionableToolErrorShape,
  safeFromThrown,
  okReceipt,
  errorReceipt,
  serializeError,
  serializeForMcp,
  parseStructuredError,
} from '../../dist/application/call-correlation.js';

const __filename = fileURLToPath(import.meta.url);
void __filename; // referenced for parity with sibling test files.

// ===========================================================================
// §11.9 — Call-instance correlation value.
// ===========================================================================

test('§11.9 mintCorrelationId produces the platform-owned call:<uuid> shape', () => {
  const id = mintCorrelationId();
  assert.ok(id.startsWith(CALL_CORRELATION_PREFIX), 'minted id carries the platform prefix');
  assert.ok(isValidCorrelationId(id), 'a freshly minted id validates');
});

test('§11.9 mintCorrelationId is unique across calls', () => {
  const ids = new Set(Array.from({ length: 1000 }, () => mintCorrelationId()));
  assert.equal(ids.size, 1000, '1000 minted ids are all distinct');
});

test('§11.9 isValidCorrelationId rejects non-platform values', () => {
  // The whole point of §11.9's "validates ... before module handler input
  // decoding": a workspace file path or bare string must never pass as a
  // correlation id.
  assert.equal(isValidCorrelationId('not-a-call-id'), false);
  assert.equal(isValidCorrelationId('path/to/workspace/file.ts'), false);
  assert.equal(isValidCorrelationId('550e8400-e29b-41d4-a716-446655440000'), false, 'bare uuid rejected');
  assert.equal(isValidCorrelationId(''), false);
  assert.equal(isValidCorrelationId(null), false);
  assert.equal(isValidCorrelationId(undefined), false);
  assert.equal(isValidCorrelationId(123), false);
  assert.equal(isValidCorrelationId({}), false);
  assert.equal(isValidCorrelationId('call:not-a-uuid'), false);
});

test('§11.9 readCorrelationId reads the reserved key from an args object', () => {
  const id = mintCorrelationId();
  const args = { taskId: 7, [CALL_CORRELATION_KEY]: id };
  assert.equal(readCorrelationId(args), id);
});

test('§11.9 readCorrelationId returns null when absent or invalid', () => {
  assert.equal(readCorrelationId({ taskId: 7 }), null);
  assert.equal(readCorrelationId({ [CALL_CORRELATION_KEY]: 'bogus' }), null);
  assert.equal(readCorrelationId(null), null);
  assert.equal(readCorrelationId('string'), null);
});

test('§11.9 stripCorrelation removes the reserved key before handler input decoding', () => {
  // The STRIP step: the module handler must never see the correlation token.
  const id = mintCorrelationId();
  const args = { taskId: 7, epicId: 3, [CALL_CORRELATION_KEY]: id };
  const stripped = stripCorrelation(args);
  assert.equal(CALL_CORRELATION_KEY in stripped, false, 'reserved key is gone');
  assert.equal(stripped.taskId, 7, 'declared input fields survive');
  assert.equal(stripped.epicId, 3, 'declared input fields survive');
  // Original is NOT mutated — the gateway must not rewrite the inbound object.
  assert.equal(args[CALL_CORRELATION_KEY], id, 'original args are untouched');
});

test('§11.9 stripCorrelation strips the reserved key even when its value is invalid', () => {
  // The key is reserved regardless of value. An attacker-supplied bogus value
  // under the reserved key is removed before the handler sees it.
  const stripped = stripCorrelation({ taskId: 1, [CALL_CORRELATION_KEY]: 'bogus' });
  assert.equal(CALL_CORRELATION_KEY in stripped, false);
  assert.equal(stripped.taskId, 1);
});

test('§11.9 stripCorrelation passes through non-object args unchanged', () => {
  assert.equal(stripCorrelation(null), null);
  assert.equal(stripCorrelation(undefined), undefined);
  assert.equal(stripCorrelation('x'), 'x');
});

test('§11.9 stripCorrelation preserves a handler input contract with many fields', () => {
  const id = mintCorrelationId();
  const args = {
    [CALL_CORRELATION_KEY]: id,
    project_id: 42,
    epic_id: 7,
    status: 'todo',
    nested: { a: 1, b: [2, 3] },
  };
  const stripped = stripCorrelation(args);
  assert.deepEqual(
    stripped,
    { project_id: 42, epic_id: 7, status: 'todo', nested: { a: 1, b: [2, 3] } },
  );
  // shallow copy: nested object identity is shared, but top-level is a new object
  assert.notEqual(stripped, args);
});

// ===========================================================================
// §11.9 — Provenance-inference guard.
// ===========================================================================

test('§11.9 detectInferredProvenance flags a workspace file path smuggled into args', () => {
  // The runtime must never infer which workspace file produced an MCP argument
  // object. If a caller tries to encode that as an argument, the gateway audits it.
  const offenders = detectInferredProvenance({
    taskId: 7,
    file: 'docs/requirements/REQ-001/AC-1.md',
    schema: 'src/schemas/ac.json',
  });
  assert.ok(offenders.includes('file'), 'file path is flagged');
  assert.ok(offenders.includes('schema'), 'schema path is flagged');
  assert.ok(!offenders.includes('taskId'), 'bare logical id is NOT flagged');
});

test('§11.9 detectInferredProvenance exempts the reserved correlation key', () => {
  const id = mintCorrelationId();
  const offenders = detectInferredProvenance({
    [CALL_CORRELATION_KEY]: id,
    file: 'some/path.md',
  });
  // The reserved key is platform-owned; even though its value contains no
  // slash, it must never be reported as provenance.
  assert.ok(!offenders.includes(CALL_CORRELATION_KEY));
  assert.ok(offenders.includes('file'));
});

test('§11.9 detectInferredProvenance is clean for logical references', () => {
  assert.deepEqual(
    detectInferredProvenance({ taskId: 'task-123', epicId: 'REQ-001', status: 'done' }),
    [],
  );
  assert.deepEqual(detectInferredProvenance(null), []);
  assert.deepEqual(detectInferredProvenance('x'), []);
});

// ===========================================================================
// §11.8 / §11.10 — ActionableToolError structural shape.
// ===========================================================================

test('§11.8 isActionableToolErrorShape accepts a complete structured error', () => {
  const id = mintCorrelationId();
  const err = {
    code: 'FIELD_INVALID',
    message: 'project_id must be a positive integer',
    fieldPath: '/project_id',
    expected: 'positive integer',
    actual: '-1',
    sourceOfTruth: 'docs/schemas/project.json#/project_id',
    callInstance: id,
    checklistRef: 'planning.ac#step-2',
    trackerRef: 'task/1024',
    resumeStep: 're-plan',
    retry: 'retryable',
  };
  assert.equal(isActionableToolErrorShape(err), true);
});

test('§11.8 isActionableToolErrorShape accepts the minimal shape (code + message)', () => {
  assert.equal(isActionableToolErrorShape({ code: 'X', message: 'm' }), true);
});

test('§11.8 isActionableToolErrorShape rejects non-structured values', () => {
  assert.equal(isActionableToolErrorShape(null), false);
  assert.equal(isActionableToolErrorShape('Error: boom'), false, 'flattened string rejected');
  assert.equal(isActionableToolErrorShape(new Error('boom')), false);
  assert.equal(isActionableToolErrorShape({}), false, 'missing code');
  assert.equal(isActionableToolErrorShape({ code: '', message: 'm' }), false, 'empty code');
  assert.equal(isActionableToolErrorShape({ code: 'X' }), false, 'missing message');
  assert.equal(
    isActionableToolErrorShape({ code: 'X', message: 'm', retry: 'forever' }),
    false,
    'bad retry permission',
  );
  assert.equal(
    isActionableToolErrorShape({ code: 'X', message: 'm', callInstance: 'bogus' }),
    false,
    'invalid callInstance',
  );
});

test('§11.10 safeFromThrown preserves an already-structured error verbatim', () => {
  // The anti-flattening guarantee: a structured throw is NOT stringified.
  const id = mintCorrelationId();
  const structured = {
    code: 'AUTHORITY_DENIED',
    message: 'tool not permitted by frozen execution authority',
    fieldPath: '/tool',
    retry: 'not-retryable',
    checklistRef: 'authority#step-1',
  };
  const out = safeFromThrown(structured, id);
  assert.equal(out.code, 'AUTHORITY_DENIED');
  assert.equal(out.message, 'tool not permitted by frozen execution authority');
  assert.equal(out.fieldPath, '/tool', 'repair fields preserved');
  assert.equal(out.retry, 'not-retryable', 'retry permission preserved');
  assert.equal(out.checklistRef, 'authority#step-1', 'checklist ref preserved');
  assert.equal(out.callInstance, id, 'correlation attached to a structured error lacking one');
});

test('§11.10 safeFromThrown does NOT overwrite an existing callInstance', () => {
  const id = mintCorrelationId();
  const other = mintCorrelationId();
  const structured = { code: 'X', message: 'm', callInstance: other };
  const out = safeFromThrown(structured, id);
  assert.equal(out.callInstance, other, 'the error own correlation wins');
});

test('§11.10 safeFromThrown wraps a plain Error into a structured shape (no flattening)', () => {
  const id = mintCorrelationId();
  const out = safeFromThrown(new Error('boom'), id);
  assert.equal(isActionableToolErrorShape(out), true);
  assert.equal(out.code, 'TOOL_UNHANDLED');
  assert.equal(out.message, 'boom');
  assert.equal(out.callInstance, id);
  assert.equal(out.retry, 'retryable');
  // It must be a structured object, never the bare string "Error: boom".
  assert.equal(typeof out, 'object');
});

test('§11.10 safeFromThrown wraps a thrown string into a structured shape', () => {
  const out = safeFromThrown('plain string', null);
  assert.equal(isActionableToolErrorShape(out), true);
  assert.equal(out.message, 'plain string');
  assert.equal(out.callInstance, undefined, 'null correlation → undefined, not a string');
});

test('§11.10 safeFromThrown wraps an unknown thrown value', () => {
  const out = safeFromThrown({ weird: true }, null);
  assert.equal(isActionableToolErrorShape(out), true);
  assert.equal(out.code, 'TOOL_UNHANDLED');
  assert.equal(out.retry, 'retryable');
});

// ===========================================================================
// §11.9 — Common receipt envelope.
// ===========================================================================

test('§11.9 okReceipt carries correlation + production and is not an error', () => {
  const id = mintCorrelationId();
  const r = okReceipt('task_create', { id: 7 }, id);
  assert.equal(r.tool, 'task_create');
  assert.equal(r.ok, true);
  assert.equal(r.correlation, id);
  assert.deepEqual(r.production, { id: 7 });
  assert.equal(r.error, undefined);
});

test('§11.9 errorReceipt carries correlation + structured error', () => {
  const id = mintCorrelationId();
  const r = errorReceipt('task_create', { code: 'X', message: 'm', retry: 'retryable' }, id);
  assert.equal(r.ok, false);
  assert.equal(r.correlation, id);
  assert.equal(r.production, undefined);
  assert.equal(isActionableToolErrorShape(r.error), true);
});

test('§11.9 a receipt allows a null correlation (non-consequential compatibility call)', () => {
  const r = okReceipt('unstructured_tool', { ok: true }, null);
  assert.equal(r.correlation, null);
  assert.equal(r.ok, true);
});

// ===========================================================================
// §11.10 — Structured MCP serialization (the flagship guarantee).
// ===========================================================================

test('§11.10 serializeForMcp preserves a structured error field-for-field across transport', () => {
  // THIS IS THE §11.10 / §0.9.12 EXIT-GATE PROOF: structured errors survive
  // MCP transport. The serialized body carries EVERY repair field plus the
  // kind discriminant and correlation. It is NOT "Error: <msg>".
  const id = mintCorrelationId();
  const err = {
    code: 'FIELD_INVALID',
    message: 'epic_id is required',
    fieldPath: '/epic_id',
    expected: 'integer',
    actual: 'undefined',
    sourceOfTruth: 'docs/schemas/task.json#/epic_id',
    checklistRef: 'planning#step-1',
    trackerRef: 'task/2048',
    resumeStep: 're-plan',
    retry: 'retryable',
  };
  const receipt = errorReceipt('task_create', err, id);
  const wire = serializeForMcp(receipt);

  assert.equal(wire.isError, true, 'failure result is flagged isError');
  assert.equal(wire.content.length, 1);
  assert.equal(wire.content[0].type, 'text');

  // It must NOT be a flattened "Error: ..." string.
  assert.ok(!wire.content[0].text.startsWith('Error:'),
    'error is not flattened into a textual Error string');

  const body = JSON.parse(wire.content[0].text);
  assert.equal(body.kind, SERIALIZED_ERROR_KIND, 'carries the structured-error discriminant');
  assert.equal(body.code, 'FIELD_INVALID');
  assert.equal(body.message, 'epic_id is required');
  assert.equal(body.fieldPath, '/epic_id', 'fieldPath survived transport');
  assert.equal(body.expected, 'integer', 'expected survived transport');
  assert.equal(body.actual, 'undefined', 'actual survived transport');
  assert.equal(body.sourceOfTruth, 'docs/schemas/task.json#/epic_id');
  assert.equal(body.checklistRef, 'planning#step-1', 'checklist ref survived transport');
  assert.equal(body.trackerRef, 'task/2048', 'tracker ref survived transport');
  assert.equal(body.resumeStep, 're-plan', 'resume step survived transport');
  assert.equal(body.retry, 'retryable', 'retry permission survived transport');
  assert.equal(body.callInstance, id, 'call-instance correlation survived transport');
});

test('§11.10 serializeForMcp serializes a success production without isError', () => {
  const id = mintCorrelationId();
  const receipt = okReceipt('task_create', { id: 99, title: 'demo' }, id);
  const wire = serializeForMcp(receipt);
  assert.equal(wire.isError, undefined);
  assert.equal(wire.content.length, 1);
  assert.deepEqual(JSON.parse(wire.content[0].text), { id: 99, title: 'demo' });
});

test('§11.10 serializeError attaches the receipt correlation when the error lacks one', () => {
  const id = mintCorrelationId();
  const serialized = serializeError({ code: 'X', message: 'm' }, id);
  assert.equal(serialized.kind, SERIALIZED_ERROR_KIND);
  assert.equal(serialized.callInstance, id);
});

test('§11.10 round-trip: parseStructuredError recovers the structured error from the wire', () => {
  const id = mintCorrelationId();
  const err = {
    code: 'AUTHORITY_DENIED',
    message: 'not permitted',
    retry: 'not-retryable',
    fieldPath: '/tool',
  };
  const wire = serializeForMcp(errorReceipt('tool_x', err, id));
  const recovered = parseStructuredError(wire);
  assert.ok(recovered, 'structured error recovered from transport');
  assert.equal(recovered.code, 'AUTHORITY_DENIED');
  assert.equal(recovered.retry, 'not-retryable');
  assert.equal(recovered.fieldPath, '/tool');
  assert.equal(recovered.callInstance, id);
  assert.equal(recovered.kind, SERIALIZED_ERROR_KIND);
});

test('§11.10 parseStructuredError returns null for a success result', () => {
  const wire = serializeForMcp(okReceipt('tool_x', { ok: true }, null));
  assert.equal(parseStructuredError(wire), null);
});

test('§11.10 parseStructuredError returns null for a unsupported flattened Error string', () => {
  // A gateway that violated §11.10 and produced "Error: boom" cannot trick the
  // receiver into treating it as structured. The receiver treats it as
  // unrecoverable rather than guessing a repair contract.
  const unsupported = {
    content: [{ type: 'text', text: 'Error: boom' }],
    isError: true,
  };
  assert.equal(parseStructuredError(unsupported), null);
});

test('§11.10 parseStructuredError ignores a success body that happens to contain an error field', () => {
  // Without the kind discriminant, a body is ordinary production. An error
  // must be explicitly marked, never inferred from a field name.
  const wire = serializeForMcp(
    okReceipt('tool_x', { error: 'something', ok: false }, null),
  );
  assert.equal(parseStructuredError(wire), null);
});

// ===========================================================================
// End-to-end gateway-mirror: validate → strip → dispatch → serialize.
//
// This mirrors the exact sequence the Wave 11 gateway will run, proving the
// contract composes correctly without depending on src/index.ts.
// ===========================================================================

test('§11.9-11.10 end-to-end: validate, strip, dispatch success, serialize', () => {
  const id = mintCorrelationId();
  const inbound = { [CALL_CORRELATION_KEY]: id, taskId: 5, title: 'demo' };

  // 1. Validate (gateway rejects non-platform ids before decoding).
  assert.equal(isValidCorrelationId(readCorrelationId(inbound)), true);

  // 2. Strip before handler input decoding.
  const handlerInput = stripCorrelation(inbound);
  assert.equal(CALL_CORRELATION_KEY in handlerInput, false);

  // 3. Dispatch — the handler sees only its declared contract.
  const production = simulateHandler(handlerInput);

  // 4. Serialize.
  const wire = serializeForMcp(okReceipt('task_update', production, id));
  assert.equal(wire.isError, undefined);
  assert.deepEqual(JSON.parse(wire.content[0].text), { id: 5, title: 'demo' });

  function simulateHandler(input) {
    // A real handler must never see the correlation token.
    assert.equal(CALL_CORRELATION_KEY in input, false);
    return { id: input.taskId, title: input.title };
  }
});

test('§11.9-11.10 end-to-end: handler throws, error survives transport structured', () => {
  const id = mintCorrelationId();
  const inbound = { [CALL_CORRELATION_KEY]: id, taskId: -1 };

  const handlerInput = stripCorrelation(inbound);
  let thrown;
  try {
    simulateFailingHandler(handlerInput);
  } catch (e) {
    thrown = e;
  }
  const structured = safeFromThrown(thrown, id);
  const wire = serializeForMcp(errorReceipt('task_update', structured, id));

  assert.equal(wire.isError, true);
  const recovered = parseStructuredError(wire);
  assert.ok(recovered);
  assert.equal(recovered.code, 'FIELD_INVALID');
  assert.equal(recovered.fieldPath, '/taskId');
  assert.equal(recovered.callInstance, id);

  function simulateFailingHandler(input) {
    if (input.taskId < 0) {
      throw {
        code: 'FIELD_INVALID',
        message: 'taskId must be non-negative',
        fieldPath: '/taskId',
        retry: 'retryable',
      };
    }
  }
});

test('§11.9-11.10 end-to-end: invalid correlation is treated as absent (validated before decode)', () => {
  // A non-platform value under the reserved key does not pass validation, so
  // the gateway treats the call as uncorrelated. The reserved key is still
  // stripped before the handler runs.
  const inbound = { [CALL_CORRELATION_KEY]: 'attacker/bogus', taskId: 1 };
  assert.equal(readCorrelationId(inbound), null, 'invalid id reads back as null');
  const handlerInput = stripCorrelation(inbound);
  assert.equal(CALL_CORRELATION_KEY in handlerInput, false, 'reserved key still stripped');
});
