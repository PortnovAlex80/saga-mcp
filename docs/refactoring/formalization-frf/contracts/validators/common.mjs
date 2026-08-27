/**
 * FRF-WP03 minimal semantic contracts - shared pure helpers.
 *
 * These contracts are PAYLOAD CONTRACTS ONLY (plan FRF-WP03: "Adds no
 * artifact type or mutable storage owner"). No production module imports
 * this file; the FRF-04..09 cells will adopt the schemas/validators as
 * their product payload contracts and call the validators with the exact
 * accepted id sets carried by transitions.
 *
 * Purity: node:crypto (deterministic hashing) and pure functions only.
 * No I/O, no clock, no session, no SQL.
 *
 * Canonical rule: byte-identical to src/workflow-kernel/domain/digest.ts
 * (recursively key-sorted, compact JSON.stringify, sha256 over UTF-8).
 */

import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Canonical serialization + digests (frozen kernel rule)               */
/* ------------------------------------------------------------------ */

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

export function sha256OfCanonical(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function sha256OfText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** sha256 over the canonical JSON of the object minus excluded top-level keys. */
export function digestExcluding(value, excludedKeys) {
  const copy = {};
  for (const key of Object.keys(value)) {
    if (!excludedKeys.includes(key)) copy[key] = value[key];
  }
  return sha256OfCanonical(copy);
}

/* ------------------------------------------------------------------ */
/* Typed refusals (the closed kernel refusal vocabulary)                */
/* ------------------------------------------------------------------ */

export const REFUSAL_REASONS = Object.freeze([
  'COVERAGE_GAP',
  'DRIFT_DETECTED',
  'FOREIGN_LINEAGE',
  'MALFORMED_PRODUCT',
  'MISSING_LINEAGE',
  'SCOPE_VIOLATION',
  'STALE_LINEAGE',
]);

export function refused(reason, detail) {
  return { detail, ok: false, reason, refused: true };
}

export function sealed(kind, payload) {
  const digest = sha256OfCanonical(payload);
  return { digest, kind, ok: true, ref: `sha256:${digest}` };
}

/* ------------------------------------------------------------------ */
/* The accepted id-set universe (fail-closed lineage resolution)        */
/* ------------------------------------------------------------------ */

/**
 * The supplied accepted-ids universe. Every validator refuses (fail-closed)
 * when a payload cites a reference class whose accepted id set was not
 * supplied, or cites an id outside the supplied set. This is the
 * UC-FOREIGN fix TARGET surface: a binding that does not resolve against
 * the exact accepted id sets is a typed FOREIGN_LINEAGE refusal.
 */
export function requireIdSet(universe, setName, purpose) {
  const sets = universe?.idSets ?? undefined;
  const value = sets?.[setName];
  if (!Array.isArray(value) || value.length === 0) {
    return refused('MISSING_LINEAGE', `no accepted ${setName} set was supplied (${purpose}); the validator is fail-closed and will not guess the accepted universe`);
  }
  return null;
}

/** Resolve refs against a supplied accepted set; typed refusals on mismatch. */
export function resolveRefs(refs, setName, universe, { purpose }) {
  if (!Array.isArray(refs) || refs.length === 0) {
    return refused('MISSING_LINEAGE', `${purpose} cites no accepted ${setName} reference`);
  }
  const missing = requireIdSet(universe, setName, purpose);
  if (missing !== null) return missing;
  const acceptedIds = universe.idSets[setName];
  const foreign = refs.filter((ref) => !acceptedIds.includes(ref));
  if (foreign.length > 0) {
    return refused('FOREIGN_LINEAGE', `${purpose} cites ${setName} outside the exact accepted id set: ${foreign.sort().join(', ')}`);
  }
  return null;
}

/**
 * Resolve terminal-branch refs at their OWN level: every branch must resolve
 * inside the branch id set of one of the CITED owning scenarios (reverse
 * edge/0094: "branch identities resolve against the owning scenario's frozen
 * branch id set"). A branch id that exists in another scenario - or nowhere -
 * is a cross-level citation and is refused FOREIGN_LINEAGE.
 */
export function resolveBranchRefsWithinCitedScenarios(branchRefs, scenarioRefs, universe, { branchSetMissing, purpose }) {
  if (!Array.isArray(branchRefs) || branchRefs.length === 0) {
    return refused('MISSING_LINEAGE', `${purpose} cites no UC terminal branch`);
  }
  const byScenario = universe?.idSets?.ucBranchIdsByScenario;
  if (byScenario === undefined || byScenario === null || typeof byScenario !== 'object') {
    return refused('MISSING_LINEAGE', branchSetMissing);
  }
  const citedScenarios = Array.isArray(scenarioRefs) ? scenarioRefs : [];
  const owningBranches = new Set();
  for (const scenarioId of citedScenarios) {
    for (const branchId of byScenario[scenarioId] ?? []) owningBranches.add(branchId);
  }
  const foreign = branchRefs.filter((ref) => !owningBranches.has(ref));
  if (foreign.length > 0) {
    const knownElsewhere = foreign.filter((ref) =>
      Object.values(byScenario).some((branchIds) => branchIds.includes(ref)));
    if (knownElsewhere.length === foreign.length && foreign.length > 0) {
      return refused('FOREIGN_LINEAGE', `${purpose} cites terminal branch(es) ${foreign.sort().join(', ')} whose owning scenario is not among the cited scenario references (cross-level citation; a branch resolves within exactly one owning UC scenario)`);
    }
    return refused('FOREIGN_LINEAGE', `${purpose} cites terminal branch(es) ${foreign.sort().join(', ')} outside the accepted branch id sets`);
  }
  return null;
}

/** Set equality helper with per-direction typed reporting. */
export function setIdentical(actualIds, expectedIds, { extraRefusal = 'FOREIGN_LINEAGE', missingRefusal = 'COVERAGE_GAP', subject }) {
  const actual = [...actualIds].sort();
  const expected = [...expectedIds].sort();
  const extra = actual.filter((id) => !expected.includes(id));
  if (extra.length > 0) {
    return refused(extraRefusal, `${subject} contains ${extra.join(', ')} outside the exact accepted id set (the freezer never adopts foreign or substituted material)`);
  }
  const missing = expected.filter((id) => !actual.includes(id));
  if (missing.length > 0) {
    return refused(missingRefusal, `${subject} is missing accepted member(s) ${missing.join(', ')} (exact set equality; accepted material cannot disappear at freeze)`);
  }
  return null;
}

/** Duplicates in an id/digest list are substitution or double emission. */
export function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

/* ------------------------------------------------------------------ */
/* Minimal JSON Schema draft 2020-12 subset engine                      */
/* ------------------------------------------------------------------ */

/**
 * The structural layer of the payload contracts. Supports exactly the
 * keyword subset used by the five schema documents:
 *   $ref (root-local #/$defs/*), type, enum, const, properties, required,
 *   additionalProperties (boolean), items, minLength, minItems, uniqueItems,
 *   pattern. Deterministic, dependency-free, fail-closed on unknown
 *   structural keywords inside "properties"/"$defs" subtrees is NOT
 *   enforced (unknown keywords are ignored per JSON Schema spec); the
 *   schema-file meta-check in run-proof.mjs keeps the subset closed.
 */
export function validateWithSchema(schema, instance) {
  const errors = [];
  const visit = (node, value, path) => {
    if (node === undefined || node === null) return;
    if (typeof node.$ref === 'string') {
      const resolved = resolveRef(schema, node.$ref);
      if (resolved === undefined) {
        errors.push({ instancePath: path, message: `unresolvable $ref ${node.$ref}`, schemaPath: '$ref' });
        return;
      }
      visit(resolved, value, path);
      return;
    }
    if (node.const !== undefined && value !== node.const) {
      errors.push({ instancePath: path, message: `expected const ${JSON.stringify(node.const)}`, schemaPath: 'const' });
    }
    if (Array.isArray(node.enum) && !node.enum.some((option) => value === option || (typeof value === 'number' && option === value))) {
      errors.push({ instancePath: path, message: `value ${JSON.stringify(value)} outside closed enum [${node.enum.join(', ')}]`, schemaPath: 'enum' });
    }
    if (typeof node.type === 'string') {
      const matches =
        (node.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) ||
        (node.type === 'array' && Array.isArray(value)) ||
        (node.type === 'string' && typeof value === 'string') ||
        (node.type === 'number' && typeof value === 'number') ||
        (node.type === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
        (node.type === 'boolean' && typeof value === 'boolean') ||
        (node.type === 'null' && value === null);
      if (!matches) {
        errors.push({ instancePath: path, message: `expected type ${node.type}`, schemaPath: 'type' });
        return;
      }
    }
    if (typeof value === 'string') {
      if (typeof node.minLength === 'number' && value.length < node.minLength) {
        errors.push({ instancePath: path, message: `shorter than minLength ${node.minLength}`, schemaPath: 'minLength' });
      }
      if (typeof node.pattern === 'string' && !new RegExp(node.pattern).test(value)) {
        errors.push({ instancePath: path, message: `does not match pattern ${node.pattern}`, schemaPath: 'pattern' });
      }
    }
    if (Array.isArray(value)) {
      if (typeof node.minItems === 'number' && value.length < node.minItems) {
        errors.push({ instancePath: path, message: `fewer than minItems ${node.minItems}`, schemaPath: 'minItems' });
      }
      if (node.uniqueItems === true) {
        const duplicates = findDuplicates(value.map((entry) => canonicalJson(entry)));
        if (duplicates.length > 0) {
          errors.push({ instancePath: path, message: `duplicate items`, schemaPath: 'uniqueItems' });
        }
      }
      if (node.items !== undefined) {
        value.forEach((entry, index) => visit(node.items, entry, `${path}[${index}]`));
      }
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of node.required ?? []) {
        if (!(key in value)) {
          errors.push({ instancePath: path, message: `missing required property "${key}"`, schemaPath: 'required' });
        }
      }
      if (node.properties !== undefined) {
        for (const [key, child] of Object.entries(node.properties)) {
          if (key in value) visit(child, value[key], path === '' ? key : `${path}.${key}`);
        }
      }
      if (node.additionalProperties === false && node.properties !== undefined) {
        for (const key of Object.keys(value)) {
          if (!(key in node.properties)) {
            errors.push({ instancePath: path, message: `unexpected property "${key}" (additionalProperties: false)`, schemaPath: 'additionalProperties' });
          }
        }
      }
    }
  };
  visit(schema, instance, '');
  return errors;
}

function resolveRef(schema, ref) {
  if (!ref.startsWith('#/')) return undefined;
  let node = schema;
  for (const segment of ref.slice(2).split('/')) {
    node = node?.[segment];
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* Common id patterns                                                  */
/* ------------------------------------------------------------------ */

export const ID_PATTERN = '^[a-z][a-z0-9]*(:[A-Za-z0-9][A-Za-z0-9._-]*)+$';
export const SHA256_REF_PATTERN = '^sha256:[0-9a-f]{64}$';
export const SHA256_HEX_PATTERN = '^[0-9a-f]{64}$';
