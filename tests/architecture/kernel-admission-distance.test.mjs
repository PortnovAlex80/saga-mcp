// tests/architecture/kernel-admission-distance.test.mjs
//
// ADR-082 — the kernel GENERICITY guard (post-cutover shape, WP-12 2026-08-26).
//
// WHAT SURVIVED THE EK-8 CUTOVER. The four frozen ADMISSION surfaces of the
// old process-module runtime (payload contracts, executable capabilities,
// the five register* composition calls, the lifecycle start gateway) died
// with that runtime; their successors are the EK-1 frozen admission specs
// (guarded BLOCKING by the ek-admission matrix group) and the per-workshop
// installed-manifest structure tests. The BEHAVIOURAL SCAN — the kernel must
// never branch on a workshop/stage name — survived and is the whole of this
// guard now: it is the kernel-genericity decision of ADR-082 / CONVEYOR §3,
// and it has strictly more bite post-cutover because the scan now covers
// every production source file of the tree (src/workflow-kernel/** only —
// the purge deleted every other production tree).
//
// THE REGISTERS. Every behavioural site must be claimed by a register entry:
//   BENIGN_NAME_DATA      — the mention is data (identity comparisons over
//                           frozen universe constants), not behaviour
//   BLESSED_BEHAVIOURAL   — an architect-blessed behavioural site (empty
//                           post-cutover: the old blessed projection site
//                           died with its file; a new blessed entry requires
//                           architectural adjudication)
//   DRIFT_REPORTED        — behavioural sites pending adjudication (empty
//                           post-cutover: every old drift site died with its
//                           file; NEW drift is red until adjudicated)
//
// EK-8 PRUNING NOTE (2026-08-26): 21 register entries whose files were
// DELETE-classified left with their files (4 BENIGN in validate-process-
// module.ts, 2 BLESSED in sqlite-production-cell-projection-persistence.ts,
// 15 DRIFT across tools/app/lifecycles) — counts updated in the same commit.
//
// IF THIS TEST GOES RED you added a behavioural branch on a workshop/stage
// name — stop; that is a kernel-genericity decision (ADR-082, CONVEYOR §3);
// escalate it instead of widening the registers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Source with comments blanked but line numbers PRESERVED (block comments are
 * replaced by spaces, line comments emptied). A ratchet must judge code, not
 * prose about it — keeping line numbers so failure output points at the line.
 */
const readCodeLines = (absPath) => readFileSync(absPath, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/gm, '$1')
  .split(/\r?\n/);

/** Every production .ts file of the post-cutover tree (src/workflow-kernel). */
function listKernelTypeScriptFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
        out.push({ abs, rel });
      }
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  return out;
}

// ---------------------------------------------------------------------------
// General behavioural scan: no workshop/stage-name branch outside the
// registers. Three registers with three different meanings (header above).
// ---------------------------------------------------------------------------

const NAMES = String.raw`(?:discovery|formalization|development|delivery|initial-discovery|solution-formalization|solution-development|delivery-release|factory\.discovery)`;

const PREDICATES = [
  ['P1:name-equality',
    new RegExp(String.raw`(?:===|!==)\s*'${NAMES}'|'${NAMES}'\s*(?:===|!==)`)],
  ['P2:name-array-includes',
    new RegExp(String.raw`\[[^\]]*'${NAMES}'[^\]]*\]\s*\.\s*(?:includes|indexOf)\s*\(`)],
  ['P2b:name-array-declaration',
    new RegExp(String.raw`(?:const|let)\s+\w+[^=\n]*=\s*\[[^\]]*'${NAMES}'`)],
  ['E:bare-name-element',
    new RegExp(String.raw`^\s*'${NAMES}'\s*,?\s*$`)],
  ['P3:sql-stage-filter',
    new RegExp(String.raw`(?:stage_id|workflow_stage|module_ref_key|module_ref)\s*=\s*'${NAMES}'`)],
  ['P4a:constant-member-identity',
    new RegExp(String.raw`[A-Z][A-Z0-9_]{3,}\.(?:name|kind|version|id)\b[^;\n]{0,120}(?:===|!==)|(?:===|!==)[^;\n]{0,120}[A-Z][A-Z0-9_]{3,}\.(?:name|kind|version|id)\b`)],
  ['P4b:refs-set-gate',
    new RegExp(String.raw`[A-Z][A-Z0-9_]{3,}_REFS?\s*\.\s*has\s*\(`)],
];

