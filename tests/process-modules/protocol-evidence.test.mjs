// W4-A3 — Protocol evidence verification tests.
//
// Plan refs: §8.4 (step completion needs required durable evidence),
// §8.5 (Runtime understands category, never meaning; module verifier checks
// semantics), §8.6 (Runtime verifies declared evidence before advancing),
// §8.2.9 (node completion evidence), §14.6.4 / C026 (before-complete gate),
// §0.7.11 exit gate #6 ("Required evidence CANNOT be skipped").
//
// These tests exercise the W4-A3 surface only:
//   - STANDARD_EVIDENCE_CATEGORIES / STRUCTURAL_EVIDENCE_CATEGORIES membership.
//   - verifyStepEvidence + diagnoseStepEvidence for every category, including
//     the fail-closed negative cases (C026).
//   - PackageEvidenceVerifierRegistry register/resolve + the verifier
//     delegation path for module-verifier-receipt.
//   - verifyBeforeCompleteGate / canCompleteStep (C026) including the
//     node-completion dual-check (step + nodeCompletionEvidence).
//   - contractRefKey / contractRefEquals / categoryRequiredFields helpers.

import assert from 'node:assert/strict';
import test from 'node:test';

const mod = await import(
  '../../dist/process-modules/application/protocol-evidence.js'
);

const {
  STANDARD_EVIDENCE_CATEGORIES,
  STRUCTURAL_EVIDENCE_CATEGORIES,
  PackageEvidenceVerifierRegistry,
  verifyStepEvidence,
  diagnoseStepEvidence,
  verifyBeforeCompleteGate,
  canCompleteStep,
  contractRefKey,
  contractRefEquals,
  categoryRequiredFields,
} = mod;

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function ref(schemaId, digest) {
  return {
    schemaId,
    version: '1.0.0',
    digest: digest ?? '0'.repeat(64),
  };
}

const TOOL_REF = ref('saga3.evidence.tool-receipt.v1', 'a'.repeat(64));
const ARTIFACT_REF = ref('saga3.evidence.artifact-reference.v1', 'b'.repeat(64));
const TRACE_REF = ref('saga3.evidence.trace-reference.v1', 'c'.repeat(64));
const HUMAN_REF = ref('saga3.evidence.human-receipt.v1', 'd'.repeat(64));
const EXTERNAL_REF = ref('saga3.evidence.external-receipt.v1', 'e'.repeat(64));
const VERIFIER_REF = ref('saga3.evidence.module-verifier-receipt.v1', 'f'.repeat(64));
const OTHER_REF = ref('saga3.evidence.tool-receipt.v1', 'z'.repeat(64));

function req(category, contractRef, required = true) {
  return { category, contractRef, required };
}

function evidence(category, contractRef, value, extra = {}) {
  return { category, contractRef, value, ...extra };
}

function step(overrides = {}) {
  return {
    id: 'step-1',
    instructions: 'Author the artifact.',
    resources: ['res://skill/x'],
    allowedTools: ['tool:write'],
    evidenceRequirements: [],
    ...overrides,
  };
}

// Well-formed structural values per category.
const STRUCTURAL_VALUES = {
  'tool-receipt': { toolId: 'tool:write', receiptHash: 'h1' },
  'artifact-reference': { artifactRef: 'artifact:42', contentHash: 'h2' },
  'trace-reference': { sourceId: 'a:1', targetId: 'a:2' },
  'human-receipt': { approverId: 'user:alice', decisionHash: 'h3' },
  'external-receipt': { externalSystemId: 'ci:build', receiptHash: 'h4' },
  'module-verifier-receipt': { verifierId: 'verifier:srs', acceptanceHash: 'h5' },
};

// ---------------------------------------------------------------------------
// Category sets.
// ---------------------------------------------------------------------------

test('STANDARD_EVIDENCE_CATEGORIES contains exactly the six spec categories', () => {
  assert.deepEqual(
    [...STANDARD_EVIDENCE_CATEGORIES].sort(),
    [
      'artifact-reference',
      'external-receipt',
      'human-receipt',
      'module-verifier-receipt',
      'tool-receipt',
      'trace-reference',
    ],
  );
});

