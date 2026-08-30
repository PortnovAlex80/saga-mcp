// The artifact wiki: material as a readable, addressable, EDITABLE artifact.
// Editing is not a second mechanism — the operator submits material like any
// worker, and the gate re-decides over the accumulated desk.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-artifacts-'));
process.env.DB_PATH = path.join(dir, 'artifacts.db');
const REPO = path.join(dir, 'product-repo');

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph } = await import('../dist/kernel/runner.js');
const { runArtifacts, artifactBody, latestPublished, publishedFiles } = await import('../dist/kernel/artifacts.js');
const { projectRun } = await import('../dist/kernel/projection.js');
const { submitOperatorMaterial } = await import('../dist/operator.js');
const { getEvents } = await import('../dist/events.js');

const db = getDb();
const eventsOf = (runId, type) => getEvents(db, runId).filter((e) => e.type === type);

function publishGraph(text, checks) {
  return JSON.stringify({
    nodes: {
      source: { type: 'emit', parameters: { items: [{ json: { text } }] } },
      quality: { type: 'gate', parameters: { checks, max_repairs: 0, repair_target: 'source' } },
      publish: {
        type: 'effect',
        parameters: {
          mode: 'git',
          repo: REPO,
          branch: 'main',
          message: 'discovery: brief',
          files: [{ path: 'discovery/brief.md', field: 'text' }],
        },
      },
    },
    connections: {
      source: { main: [[{ node: 'quality' }]] },
      quality: { main: [[{ node: 'publish' }]] },
    },
  });
}

test('accepted material is an artifact with a repo path, a digest and a body', () => {
  const run = runGraph(db, publishGraph('# Бриф\n\nСуть продукта: счётчик.', [
    { op: 'nonempty', field: 'text' },
    { op: 'regex', field: 'text', pattern: 'Суть продукта' },
  ]), { name: 'artifact-happy' });
  // the git effect is an activity: the run waits for a worker, the artifact exists already
  assert.equal(run.stop, 'waiting');

  const artifacts = runArtifacts(db, run.runId);
  const brief = artifacts.find((a) => a.node_id === 'source');
  assert.ok(brief, 'the author node produced an artifact');
  assert.equal(brief.path, 'discovery/brief.md', 'path comes from the downstream effect declaration');
  assert.equal(brief.kind, 'markdown');
  assert.equal(brief.accepted, true, 'a gate sealed it into an accepted revision');

  const body = artifactBody(db, run.runId, 'source', brief.digest, 0);
  assert.match(body.body, /Суть продукта/);
  assert.equal(body.items.length, 1);

  // What the effect WOULD write, byte for byte, without touching the filesystem.
  const files = publishedFiles(db, projectRun(db, run.runId));
  assert.equal(files[0].path, 'discovery/brief.md');
  assert.match(files[0].content, /Суть продукта/);

  const published = latestPublished(db, 'discovery/brief.md', { repo: REPO });
  assert.ok(published, 'the next workshop can take this material by digest');
  assert.match(published.content, /Суть продукта/);
  assert.equal(latestPublished(db, 'discovery/brief.md', { repo: path.join(dir, 'other-product') }), undefined,
    'material never leaks between products');
});

test('operator edits the artifact: the gate re-decides and the run continues', () => {
  const run = runGraph(db, JSON.stringify({
    nodes: {
      source: { type: 'emit', parameters: { items: [{ json: { text: 'бриф без критериев' } }] } },
      quality: {
        type: 'gate',
        parameters: {
          checks: [{ op: 'regex', field: 'text', pattern: 'Критерий готовности' }],
          max_repairs: 0,
          repair_target: 'source',
        },
      },
      next: { type: 'template', parameters: { template: 'SRS по: {{text}}' } },
    },
    connections: {
      source: { main: [[{ node: 'quality' }]] },
      quality: { main: [[{ node: 'next' }]] },
    },
  }), { name: 'artifact-edit' });
  assert.equal(run.stop, 'waiting', 'budget exhausted → human gate');
  assert.equal(JSON.parse(eventsOf(run.runId, 'gate.decided').at(-1).payload_json).verdict, 'human_required');

  const draft = runArtifacts(db, run.runId).find((a) => a.node_id === 'source');
  assert.equal(draft.editable, true);

  const submitted = submitOperatorMaterial(
    db,
    run.runId,
    'source',
    [{ json: { text: 'бриф\nКритерий готовности: страница открывается' } }],
    'оператор дописал критерий'
  );
  assert.equal(submitted.run.status, 'success', 'the repaired desk passes the same criteria');

  const authored = eventsOf(run.runId, 'material.submitted')
    .map((event) => JSON.parse(event.payload_json))
    .filter((payload) => payload.author === 'operator');
  assert.equal(authored.length, 1, 'provenance says a human wrote exactly this material');
  assert.equal(authored[0].digest, submitted.digest);
  assert.equal(JSON.parse(eventsOf(run.runId, 'gate.decided').at(-1).payload_json).verdict, 'accepted');

  const after = runArtifacts(db, run.runId).filter((a) => a.node_id === 'source');
  assert.equal(after.length, 2, 'the desk accumulates: the draft is history, not overwritten');
  assert.equal(after.filter((a) => a.accepted).length, 2);
});

test('material violating an admission criterion is superseded, so a repair is possible at all', () => {
  const broken = 'бриф �� сломанная кодировка';
  const run = runGraph(db, publishGraph(broken, [
    { op: 'not_contains', field: 'text', value: '�' },
    { op: 'nonempty', field: 'text' },
  ]), { name: 'artifact-supersede' });
  assert.equal(run.stop, 'waiting');

  const superseded = eventsOf(run.runId, 'material.superseded');
  assert.equal(superseded.length, 1, 'the offending member left the desk with a durable reason');
  const payload = JSON.parse(superseded[0].payload_json);
  assert.equal(payload.members[0].node, 'source');
  assert.match(payload.reasons[0], /not_contains/);

  const sealed = JSON.parse(eventsOf(run.runId, 'revision.sealed')[0].payload_json);
  assert.deepEqual(sealed.members.find((m) => m.node === 'source').digests, [],
    'the sealed revision judges only what survived admission');

  // Without superseding, the accumulating desk could never be repaired: the
  // mojibake would fail not_contains forever. With it, one clean submission wins.
  const fixed = submitOperatorMaterial(
    db,
    run.runId,
    'source',
    [{ json: { text: '# Бриф\n\nчистый текст' } }],
    'оператор переписал в UTF-8'
  );
  assert.equal(JSON.parse(eventsOf(run.runId, 'gate.decided').at(-1).payload_json).verdict, 'accepted');
  assert.equal(fixed.run.stop, 'waiting', 'accepted → the publish effect is now queued');

  const live = runArtifacts(db, run.runId).filter((a) => a.node_id === 'source');
  assert.equal(live.length, 1, 'superseded material is off the desk');
  assert.match(live[0].preview, /чистый текст/);
});

test('a successful run is sealed: the operator cannot rewrite accepted material', () => {
  const run = runGraph(db, JSON.stringify({
    nodes: { only: { type: 'emit', parameters: { items: [{ json: { text: 'готово' } }] } } },
    connections: {},
  }), { name: 'artifact-sealed' });
  assert.equal(run.status, 'success');
  assert.throws(
    () => submitOperatorMaterial(db, run.runId, 'only', [{ json: { text: 'подмена' } }]),
    /RUN_SEALED/
  );
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
