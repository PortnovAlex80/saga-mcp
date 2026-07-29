// @ts-check
/**
 * W7-A3 — Scenario compiler tests.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE7-SCENARIO-SPEC.md` Lane W7-A3.
 * Task: `docs/refactor-management/05-subagent-tasks/W07-a3.md`.
 *
 * What this file proves (the five frozen-spec validation categories + a happy
 * path + the convenience resolver):
 *
 *   1. Happy path — a well-formed manifest + matching module contracts compile
 *      to a `ScenarioCompilation` with resolved stages, derived outcome sets,
 *      reachability facts, and deduped required modules.
 *   2. Mappings type-check against module contracts:
 *        - moduleSelector that does not resolve → MODULE_CONTRACT_UNRESOLVED.
 *        - invalid mapping expression (bad runtime var, unsafe path) →
 *          MAPPING_EXPRESSION_INVALID.
 *        - inputContractRef not in the supplied schema registry →
 *          CONTRACT_REF_NOT_REGISTERED.
 *   3. Route table completeness — a module outcome with no static route →
 *      OUTCOME_ROUTE_MISSING.
 *   4. Graph reachability — unreachable stage, stage that cannot terminate,
 *      entry that cannot terminate.
 *   5. Terminal outcomes — empty terminalStatuses, scenario-level terminal
 *      route to an undeclared status, module terminal outcome routed to a
 *      missing stage.
 *   6. Budget validation — non-integer / out-of-range top-level caps, perStage
 *      entries that reference unknown stages or carry invalid caps.
 *   7. requiredModuleSelectors ↔ used modules consistency both directions.
 *   8. Envelope defense-in-depth — a manifest that fails Wave 1 validation
 *      short-circuits with ENVELOPE_INVALID and never reaches contract checks.
 *   9. createModuleContractResolver — caret/tilde/exact/wildcard satisfaction.
 *
 * Imports run against the COMPILED dist/ output.
 *
 * Run: `node --test tests/execution/scenario-compiler.test.mjs`
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileScenario,
  createModuleContractResolver,
  // Error code tokens (branch on these, not on message text).
  ENVELOPE_INVALID,
  MODULE_CONTRACT_UNRESOLVED,
  MAPPING_EXPRESSION_INVALID,
  CONTRACT_REF_NOT_REGISTERED,
  OUTCOME_ROUTE_MISSING,
  STAGE_UNREACHABLE,
  STAGE_CANNOT_TERMINATE,
  ENTRY_CANNOT_TERMINATE,
  BUDGET_INVALID,
  BUDGET_PERSTAGE_UNKNOWN_STAGE,
  REQUIRED_MODULE_UNDECLARED,
  REQUIRED_MODULE_UNUSED,
} from '../../dist/application/scenario-compiler.js';

// ---------------------------------------------------------------------------
// Fixture builders.
// ---------------------------------------------------------------------------

function ref(schemaId, version, digest) {
  return { schemaId, version, digest: digest ?? `d-${schemaId}-${version}` };
}

/**
 * Minimal valid ProcessModuleManifest. `extraOutcomes` appends to the default
 * `go`/`clarify` outcomes; `flowId` lets two distinct manifests differ.
 */
