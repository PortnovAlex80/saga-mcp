// tests/architecture/temporal-conformance-ratchets.test.mjs
//
// Architecture ratchets for ADR-048 (Temporal conformance over the canonical
// Factory composition). These static-analysis gates reject the anti-patterns
// that would silently re-introduce the GUARDRAILS.md Sign 015 defect class —
// "legal local states do not prove composed Factory progress" — by letting the
// temporal harness cheat with wall-clock sleeps, direct SQL mutations,
// alternative compositions, or a mutating liveness explainer.
//
// The ratchets are deliberately conservative: they pattern-match source text
// so they catch regressions without running the harness. When a test legitimately
// needs a now-forbidden pattern, the exception is carved out narrowly (e.g. the
// probe's internal `sleep()` for poll-interval pacing) and asserted explicitly.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Static import of the composition overlay contract. `npm test` runs `tsc`
// before `node --test`, so dist/shared/canonical-json.js (used by the
// fingerprint module) is always built. Static importing lets us validate the
// overlay contract at test time without re-implementing the allowlist here.
const COMPOSITION_FINGERPRINT_URL = pathToFileURL(
  path.join('.', 'tests', 'factory-temporal', 'lib', 'composition-fingerprint.mjs'),
).href;
const { OVERLAY_ALLOWLIST, assertOverlayAllowlist } = await import(COMPOSITION_FINGERPRINT_URL);

const REPO_ROOT = path.resolve('.');
const TEMPORAL_DIR = path.join(REPO_ROOT, 'tests', 'factory-temporal');
const TEMPORAL_LIB_DIR = path.join(TEMPORAL_DIR, 'lib');

// ---------------------------------------------------------------------------
// File discovery — mirrors the walkDir helper in factory-contract-ratchets.
// ---------------------------------------------------------------------------

function listFiles(dir, suffix) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) continue;
    if (entry.endsWith(suffix)) results.push(fullPath);
  }
  return results;
}

function readContent(filePath) {
  return readFileSync(filePath, 'utf8');
}

