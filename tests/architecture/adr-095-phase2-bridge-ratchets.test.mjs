// tests/architecture/adr-095-phase2-bridge-ratchets.test.mjs
//
// ADR-095 Phase-2 bridge ratchets — additive, GREEN-today, non-vacuous.
//
// Phase 2 (ADR-095: "ratchets first") authors the removal-pinning proofs
// BEFORE any deletion lands. This suite carries the Phase-2 subset provable
// on the legacy-present tree and consumes the exact machine inventory
// (tests/infrastructure/adr-095-removal-inventory.mjs):
//
//   BR1  inventory self-validation — uniqueness, dead∩kept=∅, every
//        present-today path resolves, schema tables/indexes exact, and the
//        EXACT pinned counts (dead 36 = 27 phase-4 files + 9 dead-lane
//        resources; kept 47 = 18 fully-kept production files + 5
//        partial-live containers with exhaustively classified rows +
//        11 live resources + 13 live test files);
//   BR2  unresolved closure + the Phase-4 atomic gate — unresolved is EMPTY
//        (closed in Phase-2B by the exhaustive row classifications C1/C2 +
//        the exact test partition C3), phase4BlockedByUnresolved is false,
//        and the BIDIRECTIONAL dead-file presence counter is LIVE (fails on
//        early deletion AND on unreviewed dead-set growth); decoupled
//        mutated clones fail validation;
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
//        the three classified legacy files (Phase-4 tightens this to zero);
//   BR6  the BIDIRECTIONAL SCOPED PARTITION SCAN (Phase-2B correction C6) —
//        the completeness claim "the 36 dead paths + 47 kept paths are the
//        whole scoped universe" is machine-proved: virtual-tree mutation
//        negatives show the scan fails on an UNCLASSIFIED scoped file, on a
//        classified file ABSENT from the scanned set, and on a DOUBLE
//        classification — the scan cannot pass vacuously;
//   BR7  Phase-3.1 code-block truth (2026-08-24) — the products.ts projection
//        block is EXECUTED (no removed marker remains in src), the other
//        three phase-3 code-blocks are still PENDING (Phase 3 ≠ Phase 3.1),
//        the migrated conveyor-v4.3 suite carries no dead projection import,
//        and a lying executed/pending status fails validation (the inventory
//        status can never drift from the code truth).
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
  // Exact counts, deliberately pinned (red-team F1 + Phase-2B corrections
  // C1/C2): the classified dead baseline is 36 paths = 27 phase-4 files
  // (Phase-2A 26 + the wholly-dead tool-contributions.ts) + 9 dead-lane
  // resources (phase 3 contributes code-blocks only — no whole files/
  // resources today); the kept baseline is 47 paths = 18 fully-kept
  // production files (Phase-2A 20 − discovery-domain-contracts.ts − the
  // contributions barrel, both now partial-live) + 5 partial-live
  // containers (4 contributions incl. the barrel + discovery-domain-contracts)
  // + 11 live resources (Phase-2A 10 + skills/saga-kickstart/SKILL.md per
  // C4) + 13 live test files (Phase-2A 9 + the four newly hosted live
  // suites per C3). Any delta must be a reviewed classification change
  // landing in the same commit as this pin, never silent drift.
  assert.equal(ADR_095_INVENTORY.deadPhase4Files.length, 27,
    'exact classified dead baseline: 27 phase-4 files (update this pin only with a reviewed classification change)');
  assert.equal(ADR_095_INVENTORY.deadPhase4Resources.length, 9,
    'exact classified dead baseline: 9 dead-lane resources');
  assert.equal(deadPaths.size, 36,
    'exact classified dead baseline: 36 dead paths = 27 phase-4 files + 9 resources');
  assert.equal(ADR_095_INVENTORY.keptLive.productionFiles.length, 18,
    'exact kept baseline: 18 fully-kept production files');
  assert.equal(ADR_095_INVENTORY.keptLive.partialLiveFiles.length, 5,
    'exact kept baseline: 5 partial-live containers (kept as files, rows exhaustively classified)');
  assert.equal(ADR_095_INVENTORY.keptLive.liveResources.length, 11,
    'exact kept baseline: 11 live resources');
  assert.equal(ADR_095_INVENTORY.keptLive.testFiles.length, 13,
    'exact kept baseline: 13 live test files');
  assert.equal(validation.keptPaths.size, 47,
    'exact kept baseline: 47 kept paths = 18 + 5 + 11 + 13');
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

