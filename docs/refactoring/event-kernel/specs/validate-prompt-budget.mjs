#!/usr/bin/env node
// validate-prompt-budget.mjs — EK-1 frozen admission-spec validator (WP-16 part 3).
//
// Validates the prompt-budget admission specification set in this directory:
//   - prompt-budget-profile.schema.json      (structural self-check against the plan field list)
//   - context-source-classification.json     (closed five-class vocabulary, per-class laws, census coverage)
//   - examples/*.example.json                (miniature valid profiles + illustrative limit table)
//   - an in-memory RED mutation corpus       (every mutation MUST fail; a passing mutation is a validator bug)
//
// Deterministic by construction: no timestamps, no randomness, sorted output.
// Two consecutive runs must print byte-identical output (final RESULT line carries
// a sha256 over the canonical results object).
//
// Usage: node docs/refactoring/event-kernel/specs/validate-prompt-budget.mjs [--digest-only]
// Exit code: 0 = all green + all RED mutations red; 1 = any failure.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EX = join(HERE, 'examples');

// ---------------------------------------------------------------------------
// Frozen constants (mirroring the plan block and the EK-1 spec set)
// ---------------------------------------------------------------------------

// The EXACT PromptBudgetProfile field list from the plan section
// "Bounded prompt and context envelope" — in plan order.
const PLAN_PROFILE_FIELDS = [
  'providerModelLimitTableRef',
  'providerContextLimitTokens',
  'tokenCounterRef',
  'maxProviderRequests',
  'maxStaticTokens',
  'maxDynamicTokens',
  'maxRecoveryTokens',
  'maxToolResultTokens',
  'maxTotalInputTokens',
  'maxCumulativeSessionInputTokens',
  'reservedOutputTokens',
  'providerOverheadReserveTokens',
  'safetyMarginTokens',
  'maxPromptBytes',
];

const POSITIVE_FINITE_LIMIT_FIELDS = [
  'providerContextLimitTokens',
  'maxProviderRequests',
  'maxStaticTokens',
  'maxDynamicTokens',
  'maxRecoveryTokens',
  'maxToolResultTokens',
  'maxTotalInputTokens',
  'maxCumulativeSessionInputTokens',
  'reservedOutputTokens',
  'providerOverheadReserveTokens',
  'safetyMarginTokens',
  'maxPromptBytes',
];

const LAYER_CAP_FIELDS = [
  'maxStaticTokens',
  'maxDynamicTokens',
  'maxRecoveryTokens',
  'maxToolResultTokens',
];

const CLOSED_CLASSES = [
  'mandatory-inline',
  'bounded-summary',
  'content-addressed-reference',
  'bounded-tool-result',
  'forbidden-duplication',
];

const CENSUS_SITES = ['PA-1','PA-2','PA-3','PA-4','PA-5','PA-6','PA-7','PA-8','PA-9','PA-10'];
const CENSUS_SITE_EXCLUDED_FROM_SOURCES = ['PA-2']; // replaced baseline mechanism (coverage.note documents it)

const PINNED_COUNTER_NAME = 'saga-token-counter-protocol';
const PINNED_COUNTER_VERSION = '1';

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const CONTENT_REF_RE = /^content:\/\/[a-z0-9._/-]+$/;

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

const canonical = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
};
const sha256 = (s) => 'sha256:' + createHash('sha256').update(s, 'utf8').digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));

function loadJson(rel) {
  const raw = readFileSync(join(HERE, rel), 'utf8');
  return { doc: JSON.parse(raw), raw };
}

// ---------------------------------------------------------------------------
// Profile validation (mirrors prompt-budget-profile.schema.json + plan invariants)
// ---------------------------------------------------------------------------

function validatePositiveFinite(value, field, errs) {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isInteger(value) || value < 1) {
    errs.push(`${field}: not a positive finite integer (zero, missing, fractional, non-number and unbounded sentinels all fail closed): ${JSON.stringify(value)}`);
  } else if (!Number.isSafeInteger(value)) {
    errs.push(`${field}: exceeds safe integer range (not finite-safe)`);
  }
}

