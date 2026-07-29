// @ts-check
/**
 * W5-A1 — `buildWorkspaceProjection` conformance tests.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE5-WORKSPACE-TRACKER-SPEC.md`
 *        §1 (W5-A1 lane), §3 exit-gate item 1, §0 key findings.
 * Task: `docs/refactor-management/05-subagent-tasks/W05-a1.md`.
 *
 * What this file proves:
 *   1. Skills/templates/checklists are resolved from the PINNED installation
 *      record (via `getById` on the registry), NOT a global skill root — two
 *      different pinned records with the same `nodeId`/`profile` yield
 *      different `absolutePath`s because `storeLocation` differs (W5-A1 core
 *      invariant).
 *   2. Node-scoped skill resolution: the LM node's `executionProfile`
 *      selects the execution + reviewer skill resources (reviewer resolved
 *      SEPARATELY, plan §13.18 — not as an alias of the execution skill).
 *   3. Resource partitioning: templates (incl. mcp-call-template), checklists,
 *      instructions are split into named slots; `allResources` keeps the full
 *      set for diagnostics.
 *   4. Absolute paths are POSIX-joined under `storeLocation` and reject
 *      traversal/absolute resource paths (defense in depth).
 *   5. Error surface: not-found id, non-active status, unknown node, non-LM
 *      node, and missing execution profile each throw the documented code.
 *   6. Purity: same inputs → structurally-equal projection (determinism).
 *
 * Anti-scope:
 *   - No filesystem, no DB, no real package store. The registry is an
 *     in-memory fake implementing the `WorkspacePackageRegistry` intersection
 *     (`select`/`has`/`listSelectors`/`getById`). Production wires a real
 *     `InstallationBasedPackageRegistry` + `SqliteModuleInstallationRepository`
 *     at the composition root (Wave 11) — that wiring is W5-A6's job.
 *   - No byte materialization (copying skill files into a workspace) — that is
 *     `process-execution-workspace.ts` + W5-A6. This lane is the PROJECTION.
 *
 * Imports run against the COMPILED dist/ output (production files live under
 * `dist/process-modules/...`).
 *
 * Run: `node --test tests/process-modules/workspace-projection.test.mjs`
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Hex } from '../../dist/process-modules/shared/canonical-json.js';

// Wave 1 SPI — legacy adapter (wraps a definition into a manifest envelope).
const { adaptLegacyProcessModule } = await import(
  '../../dist/process-modules/domain/spi/index.js'
);

// This lane — buildWorkspaceProjection + error codes.
const {
  buildWorkspaceProjection,
  WorkspaceProjectionError,
  WORKSPACE_INSTALLATION_NOT_FOUND,
  WORKSPACE_INSTALLATION_NOT_ACTIVE,
  WORKSPACE_NODE_NOT_FOUND,
  WORKSPACE_NODE_NOT_LM,
  WORKSPACE_PROFILE_NOT_FOUND,
} = await import(
  '../../dist/process-modules/application/workspace-projection.js'
);

// ---------------------------------------------------------------------------
// Fixture: an LM-node ProcessModuleDefinition with a package-declared skill,
// reviewer-skill, templates, a checklist, an instruction, and a schema.
// ---------------------------------------------------------------------------

const MODULE_NAME = 'synthetic-workspace-demo';
const MODULE_VERSION = '1.4.2';
const INPUT_SCHEMA = 'synthetic.workspace.input.v1';
const OUTPUT_SCHEMA = 'synthetic.workspace.output.v1';

/** The execution skill the package ships (kind:'skill'). */
const EXECUTION_SKILL_NAME = 'saga-product';
/** The independent reviewer skill the package ships (kind:'reviewer-skill'). */
const REVIEWER_SKILL_NAME = 'saga-requirements-reviewer';
/** Shared execution protocol, intentionally classified as an instruction. */
const PROTOCOL_SKILL_NAME = 'saga-process-module-worker-protocol';

/**
 * @typedef {import('../../src/process-modules/domain/spi/resource-index.ts').ResourceIndexEntry} ResourceIndexEntry
 */

/**
 * The package-declared resource index. Each entry maps to a module-relative
 * path under the installation's content-addressed store location.
 *
 * @type {ReadonlyArray<ResourceIndexEntry>}
 */
