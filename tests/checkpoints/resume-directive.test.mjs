import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteResumeDirectiveRepository } from '../../dist/checkpoints/sqlite-resume-directive-repository.js';

test('resume directive is exact, digest-checked, and single-use', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,name) VALUES (1,'p')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (2,1,'e')").run();
  db.prepare(
    `INSERT INTO factory_adoptions
      (adoption_ref,checkpoint_ref,manifest_digest,target_project_id,target_epic_id,
       target_process_run_id,target_node_id,source_node_run_id,target_input_hash,
       authority_kind,actor,reason,receipt_json)
     VALUES ('a','c','d',1,2,3,'n',4,'input','checkpoint_import','test','why','{}')`,
  ).run();
  const result = {
    runtimeEvent: 'completed',
    receipt: {
      kind: 'task-execution', executorKind: 'lm', intentId: 5, taskId: 6,
      executionId: 'source', runtimeStatus: 'completed', replayed: false,
    },
  };
  const serialized = SqliteResumeDirectiveRepository.serializeResult(result);
  db.prepare(
    `INSERT INTO factory_resume_directives
      (directive_ref,adoption_ref,process_run_id,node_id,process_input_hash,
       package_digest,result_json,result_digest)
     VALUES ('r','a',3,'n','input','pkg',?,?)`,
  ).run(serialized.json, serialized.digest);
  const repo = new SqliteResumeDirectiveRepository(db);
  assert.throws(() => repo.peek({ processRunId: 3, nodeId: 'n', processInputHash: 'wrong', packageDigest: 'pkg' }), /INPUT_MISMATCH/);
  const adopted = repo.peek({ processRunId: 3, nodeId: 'n', processInputHash: 'input', packageDigest: 'pkg' });
  assert.ok(adopted);
  assert.equal(adopted.result.receipt.executionId, 'checkpoint-import:a');
  assert.equal(adopted.result.receipt.replayed, true);
  repo.markConsumed('r', 10);
  assert.equal(repo.peek({ processRunId: 3, nodeId: 'n', processInputHash: 'input', packageDigest: 'pkg' }), null);
  assert.throws(() => repo.markConsumed('r', 11), /ALREADY_CONSUMED/);
  db.close();
});
