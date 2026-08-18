// tests/architecture/material-identity-execution-free.test.mjs
//
// K10 — material identity is execution-free; execution survives ONLY as
// enumerated provenance (Saga Core Renewal Wave 3).
//
// AUDIT FINDING (2026-08-17, K10): the refactor work this release's train
// anticipated (remove producerExecutionRef from material identity; derive
// the CandidateSet seal key from workplace + production revision; drop the
// producer_execution_ref authority column; remove dual-schema readers) was
// already delivered by the ADR-053 Phase 3-7 cutover BEFORE the program
// started:
//
//   - revisionRef / materialDigest / semanticDigest exclude presenter,
//     contributors, adapters, parent path, and ProductRef aliases by
//     construction (workplace-production-revision.ts);
//   - the CandidateSet digest is workplace + productionRevision + role +
//     subject (candidate-set.ts); the ref IS the key;
//   - factory_candidate_sets carries NO execution column at all;
//   - seal_receipt_ref ('seal:<execution>:<role>') is write-only
//     provenance: no reader resolves material by it.
//
// What was missing is the deterministic BAN. This ratchet pins:
//
//   1. The identity-function sources read only material coordinates —
//      an execution/presenter/product-ref reference smuggled into a
//      digest fails.
//   2. The material interface field sets are EXACTLY the enumerated ones;
//      execution refs appear only in the documented provenance fields.
//      Adding any field (especially an execution-scoped authority field)
//      fails the set equality.
//   3. The candidate-set schema stays execution-free; the revision schema
//      carries execution ONLY in its two provenance columns.
//   4. seal_receipt_ref stays write-only provenance (no selecting reader).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');
}

function read(rel) {
  return stripComments(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
}

function functionBody(source, name) {
  const header = new RegExp(`export function ${name}\\(`);
  const match = header.exec(source);
  assert.ok(match, `function ${name} found`);
  // The parameter list may contain object type literals; the BODY opens at
  // the '{' reached when the parameter parenthesis depth is back to zero.
  // match[0] consumed the opening '(' of the parameter list.
  let i = match.index + match[0].length;
  let parenDepth = 1;
  let bodyStart = -1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') parenDepth -= 1;
    else if (ch === '{' && parenDepth === 0) { bodyStart = i; break; }
    i += 1;
  }
  assert.ok(bodyStart >= 0, `function ${name} body found`);
  let depth = 0;
  let j = bodyStart;
  while (j < source.length) {
    if (source[j] === '{') depth += 1;
    else if (source[j] === '}') depth -= 1;
    j += 1;
    if (depth === 0) break;
  }
  return source.slice(bodyStart + 1, j - 1);
}

function interfaceFields(source, name) {
  const header = new RegExp(`export interface ${name}\\s*\\{`);
  const match = header.exec(source);
  assert.ok(match, `interface ${name} found`);
  const start = match.index + match[0].length;
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') depth -= 1;
    i += 1;
  }
  const body = source.slice(start, i - 1);
  const fields = [];
  let baseIndent = null;
  for (const m of body.matchAll(/^([ \t]*)(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/gm)) {
    if (baseIndent === null) baseIndent = m[1];
    if (m[1] === baseIndent) fields.push(m[2]);
  }
  return fields;
}

const REVISION_SRC = 'src/process-modules/domain/workplace/workplace-production-revision.ts';
const CANDIDATE_SRC = 'src/process-modules/domain/workplace/candidate-set.ts';

// ---------------------------------------------------------------------------
// 1. The identity functions read ONLY material coordinates.
// ---------------------------------------------------------------------------

test('K10/ban: materialDigest reads only workplace + (memberKey, contentDigest)', () => {
  const body = functionBody(read(REVISION_SRC), 'materialDigest');
  assert.match(body, /memberKey/u);
  assert.match(body, /contentDigest/u);
  for (const banned of ['presenter', 'contributor', 'executionRef', 'sourceAdapter', 'productRef']) {
    assert.doesNotMatch(body, new RegExp(banned, 'iu'),
      `materialDigest must not read ${banned} — provenance in the digest breaks partition invariance`);
  }
});

test('K10/ban: semanticDigest reads only (memberKey, contentDigest)', () => {
  const body = functionBody(read(REVISION_SRC), 'semanticDigest');
  assert.match(body, /memberKey/u);
  assert.match(body, /contentDigest/u);
  for (const banned of ['presenter', 'contributor', 'executionRef', 'sourceAdapter', 'productRef', 'workplaceRef']) {
    assert.doesNotMatch(body, new RegExp(banned, 'iu'),
      `semanticDigest must not read ${banned} — the cross-run projection is members-only`);
  }
});

