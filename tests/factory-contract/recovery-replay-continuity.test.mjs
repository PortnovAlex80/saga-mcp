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

test('supervision classifies stale executions before renewing surviving leases', () => {
  const source = read('src/infrastructure/work/worker-supervision-service.ts');
  const runBody = source.slice(source.indexOf('const run ='));
  const reconcilePos = runBody.indexOf('options.executionRuntime.reconcile(');
  const renewPos = runBody.indexOf('options.executionRuntime.renewLeases(');

  assert.ok(reconcilePos >= 0, 'supervision must invoke reconcile');
  assert.ok(renewPos >= 0, 'supervision must invoke renewLeases');
  assert.ok(reconcilePos < renewPos,
    'reconcile must run before renewLeases so a restarted host cannot adopt an orphaned same-host execution by extending its expired lease');
  assert.match(runBody, /PRE-SWEEP lease|Reconcile FIRST, renew SECOND/);
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

test('canonical factory command preflights and supplies production composition', () => {
  const source = read('scripts/factory.mjs');

  assert.match(source, /function resolveFactoryComposition\(\)/);
  assert.match(source, /tracker-view[\s\S]*product-delivery-composition\.mjs/);
  assert.match(source, /const factoryCompositionPath = resolveFactoryComposition\(\)/);
  assert.match(source, /SAGA_PRODUCT_LIFECYCLE_COMPOSITION:\s*factoryCompositionPath/);
});

test('dispatcher cannot claim projection cards owned by a terminal ProcessRun', () => {
  const source = read('src/lifecycle/work-assignment-core.ts');

  assert.match(
    source,
    /factory_process_runs pr[\s\S]*pr\.id=json_extract\(t\.metadata, '\$\.process_run_id'\)[\s\S]*pr\.status IN \('running','paused'\)/,
  );
});

test('replay semantic input canonicalization excludes operator initiation provenance', () => {
  const source = read('src/process-modules/application/node-executors/production-cell-node-executor.ts');

  assert.match(source, /\^initiated_\?by\$\/i/);
  assert.match(source, /operator initiation identity/);
  assert.match(source, /canonicalizeLifecycleInput\(ctx\.input\)/);
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

test('QA supervision addendum forbids renew-before-reconcile orphan adoption', () => {
  const addendum = read('skills/saga-factory-qa/RECOVERY-SUPERVISION.md');

  assert.match(addendum, /RS-01 — classify before renewing/);
  assert.match(addendum, /reconcile active WorkerExecutions[\s\S]*renew leases only for executions that survived reconciliation/);
  assert.match(addendum, /renewLeases\(all same-host active executions\)[\s\S]*reconcile/);
  assert.match(addendum, /same host is not same foreman/i);
  assert.match(addendum, /source-order regex[\s\S]*NOT sufficient runtime proof/i);
});