function moduleManifest(name, version, opts = {}) {
  const outcomes = opts.outcomes ?? [
    { code: 'go', description: 'proceed', terminal: false },
    { code: 'clarify', description: 'needs work', terminal: true },
  ];
  return {
    manifestFormatVersion: '0.1.0',
    definition: {
      identity: {
        name,
        version,
        kind: opts.kind ?? 'process',
        displayName: opts.displayName ?? name,
        description: opts.description ?? `${name} module`,
      },
      inputContract: { id: `${name}.input` },
      outputContract: { id: `${name}.output` },
      outcomes,
      flow: {
        id: opts.flowId ?? `${name}-flow`,
        version: '1.0.0',
        entryNodeId: 'n1',
        nodes: [
          { id: 'n1', label: 'do', kind: 'lm', executionProfile: 'p1', description: 'do work', emitsOutcome: 'go' },
        ],
        transitions: [],
        terminalNodeIds: ['n1'],
      },
      artifacts: [],
      policies: [],
      invariants: [],
      executionProfiles: [
        {
          id: 'p1',
          workIntentKind: 'w',
          workIntentSchema: { id: 'w.schema' },
          taskKind: 't',
          executionSkill: 's',
          protocolSkill: 'ps',
          semanticSkill: 'ss',
          executionMode: 'git_change',
          allowedTools: [],
          trackerTemplate: null,
          workspaceTemplates: [],
          callTemplates: [],
          checklists: [],
          outputSchema: { id: 'o.schema' },
          retryPolicy: { maxAttempts: 1, retryOn: [], backoff: 'none' },
          recoveryPolicy: {
            resumeFromCheckpoint: false,
            reuseWorkIntent: false,
            reuseAcceptedOutput: false,
            onExhausted: 'fail',
          },
        },
      ],
    },
    resourceIndex: [],
    handlerRefs: [],
    inputContractRef: ref(`${name}.input`, '1.0.0'),
    outputContractRef: ref(`${name}.output`, '1.0.0'),
    runtimeCompatibilityRange: '^3.0.0',
  };
}

/** A stage binding whose outcomeRoutes are filled by the caller. */
function stage(id, moduleName, moduleVersion, opts = {}) {
  // Default routes cover BOTH default module outcomes (go + clarify) so a
  // stage is route-complete unless the test deliberately overrides `routes`.
  const routes = opts.routes ?? {
    go: { type: 'terminal', status: 'done' },
    clarify: { type: 'terminal', status: 'done' },
  };
  const binding = {
    id,
    displayName: opts.displayName ?? id,
    moduleRef: { name: moduleName, version: moduleVersion },
    moduleSelector: { name: moduleName, versionRange: opts.versionRange ?? moduleVersion },
    inputMapping: opts.inputMapping ?? { payload: 'root.payload' },
    outputMapping: opts.outputMapping,
    outcomeRoutes: routes,
    entryConditions: opts.entryConditions ?? [],
    exitConditions: opts.exitConditions ?? [],
  };
  return binding;
}

/**
 * Build a baseline valid manifest. Each test clones + mutates one field to
 * introduce exactly one defect class, then asserts the matching error code.
 */
