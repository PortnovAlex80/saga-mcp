// @ts-check
/**
 * W0-A7 synthetic fixtures smoke test.
 *
 * Loads every synthetic module and the campaign scenario fixture and asserts
 * the required identity / flow / node / outcome fields are present. This is a
 * SHAPE test, not a behavior test: it proves the fixtures conform to the
 * documented `ProcessModuleDefinition` / `LifecycleDefinition` contract
 * surface. It must pass today and continue to pass as Wave 1 codifies the
 * typed SPI.
 *
 * Run: `node --test tests/fixtures/synthetic-modules/index.test.mjs`
 *
 * Plan ref: §0.3.8, §14.1.4, §15.11.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import lmMarketing, {
  LM_MARKETING_MODULE_REF,
  lmMarketingResourceIndex,
} from './lm-marketing/definition.mjs';
import kernelAnalytics, {
  KERNEL_ANALYTICS_MODULE_REF,
  kernelAnalyticsResourceIndex,
} from './kernel-analytics/definition.mjs';
import humanDirectorApproval, {
  HUMAN_DIRECTOR_APPROVAL_MODULE_REF,
  humanDirectorApprovalResourceIndex,
} from './human-director-approval/definition.mjs';
import externalSeo, {
  EXTERNAL_SEO_MODULE_REF,
  externalSeoResourceIndex,
} from './external-seo/definition.mjs';
import campaignScenario, {
  CAMPAIGN_TERMINAL_STATUSES,
  campaignModuleRefs,
} from '../synthetic-scenarios/campaign/definition.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Shared shape helpers
// ---------------------------------------------------------------------------

/**
 * Assert the value is a plain object (not null, not array).
 * @param {unknown} v
 * @param {string} label
 */
function assertPlainObject(v, label) {
  assert.ok(typeof v === 'object' && v !== null && !Array.isArray(v), `${label} must be a plain object`);
}

/**
 * Assert a ProcessModuleDefinition-shaped object has the required identity,
 * contract, outcome, flow, node, and kind fields.
 *
 * @param {unknown} mod
 * @param {{ name: string; version: string; kind: string; nodeKind: string; expectedOutcomes: string[]; nodeId: string }} expected
 */
function assertProcessModuleShape(mod, expected) {
  assertPlainObject(mod, 'module');
  // identity
  assertPlainObject(mod.identity, 'module.identity');
  assert.equal(mod.identity.name, expected.name, 'identity.name');
  assert.equal(mod.identity.version, expected.version, 'identity.version');
  assert.equal(mod.identity.kind, expected.kind, 'identity.kind');
  assert.equal(typeof mod.identity.displayName, 'string', 'identity.displayName is a string');
  assert.equal(typeof mod.identity.description, 'string', 'identity.description is a string');
  // contracts
  assertPlainObject(mod.inputContract, 'inputContract');
  assert.equal(typeof mod.inputContract.id, 'string', 'inputContract.id is a string');
  assertPlainObject(mod.outputContract, 'outputContract');
  assert.equal(typeof mod.outputContract.id, 'string', 'outputContract.id is a string');
  // outcomes
  assert.ok(Array.isArray(mod.outcomes) && mod.outcomes.length > 0, 'outcomes is a non-empty array');
  const codes = mod.outcomes.map((/** @type {{code:string}} */ o) => o.code);
  for (const code of expected.expectedOutcomes) {
    assert.ok(codes.includes(code), `outcome '${code}' declared`);
  }
  for (const o of mod.outcomes) {
    assert.equal(typeof o.code, 'string', 'outcome.code is a string');
    assert.equal(typeof o.description, 'string', 'outcome.description is a string');
    assert.equal(typeof o.terminal, 'boolean', 'outcome.terminal is a boolean');
  }
  // flow
  assertPlainObject(mod.flow, 'flow');
  assert.equal(typeof mod.flow.id, 'string', 'flow.id is a string');
  assert.equal(typeof mod.flow.version, 'string', 'flow.version is a string');
  assert.equal(typeof mod.flow.entryNodeId, 'string', 'flow.entryNodeId is a string');
  assert.ok(Array.isArray(mod.flow.nodes) && mod.flow.nodes.length === 1, 'flow has exactly one node');
  const node = mod.flow.nodes[0];
  assert.equal(node.id, expected.nodeId, 'node.id');
  assert.equal(node.kind, expected.nodeKind, 'node.kind');
  // artifacts / policies / invariants / executionProfiles are arrays
  for (const f of ['artifacts', 'policies', 'invariants', 'executionProfiles']) {
    assert.ok(Array.isArray(mod[f]), `${f} is an array`);
  }
}

