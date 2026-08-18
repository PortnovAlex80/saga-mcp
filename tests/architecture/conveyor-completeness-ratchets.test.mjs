/**
 * CONVEYOR §27 fitness functions for the completeness gaps closed in this pass.
 *
 * Markdown is an architectural source of truth; executable fitness functions
 * are its enforcement. Each ratchet here pins one property whose ABSENCE was
 * an observed production failure, so the same gap cannot silently reopen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { selectReplayCapsule } from '../../dist/infrastructure/replay/replay-capsule-selection.js';
import { assembleFrameFromDurableNodeRuns } from '../../dist/process-modules/application/generic-flow-executor.js';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** Source with comments stripped: a ratchet must judge code, not prose about it. */
const readCode = (path) => read(path)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// ---------------------------------------------------------------------------
// 1. The durable EffectAttempt exists (CONVEYOR §20).
// ---------------------------------------------------------------------------

test('effects carry a durable attempt with a four-valued outcome', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const table = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='factory_effect_attempts'",
  ).get();
  assert.ok(table, 'factory_effect_attempts must exist — a receipt proves only success');
  for (const outcome of ['succeeded', 'pending', 'repair_required', 'human_required', 'policy_terminal']) {
    assert.match(table.sql, new RegExp(`'${outcome}'`),
      `outcome '${outcome}' must be representable (§20 four-valued effect outcome)`);
  }
  // Attempts are evidence: they may never be rewritten.
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='factory_effect_attempts'",
  ).all().map(row => row.name);
  assert.ok(triggers.length >= 2, 'attempts must be immutable (no update, no delete)');
  db.close();
});

// ---------------------------------------------------------------------------
// 2. Replay selection is semantic, never recency (§9 / DRAGON law #1).
// ---------------------------------------------------------------------------

test('replay capsule selection never resolves by arrival order', () => {
  const aliases = [
    { capsule_ref: 'capsule:a', payload_hash: 'hash:a' },
    { capsule_ref: 'capsule:b', payload_hash: 'hash:b' },
  ];
  const forward = selectReplayCapsule('k', aliases);
  const reversed = selectReplayCapsule('k', [...aliases].reverse());
  assert.equal(forward.outcome, 'conflict');
  assert.deepEqual(forward.outcome, reversed.outcome,
    'a conflict is a property of the key, not of row order');

  const equal = [
    { capsule_ref: 'capsule:z', payload_hash: 'same' },
    { capsule_ref: 'capsule:a', payload_hash: 'same' },
  ];
  assert.deepEqual(
    selectReplayCapsule('k', equal),
    selectReplayCapsule('k', [...equal].reverse()),
    'alias resolution must be order-independent',
  );

  assert.doesNotMatch(
    readCode('src/infrastructure/replay/replay-capsule-selection.ts'),
    /capsules\[capsules\.length - 1\]/,
    'last-rowid-wins is recency-as-authority in the material path',
  );
});

// ---------------------------------------------------------------------------
// 3. Frame rehydration keys by nodeId and excludes paused rows.
//
// This is the guard that keeps a paused node from feeding its OWN partial
// manifest back as its fan-out source. It currently holds implicitly; without
// it, `resolveSourceProduction` falls through to ctx.input and workKeys derive
// from the cell's own output.
// ---------------------------------------------------------------------------

test('durable frame rehydration is keyed by nodeId and ignores paused rows', () => {
  const frame = assembleFrameFromDurableNodeRuns({ seed: true }, [
    {
      nodeId: 'resolve-task-graph', status: 'completed', event: 'runtime.completed',
      outputRef: 'graph:1', outputSchema: 's', outputHash: 'h1',
      outputBindings: { items: [{ id: 'a' }] }, executionReceipt: null,
    },
    {
      nodeId: 'implement-work-items', status: 'completed', event: 'runtime.paused',
      outputRef: 'manifest:1', outputSchema: 'm', outputHash: 'h2',
      outputBindings: { items: [{ id: 'self' }] }, executionReceipt: null,
    },
  ]);
  assert.ok(frame.productions['resolve-task-graph'],
    'a completed upstream production must be addressable by its node id');
  assert.equal(frame.productions['implement-work-items'], undefined,
    'a paused row is not a production — it must never become a fan-out source');
});

// ---------------------------------------------------------------------------
// 4. A pause states which of the two opposite waits it is (§23 / §19).
// ---------------------------------------------------------------------------

test('a production cell distinguishes an active worker from a human park', () => {
  const source = read('src/process-modules/application/node-executors/production-cell-node-executor.ts');
  assert.match(source, /kind: 'human_required'/,
    'a human park must be typed');
  assert.match(source, /kind: 'worker_active'/,
    'production in flight must be typed — it is a live owner, not a wait for a person');
});

// ---------------------------------------------------------------------------
// 5. The progress-obligation invariant stays executable, not prose (§23).
// ---------------------------------------------------------------------------

test('the progress-obligation invariant is wired into the engine, not just defined', () => {
  const runtime = read('src/app/product-lifecycle-runtime.ts');
  assert.match(runtime, /findStalledScopes/,
    'the engine must evaluate the invariant; a classifier nobody calls is prose');
  assert.match(runtime, /progress-invariant/,
    'an unhealthy scope must reach the engine log as a typed incident');
});

// ---------------------------------------------------------------------------
// 6. Idle re-entry does not mint execution attempts.
// ---------------------------------------------------------------------------

test('re-entering a paused node reuses its attempt row', () => {
  const source = read('src/process-modules/persistence/sqlite-node-run-repository.ts');
  assert.match(source, /A pause is the SAME attempt continuing/,
    'pause coalescing must remain documented at the seam that mints attempts');
  assert.match(source, /status='completed' AND event='runtime\.paused'/,
    'startV2 must recognise a resumable paused row');
});