const RESOURCE_INDEX = Object.freeze([
  { logicalId: EXECUTION_SKILL_NAME, path: `skills/${EXECUTION_SKILL_NAME}.md`, kind: 'skill', digest: sha256Hex({ id: EXECUTION_SKILL_NAME }) },
  { logicalId: REVIEWER_SKILL_NAME, path: `skills/${REVIEWER_SKILL_NAME}.md`, kind: 'reviewer-skill', digest: sha256Hex({ id: REVIEWER_SKILL_NAME }) },
  { logicalId: 'workspace-template', path: 'templates/tracker.md', kind: 'template', digest: sha256Hex({ id: 'workspace-template' }) },
  { logicalId: 'submit-call', path: 'templates/submit-call.json', kind: 'mcp-call-template', digest: sha256Hex({ id: 'submit-call' }) },
  { logicalId: 'verify-checklist', path: 'checklists/verify.md', kind: 'checklist', digest: sha256Hex({ id: 'verify-checklist' }) },
  { logicalId: 'node-instructions', path: 'instructions/prd.md', kind: 'instruction', digest: sha256Hex({ id: 'node-instructions' }) },
  {
    logicalId: 'module.instruction.process-protocol',
    path: `skills/${PROTOCOL_SKILL_NAME}/SKILL.md`,
    kind: 'instruction',
    digest: sha256Hex({ id: PROTOCOL_SKILL_NAME }),
  },
  { logicalId: 'prd-schema', path: 'schemas/prd.v1.json', kind: 'schema', digest: sha256Hex({ id: 'prd-schema' }) },
]);

/**
 * A ProcessModuleDefinition with one LM node carrying an execution profile that
 * names the package skills + a separate reviewer skill.
 */
const moduleDefinition = {
  identity: { name: MODULE_NAME, version: MODULE_VERSION, kind: 'formalization', displayName: 'Workspace Demo', description: 'W5-A1 fixture' },
  inputContract: { id: INPUT_SCHEMA },
  outputContract: { id: OUTPUT_SCHEMA },
  outcomes: [{ code: 'prd-accepted', description: '', terminal: true }],
  flow: {
    id: 'workspace-demo.flow',
    version: '1.0.0',
    entryNodeId: 'write-prd',
    nodes: [
      {
        id: 'write-prd',
        label: 'Write PRD',
        kind: 'lm',
        description: 'Author the PRD',
        executionProfile: 'formalization.product',
        inputSchema: { id: INPUT_SCHEMA },
        outputSchema: { id: OUTPUT_SCHEMA },
        emitsOutcome: 'prd-accepted',
      },
      {
        id: 'settle',
        label: 'Settle',
        kind: 'kernel',
        description: 'Kernel settlement',
        handler: 'settle-handler@1.0.0',
      },
    ],
    transitions: [{ from: 'write-prd', to: 'settle', on: 'prd-accepted' }],
    terminalNodeIds: ['settle'],
  },
  artifacts: [{ code: 'prd', description: '', acceptanceAuthority: 'kernel-gate' }],
  policies: [],
  invariants: [],
  executionProfiles: [
    {
      id: 'formalization.product',
      workIntentKind: 'formalization.product',
      workIntentSchema: { id: INPUT_SCHEMA },
      taskKind: 'formalization.prd',
      executionSkill: EXECUTION_SKILL_NAME,
      reviewSkill: REVIEWER_SKILL_NAME,
      protocolSkill: PROTOCOL_SKILL_NAME,
      semanticSkill: EXECUTION_SKILL_NAME,
      artifactAcceptanceAuthority: 'kernel-gate',
      executionMode: 'git_change',
      allowedTools: ['Read', 'Write'],
      trackerTemplate: 'templates/tracker.md',
      workspaceTemplates: ['templates/tracker.md'],
      callTemplates: ['templates/submit-call.json'],
      checklists: ['checklists/verify.md'],
      outputSchema: { id: OUTPUT_SCHEMA },
      retryPolicy: { maxAttempts: 3, backoff: 'linear' },
      recoveryPolicy: { onExhausted: 'fail', maxRounds: 1 },
    },
  ],
};