function validateRefShape(ref, field, errs) {
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) {
    errs.push(`${field}: must be an object`);
    return;
  }
  const allowed = new Set(['ref', 'digest', 'digestAlgorithm']);
  for (const k of Object.keys(ref)) if (!allowed.has(k)) errs.push(`${field}.${k}: additional property not allowed`);
  for (const k of ['ref', 'digest', 'digestAlgorithm']) if (!(k in ref)) errs.push(`${field}.${k}: required`);
  if ('ref' in ref && (typeof ref.ref !== 'string' || !CONTENT_REF_RE.test(ref.ref))) errs.push(`${field}.ref: not a content-addressed reference`);
  if ('digest' in ref && (typeof ref.digest !== 'string' || !SHA256_RE.test(ref.digest))) errs.push(`${field}.digest: not sha256:<64 lowercase hex>`);
  if ('digestAlgorithm' in ref && ref.digestAlgorithm !== 'sha256') errs.push(`${field}.digestAlgorithm: must be "sha256"`);
}

function validateTokenCounterRef(tc, errs) {
  const field = 'tokenCounterRef';
  if (typeof tc !== 'object' || tc === null || Array.isArray(tc)) {
    errs.push(`${field}: must be an object`);
    return;
  }
  const allowed = new Set(['name', 'protocolVersion', 'implementationRef', 'digest', 'digestAlgorithm', 'encoding']);
  for (const k of Object.keys(tc)) if (!allowed.has(k)) errs.push(`${field}.${k}: additional property not allowed`);
  for (const k of allowed) if (!(k in tc)) errs.push(`${field}.${k}: required`);
  if (tc.name !== PINNED_COUNTER_NAME) errs.push(`${field}.name: counter protocol not pinned (expected const "${PINNED_COUNTER_NAME}", got ${JSON.stringify(tc.name)}) — drift is a mismatch failure`);
  if (tc.protocolVersion !== PINNED_COUNTER_VERSION) errs.push(`${field}.protocolVersion: not pinned to "${PINNED_COUNTER_VERSION}"`);
  if ('implementationRef' in tc && (typeof tc.implementationRef !== 'string' || !CONTENT_REF_RE.test(tc.implementationRef))) errs.push(`${field}.implementationRef: not a content-addressed reference`);
  if ('digest' in tc && (typeof tc.digest !== 'string' || !SHA256_RE.test(tc.digest))) errs.push(`${field}.digest: not sha256:<64 lowercase hex>`);
  if ('digestAlgorithm' in tc && tc.digestAlgorithm !== 'sha256') errs.push(`${field}.digestAlgorithm: must be "sha256"`);
  if ('encoding' in tc && (typeof tc.encoding !== 'string' || tc.encoding.length < 1)) errs.push(`${field}.encoding: must be a non-empty string`);
}

