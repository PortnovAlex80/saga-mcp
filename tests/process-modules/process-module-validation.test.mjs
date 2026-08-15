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

  test(`${module.identity.name}: every worker-producing node has bound execution profiles and recovery`, () => {
    const profiles = new Map(module.executionProfiles.map(profile => [profile.id, profile]));
    for (const node of module.flow.nodes.filter(candidate => candidate.kind === 'lm')) {
      const profile = profiles.get(node.executionProfile);
      assert.ok(profile, `missing profile ${node.executionProfile}`);
      assert.ok(profile.outputSchema.id, `${profile.id} must declare its typed output`);
      assert.equal(profile.recoveryPolicy.resumeFromCheckpoint, true);
      assert.equal(profile.recoveryPolicy.reuseWorkIntent, true);
    }
    for (const node of module.flow.nodes.filter(candidate =>
      candidate.kind === 'production-cell' && candidate.cellDefinition)) {
      const authorId = node.cellDefinition.author.skillRef;
      assert.ok(profiles.has(authorId), `${node.id} missing author profile ${authorId}`);
      assert.ok(node.cellDefinition.recovery.maxAttempts > 0);
      const reviewerId = node.cellDefinition.review?.reviewer.skillRef;
      if (reviewerId) {
        assert.ok(profiles.has(reviewerId), `${node.id} missing reviewer profile ${reviewerId}`);
      }
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
    const referencedProfileIds = new Set();
    for (const node of module.flow.nodes) {
      if (node.kind === 'lm') referencedProfileIds.add(node.executionProfile);
      if (node.kind === 'production-cell' && node.cellDefinition) {
        referencedProfileIds.add(node.cellDefinition.author.skillRef);
        const reviewerId = node.cellDefinition.review?.reviewer.skillRef;
        if (reviewerId) referencedProfileIds.add(reviewerId);
      }
    }
    for (const profileId of referencedProfileIds) {
      const profile = profiles.get(profileId);
      assert.ok(profile, `missing profile ${profileId}`);
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
    'solution-development@1.4.0',
    'solution-formalization@1.0.0',
  ]);
});

test('validator rejects a Production Cell without its author execution profile', () => {
  const broken = structuredClone(discoveryProcessModule);
  const node = broken.flow.nodes.find(candidate =>
    candidate.kind === 'production-cell' && candidate.cellDefinition);
  assert.ok(node);
  node.cellDefinition.author.skillRef = 'missing-profile';
  const validation = validateProcessModuleDefinition(broken);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /missing author execution profile/);
});

test('development planner pins its exact executable payload contract', () => {
  const node = developmentProcessModule.flow.nodes.find(candidate =>
    candidate.id === 'plan-task-graph');
  assert.ok(node?.cellDefinition);
  const contract = node.cellDefinition.productContracts[0].payloadContract;
  assert.equal(contract?.contractId, 'development.task-graph-proposal-payload.v1');
  assert.equal(contract?.version, '1.0.0');
  assert.match(contract?.contractDigest ?? '', /^[0-9a-f]{64}$/);
});

test('formalization artifact writers delegate acceptance to the common kernel gate', () => {
  const profiles = new Map(formalizationProcessModule.executionProfiles.map(profile =>
    [profile.id, profile]));
  const cells = formalizationProcessModule.flow.nodes.filter(node =>
    node.kind === 'production-cell' && node.cellDefinition);
  assert.ok(cells.length > 0);
  for (const node of cells) {
    const profile = profiles.get(node.cellDefinition.author.skillRef);
    assert.ok(profile, node.id);
    assert.equal(
      profile.artifactAcceptanceAuthority,
      'kernel-gate',
      profile.id,
    );
    assert.ok(node.cellDefinition.review, `${node.id} must declare an independent reviewer`);
    assert.ok(
      profiles.has(node.cellDefinition.review.reviewer.skillRef),
      `${node.id} reviewer profile must exist`,
    );
  }
  assert.equal(
    cells.find(node => node.id === 'define-architecture-contract')
      .cellDefinition.review.reviewer.skillRef,
    'formalization-architecture-reviewer',
  );
  assert.equal(
    profiles.get('formalization-architecture-reviewer').semanticSkill,
    'saga-architecture-reviewer',
  );
});

test('formalization document authors use structured file tools, never a shell', () => {
  const profiles = new Map(formalizationProcessModule.executionProfiles.map(profile =>
    [profile.id, profile]));
  const cells = formalizationProcessModule.flow.nodes.filter(node =>
    node.kind === 'production-cell' && node.cellDefinition);

  for (const node of cells) {
    const profile = profiles.get(node.cellDefinition.author.skillRef);
    assert.ok(profile, node.id);
    assert.ok(profile.allowedTools.includes('Write'), `${profile.id} must provide Write`);
    assert.ok(profile.allowedTools.includes('Edit'), `${profile.id} must provide Edit`);
    assert.equal(
      profile.allowedTools.includes('Bash'),
      false,
      `${profile.id} must not turn managed document production into shell quoting`,
    );
  }
});

test('development planner is a universal Production Cell with bounded semantic recovery', () => {
  const node = developmentProcessModule.flow.nodes.find(candidate =>
    candidate.id === 'plan-task-graph');
  assert.equal(node.kind, 'production-cell');
  assert.equal(node.cellDefinition.author.skillRef, 'development-task-graph-planner');
  assert.deepEqual(node.cellDefinition.recovery, { maxAttempts: 3, onExhausted: 'pause' });
  assert.equal(node.cellDefinition.transitions.accepted, 'resolve-task-graph');
});

test('validator rejects ambiguous transitions from one node on one event', () => {
  const broken = structuredClone(formalizationProcessModule);
  broken.flow.transitions.push({
    from: 'define-product-contract',
    to: 'complete-failed',
    on: 'domain.accepted',
  });
  const validation = validateProcessModuleDefinition(broken);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /ambiguous transitions/);
});

test('validator rejects an invalid inline Production Cell recovery declaration', () => {
  const broken = structuredClone(formalizationProcessModule);
  const cell = broken.flow.nodes.find(node =>
    node.kind === 'production-cell' && node.cellDefinition);
  assert.ok(cell);
  cell.cellDefinition.recovery.maxAttempts = 0;
  const validation = validateProcessModuleDefinition(broken);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /maxAttempts must be a positive integer/);
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
  // LM remains a supported generic node kind even though built-in cognitive
  // work now uses universal Production Cells. Synthesize one to isolate C2.
  const target = broken.flow.nodes.find(node => node.id === broken.flow.entryNodeId);
  assert.ok(target);
  Object.assign(target, {
    kind: 'lm',
    executionProfile: broken.executionProfiles[0].id,
    cellDefinition: undefined,
    cellDefinitionRef: undefined,
  });
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
