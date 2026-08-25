/**
 * plan-graph.test.mjs - the immutable planning graph authoring oracle
 * (WP-09, plan phase EK-6): complete-graph authoring, the eight typed
 * fences, immutability of the committed facts and deterministic re-authoring.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { authorPlanGraph } = await import('../../../dist/workflow-kernel/planning/plan-graph.js');
const conveyor = await import('../../../dist/workflow-kernel/planning/conveyor.js');
const { freshDatabase, observingOptions } = await import('./support.mjs');

/* ------------------------------------------------------------------ */
/* Complete-graph authoring                                            */
/* ------------------------------------------------------------------ */

test('authorPlanGraph authors deterministic command inputs in topological order with exact edges', () => {
  const facts = conveyor.factsForTopology('diamond');
  const authored = authorPlanGraph(facts);
  assert.equal('refused' in authored, false);
  assert.deepEqual(
    authored.workItems.map((item) => item.itemRef),
    ['a', 'b', 'c', 'd'],
    'topological order (dependencies first)',
  );
  for (const item of authored.workItems) {
    assert.equal(item.command.command, 'workItem.planGraph');
    assert.equal(item.command.expectedRevision, 0);
    assert.ok(item.command.idempotencyKey.startsWith(`plan:${facts.planningRef}:`));
    assert.ok(item.command.evidenceRefs.length >= 2, 'the item token and the graph token are the evidence');
  }
  assert.deepEqual(
    authored.edges,
    [
      { workItemRef: 'work-item:b', dependsOnRef: 'work-item:a' },
      { workItemRef: 'work-item:c', dependsOnRef: 'work-item:a' },
      { workItemRef: 'work-item:d', dependsOnRef: 'work-item:b' },
      { workItemRef: 'work-item:d', dependsOnRef: 'work-item:c' },
    ],
    'the exact declared diamond edges',
  );
  // Deterministic: identical facts author identical bytes.
  assert.deepEqual(JSON.stringify(authorPlanGraph(facts)), JSON.stringify(authored));
});

test('workItem.planGraph commits immutable facts: creation is the only transition, replay never re-commits', () => {
  const db = freshDatabase('ek-wp09-immutable-');
  const session = db.open();
  try {
    const options = observingOptions();
    // The capsule carries the planning inputs; import it first (public ingress).
    conveyor.ensureCommand(session, 'factoryRun.bootstrap', 'factory-run:1', 'conveyor:bootstrap', {}, options);
    conveyor.ensureCommand(session, 'factoryRun.importCapsule', 'factory-run:1', 'conveyor:import-capsule', {}, options);
    const facts = conveyor.factsForTopology('chain');
    const planned = conveyor.commitPlanGraph(session, facts);
    assert.equal('refused' in planned, false);
    assert.deepEqual(planned.committedItemIds, ['work-item:a', 'work-item:b', 'work-item:c']);
    const rows = session.db.prepare('SELECT instance_id, revision, status FROM work_item ORDER BY instance_id').all();
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.revision, 1, 'immutable planning fact: revision is frozen at 1');
      assert.equal(row.status, 'planned');
    }
    const edges = session.db.prepare('SELECT work_item_ref, depends_on_ref FROM work_item_dependency ORDER BY work_item_ref').all();
    assert.deepEqual(edges, [
      { work_item_ref: 'work-item:b', depends_on_ref: 'work-item:a' },
      { work_item_ref: 'work-item:c', depends_on_ref: 'work-item:b' },
    ]);
    // A second identical planGraph cannot commit a second fact: the creation
    // edge requires a non-existent instance, so the engine refuses typed and
    // the recorded planning key stays single (never a duplicate fact).
    const replay = session.workItem.applyCommand(
      { ...planned.authored.workItems[0].command, expectedRevision: 1 },
      { dependencyEdges: [] },
    );
    assert.equal(replay.refused, true);
    assert.equal(replay.reason, 'ILLEGAL_TRANSITION', 'duplicate creation is refused at the edge, never re-committed');
    assert.equal(session.db.prepare('SELECT COUNT (*) AS n FROM work_item').get().n, 3);
    // The append-only trigger refuses any mutation of a committed planning fact.
    assert.throws(
      () => session.db.prepare("UPDATE work_item SET status = 'todo' WHERE instance_id = 'work-item:a'").run(),
      /EK_WORK_ITEM_IMMUTABLE_PLANNING_FACT/,
    );
    assert.throws(
      () => session.db.prepare("DELETE FROM work_item_dependency WHERE work_item_ref = 'work-item:b'").run(),
      /EK_WORK_ITEM_DEPENDENCY_IMMUTABLE/,
    );
    void options;
  } finally {
    session.close();
  }
});

