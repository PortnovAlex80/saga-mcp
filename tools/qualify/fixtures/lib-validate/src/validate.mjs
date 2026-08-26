/**
 * lib-validate/src/validate.mjs - the reusable validation library (plan
 * EK-11 P04 + P12): a rule-based value validator and a minimal JSON-Schema
 * (draft-subset) validator. Pure functions, no dependencies; the packaged
 * library surface IS this module.
 */

/** Validate one value against declared rules -> { valid, errors }.
 *  Rules: { type?, required?, min?, max?, pattern?, enum? } */
export function validate(value, rules) {
  const errors = [];
  if (rules.type !== undefined) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (actual !== rules.type) errors.push({ path: '$', rule: 'type', expected: rules.type, actual });
  }
  if (rules.required === true && (value === undefined || value === null || value === '')) {
    errors.push({ path: '$', rule: 'required' });
  }
  if (rules.min !== undefined && typeof value === 'number' && value < rules.min) {
    errors.push({ path: '$', rule: 'min', expected: rules.min, actual: value });
  }
  if (rules.max !== undefined && typeof value === 'number' && value > rules.max) {
    errors.push({ path: '$', rule: 'max', expected: rules.max, actual: value });
  }
  if (rules.pattern !== undefined && typeof value === 'string' && !new RegExp(rules.pattern).test(value)) {
    errors.push({ path: '$', rule: 'pattern', expected: rules.pattern });
  }
  if (rules.enum !== undefined && !rules.enum.includes(value)) {
    errors.push({ path: '$', rule: 'enum', expected: rules.enum });
  }
  return { valid: errors.length === 0, errors };
}

/** Validate one value against a JSON-Schema subset:
 *  type, properties, required, items, enum, minimum, maximum. */
export function validateJsonSchema(value, schema, path = '$') {
  const errors = [];
  const type = schema.type;
  if (type !== undefined) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (actual !== type) {
      errors.push({ path, rule: 'type', expected: type, actual });
      return errors; // a wrong container type makes deeper checks meaningless
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push({ path, rule: 'enum', expected: schema.enum });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, rule: 'minimum', expected: schema.minimum, actual: value });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, rule: 'maximum', expected: schema.maximum, actual: value });
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push({ path: `${path}.${key}`, rule: 'required' });
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validateJsonSchema(value[key], child, `${path}.${key}`));
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => errors.push(...validateJsonSchema(item, schema.items, `${path}[${index}]`)));
  }
  return errors;
}