test('STRUCTURAL_EVIDENCE_CATEGORIES is the five non-verifier categories', () => {
  assert.deepEqual(
    [...STRUCTURAL_EVIDENCE_CATEGORIES].sort(),
    [
      'artifact-reference',
      'external-receipt',
      'human-receipt',
      'tool-receipt',
      'trace-reference',
    ],
  );
  assert.ok(!STRUCTURAL_EVIDENCE_CATEGORIES.has('module-verifier-receipt'));
});

test('module-verifier-receipt is standard but not structural', () => {
  assert.ok(STANDARD_EVIDENCE_CATEGORIES.has('module-verifier-receipt'));
  assert.ok(!STRUCTURAL_EVIDENCE_CATEGORIES.has('module-verifier-receipt'));
});

// ---------------------------------------------------------------------------
// Helpers: categoryRequiredFields / contractRefKey / contractRefEquals.
// ---------------------------------------------------------------------------

test('categoryRequiredFields returns the structural fields for each category', () => {
  assert.deepEqual([...categoryRequiredFields('tool-receipt')], ['toolId', 'receiptHash']);
  assert.deepEqual([...categoryRequiredFields('artifact-reference')], [
    'artifactRef',
    'contentHash',
  ]);
  assert.deepEqual([...categoryRequiredFields('trace-reference')], [
    'sourceId',
    'targetId',
  ]);
  assert.deepEqual([...categoryRequiredFields('human-receipt')], [
    'approverId',
    'decisionHash',
  ]);
  assert.deepEqual([...categoryRequiredFields('external-receipt')], [
    'externalSystemId',
    'receiptHash',
  ]);
  assert.deepEqual([...categoryRequiredFields('module-verifier-receipt')], [
    'verifierId',
    'acceptanceHash',
  ]);
});

test('categoryRequiredFields returns null for unknown category', () => {
  assert.equal(categoryRequiredFields('not-a-category'), null);
});

test('contractRefKey includes schemaId, version and digest', () => {
  const k = contractRefKey(TOOL_REF);
  assert.ok(k.includes(TOOL_REF.schemaId));
  assert.ok(k.includes(TOOL_REF.version));
  assert.ok(k.includes(TOOL_REF.digest));
});

test('contractRefKey distinguishes same schemaId/version with different digest', () => {
  assert.notEqual(contractRefKey(TOOL_REF), contractRefKey(OTHER_REF));
});

test('contractRefEquals is true only when all three fields match', () => {
  assert.ok(contractRefEquals(TOOL_REF, { ...TOOL_REF }));
  assert.ok(!contractRefEquals(TOOL_REF, OTHER_REF));
  assert.ok(
    !contractRefEquals(TOOL_REF, {
      schemaId: TOOL_REF.schemaId,
      version: TOOL_REF.version,
      digest: 'x'.repeat(64),
    }),
  );
});

// ---------------------------------------------------------------------------
// verifyStepEvidence: positive cases for each structural category.
// ---------------------------------------------------------------------------

for (const category of [
  'tool-receipt',
  'artifact-reference',
  'trace-reference',
  'human-receipt',
  'external-receipt',
]) {
  test(`verifyStepEvidence accepts well-formed ${category}`, () => {
    const contractRef =
      category === 'tool-receipt'
        ? TOOL_REF
        : category === 'artifact-reference'
          ? ARTIFACT_REF
          : category === 'trace-reference'
            ? TRACE_REF
            : category === 'human-receipt'
              ? HUMAN_REF
              : EXTERNAL_REF;
    const s = step({
      evidenceRequirements: [req(category, contractRef, true)],
    });
    const ok = verifyStepEvidence(s, s.evidenceRequirements, [
      evidence(category, contractRef, STRUCTURAL_VALUES[category]),
    ]);
    assert.equal(ok, true);
  });
}

test('verifyStepEvidence returns true when there are no required requirements', () => {
  const s = step({ evidenceRequirements: [] });
  assert.equal(verifyStepEvidence(s, s.evidenceRequirements, []), true);
});

test('verifyStepEvidence ignores optional requirements when absent', () => {
  const s = step({
    evidenceRequirements: [req('tool-receipt', TOOL_REF, false)],
  });
  assert.equal(verifyStepEvidence(s, s.evidenceRequirements, []), true);
});

