// @ts-check
/**
 * W10-A7 — `package-describe` tests.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`
 *        §1 row W10-A7, §2 exit-gate item 5, §4 (the import-list proof).
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a7.md`.
 *
 * What this file proves:
 *   1. `describePackage` projects a `ProcessModuleManifest` into a full
 *      PackageDescription covering the seven architecture views (contracts,
 *      flow, outcomes, resources, capabilities, tools, recovery) deterministically.
 *   2. `describeScenario` projects a `LifecycleScenarioManifest` into a
 *      ScenarioDescription covering the stages view + static outcome routes
 *      (no resolver surface anywhere — plan §6.4).
 *   3. Both projections are PURE: same manifest → structurally-equal description.
 *   4. Both results are canonically serializable (round-trip through
 *      canonicalJson, plan §3.5) so they can be persisted/transported.
 *   5. `describeInstallation` (Wave 2) is re-exported from this surface and
 *      still works (the single describe import path for agents).
 *   6. The §4 import-list proof: package-describe.ts depends ONLY on
 *      `installation/`, `domain/spi/`, and pure domain — never on the catalog,
 *      an existing module, the gateway, or tracker-view.
 *
 * Imports run against the COMPILED dist/ output (`node --test` resolves .mjs
 * against the repo root; production files live under `dist/...`).
 *
 * Run: `node --test tests/application/package-describe.test.mjs`
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, sha256Hex } from '../../dist/process-modules/shared/canonical-json.js';

// Wave 1 SPI — legacy adapter (wraps a definition into a manifest envelope).
const { adaptLegacyProcessModule } = await import(
  '../../dist/process-modules/domain/spi/index.js'
);

// This lane — the describe interfaces.
const {
  describePackage,
  describePackageArchitecture,
  describeScenario,
  describeInstallation,
} = await import('../../dist/application/package-describe.js');

// ---------------------------------------------------------------------------
// Fixtures: build a manifest by adapting the synthetic lm-marketing definition
// and then enriching it with optional fields (tools, capabilities, recovery).
// We import the fixture data-only (no real handlers).
// ---------------------------------------------------------------------------
const lmMarketing = (
  await import('../../tests/fixtures/synthetic-modules/lm-marketing/definition.mjs')
).default;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a ProcessModuleManifest-shaped object for the describe tests. We start
 * from the lm-marketing fixture (adapted into a manifest envelope) and splice
 * in optional fields (toolContributions, capabilityRequirements) plus a
 * recovery route so every view is non-empty.
 */
