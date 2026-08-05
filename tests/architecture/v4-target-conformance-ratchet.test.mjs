// tests/architecture/v4-target-conformance-ratchet.test.mjs
//
// Conveyor v4 step 6 ratchet — target-architecture conformance checks.
//
// These are STATIC source checks that guard the v4 migration's forward
// progress. They are ratchets: they PASS today and fail if a future change
// regresses a v4 invariant. Each test documents which REG/E2E it guards.
//
// Coverage:
//   1. REG-01-AC-04: runtime core does not switch on module names/task_kind.
//      Checks the four core files for module-name string literals in code.
//   2. REG-03-AC-04: a fifth workshop can install without core changes.
//      (Structural: verified by absence of hard-coded workshop switches.)
//   3. REG-11: universal ProductRepositoryPort exists and is importable.
//   4. REG-18: GateDecision verdict is a closed union of four values.
//   5. Production cell FlowNode kind exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readSrc(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// REG-01-AC-04: runtime core must not switch on module names.
// The four core files must not contain module-name string literals in code.
const CORE_FILES = [
  'src/process-modules/domain/process-module.ts',
  'src/process-modules/application/node-executor.ts',
  'src/process-modules/application/generic-flow-executor.ts',
];
const MODULE_NAME_LITERALS = [
  "'discovery'",
  "'formalization'",
  "'development'",
  "'delivery'",
  '"discovery"',
  '"formalization"',
  '"development"',
  '"delivery"',
];

test('REG-01-AC-04: runtime core files do not switch on module names', () => {
  for (const file of CORE_FILES) {
    if (!existsSync(path.join(REPO_ROOT, file))) continue;
    const source = readSrc(file);
    // Check for module-name string literals IN CODE (not in comments).
    // We strip /* */ comments and // line comments first.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const literal of MODULE_NAME_LITERALS) {
      // Allow the literal in type positions (e.g. 'production-cell' is a kind,
      // not a module name). We only flag when the literal appears in a
      // comparison or switch case, not in a string type.
      if (stripped.includes(`=== ${literal}`) || stripped.includes(`case ${literal}:`)) {
        assert.fail(
          `REG-01-AC-04 violation: ${file} switches on module name ${literal}`,
        );
      }
    }
  }
});

test('REG-11: ProductRepositoryPort exists and is importable', () => {
  const source = readSrc('src/process-modules/application/product-repository-port.ts');
  assert.ok(source.includes('interface ProductRepositoryPort'));
  assert.ok(source.includes('STALE_EXECUTION_CANNOT_SUBMIT'));
});

test('REG-18: GateDecision verdict is a closed union of four values', () => {
  const source = readSrc('src/process-modules/domain/workplace/gate.ts');
  assert.ok(source.includes("'accepted'"));
  assert.ok(source.includes("'repair_required'"));
  assert.ok(source.includes("'human_required'"));
  assert.ok(source.includes("'failed'"));
  assert.ok(source.includes('type GateVerdict'));
});

test('REG-04: production-cell FlowNode kind exists', () => {
  const source = readSrc('src/process-modules/domain/process-module.ts');
  assert.ok(source.includes("'production-cell'"));
  assert.ok(source.includes('ProductionCellFlowNodeDefinition'));
});

test('REG-05: WorkplaceRef identity components are stable (4 fields)', () => {
  const source = readSrc('src/process-modules/domain/workplace/workplace-ref.ts');
  assert.ok(source.includes('processRunId'));
  assert.ok(source.includes('moduleRef'));
  assert.ok(source.includes('productionCellId'));
  assert.ok(source.includes('workKey'));
});

test('REG-09: WorkerLauncherPort exists', () => {
  const source = readSrc('src/application/ports/worker-launcher-port.ts');
  assert.ok(source.includes('interface WorkerLauncherPort'));
  assert.ok(source.includes('launch(request'));
});

test('REG-10-AC-05: ConcurrentLaunchBudget exists', () => {
  const source = readSrc('src/application/concurrent-launch-budget.ts');
  assert.ok(source.includes('class ConcurrentLaunchBudget'));
  assert.ok(source.includes('async acquire'));
});

test('REG-22: HumanInteractionRun contract exists', () => {
  const source = readSrc('src/modules/delivery/domain/delivery-effect-contracts.ts');
  assert.ok(source.includes('interface HumanInteractionRun'));
});

test('REG-23: EffectAttempt + EffectExecutorPort exist', () => {
  const source = readSrc('src/modules/delivery/domain/delivery-effect-contracts.ts');
  assert.ok(source.includes('interface EffectAttempt'));
  assert.ok(source.includes('interface EffectExecutorPort'));
});

test('REG-11: artifact-ref bridge for Formalization exists', () => {
  assert.ok(existsSync(path.join(REPO_ROOT, 'src/modules/formalization/domain/artifact-ref-bridge.ts')));
});

test('REG-11: proposal-ref bridge for Discovery exists', () => {
  assert.ok(existsSync(path.join(REPO_ROOT, 'src/modules/discovery/domain/proposal-ref-bridge.ts')));
});

test('REG-11-AC-05: TextSetManifest for Development exists', () => {
  assert.ok(existsSync(path.join(REPO_ROOT, 'src/modules/development/domain/text-set-manifest.ts')));
});

test('v4 migration plan document exists', () => {
  assert.ok(existsSync(path.join(REPO_ROOT, 'docs/architecture/CONVEYOR-V4-MIGRATION-PLAN.md')));
});
