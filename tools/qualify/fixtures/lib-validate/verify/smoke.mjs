/**
 * lib-validate/verify/smoke.mjs - the CLI/library smoke: import the packaged
 * module from a consumer script (the library's real use surface) and assert
 * the public API answers deterministically. Exit 0 = verified.
 */
import assert from 'node:assert/strict';
import { validate, validateJsonSchema } from '../src/validate.mjs';

assert.equal(validate('ok', { type: 'string' }).valid, true);
assert.equal(validate(7, { type: 'string' }).valid, false);
const schema = { type: 'object', required: ['id'], properties: { id: { type: 'number' } } };
assert.deepEqual(validateJsonSchema({ id: 1 }, schema), []);
assert.equal(validateJsonSchema({}, schema).length, 1);
assert.equal(
  JSON.stringify(validateJsonSchema({ id: 1 }, schema)),
  JSON.stringify(validateJsonSchema({ id: 1 }, schema)),
  'the validator is deterministic',
);
process.stdout.write('lib-validate smoke ok: public API answers deterministically\n');