const BENIGN_NAME_DATA = [
  // 2026-08-26 EK-wave admissions (deliberate, same commit as the merge that
  // introduced them — the guard is a ratchet, not a wall):
  // (a) WP-18 accountant: the counter-identity pin check is a fail-closed
  //     identity comparison (TOKEN_COUNTER_MISMATCH), not a workshop/stage
  //     branch — the P4a heuristic cannot tell constants apart.
  { file: 'src/workflow-kernel/context-envelope/accountant.ts', anchor: 'pin.name === RUNNING_COUNTER_IDENTITY.name &&', why: 'counter-identity pin check (fail-closed TOKEN_COUNTER_MISMATCH) — identity comparison of the pinned token counter, not a workshop/stage branch' },
  // (b) WP-05 lifecycle-run reducer: the four routeOutcome edges are the EK-1
  //     frozen transition-universe DATA (obligation:enterStage.* pinned in
  //     docs/refactoring/event-kernel/reconciliation/transition-universe.json);
  //     the names ARE the register.
  { file: 'src/workflow-kernel/domain/reducers/lifecycle-run.ts', anchor: "input.stageRoute === 'initial-discovery'", why: 'EK-1 frozen transition-universe data: routeOutcome edge over the frozen stage route (obligation:enterStage.initial-discovery)' },
  { file: 'src/workflow-kernel/domain/reducers/lifecycle-run.ts', anchor: "input.stageRoute === 'solution-formalization'", why: 'EK-1 frozen transition-universe data: routeOutcome edge over the frozen stage route (obligation:enterStage.solution-formalization)' },
  { file: 'src/workflow-kernel/domain/reducers/lifecycle-run.ts', anchor: "input.stageRoute === 'solution-development'", why: 'EK-1 frozen transition-universe data: routeOutcome edge over the frozen stage route (obligation:enterStage.solution-development)' },
  { file: 'src/workflow-kernel/domain/reducers/lifecycle-run.ts', anchor: "input.stageRoute === 'delivery-release'", why: 'EK-1 frozen transition-universe data: routeOutcome edge over the frozen stage route (obligation:enterStage.delivery-release)' },
];

const BLESSED_BEHAVIOURAL = [
  // Empty post-cutover (2026-08-26): the audit-blessed linkType site
  // (sqlite-production-cell-projection-persistence.ts) was DELETE-classified
  // and is gone. A new blessed entry requires architectural adjudication —
  // never add one to make a red scan green.
];

const DRIFT_REPORTED = [
  // Empty post-cutover (2026-08-26): every pre-cutover drift site
  // (tools/tasks.ts, app/factory-continuation.ts, the lifecycle derivations)
  // died with its file. New behavioural sites are RED until adjudicated.
];

// Post-cutover frozen counts (EK-8 pruning: benign 9 -> 5, blessed 2 -> 0,
// drift 15 -> 0; the 21 pruned entries' files were DELETE-classified).
const FROZEN_REGISTER_COUNTS = { benign: 5, blessed: 0, drift: 0 };

test('the kernel never branches on a workshop/stage name outside the registers (kernel-genericity, ADR-082 / CONVEYOR §3)', () => {
  const registers = [
    ...BENIGN_NAME_DATA.map((e) => ({ ...e, register: 'BENIGN_NAME_DATA' })),
    ...BLESSED_BEHAVIOURAL.map((e) => ({ ...e, register: 'BLESSED_BEHAVIOURAL' })),
    ...DRIFT_REPORTED.map((e) => ({ ...e, register: 'DRIFT_REPORTED' })),
  ];
  const claims = new Map(registers.map((e) => [e, 0]));

  const unclaimed = [];
  for (const { abs, rel } of listKernelTypeScriptFiles()) {
    readCodeLines(abs).forEach((line, i) => {
      if (!PREDICATES.some(([, re]) => re.test(line))) return;
      const entry = registers.find((e) => e.file === rel && line.includes(e.anchor));
      if (!entry) {
        unclaimed.push(`  ${rel}:${i + 1}: ${line.trim()}`);
        return;
      }
      claims.set(entry, claims.get(entry) + 1);
    });
  }

  assert.deepEqual(unclaimed, [],
    `new workshop/stage-name branch(es) outside the registers (kernel-genericity, ADR-082 / CONVEYOR §3 — escalate, do not widen):\n${unclaimed.join('\n')}`);

  const stale = registers.filter((e) => claims.get(e) === 0)
    .map((e) => `  [${e.register}] ${e.file} :: ${e.anchor}`);
  assert.deepEqual(stale, [],
    `register entries that no longer claim any line (stale — remove or re-anchor them):\n${stale.join('\n')}`);

  const overclaimed = registers.filter((e) => claims.get(e) > 1)
    .map((e) => `  [${e.register}] ${e.file} :: ${e.anchor} claimed ${claims.get(e)} lines`);
  assert.deepEqual(overclaimed, [],
    `register anchors must be unique per file — one anchor claimed several hit lines:\n${overclaimed.join('\n')}`);

  assert.equal(BENIGN_NAME_DATA.length, FROZEN_REGISTER_COUNTS.benign);
  assert.equal(BLESSED_BEHAVIOURAL.length, FROZEN_REGISTER_COUNTS.blessed);
  assert.equal(DRIFT_REPORTED.length, FROZEN_REGISTER_COUNTS.drift,
    'the DRIFT_REPORTED register changed: entries leave only by architectural adjudication (see header)');
});
