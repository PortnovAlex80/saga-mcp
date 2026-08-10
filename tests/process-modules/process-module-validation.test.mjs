import assert from 'node:assert/strict';
import test from 'node:test';

const { validateProcessModuleDefinition } = await import(
  '../../dist/process-modules/application/validate-process-module.js'
);
// Wave 13 removed modules/catalog.ts; build the registry inline.
const { ProcessModuleRegistry } = await import(
  '../../dist/process-modules/application/process-module-registry.js'
);
const { discoveryProcessModule } = await import(
  '../../dist/process-modules/modules/discovery/discovery-process-module.js'
);
const { formalizationProcessModule } = await import(
  '../../dist/process-modules/modules/formalization/formalization-process-module.js'
);
const { developmentProcessModule } = await import(
  '../../dist/process-modules/modules/development/development-process-module.js'
);
const { deliveryProcessModule } = await import(
  '../../dist/process-modules/modules/delivery/delivery-process-module.js'
);
function createBuiltInProcessModuleRegistry() {
  const registry = new ProcessModuleRegistry();
  registry.register(discoveryProcessModule);
  registry.register(formalizationProcessModule);
  registry.register(developmentProcessModule);
  registry.register(deliveryProcessModule);
  return registry;
}

for (const module of [
  discoveryProcessModule,
  formalizationProcessModule,
  developmentProcessModule,
  deliveryProcessModule,
]) {
  test(`${module.identity.name}: definition is structurally valid`, () => {
    const validation = validateProcessModuleDefinition(module);
    assert.equal(validation.valid, true, validation.errors.join('\n'));
    assert.deepEqual(validation.errors, []);
  });

  test(`${module.identity.name}: every LM node has a bound execution profile and recovery`, () => {
    const profiles = new Map(module.executionProfiles.map(profile => [profile.id, profile]));
    for (const node of module.flow.nodes.filter(candidate => candidate.kind === 'lm')) {
      const profile = profiles.get(node.executionProfile);
      assert.ok(profile, `missing profile ${node.executionProfile}`);
      assert.ok(profile.outputSchema.id, `${profile.id} must declare its typed output`);
      assert.equal(profile.recoveryPolicy.resumeFromCheckpoint, true);
      assert.equal(profile.recoveryPolicy.reuseWorkIntent, true);
    }
  });

  test(`${module.identity.name}: every terminal process outcome is emitted`, () => {
    const terminalIds = new Set(module.flow.terminalNodeIds);
    const emitted = new Set(
      module.flow.nodes
        .filter(node => terminalIds.has(node.id))
        .map(node => node.emitsOutcome),
    );
    for (const outcome of module.outcomes.filter(candidate => candidate.terminal)) {
      assert.ok(emitted.has(outcome.code), `terminal outcome ${outcome.code} is not emitted`);
    }
  });
}

for (const module of [discoveryProcessModule, formalizationProcessModule]) {
  test(`${module.identity.name}: authoring LM profiles include operational templates`, () => {
    const profiles = new Map(module.executionProfiles.map(profile => [profile.id, profile]));
    for (const node of module.flow.nodes.filter(candidate => candidate.kind === 'lm')) {
      const profile = profiles.get(node.executionProfile);
      assert.equal(typeof profile.trackerTemplate, 'string');
      assert.ok(profile.callTemplates.length > 0, `${profile.id} must materialize tool calls`);
      assert.ok(profile.checklists.length > 0, `${profile.id} must have a checklist`);
    }
  });
}

test('built-in registry registers all lifecycle modules by versioned identity', () => {
  const registry = createBuiltInProcessModuleRegistry();
  const refs = registry.list().map(module => `${module.identity.name}@${module.identity.version}`);
  assert.deepEqual(refs.sort(), [
    'delivery-release@1.0.0',
    'product-discovery@3.0.2',
    'solution-development@1.1.0',
    'solution-formalization@1.0.0',
  ]);
});

test('validator rejects an LM node without an execution profile', () => {
  const broken = structuredClone(discoveryProcessModule);
  const node = broken.flow.nodes.find(candidate => candidate.kind === 'lm');
  assert.ok(node);
  node.executionProfile = 'missing-profile';
  const validation = validateProcessModuleDefinition(broken);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /missing execution profile/);
});

test('formalization artifact writers delegate acceptance to the common kernel gate', () => {
  for (const profile of formalizationProcessModule.executionProfiles) {
    assert.equal(
      profile.artifactAcceptanceAuthority,
      'kernel-gate',
      profile.id,
    );
    assert.ok(profile.reviewSkill, `${profile.id} must declare an independent reviewer`);
  }
  assert.equal(
    formalizationProcessModule.executionProfiles.find(profile =>
      profile.id === 'formalization-architect').reviewSkill,
    'saga-architecture-reviewer',
  );
});

test('development planner declares reviewer and semantic recovery route', () => {
  const profile = developmentProcessModule.executionProfiles.find(candidate =>
    candidate.id === 'development-task-graph-planner');
  assert.equal(profile.reviewSkill, 'saga-planning-reviewer');
  assert.deepEqual(
    developmentProcessModule.flow.recovery.map(policy => policy.id),
    ['repair-development-task-graph'],
  );
});

test('validator rejects ambiguous transitions from one node on one event', () => {
  const broken = structuredClone(formalizationProcessModule);
  broken.flow.transitions.push({
    from: 'resolve-product-contract',
    to: 'complete-failed',
    on: 'domain.completed',
  });
  const validation = validateProcessModuleDefinition(broken);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /ambiguous transitions/);
});