/* ------------------------------------------------------------------ */
/* The eight fences (each a typed refusal with an exact code)           */
/* ------------------------------------------------------------------ */

const baseFacts = () => JSON.parse(JSON.stringify(conveyor.factsForTopology('chain')));

test('fence 1: acceptance criteria alone are not a planning graph (typed INPUT_INCOMPLETE)', () => {
  const facts = baseFacts();
  facts.scopeItems = [];
  const refused = authorPlanGraph(facts);
  assert.equal(refused.refused, true);
  assert.equal(refused.code, 'PLANNING_INPUT_INCOMPLETE');
  assert.match(refused.refusal.detail, /acceptance criteria alone are not a planning graph/);
  assert.equal(refused.refusal.reason, 'MISSING_EVIDENCE');
});

test('fence 1b: missing claims or surfaces are input-incomplete even with full scope', () => {
  const noClaims = baseFacts();
  noClaims.terminalClaims = [];
  assert.equal(authorPlanGraph(noClaims).code, 'PLANNING_INPUT_INCOMPLETE');
  const noSurfaces = baseFacts();
  noSurfaces.constructionSurfaces = [];
  assert.equal(authorPlanGraph(noSurfaces).code, 'PLANNING_INPUT_INCOMPLETE');
});

test('fence 2: a foreign reference refuses the whole graph (typed FOREIGN_EVIDENCE_REF)', () => {
  const facts = baseFacts();
  facts.workItems[1].dependsOn = ['ghost-item'];
  const refused = authorPlanGraph(facts);
  assert.equal(refused.code, 'PLANNING_FOREIGN_REF');
  assert.equal(refused.refusal.reason, 'FOREIGN_EVIDENCE_REF');
  assert.match(refused.refusal.detail, /ghost-item/);
});

test('fence 3: epic scope equality - covered + explicit deferred == declared (typed SCOPE_INEQUALITY)', () => {
  // 3a: an undeclared scope drop (covered by nobody, deferred by nobody).
  const dropped = baseFacts();
  dropped.workItems = dropped.workItems.map((item) => ({ ...item, coversScope: [] }));
  const refused = authorPlanGraph(dropped);
  assert.equal(refused.code, 'PLANNING_SCOPE_INEQUALITY');
  assert.match(refused.refusal.detail, /covered \+ explicit deferred != declared scope/);
  // 3b: a scope item covered AND deferred is double-counted, not equal.
  const both = baseFacts();
  both.deferredScope.push({ scopeRef: 'scope:a', owner: 'operator', reason: 'double counted' });
  const refusedBoth = authorPlanGraph(both);
  assert.equal(refusedBoth.code, 'PLANNING_SCOPE_INEQUALITY');
  assert.match(refusedBoth.refusal.detail, /both covered and explicitly deferred/);
  // 3c: a deferral without owner or reason is not explicit.
  const noReason = baseFacts();
  noReason.workItems = noReason.workItems.map((item) => ({ ...item, coversScope: [] }));
  noReason.deferredScope.push({ scopeRef: 'scope:a', owner: '', reason: '' });
  const refusedNoReason = authorPlanGraph(noReason);
  assert.equal(refusedNoReason.code, 'PLANNING_SCOPE_INEQUALITY');
  assert.match(refusedNoReason.refusal.detail, /requires an owner and a reason/);
  // 3d: the topology fixture itself defers one scope item explicitly and passes.
  assert.equal('refused' in authorPlanGraph(baseFacts()), false);
});

