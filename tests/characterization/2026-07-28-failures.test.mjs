/**
 * W0-A6 — 2026-07-28 failure-class characterization fixtures.
 *
 * Plan refs: §0.3.7, §2.2, §14.1.1.
 *
 * This is a characterization test, NOT a functional test. It loads each
 * fixture manifest under tests/characterization/fixtures/2026-07-28-failures/
 * and asserts the manifest is well-formed (schema check). Where the current
 * buggy/fragile behavior can be reproduced cheaply from the live source tree
 * without running a full pipeline, it asserts that reproduction too — pinning
 * the boundary so later waves (1/2/3/4/5/9/11) can prove their fix removes
 * the symptom.
 *
 * Anti-scope (plan W00-A6): this test does NOT fix any failure, does NOT edit
 * production source, and does NOT invent evidence. Each manifest carries
 * concrete file/commit evidence gathered read-only from the frozen checkpoint.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');
const fixturesDir = path.join(
  import.meta.dirname,
  'fixtures',
  '2026-07-28-failures',
);

// --- Taxonomy enum (plan §2.2 + task file W00-A6) ----------------------------
const ROOT_CAUSE_CLASSES = new Set([
  'missing-production',
  'incomplete-provenance',
  'execution-scoped-read',
  'lost-receipt',
  'no-op-port',
  'mutable-tracker',
  'null-content-hash',
  'skill-drift',
  'retry-inconsistency',
]);

const REQUIRED_FIELDS = [
  'id',
  'symptom',
  'root_cause_class',
  'evidence',
  'reproduction',
  'expected_after_fix',
  'fixing_waves',
];

/**
 * Minimal YAML frontmatter parser for the manifest subset this lane owns:
 *   - top-level scalars  `key: value`
 *   - block scalars      `key: |` followed by indented lines
 *   - one list field     `fixing_waves:` followed by `  - "N"` items
 * No quoting/anchors/flow-collections beyond the above are supported; the
 * schema test below would catch any manifest that drifts outside the subset.
 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(match, 'manifest must start with a --- YAML frontmatter block');
  const body = match[1];
  const lines = body.split(/\r?\n/);
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i += 1; continue; }
    const scalar = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    assert.ok(scalar, `unsupported frontmatter line: ${JSON.stringify(line)}`);
    const key = scalar[1];
    const rest = scalar[2];
    if (rest === '|') {
      // Block scalar: collect following indented lines (>= 2 spaces).
      const buf = [];
      i += 1;
      while (i < lines.length && /^ {2,}\S/.test(lines[i])) {
        // Strip exactly two leading spaces (our manifests use 2-space indent).
        buf.push(lines[i].replace(/^  /, ''));
        i += 1;
      }
      data[key] = buf.join('\n');
    } else if (rest === '') {
      // List field: collect following `  - "..."` items.
      const items = [];
      i += 1;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        const itemMatch = /^\s+-\s+"(.*?)"\s*$/.exec(lines[i])
          || /^\s+-\s+'(.*?)'\s*$/.exec(lines[i])
          || /^\s+-\s+(.*?)\s*$/.exec(lines[i]);
        assert.ok(itemMatch, `unsupported list item: ${JSON.stringify(lines[i])}`);
        items.push(itemMatch[1]);
        i += 1;
      }
      data[key] = items;
    } else {
      // Plain scalar (strip surrounding quotes if present).
      data[key] = rest.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      i += 1;
    }
  }
  return data;
}

function loadManifests() {
  assert.ok(
    existsSync(fixturesDir),
    `fixtures dir missing: ${fixturesDir}`,
  );
  const files = readdirSync(fixturesDir)
    .filter(f => f.endsWith('.md'))
    .sort();
  assert.ok(
    files.length >= 9,
    `expected >=9 fixture manifests, found ${files.length}`,
  );
  return files.map((file) => {
    const fullPath = path.join(fixturesDir, file);
    const text = readFileSync(fullPath, 'utf8');
    const data = parseFrontmatter(text);
    return { file, fullPath, text, data };
  });
}

const manifests = loadManifests();

// ---------------------------------------------------------------------------
// Schema validation: every required field present, root_cause_class in the
// taxonomy enum, fixing_waves non-empty list of wave ids.
// ---------------------------------------------------------------------------
test('every fixture manifest is well-formed against the W0-A6 schema', () => {
  assert.ok(manifests.length >= 9, 'must capture all 9 plan §2.2 failure classes');
  const seenClasses = new Set();
  const seenIds = new Set();
  for (const { file, data } of manifests) {
    for (const field of REQUIRED_FIELDS) {
      assert.ok(
        data[field] !== undefined && data[field] !== null && data[field] !== '',
        `${file}: missing or empty required field '${field}'`,
      );
    }
    assert.ok(
      ROOT_CAUSE_CLASSES.has(data.root_cause_class),
      `${file}: root_cause_class '${data.root_cause_class}' not in taxonomy ${[...ROOT_CAUSE_CLASSES].join(', ')}`,
    );
    assert.ok(
      Array.isArray(data.fixing_waves) && data.fixing_waves.length > 0,
      `${file}: fixing_waves must be a non-empty list`,
    );
    for (const w of data.fixing_waves) {
      assert.ok(/^\d+$/.test(w), `${file}: fixing_waves entry '${w}' is not a numeric wave id`);
    }
    assert.ok(!seenIds.has(data.id), `${file}: duplicate fixture id '${data.id}'`);
    seenIds.add(data.id);
    seenClasses.add(data.root_cause_class);
  }
  // Every taxonomy class must be covered exactly once.
  assert.deepEqual(
    [...ROOT_CAUSE_CLASSES].sort(),
    [...seenClasses].sort(),
    'fixture set must cover every plan §2.2 failure class exactly once',
  );
});

// ---------------------------------------------------------------------------
// Reproduction of current buggy/fragile behavior — cheap static checks
// against the live source tree (no full pipeline run). These pin the
// documented boundary so a later wave's exit-gate test can assert it moved.
// ---------------------------------------------------------------------------

const readSrc = rel => readFileSync(path.join(root, rel.replaceAll('/', path.sep)), 'utf8');

test('fixture missing-brief-production: brief is a kernel side-effect projection, not a declared product', () => {
  const f = manifests.find(m => m.data.id === 'missing-brief-production');
  const install = readSrc('src/modules/discovery/application/discovery-installation.ts');
  // The fix at commit 3110770 projects the brief from the kernel.
  assert.ok(
    install.includes('ensureDiscoveryBriefArtifact'),
    'ensureDiscoveryBriefArtifact projection must be present (commit 3110770 evidence)',
  );
  // And it is wrapped in a swallowing try/catch ("convenience projection").
  assert.ok(
    /ensureDiscoveryBriefArtifact[\s\S]*?} catch/.test(install),
    'brief projection must be wrapped in a swallowing try/catch (hidden side effect)',
  );
  // The brief is NOT declared as a production in the module manifest itself.
  const moduleManifest = readSrc('src/process-modules/modules/discovery/discovery-process-module.ts');
  assert.ok(
    !/produces.*brief|brief.*produces|artifactTypes.*brief/i.test(moduleManifest),
    'precondition: brief not yet a declared manifest production (Wave 9 fixes this)',
  );
  // fixing_waves must include Wave 9 (plan §14.11.3) and a contract wave.
  assert.ok(f.data.fixing_waves.includes('9'), 'missing-brief must list Wave 9');
});

test('fixture incomplete-provenance: Production Cell provenance is complete by construction', () => {
  const f = manifests.find(m => m.data.id === 'incomplete-provenance');
  const cell = readSrc('src/process-modules/application/node-executors/production-cell-node-executor.ts');
  assert.ok(
    cell.includes('readProcessInputHash(ctx.processRunId)'),
    'process_input_hash must come from the immutable ProcessRun',
  );
  assert.ok(
    cell.includes('nodeInputHash: sha256Hex(nodeInput)'),
    'node input provenance must be canonically hashed',
  );
  const ledger = readSrc('src/process-modules/persistence/sqlite-managed-production-ledger.ts');
  assert.ok(
    ledger.includes('MANAGED_PRODUCTION_CONTEXT_INVALID'),
    'managed-production provenance fence must be present',
  );
  assert.ok(f.data.fixing_waves.includes('3'), 'incomplete-provenance must list Wave 3');
});

test('fixture execution-scoped-read: process-run fallback exists (commit 9229f14)', () => {
  const f = manifests.find(m => m.data.id === 'execution-scoped-read');
  const formalization = readSrc('src/modules/formalization/application/formalization-installation.ts');
  // The fallback method added by commit 9229f14.
  assert.ok(
    formalization.includes('listArtifactsForNodeInProcessRun'),
    'process-run fallback listArtifactsForNodeInProcessRun must be present (commit 9229f14)',
  );
  const ledger = readSrc('src/process-modules/persistence/sqlite-managed-production-ledger.ts');
  assert.ok(
    ledger.includes('listArtifactsForNodeInProcessRun'),
    'ledger must expose the process-run-scoped fallback method',
  );
  assert.ok(f.data.fixing_waves.includes('3'), 'execution-scoped-read must list Wave 3');
});

test('fixture lost-receipt: receipt is a nullable JSON blob reconstructed each walk()', () => {
  const f = manifests.find(m => m.data.id === 'lost-receipt');
  const exec = readSrc('src/process-modules/application/generic-flow-executor.ts');
  // WAVE 6 (fourth audit 2026-08-02): restoreFrame was removed; walk() now
  // calls the boundary adapter assembleFrameFromDurableNodeRuns directly,
  // which reconstructs the frame on every walk() from the durable NodeRun
  // rows. The retired symbol is forbidden by no-execution-scoped-lookup.
  assert.ok(
    exec.includes('assembleFrameFromDurableNodeRuns(context.inputPayload, allRuns)'),
    'walk() must invoke the durable boundary adapter at the top of the frame build',
  );
  assert.ok(
    !exec.includes('function restoreFrame('),
    'restoreFrame symbol must be removed (forbidden-fallback gate)',
  );
  const nodeRun = readSrc('src/process-modules/persistence/sqlite-node-run-repository.ts');
  // execution_receipt is a nullable TEXT column added by ALTER TABLE.
  assert.ok(
    /execution_receipt\s+TEXT/.test(nodeRun),
    'execution_receipt must be a nullable TEXT column',
  );
  assert.ok(
    nodeRun.includes('ALTER TABLE factory_node_runs ADD COLUMN execution_receipt'),
    'execution_receipt must be added by ALTER TABLE migration (nullable by construction)',
  );
  assert.ok(f.data.fixing_waves.includes('3'), 'lost-receipt must list Wave 3');
});

test('fixture no-op-port: composition wires declared ports to throw-stubs', () => {
  const f = manifests.find(m => m.data.id === 'no-op-port');
  const composition = readSrc('product-lifecycle-composition.mjs');
  assert.ok(
    composition.includes('notReached'),
    'composition must define notReached throw-stub',
  );
  assert.ok(
    /PRODUCT_LIFECYCLE_TEST_.*_NOT_REACHED/.test(composition),
    'composition must wire declared ports to NOT_REACHED throw-stubs',
  );
  // Delivery ports are still stubbed.
  assert.ok(
    /publication.*notReached|notReached.*publication/s.test(composition)
    && /observation.*notReached|notReached.*observation/s.test(composition),
    'delivery publication + observation ports must still be no-op stubs',
  );
  // fixing_waves includes Wave 9 or 11 (delivery/port wiring) + Wave 2 (install gate).
  const waves = f.data.fixing_waves;
  assert.ok(
    waves.includes('9') || waves.includes('11'),
    'no-op-port must list Wave 9 or 11',
  );
  assert.ok(waves.includes('2'), 'no-op-port must list Wave 2 (install-time gate)');
});

test('fixture mutable-tracker: tracker Markdown is worker-maintained, reminder is non-blocking', () => {
  const f = manifests.find(m => m.data.id === 'mutable-tracker');
  // The tracker filename template moved out of process-execution-workspace.ts
  // during the saga4 cutover. The per-node tracker is now node-stable
  // (commit c1e47d6, CGAD P18: one tracker per workplace, keyed by node not
  // task): the filename is `node-${nodeId}.md`, pinned by an endsWith
  // invariant in pinned-workspace-materializer.ts. The legacy
  // project-<x>-stage-<y>.md regex no longer matches anywhere.
  const materializer = readSrc('src/process-modules/application/pinned-workspace-materializer.ts');
  assert.ok(
    materializer.includes("node-${desk.nodeId}.md"),
    'materializer must pin a node-stable tracker filename (node-${nodeId}.md)',
  );
  const workspace = readSrc('src/process-modules/application/process-execution-workspace.ts');
  // The tracker is a per-task Markdown file written/refreshed from a template.
  assert.ok(
    workspace.includes('refreshMarkdownMachineBindings'),
    'workspace must refresh machine bindings in-place into the Markdown',
  );
  // W13-A2: the legacy tracker-reminder.mjs (C027 violation — regex Markdown
  // parsing) was DELETED and replaced by tracker-view/structured-context-hook.mjs
  // (W5-A5). The new hook reads SAGA_AGENT_ASSISTANCE_PATH (a STRUCTURED JSON
  // projection) and never parses Markdown. It is still a generic
  // additionalContext injector, NOT a context-blocker.
  const reminder = readSrc('tracker-view/structured-context-hook.mjs');
  assert.ok(
    reminder.includes('SAGA_AGENT_ASSISTANCE_PATH'),
    'replacement structured-context hook must read the env-bound assistance path',
  );
  // Reminder is a generic additionalContext injector, NOT a context-blocker.
  assert.ok(
    reminder.includes('additionalContext'),
    'reminder must inject a generic additionalContext (non-blocking PostToolUse)',
  );
  assert.ok(
    f.data.fixing_waves.includes('5') || f.data.fixing_waves.includes('4'),
    'mutable-tracker must list Wave 4 or 5',
  );
});

test('fixture null-content-hash: schema column is nullable + index uses COALESCE', () => {
  const f = manifests.find(m => m.data.id === 'null-content-hash');
  const ledger = readSrc('src/process-modules/persistence/sqlite-managed-production-ledger.ts');
  // Column declared nullable (no NOT NULL).
  assert.ok(
    /content_hash\s+TEXT[,\n]/.test(ledger) && !/content_hash\s+TEXT\s+NOT\s+NULL/.test(ledger),
    'content_hash must be declared nullable TEXT',
  );
  // The unique-exact index tolerates NULL via COALESCE.
  assert.ok(
    ledger.includes('COALESCE(content_hash, ') || ledger.includes('COALESCE(content_hash,'),
    'exact-replay index must collapse NULL via COALESCE',
  );
  // Row type propagates null into the read model.
  assert.ok(
    ledger.includes('content_hash: string | null'),
    'row type must propagate content_hash as nullable',
  );
  // Discovery runtime documents the failure mode.
  const discovery = readSrc('src/modules/discovery/infrastructure/sqlite-discovery-runtime.ts');
  assert.ok(
    discovery.includes('NULL content_hash') || discovery.includes('NULL project_repository_id and NULL content_hash'),
    'discovery runtime must document the NULL content_hash failure mode',
  );
  assert.ok(f.data.fixing_waves.includes('3'), 'null-content-hash must list Wave 3');
});

test('fixture skill-drift: profile.semanticSkill overrides reviewer assignment', () => {
  const f = manifests.find(m => m.data.id === 'skill-drift');
  const runner = readSrc('tracker-view/claude-runner.mjs');
  // W5-A6 (commit d8c5d82, §13.18 fix: reviewer skill wins): the precedence
  // chain now starts with the launch-picked skill so the reviewer skill can
  // override the author semantic skill. The old chain
  // `semanticSkillName ?? assignment.skill` is superseded by
  // `launchPickedSkill ?? semanticSkillName ?? assignment.skill`.
  // Regression test: execution-profile-runner-workspace-hooks.test.mjs:269.
  assert.ok(
    runner.includes('launchPickedSkill = pickLaunchSpecSkillName(launchSpec, isReview)'),
    'claude-runner must resolve the launch-picked skill name first (W5-A6 reviewer-wins)',
  );
  assert.ok(
    /effectiveSemanticSkill\s*=\s*launchPickedSkill\s*\n?\s*\?\?\s*semanticSkillName\s*\?\?\s*assignment\.skill/.test(runner),
    'claude-runner must resolve effectiveSemanticSkill with launch-picked → semanticSkill → assignment precedence',
  );
  // A single semantic skill is inlined for both author and reviewer runs.
  assert.ok(
    runner.includes('--- SEMANTIC SKILL BEGIN'),
    'claude-runner must inline a single semantic skill section for every run',
  );
  assert.ok(f.data.fixing_waves.includes('5') || f.data.fixing_waves.includes('1'),
    'skill-drift must list Wave 1 or 5');
});

test('fixture retry-inconsistency: retryOn/backoff declared but never read at runtime', () => {
  const f = manifests.find(m => m.data.id === 'retry-inconsistency');
  const domain = readSrc('src/process-modules/domain/process-module.ts');
  assert.ok(
    domain.includes("backoff: 'none' | 'fixed' | 'exponential'") && domain.includes('retryOn:'),
    'RetryPolicyDefinition must declare retryOn + backoff',
  );
  // Modules declare non-trivial values.
  const formalization = readSrc('src/process-modules/modules/formalization/formalization-process-module.ts');
  assert.ok(
    formalization.includes("backoff: 'fixed'") || formalization.includes("retryOn:"),
    'a production module must declare non-trivial retryOn/backoff values',
  );
  // The application layer reads ONLY maxAttempts.
  const exec = readSrc('src/process-modules/application/generic-flow-executor.ts');
  assert.ok(
    exec.includes('policy.maxAttempts') && !exec.includes('.retryOn') && !/\.backoff/.test(exec),
    'generic-flow-executor must read maxAttempts but never retryOn/backoff',
  );
  // fixing_waves includes Wave 4 (real semantics) or Wave 2 (install reject).
  const waves = f.data.fixing_waves;
  assert.ok(
    waves.includes('4') || waves.includes('2'),
    'retry-inconsistency must list Wave 4 or Wave 2',
  );
});

// ---------------------------------------------------------------------------
// Coverage sanity: the nine expected ids are all present.
// ---------------------------------------------------------------------------
test('the nine plan §2.2 failure-class ids are all captured', () => {
  const ids = new Set(manifests.map(m => m.data.id));
  const expected = new Set([
    'missing-brief-production',
    'incomplete-provenance',
    'execution-scoped-read',
    'lost-receipt',
    'no-op-port',
    'mutable-tracker',
    'null-content-hash',
    'skill-drift',
    'retry-inconsistency',
  ]);
  assert.deepEqual([...expected].sort(), [...ids].sort(),
    'fixture set ids must match the plan §2.2 taxonomy exactly');
});