test('verifyStepEvidence accepts multiple requirements satisfied by distinct items', () => {
  const s = step({
    evidenceRequirements: [
      req('tool-receipt', TOOL_REF, true),
      req('artifact-reference', ARTIFACT_REF, true),
    ],
  });
  assert.equal(
    verifyStepEvidence(s, s.evidenceRequirements, [
      evidence('tool-receipt', TOOL_REF, STRUCTURAL_VALUES['tool-receipt']),
      evidence('artifact-reference', ARTIFACT_REF, STRUCTURAL_VALUES['artifact-reference']),
    ]),
    true,
  );
});

// ---------------------------------------------------------------------------
// verifyStepEvidence: negative cases (fail closed — C026).
// ---------------------------------------------------------------------------

test('verifyStepEvidence fails when a required item is absent', () => {
  const s = step({ evidenceRequirements: [req('tool-receipt', TOOL_REF, true)] });
  const r = diagnoseStepEvidence(s, s.evidenceRequirements, []);
  assert.equal(r.satisfied, false);
  assert.equal(r.stepId, 'step-1');
  assert.equal(r.unsatisfied.length, 1);
  assert.equal(r.unsatisfied[0].reasonCode, 'NO_MATCHING_EVIDENCE');
  assert.equal(r.unsatisfied[0].category, 'tool-receipt');
});

test('verifyStepEvidence fails when contractRef does not match', () => {
  const s = step({ evidenceRequirements: [req('tool-receipt', TOOL_REF, true)] });
  const r = diagnoseStepEvidence(s, s.evidenceRequirements, [
    evidence('tool-receipt', OTHER_REF, STRUCTURAL_VALUES['tool-receipt']),
  ]);
  assert.equal(r.satisfied, false);
  assert.equal(r.unsatisfied[0].reasonCode, 'CONTRACT_REF_MISMATCH');
});

test('verifyStepEvidence fails when structural fields are missing', () => {
  const s = step({ evidenceRequirements: [req('tool-receipt', TOOL_REF, true)] });
  const r = diagnoseStepEvidence(s, s.evidenceRequirements, [
    // receiptHash missing
    evidence('tool-receipt', TOOL_REF, { toolId: 'tool:write' }),
  ]);
  assert.equal(r.satisfied, false);
  assert.equal(r.unsatisfied[0].reasonCode, 'VALUE_MISSING_STRUCTURAL_FIELDS');
});

test('verifyStepEvidence fails when a structural field is empty string', () => {
  const s = step({ evidenceRequirements: [req('tool-receipt', TOOL_REF, true)] });
  const r = diagnoseStepEvidence(s, s.evidenceRequirements, [
    evidence('tool-receipt', TOOL_REF, { toolId: '', receiptHash: 'h1' }),
  ]);
  assert.equal(r.satisfied, false);
  assert.equal(r.unsatisfied[0].reasonCode, 'VALUE_MISSING_STRUCTURAL_FIELDS');
});

test('verifyStepEvidence fails when value is not a plain object', () => {
  const s = step({ evidenceRequirements: [req('tool-receipt', TOOL_REF, true)] });
  const r = diagnoseStepEvidence(s, s.evidenceRequirements, [
    evidence('tool-receipt', TOOL_REF, null),
  ]);
  assert.equal(r.satisfied, false);
  assert.equal(r.unsatisfied[0].reasonCode, 'VALUE_MISSING_STRUCTURAL_FIELDS');
});

test('verifyStepEvidence fails closed for unknown category requirement', () => {
  const s = step({
    evidenceRequirements: [req('bogus-category' /* not standard */, TOOL_REF, true)],
  });
  const r = diagnoseStepEvidence(s, s.evidenceRequirements, []);
  assert.equal(r.satisfied, false);
  assert.equal(r.unsatisfied[0].reasonCode, 'CATEGORY_UNKNOWN');
});

test('verifyStepEvidence partial satisfaction still fails the gate', () => {
  const s = step({
    evidenceRequirements: [
      req('tool-receipt', TOOL_REF, true),
      req('artifact-reference', ARTIFACT_REF, true),
    ],
  });
  // Only the tool-receipt is provided.
  const r = diagnoseStepEvidence(s, s.evidenceRequirements, [
    evidence('tool-receipt', TOOL_REF, STRUCTURAL_VALUES['tool-receipt']),
  ]);
  assert.equal(r.satisfied, false);
  assert.equal(r.unsatisfied.length, 1);
  assert.equal(r.unsatisfied[0].category, 'artifact-reference');
});