function validManifest(stages) {
  const moduleNames = [...new Set(stages.map((s) => s.moduleSelector.name + '@' + s.moduleSelector.versionRange))]
    .map((key) => {
      const [name, versionRange] = key.split('@');
      return { name, versionRange };
    });
  return {
    manifestFormatVersion: '0.1.0',
    identity: {
      name: 'test-scenario',
      version: '1.0.0',
      displayName: 'Test Scenario',
      description: 'a test',
    },
    inputContractRef: ref('scenario.input', '1.0.0'),
    outputContractRef: ref('scenario.output', '1.0.0'),
    entryStageId: stages[0].id,
    stageBindings: stages,
    outcomeRoutes: {},
    inputMappings: { root: 'root' },
    outputMappings: {},
    terminalStatuses: ['done'],
    scenarioPolicies: {},
    requiredModuleSelectors: moduleNames,
    transitionBudgets: { maxTransitions: 10 },
    reentryBudgets: { maxReentries: 2 },
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function codes(result) {
  return new Set((result.errors ?? []).map((e) => e.code));
}

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

// ---------------------------------------------------------------------------
// 1. Happy path.
// ---------------------------------------------------------------------------

test('happy path: valid manifest + matching contracts compiles', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const m2 = moduleManifest('beta', '2.0.0', {
    outcomes: [
      { code: 'next', description: 'to alpha', terminal: false },
      { code: 'end', description: 'done', terminal: true },
    ],
  });
  const stages = [
    // alpha declares {go, clarify}; route go→s2, clarify→terminal.
    stage('s1', 'alpha', '1.0.0', { routes: { go: { type: 'stage', stageId: 's2' }, clarify: { type: 'terminal', status: 'done' } } }),
    // beta declares {next, end}; route next→s1, end→terminal.
    stage('s2', 'beta', '2.0.0', { routes: { next: { type: 'stage', stageId: 's1' }, end: { type: 'terminal', status: 'done' } } }),
  ];
  const manifest = validManifest(stages);
  const resolver = createModuleContractResolver([m1, m2]);

  const result = compileScenario(manifest, resolver);

  assert.equal(result.ok, true);
  assert.equal(result.stages.s1.moduleContract.definition.identity.name, 'alpha');
  assert.equal(result.stages.s2.moduleContract.definition.identity.name, 'beta');
  assert.deepEqual([...result.stages.s1.declaredOutcomes].sort(), ['clarify', 'go']);
  assert.deepEqual([...result.stages.s1.terminalOutcomes], ['clarify']);
  assert.deepEqual([...result.terminalStatuses], ['done']);
  // Both stages reachable from entry s1.
  assert.deepEqual([...result.reachability.reachableFromEntry].sort(), ['s1', 's2']);
  // Both stages can reach a terminal (s2 directly, s1 via s2.end).
  assert.ok(result.reachability.stagesReachingTerminal.includes('s1'));
  assert.ok(result.reachability.stagesReachingTerminal.includes('s2'));
  assert.equal(result.reachability.entryReachesTerminal, true);
  // Two distinct required modules.
  assert.equal(result.requiredModules.length, 2);
});

// ---------------------------------------------------------------------------
// 2. Mappings type-check against module contracts.
// ---------------------------------------------------------------------------

test('category 1a: unresolved moduleSelector → MODULE_CONTRACT_UNRESOLVED', () => {
  const stages = [stage('s1', 'alpha', '1.0.0')];
  const manifest = validManifest(stages);
  // Resolver that resolves nothing.
  const result = compileScenario(manifest, () => undefined);

  assert.equal(result.ok, false);
  assert.ok(codes(result).has(MODULE_CONTRACT_UNRESOLVED));
});

test('category 1b: invalid mapping expression (bad runtime var) → MAPPING_EXPRESSION_INVALID', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const stages = [
    stage('s1', 'alpha', '1.0.0', {
      inputMapping: { bad: { runtime: 'notARealVariable' } },
    }),
  ];
  const manifest = validManifest(stages);
  const result = compileScenario(manifest, createModuleContractResolver([m1]));

  assert.equal(result.ok, false);
  assert.ok(codes(result).has(MAPPING_EXPRESSION_INVALID));
});

test('category 1b: unsafe mapping path is rejected (defense-in-depth)', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const stages = [
    stage('s1', 'alpha', '1.0.0', {
      inputMapping: { evil: '__proto__.polluted' },
    }),
  ];
  const manifest = validManifest(stages);
  const result = compileScenario(manifest, createModuleContractResolver([m1]));

  assert.equal(result.ok, false);
  // Wave 1 envelope catches the unsafe path first (§6.9.5); the compiler
  // surfaces it under ENVELOPE_INVALID as defense-in-depth.
  assert.ok(codes(result).has(ENVELOPE_INVALID));
});

test('category 1b: literal mapping expression is accepted', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const stages = [
    stage('s1', 'alpha', '1.0.0', {
      inputMapping: { fixed: { literal: 42 }, rt: { runtime: 'projectId' }, path: 'root.x' },
    }),
  ];
  const manifest = validManifest(stages);
  const result = compileScenario(manifest, createModuleContractResolver([m1]));

  assert.equal(result.ok, true);
});

test('category 1c: scenario inputContractRef not registered → CONTRACT_REF_NOT_REGISTERED', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const stages = [stage('s1', 'alpha', '1.0.0')];
  const manifest = validManifest(stages);
  const lookup = {
    has: (r) => r.schemaId === 'scenario.output', // input deliberately absent
  };
  const result = compileScenario(
    manifest,
    createModuleContractResolver([m1]),
    lookup,
  );

  assert.equal(result.ok, false);
  assert.ok(codes(result).has(CONTRACT_REF_NOT_REGISTERED));
});

