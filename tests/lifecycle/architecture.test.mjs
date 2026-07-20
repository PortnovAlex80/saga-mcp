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
// 3. Boundary check: lifecycle UPDATE confined to src/lifecycle/** (ADR-013 §3.2).
// ---------------------------------------------------------------------------
// Pre-3.2 this test was a 13-file whitelist: 'these files are allowed to
// mutate task lifecycle, all others are forbidden'. A whitelist is weak —
// adding a new writer is a one-line change to SANCTIONED with no force
// pushing the writer into the lifecycle layer.
//
// Post-3.2 the assertion is inverted: lifecycle UPDATE (status / assigned_to
// / integration_state / current_execution_id mutation) is allowed ONLY in
// src/lifecycle/**. Every other file that contains such an UPDATE must be
// listed in TEMPORARY_EXCEPTIONS with a TODO(phase) tag and a short reason.
// The test fails on any new exception that is not explicitly acknowledged.
//
// The exceptions list is the migration surface for Phase 4 (application
// service / command bus). Each entry should disappear as the corresponding
// handler is rewritten to call into src/lifecycle/application-service.ts.

test('architecture: lifecycle UPDATE confined to src/lifecycle/** (boundary, not whitelist)', () => {
  // Files that legitimately still write lifecycle fields outside the kernel.
  // Each entry MUST carry a TODO(phase) tag so it shows up in the migration
  // backlog. Adding an entry without a TODO is a test failure.
  const TEMPORARY_EXCEPTIONS = new Map([
    // Phase 4.1 — these handlers will become thin adapters to the command bus.
    ['src/tools/dispatcher.ts', 'TODO(4.1): worker_next/worker_done/ask/merge move to application-service'],
    ['src/tools/tasks.ts', 'TODO(4.1): evaluateAndUpdateDependencies moves to lifecycle/reconciler'],
    ['src/orchestrate.ts', 'TODO(4.1): recoverAssignment delegates to atomic-release already, but still contains UPDATE tasks SET status'],
    ['src/worker-executions.ts', 'TODO(4.1): markExecutionRunning still writes state=running directly; only terminalization was unified in 3.1'],
  ]);

  // Every lifecycle mutation we consider boundary-worthy. status/assigned_to
  // were the original patterns; current_execution_id and integration_state
  // are part of the same fence/lifecycle and should also be confined.
  const FORBIDDEN_PATTERNS = [
    /UPDATE\s+tasks\s+SET\s+status\s*=/i,
    /UPDATE\s+tasks\s+SET[^=]*assigned_to\s*=/i,
    /UPDATE\s+tasks\s+SET[^=]*integration_state\s*=/i,
    /UPDATE\s+tasks\s+SET[^=]*current_execution_id\s*=/i,
  ];

  const allTs = listFiles(SRC, isTs);
  const violations = [];
  const staleExceptions = new Set(TEMPORARY_EXCEPTIONS.keys());

  for (const file of allTs) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    // Anything under src/lifecycle/** is the kernel — always allowed.
    if (rel.startsWith('src/lifecycle/')) continue;
    // Read once, scan for any forbidden pattern.
    const src = readFileSync(file, 'utf8');
    const matches = FORBIDDEN_PATTERNS
      .filter((p) => p.test(src))
      .map((p) => p.source);
    if (matches.length === 0) continue;

    if (TEMPORARY_EXCEPTIONS.has(rel)) {
      // Acknowledged exception — verify it carries a TODO tag (enforces
      // that new entries are deliberate, not silent).
      const tag = TEMPORARY_EXCEPTIONS.get(rel);
      if (!/TODO\(|NOT-ADR-013/.test(tag)) {
        violations.push(
          `${rel}: exception lacks TODO(phase) or NOT-ADR-013 tag (got: "${tag}")`,
        );
      }
      staleExceptions.delete(rel);
      continue;
    }
    violations.push(`${rel}: matches ${matches.map((m) => `/${m}/`).join(', ')}`);
  }

  // Any TEMPORARY_EXCEPTIONS entry that no longer matches a real file (or
  // no longer contains the forbidden pattern) is a stale exception — remove
  // it. This makes the migration forward-visible: when Phase 4.1 lands and
  // the handler stops writing lifecycle fields, the exception must go too.
  if (staleExceptions.size > 0) {
    violations.push(
      `stale TEMPORARY_EXCEPTIONS (file no longer contains lifecycle UPDATEs — remove the entry): ${[...staleExceptions].join(', ')}`,
    );
  }

  assert.deepEqual(
    violations, [],
    `lifecycle UPDATE must live in src/lifecycle/**. Found violations:\n${violations.join('\n')}`,
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
    'invariant-scanner.ts',
    'work-item-repository.ts',
    'compatibility-projector.ts',
    'backfill-migration.ts',
    'integration-executor.ts',
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
  const skillPath = path.join(ROOT, 'skills', 'saga-worker', 'SKILL.md');
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