test('BR1d: the audited contribution/domain-contracts row classifications are pinned exactly (Phase-2B C1/C2)', () => {
  // tool-contributions.ts is WHOLLY DEAD — a deadPhase4File, not a container.
  assert.ok(deadPaths.has('src/process-modules/modules/discovery/package/contributions/tool-contributions.ts'),
    'tool-contributions.ts must be classified dead (all 9 rows are ControlIntent-era tool lanes)');
  const partial = Object.fromEntries(
    ADR_095_INVENTORY.keptLive.partialLiveFiles.map((e) => [e.path, e]),
  );
  // discovery-domain-contracts.ts: exactly 5 live rows (the discovery-process-module
  // constants), dead rows grouped but exhaustive.
  const contracts = partial['src/modules/discovery/domain/discovery-domain-contracts.ts'];
  assert.ok(contracts, 'discovery-domain-contracts.ts must be a partial-live container');
  assert.equal(contracts.liveRows.length, 5,
    'domain-contracts has exactly 5 live rows (consumed by discovery-process-module.ts)');
  for (const row of ['DISCOVERY_PROPOSAL_SCHEMA', 'DISCOVERY_READINESS_ASSESSMENT_SCHEMA',
    'DISCOVERY_INTENT_KIND', 'DISCOVERY_READINESS_INTENT_KIND', 'DISCOVERY_WORK_INTENT_SCHEMA']) {
    assert.ok(contracts.liveRows.some((r) => r.row === row), `missing live row: ${row}`);
  }
  // The three audited contribution containers keep their exact dead-row groups.
  const out = partial['src/process-modules/modules/discovery/package/contributions/output-contracts.ts'];
  assert.equal(out.deadRows.length, 4, 'output-contracts: 3 dead bundle contracts + the aggregate entry');
  const caps = partial['src/process-modules/modules/discovery/package/contributions/acceptance-capabilities.ts'];
  assert.equal(caps.deadRows.length, 4, 'acceptance-capabilities: 3 dead rows + the aggregate entry');
  const skills = partial['src/process-modules/modules/discovery/package/contributions/reviewer-skills.ts'];
  assert.equal(skills.deadRows.length, 3, 'reviewer-skills: 2 dead pins + the aggregate entry');
  // The audited dead-row NAMES appear in their justifications/rows (spot pins).
  assert.match(out.deadRows.map((r) => r.row).join(' '), /NORMALIZATION_BUNDLE/);
  assert.match(out.deadRows.map((r) => r.row).join(' '), /DIAGNOSIS_BUNDLE/);
  assert.match(out.deadRows.map((r) => r.row).join(' '), /BRIEF_BUNDLE/);
  assert.match(caps.deadRows.map((r) => r.row).join(' '), /RUNTIME_PERSISTENCE/);
  assert.match(caps.deadRows.map((r) => r.row).join(' '), /SETTLEMENT_POLICY_REPOSITORY/);
  assert.match(caps.deadRows.map((r) => r.row).join(' '), /DIAGNOSIS_ADVISORY/);
  assert.match(skills.deadRows.map((r) => r.row).join(' '), /NORMALIZER_SKILL/);
  assert.match(skills.deadRows.map((r) => r.row).join(' '), /DIAGNOSIS_ADVISOR_REVIEWER_SKILL/);
  // C4: saga-kickstart is a KEPT live resource.
  assert.ok(ADR_095_INVENTORY.keptLive.liveResources.includes('skills/saga-kickstart/SKILL.md'),
    'skills/saga-kickstart/SKILL.md must be kept (C4)');
});

