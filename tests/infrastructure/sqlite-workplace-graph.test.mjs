import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { createSqliteProductionCellProjectionPersistence } from
  '../../dist/infrastructure/workplace/sqlite-production-cell-projection-persistence.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects(id,name,status) VALUES (1,'p','active')").run();
  db.prepare(
    "INSERT INTO epics(id,project_id,name,status,priority) VALUES (1,1,'e','planned','high')",
  ).run();
  const items = ['a', 'b', 'c'].map((itemId, ordinal) => {
    const workplaceRef = `workplace/7/test@1/cell/${itemId}`;
    db.prepare(
      `INSERT INTO factory_workplaces
         (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
          kanban_phase,loop_state,next_role,revision)
       VALUES (?,7,'test@1','cell',?,'todo','idle','author',0)`,
    ).run(workplaceRef, itemId);
    const task = db.prepare(
      `INSERT INTO tasks
         (epic_id,title,status,priority,task_kind,workflow_stage,execution_skill,
          execution_mode,generation_key,tags,metadata,workplace_ref)
       VALUES (1,?,'todo','high','test','test','test','tracker_only',?,'[]','{}',?)`,
    ).run(itemId, `g:${itemId}`, workplaceRef);
    return {
      ordinal,
      itemId,
      workplaceRef,
      taskId: Number(task.lastInsertRowid),
    };
  });
  return { db, items };
}

function graphInput(items) {
  const dependencies = {
    a: [],
    b: ['a'],
    c: ['a', 'b'],
  };
  const byId = new Map(items.map(item => [item.itemId, item]));
  const graphItems = items.map(item => ({
    ...item,
    dependencyItemIds: dependencies[item.itemId],
    dependencyWorkplaceRefs: dependencies[item.itemId].map(id => byId.get(id).workplaceRef),
    dependencyTaskIds: dependencies[item.itemId].map(id => byId.get(id).taskId),
  }));
  const graphDigest = sha256Hex({
    productionCellId: 'cell',
    items: graphItems.map(item => ({
      ordinal: item.ordinal,
      itemId: item.itemId,
      workplaceRef: item.workplaceRef,
      taskId: item.taskId,
      dependencyItemIds: item.dependencyItemIds,
      dependencyWorkplaceRefs: item.dependencyWorkplaceRefs,
      dependencyTaskIds: item.dependencyTaskIds,
    })),
  });
  return {
    graphRef: `workplace-graph:${graphDigest}`,
    graphDigest,
    processRunId: 7,
    moduleRef: 'test@1',
    productionCellId: 'cell',
    sealedAt: '2026-08-09T00:00:00.000Z',
    items: graphItems,
  };
}

test('sealed Workplace graph is immutable and task edges remain a full projection', () => {
  const { db, items } = fixture();
  const persistence = createSqliteProductionCellProjectionPersistence(db);
  const input = graphInput(items);

  persistence.sealWorkplaceGraph(input);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM factory_workplace_graphs').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM factory_workplace_graph_items').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM factory_workplace_dependencies').get().n, 3);
  assert.deepEqual(
    db.prepare(
      'SELECT task_id,depends_on_task_id FROM task_dependencies ORDER BY task_id,depends_on_task_id',
    ).all(),
    [
      { task_id: items[1].taskId, depends_on_task_id: items[0].taskId },
      { task_id: items[2].taskId, depends_on_task_id: items[0].taskId },
      { task_id: items[2].taskId, depends_on_task_id: items[1].taskId },
    ],
  );

  db.prepare("UPDATE tasks SET status='done'").run();
  db.prepare('DELETE FROM task_dependencies').run();
  persistence.sealWorkplaceGraph(input);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_dependencies').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM factory_workplace_dependencies').get().n, 3);

  const changed = {
    ...input,
    graphDigest: sha256Hex('changed'),
    graphRef: `workplace-graph:${sha256Hex('changed')}`,
  };
  assert.throws(
    () => persistence.sealWorkplaceGraph(changed),
    /PRODUCTION_CELL_GRAPH_DIGEST_INVALID/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM factory_workplace_dependencies').run(),
    /immutable/,
  );
  assert.throws(
    () => db.prepare("UPDATE factory_workplace_graphs SET graph_digest='bad'").run(),
    /immutable/,
  );
  db.close();
});