/**
 * Assert a manifest.json round-trips against the .mjs definition for the
 * fields that matter for Wave 1 serialization tests.
 *
 * @param {string} fixtureDir  absolute path to the fixture directory
 * @param {{ name: string; version: string; kind: string; expectedOutcomes: string[] }} expected
 */
function assertManifestMatches(fixtureDir, expected) {
  const manifestPath = path.join(fixtureDir, 'manifest.json');
  assert.ok(existsSync(manifestPath), `manifest.json exists at ${manifestPath}`);
  /** @type {any} */
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.identity.name, expected.name, 'manifest.identity.name matches definition');
  assert.equal(manifest.identity.version, expected.version, 'manifest.identity.version matches definition');
  assert.equal(manifest.identity.kind, expected.kind, 'manifest.identity.kind matches definition');
  const codes = manifest.outcomes.map((/** @type {{code:string}} */ o) => o.code);
  for (const code of expected.expectedOutcomes) {
    assert.ok(codes.includes(code), `manifest declares outcome '${code}'`);
  }
  assert.ok(Array.isArray(manifest.flow?.nodes) && manifest.flow.nodes.length === 1, 'manifest flow has one node');
}

/**
 * Assert every resource-index entry resolves to a real file under the fixture
 * directory (proves module-relative resource resolution is well-formed).
 *
 * @param {string} fixtureDir
 * @param {readonly { logicalId: string; path: string; kind: string }[]} index
 */
function assertResourcesResolve(fixtureDir, index) {
  for (const entry of index) {
    const resolved = path.join(fixtureDir, entry.path);
    assert.ok(
      resolved.startsWith(fixtureDir),
      `resource '${entry.logicalId}' must not escape the fixture dir`,
    );
    assert.ok(existsSync(resolved), `resource '${entry.logicalId}' resolves at ${entry.path}`);
  }
}

// ---------------------------------------------------------------------------
// Module fixtures
// ---------------------------------------------------------------------------

test('lm-marketing: LM-node fixture has required shape', () => {
  assertProcessModuleShape(lmMarketing, {
    name: 'synthetic-lm-marketing',
    version: '0.1.0',
    kind: 'lm-marketing',
    nodeKind: 'lm',
    nodeId: 'draft-campaign',
    expectedOutcomes: ['campaign-drafted'],
  });
  // LM-specific: executionProfile reference + profile object present
  const node = lmMarketing.flow.nodes[0];
  assert.equal(node.executionProfile, 'marketing-author', 'LM node references executionProfile id');
  const profile = lmMarketing.executionProfiles.find((/** @type {{id:string}} */ p) => p.id === 'marketing-author');
  assert.ok(profile, 'executionProfile object present');
  assert.equal(profile.semanticSkill, 'skills/synthetic-marketing-skill.md', 'semanticSkill is module-relative');
  // manifest round-trip + resource resolution
  assertManifestMatches(path.join(HERE, 'lm-marketing'), {
    name: 'synthetic-lm-marketing',
    version: '0.1.0',
    kind: 'lm-marketing',
    expectedOutcomes: ['campaign-drafted'],
  });
  assertResourcesResolve(path.join(HERE, 'lm-marketing'), lmMarketingResourceIndex);
  // module ref is frozen and well-formed
  assert.equal(LM_MARKETING_MODULE_REF.name, 'synthetic-lm-marketing');
  assert.equal(LM_MARKETING_MODULE_REF.version, '0.1.0');
});

