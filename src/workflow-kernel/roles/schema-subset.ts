/**
 * workflow-kernel/roles/schema-subset.ts - programmatic validation of
 * CanonicalRoleContract values against the FROZEN schema document (WP-17).
 *
 * This is a faithful TypeScript port of the zero-dependency draft-2020-12
 * subset checker embedded in the frozen admission validator
 * (docs/refactoring/event-kernel/specs/validate-role-contract.mjs, section
 * "Minimal draft-2020-12 subset checker"), INCLUDING its error message
 * formats - tests prove behavioral agreement between this port and the
 * frozen validator on identical inputs.
 *
 * Supported keywords: $ref (local #/$defs/X only), type (string or array),
 * const, enum, pattern, minLength, minItems, maxItems, uniqueItems,
 * minProperties, properties, required, additionalProperties, items.
 * Annotation keywords (title/description/$comment/$id/$schema/$defs) are
 * ignored. The frozen schema deliberately confines itself to this subset so
 * the normative reading is unambiguous.
 *
 * PURITY: imports only the kernel's own canonical JSON rule (deep equality
 * and unique-item checks reuse the ONE canonical serialization).
 */

import { canonicalJson } from '../domain/digest.js';

/** A parsed JSON Schema value of the frozen subset vocabulary. */
export type SchemaDocument = Record<string, unknown>;

function asSchema(value: unknown): SchemaDocument | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as SchemaDocument;
  }
  return undefined;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function resolveRef(ref: string, root: unknown): SchemaDocument {
  const match = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
  if (!match) throw new Error(`UNSUPPORTED_REF (only local #/$defs/X): ${ref}`);
  const rootDoc = asSchema(root);
  const defs = rootDoc ? asSchema(rootDoc.$defs) : undefined;
  const target = defs ? asSchema(defs[match[1]]) : undefined;
  if (!target) throw new Error(`UNRESOLVED_REF: ${ref}`);
  return target;
}

function checkType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    default: throw new Error(`UNSUPPORTED_TYPE: ${type}`);
  }
}

/**
 * Validate value against schema, appending `<path>: <message>` strings to
 * errors. Returns nothing; callers test errors.length.
 */
export function validateSchema(
  value: unknown,
  schema: unknown,
  root: unknown,
  instancePath: string,
  errors: string[],
): void {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${instancePath}: schema forbids any value`);
    return;
  }
  const schemaObj = asSchema(schema);
  if (!schemaObj) return;

  if (typeof schemaObj.$ref === 'string') {
    validateSchema(value, resolveRef(schemaObj.$ref, root), root, instancePath, errors);
  }
  if (schemaObj.type !== undefined) {
    const types = Array.isArray(schemaObj.type) ? schemaObj.type : [schemaObj.type];
    if (!types.some((t) => checkType(value, String(t)))) {
      errors.push(
        `${instancePath}: expected type ${JSON.stringify(schemaObj.type)}, got ${
          Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
        }`,
      );
      return; // further keywords assume the declared type
    }
  }
  if (schemaObj.const !== undefined && !deepEqual(value, schemaObj.const)) {
    errors.push(`${instancePath}: expected const ${JSON.stringify(schemaObj.const)}, got ${JSON.stringify(value)}`);
  }
  if (Array.isArray(schemaObj.enum) && !schemaObj.enum.some((option) => deepEqual(value, option))) {
    errors.push(`${instancePath}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schemaObj.enum)}`);
  }
  if (typeof value === 'string') {
    if (schemaObj.pattern !== undefined && !new RegExp(String(schemaObj.pattern)).test(value)) {
      errors.push(`${instancePath}: string ${JSON.stringify(value)} does not match pattern ${String(schemaObj.pattern)}`);
    }
    if (schemaObj.minLength !== undefined && value.length < Number(schemaObj.minLength)) {
      errors.push(`${instancePath}: string shorter than minLength ${String(schemaObj.minLength)}`);
    }
  }
  if (Array.isArray(value)) {
    if (schemaObj.minItems !== undefined && value.length < Number(schemaObj.minItems)) {
      errors.push(`${instancePath}: array has ${value.length} items, minItems ${String(schemaObj.minItems)}`);
    }
    if (schemaObj.maxItems !== undefined && value.length > Number(schemaObj.maxItems)) {
      errors.push(`${instancePath}: array has ${value.length} items, maxItems ${String(schemaObj.maxItems)}`);
    }
    if (schemaObj.uniqueItems === true) {
      const seen: unknown[] = [];
      for (const item of value) {
        if (seen.some((other) => deepEqual(item, other))) {
          errors.push(`${instancePath}: array items not unique (duplicate ${canonicalJson(item).slice(0, 60)})`);
          break;
        }
        seen.push(item);
      }
    }
    if (schemaObj.items !== undefined) {
      value.forEach((item, index) => {
        validateSchema(item, schemaObj.items, root, `${instancePath}[${index}]`, errors);
      });
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keyCount = Object.keys(record).length;
    if (schemaObj.minProperties !== undefined && keyCount < Number(schemaObj.minProperties)) {
      errors.push(`${instancePath}: object has ${keyCount} properties, minProperties ${String(schemaObj.minProperties)}`);
    }
    const properties = asSchema(schemaObj.properties) ?? {};
    for (const key of Object.keys(properties)) {
      if (key in record) {
        validateSchema(record[key], properties[key], root, `${instancePath}.${key}`, errors);
      }
    }
    if (Array.isArray(schemaObj.required)) {
      for (const key of schemaObj.required) {
        if (!(String(key) in record)) {
          errors.push(`${instancePath}: missing required property "${String(key)}"`);
        }
      }
    }
    if (schemaObj.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          errors.push(`${instancePath}: additional property "${key}" is forbidden (closed shape; adding fields reopens EK-1)`);
        }
      }
    } else if (schemaObj.additionalProperties !== undefined) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          validateSchema(record[key], schemaObj.additionalProperties, root, `${instancePath}.${key}`, errors);
        }
      }
    }
  }
}

/** Validate a value against `<root>/$defs/<name>`, labeled for error output. */
export function validateAgainstDef(
  value: unknown,
  root: unknown,
  defName: string,
  label: string,
  errors: string[],
): void {
  validateSchema(value, { $ref: `#/$defs/${defName}` }, root, label, errors);
}
