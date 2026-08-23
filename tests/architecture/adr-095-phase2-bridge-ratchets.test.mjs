// tests/architecture/adr-095-phase2-bridge-ratchets.test.mjs
//
// ADR-095 Phase-2A — additive, GREEN-today, non-vacuous bridge ratchets.
//
// Phase 2 (ADR-095: "ratchets first") authors the removal-pinning proofs
// BEFORE any deletion lands. This suite carries the Phase-2A subset that is
// provable on the legacy-present tree and consumes the exact machine
// inventory (tests/infrastructure/adr-095-removal-inventory.mjs):
//
//   BR1  inventory self-validation — uniqueness, dead∩kept=∅, every
//        present-today path resolves, schema tables/indexes exact, and the
//        EXACT pinned counts (dead 35 = 26 phase-4 files + 9 dead-lane
//        resources; kept 43 = 20 fully-kept production files + 4
//        partial-live containers + 10 live resources + 9 live test files);
//   BR2  unresolved monotonicity + the Phase-4 atomic gate — the exact
//        pinned baseline of 5 may only shrink (growth rejected), and the
//        `phase4BlockedByUnresolved` machine flag is proven COUPLED to the
//        unresolved list (decoupled mutated clones must fail validation);
//        the dead-file presence counter stays deferred until closure;
//   BR3  the dependency-direction allowlist DENIES any ADR-095 dead-file
//        edge — the KNOWN_VIOLATIONS array block (plus its single
//        programmatic append site) is extracted BOUNDED and no quoted
//        canonical .ts entry in it may reference a dead file, so the
//        Phase-4 deletion can never be blocked by (or smuggled through) new
//        allowlist debt (ratchet 1 bridge);
//   BR4  the live production composition has EXACTLY ONE settlement handler:
//        the production-cell kernel handler factory returns exactly
//        { 'discovery-settlement-policy' } and the live registration never
//        touches the dead six-handler factory (ratchet 2/6 bridge);
//   BR5  retired handler IDs cannot fan out beyond the exact known legacy
//        files — the five ControlIntent-era ids appear in src/ ONLY inside
//        the three classified legacy files (Phase-4 tightens this to zero).
//
// Deliberately NOT duplicated here: the same-version six→one handler drift
// negative (MODULE_INSTALLATION_INCOMPATIBLE_DRIFT) is already machine-proven
// by the Phase-1 suite
// tests/process-modules/discovery-legacy-removal-boot-regression.test.mjs
// (blocking, process-modules group, guard G2h). No second drift oracle.
//
// Phase-4/5/6 note: when the removal lands, BR4's factory assertion keeps
// holding (it pins the live surface) and BR5's allowed set becomes empty —
// update this suite in the SAME commit as the removal it pins (ADR-095
// ratchets land green in the same commit-train as the removal).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADR_095_INVENTORY,
  validateAdr095Inventory,
} from '../infrastructure/adr-095-removal-inventory.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const toPosix = (p) => p.split(path.sep).join('/');

const validation = validateAdr095Inventory(REPO_ROOT);
const deadPaths = validation.deadPaths;
const retiredHandlerIds = validation.retiredHandlerIds;

// ---------------------------------------------------------------------------
// BR1 — inventory self-validation (the validator itself throws on defect;
// these tests additionally pin the classification shape non-vacuously).
// ---------------------------------------------------------------------------

test('BR1a: inventory self-validation passes with the EXACT pinned dead/kept counts', () => {
  // Exact counts, deliberately pinned (red-team F1): the classified dead
  // baseline is 35 paths = 26 phase-4 files + 9 dead-lane resources (phase 3
  // contributes code-blocks only — no whole files/resources today); the kept
  // baseline is 43 paths = 20 fully-kept production files + 4 partial-live
  // containers + 10 live resources + 9 live test files. Any delta must be a
  // reviewed classification change landing in the same commit as this pin,
  // never silent drift.
  assert.equal(ADR_095_INVENTORY.deadPhase4Files.length, 26,
    'exact classified dead baseline: 26 phase-4 files (update this pin only with a reviewed classification change)');
  assert.equal(ADR_095_INVENTORY.deadPhase4Resources.length, 9,
    'exact classified dead baseline: 9 dead-lane resources');
  assert.equal(deadPaths.size, 35,
    'exact classified dead baseline: 35 dead paths = 26 phase-4 files + 9 resources');
  assert.equal(ADR_095_INVENTORY.keptLive.productionFiles.length, 20,
    'exact kept baseline: 20 fully-kept production files');
  assert.equal(ADR_095_INVENTORY.keptLive.partialLiveFilesWithUnresolvedRows.length, 4,
    'exact kept baseline: 4 partial-live containers (kept as files, rows unresolved)');
  assert.equal(ADR_095_INVENTORY.keptLive.liveResources.length, 10,
    'exact kept baseline: 10 live resources');
  assert.equal(ADR_095_INVENTORY.keptLive.testFiles.length, 9,
    'exact kept baseline: 9 live test files');
  assert.equal(validation.keptPaths.size, 43,
    'exact kept baseline: 43 kept paths = 20 + 4 + 10 + 9');
});