test('kernel-analytics: Kernel-node fixture has required shape', () => {
  assertProcessModuleShape(kernelAnalytics, {
    name: 'synthetic-kernel-analytics',
    version: '0.1.0',
    kind: 'kernel-analytics',
    nodeKind: 'kernel',
    nodeId: 'compute-metrics',
    expectedOutcomes: ['metrics-computed'],
  });
  // Kernel-specific: handler reference present and versioned
  const node = kernelAnalytics.flow.nodes[0];
  assert.equal(node.handler, 'analytics-compute-handler@1.0.0', 'Kernel node references exact versioned handler');
  assert.match(node.handler, /@/, 'handler ref is name@version');
  // Kernel modules have no LM execution profiles (proves kind-specific data only)
  assert.equal(kernelAnalytics.executionProfiles.length, 0, 'Kernel module has no LM execution profile');
  assertManifestMatches(path.join(HERE, 'kernel-analytics'), {
    name: 'synthetic-kernel-analytics',
    version: '0.1.0',
    kind: 'kernel-analytics',
    expectedOutcomes: ['metrics-computed'],
  });
  assertResourcesResolve(path.join(HERE, 'kernel-analytics'), kernelAnalyticsResourceIndex);
  assert.equal(KERNEL_ANALYTICS_MODULE_REF.name, 'synthetic-kernel-analytics');
});

test('human-director-approval: Human-node fixture has required shape (2 outcomes)', () => {
  assertProcessModuleShape(humanDirectorApproval, {
    name: 'synthetic-human-director-approval',
    version: '0.1.0',
    kind: 'human-approval',
    nodeKind: 'human',
    nodeId: 'director-signoff',
    expectedOutcomes: ['approved', 'rejected'],
  });
  // Human-specific: interactionContract + adapter reference (declared on node via manifest)
  const node = humanDirectorApproval.flow.nodes[0];
  assertPlainObject(node.interactionContract, 'Human node has interactionContract');
  assert.equal(typeof node.interactionContract.id, 'string', 'interactionContract.id is a string');
  // Two terminal outcomes (proves complete route table later)
  assert.equal(humanDirectorApproval.outcomes.length, 2, 'Human module declares exactly two outcomes');
  assertManifestMatches(path.join(HERE, 'human-director-approval'), {
    name: 'synthetic-human-director-approval',
    version: '0.1.0',
    kind: 'human-approval',
    expectedOutcomes: ['approved', 'rejected'],
  });
  assertResourcesResolve(path.join(HERE, 'human-director-approval'), humanDirectorApprovalResourceIndex);
  assert.equal(HUMAN_DIRECTOR_APPROVAL_MODULE_REF.name, 'synthetic-human-director-approval');
});

test('external-seo: External-node fixture has required shape', () => {
  assertProcessModuleShape(externalSeo, {
    name: 'synthetic-external-seo',
    version: '0.1.0',
    kind: 'external-seo',
    nodeKind: 'external',
    nodeId: 'fetch-ranking',
    expectedOutcomes: ['ranking-fetched'],
  });
  // External-specific: adapter reference present and versioned
  const node = externalSeo.flow.nodes[0];
  assert.equal(node.adapter, 'seo-api-adapter@1.0.0', 'External node references exact versioned adapter');
  assert.match(node.adapter, /@/, 'adapter ref is name@version');
  assertManifestMatches(path.join(HERE, 'external-seo'), {
    name: 'synthetic-external-seo',
    version: '0.1.0',
    kind: 'external-seo',
    expectedOutcomes: ['ranking-fetched'],
  });
  assertResourcesResolve(path.join(HERE, 'external-seo'), externalSeoResourceIndex);
  assert.equal(EXTERNAL_SEO_MODULE_REF.name, 'synthetic-external-seo');
});

