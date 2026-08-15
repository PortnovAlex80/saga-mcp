// tools/scenario-authoring-kit/scenario-validator.test.mjs
//
// W10-A6 Scenario Authoring Kit — validator unit tests.
//
// Exercises `validateScenarioManifest` against a battery of well-formed and
// deliberately-broken manifests. Each broken manifest targets exactly one rule
// so the rule provenance is unambiguous. Uses node:test — no build step needed.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateScenarioManifest,
  RULES,
} from './scenario-validator.mjs';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** A minimal well-formed manifest (two stages, complete route table). */
function goodManifest(overrides = {}) {
  return structuredClone({
    manifestFormatVersion: '0.1.0',
    identity: {
      name: 'demo',
      version: '0.1.0',
      displayName: 'Demo',
      description: 'A demo scenario.',
    },
    inputContract: { id: 'demo.input.v1' },
    outputContract: { id: 'demo.output.v1' },
    entryStageId: 'draft',
    terminalStatuses: ['demo-approved', 'demo-rejected'],
    moduleRefs: [
      { name: 'demo-module-a', version: '0.1.0' },
      { name: 'demo-module-b', version: '0.1.0' },
    ],
    stages: [
      {
        id: 'draft',
        displayName: 'Draft',
        moduleRef: { name: 'demo-module-a', version: '0.1.0' },
        inputMapping: { field1: 'initiative.field1', market: { literal: 'baseline' } },
        outputMapping: { result1: 'output.result1' },
        outcomeRoutes: { drafted: { type: 'stage', stageId: 'approve' } },
        entryConditions: ['Scenario root input present'],
        exitConditions: ['drafted outcome emitted'],
      },
      {
        id: 'approve',
        displayName: 'Approve',
        moduleRef: { name: 'demo-module-b', version: '0.1.0' },
        inputMapping: {
          result1: 'stages.draft.output.result1',
          requestedBy: { runtime: 'initiatedBy' },
        },
        outputMapping: { decision: 'output.decision' },
        outcomeRoutes: {
          approved: { type: 'terminal', status: 'demo-approved' },
          rejected: { type: 'terminal', status: 'demo-rejected' },
        },
        entryConditions: ['draft stage produced output'],
        exitConditions: ['approved or rejected outcome emitted'],
      },
    ],
    routeResolverPresent: false,
    ...overrides,
  });
}

function errorRules(findings) {
  return findings.filter((f) => f.severity === 'error').map((f) => f.rule);
}
function hasError(findings, rule) {
  return findings.some((f) => f.severity === 'error' && f.rule === rule);
}

// ---------------------------------------------------------------------------
// Registry sanity.
// ---------------------------------------------------------------------------

test('RULES catalogue is non-empty and stable', () => {
  assert.ok(RULES.length >= 10, 'expected at least the core rules');
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'rule ids are unique');
  for (const r of RULES) {
    assert.ok(r.section.startsWith('§'), `${r.id} section references a plan paragraph`);
  }
});

// ---------------------------------------------------------------------------
// Well-formed manifest.
// ---------------------------------------------------------------------------

test('well-formed manifest validates with zero errors', () => {
  const { findings, summary } = validateScenarioManifest(goodManifest());
  assert.equal(summary.errors, 0, `unexpected errors: ${JSON.stringify(findings)}`);
  assert.equal(summary.ok, true);
});

// ---------------------------------------------------------------------------
// V0: not an object.
// ---------------------------------------------------------------------------

