/**
 * tests/workflow-kernel/composition/cutover-pins.test.mjs - the EK-8/WP-12
 * CUTOVER-LAW RED/GREEN pins (blocking).
 *
 * The two hard-cutover laws, each proven by a REAL SOURCE MUTATION applied
 * to the live tree and then reverted (the suite is hermetic: every mutation
 * is restored in a finally block; a crashed run leaves no debris because
 * the mutated file is restored before any assertion can throw):
 *
 *   PIN-1  PROJECTION-DERIVED DECISION INPUT IS CAUGHT: injecting a
 *          `tasks`-reading SQL statement into a kernel-core source makes
 *          the WP-10 F1 fence (over the REAL kernel tree) name that file —
 *          a scheduling decision may never again derive from projection or
 *          legacy-board state (the class the whole EK-7/EK-8 program
 *          deleted).
 *   PIN-2  PROJECTION-TABLE READ OUTSIDE THE STORE IS CAUGHT: injecting a
 *          kanban_card read into a kernel-core source makes the F3 fence
 *          name that file — cards are disposable UI state, never workflow
 *          inputs, even in the production composition era.
 *
 * The old-path RESURRECTION pin (legacy-zero --strict) is owned by
 * tests/infrastructure/ek-removal-guard.test.mjs RG4b-RED/GREEN.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fences = await import('../../../dist/workflow-kernel/projection/fences.js');

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const KERNEL_SRC = join(__dirname, '..', '..', '..', 'src', 'workflow-kernel');
const TARGET = join(KERNEL_SRC, 'planning', 'readiness.ts');

/** Run the F1/F3 scans the projection suite runs, over the real kernel-core tree. */
function scanKernelCore() {
  const violations = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue;
      const rel = full.slice(KERNEL_SRC.length + 1).replaceAll('\\', '/');
      if (rel.startsWith('projection/')) continue; // kernel-core = outside projection/
      const text = readFileSync(full, 'utf8');
      violations.push(...fences.scanCoreSourceForDecisionInputs(rel, text));
      violations.push(...fences.scanSourceForProjectionTableUse(rel, text, false));
    }
  };
  walk(KERNEL_SRC);
  return violations;
}

/** Apply a textual mutation to the live file, run the scan, restore, return the RED violations. */
function withLiveMutation(mutation) {
  const original = readFileSync(TARGET, 'utf8');
  writeFileSync(TARGET, original + '\n' + mutation + '\n', 'utf8');
  try {
    return scanKernelCore().filter((v) => v.source.includes('readiness.ts'));
  } finally {
    writeFileSync(TARGET, original, 'utf8');
  }
}

test('PIN-1 RED/GREEN: a projection-derived decision input in kernel-core is CAUGHT (F1)', () => {
  const red = withLiveMutation(
    "const __wp12Probe = 'SELECT status FROM tasks WHERE tasks.status = \'in_progress\' AND assigned_worker IS NOT NULL';",
  );
  assert.ok(red.length > 0, 'the F1 fence must catch a tasks-reading decision input injected into kernel-core');
  assert.ok(red.some((v) => v.fence === 'F1_CORE_DECISION_INPUT'), `expected an F1 violation, got ${JSON.stringify(red)}`);
  // GREEN: with the mutation reverted (the finally block restored the file),
  // the real tree scans clean.
  assert.deepEqual(scanKernelCore().filter((v) => v.source.includes('readiness.ts')), [],
    'the un-mutated kernel-core tree must stay F1-clean');
});

test('PIN-2 RED/GREEN: a projection-table read outside the store is CAUGHT (F3)', () => {
  const red = withLiveMutation(
    "const __wp12Probe = 'SELECT lane FROM kanban_card WHERE work_item_ref = ?';",
  );
  assert.ok(red.length > 0, 'the F3 fence must catch a kanban_card read injected outside the projection store');
  assert.ok(red.some((v) => v.fence === 'F3_STORE_READ_OUTSIDE_PROJECTION_STORE'), `expected an F3 violation, got ${JSON.stringify(red)}`);
  assert.deepEqual(scanKernelCore().filter((v) => v.source.includes('readiness.ts')), [],
    'the un-mutated kernel-core tree must stay F3-clean');
});