test('All 4 module fixtures cover all 4 node kinds (lm, kernel, human, external)', () => {
  const kinds = new Set([
    lmMarketing.flow.nodes[0].kind,
    kernelAnalytics.flow.nodes[0].kind,
    humanDirectorApproval.flow.nodes[0].kind,
    externalSeo.flow.nodes[0].kind,
  ]);
  assert.deepEqual([...kinds].sort(), ['external', 'human', 'kernel', 'lm'], 'all 4 node kinds represented');
});

// ---------------------------------------------------------------------------
// Campaign scenario fixture
// ---------------------------------------------------------------------------

test('campaign: scenario has documented LifecycleDefinition shape', () => {
  assertPlainObject(campaignScenario, 'scenario');
  assertPlainObject(campaignScenario.identity, 'scenario.identity');
  assert.equal(campaignScenario.identity.name, 'synthetic-campaign', 'scenario.identity.name');
  assert.equal(campaignScenario.identity.version, '0.1.0', 'scenario.identity.version');
  assert.equal(typeof campaignScenario.identity.displayName, 'string', 'displayName');
  assert.equal(typeof campaignScenario.entryStageId, 'string', 'entryStageId is a string');
  assert.ok(Array.isArray(campaignScenario.stages) && campaignScenario.stages.length === 5, '5 stages');
  assert.ok(Array.isArray(campaignScenario.terminalStatuses), 'terminalStatuses is an array');
});

test('campaign: NO routeResolver present (proves plan §6.4)', () => {
  // The whole point of this fixture: declarative static routes only.
  assert.equal(
    'routeResolver' in campaignScenario,
    false,
    'scenario must NOT carry a routeResolver closure (plan §6.4)',
  );
  for (const stage of campaignScenario.stages) {
    assert.equal('routeResolver' in stage, false, `stage '${stage.id}' must NOT carry a routeResolver`);
    assertPlainObject(stage.outcomeRoutes, `stage '${stage.id}' has static outcomeRoutes table`);
  }
});

test('campaign: external-seo is reused across exactly two stages (proves plan §6.8)', () => {
  const seoStages = campaignScenario.stages.filter(
    (/** @type {{moduleRef: {name: string}}} */ s) => s.moduleRef.name === 'synthetic-external-seo',
  );
  assert.equal(seoStages.length, 2, 'synthetic-external-seo appears in exactly 2 stages');
  const seoStageIds = seoStages.map((/** @type {{id: string}} */ s) => s.id).sort();
  assert.deepEqual(seoStageIds, ['seo-baseline', 'seo-followup'], 'reused in seo-baseline + seo-followup');
});

test('campaign: every declared module outcome has exactly one deterministic route (proves §6.3.5/§6.9.3)', () => {
  /** @type {Record<string, { outcomes: string[] }>} */
  const moduleOutcomesByName = {
    'synthetic-lm-marketing': { outcomes: ['campaign-drafted'] },
    'synthetic-kernel-analytics': { outcomes: ['metrics-computed'] },
    'synthetic-human-director-approval': { outcomes: ['approved', 'rejected'] },
    'synthetic-external-seo': { outcomes: ['ranking-fetched'] },
  };
  for (const stage of campaignScenario.stages) {
    const expected = moduleOutcomesByName[stage.moduleRef.name];
    assert.ok(expected, `stage '${stage.id}' references a known module`);
    const routed = Object.keys(stage.outcomeRoutes).sort();
    const declared = [...expected.outcomes].sort();
    assert.deepEqual(routed, declared, `stage '${stage.id}' routes every declared outcome exactly once`);
  }
});

test('campaign: Human stage routes approved/rejected to distinct terminal statuses', () => {
  const approve = campaignScenario.stages.find((/** @type {{id:string}} */ s) => s.id === 'approve');
  assert.ok(approve, 'approve stage exists');
  assert.deepEqual(approve.outcomeRoutes.approved, { type: 'terminal', status: 'campaign-approved' });
  assert.deepEqual(approve.outcomeRoutes.rejected, { type: 'terminal', status: 'campaign-rejected' });
});