test('validator rejects ambiguous and non-resolvable recovery declarations', () => {
  const broken = structuredClone(formalizationProcessModule);
  broken.flow.recovery.push({
    id: 'second-product-repair',
    verifyNodeId: 'resolve-product-contract',
    repairNodeId: 'define-product-contract',
    triggerEvents: ['domain.repair-required'],
    resolvedEvents: ['domain.repair-required', 'domain.orphan-success'],
    maxAttempts: 1,
    onExhausted: 'pause',
  });
  const validation = validateProcessModuleDefinition(broken);
  assert.equal(validation.valid, false);
  const errors = validation.errors.join('\n');
  assert.match(errors, /owned by both/);
  assert.match(errors, /both trigger and resolved event/);
  assert.match(errors, /orphan-success.*has no transition/);
});

// --- Phase 3 / C1: composite node must declare a moduleRef ---

test('C1: validator rejects a composite node with no moduleRef', () => {
  const broken = structuredClone(discoveryProcessModule);
  const target = broken.flow.nodes.find(node => node.id === broken.flow.entryNodeId);
  assert.ok(target, 'entry node must exist for the test');
  // Replace the entry node with a composite node lacking a moduleRef. Make it
  // terminal and emit the first outcome so the rest of the validator stays
  // quiet about outcomes; this isolates the composite check.
  const outcome = broken.outcomes[0].code;
  Object.assign(target, {
    kind: 'composite',
    moduleRef: undefined,
    emitsOutcome: outcome,
  });
  broken.flow.terminalNodeIds = [target.id];
  broken.flow.transitions = [];

  const validation = validateProcessModuleDefinition(broken);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /composite node '.*' must declare moduleRef/);
});

test('C1: validator accepts a composite node with a valid moduleRef', () => {
  const broken = structuredClone(discoveryProcessModule);
  const target = broken.flow.nodes.find(node => node.id === broken.flow.entryNodeId);
  assert.ok(target);
  const outcome = broken.outcomes[0].code;
  Object.assign(target, {
    kind: 'composite',
    moduleRef: { name: 'sub-module', version: '1.0.0' },
    emitsOutcome: outcome,
  });
  broken.flow.terminalNodeIds = [target.id];
  broken.flow.transitions = [];

  const validation = validateProcessModuleDefinition(broken);
  const compositeError = validation.errors
    .find(error => /composite node.*must declare moduleRef/.test(error));
  assert.equal(compositeError, undefined, 'valid composite moduleRef must not error');
});

// --- Phase 3 / C2: LM nodes require a non-empty executionProfiles array ---

test('C2: validator rejects LM nodes when executionProfiles is empty', () => {
  const broken = structuredClone(discoveryProcessModule);
  // discoveryProcessModule has at least one LM node.
  assert.ok(
    broken.flow.nodes.some(node => node.kind === 'lm'),
    'discovery module must have an LM node for this test',
  );
  broken.executionProfiles = [];

  const validation = validateProcessModuleDefinition(broken);
  assert.equal(validation.valid, false);
  assert.match(
    validation.errors.join('\n'),
    /module has LM nodes but no execution profiles/,
  );
});

test('C2: validator does not require executionProfiles when no LM nodes exist', () => {
  // Formalization-style modules all use LM nodes, so synthesize a kernel-only
  // module from scratch to confirm the C2 check is skipped without LM nodes.
  const kernelOnly = {
    identity: {
      name: 'kernel-only',
      version: '1.0.0',
      kind: 'development',
      displayName: 'Kernel Only',
      description: 'Kernel-only module.',
    },
    inputContract: { id: 'in.v1' },
    outputContract: { id: 'out.v1' },
    outcomes: [{ code: 'done', description: 'done', terminal: true }],
    flow: {
      id: 'flow',
      version: '1.0.0',
      entryNodeId: 'k',
      nodes: [
        { id: 'k', label: 'Kernel', kind: 'kernel', handler: 'do-it', description: 'kernel' },
      ],
      transitions: [],
      terminalNodeIds: ['k'],
    },
    artifacts: [],
    policies: [],
    invariants: [],
    executionProfiles: [],
  };
  const validation = validateProcessModuleDefinition(kernelOnly);
  assert.equal(
    validation.errors
      .some(error => /module has LM nodes but no execution profiles/.test(error)),
    false,
    'kernel-only module must not trip the C2 LM/profiles check',
  );
});

// --- Phase 3 / C3: identity.kind closed set (warning, not error) ---

test('C3: validator warns when identity.kind is outside the standard set', () => {
  const broken = structuredClone(discoveryProcessModule);
  broken.identity.kind = 'formalisation'; // British spelling typo, not in set

  const validation = validateProcessModuleDefinition(broken);
  assert.equal(validation.valid, true, 'non-standard kind is a warning, not an error');
  assert.match(
    validation.warnings.join('\n'),
    /identity.kind 'formalisation' is not in the standard set/,
  );
});

test('C3: validator does not warn for a standard identity.kind', () => {
  for (const kind of ['discovery', 'formalization', 'development', 'delivery']) {
    const module = structuredClone(discoveryProcessModule);
    module.identity.kind = kind;
    const validation = validateProcessModuleDefinition(module);
    const kindWarning = validation.warnings
      .find(warning => /identity.kind.*is not in the standard set/.test(warning));
    assert.equal(kindWarning, undefined, `standard kind '${kind}' must not warn`);
  }
});
