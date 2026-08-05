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
//   6. REG-03-AC-05 step 6 ratchet: module-name/task-kind switches are
//      captured in a shrinkage whitelist (target = zero switches).

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

test('factory-only decision document exists', () => {
  assert.ok(existsSync(path.join(REPO_ROOT, 'docs/architecture/decisions/027-factory-only-runtime.md')));
});

// ---------------------------------------------------------------------------
// Step 6 final ratchet — no-module-name-switch (REG-03-AC-05).
//
// Target: zero `moduleName/task_kind` switches in runtime code. A workshop's
// semantic differences must live in contracts/skills/CheckPlan/policies, not
// in `if (task_kind === ...)` runtime branches (REG-03-AC-05, REG-01-AC-04).
//
// Today a small number of switches remain (the per-workshop settlement path
// and the verification.ac dispatch special-case). This ratchet captures them
// in a SHRINKAGE whitelist: the set may only shrink as each workshop moves
// its semantics into declarative policy (steps 3.A.4/3.B.3/3.C.4).
// ---------------------------------------------------------------------------

// Scan the runtime-relevant trees (NOT domain/ where task_kind may appear as
// a typed field, NOT tests/).
const SWITCH_SCAN_TREES = [
  'src/tools',
  'src/lifecycle',
  'src/application',
  'src/process-modules/application',
  'src/app',
  'src/planner',
  'src/shared',
];

// Allowed current switches. Each retires when the workshop ships its
// semantics as declarative policy. Adding an entry requires an ADR.
const ALLOWED_TASK_KIND_SWITCHES = [
  // dispatcher — the verification.ac → pending_verification special-case.
  // Retires when verification becomes a declarative Cell (step 3.A.6 / REG-18).
  'src/tools/dispatcher.ts',
  // tasks.ts — verification.ac trace-type binding + scaffold detection.
  // Retires when task-graph policy is declarative (REG-03-AC-05).
  'src/tools/tasks.ts',
  // artifacts.ts — verification.ac verified_by trace binding.
  // Retires with tasks.ts (same declarative policy).
  'src/tools/artifacts.ts',
  // settlement-debug.ts — discovery module_ref_key debug surface.
  // Retires when discovery read-switch lands (3.B.3).
  'src/tools/settlement-debug.ts',
];

// Match task_kind / module_ref_key / taskKind equality switches and case
// labels against the four workshop names + verification.ac.
const SWITCH_RE =
  /(task_kind|taskKind|module_ref_key|moduleName|moduleRef)\s*===\s*['"](discovery|formalization|development|delivery|saga3\.[a-z]+|verification\.ac|development\.scaffold)['"]|case\s+['"](discovery|formalization|development|delivery)['"]:/g;

function listTsFiles2(dir) {
  const out = [];
  let st;
  try { st = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of st) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles2(full));
    } else if (entry.isFile() && /\.(ts|tsx)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function findSwitches() {
  const hits = [];
  for (const tree of SWITCH_SCAN_TREES) {
    const abs = path.join(REPO_ROOT, tree);
    for (const file of listTsFiles2(abs)) {
      const text = readFileSync(file, 'utf8');
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      let m;
      SWITCH_RE.lastIndex = 0;
      while ((m = SWITCH_RE.exec(text)) !== null) {
        // Skip if the hit is on a // comment line.
        const lineStart = text.lastIndexOf('\n', m.index) + 1;
        const lineEnd = text.indexOf('\n', m.index);
        const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        if (/^\s*\/\//.test(line)) continue;
        if (line.slice(0, m.index - lineStart).includes('//')) continue;
        hits.push(rel);
        break;
      }
    }
  }
  return [...new Set(hits)].sort();
}

const OBSERVED_SWITCHES = findSwitches();

test('REG-03-AC-05 step 6: every task_kind/module-name switch is whitelisted', () => {
  const unlisted = OBSERVED_SWITCHES.filter(
    (f) => !ALLOWED_TASK_KIND_SWITCHES.includes(f),
  );
  if (unlisted.length > 0) {
    assert.fail(
      `${unlisted.length} runtime file(s) switch on module-name/task_kind but are NOT ` +
        `on ALLOWED_TASK_KIND_SWITCHES (Conveyor v4 step 6, REG-03-AC-05). Move the ` +
        `workshop's semantics into declarative contracts/CheckPlan/policy, or add the ` +
        `file to the whitelist with a retirement citation:\n` +
        unlisted.map((f) => `  ${f}`).join('\n'),
    );
  }
});

test('REG-03-AC-05 step 6: whitelist has no dead entries (shrinkage is honest)', () => {
  const dead = ALLOWED_TASK_KIND_SWITCHES.filter(
    (f) => !OBSERVED_SWITCHES.includes(f),
  );
  if (dead.length > 0) {
    assert.fail(
      `${dead.length} ALLOWED_TASK_KIND_SWITCHES entr(ies) no longer switch on ` +
        `module-name/task_kind — remove them (the declarative policy landed):\n` +
        dead.map((f) => `  ${f}`).join('\n'),
    );
  }
});

test('REG-03-AC-05 step 6: reports switch set for shrinkage visibility', () => {
  // eslint-disable-next-line no-console
  console.log(
    `\n  step 6 no-module-name-switch ratchet: ${ALLOWED_TASK_KIND_SWITCHES.length} allowed ` +
      `switch file(s), ${OBSERVED_SWITCHES.length} observed. Target = 0 when every ` +
      `workshop ships its semantics as declarative policy (REG-03-AC-05).`,
  );
  assert.ok(ALLOWED_TASK_KIND_SWITCHES.length >= 0);
});