test('BR1b: the exact ADR dead-file names from the decision text are all classified dead', () => {
  const namedByAdr = [
    'src/modules/discovery/application/discovery-installation.ts',
    'src/tools/discovery-proposal-tools.ts',
    'src/tools/discovery-normalization-tools.ts',
    'src/tools/discovery-readiness-tools.ts',
    'src/tools/discovery-tool-args.ts',
    'src/modules/discovery/application/discovery-settlement-service.ts',
    'src/modules/discovery/infrastructure/discovery-normalization-repository.ts',
    'src/modules/discovery/infrastructure/discovery-readiness-repository.ts',
    'src/modules/discovery/infrastructure/discovery-settlement-repository.ts',
    'src/modules/discovery/infrastructure/discovery-proposal-repository.ts',
    'src/modules/discovery/infrastructure/sqlite-discovery-runtime.ts',
    'src/modules/discovery/infrastructure/discovery-runtime-port.ts',
    'src/process-modules/modules/discovery/package/contributions/handler-adapter.ts',
    'src/modules/discovery/domain/proposal.ts',
    'src/modules/discovery/domain/proposal-ref-bridge.ts',
    'src/modules/discovery/domain/discovery-outcome-certificate.ts',
    'src/modules/discovery/application/discovery-outcome-certificate-projection.ts',
    'src/modules/discovery/domain/discovery-readiness-records.ts',
    'src/modules/discovery/application/discovery-certificate-bundle.ts',
    'src/modules/discovery/application/ensure-discovery-workspace.ts',
    'src/modules/discovery/infrastructure/discovery-proposal-projection.ts',
  ];
  for (const p of namedByAdr) {
    assert.ok(deadPaths.has(p), `ADR-095-named dead file missing from inventory: ${p}`);
  }
});

test('BR1c: factory_work_intents is kept live and NOT part of the legacy table closure', () => {
  assert.ok(ADR_095_INVENTORY.keptLive.keptTables.includes('factory_work_intents'));
  assert.ok(!ADR_095_INVENTORY.deadPhase5Tables.includes('factory_work_intents'));
  // Its kept indexes must not be in the dead index closure either.
  for (const idx of ADR_095_INVENTORY.keptLive.keptIndexes) {
    assert.ok(!ADR_095_INVENTORY.deadPhase5Indexes.includes(idx));
  }
});

// ---------------------------------------------------------------------------
// BR2 — unresolved monotonicity + the Phase-4 atomic gate. Deliberately NOT
// a tautological `deferred === (unresolved > 0)` restatement: the coupling
// is enforced MACHINE-side by validateAdr095Inventory, and BR2b proves it
// fires by feeding decoupled mutated clones to the validator. The tests
// themselves pin today's exact state (baseline 5, blocked, deferred).
// ---------------------------------------------------------------------------

test('BR2a: unresolved is the exact pinned baseline of 5 and may only shrink', () => {
  // Monotone ratchet: 5 → 4 → … → 0. Growth beyond the baseline is rejected
  // by validateAdr095Inventory (machine side). This exact equality is the
  // review-forcing pin: a resolution must update it in the SAME commit.
  // Baseline history: 2026-08-24 baseline = 5 (4 partial-live contribution
  // containers + the legacy-only test list).
  assert.equal(
    ADR_095_INVENTORY.unresolved.length,
    5,
    'unresolved must equal the pinned baseline 5 — a resolution updates this pin in the same ' +
      'commit; growth is a classification regression',
  );
});

