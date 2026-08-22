/**
 * Order Constraint Register (AC-drift remedy, network 0 — the single source
 * for all three obligation networks).
 *
 * The register is extracted at discovery time, while the order's constraints
 * are still visible, and is content-addressed by digest. It is the typed
 * inventory the A1 reaction network (brief dispositions), the A2 structure
 * network (AC/SRS coverage) and the A3 execution network (verification
 * warrant) all diff against.
 *
 * Pure unit tests: no SQLite, no engine, no LM.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import { canonicalJson } from '../../dist/shared/canonical-json.js';

import {
  ORDER_CONSTRAINT_REGISTER_SCHEMA,
  ORDER_CONSTRAINT_REGISTER_SCHEMA_V2,
  ORDER_CONSTRAINT_CLASSES,
  ORDER_CONSTRAINT_KINDS,
  buildOrderConstraintRegister,
  buildOrderConstraintRegisterV2,
  assertOrderConstraintUnknownsLifted,
  orderConstraintRegisterRef,
  verifyOrderConstraintRegister,
} from '../../dist/shared/constraint-register.js';
import {
  validateDiscoveryProposal,
} from '../../dist/modules/discovery/domain/discovery-proposal.js';

function baseProposal(overrides = {}) {
  return {
    problem_statement: 'p',
    observed_context: 'o',
    stakeholders_or_actors: ['a'],
    assumptions: [],
    unknowns: [],
    risks: [],
    candidate_scope: 's',
    evidence_refs: ['e'],
    recommended_outcome: 'go',
    rationale: 'r',
    ...overrides,
  };
}

const DOCKER_DRAFT = {
  class: 'execution',
  text: 'one-command `docker compose up`',
  evidence_ref: 'order.source_body',
};
const TS_DRAFT = {
  class: 'material',
  text: 'TypeScript backend',
  evidence_ref: 'order.source_body',
};
const CHROME_DRAFT = {
  class: 'human',
  text: 'Chrome client feel',
  evidence_ref: 'order.source_body',
};

// ---- buildOrderConstraintRegister ------------------------------------------

test('register is null when no order_constraints are carried (retro-compat)', () => {
  assert.equal(buildOrderConstraintRegister(undefined), null);
  assert.equal(buildOrderConstraintRegister(null), null);
  assert.equal(buildOrderConstraintRegister([]), null);
});

test('register assigns stable positional IDs ord-c-001.. and carries the class', () => {
  const register = buildOrderConstraintRegister([
    { ...DOCKER_DRAFT },
    { ...TS_DRAFT },
    { ...CHROME_DRAFT },
  ]);
  assert.ok(register);
  assert.equal(register.schemaVersion, ORDER_CONSTRAINT_REGISTER_SCHEMA);
  assert.deepEqual(
    register.constraints.map(entry => entry.id),
    ['ord-c-001', 'ord-c-002', 'ord-c-003'],
  );
  assert.deepEqual(
    register.constraints.map(entry => entry.class),
    ['execution', 'material', 'human'],
  );
  assert.equal(register.constraints[0].text, DOCKER_DRAFT.text);
  assert.equal(register.constraints[0].evidenceRef, DOCKER_DRAFT.evidence_ref);
});

test('register digest is deterministic and independent of array identity', () => {
  const first = buildOrderConstraintRegister([{ ...DOCKER_DRAFT }, { ...TS_DRAFT }]);
  const second = buildOrderConstraintRegister([{ ...DOCKER_DRAFT }, { ...TS_DRAFT }]);
  assert.ok(first && second);
  assert.equal(first.registerDigest, second.registerDigest);
  assert.match(first.registerDigest, /^[a-f0-9]{64}$/);
});

test('register digest changes when constraint content changes', () => {
  const first = buildOrderConstraintRegister([{ ...DOCKER_DRAFT }]);
  const second = buildOrderConstraintRegister([{
    ...DOCKER_DRAFT,
    text: 'two-command startup',
  }]);
  assert.ok(first && second);
  assert.notEqual(first.registerDigest, second.registerDigest);
});

test('orderConstraintRegisterRef is content-addressed by the digest', () => {
  const register = buildOrderConstraintRegister([{ ...DOCKER_DRAFT }]);
  assert.ok(register);
  assert.equal(
    orderConstraintRegisterRef(register),
    `constraint-register:${register.registerDigest}`,
  );
});

test('duplicate constraint text is preserved as distinct entries (IDs are positional)', () => {
  const register = buildOrderConstraintRegister([
    { ...DOCKER_DRAFT },
    { ...DOCKER_DRAFT },
  ]);
  assert.ok(register);
  assert.equal(register.constraints.length, 2);
  assert.deepEqual(
    register.constraints.map(entry => entry.id),
    ['ord-c-001', 'ord-c-002'],
  );
});

test('invalid draft fails closed with a typed error', () => {
  assert.throws(
    () => buildOrderConstraintRegister([{ class: 'cosmic', text: 'x', evidence_ref: 'y' }]),
    /ORDER_CONSTRAINT_CLASS_INVALID/,
  );
  assert.throws(
    () => buildOrderConstraintRegister([{ class: 'execution', text: '  ', evidence_ref: 'y' }]),
    /ORDER_CONSTRAINT_TEXT_REQUIRED/,
  );
  assert.throws(
    () => buildOrderConstraintRegister([{ class: 'execution', text: 'x' }]),
    /ORDER_CONSTRAINT_EVIDENCE_REF_REQUIRED/,
  );
});

test('non-array order_constraints fails closed', () => {
  assert.throws(
    () => buildOrderConstraintRegister('nope'),
    /ORDER_CONSTRAINT_DRAFTS_INVALID/,
  );
});

// ---- validateDiscoveryProposal integration ----------------------------------

test('proposal with valid order_constraints validates', () => {
  const result = validateDiscoveryProposal(baseProposal({
    order_constraints: [{ ...DOCKER_DRAFT }, { ...TS_DRAFT }, { ...CHROME_DRAFT }],
  }));
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('proposal with invalid order_constraints is rejected with named field errors', () => {
  const result = validateDiscoveryProposal(baseProposal({
    order_constraints: [{ class: 'runtime', text: 'x', evidence_ref: 'y' }],
  }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('order_constraints[0].class')));

  const missingText = validateDiscoveryProposal(baseProposal({
    order_constraints: [{ class: 'material', text: '', evidence_ref: 'y' }],
  }));
  assert.equal(missingText.valid, false);
  assert.ok(missingText.errors.some(error => error.includes('order_constraints[0].text')));
});

test('proposal without order_constraints still validates (retro-compat monotonicity)', () => {
  const result = validateDiscoveryProposal(baseProposal());
  assert.equal(result.valid, true);
});

test('ORDER_CONSTRAINT_CLASSES is the closed class vocabulary', () => {
  assert.deepEqual([...ORDER_CONSTRAINT_CLASSES], ['execution', 'material', 'human']);
});

// ---- ADR-088 (CC-GAP-6): execution-class entrypoint declarations ---------

const START_DRAFT = {
  class: 'execution',
  text: 'npm install plus npm start lead to an accessible running browser product',
  evidence_ref: 'order.source_body',
  entrypoint_files: ['index.html', 'server.js'],
};

test('execution-class drafts carry declared entrypoint files into the register entries', () => {
  const register = buildOrderConstraintRegister([{ ...START_DRAFT }, { ...TS_DRAFT }]);
  assert.ok(register);
  assert.deepEqual(register.constraints[0].entrypointFiles, ['index.html', 'server.js']);
  assert.equal('entrypointFiles' in (register.constraints[1] ?? {}), false);
});

test('entrypoint declarations are part of the register content identity', () => {
  const withEntrypoints = buildOrderConstraintRegister([{ ...START_DRAFT }]);
  const withoutEntrypoints = buildOrderConstraintRegister([{
    class: START_DRAFT.class,
    text: START_DRAFT.text,
    evidence_ref: START_DRAFT.evidence_ref,
  }]);
  assert.ok(withEntrypoints && withoutEntrypoints);
  assert.notEqual(withEntrypoints.registerDigest, withoutEntrypoints.registerDigest);
});

test('entrypoint declarations on non-execution classes fail closed with a typed error', () => {
  assert.throws(
    () => buildOrderConstraintRegister([{
      ...TS_DRAFT,
      entrypoint_files: ['index.html'],
    }]),
    /ORDER_CONSTRAINT_ENTRYPOINT_CLASS_INVALID/,
  );
});

test('malformed entrypoint declarations fail closed with typed errors', () => {
  assert.throws(
    () => buildOrderConstraintRegister([{ ...START_DRAFT, entrypoint_files: 'index.html' }]),
    /ORDER_CONSTRAINT_ENTRYPOINT_FILES_INVALID/,
  );
  assert.throws(
    () => buildOrderConstraintRegister([{ ...START_DRAFT, entrypoint_files: ['/abs/index.html'] }]),
    /ORDER_CONSTRAINT_ENTRYPOINT_FILE_INVALID/,
  );
  assert.throws(
    () => buildOrderConstraintRegister([{ ...START_DRAFT, entrypoint_files: ['../escape.js'] }]),
    /ORDER_CONSTRAINT_ENTRYPOINT_FILE_INVALID/,
  );
  assert.throws(
    () => buildOrderConstraintRegister([{ ...START_DRAFT, entrypoint_files: [42] }]),
    /ORDER_CONSTRAINT_ENTRYPOINT_FILE_INVALID/,
  );
  assert.throws(
    () => buildOrderConstraintRegister([{ ...START_DRAFT, entrypoint_files: ['a.js', 'a.js'] }]),
    /ORDER_CONSTRAINT_ENTRYPOINT_FILE_INVALID/,
  );
});

test('an empty entrypoint_files list declares nothing (absent, not empty)', () => {
  const register = buildOrderConstraintRegister([{ ...START_DRAFT, entrypoint_files: [] }]);
  assert.ok(register);
  assert.equal('entrypointFiles' in register.constraints[0], false);
});

test('verifyOrderConstraintRegister round-trips a built register (incl. entrypoints)', () => {
  const register = buildOrderConstraintRegister([{ ...START_DRAFT }, { ...TS_DRAFT }]);
  assert.ok(register);
  const verified = verifyOrderConstraintRegister(JSON.parse(JSON.stringify(register)));
  assert.deepEqual(verified, register);

  assert.equal(verifyOrderConstraintRegister(undefined), null);
  assert.equal(verifyOrderConstraintRegister(null), null);

  const tampered = JSON.parse(JSON.stringify(register));
  tampered.constraints[0].text = 'quietly changed';
  assert.throws(
    () => verifyOrderConstraintRegister(tampered),
    /ORDER_CONSTRAINT_REGISTER_DIGEST_MISMATCH/,
  );
});

// ---- CC-IC-1 base verification (m0 residual): id reorder + snake_case at verify ---

test('id-reordered stored entries fail closed with ORDER_CONSTRAINT_REGISTER_ID_MISMATCH (m0 residual)', () => {
  const register = buildOrderConstraintRegister([{ ...DOCKER_DRAFT }, { ...TS_DRAFT }, { ...CHROME_DRAFT }]);
  assert.ok(register);
  // The MUTATION: the persisted rows are reordered (entry ord-c-002 first)
  // while the stored registerDigest is kept. Positional ids are content
  // identities — the reorder is a typed red, never a silent reinterpretation
  // or a quiet digest rebuild.
  const reordered = JSON.parse(JSON.stringify(register));
  reordered.constraints = [
    reordered.constraints[1],
    reordered.constraints[0],
    reordered.constraints[2],
  ];
  assert.throws(
    () => verifyOrderConstraintRegister(reordered),
    /ORDER_CONSTRAINT_REGISTER_ID_MISMATCH/,
  );
});

test('a snake_case DRAFT row arriving at the verify boundary is a typed rejection, never a silent reinterpretation (m0 residual)', () => {
  const register = buildOrderConstraintRegister([{ ...DOCKER_DRAFT }, { ...TS_DRAFT }]);
  assert.ok(register);
  // The MUTATION: a worker-facing snake_case draft row (evidence_ref) is fed
  // to the read-back verifier in place of the canonical camelCase entry. The
  // verifier validates the CANONICAL shape directly — the draft must be a
  // typed rejection (never re-derived through the builder, never silently
  // reinterpreted).
  const draftShaped = JSON.parse(JSON.stringify(register));
  delete draftShaped.constraints[0].evidenceRef;
  draftShaped.constraints[0].evidence_ref = DOCKER_DRAFT.evidence_ref;
  assert.throws(
    () => verifyOrderConstraintRegister(draftShaped),
    /ORDER_CONSTRAINT_REGISTER_INVALID: register entry evidenceRef must be a non-empty string/,
  );
});

// ---- ADR-090 (CC-IC-1): the v2 universal vocabulary --------------------------

test('ORDER_CONSTRAINT_KINDS is the closed orthogonal kind vocabulary; classes stay unchanged', () => {
  assert.deepEqual([...ORDER_CONSTRAINT_KINDS], [
    'scope', 'open-question', 'mechanics', 'synthesis', 'ordered-smoke', 'quality',
  ]);
  // `open-question` is a KIND, never a class; the class vocabulary is not overloaded.
  assert.deepEqual([...ORDER_CONSTRAINT_CLASSES], ['execution', 'material', 'human']);
  assert.equal(ORDER_CONSTRAINT_CLASSES.includes('open-question'), false);
});

test('a draft row carrying a kind MUST carry one of the six closed values (builder + boundary)', () => {
  assert.throws(
    () => buildOrderConstraintRegisterV2({ drafts: [{ ...DOCKER_DRAFT, kind: 'epic' }] }),
    /ORDER_CONSTRAINT_KIND_INVALID/,
  );
  const boundary = validateDiscoveryProposal(baseProposal({
    order_constraints: [{ ...DOCKER_DRAFT, kind: 'epic' }],
  }));
  assert.equal(boundary.valid, false);
  assert.ok(boundary.errors.some(error => error.includes('order_constraints[0].kind must be one of')));

  const six = buildOrderConstraintRegisterV2({
    drafts: ORDER_CONSTRAINT_KINDS.map(kind => ({
      ...DOCKER_DRAFT,
      kind,
      ...(kind === 'quality'
        ? { measurability: { state: 'deferred', reason: 'deferred to the operator study' } }
        : {}),
    })),
  });
  assert.ok(six);
  assert.deepEqual(six.constraints.map(entry => entry.kind), [...ORDER_CONSTRAINT_KINDS]);
});

test('a kind-less v1-shaped draft under a NEW v2 settlement defaults deterministically to kind scope', () => {
  const register = buildOrderConstraintRegisterV2({ drafts: [{ ...DOCKER_DRAFT }, { ...TS_DRAFT }] });
  assert.ok(register);
  assert.equal(register.schemaVersion, ORDER_CONSTRAINT_REGISTER_SCHEMA_V2);
  assert.deepEqual(
    register.constraints.map(entry => entry.kind),
    ['scope', 'scope'],
  );
  // The kind is entry content: the v2 digest differs from the v1 register
  // over the same base rows — an honest revision, never an in-place mutation.
  const v1 = buildOrderConstraintRegister([{ ...DOCKER_DRAFT }, { ...TS_DRAFT }]);
  assert.ok(v1);
  assert.notEqual(register.registerDigest, v1.registerDigest);
});

test('v1 registers verify unchanged under the v1 schema; v2 typed fields on a v1 register are a typed defect', () => {
  const v1 = buildOrderConstraintRegister([{ ...DOCKER_DRAFT }]);
  assert.ok(v1);
  assert.equal(verifyOrderConstraintRegister(JSON.parse(JSON.stringify(v1)))?.registerDigest, v1.registerDigest);

  const kindOnV1 = JSON.parse(JSON.stringify(v1));
  kindOnV1.constraints[0].kind = 'scope';
  assert.throws(
    () => verifyOrderConstraintRegister(kindOnV1),
    /ORDER_CONSTRAINT_REGISTER_INVALID: v1 register entries carry no v2 typed fields/,
  );
});

test('the v1 builder never silently drops v2 vocabulary (kind/measurability/lifecycle_synthesis fail closed)', () => {
  assert.throws(
    () => buildOrderConstraintRegister([{ ...DOCKER_DRAFT, kind: 'scope' }]),
    /ORDER_CONSTRAINT_KIND_REQUIRES_V2/,
  );
  assert.throws(
    () => buildOrderConstraintRegister([{
      ...DOCKER_DRAFT,
      measurability: { state: 'deferred', reason: 'r' },
    }]),
    /ORDER_CONSTRAINT_MEASURABILITY_REQUIRES_V2/,
  );
  assert.throws(
    () => buildOrderConstraintRegister([{
      ...DOCKER_DRAFT,
      lifecycle_synthesis: { classification: 'runnable-local', injection_table_ref: 'x' },
    }]),
    /ORDER_CONSTRAINT_LIFECYCLE_SYNTHESIS_KERNEL_ONLY/,
  );
});

// ---- m1: deterministic 1:1 open-question lifting from proposal unknowns -------

const PRICING_UNKNOWN = 'the dynamic pricing algorithm is not yet chosen';
const BROWSER_UNKNOWN = 'the ordered browser smoke steps are not yet fixed';

test('unknowns are lifted 1:1 and positionally as kind open-question entries (text = unknown, evidenceRef = the payload field)', () => {
  const register = buildOrderConstraintRegisterV2({
    drafts: [{ ...DOCKER_DRAFT }],
    unknowns: [PRICING_UNKNOWN, BROWSER_UNKNOWN],
  });
  assert.ok(register);
  const openQuestions = register.constraints.filter(entry => entry.kind === 'open-question');
  assert.deepEqual(
    openQuestions.map(entry => entry.text),
    [PRICING_UNKNOWN, BROWSER_UNKNOWN],
  );
  for (const entry of openQuestions) {
    assert.equal(entry.evidenceRef, 'proposal.unknowns');
    assert.ok(ORDER_CONSTRAINT_CLASSES.includes(entry.class), 'the class vocabulary stays closed');
  }
  // Interleave: constraints first (payload order), then unknowns.
  assert.deepEqual(
    register.constraints.map(entry => entry.id),
    ['ord-c-001', 'ord-c-002', 'ord-c-003'],
  );
  // A non-string unknown is a typed builder error (no guessing).
  assert.throws(
    () => buildOrderConstraintRegisterV2({ unknowns: [42] }),
    /ORDER_CONSTRAINT_UNKNOWN_INVALID/,
  );
});

test('m1: a proposal unknown absent from the register open-question entries is a typed red (never a silent under-count)', () => {
  const register = buildOrderConstraintRegisterV2({ unknowns: [PRICING_UNKNOWN] });
  assert.ok(register);
  assertOrderConstraintUnknownsLifted(register, [PRICING_UNKNOWN]);

  // The MUTATION: settlement lifted only one of two proposal unknowns.
  const lossy = buildOrderConstraintRegisterV2({ unknowns: [PRICING_UNKNOWN] });
  assert.throws(
    () => assertOrderConstraintUnknownsLifted(lossy, [PRICING_UNKNOWN, BROWSER_UNKNOWN]),
    new RegExp(`ORDER_CONSTRAINT_UNKNOWN_NOT_LIFTED.*${BROWSER_UNKNOWN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  // The empty-lift mutant (settlement dropped the unknowns entirely).
  const none = buildOrderConstraintRegisterV2({ unknowns: [] });
  assert.equal(none, null);
  assert.throws(
    () => assertOrderConstraintUnknownsLifted(none, [PRICING_UNKNOWN]),
    /ORDER_CONSTRAINT_UNKNOWN_NOT_LIFTED/,
  );
});

// ---- m4a: the injected block layout is register content (digest-pinned) -------

const INJECTION_TABLE = {
  schemaVersion: 'factory.lifecycle-obligation-injection.v1',
  classification: 'runnable-local',
  entries: [
    {
      class: 'execution',
      kind: 'synthesis',
      text: 'the whole product is assembled as one runnable whole',
      evidence_ref: 'lifecycle.classification.runnable-local',
    },
    {
      class: 'execution',
      kind: 'ordered-smoke',
      text: 'install, then start, then reach the running product',
      evidence_ref: 'lifecycle.classification.runnable-local',
    },
  ],
};
const INJECTION_REF = 'lifecycle-obligation-injection:a'.repeat(1) + '0'.repeat(0)
  + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

test('injected entries are APPENDED after the proposal block in declared table order, with kernel lifecycleSynthesis provenance', () => {
  const register = buildOrderConstraintRegisterV2({
    drafts: [{ ...DOCKER_DRAFT }],
    unknowns: [PRICING_UNKNOWN],
    injections: [{ table: INJECTION_TABLE, tableRef: INJECTION_REF }],
  });
  assert.ok(register);
  assert.deepEqual(
    register.constraints.map(entry => [entry.id, entry.kind, entry.lifecycleSynthesis ? 'injected' : 'proposal']),
    [
      ['ord-c-001', 'scope', 'proposal'],
      ['ord-c-002', 'open-question', 'proposal'],
      ['ord-c-003', 'synthesis', 'injected'],
      ['ord-c-004', 'ordered-smoke', 'injected'],
    ],
  );
  assert.equal(register.constraints[2].lifecycleSynthesis.injectionTableRef, INJECTION_REF);
  assert.equal(register.constraints[2].lifecycleSynthesis.classification, 'runnable-local');

  const verified = verifyOrderConstraintRegister(JSON.parse(JSON.stringify(register)));
  assert.equal(verified.registerDigest, register.registerDigest);
});

test('m4a: injected rows interleaved among proposal-derived rows are a typed verifier red, and any reordering is a digest change', () => {
  const canonical = buildOrderConstraintRegisterV2({
    drafts: [{ ...DOCKER_DRAFT }, { ...TS_DRAFT }],
    injections: [{ table: INJECTION_TABLE, tableRef: INJECTION_REF }],
  });
  assert.ok(canonical);
  // The MUTATION (layout violation): the synthesis entry is interleaved
  // among the proposal-derived rows while the digest is recomputed — the
  // block layout itself is content, so the verifier rejects it.
  const interleaved = {
    schemaVersion: ORDER_CONSTRAINT_REGISTER_SCHEMA_V2,
    constraints: [
      canonical.constraints[0],
      canonical.constraints[2],
      canonical.constraints[1],
      canonical.constraints[3],
    ],
    registerDigest: '',
  };
  interleaved.constraints = interleaved.constraints.map((entry, index) => ({
    ...entry,
    id: `ord-c-${String(index + 1).padStart(3, '0')}`,
  }));
  interleaved.registerDigest = createHash('sha256')
    .update(canonicalJson(interleaved.constraints)).digest('hex');
  assert.throws(
    () => verifyOrderConstraintRegister(interleaved),
    /ORDER_CONSTRAINT_REGISTER_BLOCK_LAYOUT_INVALID/,
  );
  // Proposal-derived positional ids stay stable when the injection-table
  // REVISION changes (appended block only) — but any reordering of the blocks
  // changes the digest (an honest revision).
  const noInjection = buildOrderConstraintRegisterV2({ drafts: [{ ...DOCKER_DRAFT }, { ...TS_DRAFT }] });
  assert.ok(noInjection);
  assert.deepEqual(
    canonical.constraints.slice(0, 2).map(entry => entry.id),
    noInjection.constraints.map(entry => entry.id),
  );
  assert.notEqual(canonical.registerDigest, noInjection.registerDigest);
});

test('an undeclared/ad-hoc injection table fails closed at the builder', () => {
  assert.throws(
    () => buildOrderConstraintRegisterV2({
      injections: [{ table: { ...INJECTION_TABLE, entries: [] }, tableRef: INJECTION_REF }],
    }),
    /ORDER_CONSTRAINT_INJECTION_TABLE_INVALID/,
  );
  assert.throws(
    () => buildOrderConstraintRegisterV2({
      injections: [{
        table: { ...INJECTION_TABLE, entries: [{ ...INJECTION_TABLE.entries[0], kind: 'scope' }] },
        tableRef: INJECTION_REF,
      }],
    }),
    /ORDER_CONSTRAINT_INJECTION_TABLE_INVALID/,
  );
});

// ---- m5: typed measurability binds ONLY kind quality, and is REQUIRED there ---

test('m5: a quality entry without a measurable interpretation or typed deferral is a typed red', () => {
  assert.throws(
    () => buildOrderConstraintRegisterV2({
      drafts: [{ ...DOCKER_DRAFT, kind: 'quality' }],
    }),
    /ORDER_CONSTRAINT_MEASURABILITY_REQUIRED/,
  );
  const boundary = validateDiscoveryProposal(baseProposal({
    order_constraints: [
      { ...TS_DRAFT, kind: 'quality' },
      { class: 'material', kind: 'quality', text: 'x', evidence_ref: 'y', measurability: { state: 'bogus' } },
    ],
  }));
  assert.equal(boundary.valid, false);
  assert.ok(boundary.errors.some(error => error.includes("measurability.state must be 'measurable' or 'deferred'")));
});

test('quality measurability accepts measurable+interpretationRef or deferred+reason; other kinds reject it', () => {
  const measurable = buildOrderConstraintRegisterV2({
    drafts: [{
      ...DOCKER_DRAFT, kind: 'quality',
      measurability: { state: 'measurable', interpretation_ref: 'p95 latency under 200ms on loopback' },
    }],
  });
  assert.ok(measurable);
  assert.deepEqual(
    measurable.constraints[0].measurability,
    { state: 'measurable', interpretationRef: 'p95 latency under 200ms on loopback' },
  );

  const deferred = buildOrderConstraintRegisterV2({
    drafts: [{ ...DOCKER_DRAFT, kind: 'quality', measurability: { state: 'deferred', reason: 'operator study pending' } }],
  });
  assert.ok(deferred);
  assert.deepEqual(
    deferred.constraints[0].measurability,
    { state: 'deferred', reason: 'operator study pending' },
  );

  assert.throws(
    () => buildOrderConstraintRegisterV2({
      drafts: [{ ...DOCKER_DRAFT, measurability: { state: 'deferred', reason: 'r' } }],
    }),
    /ORDER_CONSTRAINT_MEASURABILITY_KIND_INVALID/,
  );
  assert.throws(
    () => buildOrderConstraintRegisterV2({
      drafts: [{ ...DOCKER_DRAFT, kind: 'quality', measurability: { state: 'measurable', interpretation_ref: ' ' } }],
    }),
    /ORDER_CONSTRAINT_MEASURABILITY_INVALID/,
  );
  // The verifier repeats the rule on the canonical shape.
  const verified = verifyOrderConstraintRegister(JSON.parse(JSON.stringify(measurable)));
  assert.equal(verified.registerDigest, measurable.registerDigest);
});

test('a v2 register round-trips through the repaired read-back verifier; quality rows must carry measurability there too', () => {
  const register = buildOrderConstraintRegisterV2({
    drafts: [
      { ...DOCKER_DRAFT },
      { ...DOCKER_DRAFT, kind: 'quality', measurability: { state: 'deferred', reason: 'r' } },
    ],
    unknowns: [PRICING_UNKNOWN],
    injections: [{ table: INJECTION_TABLE, tableRef: INJECTION_REF }],
  });
  assert.ok(register);
  const verified = verifyOrderConstraintRegister(JSON.parse(JSON.stringify(register)));
  assert.deepEqual(verified, register);

  const stripped = JSON.parse(JSON.stringify(register));
  delete stripped.constraints[1].measurability;
  stripped.registerDigest = createHash('sha256').update(canonicalJson(stripped.constraints)).digest('hex');
  assert.throws(
    () => verifyOrderConstraintRegister(stripped),
    /ORDER_CONSTRAINT_MEASURABILITY_REQUIRED/,
  );
});

test('proposal validation rejects entrypoint_files on non-execution classes at the submission boundary', () => {
  const result = validateDiscoveryProposal(baseProposal({
    order_constraints: [{ ...TS_DRAFT, entrypoint_files: ['index.html'] }],
  }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error =>
    error.includes('order_constraints[0].entrypoint_files may only be declared by execution-class')));

  const nonArray = validateDiscoveryProposal(baseProposal({
    order_constraints: [{ ...TS_DRAFT, entrypoint_files: 'index.html' }],
  }));
  assert.equal(nonArray.valid, false);
  assert.ok(nonArray.errors.some(error =>
    error.includes('order_constraints[0].entrypoint_files must be an array')));

  const valid = validateDiscoveryProposal(baseProposal({
    order_constraints: [{ ...START_DRAFT }, { ...TS_DRAFT }],
  }));
  assert.equal(valid.valid, true, valid.errors.join('; '));
});