function buildManifest(overrides = {}) {
  const base = adaptLegacyProcessModule(lmMarketing);
  // The legacy adapter zeroes resourceIndex/handlerRefs; supply real-shaped
  // values so the resources/handlers views are exercised.
  const resourceIndex = [
    {
      logicalId: 'semantic-skill',
      path: 'skills/synthetic-marketing-skill.md',
      kind: 'skill',
      digest: sha256Hex({ logicalId: 'semantic-skill' }),
    },
    {
      logicalId: 'campaign-template',
      path: 'templates/campaign-draft-template.md',
      kind: 'template',
      digest: sha256Hex({ logicalId: 'campaign-template' }),
    },
  ];
  const handlerRefs = [
    {
      logicalId: 'marketing-author-handler',
      version: '1.0.0',
      digest: sha256Hex({ logicalId: 'marketing-author-handler' }),
    },
  ];
  const inputContractRef = {
    schemaId: 'synthetic.marketing.input.v1',
    version: '1.0.0',
    digest: sha256Hex({ schemaId: 'synthetic.marketing.input.v1' }),
  };
  const outputContractRef = {
    schemaId: 'synthetic.marketing.output.v1',
    version: '1.0.0',
    digest: sha256Hex({ schemaId: 'synthetic.marketing.output.v1' }),
  };
  const toolContributions = [
    {
      logicalId: 'marketing.draft_campaign',
      version: '1.0.0',
      inputContractRef,
      outputContractRef,
      handlerRef: 'marketing-author-handler@1.0.0',
      guardBindings: [{ ref: 'marketing.guard', scope: 'call' }],
      idempotency: 'none',
      sideEffect: 'write',
    },
    {
      logicalId: 'marketing.explain_draft',
      version: '1.0.0',
      inputContractRef,
      outputContractRef,
      handlerRef: 'marketing-author-handler@1.0.0',
      guardBindings: [],
      idempotency: 'idempotent',
      sideEffect: 'read',
    },
  ];
  const capabilityRequirements = [
    { ref: 'marketing.creative-engine', version: '1.0.0' },
    { ref: 'marketing.brand-voice', version: '2.0.0', optional: true },
  ];
  // A recovery route referencing existing flow node ids.
  const recovery = [
    {
      id: 'draft-repair',
      verifyNodeId: 'draft-campaign',
      repairNodeId: 'draft-campaign',
      triggerEvents: ['draft-rejected'],
      resolvedEvents: ['campaign-drafted'],
      maxAttempts: 2,
      onExhausted: 'pause',
    },
  ];
  // Rebuild the definition with a multi-kind flow + recovery + a second outcome
  // so the flow/outcomes/recovery views are non-trivial.
  const enrichedDefinition = {
    ...base.definition,
    flow: {
      ...base.definition.flow,
      nodes: [
        ...base.definition.flow.nodes,
        {
          id: 'verify-draft',
          label: 'Verify Draft',
          kind: 'kernel',
          description: 'Deterministic draft verifier.',
          handler: 'marketing-verifier@1.0.0',
          inputSchema: { id: 'synthetic.marketing.input.v1' },
          outputSchema: { id: 'synthetic.marketing.output.v1' },
          emitsOutcome: 'draft-verified',
        },
      ],
      transitions: [
        { from: 'draft-campaign', to: 'verify-draft', on: 'campaign-drafted' },
      ],
      terminalNodeIds: ['verify-draft'],
      recovery,
    },
    outcomes: [
      ...base.definition.outcomes,
      {
        code: 'draft-verified',
        description: 'The draft passed deterministic verification.',
        terminal: true,
      },
      {
        code: 'draft-rejected',
        description: 'The draft failed verification and may be repaired.',
        terminal: false,
      },
    ],
  };
  return {
    ...base,
    definition: enrichedDefinition,
    resourceIndex,
    handlerRefs,
    inputContractRef,
    outputContractRef,
    toolContributions,
    capabilityRequirements,
    ...overrides,
  };
}

/**
 * Build a LifecycleScenarioManifest-shaped object mirroring the campaign
 * fixture shape (plan §6.2). Pure data — no resolver.
 */