test('K10/ban: revisionRef is exactly (schema, workplace, materialDigest, semanticDigest)', () => {
  const body = functionBody(read(REVISION_SRC), 'revisionRef');
  for (const required of ['schema', 'workplaceRef', 'materialDigest', 'semanticDigest']) {
    assert.match(body, new RegExp(required, 'u'), `revisionRef input includes ${required}`);
  }
  for (const banned of ['presenter', 'contributor', 'execution', 'parentRevision', 'sealedAt', 'adapter']) {
    assert.doesNotMatch(body, new RegExp(banned, 'iu'),
      `revisionRef must not read ${banned} — the content address must be partition-invariant`);
  }
});

// ---------------------------------------------------------------------------
// 2. Material interface field sets — execution only as enumerated provenance.
// ---------------------------------------------------------------------------

test('K10/ban: RevisionMember carries execution ONLY in the documented provenance field', () => {
  const fields = interfaceFields(read(REVISION_SRC), 'RevisionMember').sort();
  assert.deepEqual(fields, [
    'contentDigest', 'contributorExecutionRef', 'memberKey',
    'productRef', 'sourceAdapter',
  ]);
});

test('K10/ban: WorkplaceProductionRevision carries execution ONLY in the provenance envelope', () => {
  const fields = interfaceFields(read(REVISION_SRC), 'WorkplaceProductionRevision').sort();
  assert.deepEqual(fields, [
    'contributingExecutionRefs', 'materialDigest', 'members',
    'parentRevisionRef', 'presenterRef', 'revisionRef', 'sealedAt',
    'semanticDigest', 'workplaceRef',
  ]);
});

test('K10/ban: CandidateSet carries no execution field at all', () => {
  const fields = interfaceFields(read(CANDIDATE_SRC), 'CandidateSet');
  const executionFields = fields.filter(f =>
    /execution|presenter|contributor/iu.test(f));
  assert.deepEqual(executionFields, [],
    'CandidateSet authority is execution-free; provenance lives in the revision envelope');
  // The seal receipt is the documented provenance exception.
  assert.ok(fields.includes('sealReceiptRef'),
    'the seal receipt remains as the documented (write-only) provenance field');
});

// ---------------------------------------------------------------------------
// 3. Schema: the authority tables carry no execution authority column.
// ---------------------------------------------------------------------------

test('K10/ban: factory_candidate_sets schema is execution-free', () => {
  const schema = readFileSync(path.join(REPO_ROOT, 'src', 'schema.ts'), 'utf8');
  const match = /CREATE TABLE IF NOT EXISTS factory_candidate_sets \(([\s\S]*?)\n\);/.exec(schema);
  assert.ok(match, 'factory_candidate_sets DDL found');
  const ddl = match[1];
  for (const banned of [/execution/u, /presenter/u, /contributor/u]) {
    assert.doesNotMatch(ddl, banned,
      'the CandidateSet authority table carries no execution-scoped column');
  }
});

test('K10/ban: the revision schema carries execution ONLY in its two provenance columns', () => {
  const schema = readFileSync(path.join(REPO_ROOT, 'src', 'schema.ts'), 'utf8');
  const match = /CREATE TABLE IF NOT EXISTS factory_workplace_production_revisions \(([\s\S]*?)\n\);/.exec(schema);
  assert.ok(match, 'factory_workplace_production_revisions DDL found');
  const ddl = match[1];
  const executionColumns = [...ddl.matchAll(/^\s+([a-z_]*execution[a-z_]*)\s+/gm)]
    .map(m => m[1]);
  assert.deepEqual(
    executionColumns.sort(),
    ['contributing_execution_refs'],
    'only the contributing-provenance column (presenter_ref is the presenter provenance column, '
    + 'not execution-named); identity columns are material_digest/semantic_digest/revision_ref',
  );
});

// ---------------------------------------------------------------------------
// 4. seal_receipt_ref stays write-only provenance.
// ---------------------------------------------------------------------------

test('K10/ban: no reader resolves material by seal_receipt_ref', () => {
  const offenders = [];
  for (const rel of [
    'src/infrastructure/workplace/sqlite-candidate-set-repository.ts',
    'src/process-modules/application/node-executors/production-cell-node-executor.ts',
    'src/process-modules/domain/workplace/candidate-set.ts',
  ]) {
    const source = read(rel);
    // A selecting reader would use the column in a WHERE clause or as a
    // lookup key. Writes (INSERT/VALUES), row-mapping (row.seal_receipt_ref),
    // and shape validation are the legal provenance surfaces.
    const selecting = source.match(
      /(?:WHERE|where)[^;]{0,120}seal_receipt_ref|seal_receipt_ref\s*=\s*\?/gu,
    );
    if (selecting) offenders.push(`${rel}: ${selecting.join(' | ')}`);
  }
  assert.deepEqual(offenders, [],
    'seal_receipt_ref is write-only provenance — resolving material by the sealing receipt '
    + 'would make execution identity an authority key');
});