test('campaign: every stage has safe own-property input/output mappings (proves §6.9.5)', () => {
  for (const stage of campaignScenario.stages) {
    assertPlainObject(stage.inputMapping, `stage '${stage.id}' inputMapping`);
    for (const [key, expr] of Object.entries(stage.inputMapping)) {
      if (typeof expr === 'string') {
        // path: forbid prototype-polluting keys
        assert.ok(!/^__proto__|prototype|constructor(\$|\.)/.test(expr), `mapping '${stage.id}.${key}' path is safe`);
      } else if (expr && typeof expr === 'object' && 'literal' in expr) {
        // { literal: ... } — immutable declared value
      } else if (expr && typeof expr === 'object' && 'runtime' in expr) {
        // { runtime: 'projectId' | 'epicId' | 'lifecycleRunId' | 'stageId' | 'initiatedBy' }
        assert.ok(
          ['projectId', 'epicId', 'lifecycleRunId', 'stageId', 'initiatedBy'].includes(/** @type {any} */ (expr).runtime),
          `runtime field '${stage.id}.${key}' is one of the allowed immutable runtime keys`,
        );
      } else {
        assert.fail(`mapping '${stage.id}.${key}' must be string | {literal} | {runtime}`);
      }
    }
    if (stage.outputMapping) {
      assertPlainObject(stage.outputMapping, `stage '${stage.id}' outputMapping`);
    }
  }
});

test('campaign: entry stage exists, all routes target existing stages or valid terminals (proves §6.9.1/§6.9.2)', () => {
  const stageIds = new Set(campaignScenario.stages.map((/** @type {{id:string}} */ s) => s.id));
  assert.ok(stageIds.has(campaignScenario.entryStageId), 'entryStageId references an existing stage');
  for (const status of CAMPAIGN_TERMINAL_STATUSES) {
    assert.ok(campaignScenario.terminalStatuses.includes(status), `terminal status '${status}' declared`);
  }
  for (const stage of campaignScenario.stages) {
    for (const [outcome, target] of Object.entries(stage.outcomeRoutes)) {
      if (target.type === 'stage') {
        assert.ok(stageIds.has(target.stageId), `stage '${stage.id}' outcome '${outcome}' -> existing stage '${target.stageId}'`);
      } else if (target.type === 'terminal') {
        assert.ok(
          campaignScenario.terminalStatuses.includes(target.status),
          `stage '${stage.id}' outcome '${outcome}' -> declared terminal '${target.status}'`,
        );
      } else {
        assert.fail(`unknown route target type on stage '${stage.id}'`);
      }
    }
  }
});

test('campaign: scenario depends only on the 4 synthetic module public contracts (proves §6.10)', () => {
  const referenced = new Set(campaignScenario.stages.map((/** @type {{moduleRef:{name:string}}} */ s) => s.moduleRef.name));
  const known = new Set(campaignModuleRefs.map((/** @type {{name:string}} */ r) => r.name));
  for (const name of referenced) {
    assert.ok(known.has(name), `scenario references known module '${name}'`);
  }
  assert.equal(referenced.size, 4, 'scenario uses all 4 module kinds');
});

test('campaign: manifest.json renders the same shape (Wave 1 round-trip target)', () => {
  const manifestPath = path.join(HERE, '..', 'synthetic-scenarios', 'campaign', 'manifest.json');
  assert.ok(existsSync(manifestPath), `campaign manifest.json exists`);
  /** @type {any} */
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.identity.name, 'synthetic-campaign', 'manifest identity name');
  assert.equal(manifest.entryStageId, 'draft', 'manifest entryStageId');
  assert.equal(manifest.stages.length, 5, 'manifest has 5 stages');
  assert.equal(manifest.routeResolverPresent, false, 'manifest declares no routeResolver');
  const seoStages = manifest.stages.filter(
    (/** @type {{moduleRef:{name:string}}} */ s) => s.moduleRef.name === 'synthetic-external-seo',
  );
  assert.equal(seoStages.length, 2, 'manifest reuses external-seo in 2 stages');
});
