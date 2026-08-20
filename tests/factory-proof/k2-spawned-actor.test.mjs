// tests/factory-proof/k2-spawned-actor.test.mjs
//
// K2-A — the first STRICT L3 proof slice (conformance-engine plan §K2):
// a real worker CHILD PROCESS spawned by the PRODUCTION runner under the
// production envelope (argv + stdin prompt + pinned cwd + per-execution
// --mcp-config + sanitized env), whose durable effects flow through the REAL
// saga MCP server. The in-process workerExecutorFactory fast lane is NOT
// composed at all — the composition root builds the production pinned worker
// factory and only the physical executable is the deterministic scripted
// child (workerSpawn seam).
//
// Scope of K2-A (honestly not claimed): one cell (discovery-proposal), happy
// path only. Repair counterfactuals, permission-denial negatives and the
// full-lifecycle strict drive arrive with K2-B..K2-D; CanonicalSpawn stays
// out of proof-claims until those land.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href);
const { bootstrapFreshHarness, driveFreshHarness } = harness;
const { HARNESS_CONCURRENCY_CEILING } = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href
);
const { buildCanonicalProofComposition, createScriptedObserver } = await import('./canonical-proof-composition.mjs');
const { createScriptedChildSpawn } = await import('./k2-spawn-override.mjs');

const PROGRAM = path.resolve(REPO_ROOT, 'tests/factory-proof/k2-program-discovery-proposal.json');

test('K2-A: a spawned strict actor completes the discovery-proposal cell through the real MCP server', async () => {
  const spawnLogDir = mkdtempSync(path.join(tmpdir(), 'k2-strict-'));
  const spawnLog = path.join(spawnLogDir, 'spawn.jsonl');
  process.env.DB_PATH = ''; // bootstrap owns the DB path
  // Declare the SAME legal backend route as production (the opencode
  // agent-proxy shim) — the pre-spawn policy forbids the claude CLI, and the
  // strict seam must not weaken that gate. The spawn override then swaps only
  // the physical executable; the route declaration stays production-legal.
  const prevReal = process.env.SAGA_REAL_CLAUDE_PATH;
  const prevClaude = process.env.SAGA_CLAUDE_PATH;
  process.env.SAGA_REAL_CLAUDE_PATH = `node ${path.resolve(REPO_ROOT, 'tools/agent-proxy/claude-shim.mjs')}`;
  process.env.SAGA_CLAUDE_PATH = process.env.SAGA_REAL_CLAUDE_PATH;

  const bootstrap = await bootstrapFreshHarness({
    repoRoot: REPO_ROOT,
    concurrencyCap: HARNESS_CONCURRENCY_CEILING,
    idea: 'K2-A strict spawned actor: the discovery-proposal cell only',
  });
  try {
    const observer = createScriptedObserver();
    const composition = buildCanonicalProofComposition({
      observer,
      repoPath: bootstrap.repoPath,
      sagaRepoRoot: bootstrap.sagaRepoRoot,
      workerSpawn: createScriptedChildSpawn({ programPath: PROGRAM, spawnLog }),
    });
    assert.equal(composition.workerExecutorFactory, undefined,
      'strict mode must NOT compose the in-process fast lane');

    const result = await driveFreshHarness({
      bootstrap,
      composition,
      scenarioConcurrencyCap: 1,
      maxCycles: 4,
      pollMs: 5,
      maxEmptyDispatchStreak: 6,
    });

    // The drive legitimately pauses: only the proposal cell has a program.
    // The strict slice asserts THAT cell, not the whole lifecycle.
    const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
    const db = getDb();
    const proposalWp = db.prepare(
      `SELECT kanban_phase, loop_state, terminal_reason FROM factory_workplaces
        WHERE production_cell_id='discovery-proposal'`,
    ).get();
    assert.ok(proposalWp, 'the discovery-proposal workplace must exist');
    assert.equal(proposalWp.kanban_phase, 'done', `proposal cell phase: ${JSON.stringify(proposalWp)}`);
    assert.equal(proposalWp.terminal_reason, 'accepted');

    // The child REALLY spawned with the production envelope.
    const spawns = readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.ok(spawns.length >= 1, 'at least one physical child spawn must be logged');
    assert.equal(spawns[0].hasMcpConfig, true, 'the envelope carries --mcp-config');

    // The durable effects went through the REAL MCP server: the per-execution
    // MCP identity env (SAGA_MANAGED_EXECUTION=1) recorded a worker_done
    // command receipt for the spawned execution.
    const receipt = db.prepare(
      `SELECT COUNT(*) AS n FROM command_receipts WHERE command_kind='worker_done'`,
    ).get();
    assert.ok(receipt.n >= 1, 'worker_done must be a durable MCP command receipt');

    // The sealed product exists through the production gate path.
    const sealed = db.prepare(
      `SELECT COUNT(*) AS n FROM factory_sealed_product_materials
        WHERE schema_id='factory.discovery-proposal.v1'`,
    ).get();
    assert.ok(sealed.n >= 1, 'the proposal product must be sealed');

    assert.equal(observer.getInvocationCount(), 0,
      'zero in-process scripted inferences — the fast lane was not composed');
    assert.equal(result.strandedActiveExecutions, 0);
  } finally {
    bootstrap.cleanup();
    rmSync(spawnLogDir, { recursive: true, force: true });
    if (prevReal === undefined) delete process.env.SAGA_REAL_CLAUDE_PATH; else process.env.SAGA_REAL_CLAUDE_PATH = prevReal;
    if (prevClaude === undefined) delete process.env.SAGA_CLAUDE_PATH; else process.env.SAGA_CLAUDE_PATH = prevClaude;
  }
});