/**
 * Build a fake `ModuleInstallationRecord` from the fixture, wrapping the
 * definition via `adaptLegacyProcessModule` (Wave 1 SPI) into a manifest
 * envelope, then splicing in the resolved resource index + handler refs.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function buildRecord(overrides = {}) {
  const manifest = adaptLegacyProcessModule(moduleDefinition);
  const resourceIndex = RESOURCE_INDEX.map((r) => ({ ...r }));
  const handlerRefs = [
    { logicalId: 'settle-handler', version: '1.0.0', digest: sha256Hex({ id: 'settle-handler' }) },
  ];
  const packageDigest = sha256Hex({ manifest, resourceIndex, handlerRefs });
  return {
    id: 42,
    name: MODULE_NAME,
    version: MODULE_VERSION,
    packageDigest,
    manifestSnapshot: { ...manifest, resourceIndex: [], handlerRefs: [] },
    storeLocation: `/var/saga/packages/${packageDigest.slice(0, 2)}/${packageDigest}`,
    resourceIndex,
    handlerRefs,
    dependencyLock: { kind: 'stand-in' },
    status: 'active',
    installedAt: '2026-07-29T00:00:00.000Z',
    activatedAt: '2026-07-29T00:00:01.000Z',
    ...overrides,
  };
}

/**
 * A fake `WorkspacePackageRegistry`: an in-memory map of id → record, plus the
 * `PackageRegistry` port methods (`select`/`has`/`listSelectors`) implemented
 * minimally so the registry satisfies the structural intersection the
 * projection requires.
 *
 * @param {Array<object>} records
 */