/** Mirrors the schema root + the plan's formula laws. Returns array of errors (empty = valid). */
export function validateProfile(profile) {
  const errs = [];
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
    errs.push('profile: must be an object');
    return errs;
  }
  const allowed = new Set(PLAN_PROFILE_FIELDS);
  for (const k of Object.keys(profile)) if (!allowed.has(k)) errs.push(`profile.${k}: additional property not allowed (the plan field list is exact)`);
  for (const k of PLAN_PROFILE_FIELDS) if (!(k in profile)) errs.push(`profile.${k}: required (a missing limit is fail-closed invalid, not unbounded-valid)`);

  if ('providerModelLimitTableRef' in profile) validateRefShape(profile.providerModelLimitTableRef, 'providerModelLimitTableRef', errs);
  if ('tokenCounterRef' in profile) validateTokenCounterRef(profile.tokenCounterRef, errs);
  for (const f of POSITIVE_FINITE_LIMIT_FIELDS) if (f in profile) validatePositiveFinite(profile[f], `profile.${f}`, errs);

  // Formula coherence (only when the inputs are present and finite).
  const num = (f) => (POSITIVE_FINITE_LIMIT_FIELDS.includes(f) && typeof profile[f] === 'number' && Number.isInteger(profile[f]) && profile[f] >= 1 ? profile[f] : null);
  const ctx = num('providerContextLimitTokens');
  const reserved = num('reservedOutputTokens');
  const overhead = num('providerOverheadReserveTokens');
  const margin = num('safetyMarginTokens');
  const total = num('maxTotalInputTokens');
  const cumulative = num('maxCumulativeSessionInputTokens');
  if (ctx !== null && reserved !== null && overhead !== null && margin !== null) {
    const eff = ctx - reserved - overhead - margin;
    if (eff < 1) errs.push(`formula: effectiveInputLimit = ${eff} (must be positive)`);
    if (total !== null && total > eff) errs.push(`formula: maxTotalInputTokens (${total}) > effectiveInputLimit (${eff})`);
    if (total !== null && cumulative !== null) {
      const requestCap = Math.min(total, eff);
      if (cumulative < requestCap) errs.push(`formula: maxCumulativeSessionInputTokens (${cumulative}) < per-request cap (${requestCap}) — session budget below one maximal request is incoherent`);
    }
  }
  if (total !== null) {
    for (const f of LAYER_CAP_FIELDS) {
      const cap = num(f);
      if (cap !== null && cap > total) errs.push(`formula: ${f} (${cap}) > maxTotalInputTokens (${total}) — a layer cannot exceed the whole request cap`);
    }
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Limit-table artifact validation (read-only lookup, no selection semantics)
// ---------------------------------------------------------------------------

const TABLE_ROW_KEYS = ['provider', 'model', 'version', 'contextLimitTokens'];

export function validateTableArtifact(table) {
  const errs = [];
  if (typeof table !== 'object' || table === null || Array.isArray(table)) {
    errs.push('limit table: must be an object');
    return errs;
  }
  const allowed = new Set(['kind', 'rows']);
  for (const k of Object.keys(table)) if (!allowed.has(k)) errs.push(`limit table.${k}: additional property not allowed`);
  if (table.kind !== 'provider-model-limit-table') errs.push('limit table.kind: must be "provider-model-limit-table"');
  if (!Array.isArray(table.rows) || table.rows.length < 1) {
    errs.push('limit table.rows: must be a non-empty array');
    return errs;
  }
  const seen = new Set();
  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i];
    const at = `limit table.rows[${i}]`;
    if (typeof row !== 'object' || row === null || Array.isArray(row)) { errs.push(`${at}: must be an object`); continue; }
    for (const k of Object.keys(row)) if (!TABLE_ROW_KEYS.includes(k)) errs.push(`${at}.${k}: additional property not allowed — selection/fallback/priority semantics are structurally forbidden`);
    for (const k of TABLE_ROW_KEYS) if (!(k in row)) errs.push(`${at}.${k}: required`);
    for (const k of ['provider', 'model', 'version']) {
      if (k in row && (typeof row[k] !== 'string' || row[k].length < 1)) errs.push(`${at}.${k}: must be a non-empty string`);
      if (row[k] === '*') errs.push(`${at}.${k}: wildcard key forbidden — exact (provider, model, version) keys only`);
    }
    if ('contextLimitTokens' in row) validatePositiveFinite(row.contextLimitTokens, `${at}.contextLimitTokens`, errs);
    if (row.provider && row.model && row.version) {
      const key = `${row.provider}|${row.model}|${row.version}`;
      if (seen.has(key)) errs.push(`${at}: duplicate exact-key row`);
      seen.add(key);
    }
  }
  return errs;
}

/** sha256 over the canonicalized rows array (the content-addressing used by the example artifacts). */
export const tableRowsDigest = (rows) => sha256(canonical(rows));

// ---------------------------------------------------------------------------
// Example-document validation (wrapper + profile + route lookup + digest binding)
// ---------------------------------------------------------------------------