test('V0: non-object manifest is rejected', () => {
  for (const bad of [null, 42, 'x', [], true]) {
    const { findings } = validateScenarioManifest(bad);
    assert.ok(hasError(findings, 'V0'), `expected V0 for ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// V1: missing top-level fields.
// ---------------------------------------------------------------------------

test('V1: missing entryStageId is flagged', () => {
  const m = goodManifest();
  delete m.entryStageId;
  assert.ok(hasError(validateScenarioManifest(m).findings, 'V1'));
});

test('V1: terminalStatuses must be string array', () => {
  const m = goodManifest({ terminalStatuses: ['ok', 7] });
  assert.ok(hasError(validateScenarioManifest(m).findings, 'V1'));
});

// ---------------------------------------------------------------------------
// V2: identity shape.
// ---------------------------------------------------------------------------

test('V2: non-kebab identity.name is flagged', () => {
  const m = goodManifest({ identity: { ...goodManifest().identity, name: 'Bad Name' } });
  assert.ok(hasError(validateScenarioManifest(m).findings, 'V2'));
});

test('V2: non-semver identity.version is flagged', () => {
  const m = goodManifest({ identity: { ...goodManifest().identity, version: 'latest' } });
  assert.ok(hasError(validateScenarioManifest(m).findings, 'V2'));
});

// ---------------------------------------------------------------------------
// V3: contracts.
// ---------------------------------------------------------------------------

test('V3: inputContract without id is flagged', () => {
  const m = goodManifest({ inputContract: {} });
  assert.ok(hasError(validateScenarioManifest(m).findings, 'V3'));
});

// ---------------------------------------------------------------------------
// V4: NO routeResolver — the core §6.4 proof.
// ---------------------------------------------------------------------------

test('V4: routeResolver field is rejected', () => {
  // A manifest is JSON; a routeResolver cannot truly be carried in JSON. The
  // validator forbids the FIELD NAME regardless of value (the field itself is
  // the §6.4 violation — its presence implies an executable closure would be
  // needed).
  const m = goodManifest({ routeResolver: { type: 'function' } });
  assert.ok(hasError(validateScenarioManifest(m).findings, 'V4'));
});

test('V4: routeResolverPresent=true is rejected', () => {
  const m = goodManifest({ routeResolverPresent: true });
  assert.ok(hasError(validateScenarioManifest(m).findings, 'V4'));
});

test('V4: a clean manifest never reports V4', () => {
  assert.ok(!hasError(validateScenarioManifest(goodManifest()).findings, 'V4'));
});

// ---------------------------------------------------------------------------
// V5: entry stage resolves.
// ---------------------------------------------------------------------------

test('V5: entryStageId pointing at a missing stage is flagged', () => {
  const m = goodManifest({ entryStageId: 'nope' });
  assert.ok(hasError(validateScenarioManifest(m).findings, 'V5'));
});

// ---------------------------------------------------------------------------
// V6: route completeness + shape.
// ---------------------------------------------------------------------------

test('V6: route targeting unknown stage is flagged', () => {
  const m = goodManifest();
  m.stages[0].outcomeRoutes = { drafted: { type: 'stage', stageId: 'ghost' } };
  const { findings } = validateScenarioManifest(m);
  assert.ok(hasError(findings, 'V6'));
  // cascading: approve becomes unreachable (V11 warning), but no new error beyond V6.
  assert.ok(!errorRules(findings).some((r) => r !== 'V6'), `unexpected error rules: ${errorRules(findings)}`);
});

test('V6: terminal route targeting undeclared status is flagged', () => {
  const m = goodManifest();
  m.stages[1].outcomeRoutes = {
    approved: { type: 'terminal', status: 'mystery' },
    rejected: { type: 'terminal', status: 'demo-rejected' },
  };
  assert.ok(hasError(validateScenarioManifest(m).findings, 'V6'));
});

test('V6: route with bad type is flagged', () => {
  const m = goodManifest();
  m.stages[0].outcomeRoutes = { drafted: { type: 'lambda' } };
  assert.ok(hasError(validateScenarioManifest(m).findings, 'V6'));
});

test('V6: module outcome without a route is flagged when moduleOutcomes supplied', () => {
  const m = goodManifest();
  // module demo-module-a declares outcomes [drafted, draft-skipped]; only drafted routed.
  const { findings } = validateScenarioManifest(m, {
    moduleOutcomes: { 'demo-module-a': ['drafted', 'draft-skipped'] },
  });
  assert.ok(hasError(findings, 'V6'));
  assert.match(findings.find((f) => f.rule === 'V6').message, /draft-skipped/);
});

test('V6: complete route table for all declared outcomes passes', () => {
  const m = goodManifest();
  m.stages[0].outcomeRoutes = {
    drafted: { type: 'stage', stageId: 'approve' },
    'draft-skipped': { type: 'terminal', status: 'demo-rejected' },
  };
  const { summary } = validateScenarioManifest(m, {
    moduleOutcomes: { 'demo-module-a': ['drafted', 'draft-skipped'] },
  });
  assert.equal(summary.errors, 0);
});

// ---------------------------------------------------------------------------
// V7: stage ids.
// ---------------------------------------------------------------------------

test('V7: duplicate stage id is flagged', () => {
  const m = goodManifest();
  m.stages[1].id = 'draft';
  assert.ok(hasError(validateScenarioManifest(m).findings, 'V7'));
});

// ---------------------------------------------------------------------------
// V8: moduleRef declared.
// ---------------------------------------------------------------------------

test('V8: stage referencing undeclared module is flagged', () => {
  const m = goodManifest();
  m.stages[0].moduleRef = { name: 'phantom', version: '0.1.0' };
  assert.ok(hasError(validateScenarioManifest(m).findings, 'V8'));
});

test('V8: undeclared moduleRef is NOT flagged when moduleRefs is empty (degrades gracefully)', () => {
  const m = goodManifest({ moduleRefs: [] });
  assert.ok(!hasError(validateScenarioManifest(m).findings, 'V8'));
});

// ---------------------------------------------------------------------------
// V9: mapping safety (§6.9.5).
// ---------------------------------------------------------------------------

test('V9: path-string mapping is accepted', () => {
  const m = goodManifest();
  m.stages[0].inputMapping = { x: 'initiative.x' };
  assert.ok(!hasError(validateScenarioManifest(m).findings, 'V9'));
});

test('V9: literal mapping is accepted', () => {
  const m = goodManifest();
  m.stages[0].inputMapping = { x: { literal: 42 } };
  assert.ok(!hasError(validateScenarioManifest(m).findings, 'V9'));
});

test('V9: allowed runtime fields are accepted', () => {
  const m = goodManifest();
  m.stages[0].inputMapping = { a: { runtime: 'initiatedBy' }, b: { runtime: 'projectId' } };
  assert.ok(!hasError(validateScenarioManifest(m).findings, 'V9'));
});

test('V9: disallowed runtime field is flagged', () => {
  const m = goodManifest();
  m.stages[0].inputMapping = { x: { runtime: 'systemTime' } };
  assert.ok(hasError(validateScenarioManifest(m).findings, 'V9'));
});

test('V9: object mapping without literal/runtime is flagged', () => {
  const m = goodManifest();
  m.stages[0].inputMapping = { x: { expression: 'a + b' } };
  assert.ok(hasError(validateScenarioManifest(m).findings, 'V9'));
});

test('V9: number mapping value is flagged', () => {
  const m = goodManifest();
  m.stages[0].inputMapping = { x: 7 };
  assert.ok(hasError(validateScenarioManifest(m).findings, 'V9'));
});

// ---------------------------------------------------------------------------
// V11 / V12: reachability warnings (not errors).
// ---------------------------------------------------------------------------

test('V11: unreachable non-entry stage is a warning, not an error', () => {
  const m = goodManifest();
  // orphan stage nobody routes to.
  m.stages.push({
    id: 'orphan',
    displayName: 'Orphan',
    moduleRef: { name: 'demo-module-a', version: '0.1.0' },
    inputMapping: {},
    outputMapping: {},
    outcomeRoutes: { done: { type: 'terminal', status: 'demo-approved' } },
  });
  const { findings, summary } = validateScenarioManifest(m);
  assert.ok(findings.some((f) => f.rule === 'V11' && f.severity === 'warning'));
  // the orphan does not introduce hard errors.
  assert.equal(summary.errors, 0, JSON.stringify(findings));
});

test('V12: unreachable terminal status is a warning', () => {
  const m = goodManifest({ terminalStatuses: ['demo-approved', 'demo-rejected', 'never-used'] });
  const { findings, summary } = validateScenarioManifest(m);
  assert.ok(findings.some((f) => f.rule === 'V12' && f.severity === 'warning'));
  assert.equal(summary.errors, 0);
});

// ---------------------------------------------------------------------------
// Summary shape.
// ---------------------------------------------------------------------------

test('summary.byRule aggregates counts', () => {
  const m = goodManifest();
  delete m.entryStageId; // V1
  m.stages[0].inputMapping = { x: 7 }; // V9
  const { summary } = validateScenarioManifest(m);
  assert.ok(summary.byRule.V1 >= 1);
  assert.ok(summary.byRule.V9 >= 1);
  assert.equal(summary.ok, false);
});