test('BR1e: the legacy test partition is exact paths with exact actions (Phase-2B C3)', () => {
  // 13 delete/helper + 5 migrate = 18 entries; no wildcards.
  const lt = ADR_095_INVENTORY.legacyTests;
  assert.equal(lt.length, 18, 'exact legacy-test partition: 18 files');
  for (const t of lt) {
    assert.ok(!/[*?]/.test(t.path), `wildcard in legacy test path: ${t.path}`);
    assert.ok(t.path.endsWith('.test.mjs') || t.path.endsWith('_conveyor-fakes.mjs'),
      `non-test path in legacyTests: ${t.path}`);
  }
  assert.equal(lt.filter((t) => t.verdict === 'delete').length, 12);
  assert.equal(lt.filter((t) => t.verdict === 'helper').length, 1);
  assert.equal(lt.filter((t) => t.verdict === 'migrate').length, 5);
  // The four previously-unhosted LIVE suites are now hosted kept-live tests.
  for (const f of [
    'tests/discovery/d1-1-authority.test.mjs',
    'tests/discovery/d1-1-binding.test.mjs',
    'tests/discovery/d3-readiness-domain.test.mjs',
    'tests/discovery/d4-settlement-policy.test.mjs',
  ]) {
    assert.ok(ADR_095_INVENTORY.keptLive.testFiles.includes(f), `${f} must be a kept live test (hosted Phase-2B)`);
    assert.ok(!lt.some((t) => t.path === f), `${f} must not be a legacy test`);
  }
  // Every hosted dead importer is a real hosted file with an obligation (C5).
  for (const h of ADR_095_INVENTORY.hostedDeadImporters) {
    assert.ok(h.obligation.length > 20, `hosted importer without a concrete action: ${h.file}`);
  }
});

// ---------------------------------------------------------------------------
// BR2 — unresolved closure + the Phase-4 atomic gate + the LIVE bidirectional
// presence counter. Deliberately NOT a tautological restatement: the coupling
// is enforced MACHINE-side by validateAdr095Inventory, and BR2b proves it
// fires by feeding decoupled mutated clones to the validator. The tests
// themselves pin today's exact state (empty, unblocked, counter live).
// ---------------------------------------------------------------------------

test('BR2a: unresolved is EMPTY (closed by the Phase-2B exhaustive classifications) and may never regrow', () => {
  // Closure history: 2026-08-24 Phase-2A baseline = 5 (4 partial-live
  // contribution containers + the legacy-only test list); 2026-08-24
  // Phase-2B = 0 (C1/C2 closed every contribution + domain-contracts row;
  // C3 replaced the test wildcard with exact per-file actions). The
  // partition scan (BR6) enforces completeness forward — an ambiguous file
  // must be classified in the scan, never parked in unresolved.
  assert.equal(
    ADR_095_INVENTORY.unresolved.length,
    0,
    'unresolved must be EMPTY — completeness is enforced by the partition scan, not by an open list',
  );
});

test('BR2b: phase4BlockedByUnresolved is cleared and the bidirectional presence counter is LIVE (machine-coupled)', () => {
  // Today's pinned state: Phase 4 is UNBLOCKED (unresolved empty since
  // Phase-2B), and the bidirectional dead-file presence counter is live —
  // it fails on early deletion AND on unreviewed dead-set growth.
  assert.equal(ADR_095_INVENTORY.phase4BlockedByUnresolved, false,
    'Phase 4 is unblocked today: unresolved is empty (Phase-2B closure)');
  assert.equal(ADR_095_INVENTORY.presenceCounter.deferred, false,
    'the presence counter is LIVE since the Phase-2B completeness proof');
  assert.equal(ADR_095_INVENTORY.presenceCounter.deadPathCount, 36,
    'the counter pins the exact dead-path count (36)');
  // Non-vacuous machine proofs (not a tautology): the validator must REJECT
  // a re-OPENED unresolved list (a classification regression — growth from
  // empty is never progress) ...
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, {
      ...ADR_095_INVENTORY,
      unresolved: [{ path: 'x', question: 'regressed' }],
    }),
    /unresolved must be EMPTY/,
    'a non-empty unresolved list must fail validation (closure is one-way)',
  );
  // ... a decoupled flag (blocked while unresolved is empty) ...
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, { ...ADR_095_INVENTORY, phase4BlockedByUnresolved: true }),
    /phase4BlockedByUnresolved/,
    'the flag must track the (empty) unresolved list exactly',
  );
  // ... a counter that UNDERCOUNTS (would pass an early deletion) ...
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, {
      ...ADR_095_INVENTORY,
      presenceCounter: { ...ADR_095_INVENTORY.presenceCounter, deadPathCount: 35 },
    }),
    /deadPathCount/,
    'an undercounting presence counter must fail validation (early-deletion direction)',
  );
  // ... and a counter that OVERCOUNTS (would hide unreviewed dead-set growth).
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, {
      ...ADR_095_INVENTORY,
      presenceCounter: { ...ADR_095_INVENTORY.presenceCounter, deadPathCount: 37 },
    }),
    /deadPathCount/,
    'an overcounting presence counter must fail validation (dead-set-growth direction)',
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
// BR6 — the bidirectional scoped partition scan is NON-VACUOUS (C6). The
// real-tree scan already ran inside validateAdr095Inventory at import time
// (it would have thrown otherwise). Here, VIRTUAL tree listings prove the
// scan's failure modes: an unclassified scoped file, a classified file
// missing from the scanned set, and a double classification each turn the
// validation RED. Without these negatives, "the 36+47 partition is the whole
// scoped universe" would be an unproven claim (audit correction 6).
// ---------------------------------------------------------------------------