// ---------------------------------------------------------------------------
// 3. Route table completeness.
// ---------------------------------------------------------------------------

test('category 2: module outcome with no route → OUTCOME_ROUTE_MISSING', () => {
  const m1 = moduleManifest('alpha', '1.0.0', {
    outcomes: [
      { code: 'go', description: 'proceed', terminal: false },
      { code: 'clarify', description: 'needs work', terminal: true },
      { code: 'extra', description: 'an extra outcome', terminal: false },
    ],
  });
  // Stage routes 'go' and 'clarify' but NOT 'extra'.
  const stages = [
    stage('s1', 'alpha', '1.0.0', {
      routes: { go: { type: 'terminal', status: 'done' }, clarify: { type: 'terminal', status: 'done' } },
    }),
  ];
  const manifest = validManifest(stages);
  const result = compileScenario(manifest, createModuleContractResolver([m1]));

  assert.equal(result.ok, false);
  assert.ok(codes(result).has(OUTCOME_ROUTE_MISSING));
  const missingErr = result.errors.find((e) => e.code === OUTCOME_ROUTE_MISSING);
  assert.ok(missingErr.message.includes('"extra"'), `expected error to name the unroute outcome, got: ${missingErr.message}`);
});

// ---------------------------------------------------------------------------
// 4. Graph reachability.
// ---------------------------------------------------------------------------

test('category 3a: stage unreachable from entry → STAGE_UNREACHABLE', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const m2 = moduleManifest('beta', '2.0.0', {
    outcomes: [{ code: 'end', description: 'done', terminal: true }],
  });
  // s1 routes to a terminal only; s2 is orphaned (no inbound edge) but itself
  // routes to a terminal, so the only defect is unreachability.
  const stages = [
    stage('s1', 'alpha', '1.0.0', { routes: { go: { type: 'terminal', status: 'done' }, clarify: { type: 'terminal', status: 'done' } } }),
    stage('s2', 'beta', '2.0.0', { routes: { end: { type: 'terminal', status: 'done' } } }),
  ];
  const manifest = validManifest(stages);
  const result = compileScenario(manifest, createModuleContractResolver([m1, m2]));

  assert.equal(result.ok, false);
  assert.ok(codes(result).has(STAGE_UNREACHABLE));
});

test('category 3b: reachable stage that cannot terminate → STAGE_CANNOT_TERMINATE', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  // s1 routes to s2 (stage edge); s2 only routes back to s1 — neither reaches
  // a terminal. Both are reachable but neither can terminate.
  const stages = [
    stage('s1', 'alpha', '1.0.0', { routes: { go: { type: 'stage', stageId: 's2' }, clarify: { type: 'stage', stageId: 's2' } } }),
    stage('s2', 'alpha', '1.0.0', { routes: { go: { type: 'stage', stageId: 's1' }, clarify: { type: 'stage', stageId: 's1' } } }),
  ];
  const manifest = validManifest(stages);
  const result = compileScenario(manifest, createModuleContractResolver([m1]));

  assert.equal(result.ok, false);
  const c = codes(result);
  assert.ok(c.has(STAGE_CANNOT_TERMINATE));
  assert.ok(c.has(ENTRY_CANNOT_TERMINATE));
});

// ---------------------------------------------------------------------------
// 5. Terminal outcomes.
// ---------------------------------------------------------------------------

test('category 4a: empty terminalStatuses is caught by envelope (defense-in-depth)', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const stages = [stage('s1', 'alpha', '1.0.0')];
  const manifest = validManifest(stages);
  manifest.terminalStatuses = [];
  const result = compileScenario(manifest, createModuleContractResolver([m1]));

  assert.equal(result.ok, false);
  // Wave 1 envelope enforces non-empty terminalStatuses (§6.2.9); the
  // compiler surfaces it as ENVELOPE_INVALID rather than reaching its own
  // duplicate check.
  assert.ok(codes(result).has(ENVELOPE_INVALID));
});

