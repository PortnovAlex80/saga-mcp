// M3 quality-loop fitness: deterministic gates over sealed desk revisions,
// declarative repair budgets, operator decisions, and the ADR-053 Run-011
// partition-invariance property.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-quality-'));
process.env.DB_PATH = path.join(dir, 'quality.db');

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph, resumeRun } = await import('../dist/kernel/runner.js');
const { revisionManifest } = await import('../dist/kernel/gate.js');
const { getEvents, appendEvent } = await import('../dist/events.js');
const { putMaterial, getMaterial } = await import('../dist/materials.js');
const { resolveHumanGate, ensureHumanTask, completeHumanTask } = await import('../dist/operator.js');

const db = getDb();

function gateGraph(text, checks, maxRepairs) {
  return JSON.stringify({
    nodes: {
      source: { type: 'emit', parameters: { items: [{ json: { text } }] } },
      quality: { type: 'gate', parameters: { checks, max_repairs: maxRepairs, repair_target: 'source' } },
      after: { type: 'template', parameters: { template: 'OK {{text}}' } },
    },
    connections: {
      source: { main: [[{ node: 'quality' }]] },
      quality: { main: [[{ node: 'after' }]] },
    },
  });
}

function eventsOf(runId, type) {
  return getEvents(db, runId).filter((e) => e.type === type);
}

test('accepted gate seals a revision and the pipeline continues over its items', () => {
  const run = runGraph(db, gateGraph('hello saga', [{ op: 'contains', value: 'saga' }], 2), { name: 'gate-ok' });
  assert.equal(run.status, 'success');

  const sealed = eventsOf(run.runId, 'revision.sealed');
  assert.equal(sealed.length, 1);
  const decided = JSON.parse(eventsOf(run.runId, 'gate.decided')[0].payload_json);
  assert.equal(decided.verdict, 'accepted');
  assert.equal(decided.revision_digest, JSON.parse(sealed[0].payload_json).revision_digest);

  const gateCompleted = JSON.parse(eventsOf(run.runId, 'node.completed')
    .map((e) => e.payload_json)
    .find((p) => JSON.parse(p).node_id === 'quality'));
  assert.equal(gateCompleted.revision_digest, decided.revision_digest, 'gate output carries the revision authority');

  const after = JSON.parse(eventsOf(run.runId, 'node.completed')
    .map((e) => e.payload_json)
    .find((p) => JSON.parse(p).node_id === 'after'));
  const items = JSON.parse(getMaterial(db, after.output_digest).content);
  assert.equal(items[0].json.text, 'OK hello saga');
});

test('repair budget: repair_required → re-run → human_required, task surfaces blocked', () => {
  const run = runGraph(db, gateGraph('no marker here', [{ op: 'contains', value: 'X' }], 1), { name: 'gate-repair' });
  assert.equal(run.stop, 'waiting', 'human gate is a typed wait, not a crash');

  const verdicts = eventsOf(run.runId, 'gate.decided').map((e) => JSON.parse(e.payload_json).verdict);
  assert.deepEqual(verdicts, ['repair_required', 'human_required']);
  assert.equal(eventsOf(run.runId, 'repair.requested').length, 1);
  assert.equal(eventsOf(run.runId, 'node.completed').filter((e) => JSON.parse(e.payload_json).node_id === 'source').length, 2,
    'repair re-executed the author once');

  const taskId = ensureHumanTask(db, run.runId, 'quality', undefined);
  assert.equal(ensureHumanTask(db, run.runId, 'quality', undefined), taskId, 'task creation is idempotent');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId).status, 'blocked');
});

test('operator approve re-gates; reject fails the node and strands the run', () => {
  const running = db.prepare("SELECT id FROM runs WHERE status = 'running' AND id LIKE '%'").get();
  const runId = running.id;

  resolveHumanGate(db, runId, 'quality', 'approve', 'checked externally');
  assert.equal(resumeRun(db, runId).stop, 'waiting', 'checks still fail → human gate again');
  assert.equal(eventsOf(runId, 'gate.decided').length, 3);

  resolveHumanGate(db, runId, 'quality', 'reject', 'does not fit');
  assert.equal(resumeRun(db, runId).status, 'error');
  const failed = JSON.parse(eventsOf(runId, 'node.failed').at(-1).payload_json);
  assert.match(failed.error, /operator rejected/);
  completeHumanTask(db, runId, 'quality', 'reject');
});

test('Run 011 as integration: recovery execution joins the desk, gate accepts the union', () => {
  // Execution A produces brief+PRD; the gate demands FR — repair_required.
  const run = runGraph(db, gateGraph('brief + PRD', [{ op: 'contains', value: 'FR' }], 9), {
    name: 'run011',
    maxNodeExecutions: 1, // stop after the author, BEFORE the gate ever runs
  });
  assert.equal(run.stop, 'budget');

  // Execution B (recovery) lands FR on the same desk as a NEW execution.
  const fr = putMaterial(db, 'node_output', JSON.stringify([{ json: { text: 'FR' } }]));
  appendEvent(db, run.runId, 'node.completed', {
    node_id: 'source',
    output_digest: fr.digest,
    items_count: 1,
  });

  const resumed = resumeRun(db, run.runId);
  assert.equal(resumed.status, 'success', 'gate accepted the accumulated desk');

  const sealed = JSON.parse(eventsOf(run.runId, 'revision.sealed')[0].payload_json);
  const members = sealed.members.find((m) => m.node === 'source');
  assert.equal(members.digests.length, 2, 'revision holds BOTH executions, not the latest');
  assert.notEqual(members.digests[0], members.digests[1]);

  const manifest = JSON.parse(getMaterial(db, sealed.revision_digest).content);
  assert.deepEqual(
    manifest.members[0].digests,
    [...members.digests].sort(),
    'manifest is the canonical sorted member set'
  );
});

test('partition invariance: revision identity depends only on the member digest set', () => {
  const digests = ['d1', 'd2', 'd3', 'd4'];
  const reference = revisionManifest([{ node: 'author', digests }]);

  // seeded shuffles: any arrival order of the same members → same revision
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 20; i++) {
    const shuffled = [...digests];
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    assert.equal(revisionManifest([{ node: 'author', digests: shuffled }]), reference);
  }
  assert.equal(revisionManifest([{ node: 'author', digests: [...digests].reverse() }]), reference);
  assert.notEqual(revisionManifest([{ node: 'author', digests: ['d1', 'd2', 'd3'] }]), reference,
    'a lost member changes the revision');

  const twoNodes = revisionManifest([
    { node: 'author', digests: ['x'] },
    { node: 'reviewer', digests: ['y'] },
  ]);
  assert.equal(revisionManifest([
    { node: 'reviewer', digests: ['y'] },
    { node: 'author', digests: ['x'] },
  ]), twoNodes, 'node order is canonical');
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
