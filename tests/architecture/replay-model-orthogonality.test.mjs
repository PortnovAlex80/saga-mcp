// tests/architecture/replay-model-orthogonality.test.mjs
//
// K8 commit 6 — model choice is not material identity (ADR-079 §3).
//
// Routing orthogonality, both directions:
//
//   1. BEHAVIORAL — one semantic capsule, two executions that selected
//      DIFFERENT inference routes: both claims resolve the SAME capsule,
//      each execution's selected route is left untouched, and the frozen
//      replay block carries no route-dependent coordinate.
//   2. BEHAVIORAL — the stored key material is exactly the ADR-79 field
//      set: no executor_kind, no model route, no provider. A route/model
//      coordinate smuggled into the key would make replay selection
//      model-dependent — the exact coupling this release forbids.
//   3. SOURCE-PINNED — the ReplayKeyMaterial interface declares exactly
//      the nine material coordinates (the same pin style as the K7
//      effect-input authority theorem).
//
// Composes with the theorem test's case D (miss leaves the route
// untouched); here the HIT direction and the key's field set are pinned.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindReplayToClaim } from '../../dist/infrastructure/replay/replay-claim-binder.js';
import { computeReplayKey } from '../../dist/infrastructure/replay/replay-key-material.js';
import {
  freshDb,
  seedProcessRun,
  seedExecution,
  makeTask,
  taskMetadata,
  insertCapsule,
} from '../infrastructure/lib/replay-binder-fixture.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const PKG = 'pkg-digest-stable';

const ADR79_KEY_FIELDS = Object.freeze([
  'moduleRef', 'nodeId', 'packageDigest', 'productionCellId',
  'projectId', 'role', 'semanticInputDigest', 'subjectProductionDigest',
  'workKey',
]);

function storedEnvelope(db, executionId) {
  const row = db.prepare(
    'SELECT metadata FROM worker_executions WHERE execution_id=?',
  ).get(executionId);
  return JSON.parse(row.metadata);
}

test('K8/orthogonality: one capsule resolves for two different routes and mutates neither', () => {
  const db = freshDb();
  seedProcessRun(db, 950, 7, PKG);
  const key = computeReplayKey({
    projectId: 7,
    moduleRef: 'm@1.0.0',
    nodeId: 'node-produce',
    productionCellId: 'cell-x',
    workKey: 'work-1',
    role: 'author',
    packageDigest: PKG,
    semanticInputDigest: 'a'.repeat(64),
    subjectProductionDigest: null,
  });
  const capsuleRef = `replay-capsule:${key}:p1`;
  insertCapsule(db, { capsuleRef, replayKey: key, projectId: 7, payloadHash: 'p1' });

  // Two executions of the SAME semantic work under DIFFERENT routes.
  seedExecution(db, 'exec-route-a', 71, 7);
  db.prepare(
    `UPDATE worker_executions SET metadata=?
      WHERE execution_id='exec-route-a'`,
  ).run(JSON.stringify({
    execution_context: { selected_route: 'glm-4.7', executor_kind: 'claude_cli' },
    execution_context_hash: 'seed-a',
  }));
  seedExecution(db, 'exec-route-b', 72, 7);
  db.prepare(
    `UPDATE worker_executions SET metadata=?
      WHERE execution_id='exec-route-b'`,
  ).run(JSON.stringify({
    execution_context: { selected_route: 'qwen-35b', executor_kind: 'scenario_worker' },
    execution_context_hash: 'seed-b',
  }));

  const claimA = bindReplayToClaim(db, {
    task: makeTask(71, taskMetadata(950)),
    executionId: 'exec-route-a',
    role: 'author',
  });
  const claimB = bindReplayToClaim(db, {
    task: makeTask(72, taskMetadata(950)),
    executionId: 'exec-route-b',
    role: 'author',
  });

  assert.equal(claimA.capsuleRef, capsuleRef);
  assert.equal(claimB.capsuleRef, capsuleRef,
    'material identity is route-independent: both routes resolve the same capsule');
  assert.equal(claimA.replayKey, claimB.replayKey);

  const envelopeA = storedEnvelope(db, 'exec-route-a');
  const envelopeB = storedEnvelope(db, 'exec-route-b');
  assert.equal(envelopeA.execution_context.selected_route, 'glm-4.7',
    'a HIT does not rewrite the selected route');
  assert.equal(envelopeB.execution_context.selected_route, 'qwen-35b',
    'a HIT does not rewrite the selected route');

  // The frozen replay block is route-clean: identical modulo nothing —
  // same key, same material, no route coordinate anywhere in it.
  assert.equal(envelopeA.execution_context.replay.key, key);
  assert.equal(envelopeB.execution_context.replay.key, key);
  for (const envelope of [envelopeA, envelopeB]) {
    const serialized = JSON.stringify(envelope.execution_context.replay);
    assert.ok(!/route|executor|model|provider/iu.test(serialized.replace(/work_key/gu, '')),
      `the replay block carries no routing coordinate: ${serialized}`);
  }
});

test('K8/orthogonality: the frozen key material is exactly the ADR-79 field set', () => {
  const db = freshDb();
  seedProcessRun(db, 951, 7, PKG);
  seedExecution(db, 'exec-km', 73, 7);
  bindReplayToClaim(db, {
    task: makeTask(73, taskMetadata(951)),
    executionId: 'exec-km',
    role: 'author',
  });
  const material = storedEnvelope(db, 'exec-km').execution_context.replay.key_material;
  assert.deepEqual(
    [...Object.keys(material)].sort(),
    [...ADR79_KEY_FIELDS].sort(),
    'the key material carries exactly the nine ADR-79 coordinates — no ' +
    'executor_kind, model route, or provider participates in material identity',
  );
});

test('K8/orthogonality: the ReplayKeyMaterial interface declares exactly the nine material coordinates', () => {
  const source = readFileSync(
    path.join(REPO_ROOT, 'src', 'replay', 'replay-capsule.ts'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');
  const header = /export interface ReplayKeyMaterial\s*\{/.exec(source);
  assert.ok(header, 'ReplayKeyMaterial interface found');
  const start = header.index + header[0].length;
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') depth -= 1;
    i += 1;
  }
  const body = source.slice(start, i - 1);
  const members = [];
  let baseIndent = null;
  for (const match of body.matchAll(/^([ \t]*)(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/gm)) {
    if (baseIndent === null) baseIndent = match[1];
    if (match[1] === baseIndent) members.push(match[2]);
  }
  assert.deepEqual(
    [...members].sort(),
    [...ADR79_KEY_FIELDS].sort(),
    'adding a member to ReplayKeyMaterial (especially an executor/model/' +
    'provider coordinate) makes replay selection model-dependent. ' +
    `Found: [${members.join(', ')}]`,
  );
});