test('category 4b: scenario terminal route to undeclared status is caught by envelope', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const stages = [stage('s1', 'alpha', '1.0.0')];
  const manifest = validManifest(stages);
  manifest.outcomeRoutes = { custom: { type: 'terminal', status: 'not-declared' } };
  const result = compileScenario(manifest, createModuleContractResolver([m1]));

  assert.equal(result.ok, false);
  // Wave 1 envelope resolves every outcomeRoutes target against the declared
  // stage/terminal sets (§6.2); the compiler surfaces it as ENVELOPE_INVALID.
  assert.ok(codes(result).has(ENVELOPE_INVALID));
});

test('category 4c: module terminal outcome routed to a missing stage is caught by envelope', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  // clarify is terminal; route it to a stage that does not exist.
  const stages = [
    stage('s1', 'alpha', '1.0.0', {
      routes: {
        go: { type: 'terminal', status: 'done' },
        clarify: { type: 'stage', stageId: 'ghost' },
      },
    }),
  ];
  const manifest = validManifest(stages);
  const result = compileScenario(manifest, createModuleContractResolver([m1]));

  assert.equal(result.ok, false);
  // Wave 1 envelope rejects any outcomeRoutes target whose stageId is not a
  // declared stage binding (§6.2); the compiler surfaces it as ENVELOPE_INVALID.
  assert.ok(codes(result).has(ENVELOPE_INVALID));
});

// ---------------------------------------------------------------------------
// 6. Budget validation.
// ---------------------------------------------------------------------------

test('category 5a: transitionBudgets.maxTransitions <= 0 is caught by envelope', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const stages = [stage('s1', 'alpha', '1.0.0')];
  const manifest = validManifest(stages);
  manifest.transitionBudgets = { maxTransitions: 0 };
  const result = compileScenario(manifest, createModuleContractResolver([m1]));

  assert.equal(result.ok, false);
  // Wave 1 envelope enforces maxTransitions > 0 (§6.2.10); the compiler
  // surfaces it as ENVELOPE_INVALID.
  assert.ok(codes(result).has(ENVELOPE_INVALID));
});

test('category 5b: reentryBudgets.maxReentries non-integer → BUDGET_INVALID', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const stages = [stage('s1', 'alpha', '1.0.0')];
  const manifest = validManifest(stages);
  manifest.reentryBudgets = { maxReentries: 1.5 };
  const result = compileScenario(manifest, createModuleContractResolver([m1]));

  assert.equal(result.ok, false);
  assert.ok(codes(result).has(BUDGET_INVALID));
});

test('category 5c: perStage budget references unknown stage → BUDGET_PERSTAGE_UNKNOWN_STAGE', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const stages = [stage('s1', 'alpha', '1.0.0')];
  const manifest = validManifest(stages);
  manifest.transitionBudgets = { maxTransitions: 10, perStage: { ghost: 5 } };
  const result = compileScenario(manifest, createModuleContractResolver([m1]));

  assert.equal(result.ok, false);
  assert.ok(codes(result).has(BUDGET_PERSTAGE_UNKNOWN_STAGE));
});

test('category 5d: perStage reentry budget out of range → BUDGET_INVALID', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const stages = [stage('s1', 'alpha', '1.0.0')];
  const manifest = validManifest(stages);
  manifest.reentryBudgets = { maxReentries: 2, perStage: { s1: -1 } };
  const result = compileScenario(manifest, createModuleContractResolver([m1]));

  assert.equal(result.ok, false);
  assert.ok(codes(result).has(BUDGET_INVALID));
});

// ---------------------------------------------------------------------------
// 7. requiredModuleSelectors consistency.
// ---------------------------------------------------------------------------

