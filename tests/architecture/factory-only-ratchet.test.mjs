import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = path => readFileSync(path, 'utf8');

test('retired engines and operator archives cannot return', () => {
  for (const path of [
    'src/application/ports/saga2-host-runtime.ts',
    'src/application/ports/saga2-runtime-persistence.ts',
    'src/lifecycle/unfenced-assignment-recovery.ts',
    'architecture-analysis',
    'architecture-analysis-post',
    'architecture-analysis-v2',
    'docs/refactor-management',
    'docs/design/saga4-cutover',
    'docs/saga3',
    'skills/autonomous-recovery',
    'skills/saga-orchestrator',
    'skills/saga-v3-refactor-auditor',
  ]) assert.equal(existsSync(path), false, path);
});

test('factory runtime is unconditional, fenced and gate-owned', () => {
  const writer = read('src/tools/universal-desk-helper.ts');
  assert.doesNotMatch(writer, /process\.env\.SAGA_WORKPLACE_WRITE/);
  assert.match(writer, /submitProduct/);
  assert.doesNotMatch(writer, /best-effort|shadow write/i);

  const release = read('src/tools/conveyor-runtime-helper.ts');
  assert.doesNotMatch(release, /\.acceptFinal\s*\(/);
  assert.match(release, /releaseExecution/);
  assert.match(release, /FACTORY_RELEASE_FAILED/);

  const workerRecovery = read('src/worker-executions.ts');
  assert.doesNotMatch(workerRecovery, /recoverLegacyAssignment\s*\(/);

  const assembler = read('src/process-modules/application/execution-context-assembler.ts');
  assert.match(assembler, /PACKAGE_PIN_REQUIRED/);
  assert.doesNotMatch(assembler, /return ['"]legacy:unpinned['"]/);
});

test('only the factory gateway can initiate production', () => {
  const tracker = read('tracker-view/tracker-view.mjs');
  const activePostRoutes = [...tracker.matchAll(
    /req\.method === 'POST' && url\.pathname === '([^']+)'/g,
  )].map(match => match[1]);
  assert.ok(activePostRoutes.includes('/api/factory/start'));
  for (const route of [
    '/api/engine/start', '/api/engine/restart', '/api/board-run/start',
    '/api/project/create', '/api/epic/create', '/api/artifact/save',
  ]) assert.ok(!activePostRoutes.includes(route), route);

  const catalog = read('src/index.ts');
  for (const tool of [
    'project_create', 'project_resolve_by_name', 'epic_create', 'process_run_start',
    'process_run_set', 'process_run_cancel',
  ]) assert.match(catalog, new RegExp(`INTERNAL_ONLY_TOOL_NAMES[\\s\\S]*['"]${tool}['"]`));
});

test('workspace skills require an authoritative project binding', () => {
  for (const path of [
    'skills/saga-code-reviewer/SKILL.md',
    'skills/saga-dispatch/SKILL.md',
    'skills/saga-tracker/SKILL.md',
    'src/process-modules/modules/development/package/resources/skills/saga-worker/SKILL.md',
  ]) assert.doesNotMatch(read(path), /projectname\.txt/i, path);
});