test('fence 4: terminal-claim equality - owned + verifiable == required (typed CLAIM_INEQUALITY)', () => {
  const facts = baseFacts();
  facts.workItems[1].ownsClaims = [];
  facts.workItems[1].verifiesClaims = [];
  const refused = authorPlanGraph(facts);
  assert.equal(refused.code, 'PLANNING_CLAIM_INEQUALITY');
  assert.match(refused.refusal.detail, /owned \+ verifiable != required/);
  assert.match(refused.refusal.detail, /claim:b/);
});

test('fence 5: homeless surfaces, unknowns and seams refuse (typed HOMELESS_SURFACE)', () => {
  const homelessSurface = baseFacts();
  homelessSurface.workItems[0].ownsSurfaces = [];
  assert.equal(authorPlanGraph(homelessSurface).code, 'PLANNING_HOMELESS_SURFACE');
  assert.match(authorPlanGraph(homelessSurface).refusal.detail, /construction surface\(s\) without an owner/);

  const homelessUnknown = baseFacts();
  homelessUnknown.workItems[0].ownsUnknowns = [];
  const refusedUnknown = authorPlanGraph(homelessUnknown);
  assert.equal(refusedUnknown.code, 'PLANNING_HOMELESS_SURFACE');
  assert.match(refusedUnknown.refusal.detail, /open unknown\(s\) without an owner/);
  assert.match(refusedUnknown.refusal.detail, /cannot disappear/);

  const homelessSeam = baseFacts();
  homelessSeam.workItems[1].ownsSeams = [];
  const refusedSeam = authorPlanGraph(homelessSeam);
  assert.equal(refusedSeam.code, 'PLANNING_HOMELESS_SURFACE');
  assert.match(refusedSeam.refusal.detail, /integration seam\(s\) without an owner/);
});

test('fence 6: a zero-obligation work item is empty work, not a plan (typed ZERO_OBLIGATION)', () => {
  const facts = baseFacts();
  facts.workItems[1].obligations = [];
  const refused = authorPlanGraph(facts);
  assert.equal(refused.code, 'PLANNING_ZERO_OBLIGATION');
  assert.equal(refused.refusal.reason, 'EMPTY_WORK_IS_NOT_A_PROOF');
  assert.match(refused.refusal.detail, /zero obligations/);
});

test('fence 7: circular planning graphs refuse (typed GRAPH_CIRCULAR), self edges included', () => {
  const facts = baseFacts();
  facts.workItems[0].dependsOn = ['c'];
  const refused = authorPlanGraph(facts);
  assert.equal(refused.code, 'PLANNING_GRAPH_CIRCULAR');
  assert.equal(refused.refusal.reason, 'ILLEGAL_TRANSITION');

  const selfEdge = baseFacts();
  selfEdge.workItems[0].dependsOn = ['a'];
  assert.equal(authorPlanGraph(selfEdge).code, 'PLANNING_GRAPH_CIRCULAR');
});

test('fence 8: jointly unsatisfiable verification orderings refuse (typed JOINTLY_UNSATISFIABLE)', () => {
  // Item b verifies a claim owned by a but does not depend on a: the
  // verification could run before its inputs exist - no legal order exists.
  const facts = baseFacts();
  facts.workItems[1].dependsOn = [];
  facts.workItems[1].verifiesClaims = ['claim:a'];
  const refused = authorPlanGraph(facts);
  assert.equal(refused.code, 'PLANNING_JOINTLY_UNSATISFIABLE');
  assert.equal(refused.refusal.reason, 'UNIVERSE_VIOLATION');
  assert.match(refused.refusal.detail, /verification would precede production/);

  // The same shape WITH the ordering dependency authors cleanly.
  const ordered = baseFacts();
  ordered.workItems[1].verifiesClaims = ['claim:a'];
  assert.equal('refused' in authorPlanGraph(ordered), false, 'verification ordered after production is satisfiable');
});