// The REAL scoped file set, captured once (the ground truth the virtual
// mutations derive from — using it as the override must keep validation
// green, proving the override path itself is faithful).
const REAL_SCOPED = validation.scopedFiles;
const realListing = () => [...REAL_SCOPED];

test('BR6a: the scan is green over the real scoped set replayed through the override (faithfulness)', () => {
  // The override replays exactly the real per-tree files, so validation
  // must stay green — this pins that BR6b/6c/6d fail because of their
  // MUTATION, not because the override mechanism is broken.
  const byTree = new Map(ADR_095_INVENTORY.scopedPartitionScan.directoryTrees.map((t) => [t, []]));
  for (const rel of REAL_SCOPED) {
    const tree = ADR_095_INVENTORY.scopedPartitionScan.directoryTrees.find((t) => rel.startsWith(`${t}/`));
    if (tree) byTree.get(tree).push(rel);
  }
  validateAdr095Inventory(REPO_ROOT, ADR_095_INVENTORY, (tree) => byTree.get(tree) ?? []);
});

test('BR6b: an UNCLASSIFIED scoped file fails the scan (new legacy residue cannot hide)', () => {
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, ADR_095_INVENTORY, (tree) =>
      tree === 'src/modules/discovery'
        ? [...realListing().filter((f) => f.startsWith('src/modules/discovery/')),
           'src/modules/discovery/application/some-new-legacy-service.ts']
        : realListing().filter((f) => f.startsWith(`${tree}/`))),
    /UNCLASSIFIED scoped file: src\/modules\/discovery\/application\/some-new-legacy-service\.ts/,
    'a new unclassified file inside a scoped tree must fail validation by exact path',
  );
});

test('BR6c: a classified file ABSENT from the scanned set fails the scan (ghost classifications rejected)', () => {
  // Drop a classified file from the virtual tree — the scan must name it.
  const dropped = 'tests/discovery/d4-settlement-policy.test.mjs';
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, ADR_095_INVENTORY, (tree) =>
      realListing().filter((f) => f.startsWith(`${tree}/`) && f !== dropped)),
    /ABSENT from the scanned set/,
    'a classified path inside a scoped tree but missing from disk must fail validation',
  );
});

test('BR6d: a DOUBLE classification fails the scan (a path cannot be both kept and legacy-test)', () => {
  // Clone the inventory with one kept-live test ALSO listed as a legacy
  // test — the real scan must reject the overlap.
  const mutated = {
    ...ADR_095_INVENTORY,
    legacyTests: [
      ...ADR_095_INVENTORY.legacyTests,
      Object.freeze({
        path: 'tests/discovery/d4-settlement-policy.test.mjs',
        verdict: 'delete',
        phase: 4,
        justification: 'deliberate mutation: double classification must fail',
      }),
    ],
  };
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, mutated),
    /MULTIPLE buckets/,
    'a file classified in two buckets must fail validation',
  );
});

