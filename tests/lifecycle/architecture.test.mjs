/**
 * Slice 7 — architectural invariants (static source checks).
 *
 * Source: blueprint §18 Architecture (docs/architecture/passive-worker-kernel-blueprint.md:1117-1124),
 *         §16 Slice 7 acceptance (line 934-939).
 *
 * These are static source-code checks — they read .ts files from src/lifecycle/
 * and verify forbidden patterns are absent. They do NOT execute the code; they
 * guard against regression.
 *
 * Why: as the refactor progresses, a careless import could pull SQLite or Node
 * into the pure domain module, breaking the functional-core/imperative-shell
 * separation. A careless UPDATE could re-introduce the task_batch_update bypass
 * pattern. These tests fail loudly the moment such a regression lands.
 *
 * Coverage (blueprint §18:1117-1124):
 *   1. domain imports no infrastructure (no better-sqlite3, no node:*, no ../tools,
 *      no ../db, no ../worker-executions);
 *   2. all lifecycle unions use exhaustive assertNever (verified by the compiler
 *      in strict mode — this test confirms the helper is exported and used);
 *   3. no direct lifecycle UPDATE outside projector/migrations (search src/ for
 *      UPDATE tasks SET status=... patterns and confirm they only appear in
 *      the sanctioned files);
 *   4. managed worker prompt contract (verified via skill file — see below).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const DOMAIN = path.join(SRC, 'lifecycle', 'domain');

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function listFiles(dir, predicate = () => true, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      listFiles(full, predicate, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function readSrc(rel) {
  return readFileSync(path.join(SRC, rel), 'utf8');
}

const isTs = (f) => f.endsWith('.ts');

// ---------------------------------------------------------------------------
// 1. Domain imports no infrastructure (blueprint §18:1119, §20:1145).
// ---------------------------------------------------------------------------

test('architecture: src/lifecycle/domain/** imports no infrastructure', () => {
  const domainFiles = listFiles(DOMAIN, isTs);
  assert.ok(domainFiles.length >= 8, `expected ≥8 domain files, found ${domainFiles.length}`);

  const FORBIDDEN_PATTERNS = [
    /from\s+['"]better-sqlite3['"]/,
    /from\s+['"]node:/,             // any node:* builtin
    /from\s+['"]\.\.\/db(\.js)?['"]/,
    /from\s+['"]\.\.\/\.\.\/db(\.js)?['"]/,
    /from\s+['"]\.\.\/tools\//,
    /from\s+['"]\.\.\/\.\.\/tools\//,
    /from\s+['"]\.\.\/worker-executions(\.js)?['"]/,
    /from\s+['"]\.\.\/\.\.\/worker-executions(\.js)?['"]/,
    /import\s+type\s+\{[^}]*\}\s+from\s+['"]better-sqlite3['"]/,
  ];

  const violations = [];
  for (const file of domainFiles) {
    const src = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(src)) {
        violations.push(`${path.relative(ROOT, file)}: matches /${pattern.source}/`);
      }
    }
  }

  assert.deepEqual(
    violations, [],
    `domain module MUST be pure TS. Found forbidden imports:\n${violations.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// 2. assertNever exported and used in domain (blueprint §18:1122).
// ---------------------------------------------------------------------------

test('architecture: assertNever is exported from domain and used in switches', () => {
  const stateSrc = readSrc(path.join('lifecycle', 'domain', 'state.ts'));
  assert.match(stateSrc, /export function assertNever/, 'assertNever is exported from state.ts');

  // evolve.ts must use it in its default branch.
  const evolveSrc = readSrc(path.join('lifecycle', 'domain', 'evolve.ts'));
  assert.match(evolveSrc, /assertNever/, 'evolve.ts uses assertNever');
});

// ---------------------------------------------------------------------------
// 3. No direct lifecycle UPDATE outside sanctioned files (blueprint §18:1120).
// ---------------------------------------------------------------------------

test('architecture: no direct lifecycle UPDATE outside sanctioned writers', () => {
  // Lifecycle UPDATE patterns we want to confine. Each is a status/assigned_to/
  // integration_state mutation. They are allowed ONLY in:
  //   - src/lifecycle/**         (projector, atomic-release, etc.)
  //   - src/tools/dispatcher.ts  (worker_next/worker_done/ask/merge lifecycle tools)
  //   - src/tools/tasks.ts       (evaluateAndUpdateDependencies — the reconciler)
  //   - src/db.ts                (migrations)
  //   - src/schema.ts            (DDL only, no UPDATE — included for completeness)
  //   - src/tools/lifecycle.ts   (verification_record; saga4 cutover removed
  //   - src/orchestrate.ts       (engine recovery — recoverAssignment)
  //   - tracker-view/**          (recoverRunnerAssignment)
  //
  // The blacklist: activity.ts MUST NOT mutate status/assigned_to (Slice 3 fix).
  //
  // We look for the specific patterns and assert they don't appear in
  // non-sanctioned files.

  const SANCTIONED = new Set([
    'src/lifecycle/atomic-release.ts',
    'src/lifecycle/idempotency.ts',
    'src/lifecycle/unfenced-assignment-recovery.ts',
    // Sanctioned atomic-assignment writer (WorkAssignmentPort core). The
    // UPDATE tasks here is the claim primitive shared by worker_next and the
    // dispatcher; it is legitimate because:
    //   1. CAS guard — both branches gate on status AND assigned_to NULL/empty:
    //        todo       -> WHERE id=? AND status='todo'
    //                        AND (assigned_to IS NULL OR assigned_to = '')
    //        review     -> WHERE id=? AND status='review'
    //                        AND (assigned_to IS NULL OR assigned_to = '')
    //      so a stale claim races no one (info.changes !== 1 => retry).
    //   2. Fence — every claim stamps current_execution_id on the row, fixing
    //      the live execution identity for all downstream worker_* calls.
    //   3. Atomicity — findNextClaimable is only ever invoked inside
    //      withImmediateTransaction (BEGIN IMMEDIATE), and the INSERT into
    //      worker_executions runs in that same transaction (all-or-nothing).
    //   4. Transition correctness — only legal claim transitions are emitted:
    //      todo -> in_progress, review -> review_in_progress.
    'src/lifecycle/work-assignment-core.ts',
    'src/tools/dispatcher.ts',
    'src/tools/tasks.ts',
    'src/tools/lifecycle.ts',
    'src/db.ts',
    'src/orchestrate.ts',
    'src/worker-executions.ts',
    // Conveyor v4 step 5.2 cutover: WorkplaceProjector.reverseProjectWorkplaceToTask
    // writes tasks.status as the one-way reverse projection of the authoritative
    // factory_workplaces.kanbanPhase (REG-06). Sanctioned because it IS the projection
    // writer — the single-writer invariant evolves so tasks.status is owned by
    // the projection, not by hand-written claim/release SQL.
    'src/infrastructure/projections/workplace-projector.ts',
    // Operator/recovery writers. Both are deliberate, CAS-guarded reconciliation
    // paths of the same class as unfenced-assignment-recovery and engine
    // recovery: they do not decide quality or advance a Flow, they release or
    // cancel a projection whose owning execution is provably gone.
    //   - operator-soft-stop: the operator brake releases a card (clears
    //     assignment, fence and worker pid) so a stopped worker cannot keep a
    //     task hostage.
    //   - engine-start-lifecycle-burial: burying a dead LifecycleRun cancels its
    //     still-nonterminal cards, guarded by `AND status IN (...)`.
    'src/app/operator-soft-stop.ts',
    'src/app/engine-start-lifecycle-burial.ts',
    // STAGE-13: the designed cycle-2 supersede drain (REPLAN-CYCLE-TZ §5) —
    // transactional, one-way, guarded by `AND status IN (...)`, CAS revision
    // bump on the drained projection. Its scope-trajectory trigger was removed
    // by stage-13 TASK 2 (scope widening is now THE lawful transition; one
    // mechanism for one event); the writer stays sanctioned as the drain for
    // any future explicitly-mandated re-plan cycle.
    'src/modules/development/application/replan-supersede.ts',
    // REG-28 (2026-08-25, W2): the settlement drain cancels anonymous
    // todo/queued projections at process settlement — same sanctioned class
    // as replan-supersede and lifecycle burial: transactional (runs INSIDE
    // the GenericFlowExecutor settlement transaction via sharedDeps.
    // settleDrain), one-way (todo/queued -> cancelled only), closed
    // terminal_reason vocabulary, CAS revision bump per row, result
    // recorded in task metadata, typed §23 parks protected, idempotent on
    // re-settlement. Regression: tests/process-modules/
    // reg28-kanban-drain-at-settlement.test.mjs (4 tests) plus the
    // kanban-drain oracle on both terminal scenario drives.
    'src/process-modules/infrastructure/workplace-settlement-drain.ts',
  ]);

  const FORBIDDEN_PATTERNS = [
    /UPDATE\s+tasks\s+SET\s+status\s*=/i,
    /UPDATE\s+tasks\s+SET[^=]*assigned_to\s*=/i,
  ];

  // Walk all .ts under src/ except the sanctioned list.
  const allTs = listFiles(SRC, isTs);
  const violations = [];
  for (const file of allTs) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (SANCTIONED.has(rel)) continue;
    const src = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(src)) {
        violations.push(`${rel}: matches /${pattern.source}/`);
      }
    }
  }

  assert.deepEqual(
    violations, [],
    `direct lifecycle UPDATE forbidden outside sanctioned writers. Found:\n${violations.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// 4. task_batch_update does NOT accept status or assigned_to (Slice 3 fix).
// ---------------------------------------------------------------------------

test('architecture: task_batch_update schema rejects status and assigned_to', () => {
  const src = readSrc(path.join('tools', 'activity.ts'));
  // Extract the full tool definition — from `name: 'task_batch_update'` to the
  // next `name:` or end of the definitions array. Use a greedy approach: find
  // the start, then slice until the closing `}` at column 2.
  const startMatch = src.match(/name:\s*'task_batch_update'/);
  assert.ok(startMatch, 'task_batch_update tool definition found');
  const startIdx = startMatch.index;
  // Find the end: the next `name: '` after this point (start of next tool def),
  // or end-of-file.
  const rest = src.slice(startIdx);
  const nextToolIdx = rest.slice(1).search(/name:\s*'/);
  const block = nextToolIdx >= 0 ? rest.slice(0, nextToolIdx + 1) : rest;

  assert.doesNotMatch(
    block,
    /\bstatus\s*:\s*\{[^}]*enum/i,
    'task_batch_update MUST NOT accept status (Slice 3 audit fix)',
  );
  assert.doesNotMatch(
    block,
    /\bassigned_to\s*:\s*\{/i,
    'task_batch_update MUST NOT accept assigned_to (Slice 3 audit fix)',
  );
  // And priority must still be present (the only legal field).
  assert.match(block, /priority\s*:\s*\{[^}]*enum/i, 'task_batch_update still accepts priority');
});

// ---------------------------------------------------------------------------
// 5. worker_ask_need is documented as terminal (Slice 3 fix).
// ---------------------------------------------------------------------------

test('architecture: worker_ask_need tool description documents terminal semantics', () => {
  const src = readSrc(path.join('tools', 'dispatcher.ts'));
  const toolBlock = src.match(/name:\s*'worker_ask_need'[\s\S]*?inputSchema:\s*\{[\s\S]*?\}\s*,\s*\}/);
  assert.ok(toolBlock, 'worker_ask_need tool definition found');
  const block = toolBlock[0];
  assert.match(block, /TERMINAL/i, 'description documents terminal semantics');
  assert.match(block, /stop:\s*true|stop:true/i, 'description mentions stop:true');
});

test('architecture: worker_ask_done tool description documents no-execution-id', () => {
  const src = readSrc(path.join('tools', 'dispatcher.ts'));
  const toolBlock = src.match(/name:\s*'worker_ask_done'[\s\S]*?inputSchema:\s*\{[\s\S]*?\}\s*,\s*\}/);
  assert.ok(toolBlock, 'worker_ask_done tool definition found');
  const block = toolBlock[0];
  assert.match(block, /answer/i, 'requires answer');
  // execution_id should NOT be in required (it is OK as optional, but the
  // description must document that it is not required).
  assert.match(block, /execution_id/i, 'execution_id mentioned in description');
});

// ---------------------------------------------------------------------------
// 6. Pure-TS modules exist where expected (regression guard).
// ---------------------------------------------------------------------------

test('architecture: lifecycle domain modules exist (regression guard)', () => {
  const expected = [
    'ids.ts', 'state.ts', 'commands.ts', 'events.ts', 'effects.ts',
    'decode.ts', 'evolve.ts', 'invariants.ts', 'index.ts',
  ];
  for (const name of expected) {
    const full = path.join(DOMAIN, name);
    assert.ok(existsSync(full), `${name} exists in src/lifecycle/domain/`);
  }
});

test('architecture: lifecycle infrastructure modules exist (regression guard)', () => {
  const expected = [
    'atomic-release.ts',
    'payload-hash.ts',
    'idempotency.ts',
  ];
  for (const name of expected) {
    const full = path.join(SRC, 'lifecycle', name);
    assert.ok(existsSync(full), `${name} exists in src/lifecycle/`);
  }
});

// ---------------------------------------------------------------------------
// 7. SKILL.md ASK section documents terminal semantics.
// ---------------------------------------------------------------------------

test('architecture: saga-worker SKILL.md documents ASK as terminal', () => {
  // W13-A2 (commit 5f7a1e1) migrated the saga-worker skill out of the repo's
  // top-level skills/ tree into the development Process Module package
  // resources. This is unrelated to the saga4 episode_transition cutover; the
  // path is updated here to follow the migration.
  const skillPath = path.join(
    SRC, 'process-modules', 'modules', 'development', 'package', 'resources',
    'skills', 'saga-worker', 'SKILL.md',
  );
  const src = readFileSync(skillPath, 'utf8');
  // The Slice 3 rewrite replaced the obsolete 'STAYS with you' instruction.
  assert.doesNotMatch(
    src,
    /the task STAYS with you/i,
    'obsolete "STAYS with you" instruction removed (Slice 3 SKILL/runtime drift fix)',
  );
  assert.match(src, /TERMINAL/i, 'ASK section documents terminal semantics');
  assert.match(src, /stop:\s*true/i, 'ASK section mentions stop:true');
});