export function validateExample(doc, tableDoc) {
  const errs = [];
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) { errs.push('example: must be an object'); return errs; }
  if (doc.illustrativeOnly !== true) errs.push('example.illustrativeOnly: examples must be marked illustrative (real tables land at EK-8)');
  const route = doc.pinnedRoute;
  if (typeof route !== 'object' || route === null) { errs.push('example.pinnedRoute: required (the exact provider/model/version the example pins)'); return errs; }
  for (const k of ['provider', 'model', 'version']) if (typeof route[k] !== 'string' || route[k].length < 1) errs.push(`example.pinnedRoute.${k}: required non-empty string`);

  errs.push(...validateProfile(doc.profile).map((e) => `profile: ${e}`));

  if (tableDoc) {
    const table = tableDoc.table;
    errs.push(...validateTableArtifact(table).map((e) => `table(${doc.tableFile}): ${e}`));
    const computed = tableRowsDigest(table.rows);
    if (tableDoc.computedRowsDigest !== computed) errs.push(`table(${doc.tableFile}).computedRowsDigest: declared ${tableDoc.computedRowsDigest} != computed ${computed}`);
    const row = table.rows.find((r) => r.provider === route.provider && r.model === route.model && r.version === route.version);
    if (!row) {
      errs.push(`route lookup: no exact-key row for ${route.provider}/${route.model}/${route.version} — unsupported provider/model limit fails closed`);
    } else if (doc.profile && row.contextLimitTokens !== doc.profile.providerContextLimitTokens) {
      errs.push(`route lookup: profile.providerContextLimitTokens (${doc.profile.providerContextLimitTokens}) != table row (${row.contextLimitTokens}) for the pinned route`);
    }
    if (doc.profile && doc.profile.providerModelLimitTableRef && doc.profile.providerModelLimitTableRef.digest !== computed) {
      errs.push(`profile.providerModelLimitTableRef.digest: ${doc.profile.providerModelLimitTableRef.digest} != table artifact digest ${computed} (read-only lookup must bind by digest)`);
    }
  } else {
    errs.push('example.tableFile: referenced table artifact missing');
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Classification validation (closed vocabulary + class laws + census coverage)
// ---------------------------------------------------------------------------

const CLASS_REQUIRED = {
  'mandatory-inline': (s, errs, at) => {
    if (s.noSilentOmission !== true) errs.push(`${at}.noSilentOmission: mandatory-inline requires true (never silently truncated)`);
    if (typeof s.budgetField !== 'string' || !s.budgetField.startsWith('max')) errs.push(`${at}.budgetField: mandatory-inline requires a budget field`);
  },
  'bounded-summary': (s, errs, at) => {
    if (typeof s.budgetField !== 'string' || !s.budgetField.startsWith('max')) errs.push(`${at}.budgetField: bounded-summary requires a budget field`);
  },
  'content-addressed-reference': (s, errs, at) => {
    if (s.accessMode !== 'chunked-read') errs.push(`${at}.accessMode: content-addressed-reference requires "chunked-read"`);
  },
  'bounded-tool-result': (s, errs, at) => {
    if (s.budgetField !== 'maxToolResultTokens') errs.push(`${at}.budgetField: bounded-tool-result requires "maxToolResultTokens"`);
  },
  'forbidden-duplication': (s, errs, at) => {
    if (typeof s.replacement !== 'string' || s.replacement.length < 1) errs.push(`${at}.replacement: forbidden-duplication requires the classified replacement`);
  },
};

export function validateClassification(cls) {
  const errs = [];
  if (typeof cls !== 'object' || cls === null || Array.isArray(cls)) { errs.push('classification: must be an object'); return errs; }
  const vocab = cls.closedVocabulary;
  if (JSON.stringify(vocab) !== JSON.stringify(CLOSED_CLASSES)) {
    errs.push(`closedVocabulary: must be exactly the frozen five-class list, got ${JSON.stringify(vocab)}`);
  }
  if (!Array.isArray(cls.sources) || cls.sources.length < 1) { errs.push('sources: must be a non-empty array'); return errs; }
  const vocabSet = new Set(vocab || []);
  const ids = new Set();
  const cited = new Set();
  for (let i = 0; i < cls.sources.length; i++) {
    const s = cls.sources[i];
    const at = `sources[${i}]${s && s.id ? '(' + s.id + ')' : ''}`;
    if (typeof s !== 'object' || s === null) { errs.push(`${at}: must be an object`); continue; }
    if (typeof s.id !== 'string' || s.id.length < 1) errs.push(`${at}.id: required`);
    else if (ids.has(s.id)) errs.push(`${at}.id: duplicate`);
    else ids.add(s.id);
    for (const k of ['source', 'ownerPackage', 'enforcingBoundary']) {
      if (typeof s[k] !== 'string' || s[k].length < 1) errs.push(`${at}.${k}: required non-empty string`);
    }
    if (!Array.isArray(s.censusSites) || s.censusSites.length < 1) errs.push(`${at}.censusSites: required (census §7.2 provenance)`);
    else for (const c of s.censusSites) cited.add(c);
    if (typeof s.class !== 'string' || !vocabSet.has(s.class)) {
      errs.push(`${at}.class: "${s.class}" is not in the closed vocabulary ${JSON.stringify(CLOSED_CLASSES)} — unclassified context sources are a spec violation, not a default`);
    } else {
      CLASS_REQUIRED[s.class](s, errs, at);
    }
  }
  // Census coverage: every PA site is either classified by a source or the
  // documented replaced-baseline exception (PA-2).
  const expected = new Set(CENSUS_SITES.filter((c) => !CENSUS_SITE_EXCLUDED_FROM_SOURCES.includes(c)));
  const missing = [...expected].filter((c) => !cited.has(c));
  if (missing.length > 0) errs.push(`census coverage: no source cites ${missing.join(', ')}`);
  const coverage = cls.coverage && cls.coverage.censusPromptAssemblySites;
  if (JSON.stringify(coverage) !== JSON.stringify(CENSUS_SITES)) errs.push('coverage.censusPromptAssemblySites: must list PA-1..PA-10 exactly');
  return errs;
}

// ---------------------------------------------------------------------------
// Schema self-check (the schema must freeze the plan field list EXACTLY)
// ---------------------------------------------------------------------------

function validateSchemaSelf(schema) {
  const errs = [];
  if (schema.additionalProperties !== false) errs.push('schema: root must set additionalProperties:false');
  const required = schema.required || [];
  if (JSON.stringify(required) !== JSON.stringify(PLAN_PROFILE_FIELDS)) {
    errs.push(`schema.required: must be the EXACT plan field list in plan order; got ${JSON.stringify(required)}`);
  }
  const props = Object.keys(schema.properties || {});
  const missing = PLAN_PROFILE_FIELDS.filter((f) => !props.includes(f));
  const extra = props.filter((f) => !PLAN_PROFILE_FIELDS.includes(f));
  if (missing.length) errs.push(`schema.properties: missing plan fields ${missing.join(', ')}`);
  if (extra.length) errs.push(`schema.properties: extra fields ${extra.join(', ')} (the plan block is exact)`);
  const pos = (((schema.$defs || {}).PositiveFiniteInteger) || {});
  if (pos.type !== 'integer' || pos.minimum !== 1) errs.push('schema.$defs.PositiveFiniteInteger: must be integer with minimum 1');
  const tc = (((schema.$defs || {}).TokenCounterRef) || {}).properties || {};
  if (tc.name?.const !== PINNED_COUNTER_NAME) errs.push(`schema.$defs.TokenCounterRef.properties.name: must const-pin "${PINNED_COUNTER_NAME}"`);
  if (tc.protocolVersion?.const !== PINNED_COUNTER_VERSION) errs.push(`schema.$defs.TokenCounterRef.properties.protocolVersion: must const-pin "${PINNED_COUNTER_VERSION}"`);
  const tbl = (((schema.$defs || {}).ProviderModelLimitTable) || {}).properties || {};
  if (tbl.kind?.const !== 'provider-model-limit-table') errs.push('schema.$defs.ProviderModelLimitTable.properties.kind: must const-pin the table kind');
  return errs;
}

// ---------------------------------------------------------------------------
// RED mutation corpus — every mutation MUST produce a validation failure.
// A mutation that passes means the spec/validator has a hole (validator exits 1).
// ---------------------------------------------------------------------------

function redCorpus(base) {
  const { example, tableDoc, classification } = base;
  const mut = (id, description, target, apply, expectSubstr) => ({
    id, description, target, expectSubstr,
    build: () => {
      if (target === 'profile') {
        const doc = clone(example);
        apply(doc.profile, doc);
        return (ctx) => validateExample(doc, ctx.tableDoc);
      }
      if (target === 'table') {
        const td = clone(tableDoc);
        apply(td.table.rows, td);
        return (ctx) => validateExample(clone(example), td);
      }
      if (target === 'classification') {
        const cls = clone(classification);
        apply(cls);
        return () => validateClassification(cls);
      }
      if (target === 'route') {
        const doc = clone(example);
        apply(doc);
        return (ctx) => validateExample(doc, ctx.tableDoc);
      }
      throw new Error(`unknown mutation target ${target}`);
    },
  });

  return [
    mut('M01', 'zero limit (maxProviderRequests = 0) — zero fails closed', 'profile',
      (p) => { p.maxProviderRequests = 0; }, 'positive finite'),
    mut('M02', 'missing limit (delete maxTotalInputTokens) — missing is not unbounded-valid', 'profile',
      (p) => { delete p.maxTotalInputTokens; }, 'required'),
    mut('M03', 'null limit (providerContextLimitTokens = null)', 'profile',
      (p) => { p.providerContextLimitTokens = null; }, 'positive finite'),
    mut('M04', 'missing token counter (delete tokenCounterRef)', 'profile',
      (p) => { delete p.tokenCounterRef; }, 'required'),
    mut('M05', 'counter drift (name != pinned protocol)', 'profile',
      (p) => { p.tokenCounterRef.name = 'some-other-counter'; }, 'not pinned'),
    mut('M06', 'unbounded string sentinel (maxPromptBytes = "unlimited")', 'profile',
      (p) => { p.maxPromptBytes = 'unlimited'; }, 'positive finite'),
    mut('M07', 'extra profile field (profile.hint) — plan field list is exact', 'profile',
      (p) => { p.hint = 'trust me'; }, 'additional property'),
    mut('M08', 'formula violation (maxTotalInputTokens > effectiveInputLimit)', 'profile',
      (p) => { p.maxTotalInputTokens = p.providerContextLimitTokens; }, 'effectiveInputLimit'),
    mut('M09', 'session budget below one maximal request', 'profile',
      (p) => { p.maxCumulativeSessionInputTokens = p.maxTotalInputTokens - 1; }, 'per-request cap'),
    mut('M10', 'limit table gains selection semantics (row.fallbackModel)', 'table',
      (rows) => { rows[0].fallbackModel = 'glm-4.6'; }, 'selection/fallback'),
    mut('M11', 'wildcard key in limit table (model = "*")', 'table',
      (rows) => { rows[0].model = '*'; }, 'wildcard'),
    mut('M12', 'profile context limit disagrees with the pinned table row', 'profile',
      (p) => { p.providerContextLimitTokens += 1024; }, 'table row'),
    mut('M13', 'table digest not bound (profile pins a different table digest)', 'profile',
      (p) => { p.providerModelLimitTableRef.digest = 'sha256:' + 'a'.repeat(64); }, 'digest'),
    mut('M14', 'unclassified context source (class "sometimes-inline")', 'classification',
      (cls) => { cls.sources.push({ id: 'CS-XX', source: 'mystery injection', class: 'sometimes-inline', censusSites: ['PA-1'], ownerPackage: 'x', enforcingBoundary: 'x' }); }, 'closed vocabulary'),
    mut('M15', 'mandatory-inline layer with silent omission allowed', 'classification',
      (cls) => { const s = cls.sources.find((x) => x.class === 'mandatory-inline'); delete s.noSilentOmission; }, 'noSilentOmission'),
    mut('M16', 'unsupported route pin (no exact-key table row)', 'route',
      (doc) => { doc.pinnedRoute.version = 'catalog-1999-01-01'; }, 'no exact-key row'),
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const digestOnly = process.argv.includes('--digest-only');
const lines = [];
const results = [];
const record = (id, pass, reason) => {
  results.push({ id, pass, reason: pass ? undefined : reason });
  if (!digestOnly) lines.push(`${pass ? 'PASS' : 'FAIL'}  ${id}${pass ? '' : ' — ' + reason}`);
};

let exit = 0;
try {
  // 1. Parse + schema self-check.
  const schema = loadJson('prompt-budget-profile.schema.json').doc;
  const schemaErrs = validateSchemaSelf(schema);
  record('schema.self: exact plan field list, fail-closed defs', schemaErrs.length === 0, schemaErrs.join('; '));

  // 2. Classification.
  const classification = loadJson('context-source-classification.json').doc;
  const clsErrs = validateClassification(classification);
  record('classification: closed vocabulary + class laws + census coverage', clsErrs.length === 0, clsErrs.join('; '));

  // 3. Examples (green instances).
  const tableDoc = loadJson(join('examples', 'provider-model-limit-table.example.json')).doc;
  const tableSelfErrs = validateTableArtifact(tableDoc.table);
  record('example.limit-table: read-only exact-key shape', tableSelfErrs.length === 0, tableSelfErrs.join('; '));

  for (const name of ['glm-5.2.prompt-budget.example.json', 'glm-4.7.prompt-budget.example.json']) {
    const doc = loadJson(join('examples', name)).doc;
    const errs = validateExample(doc, tableDoc);
    record(`example.profile: ${name.replace('.prompt-budget.example.json', '')} valid`, errs.length === 0, errs.join('; '));
  }

  // 4. RED mutation corpus — every mutation must fail.
  const baseExample = loadJson(join('examples', 'glm-5.2.prompt-budget.example.json')).doc;
  const corpus = redCorpus({ example: baseExample, tableDoc, classification });
  for (const m of corpus) {
    let errs;
    try {
      const validate = m.build();
      errs = validate({ tableDoc });
    } catch (e) {
      errs = [`mutation threw: ${e.message}`];
    }
    const failed = errs.length > 0;
    const matched = !m.expectSubstr || errs.some((e) => e.includes(m.expectSubstr));
    record(`red.${m.id}: ${m.description}`, failed && matched,
      failed ? (matched ? undefined : `failed but not with expected marker "${m.expectSubstr}": ${errs.join('; ')}`) : `MUTATION PASSED (validator hole): ${m.description}`);
  }

  const digest = sha256(canonical(results));
  const allPass = results.every((r) => r.pass);
  if (!allPass) exit = 1;
  if (!digestOnly) {
    lines.push('');
    lines.push(`checks: ${results.length} total, ${results.filter((r) => r.pass).length} pass, ${results.filter((r) => !r.pass).length} fail (green instances must pass; RED mutations must fail)`);
    lines.push(`RESULT ${allPass ? 'PASS' : 'FAIL'} ${digest}`);
  } else {
    lines.push(`${allPass ? 'PASS' : 'FAIL'} ${digest}`);
  }
} catch (e) {
  exit = 1;
  lines.push(`FAIL validator-error ${e.message}`);
}

if (!digestOnly) lines.unshift('validate-prompt-budget — EK-1 frozen admission spec (deterministic; two runs must match)');
console.log(lines.join('\n'));
process.exit(exit);