function fakeRegistry(records) {
  const byId = new Map(records.map((r) => [Number(r.id), r]));
  const bySelector = new Map(records.map((r) => [`${r.name}@${r.version}`, r]));
  return {
    getById(id) {
      return byId.get(Number(id)) ?? null;
    },
    select(selector) {
      const key = `${selector.name}@${selector.versionRange}`;
      const rec = bySelector.get(key);
      if (!rec) {
        const err = new Error(`PACKAGE_NOT_INSTALLED: ${key}`);
        err.code = 'PACKAGE_NOT_INSTALLED';
        throw err;
      }
      return rec;
    },
    has(selector) {
      return bySelector.has(`${selector.name}@${selector.versionRange}`);
    },
    listSelectors() {
      return records.map((r) => ({ name: r.name, versionRange: r.version }));
    },
    registerInstallation(record) {
      byId.set(Number(record.id), record);
      bySelector.set(`${record.name}@${record.version}`, record);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — happy path + pinned-installation invariant.
// ---------------------------------------------------------------------------

test('buildWorkspaceProjection resolves resources from the pinned installation record', () => {
  const record = buildRecord();
  const registry = fakeRegistry([record]);
  const proj = buildWorkspaceProjection(42, 'write-prd', registry);

  // Installation identity forwarded from the pinned record.
  assert.equal(proj.installationId, 42);
  assert.equal(proj.moduleRef, `${MODULE_NAME}@${MODULE_VERSION}`);
  assert.equal(proj.packageDigest, record.packageDigest);
  assert.equal(proj.storeLocation, record.storeLocation);
  assert.equal(proj.nodeId, 'write-prd');
  assert.equal(proj.executionProfileId, 'formalization.product');

  // Execution skill resolved from the package (kind:'skill').
  assert.equal(proj.skills.executionSkillName, EXECUTION_SKILL_NAME);
  assert.equal(proj.skills.executionSkillResource?.logicalId, EXECUTION_SKILL_NAME);
  assert.equal(
    proj.skills.executionSkillResource?.relativePath,
    `skills/${EXECUTION_SKILL_NAME}.md`,
  );
  assert.equal(proj.skills.executionSkillResource?.kind, 'skill');

  // Reviewer skill resolved SEPARATELY (kind:'reviewer-skill'), not as an alias.
  assert.equal(proj.skills.reviewerSkillName, REVIEWER_SKILL_NAME);
  assert.equal(proj.skills.reviewerSkillResource?.logicalId, REVIEWER_SKILL_NAME);
  assert.equal(proj.skills.reviewerSkillResource?.kind, 'reviewer-skill');
  assert.notEqual(
    proj.skills.executionSkillResource?.logicalId,
    proj.skills.reviewerSkillResource?.logicalId,
    'reviewer skill identity differs from execution skill identity',
  );

  // The protocol profile slot resolves an instruction-classified SKILL.md.
  assert.equal(proj.skills.protocolSkillName, PROTOCOL_SKILL_NAME);
  assert.equal(
    proj.skills.protocolSkillResource?.logicalId,
    'module.instruction.process-protocol',
  );
  assert.equal(proj.skills.protocolSkillResource?.kind, 'instruction');

  // Templates include both 'template' and 'mcp-call-template'.
  const templateKinds = proj.templates.map((t) => t.kind).sort();
  assert.deepEqual(templateKinds, ['mcp-call-template', 'template']);
  assert.equal(proj.templates.length, 2);

  // Checklists partitioned.
  assert.equal(proj.checklists.length, 1);
  assert.equal(proj.checklists[0].logicalId, 'verify-checklist');

  // Instructions partitioned.
  assert.equal(proj.instructions.length, 2);
  assert.ok(
    proj.instructions.some(resource => resource.logicalId === 'node-instructions'),
  );

  // allResources keeps the full index (including schema + protocol instruction).
  assert.equal(proj.allResources.length, RESOURCE_INDEX.length);
});

test('workspace projection does not expose adapter-private package paths', () => {
  // The W5-A1 core invariant — same nodeId/profile, different pinned
  // installation → different skill bytes location. No global skill root.
  const recordA = buildRecord({ id: 1, storeLocation: '/packages/A' });
  const recordB = buildRecord({ id: 2, storeLocation: '/packages/B' });
  const registry = fakeRegistry([recordA, recordB]);

  const projA = buildWorkspaceProjection(1, 'write-prd', registry);
  const projB = buildWorkspaceProjection(2, 'write-prd', registry);

  assert.equal(
    projA.skills.executionSkillResource?.relativePath,
    'skills/saga-product.md',
  );
  assert.equal(
    projB.skills.executionSkillResource?.relativePath,
    'skills/saga-product.md',
  );
  assert.equal('absolutePath' in projA.skills.executionSkillResource, false);
  assert.equal('absolutePath' in projB.skills.executionSkillResource, false);
});

test('a skill named in the profile but NOT shipped in-package surfaces its name only', () => {
  // Built-in/global skills are not in the package resourceIndex. The name is
  // still surfaced (runner applies legacy fallback); the resource is absent.
  const record = buildRecord({
    resourceIndex: RESOURCE_INDEX.filter(
      (r) => r.logicalId !== EXECUTION_SKILL_NAME,
    ),
  });
  const registry = fakeRegistry([record]);
  const proj = buildWorkspaceProjection(42, 'write-prd', registry);

  assert.equal(proj.skills.executionSkillName, EXECUTION_SKILL_NAME, 'name surfaced');
  assert.equal(
    proj.skills.executionSkillResource,
    undefined,
    'no in-package resource for a global skill',
  );
  // Reviewer skill is still in-package.
  assert.equal(proj.skills.reviewerSkillResource?.logicalId, REVIEWER_SKILL_NAME);
});

test('buildWorkspaceProjection is a pure deterministic projection', () => {
  const record = buildRecord();
  const registry = fakeRegistry([record]);
  const a = buildWorkspaceProjection(42, 'write-prd', registry);
  const b = buildWorkspaceProjection(42, 'write-prd', registry);
  assert.deepEqual(a, b, 'same inputs → structurally-equal projection');
});

test('the description field is the W2-A7 InstallationDescription summary', () => {
  const record = buildRecord();
  const registry = fakeRegistry([record]);
  const proj = buildWorkspaceProjection(42, 'write-prd', registry);
  assert.equal(proj.description.name, MODULE_NAME);
  assert.equal(proj.description.version, MODULE_VERSION);
  assert.equal(proj.description.packageDigest, record.packageDigest);
  assert.equal(proj.description.resourceCount, RESOURCE_INDEX.length);
  // 2 flow nodes (1 lm + 1 kernel).
  assert.equal(proj.description.flowSummary.nodeCount, 2);
});

// ---------------------------------------------------------------------------
// Tests — error surface.
// ---------------------------------------------------------------------------

test('throws WORKSPACE_INSTALLATION_NOT_FOUND for an unknown pinned id', () => {
  const registry = fakeRegistry([buildRecord()]);
  assert.throws(
    () => buildWorkspaceProjection(999, 'write-prd', registry),
    (err) => err instanceof WorkspaceProjectionError
      && err.code === WORKSPACE_INSTALLATION_NOT_FOUND,
  );
});

test('allows a retired installation for exact historical pin replay', () => {
  const registry = fakeRegistry([buildRecord({ status: 'retired' })]);
  const projection = buildWorkspaceProjection(42, 'write-prd', registry);
  assert.equal(projection.installationId, 42);
});

test('buildWorkspaceProjection resolves package-local SKILL.md directory convention', () => {
  const record = buildRecord({
    resourceIndex: RESOURCE_INDEX.map(resource => {
      if (resource.logicalId === EXECUTION_SKILL_NAME) {
        return {
          ...resource,
          logicalId: 'module.skill.product',
          path: `package/resources/skills/${EXECUTION_SKILL_NAME}/SKILL.md`,
        };
      }
      if (resource.logicalId === REVIEWER_SKILL_NAME) {
        return {
          ...resource,
          logicalId: 'module.skill.requirements-reviewer',
          path: `package/resources/skills/${REVIEWER_SKILL_NAME}/SKILL.md`,
        };
      }
      return resource;
    }),
  });
  const projection = buildWorkspaceProjection(
    42,
    'write-prd',
    fakeRegistry([record]),
  );
  assert.equal(
    projection.skills.executionSkillResource?.logicalId,
    'module.skill.product',
  );
  assert.equal(
    projection.skills.reviewerSkillResource?.logicalId,
    'module.skill.requirements-reviewer',
  );
});

test('throws WORKSPACE_INSTALLATION_NOT_ACTIVE for a staged installation', () => {
  const registry = fakeRegistry([buildRecord({ status: 'staged' })]);
  assert.throws(
    () => buildWorkspaceProjection(42, 'write-prd', registry),
    (err) => err instanceof WorkspaceProjectionError
      && err.code === WORKSPACE_INSTALLATION_NOT_ACTIVE,
  );
});

test('throws WORKSPACE_NODE_NOT_FOUND for a node absent from the flow', () => {
  const registry = fakeRegistry([buildRecord()]);
  assert.throws(
    () => buildWorkspaceProjection(42, 'no-such-node', registry),
    (err) => err instanceof WorkspaceProjectionError
      && err.code === WORKSPACE_NODE_NOT_FOUND,
  );
});

test('throws WORKSPACE_NODE_NOT_LM for a kernel node (no execution profile)', () => {
  const registry = fakeRegistry([buildRecord()]);
  assert.throws(
    () => buildWorkspaceProjection(42, 'settle', registry),
    (err) => err instanceof WorkspaceProjectionError
      && err.code === WORKSPACE_NODE_NOT_LM,
  );
});

test('throws WORKSPACE_PROFILE_NOT_FOUND when the node names an undeclared profile', () => {
  // Mutate the manifest so the LM node names a profile no definition declares.
  const record = buildRecord();
  record.manifestSnapshot.definition.flow.nodes[0].executionProfile = 'ghost.profile';
  const registry = fakeRegistry([record]);
  assert.throws(
    () => buildWorkspaceProjection(42, 'write-prd', registry),
    (err) => err instanceof WorkspaceProjectionError
      && err.code === WORKSPACE_PROFILE_NOT_FOUND,
  );
});

// ---------------------------------------------------------------------------
// Tests — path safety (defense in depth).
// ---------------------------------------------------------------------------

test('rejects a corrupt manifest resource path that escapes the package root', () => {
  const record = buildRecord({
    resourceIndex: [
      ...RESOURCE_INDEX,
      { logicalId: 'evil', path: '../escape.md', kind: 'template', digest: 'x' },
    ],
  });
  const registry = fakeRegistry([record]);
  assert.throws(
    () => buildWorkspaceProjection(42, 'write-prd', registry),
    (err) => err instanceof WorkspaceProjectionError
      && /TRAVERSAL|ABSOLUTE/.test(err.code),
    'a traversal resource path must not yield a workspace',
  );
});
