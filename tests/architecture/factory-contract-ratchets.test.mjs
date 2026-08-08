// tests/architecture/factory-contract-ratchets.test.mjs
//
// Architecture ratchets: prevent test-only Factory semantics from leaking
// into production runtime and prevent the P18 emergency node-scope repair from
// becoming the generic durable-product contract.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve('src');

function walkDir(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) results.push(...walkDir(fullPath));
    else if (entry.endsWith('.ts')) results.push(fullPath);
  }
  return results;
}

const allSrcFiles = walkDir(SRC_ROOT);
const allSrcContent = new Map();
for (const file of allSrcFiles) allSrcContent.set(file, readFileSync(file, 'utf8'));

test('AC-03: production source does not import from tests/', () => {
  const violations = [];
  for (const [file, content] of allSrcContent) {
    if (/from\s+['"]\.\..*tests\//.test(content) || /require\s*\(['"]\.\..*tests\//.test(content)) violations.push(file);
    if (/mock-claude/.test(content) && !file.includes('composition-root')) violations.push(`${file} references 'mock-claude'`);
    if (/factory-contract\/scenario/.test(content)) violations.push(`${file} references factory-contract scenarios`);
  }
  assert.deepEqual(violations, [], `Production code importing tests:\n${violations.join('\n')}`);
});

test('AC-02: no SAGA_SIM/MOCK/HYBRID environment switches in production', () => {
  const violations = [];
  const FORBIDDEN_ENV = /SAGA_SIM_|SAGA_MOCK_|SAGA_HYBRID|SAGA_TEST_MODE|SAGA_SCRIPTED/;
  for (const [file, content] of allSrcContent) if (FORBIDDEN_ENV.test(content)) violations.push(file);
  assert.deepEqual(violations, [], `Forbidden env switches in production:\n${violations.join('\n')}`);
});

test('AC-44: no test-only executor_kind in production', () => {
  const violations = [];
  for (const [file, content] of allSrcContent) {
    if (/['"]scripted['"]|['"]mock['"]|['"]simulated['"]/.test(content) && content.includes('executor_kind')) violations.push(file);
  }
  assert.deepEqual(violations, [], `Test-only executor kinds:\n${violations.join('\n')}`);
});

test('AC-44: no module-name branching that selects different Factory state machines', () => {
  const FACTORY_RUNTIME_FILES = [
    'src/application/conveyor-runtime.ts',
    'src/process-modules/application/production-cell-coordinator.ts',
    'src/process-modules/application/lifecycle-router.ts',
    'src/process-modules/application/generic-flow-executor.ts',
    'src/app/factory-start.ts',
  ];
  const violations = [];
  for (const relPath of FACTORY_RUNTIME_FILES) {
    const fullPath = path.join(SRC_ROOT, '..', relPath);
    const content = allSrcContent.get(fullPath);
    if (!content) continue;
    if (/if\s*\(.*moduleName.*===\s*['"]/.test(content) || /switch\s*\(.*moduleName/.test(content)) violations.push(relPath);
  }
  assert.deepEqual(violations, [], `Factory runtime branches on module name:\n${violations.join('\n')}`);
});

test('P18: gate path resolves managed production through exact Workplace', () => {
  const runtimePath = path.join(SRC_ROOT, 'app', 'product-lifecycle-runtime.ts');
  const runtimeContent = allSrcContent.get(runtimePath);
  assert.ok(runtimeContent, 'product-lifecycle-runtime.ts exists');
  assert.ok(runtimeContent.includes('workplaceProductionResolver.read(workplaceRef)'), 'Gate path uses exact Workplace production resolver');
  assert.ok(runtimeContent.includes('buildWorkplaceProductionSnapshot'), 'Gate path freezes an immutable Workplace snapshot before CandidateSet seal');
  assert.ok(!runtimeContent.includes('ref: `node-product-set:'), 'Generic managed-production ProductRef is not node-wide synthetic identity');
});

test('P18: workplace production resolver joins ledger rows through tasks.workplace_ref', () => {
  const resolverPath = path.join(SRC_ROOT, 'infrastructure', 'workplace', 'sqlite-workplace-production-resolver.ts');
  const content = allSrcContent.get(resolverPath);
  assert.ok(content, 'workplace production resolver exists');
  assert.ok(content.includes('JOIN tasks t ON t.id=mp.task_id'));
  assert.ok(content.includes('WHERE t.workplace_ref=?'));
});

test('Replay: capsule materialization is CandidateSet-driven, not execution-write-driven', () => {
  const capturePath = path.join(SRC_ROOT, 'infrastructure', 'replay', 'sqlite-replay-capsule-repository.ts');
  const captureContent = allSrcContent.get(capturePath);
  assert.ok(captureContent, 'replay capsule repository exists');
  const captureSection = captureContent.substring(captureContent.indexOf('captureAcceptedExecution'));
  assert.ok(captureSection.includes('readCandidateMembers'), 'Replay capture starts from exact CandidateSet members');
  assert.ok(!captureSection.includes('FROM factory_managed_artifact_productions\n        WHERE execution_id=?'), 'Replay capture does not derive accepted material from source execution writes');
});

test('candidate_read reports sealed ProductRef snapshot, not current/live provenance query', () => {
  const productsPath = path.join(SRC_ROOT, 'tools', 'products.ts');
  const productsContent = allSrcContent.get(productsPath);
  assert.ok(productsContent, 'products.ts exists');
  const candidateReadSection = productsContent.substring(productsContent.indexOf('candidateRead'), productsContent.indexOf('export const definitions'));
  assert.ok(candidateReadSection.includes('set.members.map'));
  assert.ok(candidateReadSection.includes('productRepo().getByProductRef(productRef)'));
  assert.ok(candidateReadSection.includes('isWorkplaceProductionSnapshot'));
  assert.ok(!candidateReadSection.includes('factory_managed_artifact_productions'));
  assert.ok(!candidateReadSection.includes('factory_managed_trace_productions'));
});

test('worker process termination policy is production-owned, not duplicated by scripted harness', () => {
  const finalizerPath = path.join(SRC_ROOT, 'infrastructure', 'workers', 'worker-process-termination.ts');
  const content = allSrcContent.get(finalizerPath);
  assert.ok(content?.includes('finalizeManagedWorkerProcess'));
  const scripted = readFileSync(path.resolve('tests/factory-contract/scenario-scripted-executor.mjs'), 'utf8');
  assert.ok(scripted.includes('dist/infrastructure/workers/worker-process-termination.js'));
  assert.ok(!scripted.includes('new ConveyorRuntime'));
  assert.ok(!scripted.includes('releaseExecutionAtomically('));
});
