import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_STAGE_SEQUENCE, previousStage, stageByCondition } from './stages.mjs';

test('live stage matrix has unique condition/task pairs and an explicit productive contract', () => {
  assert.equal(LIVE_STAGE_SEQUENCE.length, 11);
  assert.equal(new Set(LIVE_STAGE_SEQUENCE.map((stage) => stage.condition)).size, LIVE_STAGE_SEQUENCE.length);
  assert.equal(new Set(LIVE_STAGE_SEQUENCE.map((stage) => stage.taskKind)).size, LIVE_STAGE_SEQUENCE.length);
  for (const stage of LIVE_STAGE_SEQUENCE) {
    assert.ok(stage.condition);
    assert.ok(stage.taskKind);
    assert.ok(stage.skillId);
    assert.ok(stage.oracleId);
    assert.ok(stage.semanticChecks.length >= 3);
    assert.equal(stageByCondition(stage.condition), stage);
  }
});

test('live stage matrix forms the expected checkpoint chain', () => {
  assert.equal(previousStage('ConstitutionReady'), null);
  for (let index = 1; index < LIVE_STAGE_SEQUENCE.length; index++) {
    assert.equal(previousStage(LIVE_STAGE_SEQUENCE[index].condition), LIVE_STAGE_SEQUENCE[index - 1]);
    assert.equal(LIVE_STAGE_SEQUENCE[index].prerequisite, LIVE_STAGE_SEQUENCE[index - 1].condition);
  }
});