test('verifyStepEvidence picks the first matching item and ignores later malformed ones', () => {
  const s = step({ evidenceRequirements: [req('tool-receipt', TOOL_REF, true)] });
  assert.equal(
    verifyStepEvidence(s, s.evidenceRequirements, [
      evidence('tool-receipt', TOOL_REF, STRUCTURAL_VALUES['tool-receipt']),
      // a later malformed item of the same category must not poison the match
      evidence('tool-receipt', TOOL_REF, { toolId: 'x' }),
    ]),
    true,
  );
});

// ---------------------------------------------------------------------------
// Package verifier binding (§8.5) + module-verifier-receipt.
// ---------------------------------------------------------------------------

test('PackageEvidenceVerifierRegistry register/resolve round-trips by ContractRef', () => {
  const reg = new PackageEvidenceVerifierRegistry();
  const v = () => ({ accepted: true });
  reg.register(VERIFIER_REF, v);
  assert.equal(reg.size, 1);
  assert.equal(reg.resolve(VERIFIER_REF), v);
  // Different ContractRef is not found.
  assert.equal(reg.resolve(TOOL_REF), null);
});

test('PackageEvidenceVerifierRegistry.register rejects non-function verifier', () => {
  const reg = new PackageEvidenceVerifierRegistry();
  assert.throws(() => reg.register(VERIFIER_REF, {}), TypeError);
});

test('PackageEvidenceVerifierRegistry re-register replaces the verifier', () => {
  const reg = new PackageEvidenceVerifierRegistry();
  const v1 = () => ({ accepted: true });
  const v2 = () => ({ accepted: false, reasonCode: 'no' });
  reg.register(VERIFIER_REF, v1);
  reg.register(VERIFIER_REF, v2);
  assert.equal(reg.size, 1);
  assert.equal(reg.resolve(VERIFIER_REF), v2);
});

test('module-verifier-receipt fails closed when no verifier is registered', () => {
  const s = step({
    evidenceRequirements: [req('module-verifier-receipt', VERIFIER_REF, true)],
  });
  const r = diagnoseStepEvidence(
    s,
    s.evidenceRequirements,
    [
      evidence(
        'module-verifier-receipt',
        VERIFIER_REF,
        STRUCTURAL_VALUES['module-verifier-receipt'],
        { moduleVerifierContractRef: VERIFIER_REF },
      ),
    ],
    { verifierRegistry: new PackageEvidenceVerifierRegistry() },
  );
  assert.equal(r.satisfied, false);
  assert.equal(r.unsatisfied[0].reasonCode, 'MODULE_VERIFIER_NOT_REGISTERED');
});

test('module-verifier-receipt passes when the registered verifier accepts', () => {
  const reg = new PackageEvidenceVerifierRegistry();
  reg.register(VERIFIER_REF, () => ({ accepted: true }));
  const s = step({
    evidenceRequirements: [req('module-verifier-receipt', VERIFIER_REF, true)],
  });
  assert.equal(
    verifyStepEvidence(
      s,
      s.evidenceRequirements,
      [
        evidence(
          'module-verifier-receipt',
          VERIFIER_REF,
          STRUCTURAL_VALUES['module-verifier-receipt'],
          { moduleVerifierContractRef: VERIFIER_REF },
        ),
      ],
      { verifierRegistry: reg },
    ),
    true,
  );
});

test('module-verifier-receipt fails when the registered verifier rejects', () => {
  const reg = new PackageEvidenceVerifierRegistry();
  reg.register(VERIFIER_REF, () => ({ accepted: false, reasonCode: 'SRS_NOT_ACCEPTED' }));
  const s = step({
    evidenceRequirements: [req('module-verifier-receipt', VERIFIER_REF, true)],
  });
  const r = diagnoseStepEvidence(
    s,
    s.evidenceRequirements,
    [
      evidence(
        'module-verifier-receipt',
        VERIFIER_REF,
        STRUCTURAL_VALUES['module-verifier-receipt'],
        { moduleVerifierContractRef: VERIFIER_REF },
      ),
    ],
    { verifierRegistry: reg },
  );
  assert.equal(r.satisfied, false);
  assert.equal(r.unsatisfied[0].reasonCode, 'MODULE_VERIFIER_REJECTED');
  assert.ok(r.unsatisfied[0].reason.includes('SRS_NOT_ACCEPTED'));
});

