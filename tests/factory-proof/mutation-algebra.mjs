// tests/factory-proof/mutation-algebra.mjs
//
// W0-2 — the shared structural/relational mutation algebra (ADR-084, brief
// revision a8014c03). Compiles finite mutant families from
// AcceptanceObligationContracts:
//
//   - STRUCTURAL operators derive from a subject schema descriptor
//     (missing required, wrong type/enum/bounds, empty, malformed,
//     unknown field, incompatible version);
//   - RELATIONAL operators derive from the constraint DSL
//     (zero/below/above cardinality, duplicate, malformed/truncated/near-miss
//     grammar, missing/foreign/stale/cross-run ref, wrong-object digest,
//     missing/extra/substituted member, empty/ambiguous projection, broken
//     lineage, ordering, version, cross-field mismatch).
//
// A MutantCase never carries the expected production ANSWER — only the
// violated constraint and the authorized rejection boundary where the
// assigned protection must kill it. The kill matrix observes what the real
// boundary does; an ACCEPTED violating mutant is a blocking failure.
//
// Deterministic: every case carries a seedDigest over
// (obligationId, operatorId, violatedConstraint, mutant seed). No Math.random.

import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(typeof value === 'string'
  ? value
  : JSON.stringify(value), 'utf8').digest('hex');

export const STRUCTURAL_OPERATORS = Object.freeze([
  'missing-required', 'wrong-type', 'enum-invalid', 'empty-value',
  'malformed-payload', 'unknown-field', 'version-incompatible',
]);

export const RELATIONAL_OPERATORS = Object.freeze([
  'cardinality-zero', 'cardinality-below', 'cardinality-above',
  'duplicate-key', 'grammar-malformed', 'grammar-truncated',
  'grammar-near-miss', 'ref-missing', 'ref-foreign', 'ref-stale',
  'ref-cross-run', 'digest-wrong-object', 'member-extra', 'member-missing',
  'member-substituted', 'projection-empty', 'projection-ambiguous',
  'lineage-broken', 'ordering-swapped', 'version-downgraded',
  'crossfield-violated',
]);

/**
 * Build the base (valid) subject object from a schema descriptor:
 * { required: [k...], properties: { k: { type, enum, example } } }.
 */
export function buildWitnessFromSchema(schema) {
  const witness = {};
  for (const [key, def] of Object.entries(schema.properties ?? {})) {
    witness[key] = def.example !== undefined
      ? structuredClone(def.example)
      : def.type === 'array' ? [] : def.type === 'number' ? 1 : 'x';
  }
  return witness;
}

/**
 * Structural mutants of a schema-described subject. Each operator returns a
 * mutant subject (or null when not applicable, e.g. enum without enum).
 */
export function structuralMutants(schema, obligationId) {
  const base = buildWitnessFromSchema(schema);
  const cases = [];
  const mk = (operatorId, violated, subject) => ({
    obligationId,
    operatorId,
    violatedConstraint: `schema:${violated}`,
    expectedBoundary: 'intake-or-gate',
    mutant: subject,
    seedDigest: sha({ obligationId, operatorId, violated, subject }),
  });

  for (const key of schema.required ?? []) {
    const m = structuredClone(base);
    delete m[key];
    cases.push(mk('missing-required', `required:${key}`, m));
  }
  for (const [key, def] of Object.entries(schema.properties ?? {})) {
    if (def.type === 'string') {
      const m = structuredClone(base); m[key] = '';
      cases.push(mk('empty-value', `empty:${key}`, m));
      const w = structuredClone(base); w[key] = 12345;
      cases.push(mk('wrong-type', `type:${key}`, w));
    }
    if (def.type === 'number') {
      const w = structuredClone(base); w[key] = 'not-a-number';
      cases.push(mk('wrong-type', `type:${key}`, w));
      if (def.minimum !== undefined) {
        const b = structuredClone(base); b[key] = def.minimum - 1;
        cases.push(mk('empty-value', `bounds:${key}`, b));
      }
    }
    if (Array.isArray(def.enum)) {
      const w = structuredClone(base); w[key] = `__not_in_enum__${def.enum[0]}`;
      cases.push(mk('enum-invalid', `enum:${key}`, w));
    }
  }
  cases.push(mk('malformed-payload', 'schema:not-an-object', '<<<not-json-object>>>'));
  const u = structuredClone(base); u.__unknown_field__ = 'x';
  cases.push(mk('unknown-field', 'schema:closed-shape', u));
  if (schema.contractVersion) {
    const v = structuredClone(base);
    v[schema.versionField ?? 'contractVersion'] = '0.0.1';
    cases.push(mk('version-incompatible', `version:${schema.contractVersion}`, v));
  }
  return cases;
}

