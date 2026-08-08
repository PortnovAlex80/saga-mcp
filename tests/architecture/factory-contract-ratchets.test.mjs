// tests/architecture/factory-contract-ratchets.test.mjs
//
// Architecture ratchets: prevent test-only Factory semantics from leaking
// into production runtime. These tests MUST pass — they guard the invariant
// that scripted workers are a physical-worker substitution only, never a
// Factory runtime mode.
//
// AC-02: no supported mock/simulator/hybrid Factory runtime.
// AC-03: production source code does not import the scripted test implementation.
// AC-44: architecture tests prevent test-only Factory semantics.

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
    if (stat.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

const allSrcFiles = walkDir(SRC_ROOT);
const allSrcContent = new Map();
for (const file of allSrcFiles) {
  allSrcContent.set(file, readFileSync(file, 'utf8'));
}

test('AC-03: production source does not import from tests/', () => {
  const violations = [];
  for (const [file, content] of allSrcContent) {
    // Check for any import/require from tests/
    if (/from\s+['"]\.\..*tests\//.test(content) || /require\s*\(['"]\.\..*tests\//.test(content)) {
      violations.push(file);
    }
    // Also check for imports of mock-claude or factory-contract test helpers
    if (/mock-claude/.test(content) && !file.includes('composition-root')) {
      violations.push(`${file} references 'mock-claude'`);
    }
    if (/factory-contract\/scenario/.test(content)) {
      violations.push(`${file} references factory-contract scenarios`);
    }
  }
  assert.deepEqual(violations, [], `Production code importing tests:\n${violations.join('\n')}`);
});

test('AC-02: no SAGA_SIM/MOCK/HYBRID environment switches in production', () => {
  const violations = [];
  const FORBIDDEN_ENV = /SAGA_SIM_|SAGA_MOCK_|SAGA_HYBRID|SAGA_TEST_MODE|SAGA_SCRIPTED/;
  for (const [file, content] of allSrcContent) {
    if (FORBIDDEN_ENV.test(content)) {
      violations.push(file);
    }
  }
  assert.deepEqual(violations, [], `Forbidden env switches in production:\n${violations.join('\n')}`);
});

test('AC-44: no test-only executor_kind in production', () => {
  const violations = [];
  for (const [file, content] of allSrcContent) {
    // Check for test-only executor kind literals
    if (/['"]scripted['"]|['"]mock['"]|['"]simulated['"]/.test(content)
        && content.includes('executor_kind')) {
      violations.push(file);
    }
  }
  assert.deepEqual(violations, [], `Test-only executor kinds:\n${violations.join('\n')}`);
});

test('AC-44: no module-name branching that selects different Factory state machines', () => {
  // The Factory runtime (conveyor, production-cell coordinator, lifecycle router)
  // must not branch on module names to select different state machines.
  // The CONVEYOR model §16 forbids this: "Factory must not branch on project
  // name/isTest/mock mode."
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
    // Check for explicit module-name branching that changes behavior
    if (/if\s*\(.*moduleName.*===\s*['"]/.test(content)
        || /switch\s*\(.*moduleName/.test(content)) {
      violations.push(relPath);
    }
  }
  assert.deepEqual(violations, [], `Factory runtime branches on module name:\n${violations.join('\n')}`);
});

test('AC-13: no execution-scoped managed-production reads in gate path', () => {
  // The gate's readExecutionProducts must use node-durable scope, not execution_id.
  // This is a structural check — the product-lifecycle-runtime.ts must not
  // filter managed productions by execution_id in the gate-read path.
  const runtimePath = path.join(SRC_ROOT, 'app', 'product-lifecycle-runtime.ts');
  const runtimeContent = allSrcContent.get(runtimePath);
  assert.ok(runtimeContent, 'product-lifecycle-runtime.ts exists');

  // The managed-production read MUST use listArtifactsForNodeInProcessRun,
  // not execution-scoped queries, in the gate path.
  assert.ok(
    runtimeContent.includes('listArtifactsForNodeInProcessRun'),
    'Gate path uses node-durable managed production reads',
  );
});

test('AC-12: replay capture uses node-durable scope, not execution_id for managed production', () => {
  const capturePath = path.join(SRC_ROOT, 'infrastructure', 'replay', 'sqlite-replay-capsule-repository.ts');
  const captureContent = allSrcContent.get(capturePath);
  assert.ok(captureContent, 'replay capsule repository exists');

  // The capture method must use scopeFilter (node-durable when available)
  // not hard-coded WHERE execution_id=?
  assert.ok(
    captureContent.includes('scopeFilter'),
    'Replay capture uses scopeFilter abstraction for node-durable reads',
  );
});

test('AC-09: candidate_read uses node-durable scope, not execution_id', () => {
  const productsPath = path.join(SRC_ROOT, 'tools', 'products.ts');
  const productsContent = allSrcContent.get(productsPath);
  assert.ok(productsContent, 'products.ts exists');

  // candidate_read must NOT filter by execution_id for artifacts/traces
  const candidateReadSection = productsContent.substring(
    productsContent.indexOf('candidateRead'),
    productsContent.indexOf('candidateRead') + 2000,
  );
  assert.ok(
    !candidateReadSection.includes('WHERE process_run_id=? AND execution_id=?'),
    'candidate_read does not filter by execution_id',
  );
  assert.ok(
    candidateReadSection.includes('module_ref') && candidateReadSection.includes('node_id'),
    'candidate_read filters by node scope',
  );
});
