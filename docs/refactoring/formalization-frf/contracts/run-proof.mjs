/**
 * FRF-WP03 green/refused proof (deterministic, self-validating, dual-mode).
 *
 * Proves, over the committed fixture corpus:
 *   P1  schema documents: five valid JSON Schema draft 2020-12 documents
 *       inside the closed keyword subset, root-closed, enum/required/keys
 *       sorted as written, no timestamp-like keys;
 *   P2  green pairs: every green fixture passes BOTH the structural schema
 *       layer and its pure validator;
 *   P3  red pairs: every red seed is refused by its validator with EXACTLY
 *       the typed refusal code named in its filename;
 *   P4  universe-side refusals: green payloads against fail-closed mutated
 *       accepted-id universes are refused typed (missing sets, missing
 *       pins, substituted identity, well-formed unrelated substitution);
 *   P5  vocabulary discipline: only the closed seven-code refusal
 *       vocabulary is used, and every code is exercised;
 *   P6  determinism: every authored JSON artifact is key-sorted as written.
 *
 * Exit code 0 iff everything holds. No I/O beyond this directory.
 *
 * Usage:
 *   node docs/refactoring/formalization-frf/contracts/run-proof.mjs
 *   node --test docs/refactoring/formalization-frf/contracts/run-proof.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { REFUSAL_REASONS, validateWithSchema } from './validators/common.mjs';
import { validatePrdIntentMember } from './validators/prd-intent-member.mjs';
import { validateUcScenarioMember } from './validators/uc-scenario-member.mjs';
import { validateRequirementsBundle } from './validators/requirements-bundle.mjs';
import { validateAcBinding } from './validators/ac-binding.mjs';
import { validateWhatBaseline } from './validators/what-baseline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SCHEMAS = {
  ac: 'ac-binding',
  base: 'what-baseline',
  prd: 'prd-intent-member',
  req: 'requirements-bundle',
  uc: 'uc-scenario-member',
};

const VALIDATORS = {
  ac: validateAcBinding,
  base: validateWhatBaseline,
  prd: validatePrdIntentMember,
  req: validateRequirementsBundle,
  uc: validateUcScenarioMember,
};

const GREEN_FILES = {
  ac: 'ac-binding.json',
  base: 'what-baseline.json',
  prd: 'prd-intent-member.json',
  req: 'requirements-bundle.json',
  uc: 'uc-scenario-member.json',
};

const ALLOWED_SCHEMA_KEYWORDS = new Set([
  '$defs', '$id', '$ref', '$schema', 'additionalProperties', 'const', 'description', 'enum', 'items',
  'minItems', 'minLength', 'pattern', 'properties', 'required', 'title',
  'type', 'uniqueItems',
]);

const load = (relative) => JSON.parse(readFileSync(path.join(HERE, relative), 'utf8'));

/* ---------- P6 determinism: key-sorted as written, no timestamp-like keys ---------- */

