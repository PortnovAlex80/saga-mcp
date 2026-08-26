/**
 * lib-validate/test/validate.test.mjs - the library's own unit verification
 * (node:test, zero dependencies): rule validation + JSON-Schema validation
 * determinism and typed errors.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, validateJsonSchema } from '../src/validate.mjs';

test('rule validation accepts a conforming value', () => {
  const result = validate(42, { type: 'number', min: 0, max: 100 });
  assert.deepEqual(result, { valid: true, errors: [] });
  assert.equal(JSON.stringify(result), JSON.stringify(validate(42, { type: 'number', min: 0, max: 100 })));
});

test('rule validation reports every violated rule with typed errors', () => {
  const result = validate('nope', { type: 'number', min: 0, enum: [1, 2] });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error) => error.rule).sort(), ['enum', 'type']);
});

test('required + pattern rules behave', () => {
  assert.equal(validate('', { required: true }).valid, false);
  assert.equal(validate('abc-1', { pattern: '^[a-z]+-[0-9]+$' }).valid, true);
  assert.equal(validate('ABC-1', { pattern: '^[a-z]+-[0-9]+$' }).valid, false);
});

test('json-schema validation walks objects, arrays and scalars', () => {
  const schema = {
    type: 'object',
    required: ['name', 'tags'],
    properties: {
      name: { type: 'string' },
      count: { type: 'number', minimum: 1, maximum: 10 },
      tags: { type: 'array', items: { type: 'string', enum: ['red', 'green'] } },
    },
  };
  const good = validateJsonSchema({ name: 'x', count: 5, tags: ['red', 'green'] }, schema);
  assert.deepEqual(good, []);
  const bad = validateJsonSchema({ count: 99, tags: ['red', 'blue'] }, schema);
  assert.deepEqual(bad.map((error) => error.rule).sort(), ['enum', 'maximum', 'required']);
});

test('a wrong container type short-circuits deeper checks', () => {
  const errors = validateJsonSchema('not-an-object', { type: 'object', required: ['a'] });
  assert.deepEqual(errors.map((error) => error.rule), ['type']);
});