/**
 * Relational mutants from ONE constraint applied to a valid witness.
 * The witness shape depends on the constraint kind:
 *   cardinality/unique/grammar/subset: witness = { [member]: [...] }
 *   ref/digestOf/equality/projection/lineage/ordering/version/crossField:
 *   witness = the field holder object.
 */
export function relationalMutants(constraint, witness, obligationId) {
  const cases = [];
  const mk = (operatorId, mutant) => ({
    obligationId,
    operatorId,
    violatedConstraint: `${constraint.kind}:${constraint.member ?? constraint.field ?? ''}`,
    expectedBoundary: 'assigned-protection',
    mutant,
    seedDigest: sha({ obligationId, operatorId, constraint, mutant }),
  });
  const clone = () => structuredClone(witness);
  const member = constraint.member;
  const field = constraint.field;

  switch (constraint.kind) {
    case 'cardinality': {
      const zero = clone(); zero[member] = [];
      cases.push(mk('cardinality-zero', zero));
      if ((constraint.min ?? 0) > 1) {
        const below = clone(); below[member] = witness[member].slice(0, constraint.min - 1);
        cases.push(mk('cardinality-below', below));
      }
      if (constraint.max !== undefined && witness[member].length >= constraint.max) {
        const above = clone();
        above[member] = [...witness[member], structuredClone(witness[member][0])];
        cases.push(mk('cardinality-above', above));
      }
      return cases;
    }
    case 'unique': {
      const dup = clone();
      const arr = dup[member] ?? dup[field]
        ?? Object.values(dup).find(v => Array.isArray(v));
      if (Array.isArray(arr) && arr.length > 0) {
        arr.push(structuredClone(arr[arr.length - 1]));
        cases.push(mk('duplicate-key', dup));
      }
      return cases;
    }
    case 'grammar': {
      // witness[field] is the grammar-bearing text (or array of texts under
      // member). Families: malformed (pattern broken), truncated (cut), and
      // near-miss (shape-valid but lexically off — e.g. zero-padding/level).
      const texts = member ? witness[member] : [witness[field]];
      const mutated = structuredClone(texts);
      const idx = mutated.findIndex(t => typeof t === 'string' && t.length > 4);
      if (idx >= 0) {
        const malformed = structuredClone(texts);
        malformed[idx] = mutated[idx].replace(/:/, ' ');
        cases.push(mk('grammar-malformed', member
          ? { ...clone(), [member]: malformed }
          : { ...clone(), [field]: malformed[idx] }));

        const truncated = structuredClone(texts);
        truncated[idx] = mutated[idx].slice(0, Math.max(3, mutated[idx].length - 3));
        cases.push(mk('grammar-truncated', member
          ? { ...clone(), [member]: truncated }
          : { ...clone(), [field]: truncated[idx] }));

        const nearMiss = structuredClone(texts);
        // Zero-pad the first numeric run: AC-1 -> AC-01 (the sudoku defect
        // class) or shift a heading level (# vs ##) when the text is markdown.
        nearMiss[idx] = /\d/.test(mutated[idx])
          ? mutated[idx].replace(/(\d+)/, (d) => `0${d}`)
          : mutated[idx].replace(/^#{2,3}/, '#');
        cases.push(mk('grammar-near-miss', member
          ? { ...clone(), [member]: nearMiss }
          : { ...clone(), [field]: nearMiss[idx] }));
      }
      return cases;
    }
    case 'ref': {
      const missing = clone(); delete missing[field];
      cases.push(mk('ref-missing', missing));
      const foreign = clone();
      foreign[field] = `foreign:${String(witness[field]).slice(0, 24)}`;
      cases.push(mk('ref-foreign', foreign));
      const stale = clone();
      stale[field] = `${String(witness[field])}@stale-revision`;
      cases.push(mk('ref-stale', stale));
      const crossRun = clone();
      crossRun[field] = `${String(witness[field])}@run/9999`;
      cases.push(mk('ref-cross-run', crossRun));
      return cases;
    }
    case 'digestOf': {
      const wrong = clone();
      wrong[field] = sha(`wrong-object:${obligationId}`);
      cases.push(mk('digest-wrong-object', wrong));
      return cases;
    }
    case 'equality': {
      const mismatch = clone();
      mismatch[field] = `${String(witness[field])}__mutated`;
      cases.push(mk('member-substituted', mismatch));
      return cases;
    }
    case 'subset': {
      const extra = clone();
      extra[member] = [...(witness[member] ?? []), '__outside_of__'];
      cases.push(mk('member-extra', extra));
      const dropped = clone();
      if (Array.isArray(witness[member]) && witness[member].length > 0) {
        dropped[member] = witness[member].slice(1);
        cases.push(mk('member-missing', dropped));
      }
      const substituted = clone();
      if (Array.isArray(witness[member]) && witness[member].length > 0) {
        substituted[member] = witness[member].map(v => `${v}__substituted`);
        cases.push(mk('member-substituted', substituted));
      }
      return cases;
    }
    case 'projection': {
      const empty = clone();
      empty[field] = Array.isArray(witness[field]) ? [] : null;
      cases.push(mk('projection-empty', empty));
      const ambiguous = clone();
      ambiguous[field] = Array.isArray(witness[field])
        ? [...witness[field], structuredClone(witness[field][0] ?? { dup: true })]
        : { a: 1, b: 2 };
      cases.push(mk('projection-ambiguous', ambiguous));
      return cases;
    }
    case 'lineage': {
      const broken = clone();
      broken[field] = [];
      cases.push(mk('lineage-broken', broken));
      return cases;
    }
    case 'ordering': {
      const swapped = clone();
      const arr = swapped[field];
      if (Array.isArray(arr) && arr.length >= 2) {
        [arr[0], arr[1]] = [arr[1], arr[0]];
        cases.push(mk('ordering-swapped', swapped));
      } else {
        cases.push(mk('ordering-swapped', { ...swapped, __order_marker__: 2 }));
      }
      return cases;
    }
    case 'version': {
      const downgraded = clone();
      downgraded[field] = '0.0.1';
      cases.push(mk('version-downgraded', downgraded));
      return cases;
    }
    case 'crossField': {
      const violated = clone();
      violated.__crossfield_violation__ = true;
      cases.push(mk('crossfield-violated', violated));
      return cases;
    }
    default:
      return cases;
  }
}

/**
 * Compile the full mutant family of one obligation contract:
 * structural (schema) + relational (constraints, over the provided witness).
 * Returns a NON-EMPTY family or throws — an obligation without a generatable
 * family is a registry failure (brief W0-2 §6).
 */
export function compileObligationMutants(contract, witness) {
  const family = [];
  if (contract.mutationProfile?.structural && contract.subjectSchema) {
    family.push(...structuralMutants(contract.subjectSchema, contract.obligationId));
  }
  if (contract.mutationProfile?.relational && witness) {
    for (const constraint of contract.constraints) {
      family.push(...relationalMutants(constraint, witness, contract.obligationId));
    }
  }
  if (family.length === 0) {
    throw new Error(
      `OBLIGATION_FAMILY_EMPTY: ${contract.obligationId} compiled zero mutants — `
      + `every obligation must declare a schema and/or a witness its constraints apply to.`,
    );
  }
  return family;
}

/**
 * Run the kill matrix against a REAL boundary (sync or async).
 *
 * @param {Array} cases MutantCase[] (from compileObligationMutants)
 * @param {(mutantCase) => {accepted:boolean, code?:string, reason?:string}|Promise} boundary
 *        The authorized rejection boundary under test (a real validator/gate
 *        entry). It receives the whole case (mutant + constraint metadata).
 * @param {object} [meta] {obligationId, detector} recorded into every row.
 * @returns {Promise<{matrix: Array, failures: Array}>} — ACCEPTED (or missing
 *          verdict) rows land in failures naming obligation/operator/detector.
 */
export async function runKillMatrix(cases, boundary, meta = {}) {
  const matrix = [];
  const failures = [];
  for (const c of cases) {
    let outcome;
    let signal = null;
    try {
      const verdict = await boundary(c);
      if (verdict && verdict.accepted === true) {
        outcome = 'ACCEPTED';
      } else if (verdict && (verdict.code || verdict.reason)) {
        outcome = 'KILLED_TYPED';
        signal = verdict.code ?? verdict.reason;
      } else {
        outcome = 'UNVERDICTED';
      }
    } catch (error) {
      outcome = 'KILLED_THROW';
      signal = error instanceof Error ? error.message : String(error);
    }
    const row = {
      obligationId: c.obligationId ?? meta.obligationId,
      operatorId: c.operatorId,
      violatedConstraint: c.violatedConstraint,
      detector: meta.detector ?? 'assigned-protection',
      outcome,
      signal,
      seedDigest: c.seedDigest,
    };
    matrix.push(row);
    if (outcome !== 'KILLED_TYPED' && outcome !== 'KILLED_THROW') {
      failures.push(row);
    }
  }
  return { matrix, failures };
}

export { sha as algebraSeedHash };