test('BR2b: phase4BlockedByUnresolved is the atomic machine gate (flag, counter, validator coupling)', () => {
  // Today's pinned state: Phase 4 is BLOCKED (unresolved non-empty), the
  // bidirectional dead-file presence counter stays deferred, and the
  // deferral states the unresolved-inventory reason.
  assert.equal(ADR_095_INVENTORY.phase4BlockedByUnresolved, true,
    'Phase 4 is blocked today: unresolved is non-empty');
  assert.equal(ADR_095_INVENTORY.presenceCounter.deferred, true,
    'the presence counter must stay deferred while Phase 4 is blocked');
  assert.match(
    ADR_095_INVENTORY.presenceCounter.reason,
    /unresolved/i,
    'the deferral must state the unresolved-inventory reason',
  );
  // Non-vacuous machine proofs (not a tautology): the validator must REJECT
  // a prematurely CLEARED flag while unresolved entries remain (an early
  // Phase-4 landing) ...
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, { ...ADR_095_INVENTORY, phase4BlockedByUnresolved: false }),
    /phase4BlockedByUnresolved/,
    'clearing the flag must fail validation while unresolved is non-empty',
  );
  // ... and must REJECT an emptied unresolved list that did not clear the
  // flag (and un-defer the counter) in the same commit.
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, { ...ADR_095_INVENTORY, unresolved: [] }),
    /phase4BlockedByUnresolved|presence counter|same commit/,
    'emptying unresolved must fail validation until the flag clears and the counter lands atomically',
  );
});

// ---------------------------------------------------------------------------
// BR3 — the dependency-direction allowlist denies any ADR-095 dead-file edge.
// ---------------------------------------------------------------------------

test('BR3: no KNOWN_VIOLATIONS allowlist entry references an ADR-095 dead file', () => {
  const depTestPath = path.join(REPO_ROOT, 'tests', 'architecture', 'dependency-direction.test.mjs');
  const src = readFileSync(depTestPath, 'utf8');
  // BOUNDED extraction (red-team F4): parse ONLY the KNOWN_VIOLATIONS array
  // literal (from its declaration to the closing `];` terminator) plus the
  // discoveryLeaks block (the single programmatic KNOWN_VIOLATIONS.push
  // site) — NOT every quoted path in the full test (rule predicates and
  // fixtures outside the allowlist legitimately quote src paths such as
  // 'src/db.ts' that are NOT allowlist entries). Canonical entries are full
  // quoted `src/...ts` paths; residual aliases inside the block are bare
  // comment citations (e.g. "discovery/discovery-installation → db.ts")
  // that cannot match the exact-path dead set — any canonical quoted .ts
  // path inside the block (entry OR comment) that hits the dead set fails
  // here. A future entry that allowlists ANY dead-file edge (as source or
  // target) must fail — the shrinking allowlist (ratchet 1) may never grow
  // legacy debt.
  const block = extractArrayLiteralBlock(src, 'const KNOWN_VIOLATIONS = ');
  const appendBlock = extractArrayLiteralBlock(src, 'const discoveryLeaks = ');
  const literals =
    `${block}\n${appendBlock}`.match(/'src\/[A-Za-z0-9_.\/-]+\.ts'|"(?:src\/[A-Za-z0-9_.\/-]+\.ts)"/g) ?? [];
  const referenced = new Set(literals.map((l) => l.slice(1, -1)));
  const offenders = [...referenced].filter((p) => deadPaths.has(p));
  assert.deepEqual(
    offenders,
    [],
    `dependency-direction allowlist references ADR-095 dead files (${offenders.join(', ')}): ` +
      'dead-file edges are DENIED — the Phase-4 deletion must remove the edge, not grandfather it',
  );
});

// Extract an array literal's text, bounded between its declaration and the
// first closing `];` terminator after the opening bracket. Fails closed if
// the declaration or the terminator is missing (renamed/refactored source).
function extractArrayLiteralBlock(src, declaration) {
  const decl = src.indexOf(declaration);
  assert.ok(decl !== -1, `declaration not found in dependency-direction.test.mjs: ${declaration}`);
  const open = src.indexOf('[', decl + declaration.length);
  const close = src.indexOf('];', open);
  assert.ok(open !== -1 && close !== -1,
    `array literal terminator ('];') not found for: ${declaration}`);
  return src.slice(open, close);
}

// ---------------------------------------------------------------------------
// BR4 — the live production composition has exactly one settlement handler.
// ---------------------------------------------------------------------------