test('category 7a: stage binds a module not in requiredModuleSelectors → REQUIRED_MODULE_UNDECLARED', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const stages = [stage('s1', 'alpha', '1.0.0')];
  const manifest = validManifest(stages);
  // Wipe required list — now the used selector is undeclared.
  manifest.requiredModuleSelectors = [];
  const result = compileScenario(manifest, createModuleContractResolver([m1]));

  assert.equal(result.ok, false);
  assert.ok(codes(result).has(REQUIRED_MODULE_UNDECLARED));
});

test('category 7b: declared required module unused by any stage → REQUIRED_MODULE_UNUSED', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const stages = [stage('s1', 'alpha', '1.0.0')];
  const manifest = validManifest(stages);
  // Add a dangling declaration.
  manifest.requiredModuleSelectors = [
    { name: 'alpha', versionRange: '1.0.0' },
    { name: 'ghost', versionRange: '9.9.9' },
  ];
  const result = compileScenario(manifest, createModuleContractResolver([m1]));

  assert.equal(result.ok, false);
  assert.ok(codes(result).has(REQUIRED_MODULE_UNUSED));
});

// ---------------------------------------------------------------------------
// 8. Envelope defense-in-depth.
// ---------------------------------------------------------------------------

test('category 8: manifest failing Wave 1 envelope short-circuits with ENVELOPE_INVALID', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const stages = [stage('s1', 'alpha', '1.0.0')];
  const manifest = validManifest(stages);
  // Smuggle a routeResolver — Wave 1 §6.4 forbids the key.
  manifest.routeResolver = () => undefined;

  const result = compileScenario(manifest, createModuleContractResolver([m1]));

  assert.equal(result.ok, false);
  const c = codes(result);
  assert.ok(c.has(ENVELOPE_INVALID));
  // Must NOT reach contract checks — the only error codes present are envelope ones.
  for (const code of c) {
    assert.equal(code, ENVELOPE_INVALID, `unexpected non-envelope code: ${code}`);
  }
});

// ---------------------------------------------------------------------------
// 9. createModuleContractResolver — semver satisfaction.
// ---------------------------------------------------------------------------

test('resolver: exact version match', () => {
  const m = moduleManifest('alpha', '1.2.3');
  const resolver = createModuleContractResolver([m]);
  assert.equal(resolver({ name: 'alpha', versionRange: '1.2.3' }), m);
});

test('resolver: caret range picks highest compatible', () => {
  const mOld = moduleManifest('alpha', '1.0.0');
  const mMid = moduleManifest('alpha', '1.5.0');
  const mNew = moduleManifest('alpha', '1.9.0');
  const mNext = moduleManifest('alpha', '2.0.0');
  const resolver = createModuleContractResolver([mOld, mMid, mNew, mNext]);
  // ^1.0.0 should resolve to 1.9.0 (same major), never 2.0.0.
  assert.equal(resolver({ name: 'alpha', versionRange: '^1.0.0' }), mNew);
});

test('resolver: tilde range is same major+minor', () => {
  const m1 = moduleManifest('alpha', '1.2.0');
  const m2 = moduleManifest('alpha', '1.2.9');
  const m3 = moduleManifest('alpha', '1.3.0');
  const resolver = createModuleContractResolver([m1, m2, m3]);
  // ~1.2.0 → 1.2.9, not 1.3.0.
  assert.equal(resolver({ name: 'alpha', versionRange: '~1.2.0' }), m2);
});

test('resolver: wildcard matches any version', () => {
  const m = moduleManifest('alpha', '3.4.5');
  const resolver = createModuleContractResolver([m]);
  assert.equal(resolver({ name: 'alpha', versionRange: '*' }), m);
});

test('resolver: no match returns undefined', () => {
  const m = moduleManifest('alpha', '1.0.0');
  const resolver = createModuleContractResolver([m]);
  assert.equal(resolver({ name: 'beta', versionRange: '*' }), undefined);
  assert.equal(resolver({ name: 'alpha', versionRange: '^2.0.0' }), undefined);
});
