import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);

test('formalization completion requires an actual worker_done tool receipt', () => {
  const skill = readFileSync(new URL(
    'src/process-modules/modules/formalization/package/resources/skills/saga-product/SKILL.md',
    root,
  ), 'utf8');
  const tracker = readFileSync(new URL(
    'src/process-modules/modules/formalization/package/resources/process-module-stage-tracker.md',
    root,
  ), 'utf8');
  const template = JSON.parse(readFileSync(new URL(
    'src/process-modules/modules/formalization/package/resources/worker-done-call-template.json',
    root,
  ), 'utf8'));

  for (const text of [skill, tracker, template._MANDATORY_EXECUTION_INSTRUCTION]) {
    assert.match(text, /actual[\s`]*mcp__saga__worker_done[\s`]*tool/i);
    assert.match(text, /not\W+(?:a tool invocation|completion)|does not complete/i);
    assert.match(text, /stop:? ?true/i);
  }
});

test('the production runner enforces the worker_done tool boundary for every workshop', () => {
  const runner = readFileSync(new URL('tracker-view/claude-runner.mjs', root), 'utf8');
  assert.match(runner, /actual mcp__saga__worker_done tool/i);
  assert.match(runner, /worker-done-call\.json is NOT a tool call/i);
  assert.match(runner, /accepted stop:true receipt/i);
});