// ---------------------------------------------------------------------------
// BR7 — Phase-3.1 code-block state is MACHINE TRUTHFUL. The validator
// (validateAdr095Inventory) enforces every deadPhase3 entry's status against
// the on-disk host file content in BOTH directions; these tests pin the
// expected Phase-3.1 state (products.ts projection block EXECUTED; the other
// three phase-3 code-blocks still PENDING) and prove non-vacuously that a
// lying status is rejected.
// ---------------------------------------------------------------------------

test('BR7a: Phase 3.1 is executed — products.ts carries none of the removed projection surface', () => {
  const entry = ADR_095_INVENTORY.deadPhase3.find(
    (e) => e.path === 'src/tools/products.ts',
  );
  assert.ok(entry, 'the products.ts phase-3 code-block entry must exist');
  assert.equal(entry.status, 'executed',
    'the products.ts projection block removal is Phase 3.1 EXECUTED');
  assert.equal(entry.executedIn, 'Phase 3.1');
  const src = readFileSync(path.join(REPO_ROOT, 'src', 'tools', 'products.ts'), 'utf8');
  for (const marker of entry.contentMarkers) {
    assert.ok(!src.includes(marker),
      `removed projection surface marker '${marker}' re-introduced in src/tools/products.ts`);
  }
});

test('BR7b: the other three phase-3 code-blocks are still PENDING (Phase 3 ≠ Phase 3.1)', () => {
  const pending = ADR_095_INVENTORY.deadPhase3.filter((e) => e.status === 'pending');
  assert.deepEqual(
    pending.map((e) => e.path).sort(),
    [
      'src/app/product-lifecycle-runtime.ts',
      'src/modules/module-registration.ts',
      'src/tools/settlement-debug.ts',
    ],
    'phase 3 is NOT complete: settlement-debug legacy query, runtimePersistence construction, ' +
      'and the ModuleSharedDeps field are still pending (their same-commit obligations stand)',
  );
});

test('BR7c: a lying phase-3 status fails validation (the executed/pending state cannot drift)', () => {
  // Mutate the executed products.ts entry back to 'pending' — the validator
  // must reject it (its markers are absent from the host file, so 'pending'
  // would be untruthful). This is the mutation-negative behind BR7a.
  const mutated = {
    ...ADR_095_INVENTORY,
    deadPhase3: ADR_095_INVENTORY.deadPhase3.map((e) =>
      e.path === 'src/tools/products.ts'
        ? { ...e, status: 'pending' }
        : e),
  };
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, mutated),
    /marker 'projectDiscoveryProposal' is absent/,
    'claiming the products.ts block is still pending while it is removed must fail validation',
  );
  // And the mirror direction: claiming a still-present block is executed.
  const mutated2 = {
    ...ADR_095_INVENTORY,
    deadPhase3: ADR_095_INVENTORY.deadPhase3.map((e) =>
      e.path === 'src/tools/settlement-debug.ts'
        ? { ...e, status: 'executed', executedAt: '2026-08-24' }
        : e),
  };
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, mutated2),
    /marker 'factory_discovery_settlements' is still present/,
    'claiming the settlement-debug block is executed while it is still present must fail validation',
  );
});

test('BR7d: the migrated conveyor-v4.3 suite no longer imports the dead projection module', () => {
  const raw = readFileSync(
    path.join(REPO_ROOT, 'tests', 'replay', 'conveyor-v4.3-focused-invariants.test.mjs'),
    'utf8',
  );
  // Comment-stripped (BR4b pattern): prose may legitimately NAME the removed
  // module while explaining the migration; code may never import it.
  const src = stripComments(raw);
  assert.ok(
    !src.includes('discovery-proposal-projection.js'),
    'the migrated invariant-5 test must not import the dead discovery-proposal-projection module',
  );
  assert.ok(
    src.includes("dist/modules/discovery/domain/discovery-proposal.js"),
    'the KEPT proposal DOMAIN import (discovery-proposal.ts) stays per ADR-095 Decision 5',
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
