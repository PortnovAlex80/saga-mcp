import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

test('hard-crash reconciliation repairs Workplace authority as well as execution/task fence', () => {
  const source = read('src/infrastructure/persistence/sqlite-factory-runtime-repositories.ts');

  assert.match(source, /new ConveyorRuntime\(db\)/);
  assert.match(source, /deserializeWorkplaceRef\(binding\.workplace_ref\)/);
  assert.match(source, /conveyor\.releaseExecution\(\{/);
  assert.match(source, /reservationRef:\s*projection\.executionId/);
  assert.match(source, /outcome:\s*'crashed'/);

  const reconcilePos = source.indexOf('reconcileWorkerExecutions(');
  const workplaceReleasePos = source.indexOf('conveyor.releaseExecution({');
  assert.ok(reconcilePos >= 0 && workplaceReleasePos > reconcilePos,
    'startup reaper must reconcile the physical execution then repair the stale Workplace reservation in the same repository transaction');
});

test('factory start parsing cannot leak control option values into initiative subject', () => {
  const source = read('scripts/factory.mjs');

  assert.doesNotMatch(source, /args\.slice\(2\)\.filter\(a => !a\.startsWith\('--'\)\)\.join\(' '\)/);
  assert.match(source, /if \(arg === '--model' \|\| arg === '--sandbox'\)/);
  assert.match(source, /i \+= 1;/);
  assert.match(source, /idea:\s*ideaParts\.join\(' '\)\.trim\(\)/);
  assert.match(source, /initiatedBy:\s*'factory-start'/);
  assert.doesNotMatch(source, /initiatedBy:\s*sandboxName\s*\?\?/);
});

test('QA gate explicitly distinguishes same-run resume from cross-run replay', () => {
  const skill = read('skills/saga-factory-qa/SKILL.md');

  assert.match(skill, /RESUME[\s\S]*same LifecycleRun/);
  assert.match(skill, /NEW FACTORY START, SAME PROJECT/);
  assert.match(skill, /clean DB[\s\S]*NOT a replay test/i);
  assert.match(skill, /QA-E19 — every crash path updates Workplace authority/);
  assert.match(skill, /QA-F09 — control argv cannot contaminate semantic input/);
  assert.match(skill, /QA-G09 — same-run resume reuses durable completed stage\/process results directly/);
});