const assertSortedAsWritten = (findings, value, where) => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSortedAsWritten(findings, entry, `${where}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    const sorted = [...keys].sort();
    if (keys.join('\u0000') !== sorted.join('\u0000')) {
      findings.push(`${where} is not key-sorted as written (${keys.join(',')} vs ${sorted.join(',')})`);
    }
    for (const key of keys) {
      if (/^(date|time|.*[Tt]imestamp|createdAt|capturedAt|generatedAt|updatedAt|issuedAt)$/i.test(key)
        || /^(date|time)[A-Z_]/.test(key)) {
        findings.push(`timestamp-like key ${where}.${key}`);
      }
    }
    for (const key of keys) assertSortedAsWritten(findings, value[key], `${where}.${key}`);
  }
};

/* ---------- P1 schema document meta-check ---------- */

const checkSchemaDocument = (findings, short, schema) => {
  const where = `schemas/${SCHEMAS[short]}.schema.json`;
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    findings.push(`${where}: $schema is not draft 2020-12`);
  }
  if (typeof schema.$id !== 'string' || schema.$id.length === 0) {
    findings.push(`${where}: missing $id`);
  }
  if (schema.type !== 'object' || schema.additionalProperties !== false) {
    findings.push(`${where}: root must be a closed object schema`);
  }
  const walk = (node, at) => {
    if (node === null || typeof node !== 'object') return;
    for (const keyword of Object.keys(node)) {
      if (!ALLOWED_SCHEMA_KEYWORDS.has(keyword)) {
        findings.push(`${where}: keyword "${keyword}" at ${at} is outside the closed subset`);
      }
    }
    if (Array.isArray(node.enum) && node.enum.join('\u0000') !== [...node.enum].sort().join('\u0000')) {
      findings.push(`${where}: enum at ${at} is not sorted as written`);
    }
    if (Array.isArray(node.required)) {
      if (node.required.join('\u0000') !== [...node.required].sort().join('\u0000')) {
        findings.push(`${where}: required at ${at} is not sorted as written`);
      }
      for (const key of node.required) {
        if (node.properties === undefined || !(key in node.properties)) {
          findings.push(`${where}: required key "${key}" at ${at} has no property schema`);
        }
      }
    }
    if (node.properties !== undefined && node.additionalProperties !== false) {
      findings.push(`${where}: object schema at ${at} is not closed (additionalProperties: false required)`);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, `${at}.${key}`);
    for (const [key, child] of Object.entries(node.$defs ?? {})) walk(child, `$defs.${key}`);
    if (node.items !== undefined) walk(node.items, `${at}[]`);
  };
  walk(schema, '$');
};

/* ---------- the proof ---------- */

export function runProof() {
  const failures = [];
  const fail = (detail) => failures.push(detail);
  const universe = load('fixtures/accepted-id-sets.json');

  // P1 + P6 over schema documents.
  for (const short of Object.keys(SCHEMAS)) {
    const schema = load(`schemas/${SCHEMAS[short]}.schema.json`);
    const findings = [];
    checkSchemaDocument(findings, short, schema);
    assertSortedAsWritten(findings, schema, `schemas/${SCHEMAS[short]}.schema.json`);
    for (const finding of findings) fail(`P1/P6 ${finding}`);
  }

  // P2 green pairs.
  const greenResults = [];
  for (const short of Object.keys(GREEN_FILES)) {
    const payload = load(`fixtures/green/${GREEN_FILES[short]}`);
    const schemaErrors = validateWithSchema(load(`schemas/${SCHEMAS[short]}.schema.json`), payload);
    if (schemaErrors.length > 0) {
      fail(`P2 green ${short}: schema layer refused: ${JSON.stringify(schemaErrors)}`);
      continue;
    }
    const verdict = VALIDATORS[short](payload, universe);
    if (verdict.ok !== true) {
      fail(`P2 green ${short}: validator refused [${verdict.reason}] ${verdict.detail}`);
      continue;
    }
    greenResults.push({ digest: verdict.digest, kind: verdict.kind, short });
  }

  // P3 red pairs.
  const redFiles = readdirSync(path.join(HERE, 'fixtures/red')).filter((name) => name.endsWith('.json')).sort();
  const exercisedCodes = new Set();
  for (const file of redFiles) {
    const match = file.match(/^(\d+)-(prd|uc|req|ac|base)-([a-z0-9-]+)\.([A-Z_]+)\.json$/);
    if (match === null) {
      fail(`P3 ${file}: filename does not match the seed convention NN-<short>-<slug>.<CODE>.json`);
      continue;
    }
    const [, , short, , expectedCode] = match;
    if (!REFUSAL_REASONS.includes(expectedCode)) {
      fail(`P3 ${file}: expected code ${expectedCode} is outside the closed refusal vocabulary`);
      continue;
    }
    const payload = load(`fixtures/red/${file}`);
    const verdict = VALIDATORS[short](payload, universe);
    if (verdict.ok === true) {
      fail(`P3 ${file}: seed validated ok but must be refused ${expectedCode}`);
      continue;
    }
    if (verdict.reason !== expectedCode) {
      fail(`P3 ${file}: refused [${verdict.reason}] but expected [${expectedCode}]: ${verdict.detail}`);
      continue;
    }
    exercisedCodes.add(verdict.reason);
  }

  // P4 universe-side fail-closed refusals (mutated accepted universes).
  const stripSet = (setName) => {
    const mutated = JSON.parse(JSON.stringify(universe));
    delete mutated.idSets[setName];
    return mutated;
  };
  const universeCases = [
    ['prd', GREEN_FILES.prd, stripSet('sourceClaimIds'), 'MISSING_LINEAGE', 'no accepted source-claim set'],
    ['uc', GREEN_FILES.uc, stripSet('prdMemberIds'), 'MISSING_LINEAGE', 'no accepted PRD member set'],
    ['req', GREEN_FILES.req, stripSet('ucScenarioIds'), 'MISSING_LINEAGE', 'no accepted UC scenario set'],
    ['req', GREEN_FILES.req, { ...JSON.parse(JSON.stringify(universe)), revisionPins: { ...universe.revisionPins, prd: undefined } }, 'MISSING_LINEAGE', 'no accepted PRD revision pin'],
    ['ac', GREEN_FILES.ac, stripSet('frIds'), 'MISSING_LINEAGE', 'no accepted FR id set'],
    ['ac', GREEN_FILES.ac, stripSet('verifiableStatementIds'), 'MISSING_LINEAGE', 'no accepted verifiable-statement set'],
    ['base', GREEN_FILES.base, stripSet('criterionIds'), 'MISSING_LINEAGE', 'no accepted criterion set'],
    ['base', GREEN_FILES.base, { ...JSON.parse(JSON.stringify(universe)), caseIdentity: { discoveryCertificateRef: 'cert:other', formalizationCaseRef: 'case:other' } }, 'DRIFT_DETECTED', 'substituted case identity'],
    ['prd', GREEN_FILES.prd, (() => {
      const mutated = JSON.parse(JSON.stringify(universe));
      mutated.idSets.prdMemberIds = ['prd:x-1', 'prd:x-2'];
      mutated.idSets.sourceClaimIds = ['claim:x-1'];
      return mutated;
    })(), 'FOREIGN_LINEAGE', 'well-formed but semantically unrelated substitution'],
  ];
  for (const [short, file, mutatedUniverse, expectedCode, label] of universeCases) {
    const payload = load(`fixtures/green/${file}`);
    const verdict = VALIDATORS[short](payload, mutatedUniverse);
    if (verdict.ok === true) {
      fail(`P4 ${short} / ${label}: validated ok against a fail-closed universe`);
    } else if (verdict.reason !== expectedCode) {
      fail(`P4 ${short} / ${label}: refused [${verdict.reason}] but expected [${expectedCode}]`);
    } else {
      exercisedCodes.add(verdict.reason);
    }
  }

  // P5 closed refusal vocabulary fully exercised.
  for (const code of REFUSAL_REASONS) {
    if (!exercisedCodes.has(code)) {
      fail(`P5 refusal code ${code} is never exercised by the corpus`);
    }
  }
  if (greenResults.length !== 5) {
    fail(`P2 expected 5 green pairs, ${greenResults.length} passed`);
  }
  if (redFiles.length < 40) {
    fail(`P3 expected at least 40 red seeds, found ${redFiles.length}`);
  }

  // P6 over every authored JSON artifact (fixtures included).
  const walkJsonFiles = (relative) => readdirSync(path.join(HERE, relative), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walkJsonFiles(`${relative}/${entry.name}`) : entry.name.endsWith('.json') ? [`${relative}/${entry.name}`] : []));
  for (const file of [...walkJsonFiles('schemas'), ...walkJsonFiles('fixtures')].sort()) {
    const findings = [];
    assertSortedAsWritten(findings, load(file), file);
    for (const finding of findings) fail(`P6 ${finding}`);
  }

  return {
    green: greenResults,
    redCount: redFiles.length,
    exercisedCodes: [...exercisedCodes].sort(),
    failures,
  };
}

/* ---------- dual-mode entry ---------- */

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

test('frf-wp03 contracts: green/refused proof (P1..P6)', () => {
  const result = runProof();
  if (result.failures.length > 0) {
    throw new Error(`${result.failures.length} failure(s):\n` + result.failures.map((f) => `  ${f}`).join('\n'));
  }
});

if (isDirectRun) {
  const result = runProof();
  if (result.failures.length === 0) {
    console.log(`frf-wp03 contracts: PROOF GREEN (P1..P6 clean)`);
    console.log(`  green pairs: ${result.green.length}/5`);
    console.log(`  red seeds refused typed: ${result.redCount}`);
    console.log(`  refusal codes exercised: ${result.exercisedCodes.join(', ')}`);
  } else {
    console.error(`frf-wp03 contracts: PROOF RED (${result.failures.length} failure(s))`);
    for (const failure of result.failures) console.error(`  ${failure}`);
    process.exitCode = 1;
  }
}