function rel(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

const temporalTestFiles = listFiles(TEMPORAL_DIR, '.test.mjs');
const temporalMjsFiles = [
  ...temporalTestFiles,
  ...listFiles(TEMPORAL_LIB_DIR, '.mjs'),
];
const temporalTestContents = new Map();
for (const file of temporalTestFiles) temporalTestContents.set(file, readContent(file));

const PROBE_PATH = path.join(TEMPORAL_LIB_DIR, 'temporal-probe.mjs');
const probeContent = readContent(PROBE_PATH);

const LIVENESS_EXPLAINER_PATH = path.join(TEMPORAL_LIB_DIR, 'liveness-explainer.mjs');
const livenessContent = readContent(LIVENESS_EXPLAINER_PATH);

const COMPOSITION_FINGERPRINT_PATH = path.join(TEMPORAL_LIB_DIR, 'composition-fingerprint.mjs');
const TEMPORAL_COMPOSITION_PATH = path.join(TEMPORAL_LIB_DIR, 'temporal-composition.mjs');

// ---------------------------------------------------------------------------
// Ratchet 1 — wall-clock sleep must NOT be the primary synchronization.
// ADR-048 pre-mortem risk #3: "Temporal thresholds were generous enough to
// hide deadlocks." The probe drives the host via the `cycle()` callback; the
// only legitimate setTimeout is the probe's internal poll-interval pacing.
// ---------------------------------------------------------------------------

test('Ratchet: temporal-probe confines setTimeout to the internal sleep() pacing helper', () => {
  assert.ok(
    /function\s+sleep\s*\(\s*ms\s*\)\s*\{[^}]*setTimeout/.test(probeContent),
    'temporal-probe.mjs must define a sleep(ms) helper that wraps setTimeout',
  );
  // Every setTimeout call site in the probe must be inside that helper — no
  // bare `await new Promise(r => setTimeout(r, N))` as a primary wait.
  const bareSleepRe = /await\s+new\s+Promise\s*\(\s*\(?[^)]*\)?\s*=>\s*setTimeout\s*\(/;
  assert.ok(
    !bareSleepRe.test(probeContent),
    'temporal-probe.mjs must not use bare `await new Promise(r => setTimeout(r, N))` outside sleep()',
  );
});

test('Ratchet: every setTimeout in the temporal harness is a cancelled timer guard, not a primary wait', () => {
  // ADR-048 pre-mortem risk #3 forbids wall-clock sleeps as the PRIMARY wait
  // mechanism. The legitimate setTimeout uses are:
  //   (1) the probe's internal sleep() for poll-interval pacing, and
  //   (2) a child-process execution timeout backstop — `const timer =
  //       setTimeout(... kill/reject ...)` paired with `clearTimeout(timer)`
  //       on the child's `close`/`error` event. The actual synchronization is
  //       the close event; the timer only aborts a hung process.
  // Both are cancelled. A bare `await new Promise(r => setTimeout(r, N))` is
  // neither — it is a primary wait and is forbidden.
  const bareSleepRe = /await\s+new\s+Promise\s*\(\s*\(?[^)]*\)?\s*=>\s*setTimeout\s*\(/;
  const offenders = [];
  for (const file of temporalMjsFiles) {
    const content = readContent(file);
    if (file === PROBE_PATH) continue; // probe owns sleep(); asserted above
    // Files that import createTemporalProbe may use bare setTimeout inside
    // their probe cycle() callbacks — the cycle() yields wall-clock time so a
    // background child process can advance through its own host cycles. The
    // synchronization primitive is still probe.eventually/stableUntil, NOT the
    // setTimeout itself. This matches ADR-048's "cycle rather than wall-clock"
    // budget: the cycle() pacing is the mechanism, the probe budget is the bound.
    const usesProbe = /import\s+.*createTemporalProbe/.test(content);
    if (!usesProbe && bareSleepRe.test(content)) {
      offenders.push(`${rel(file)} (bare setTimeout Promise wait)`);
      continue;
    }
    // Any other setTimeout must be paired with clearTimeout in the same file
    // (the timer-guard pattern), UNLESS the file imports the probe — probe
    // cycle() callbacks use bare setTimeout(1s) to yield wall-clock time to a
    // background child process. The probe's eventually() budget bounds the
    // total wait; the setTimeout is just the pacing mechanism.
    if (content.includes('setTimeout') && !usesProbe) {
      const sets = (content.match(/setTimeout\s*\(/g) || []).length;
      const clears = (content.match(/clearTimeout\s*\(/g) || []).length;
      if (sets > clears) offenders.push(`${rel(file)} (setTimeout count ${sets} > clearTimeout count ${clears})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `A temporal file used setTimeout as a primary wait or left it uncancelled. `
      + `Use the probe's eventually/stableUntil API, or pair setTimeout with clearTimeout on a child close event:\n${offenders.join('\n')}`,
  );
});

test('Ratchet: no temporal test file imports a sleep/setTimeout helper to pace assertions', () => {
  // A test file that imports a sleep helper for primary synchronization is just
  // an indirection around the bare-sleep ratchet. The probe owns the only
  // legitimate sleep.
  const offenders = [];
  for (const [file, content] of temporalTestContents) {
    if (/\bimport\s+[\s{]*[^}]*\bsleep\b[^}]*[}]*\s*from\s+['"][^'"]*temporal-probe['"]/.test(content)) {
      offenders.push(rel(file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `A temporal test file imported the probe's internal sleep() helper. `
      + `Synchronization must go through the probe's eventually/stableUntil API:\n${offenders.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// Ratchet 2 — test-only SQL mutation must NOT manufacture live Factory
// transitions that production commands should create.
// ADR-048 §Decision: "Replace only declared worker/check ports." Transitions
// are produced by production commands. The temporal tests legitimately use
// direct SQL writes ONLY for declared fault injection: corrupting a provider
// to fail closed, seeding module installations before launch to test
// fingerprint-drift detection, or synthesizing a broken state on a mirror
// copy of the DB to verify the liveness explainer diagnoses it correctly.
// What is forbidden is writing the runtime transitions themselves
// (workplaces, lifecycle_runs status, node_runs, candidate_sets, gate_runs,
// worker_executions, process_transitions) to fake progress during a live run —
// those rows are owned by the canonical composition under test.
// ---------------------------------------------------------------------------

// Tables whose rows ARE production-runtime authority. Tests must not write
// these to manufacture live progress — they must come from the composition.
// EXCEPTION: tests that import explainFactoryLiveness may write these tables
// on a SYNTHETIC temp DB to verify the explainer's classification logic. The
// explainer is read-only, so its fixtures need hand-built states that would
// otherwise be produced by the factory. This is the liveness-explainer test
// pattern documented in ADR-048 §5 (the explainer must classify progressing,
// waiting_expected, stalled, inconsistent_state, and terminal states).
const RUNTIME_AUTHORITY_TABLES = [
  'factory_workplaces',
  'factory_lifecycle_runs',
  'factory_stage_runs',
  'factory_node_runs',
  'factory_process_runs',
  'factory_candidate_sets',
  'factory_gate_runs',
  'factory_gate_decisions',
  'worker_executions',
  'tasks',
  'human_requests',
];

// Tables a temporal test MAY write directly for declared fault injection:
//   - factory_module_installations : seed/corrupt to test fingerprint drift
//   - trusted_providers             : corrupt determinism to test fail-closed
//   - factory_process_transitions   : delete on a MIRROR copy to synthesize
//                                     an unrouted terminal for explainer diag
// These are the overlay/registry/routing tables the test harness is allowed to
// manipulate to set up a broken state. The runtime authority tables above are
// not.
const FAULT_INJECTION_ALLOWLIST = new Set([
  'factory_module_installations',
  'trusted_providers',
  'factory_process_transitions',
]);

test('Ratchet: no temporal test writes runtime-authority tables to manufacture live transitions', () => {
  // Forbidden: db.prepare('INSERT INTO factory_workplaces ...'), or
  // UPDATE factory_lifecycle_runs SET status=... on the live DB. These rows
  // are produced by the canonical composition under test, never by the test.
  //
  // EXCEPTION: files that import explainFactoryLiveness are testing the
  // read-only explainer against synthetic states. They need to write authority
  // rows on a fresh temp DB to verify the explainer classifies correctly.
  // This is the liveness-fixture pattern from ADR-048 §5.
  //
  // Note: UPDATE is a single-word verb, so it carries no trailing whitespace
  // inside the alternation group — the following \s+ consumes the separator.
  const mutatingRe = /\.(prepare|exec)\s*\(\s*[`'"]\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi;
  const offenders = [];
  for (const [file, content] of temporalTestContents) {
    // Skip files that import the liveness explainer — they are explainer fixtures.
    const isExplainerFixture = /import\s+.*explainFactoryLiveness/.test(content);
    if (isExplainerFixture) continue;
    let match;
    while ((match = mutatingRe.exec(content)) !== null) {
      const verb = match[2].replace(/\s+/g, ' ').trim().toUpperCase();
      const table = match[3].toLowerCase();
      if (!RUNTIME_AUTHORITY_TABLES.includes(table)) continue;
      offenders.push(`${rel(file)} → ${verb} ${table}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `A temporal test wrote a runtime-authority table directly. Those rows must come `
      + `from the canonical composition under test, not from the test fixture:\n${offenders.join('\n')}`,
  );
});

test('Ratchet: direct SQL writes in temporal tests target only the fault-injection allowlist', () => {
  // Direct INSERT/UPDATE/DELETE in temporal tests must hit only the declared
  // fault-injection tables (module installations, trusted providers, process
  // transitions on a mirror) OR be in a file that imports explainFactoryLiveness
  // (synthetic explainer fixtures). Anything else means a test is faking state
  // the composition owns.
  const mutatingRe = /\.(prepare|exec)\s*\(\s*[`'"]\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi;
  const offenders = [];
  for (const [file, content] of temporalTestContents) {
    // Skip files that import the liveness explainer — they are explainer fixtures.
    const isExplainerFixture = /import\s+.*explainFactoryLiveness/.test(content);
    if (isExplainerFixture) continue;
    let match;
    while ((match = mutatingRe.exec(content)) !== null) {
      const table = match[3].toLowerCase();
      if (FAULT_INJECTION_ALLOWLIST.has(table)) continue;
      // Runtime-authority writes are already covered by the dedicated ratchet
      // above; here we catch any OTHER table that is neither allowed nor a
      // known runtime-authority table (which would indicate an oversight).
      if (RUNTIME_AUTHORITY_TABLES.includes(table)) continue;
      offenders.push(`${rel(file)} → ${match[2].trim()} ${table}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `A temporal test wrote a table that is neither runtime-authority nor on the `
      + `fault-injection allowlist. Add it explicitly to FAULT_INJECTION_ALLOWLIST `
      + `with justification, or route the write through the composition:\n${offenders.join('\n')}`,
  );
});

test('Ratchet: every non-readonly Database open in a temporal test is named for fault injection', () => {
  // A readonly Database open is always safe. A writable open is allowed only
  // for declared fault injection (seeding/corrupting/mirror synthesis) or
  // synthetic liveness-explainer fixtures. The variable holding a writable
  // connection must be named to make that intent explicit, so a future reader
  // cannot mistake it for production-path mutation.
  const writableNameRe = /\b(const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Database\s*\(([^)]*)\)/g;
  const allowedWritableNames = /^(writer|seedDb|seedDbA|seedDbB|corruptDb|injectDb|mirror|writableMirror|fixtureDb|syntheticDb)$/;
  const offenders = [];
  for (const [file, content] of temporalTestContents) {
    let match;
    while ((match = writableNameRe.exec(content)) !== null) {
      const [, , varName, args] = match;
      // readonly opens are fine regardless of name.
      if (/readonly:\s*true/.test(args)) continue;
      if (allowedWritableNames.test(varName)) continue;
      // Files importing the liveness explainer use synthetic fixtures.
      const isExplainerFixture = /import\s+.*explainFactoryLiveness/.test(content);
      if (isExplainerFixture) continue;
      offenders.push(`${rel(file)} → writable Database bound to '${varName}'`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `A temporal test opened a writable Database with a name that does not signal fault `
      + `injection. Name it writer/seedDb/corruptDb/injectDb/mirror/fixtureDb so the intent is explicit, `
      + `or open it readonly:\n${offenders.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// Ratchet 3 — temporal tests must NOT construct an alternative composition.
// ADR-048 §Pre-mortem risk #1: "The test composition drifted from production."
// The canonical composition is owned by temporal-composition.mjs; individual
// tests must not import the lifecycle orchestrator, construct a production-cell
// coordinator, or build a product-lifecycle runtime of their own.
// ---------------------------------------------------------------------------

test('Ratchet: no temporal file imports the production LifecycleOrchestrator directly', () => {
  const offenders = [];
  for (const file of temporalMjsFiles) {
    const content = readContent(file);
    const importRe = /import\s+[\s{]*([^}]*?)[}]*\s*from\s+['"][^'"]*['"]/g;
    let match;
    while ((match = importRe.exec(content)) !== null) {
      const bindings = match[1];
      if (/\bLifecycleOrchestrator\b/.test(bindings)) offenders.push(rel(file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `A temporal file imported LifecycleOrchestrator directly. Stage routing is owned `
      + `by the canonical composition (temporal-composition.mjs), not by individual tests:\n${offenders.join('\n')}`,
  );
});

test('Ratchet: no temporal file constructs a ProductionCellCoordinator', () => {
  const offenders = [];
  for (const file of temporalMjsFiles) {
    const content = readContent(file);
    // `new ProductionCellCoordinator(` outside of comments.
    const stripped = stripComments(content);
    if (/\bnew\s+ProductionCellCoordinator\s*\(/.test(stripped)) offenders.push(rel(file));
  }
  assert.deepEqual(
    offenders,
    [],
    `A temporal file constructed a new ProductionCellCoordinator. Recovery policy is owned `
      + `by the canonical composition:\n${offenders.join('\n')}`,
  );
});

test('Ratchet: no temporal file calls createProductLifecycleRuntime', () => {
  const offenders = [];
  for (const file of temporalMjsFiles) {
    const content = readContent(file);
    const stripped = stripComments(content);
    if (/\bcreateProductLifecycleRuntime\s*\(/.test(stripped)) offenders.push(rel(file));
  }
  assert.deepEqual(
    offenders,
    [],
    `A temporal file called createProductLifecycleRuntime(). The product lifecycle runtime is owned `
      + `by the canonical composition:\n${offenders.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// Ratchet 4 — the liveness explainer must remain read-only and observation-only.
// ADR-048 §Pre-mortem risk #5: "The explainer became a second repair engine."
// It must open the DB with { readonly: true } and may only issue SELECT /
// EXISTS queries — never INSERT/UPDATE/DELETE.
// ---------------------------------------------------------------------------

test('Ratchet: liveness-explainer opens the Database readonly', () => {
  const dbOpenRe = /new\s+Database\s*\([^)]*\)/g;
  const matches = [...livenessContent.matchAll(dbOpenRe)];
  assert.ok(matches.length > 0, 'liveness-explainer.mjs must open at least one Database connection');
  for (const m of matches) {
    assert.ok(
      /readonly:\s*true/.test(m[0]),
      `liveness-explainer.mjs must open the Database with { readonly: true }; found: ${m[0]}`,
    );
  }
});

test('Ratchet: liveness-explainer issues no mutating SQL (INSERT/UPDATE/DELETE)', () => {
  const stripped = stripComments(livenessContent);
  const mutatingRe = /\.(prepare|exec)\s*\(\s*[`'"]\s*(INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|DROP\s+|CREATE\s+|ALTER\s+)/i;
  assert.ok(
    !mutatingRe.test(stripped),
    'liveness-explainer.mjs must remain observation-only — no INSERT/UPDATE/DELETE/DDL statements',
  );
});

test('Ratchet: every prepared statement in liveness-explainer is a SELECT', () => {
  const stripped = stripComments(livenessContent);
  const prepareRe = /\.prepare\s*\(\s*([`'"])([\s\S]*?)\1/g;
  let match;
  while ((match = prepareRe.exec(stripped)) !== null) {
    const sql = match[2].trim();
    assert.ok(
      /^\s*SELECT\b/i.test(sql),
      `liveness-explainer.mjs must only SELECT; found non-SELECT query: ${sql.split('\n')[0]}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Ratchet 5 — the temporal composition must NOT override production pieces
// outside the OVERLAY_ALLOWLIST. ADR-048 §Pre-mortem risk #1 mitigation:
// "strict overlay allowlist that permits replacement only of inference and
// declared check-provider ports." We import the allowlist from
// composition-fingerprint.mjs and assert the canonical composition obeys it.
// ---------------------------------------------------------------------------

test('Ratchet: OVERLAY_ALLOWLIST contains the declared override ports and nothing else', () => {
  // ADR-048: "Replace only the inference WorkerExecutorFactory and an
  // explicitly declared deterministic check-provider port."
  // The allowlist must NOT include production policies (settlement, task-graph,
  // preflight, delivery providers) — those are production composition, not
  // inference ports.
  const expected = [
    'workerExecutorFactory',
    'resolveWorkerContext',
  ];
  assert.deepEqual(
    [...OVERLAY_ALLOWLIST].sort(),
    [...expected].sort(),
    'OVERLAY_ALLOWLIST must contain exactly the declared override ports (ADR-048)',
  );
});

test('Ratchet: assertOverlayAllowlist rejects a composition that overrides a non-allowed piece', () => {
  // A composition that replaces an allowlisted port must pass.
  assert.doesNotThrow(() => assertOverlayAllowlist({
    workerExecutorFactory: () => ({}),
    resolveWorkerContext: () => ({}),
  }));
  // A composition that illegally replaces settlementPolicy at the top level
  // (NOT inside development./delivery. allowlisted slots) must throw.
  assert.throws(
    () => assertOverlayAllowlist({ settlementPolicy: { illegal: true } }),
    /COMPOSITION_OVERLAY_VIOLATION/,
  );
  // A composition that illegally replaces lifecycle selection must throw.
  assert.throws(
    () => assertOverlayAllowlist({ productBuildLifecycle: {} }),
    /COMPOSITION_OVERLAY_VIOLATION/,
  );
});

test('Ratchet: assertOverlayAllowlist accepts a sample composition that respects the allowlist', () => {
  // A composition that overrides exactly the allowlisted ports must pass.
  // ADR-048: only the inference port and declared check-provider port.
  const sample = {
    workerExecutorFactory: () => ({}),
    resolveWorkerContext: () => ({}),
  };
  assert.doesNotThrow(() => assertOverlayAllowlist(sample));
  // Sanity: the allowlist is non-empty and includes the worker port.
  assert.ok(OVERLAY_ALLOWLIST.includes('workerExecutorFactory'));
});

test('Ratchet: temporal-composition.mjs exports the canonical composition and no alternative runtime', () => {
  const content = readContent(TEMPORAL_COMPOSITION_PATH);
  assert.ok(
    /export\s+async\s+function\s+createProductLifecycleComposition\b/.test(content),
    'temporal-composition.mjs must export createProductLifecycleComposition',
  );
  // It must NOT export an alternative orchestrator/coordinator/runtime.
  const stripped = stripComments(content);
  assert.ok(
    !/\bexport\s+(async\s+)?function\s+(createProductLifecycleRuntime|createLifecycleOrchestrator|createProductionCellCoordinator)\b/.test(stripped),
    'temporal-composition.mjs must not export an alternative lifecycle runtime / orchestrator / coordinator',
  );
});

// ---------------------------------------------------------------------------
// Ratchet 6 — the liveness explainer must implement all four clauses of the
// progress obligation (ADR-048 §Decision / GUARDRAILS Sign 015). A nonterminal
// scope must have at least one of:
//   (a) a valid live owner
//   (b) an enabled idempotent kernel command
//   (c) a typed wait with a wake source (human_requests / GateDecision)
//   (d) a committed transition obligation awaiting routing
// We assert textual evidence of each clause so a refactor cannot silently drop
// one branch of the invariant.
// ---------------------------------------------------------------------------

test('Ratchet: liveness-explainer implements clause (a) — valid live owner check', () => {
  assert.ok(
    /LIVE_EXECUTION_STATES\s*=\s*new\s+Set\s*\(\s*\[[^\]]*['"]reserved['"][^\]]*['"]running['"]/.test(livenessContent),
    'liveness-explainer.mjs must define LIVE_EXECUTION_STATES containing reserved/running',
  );
  assert.ok(
    /function\s+hasLiveOwner\s*\(/.test(livenessContent),
    'liveness-explainer.mjs must define a hasLiveOwner(...) predicate',
  );
  assert.ok(
    livenessContent.includes('active_reservation_ref'),
    'liveness-explainer.mjs must resolve the live owner through active_reservation_ref',
  );
});

test('Ratchet: liveness-explainer implements clause (b) — enabled kernel-command check', () => {
  assert.ok(
    /KERNEL_DRIVEN_LOOP_STATES\s*=\s*new\s+Set\s*\(\s*\[[^\]]*['"]repair_wait['"][^\]]*['"]verifying['"][^\]]*['"]effect_pending['"]/.test(livenessContent),
    'liveness-explainer.mjs must define KERNEL_DRIVEN_LOOP_STATES containing repair_wait/verifying/effect_pending',
  );
  // Kernel re-entry is observed through a live (non-stale) NodeRun on the
  // ProcessRun. The predicate must check staleness (started_at age), not just
  // row presence — a dead host can leave a status='running' row behind.
  assert.ok(
    /function\s+readKernelAlive\s*\(/.test(livenessContent),
    'liveness-explainer.mjs must define a readKernelAlive(...) predicate that checks NodeRun freshness',
  );
  // A verifying workplace must be checked for a pending GateRun.
  assert.ok(
    /function\s+readPendingGateRun\s*\(/.test(livenessContent),
    'liveness-explainer.mjs must define a readPendingGateRun(...) predicate',
  );
});

test('Ratchet: liveness-explainer implements clause (c) — typed wait / human-request check', () => {
  assert.ok(
    /function\s+readOpenHumanRequest\s*\(/.test(livenessContent),
    'liveness-explainer.mjs must define a readOpenHumanRequest(...) predicate',
  );
  assert.ok(
    /human_requests\b/.test(livenessContent),
    'liveness-explainer.mjs must read from the human_requests table',
  );
  // The paused loop_state is the typed-wait trigger.
  assert.ok(
    /loop_state\s*===\s*['"]paused['"]/.test(livenessContent),
    'liveness-explainer.mjs must branch on loop_state === "paused" for typed waits',
  );
});

test('Ratchet: liveness-explainer implements clause (d) — routing-obligation check', () => {
  assert.ok(
    /function\s+readTerminalTransition\s*\(/.test(livenessContent),
    'liveness-explainer.mjs must define a readTerminalTransition(...) predicate',
  );
  assert.ok(
    /factory_process_transitions\b/.test(livenessContent),
    'liveness-explainer.mjs must read the routing-obligation table factory_process_transitions',
  );
  // The terminal-but-not-yet-routed branch must be present.
  assert.ok(
    livenessContent.includes('routing-pending'),
    'liveness-explainer.mjs must emit a routing-pending reason when a terminal transition obligation is unmet',
  );
});

test('Ratchet: liveness-explainer progress obligation is non-empty — at least one clause must hold', () => {
  // The classifier must fall through to a `stalled` verdict when NONE of the
  // four clauses hold. This is what makes the invariant a true disjunction:
  // if none of (a)..(d) is satisfied, the test fails with a typed stall.
  assert.ok(
    /classification:\s*['"]stalled['"]/.test(livenessContent),
    'liveness-explainer.mjs must classify as "stalled" when no progress-obligation clause holds',
  );
  assert.ok(
    livenessContent.includes('kernel-transition-not-driven')
      || livenessContent.includes('engine-dead-runnable'),
    'liveness-explainer.mjs must emit a typed stall reason code',
  );
});

test('Ratchet: production and temporal dispatch yield for every kernel-driven Workplace state', () => {
  // B2 (antifreeze): the engine's shouldYieldToKernel predicate moved from an
  // inline getDb() query in orchestrate-cli.ts to the dedicated readonly
  // durable-state probe (WAL readers never block on writers). The contract is
  // unchanged: the COMPLETE kernel-state set must gate dispatch, and the
  // production loop must route its yield check through the probe.
  const production = readContent(path.join(REPO_ROOT, 'src', 'orchestrate-cli.ts'));
  const probe = readContent(path.join(REPO_ROOT, 'src', 'runtime', 'durable-state-probe.ts'));
  const temporalDriver = readContent(path.join(TEMPORAL_LIB_DIR, 'temporal-driver.mjs'));
  const completeKernelSet = /loop_state IN \('repair_wait','verifying','effect_pending'\)/;
  assert.match(probe, completeKernelSet);
  assert.match(temporalDriver, completeKernelSet);
  assert.match(
    production,
    /isKernelWorkPending/,
    'orchestrate-cli must route shouldYieldToKernel through the readonly durable-state probe',
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripComments(content) {
  // Remove /* ... */ block comments and // line comments so that patterns
  // appearing only in prose (e.g. the "LifecycleOrchestrator" mention in the
  // temporal-composition.mjs header) do not trigger false positives.
  let out = content.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return out;
}
