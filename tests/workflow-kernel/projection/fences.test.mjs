/**
 * fences.test.mjs - WP-10: the EK-7 structural fences (hard laws).
 *
 *   F1  PROJECTION-DERIVED DECISION INPUT: no kernel-core source (the
 *       workflow-kernel OUTSIDE projection/) reads `tasks`, `tasks.status`,
 *       an assigned worker, or the projection table - core decisions are
 *       functions of canonical facts only.
 *   F2  REVERSE-BOARD TOOL CONTEXT: the command-only modules (adapters,
 *       context, cards) never read the board - tools and hooks receive
 *       exact context from authoritative commands.
 *   F3  STALE-CARD ACCEPTANCE: no source outside the projection store
 *       touches the kanban_card table - a stale or forged row can never
 *       become an input anywhere.
 *
 * Each family carries a KILLED MUTATION: the scanner is fed the real
 * kernel source with the mutation textually injected, and MUST flag it -
 * proving the fence actually kills its mutation family, not just scans
 * clean.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fences = await import('../../../dist/workflow-kernel/projection/fences.js');

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const KERNEL_SRC = join(__dirname, '..', '..', '..', 'src', 'workflow-kernel');

/** Recursively list every .ts file under a directory. */
function listTypeScriptFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTypeScriptFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const projectionDir = join(KERNEL_SRC, 'projection');
const allKernelFiles = listTypeScriptFiles(KERNEL_SRC);
const coreFiles = allKernelFiles.filter((file) => !file.startsWith(projectionDir));
const commandOnlyFiles = fences.COMMAND_ONLY_MODULES.map((name) => join(projectionDir, name));

test('F1 GREEN: no kernel-core source reads tasks/tasks.status/assigned-worker/projection state', () => {
  assert.ok(coreFiles.length > 30, 'the kernel core corpus is scanned');
  for (const file of coreFiles) {
    const violations = fences.scanCoreSourceForDecisionInputs(file, readFileSync(file, 'utf8'));
    assert.deepEqual(violations, [], `${file} is free of forbidden decision inputs`);
  }
});

test('F2 GREEN: the command-only modules never read the board (context comes from commands)', () => {
  for (const file of commandOnlyFiles) {
    const violations = fences.scanCommandOnlyModuleForBoardReads(file, readFileSync(file, 'utf8'));
    assert.deepEqual(violations, [], `${file} builds its context without any board read`);
  }
});

test('F3 GREEN: kanban_card data SQL exists ONLY inside the projection store module', () => {
  for (const file of allKernelFiles) {
    // The store owns the table's data SQL; the fences module only CARRIES the
    // register strings (like a frozen vocabulary file); the schema declares DDL.
    const exempt = file.endsWith(fences.PROJECTION_STORE_MODULE) || file.endsWith('fences.ts') || file.endsWith('schema.ts');
    const violations = fences.scanSourceForProjectionTableUse(file, readFileSync(file, 'utf8'), exempt);
    assert.deepEqual(violations, [], `${file} does not touch the projection table's data`);
  }
});

/* ------------------------------------------------------------------ */
/* Killed mutations - one per fence family (RED when the fence dies)   */
/* ------------------------------------------------------------------ */

test('F1 KILLED MUTATION: a core read of tasks.status is flagged (projection-derived decision input)', () => {
  const realCore = readFileSync(join(KERNEL_SRC, 'persistence', 'kernel-ledger.ts'), 'utf8');
  const mutated = `${realCore}\nconst banned = db.prepare('SELECT status FROM tasks WHERE assigned_worker = ?');\n`;
  const violations = fences.scanCoreSourceForDecisionInputs('kernel-ledger.ts', mutated);
  assert.ok(violations.length >= 3, 'the injected tasks.status/assigned_worker read is flagged');
  assert.ok(violations.every((violation) => violation.fence === 'F1_CORE_DECISION_INPUT'));
  assert.match(violations[0].excerpt, /SELECT status FROM tasks/);
});

test('F2 KILLED MUTATION: a tool-context builder that reverse-reads the board is flagged', () => {
  const realContext = readFileSync(join(projectionDir, 'context.ts'), 'utf8');
  const mutated = `${realContext}\nconst lane = db.prepare('SELECT lane FROM kanban_card WHERE card_id = ?').get();\n`;
  const violations = fences.scanCommandOnlyModuleForBoardReads('context.ts', mutated);
  assert.ok(violations.length >= 1, 'the injected reverse-board read is flagged');
  assert.ok(violations.every((violation) => violation.fence === 'F2_REVERSE_BOARD_CONTEXT'));
});

test('F3 KILLED MUTATION: a kernel-core module accepting a stale card row is flagged', () => {
  const realConsumer = readFileSync(join(KERNEL_SRC, 'application', 'obligation-consumer.ts'), 'utf8');
  const mutated = `${realConsumer}\nconst staleLane = db.prepare("SELECT lane, payload_json FROM kanban_card WHERE projected_sequence < ?").all();\n`;
  const violations = fences.scanSourceForProjectionTableUse('obligation-consumer.ts', mutated, false);
  assert.ok(violations.length >= 1, 'the injected stale-card acceptance is flagged');
  assert.ok(violations.every((violation) => violation.fence === 'F3_STORE_READ_OUTSIDE_PROJECTION_STORE'));
});

/* ------------------------------------------------------------------ */
/* The UI may not select: closed action payloads (shape law)           */
/* ------------------------------------------------------------------ */

test('the UI action payloads are closed: no field can select a role, skill, tool set, completion command or prompt budget', async () => {
  const adaptersSource = readFileSync(join(projectionDir, 'adapters.ts'), 'utf8');
  // The closed action union is the ONLY input surface of the adapters; the
  // forbidden selection vocabulary must not appear as an action field.
  for (const forbidden of ['skillRef', 'toolSet', 'allowedTools', 'promptBudget', 'completionCommand', 'model']) {
    assert.ok(
      !adaptersSource.includes(`readonly ${forbidden}`),
      `the adapter action payloads must not carry a selection field '${forbidden}'`,
    );
  }
  // The pin travels FROM the runtime TO the display, never from the action.
  assert.ok(adaptersSource.includes('slot.pin'), 'the pinned contract originates from the runtime slot');
  assert.ok(adaptersSource.includes('displayedRoleContract'), 'the result DISPLAYS the pinned contract for diagnosis');
});