test('BR4a: the production-cell kernel handler factory returns exactly the one live settlement handler', async () => {
  const factoryPath = path.join(
    REPO_ROOT, 'dist', 'modules', 'discovery', 'application',
    'discovery-production-cell-installation.js',
  );
  assert.ok(existsSync(factoryPath), 'dist production-cell installation missing (run npm run build)');
  const { createDiscoveryProductionCellKernelHandlers } = await import(
    pathToFileUrl(factoryPath)
  );
  // Minimal fail-closed deps: the factory validates ONLY the pinned reader
  // shape before returning the handler record (the fail-closed throw is the
  // composition contract, asserted separately below).
  const handlers = createDiscoveryProductionCellKernelHandlers({
    db: stubDb(),
    certificates: {},
    lifecycleDefinitionReader: { readDefinitionByProcessRun() { return null; } },
    lifecycleInjectionDeclarations: [],
    lifecycleInjectionRequiredClassifications: [],
  });
  assert.deepEqual(
    Object.keys(handlers).sort(),
    ['discovery-settlement-policy'],
    'the live composition must register EXACTLY one Discovery kernel handler (ADR-095 Decision 4/5)',
  );
});

test('BR4b: the live registration never touches the dead six-handler factory', () => {
  const indexPath = path.join(REPO_ROOT, 'src', 'modules', 'discovery', 'index.ts');
  const src = stripComments(readFileSync(indexPath, 'utf8'));
  assert.ok(
    src.includes('createDiscoveryProductionCellKernelHandlers'),
    'registerDiscovery must compose the production-cell kernel handlers',
  );
  assert.ok(
    !src.includes('createDiscoveryKernelHandlers'),
    'the live registration must never import/call the dead six-handler factory (discovery-installation.ts)',
  );
});

test('BR4c: the factory fails closed without the pinned lifecycle reader (composition contract intact)', async () => {
  const factoryPath = path.join(
    REPO_ROOT, 'dist', 'modules', 'discovery', 'application',
    'discovery-production-cell-installation.js',
  );
  const { createDiscoveryProductionCellKernelHandlers } = await import(
    pathToFileUrl(factoryPath)
  );
  assert.throws(
    () => createDiscoveryProductionCellKernelHandlers({
      db: stubDb(),
      certificates: {},
      lifecycleDefinitionReader: undefined,
      lifecycleInjectionDeclarations: [],
      lifecycleInjectionRequiredClassifications: [],
    }),
    /DISCOVERY_SETTLEMENT_LIFECYCLE_READER_REQUIRED/,
  );
});

// ---------------------------------------------------------------------------
// BR5 — retired handler IDs cannot fan out beyond the exact known legacy
// files. Today the five ControlIntent-era ids may exist ONLY inside the three
// classified legacy src files (dead factory, dead package adapter, stale
// manifest pins). Any NEW file mentioning one (a fresh registration, a new
// tool, a new test-visible wiring in src) fails here. Phase 4 deletes the
// first two and repins the third in ONE commit and tightens this allowed set
// to empty in that same commit.
// ---------------------------------------------------------------------------

const RETIRED_ID_ALLOWED_FILES = Object.freeze([
  'src/modules/discovery/application/discovery-installation.ts',
  'src/process-modules/modules/discovery/package/contributions/handler-adapter.ts',
  'src/process-modules/modules/discovery/package/manifest.ts',
]);

test('BR5: retired Discovery handler IDs appear in src/ ONLY inside the exact known legacy files', () => {
  const offenders = new Map();
  walkSrc(path.join(REPO_ROOT, 'src'), (file) => {
    const rel = toPosix(path.relative(REPO_ROOT, file));
    if (RETIRED_ID_ALLOWED_FILES.includes(rel)) return;
    const text = readFileSync(file, 'utf8');
    for (const id of retiredHandlerIds) {
      if (text.includes(id)) {
        if (!offenders.has(rel)) offenders.set(rel, []);
        offenders.get(rel).push(id);
      }
    }
  });
  const rendered = [...offenders.entries()].map(([f, ids]) => `  ${f}: ${ids.join(', ')}`);
  assert.deepEqual(
    rendered,
    [],
    'retired ADR-095 handler IDs fanned out beyond the exact known legacy files ' +
      `(allowed: ${RETIRED_ID_ALLOWED_FILES.join('; ')}):\n${rendered.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function stubDb() {
  return { prepare() { throw new Error('not used by the factory signature path'); } };
}

function pathToFileUrl(p) {
  return `file://${toPosix(p).replace(/^([A-Za-z]):/, (m) => m.toLowerCase())}`;
}

function stripComments(src) {
  let out = src;
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
  return out;
}

function walkSrc(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSrc(p, visit);
    else if (/\.(ts|mjs)$/.test(entry.name)) visit(p);
  }
}