test('module-verifier-receipt falls back to item.contractRef when moduleVerifierContractRef absent', () => {
  // When the receipt does not carry an explicit moduleVerifierContractRef, the
  // gate looks up the verifier by the evidence item's own contractRef.
  const reg = new PackageEvidenceVerifierRegistry();
  let seenRef;
  reg.register(VERIFIER_REF, (ev) => {
    seenRef = ev.contractRef;
    return { accepted: true };
  });
  const s = step({
    evidenceRequirements: [req('module-verifier-receipt', VERIFIER_REF, true)],
  });
  assert.equal(
    verifyStepEvidence(
      s,
      s.evidenceRequirements,
      [
        // No moduleVerifierContractRef; contractRef == VERIFIER_REF.
        evidence(
          'module-verifier-receipt',
          VERIFIER_REF,
          STRUCTURAL_VALUES['module-verifier-receipt'],
        ),
      ],
      { verifierRegistry: reg },
    ),
    true,
  );
  assert.deepEqual(seenRef, VERIFIER_REF);
});

test('verifier receives the evidence item and moduleRef', () => {
  const reg = new PackageEvidenceVerifierRegistry();
  let seenEvidence;
  let seenModuleRef;
  reg.register(VERIFIER_REF, (ev, mref) => {
    seenEvidence = ev;
    seenModuleRef = mref;
    return { accepted: true };
  });
  const s = step({
    evidenceRequirements: [req('module-verifier-receipt', VERIFIER_REF, true)],
  });
  const moduleRef = { name: 'formalization', version: '1.0.0' };
  verifyStepEvidence(
    s,
    s.evidenceRequirements,
    [
      evidence(
        'module-verifier-receipt',
        VERIFIER_REF,
        STRUCTURAL_VALUES['module-verifier-receipt'],
        { moduleVerifierContractRef: VERIFIER_REF },
      ),
    ],
    { verifierRegistry: reg, moduleRef },
  );
  assert.equal(seenEvidence.category, 'module-verifier-receipt');
  assert.deepEqual(seenModuleRef, moduleRef);
});

// ---------------------------------------------------------------------------
// Before-complete gate (C026).
// ---------------------------------------------------------------------------

test('canCompleteStep is true for a step whose required evidence is satisfied', () => {
  const s = step({ evidenceRequirements: [req('tool-receipt', TOOL_REF, true)] });
  assert.equal(
    canCompleteStep({
      step: s,
      providedEvidence: [
        evidence('tool-receipt', TOOL_REF, STRUCTURAL_VALUES['tool-receipt']),
      ],
      isNodeCompletion: false,
      completionEvidenceRequirements: [],
    }),
    true,
  );
});

test('canCompleteStep is false when required evidence is missing (C026)', () => {
  const s = step({ evidenceRequirements: [req('tool-receipt', TOOL_REF, true)] });
  assert.equal(
    canCompleteStep({
      step: s,
      providedEvidence: [],
      isNodeCompletion: false,
      completionEvidenceRequirements: [],
    }),
    false,
  );
});

test('verifyBeforeCompleteGate non-completion verifies step evidence only', () => {
  const s = step({ evidenceRequirements: [req('tool-receipt', TOOL_REF, true)] });
  const r = verifyBeforeCompleteGate({
    step: s,
    providedEvidence: [
      evidence('tool-receipt', TOOL_REF, STRUCTURAL_VALUES['tool-receipt']),
    ],
    isNodeCompletion: false,
    // Node completion evidence is deliberately UNSATISFIED; it must not be
    // checked for a non-completion step advance.
    completionEvidenceRequirements: [req('artifact-reference', ARTIFACT_REF, true)],
  });
  assert.equal(r.satisfied, true);
  assert.equal(r.verifiedNodeCompletion, false);
  assert.equal(r.completionResult, undefined);
});

test('verifyBeforeCompleteGate node completion verifies BOTH step and completion evidence', () => {
  const s = step({ evidenceRequirements: [req('tool-receipt', TOOL_REF, true)] });
  // Step evidence satisfied, completion evidence satisfied ⇒ node completes.
  const ok = verifyBeforeCompleteGate({
    step: s,
    providedEvidence: [
      evidence('tool-receipt', TOOL_REF, STRUCTURAL_VALUES['tool-receipt']),
      evidence('artifact-reference', ARTIFACT_REF, STRUCTURAL_VALUES['artifact-reference']),
    ],
    isNodeCompletion: true,
    completionEvidenceRequirements: [req('artifact-reference', ARTIFACT_REF, true)],
  });
  assert.equal(ok.satisfied, true);
  assert.equal(ok.verifiedNodeCompletion, true);
  assert.equal(ok.completionResult.satisfied, true);
});

