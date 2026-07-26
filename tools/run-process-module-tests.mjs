#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const groups = {
  a: [
    'development-task-graph-authorization.test.mjs',
    'discovery-generic-flow-scenarios.test.mjs',
    'discovery-outcome-certificate-projection.test.mjs',
    'formalization-e2e-smoke.test.mjs',
    'formalization-generic-flow.test.mjs',
    'formalization-mcp-templates.test.mjs',
    'formalization-persistence.test.mjs',
    'formalization-settlement.test.mjs',
    'legacy-formalization-process-adapter.test.mjs',
    'managed-node-submission.test.mjs',
    'managed-production-ledger.test.mjs',
    'process-module-boundaries.test.mjs',
    'process-module-installation.test.mjs',
    'process-module-run-result.test.mjs',
    'process-module-tools.test.mjs',
    'process-module-validation.test.mjs',
    'product-lifecycle-policies.test.mjs',
  ],
  b: [
    'external-effect-ledger.test.mjs',
    'generic-flow-executor.test.mjs',
    'generic-flow-recovery.test.mjs',
    'lifecycle-orchestrator.test.mjs',
    'lifecycle-routing.test.mjs',
    'process-outcome-certificate.test.mjs',
    'process-run-lifecycle.test.mjs',
    'product-delivery-lifecycle-e2e.test.mjs',
    'product-lifecycle-composition.test.mjs',
    'product-lifecycle-persistence.test.mjs',
    'runtime-engine.test.mjs',
    'sqlite-lifecycle-run-repository.test.mjs',
  ],
};

const requested = process.argv[2]?.toLowerCase() ?? 'all';
if (requested !== 'all' && !Object.hasOwn(groups, requested)) {
  console.error('Usage: node tools/run-process-module-tests.mjs [a|b|all]');
  process.exit(2);
}

const selected = requested === 'all' ? ['a', 'b'] : [requested];
for (const group of selected) {
  const files = groups[group].map(file =>
    path.join(root, 'tests', 'process-modules', file));
  console.log(
    `\n[process-modules:${group}] ${files.length} files, sequential runner`,
  );
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...files],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