function buildScenarioManifest(overrides = {}) {
  const inputContractRef = {
    schemaId: 'synthetic.campaign.input.v1',
    version: '1.0.0',
    digest: sha256Hex({ schemaId: 'synthetic.campaign.input.v1' }),
  };
  const outputContractRef = {
    schemaId: 'synthetic.campaign.output.v1',
    version: '1.0.0',
    digest: sha256Hex({ schemaId: 'synthetic.campaign.output.v1' }),
  };
  const stageBindings = [
    {
      id: 'draft',
      displayName: 'Draft Campaign',
      moduleRef: { name: 'synthetic-lm-marketing', version: '0.1.0' },
      moduleSelector: { name: 'synthetic-lm-marketing', versionRange: '^0.1.0' },
      inputMapping: { brief: 'initiative.brief' },
      outputMapping: { campaignDraft: 'output.campaignDraft' },
      outcomeRoutes: { 'campaign-drafted': { type: 'stage', stageId: 'approve' } },
      entryConditions: ['root input present'],
      exitConditions: ['campaign-drafted emitted'],
    },
    {
      id: 'approve',
      displayName: 'Director Sign-off',
      moduleRef: { name: 'synthetic-human-director-approval', version: '0.1.0' },
      moduleSelector: { name: 'synthetic-human-director-approval', versionRange: '^0.1.0' },
      inputMapping: { campaignDraft: 'stages.draft.output.campaignDraft' },
      outcomeRoutes: {
        approved: { type: 'terminal', status: 'campaign-approved' },
        rejected: { type: 'terminal', status: 'campaign-rejected' },
      },
      entryConditions: ['draft output available'],
      exitConditions: ['approved or rejected'],
    },
  ];
  return {
    manifestFormatVersion: '0.1.0',
    identity: {
      name: 'synthetic-campaign',
      version: '0.1.0',
      displayName: 'Synthetic Campaign Lifecycle',
      description: 'W10-A7 test scenario fixture.',
    },
    inputContractRef,
    outputContractRef,
    entryStageId: 'draft',
    stageBindings,
    outcomeRoutes: {},
    inputMappings: {},
    outputMappings: {},
    terminalStatuses: ['campaign-approved', 'campaign-rejected'],
    scenarioPolicies: {},
    requiredModuleSelectors: [
      { name: 'synthetic-lm-marketing', versionRange: '^0.1.0' },
      { name: 'synthetic-human-director-approval', versionRange: '^0.1.0' },
    ],
    transitionBudgets: { maxTransitions: 10 },
    reentryBudgets: { maxReentries: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Package describe tests
// ---------------------------------------------------------------------------

test('describePackage projects the seven architecture views correctly', () => {
  const manifest = buildManifest();
  const desc = describePackage(manifest);

  // Identity.
  assert.equal(desc.identity.name, 'synthetic-lm-marketing');
  assert.equal(desc.identity.version, '0.1.0');
  assert.equal(desc.identity.kind, 'lm-marketing');
  assert.equal(desc.manifestFormatVersion, base0(manifest));
  assert.equal(desc.runtimeCompatibilityRange, manifest.runtimeCompatibilityRange);

  // Contracts: forwarded refs + harvested schema ids (deduped + sorted).
  // The harvested set includes node input/output schemas AND the execution
  // profile's workIntentSchema + outputSchema ids.
  assert.equal(desc.contracts.inputContractRef.schemaId, 'synthetic.marketing.input.v1');
  assert.equal(desc.contracts.outputContractRef.schemaId, 'synthetic.marketing.output.v1');
  assert.deepEqual(
    [...desc.contracts.referencedSchemaIds],
    [
      'synthetic.marketing.input.v1',
      'synthetic.marketing.output.v1',
      'synthetic.marketing.work-intent.v1',
    ],
  );

  // Flow: 2 nodes (lm + kernel), kinds deduped + sorted, 1 transition.
  assert.equal(desc.flow.flowId, manifest.definition.flow.id);
  assert.equal(desc.flow.entryNodeId, 'draft-campaign');
  assert.deepEqual([...desc.flow.terminalNodeIds], ['verify-draft']);
  assert.equal(desc.flow.nodeCount, 2);
  assert.deepEqual([...desc.flow.nodeKinds], ['kernel', 'lm']);
  assert.equal(desc.flow.transitionCount, 1);

  // Outcomes: 3 outcomes; campaign-drafted + draft-verified terminal,
  // draft-rejected non-terminal. Emitters resolved from nodes.
  assert.equal(desc.outcomes.outcomes.length, 3);
  assert.deepEqual(
    [...desc.outcomes.terminalOutcomes],
    ['campaign-drafted', 'draft-verified'],
  );
  assert.deepEqual([...desc.outcomes.nonTerminalOutcomes], ['draft-rejected']);
  // draft-verified is emitted by the verify-draft kernel node.
  const verified = desc.outcomes.outcomes.find((o) => o.code === 'draft-verified');
  assert.deepEqual([...verified.emittingNodeIds], ['verify-draft']);
  // campaign-drafted is emitted by draft-campaign.
  const drafted = desc.outcomes.outcomes.find((o) => o.code === 'campaign-drafted');
  assert.deepEqual([...drafted.emittingNodeIds], ['draft-campaign']);

  // Resources: 2 resources, grouped by kind (skill + template).
  assert.equal(desc.resources.resourceCount, 2);
  assert.deepEqual([...desc.resources.kinds], ['skill', 'template']);
  assert.deepEqual([...desc.resources.logicalIds], [
    'campaign-template',
    'semantic-skill',
  ]);
  const skillGroup = desc.resources.groups.find((g) => g.kind === 'skill');
  assert.equal(skillGroup.entries.length, 1);
  assert.equal(skillGroup.entries[0].logicalId, 'semantic-skill');

  // Handlers: 1 handler ref.
  assert.equal(desc.handlers.handlerCount, 1);
  assert.deepEqual([...desc.handlers.logicalIds], ['marketing-author-handler']);

  // Capabilities: 2 requirements, refs deduped + sorted.
  assert.equal(desc.capabilities.capabilityCount, 2);
  assert.deepEqual([...desc.capabilities.refs], [
    'marketing.brand-voice',
    'marketing.creative-engine',
  ]);

  // Tools: 2 contributions, logicalIds sorted.
  assert.equal(desc.tools.toolCount, 2);
  assert.deepEqual([...desc.tools.logicalIds], [
    'marketing.draft_campaign',
    'marketing.explain_draft',
  ]);
  const draftTool = desc.tools.tools.find((t) => t.logicalId === 'marketing.draft_campaign');
  assert.equal(draftTool.sideEffect, 'write');
  assert.equal(draftTool.idempotency, 'none');
  assert.equal(draftTool.guardCount, 1);

  // Recovery: 1 route referencing existing node ids.
  assert.equal(desc.recovery.routeCount, 1);
  assert.deepEqual([...desc.recovery.participantNodeIds], ['draft-campaign']);
  const route = desc.recovery.routes[0];
  assert.equal(route.id, 'draft-repair');
  assert.equal(route.onExhausted, 'pause');
  assert.equal(route.maxAttempts, 2);
});

function base0(manifest) {
  return manifest.manifestFormatVersion;
}

test('describePackage is a pure deterministic projection', () => {
  const manifest = buildManifest();
  const a = describePackage(manifest);
  const b = describePackage(manifest);
  assert.deepEqual(a, b, 'same manifest yields structurally-equal description');
  // sha256Hex stability across two projections.
  assert.equal(sha256Hex(a), sha256Hex(b));
});

test('describePackage result is canonically serializable (round-trips, plan §3.5)', () => {
  const manifest = buildManifest();
  const desc = describePackage(manifest);
  const json = canonicalJson(desc);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, desc, 'round-trip via JSON.parse(canonicalJson(x))');
});

test('describePackage handles an empty manifest gracefully (vacuous views)', () => {
  // A manifest with no tools/capabilities/recovery and a single node.
  const base = adaptLegacyProcessModule(lmMarketing);
  const desc = describePackage(base);
  assert.equal(desc.tools.toolCount, 0);
  assert.equal(desc.capabilities.capabilityCount, 0);
  assert.equal(desc.recovery.routeCount, 0);
  assert.equal(desc.handlers.handlerCount, 0);
  assert.equal(desc.resources.resourceCount, 0);
  // Still one outcome (campaign-drafted), one node (lm).
  assert.equal(desc.flow.nodeCount, 1);
  assert.deepEqual([...desc.flow.nodeKinds], ['lm']);
});

test('describePackageArchitecture is an alias of describePackage', () => {
  const manifest = buildManifest();
  assert.deepEqual(
    describePackageArchitecture(manifest),
    describePackage(manifest),
  );
});

test('describeInstallation is re-exported from the describe surface (Wave 2 lineage)', () => {
  // The Wave 2 describeInstallation projects a persisted installation record.
  // Confirm it is callable from the W10-A7 import surface.
  assert.equal(typeof describeInstallation, 'function');
  const manifest = adaptLegacyProcessModule(lmMarketing);
  const record = {
    id: 1,
    name: 'synthetic-lm-marketing',
    version: '0.1.0',
    packageDigest: sha256Hex({ manifest }),
    manifestSnapshot: manifest,
    storeLocation: '<root>/ab/abc',
    resourceIndex: [],
    handlerRefs: [],
    dependencyLock: {},
    status: 'active',
    installedAt: '2026-07-29T00:00:00.000Z',
  };
  const installationDesc = describeInstallation(record);
  assert.equal(installationDesc.name, 'synthetic-lm-marketing');
  assert.equal(installationDesc.flowSummary.nodeCount, 1);
});

// ---------------------------------------------------------------------------
// Scenario describe tests
// ---------------------------------------------------------------------------

test('describeScenario projects the stages view + static outcome routes', () => {
  const manifest = buildScenarioManifest();
  const desc = describeScenario(manifest);

  assert.equal(desc.identity.name, 'synthetic-campaign');
  assert.equal(desc.identity.version, '0.1.0');
  assert.equal(desc.manifestFormatVersion, '0.1.0');

  // Contracts forwarded.
  assert.equal(desc.contracts.inputContractRef.schemaId, 'synthetic.campaign.input.v1');
  assert.deepEqual([...desc.contracts.referencedSchemaIds], [
    'synthetic.campaign.input.v1',
    'synthetic.campaign.output.v1',
  ]);

  // Stages: 2 stages, entry = draft, 2 terminal statuses.
  assert.equal(desc.stages.stageCount, 2);
  assert.equal(desc.stages.entryStageId, 'draft');
  assert.deepEqual([...desc.stages.terminalStatuses], [
    'campaign-approved',
    'campaign-rejected',
  ]);

  // Each stage carries its module selector + routed outcomes.
  const draft = desc.stages.stages.find((s) => s.id === 'draft');
  assert.equal(draft.moduleName, 'synthetic-lm-marketing');
  assert.equal(draft.moduleVersionRange, '^0.1.0');
  assert.deepEqual([...draft.routedOutcomes], ['campaign-drafted']);
  assert.deepEqual([...draft.inputMappingKeys], ['brief']);

  const approve = desc.stages.stages.find((s) => s.id === 'approve');
  assert.deepEqual([...approve.routedOutcomes], ['approved', 'rejected']);

  // Required module names deduped + sorted.
  assert.deepEqual([...desc.stages.requiredModuleNames], [
    'synthetic-human-director-approval',
    'synthetic-lm-marketing',
  ]);

  // Scenario-level outcomeRoutes is empty here (per-stage routes carry them).
  assert.deepEqual(desc.stages.outcomeRoutes, {});
});

test('describeScenario projects scenario-level outcome routes when present', () => {
  const manifest = buildScenarioManifest({
    outcomeRoutes: {
      completed: { type: 'terminal', status: 'campaign-approved' },
      retry: { type: 'stage', stageId: 'draft' },
    },
  });
  const desc = describeScenario(manifest);
  assert.deepEqual(desc.stages.outcomeRoutes, {
    completed: { type: 'terminal', target: 'campaign-approved' },
    retry: { type: 'stage', target: 'draft' },
  });
});

test('describeScenario is a pure deterministic projection', () => {
  const manifest = buildScenarioManifest();
  const a = describeScenario(manifest);
  const b = describeScenario(manifest);
  assert.deepEqual(a, b, 'same scenario manifest yields structurally-equal description');
  assert.equal(sha256Hex(a), sha256Hex(b));
});

test('describeScenario result is canonically serializable (round-trips, plan §3.5)', () => {
  const manifest = buildScenarioManifest();
  const desc = describeScenario(manifest);
  const json = canonicalJson(desc);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, desc, 'round-trip via JSON.parse(canonicalJson(x))');
});

// ---------------------------------------------------------------------------
// §4 import-list proof (WAVE10-EXTENSIBILITY-SPEC §4).
//
// The describe interfaces MUST depend only on installation/, domain/spi/, and
// pure domain — never on the catalog, an existing module, the gateway, or
// tracker-view. We assert this statically by scanning the source file's
// relative imports and confirming every resolved target lives in the allowed
// set. This mirrors the W10-A8 proof test's import-list assertion.
// ---------------------------------------------------------------------------

test('§4 import-list proof: package-describe.ts imports only allowed surfaces', () => {
  const __filename2 = fileURLToPath(import.meta.url);
  const __dirname2 = path.dirname(__filename2);
  const REPO_ROOT = path.resolve(__dirname2, '..', '..');
  const source = readFileSync(
    path.join(REPO_ROOT, 'src/application/package-describe.ts'),
    'utf8',
  );

  // Extract every relative import specifier.
  const specRe = /(?:^|\n)[ \t]*(?:import|export)[^;]*?\bfrom\s*['"]([.][./][^'"]+)['"]/g;
  const specs = [];
  let m;
  while ((m = specRe.exec(source)) !== null) specs.push(m[1]);

  // Resolve each to a repo-relative POSIX path (best-effort: map the .js spec
  // to the .ts source the scanner would resolve).
  function resolve(spec) {
    const base = path.resolve(REPO_ROOT, 'src/application', spec);
    const jsToTs = base.replace(/\.js$/, '.ts');
    const rel = path.relative(REPO_ROOT, jsToTs).split(path.sep).join('/');
    return rel;
  }
  const resolved = specs.map(resolve);

  // Allowed prefixes (WAVE10-EXTENSIBILITY-SPEC §4).
  const ALLOWED = [
    'src/process-modules/installation/',
    'src/process-modules/domain/spi/',
    'src/process-modules/domain/process-module.ts',
  ];
  const forbidden = resolved.filter((p) => !ALLOWED.some((a) => p.startsWith(a)));
  assert.deepEqual(
    forbidden,
    [],
    'package-describe.ts must import only from installation/, domain/spi/, or pure domain. ' +
      'Forbidden imports found: ' +
      JSON.stringify(forbidden),
  );

  // Explicitly MUST NOT touch any of these (§4 proof).
  const FORBIDDEN_SUBSTRINGS = [
    'modules/catalog.ts',
    'modules/installations.ts',
    'modules/discovery/',
    'modules/formalization/',
    'modules/development/',
    'modules/delivery/',
    'src/index.ts',
    'tracker-view/',
    'composition/',
  ];
  for (const f of resolved) {
    for (const bad of FORBIDDEN_SUBSTRINGS) {
      assert.ok(
        !f.includes(bad),
        `package-describe.ts must not import ${bad} (got ${f})`,
      );
    }
  }
});