test('verifyBeforeCompleteGate node completion fails when completion evidence is missing', () => {
  const s = step({ evidenceRequirements: [req('tool-receipt', TOOL_REF, true)] });
  // Step evidence satisfied but node completion evidence missing ⇒ blocked.
  const r = verifyBeforeCompleteGate({
    step: s,
    providedEvidence: [
      evidence('tool-receipt', TOOL_REF, STRUCTURAL_VALUES['tool-receipt']),
    ],
    isNodeCompletion: true,
    completionEvidenceRequirements: [req('artifact-reference', ARTIFACT_REF, true)],
  });
  assert.equal(r.satisfied, false);
  assert.equal(r.verifiedNodeCompletion, true);
  assert.equal(r.completionResult.satisfied, false);
  assert.equal(r.completionResult.unsatisfied[0].category, 'artifact-reference');
});

test('verifyBeforeCompleteGate node completion short-circuits when step evidence fails', () => {
  const s = step({ evidenceRequirements: [req('tool-receipt', TOOL_REF, true)] });
  // Step evidence MISSING; node completion evidence satisfied. The step
  // failure must short-circuit: no point checking completion evidence.
  const r = verifyBeforeCompleteGate({
    step: s,
    providedEvidence: [
      evidence('artifact-reference', ARTIFACT_REF, STRUCTURAL_VALUES['artifact-reference']),
    ],
    isNodeCompletion: true,
    completionEvidenceRequirements: [req('artifact-reference', ARTIFACT_REF, true)],
  });
  assert.equal(r.satisfied, false);
  assert.equal(r.verifiedNodeCompletion, false);
  // The step-level failure is reported.
  assert.equal(r.unsatisfied[0].category, 'tool-receipt');
});

test('verifyBeforeCompleteGate threads verifier registry into node completion evidence', () => {
  const reg = new PackageEvidenceVerifierRegistry();
  reg.register(VERIFIER_REF, () => ({ accepted: true }));
  const s = step({ evidenceRequirements: [] });
  const r = verifyBeforeCompleteGate({
    step: s,
    providedEvidence: [
      evidence(
        'module-verifier-receipt',
        VERIFIER_REF,
        STRUCTURAL_VALUES['module-verifier-receipt'],
        { moduleVerifierContractRef: VERIFIER_REF },
      ),
    ],
    isNodeCompletion: true,
    completionEvidenceRequirements: [req('module-verifier-receipt', VERIFIER_REF, true)],
    verifierRegistry: reg,
  });
  assert.equal(r.satisfied, true);
  assert.equal(r.verifiedNodeCompletion, true);
});

test('verifyBeforeCompleteGate node completion fails closed without a verifier', () => {
  const s = step({ evidenceRequirements: [] });
  const r = verifyBeforeCompleteGate({
    step: s,
    providedEvidence: [
      evidence(
        'module-verifier-receipt',
        VERIFIER_REF,
        STRUCTURAL_VALUES['module-verifier-receipt'],
        { moduleVerifierContractRef: VERIFIER_REF },
      ),
    ],
    isNodeCompletion: true,
    completionEvidenceRequirements: [req('module-verifier-receipt', VERIFIER_REF, true)],
    verifierRegistry: new PackageEvidenceVerifierRegistry(),
  });
  assert.equal(r.satisfied, false);
  assert.equal(r.completionResult.unsatisfied[0].reasonCode, 'MODULE_VERIFIER_NOT_REGISTERED');
});

// ---------------------------------------------------------------------------
// Exit-gate #6: "Required evidence CANNOT be skipped" (§0.7.11).
// ---------------------------------------------------------------------------

test('exit-gate #6: a required evidence requirement can never be satisfied by an empty payload', () => {
  // No matter how many optional items are provided, a single required item
  // that is absent blocks the gate.
  const s = step({
    evidenceRequirements: [
      req('tool-receipt', TOOL_REF, false),
      req('human-receipt', HUMAN_REF, true),
    ],
  });
  assert.equal(
    verifyStepEvidence(s, s.evidenceRequirements, [
      evidence('tool-receipt', TOOL_REF, STRUCTURAL_VALUES['tool-receipt']),
    ]),
    false,
  );
});
