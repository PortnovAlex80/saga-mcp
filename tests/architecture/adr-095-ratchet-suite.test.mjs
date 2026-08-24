// tests/architecture/adr-095-ratchet-suite.test.mjs
//
// ADR-095 Phase-2C — the COMPLETE eight-ratchet set, hosted BLOCKING in the
// architecture group (removal guard G2k).
//
// ADR-095 "Ratchets" 1..8 — every ratchet maps to EXACT owning tests:
//
//   R1 shrinking allowlist
//        R1a/R1b HERE (ceiling 1, zero Discovery-scoped edges at every
//        phase, mutation negatives) + BR3 (bridge: no dead-file edge may
//        enter KNOWN_VIOLATIONS) + the dependency-direction suite's own
//        `length <= ALLOWLIST_BASELINE` monotone test.
//   R2 exact one-handler manifest/digest across the versioned boundary
//        R2a-R2e HERE (pre-arm: the EXACT censused six-handler baseline at
//        3.0.2 with the dead-dist digest; post-arm: exactly
//        discovery-settlement-policy repinned to the production-cell dist
//        bytes with a bumped handler version) + handler-digest-runtime-
//        consistency (generic per-workshop digest==dist re-pin, phases 4+).
//   R3 full src symbol/table absence
//        R3a-R3f HERE, driven by inventory.removalSymbols (schemaVersion 3).
//        Retired-handler-ID fan-out is owned by BR5 (not duplicated).
//        R3f pins the Phase-3.2 fact: the settlement-debug legacy query host
//        allowance is GONE — reintroduction REDs in every arm.
//   R4 dist-aware clean-build absence
//        R4a/R4b HERE (pre-arm build faithfulness; post-arm zero emitted
//        dead modules; stale-dist fail-closed).
//   R5 fresh DB lacks the full closure
//        R5a-R5d HERE (real fresh DB through dist/db.js getDb; partial
//        closure / F2 ordering / kept-table guards).
//   R6 live v2 behavior
//        OWNED by the hosted discovery-live-v2 group (8 suites; hosting
//        pinned by G2i) + the factory-proof discovery packs + discovery-
//        output-handoff (process-modules). R6a HERE pins what nobody else
//        does: the discovery-live-v2 matrix group is EXACTLY the eight
//        inventory files (no directory glob can silently widen the hosted
//        surface).
//   R7 existing-DB boot with retired old installation
//        OWNED by tests/process-modules/discovery-legacy-removal-boot-
//        regression.test.mjs (in-process installProductionModules proof,
//        hosting pinned by G2h). R7a HERE anti-guts the owner: the suite
//        must still carry the F5 drift oracle text. The spawned-engine
//        exit-0 smoke lands with Phase 4 (tracker Point 5 record).
//   R8 deliberate mutation RED/GREEN
//        R8x HERE = the machine-executed mutation negatives (R1b, R2b-e,
//        R3b-e, R4b, R5b-d): every ADR-095 removed-surface mutation class
//        (dead handler ref, legacy tool import, projection write, legacy
//        CREATE TABLE, stale manifest pin at the old version) turns the
//        EXACT checker RED by precise message on the same code path the
//        real tree takes; the GREEN direction is the real-tree tests. The
//        Phase-6 deliberate cycle re-executes these classes against the
//        removed tree and records them.
//   P3 phase-3 executed/pending truth (Phases 3.1+3.2+3.3, 2026-08-24)
//        P3a/P3b HERE — the inventory's deadPhase3 status split is pinned to
//        the on-disk code both ways: ALL FOUR entries executed (products.ts
//        3.1, settlement-debug 3.2, runtimePersistence construction +
//        ModuleSharedDeps field 3.3), the pending set EMPTY (Phase-3 exit),
//        and a lying status throws (real flip-backs + synthetic mutated
//        inventory for the no-longer-populated pending direction).
//
// Phase-2C boundary honesty (no overclaim): ratchets 3/4/5 post-removal
// arms and ratchet 2's post-cutover arm CANNOT be green on today's
// legacy-present tree — they testify over the phase-4/5 end states. The
// two-armed design keys every arm on machine-derived phase markers (the
// atomic product-discovery version bump; the schema-closure DDL state), so
// the suite is GREEN today where the ADR intends (the pre-state truths and
// the mutation negatives) and flips to the post-state assertions in the
// same commit-train as the removal it pins — no consolidated red tip.
// The demonstrated RED of each post-arm against TODAY's tree is recorded in
// docs/factory-run/stage22-elite9/DISCOVERY-PHASE2C-RATCHETS.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADR_095_INVENTORY,
  validateAdr095Inventory,
} from '../infrastructure/adr-095-removal-inventory.mjs';
import {
  readRatchetState,
  readManifestFacts,
  readSrcScan,
  createFreshDbObjects,
  checkR1,
  checkR2,
  checkR3,
  checkR4,
  checkR5,
  semverGt,
} from '../infrastructure/adr-095-phase2c-ratchet-checks.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Real-tree facts, read once. The checks are pure functions over these —
// the mutation negatives below only vary the DATA, never a parallel
// implementation of the ratchet.
const state = await readRatchetState(REPO_ROOT);
const manifestFacts = await readManifestFacts(REPO_ROOT);
const srcScan = readSrcScan(REPO_ROOT);
const depTestSource = readFileSync(
  path.join(REPO_ROOT, 'tests', 'architecture', 'dependency-direction.test.mjs'),
  'utf8',
);

const LEGACY_VERSION = ADR_095_INVENTORY.moduleIdentity.version; // '3.0.2'

// ===========================================================================
// State-marker sanity — the arms must key on real, coherent markers.
// ===========================================================================

test('R0: Phase-5 state markers are coherent (dist built, versioned cutover, closure absent)', () => {
  assert.ok(state.distAvailable, 'dist/ must be built before the ratchet suite can testify (npm run build)');
  assert.ok(semverGt(state.srcVersion, LEGACY_VERSION),
    `the cutover version must be above ${LEGACY_VERSION} (got ${state.srcVersion})`);
  assert.equal(state.versionCoherent, true,
    'src and dist version markers must agree (rebuild in the same commit as any bump)');
  assert.equal(state.phase4Landed, true, 'the module-version marker arms the post-cutover checks');
  assert.equal(state.deadFilesRemaining.length, 0, 'all classified dead phase-4 files are absent');
  assert.equal(state.closureInSchema, false,
    'the fresh schema no longer creates any member of the legacy closure');
});

// ===========================================================================
// R1 — shrinking allowlist (ratchet 1)
// ===========================================================================

test('R1a: dependency-direction allowlist — baseline ceiling 1, ZERO Discovery-scoped edges (real tree GREEN)', () => {
  const { errors, facts } = checkR1(depTestSource);
  assert.deepEqual(errors, [], `ratchet 1 must be green on the real tree: ${errors.join(' | ')}`);
  assert.equal(facts.baseline, 1, 'the discovery-era allowlist ceiling is exactly 1 entry');
  assert.equal(facts.discoveryEdges.length, 0,
    'zero Discovery-scoped allowlist edges at every phase — legacy death may never become allowlist debt');
});

test('R1b: MUTATION — a Discovery-scoped allowlist edge (or a raised baseline) turns ratchet 1 RED', () => {
  // Mutation class: grandfathering a discovery edge instead of deleting it.
  const mutated = depTestSource.replace(
    'const discoveryLeaks = [];',
    "const discoveryLeaks = [['src/modules/discovery/infrastructure/sqlite-discovery-runtime.ts', 'src/db.ts']];",
  );
  const { errors } = checkR1(mutated);
  assert.ok(errors.some((e) => e.includes('Discovery-scoped edges') && e.includes('sqlite-discovery-runtime')),
    `the discovery-edge mutation must RED naming the edge (got: ${errors.join(' | ')})`);

  // Mutation class: raising the ceiling (allowlist growth without review).
  const raised = depTestSource.replace('const ALLOWLIST_BASELINE = 1', 'const ALLOWLIST_BASELINE = 2');
  const raisedResult = checkR1(raised);
  assert.ok(raisedResult.errors.some((e) => e.includes('ALLOWLIST_BASELINE grew')),
    'a raised baseline must RED (shrink-only ratchet)');
});

// ===========================================================================
// R2 — exact one-handler manifest/digest across the versioned boundary
// ===========================================================================

test('R2a: pre-cutover arm — the manifest holds the EXACT censused six-handler baseline with the dead-dist digest (real tree GREEN)', async () => {
  const errors = checkR2(state, { ...manifestFacts, srcVersion: state.srcVersion, distVersion: state.distVersion });
  assert.deepEqual(errors, [],
    `the one-handler production-cell manifest must be GREEN: ${errors.join(' | ')}`);
  assert.equal(manifestFacts.handlerRefs.length, 1, 'post-cutover shape: one handler ref');
  assert.deepEqual(manifestFacts.handlerIdsValues, [ADR_095_INVENTORY.liveHandlerId]);
});

test('R2b: MUTATION — six stale refs at the BUMPED version (post-cutover arm) turn ratchet 2 RED', () => {
  const staleRefs = ADR_095_INVENTORY.legacyHandlerIds.map((logicalId) => ({
    logicalId,
    version: '1.0.0',
    digest: manifestFacts.productionCellDigest,
  }));
  const errors = checkR2(
    { phase4Landed: true },
    {
      ...manifestFacts,
      srcVersion: '4.0.0',
      distVersion: '4.0.0',
      handlerIdsValues: [...ADR_095_INVENTORY.legacyHandlerIds],
      handlerRefs: staleRefs,
    },
  );
  assert.ok(errors.some((e) => e.includes('EXACTLY ONE handler ref')),
    `six refs at the bumped version must RED (got: ${errors.join(' | ')})`);
  assert.ok(errors.some((e) => e.includes('retired handler ids still declared')),
    'the retired ids must be named');
});

test('R2c: MUTATION — one-ref reduction at the LEGACY version (the F5 same-version drift shape) turns ratchet 2 RED', () => {
  const oneRef = {
    ...manifestFacts,
    handlerIdsValues: [ADR_095_INVENTORY.liveHandlerId],
    handlerRefs: manifestFacts.handlerRefs.slice(5), // only settlement-policy
  };
  const errors = checkR2({ phase4Landed: false }, { ...oneRef, srcVersion: LEGACY_VERSION, distVersion: LEGACY_VERSION });
  assert.ok(errors.some((e) => e.includes('six-handler baseline')),
    `a reduced manifest at ${LEGACY_VERSION} must RED — this is the manifest half of the F5 STOP-SHIP shape (got: ${errors.join(' | ')})`);
});

test('R2d: MUTATION — post-cutover digest pinned to anything but the production-cell dist bytes turns ratchet 2 RED (F3)', () => {
  const errors = checkR2(
    { phase4Landed: true },
    {
      ...manifestFacts,
      handlerIdsValues: [ADR_095_INVENTORY.liveHandlerId],
      handlerRefs: [{
        logicalId: ADR_095_INVENTORY.liveHandlerId,
        version: '1.1.0',
        digest: manifestFacts.deadDistDigest, // stale pin to the DEAD bytes
      }],
      srcVersion: '3.1.0',
      distVersion: '3.1.0',
    },
  );
  assert.ok(errors.some((e) => e.includes('production-cell dist bytes')),
    `a stale digest pin at the bumped version must RED (got: ${errors.join(' | ')})`);
});

test('R2e: MUTATION — post-cutover handler version NOT bumped turns ratchet 2 RED (Decision 4)', () => {
  const errors = checkR2(
    { phase4Landed: true },
    {
      ...manifestFacts,
      handlerIdsValues: [ADR_095_INVENTORY.liveHandlerId],
      handlerRefs: [{
        logicalId: ADR_095_INVENTORY.liveHandlerId,
        version: '1.0.0', // not bumped
        digest: manifestFacts.productionCellDigest,
      }],
      srcVersion: '3.1.0',
      distVersion: '3.1.0',
    },
  );
  assert.ok(errors.some((e) => e.includes('bumped above the legacy 1.0.0')),
    `an unbumped handler version must RED (got: ${errors.join(' | ')})`);
});

// ===========================================================================
// R3 — full src symbol/table absence (ratchet 3)
// ===========================================================================

test('R3a: post-Phase-5 arm has no removed symbol or table in src (real tree GREEN)', () => {
  const errors = checkR3(srcScan, /* phase4Landed */ true, /* closureInSchema */ false);
  assert.deepEqual(errors, [],
    `today all dead symbols must be confined to the classified dead files + the pinned allowedOutside hosts: ${errors.join(' | ')}`);
});

test('R3b: MUTATION — a legacy dead tool import in a live file turns ratchet 3 RED (both arms)', () => {
  // Mutation class: "a legacy tool import".
  const mutated = [
    ...srcScan,
    ['src/modules/discovery/index.ts',
      srcScan.find(([rel]) => rel === 'src/modules/discovery/index.ts')[1]
        + "\nimport { createDiscoveryProposalHandlers } from './application/discovery-proposal-tools.js';\n"],
  ];
  for (const phase4Landed of [false, true]) {
    const errors = checkR3(mutated, phase4Landed, true);
    assert.ok(errors.some((e) => e.includes('discovery-proposal-tools') && e.includes('src/modules/discovery/index.ts')),
      `the legacy tool import must RED in the phase4Landed=${phase4Landed} arm (got: ${errors.join(' | ')})`);
  }
});

test('R3c: MUTATION — a reintroduced projection write post-cutover turns ratchet 3 RED', () => {
  // Mutation class: "a projection write". Post-cutover the allowed sites are
  // EMPTY — even the former phase-3 host (products.ts) may not call it again.
  const mutated = srcScan.map(([rel, t]) =>
    rel === 'src/tools/products.ts' ? [rel, t + '\nif (requiresDiscoveryProjection(x)) { projectDiscoveryProposal(db, x); }\n'] : [rel, t]);
  const errors = checkR3(mutated, /* phase4Landed */ true, /* closureInSchema */ false);
  assert.ok(errors.some((e) => e.includes('projectDiscoveryProposal') && e.includes('src/tools/products.ts')),
    `the reintroduced projection write must RED post-cutover (got: ${errors.join(' | ')})`);
});

test('R3d: MUTATION — a dead symbol in a WRONG live file (not its pinned host) REDs even pre-cutover', () => {
  // Allowed sites are PER SYMBOL, not global: projectDiscoveryProposal is
  // allowed in products.ts ONLY (until phase 3); anywhere else is RED today.
  const mutated = srcScan.map(([rel, t]) =>
    rel === 'src/modules/module-registration.ts' ? [rel, t + '\nconst sneak = projectDiscoveryProposal;\n'] : [rel, t]);
  const errors = checkR3(mutated, /* phase4Landed */ false, /* closureInSchema */ true);
  assert.ok(errors.some((e) => e.includes('projectDiscoveryProposal') && e.includes('src/modules/module-registration.ts')),
    `a dead symbol outside its pinned host must RED pre-cutover (got: ${errors.join(' | ')})`);
});

test('R3e: MUTATION — a legacy table reference outside schema.ts REDs in the phase-4→5 intermediate arm', () => {
  // Between the version bump and the schema removal, table names are legal
  // ONLY inside src/schema.ts (and the dead files, which are gone by then).
  const mutated = srcScan.map(([rel, t]) =>
    rel === 'src/tools/settlement-debug.ts'
      ? [rel, t + "\nconst q = 'SELECT * FROM factory_proposals';\n"]
      : [rel, t]);
  const errors = checkR3(mutated, /* phase4Landed */ true, /* closureInSchema */ true);
  assert.ok(errors.some((e) => e.includes('factory_proposals') && e.includes('src/tools/settlement-debug.ts')),
    `a legacy table reference outside schema.ts must RED post-cutover (got: ${errors.join(' | ')})`);
});

test('R3f: MUTATION — the REINTRODUCED Discovery settlement query in settlement-debug.ts REDs in TODAY\'s pre-cutover arm (Phase 3.2)', () => {
  // Mutation class (ratchet 8): "a reintroduced legacy query". Before Phase
  // 3.2 this exact text was the tolerated baseline; after the removal the
  // settlement-debug table allowance is GONE, so re-adding the block is RED
  // in every arm — including the current pre-cutover arm.
  const mutated = srcScan.map(([rel, t]) =>
    rel === 'src/tools/settlement-debug.ts'
      ? [rel, t + "\nconst legacy = db.prepare(`SELECT ds.decision FROM factory_discovery_settlements ds WHERE ds.process_run_id = ?`);\n"]
      : [rel, t]);
  for (const phase4Landed of [false, true]) {
    const errors = checkR3(mutated, phase4Landed, /* closureInSchema */ true);
    assert.ok(
      errors.some((e) => e.includes('factory_discovery_settlements') && e.includes('src/tools/settlement-debug.ts')),
      `the reintroduced Discovery settlement query must RED in the phase4Landed=${phase4Landed} arm (got: ${errors.join(' | ')})`,
    );
  }
});

// ===========================================================================
// R4 — dist-aware clean-build absence (ratchet 4)
// ===========================================================================

test('R4a: post-cutover clean build emits no dead module (real tree GREEN)', () => {
  const errors = checkR4(state);
  assert.deepEqual(errors, [],
    `the dist must faithfully mirror the present dead files today (no stale dist): ${errors.join(' | ')}`);
});

test('R4b: MUTATION — an emitted dead module surviving in dist post-cutover turns ratchet 4 RED (F6)', () => {
  const deadEmission = 'dist/modules/discovery/application/discovery-installation.js';
  const mutatedState = {
    ...state,
    phase4Landed: true,
    deadFilesRemaining: [],
    distFiles: new Set([...state.distFiles, deadEmission]),
  };
  const errors = checkR4(mutatedState);
  assert.ok(errors.some((e) => e.includes(deadEmission) && e.includes('clean rebuild')),
    `a stale emitted dead module must RED post-cutover (got: ${errors.join(' | ')})`);
  // And the stale-dist fail-closed: no dist at all refuses to testify.
  const noDist = checkR4({ ...state, distAvailable: false, distFiles: new Set() });
  assert.ok(noDist.some((e) => e.includes('clean build')), 'an absent dist must fail closed');
});

// ===========================================================================
// R5 — fresh DB lacks the full closure (ratchet 5)
// ===========================================================================

test('R5a: real fresh DB through dist/db.js carries none of the legacy closure', async () => {
  const fresh = await createFreshDbObjects(REPO_ROOT);
  const errors = checkR5(fresh, /* phase4Landed */ true);
  assert.deepEqual(errors, [],
    `the fresh-DB closure must be absent after removal: ${errors.join(' | ')}`);
  for (const t of ADR_095_INVENTORY.deadPhase5Tables) {
    assert.equal(fresh.tables.has(t), false, `fresh DB must not create ${t}`);
  }
  for (const i of ADR_095_INVENTORY.deadPhase5Indexes) {
    assert.equal(fresh.indexes.has(i), false, `fresh DB must not create ${i}`);
  }
});

test('R5b: MUTATION — ONE reintroduced legacy CREATE TABLE post-phase-5 turns ratchet 5 RED (partial closure)', () => {
  // Post-phase-5 fresh DB with exactly one legacy table regrown.
  const mutated = {
    tables: new Set(['factory_proposals', ...ADR_095_INVENTORY.keptLive.keptTables]),
    indexes: new Set(ADR_095_INVENTORY.keptLive.keptIndexes),
    triggers: new Set(ADR_095_INVENTORY.keptLive.keptTriggers),
  };
  const errors = checkR5(mutated, /* phase4Landed */ true);
  assert.ok(errors.some((e) => e.includes('PARTIAL legacy closure') && e.includes('factory_proposals')),
    `a single reintroduced legacy CREATE TABLE must RED naming it (got: ${errors.join(' | ')})`);
});

test('R5c: MUTATION — schema closure removed BEFORE the phase-4 cutover turns ratchet 5 RED (F2 ordering)', () => {
  const mutated = {
    tables: new Set(ADR_095_INVENTORY.keptLive.keptTables),
    indexes: new Set(ADR_095_INVENTORY.keptLive.keptIndexes),
    triggers: new Set(ADR_095_INVENTORY.keptLive.keptTriggers),
  };
  const errors = checkR5(mutated, /* phase4Landed */ false);
  assert.ok(errors.some((e) => e.includes('F2') || e.includes('Decision 3')),
    `closure removal before the cutover must RED (got: ${errors.join(' | ')})`);
});

test('R5d: MUTATION — losing the KEPT factory_work_intents table REDs in every state (never part of the removal)', () => {
  const mutated = {
    tables: new Set(ADR_095_INVENTORY.deadPhase5Tables),
    indexes: new Set([
      ...ADR_095_INVENTORY.deadPhase5Indexes,
      ...ADR_095_INVENTORY.keptLive.keptIndexes,
    ]),
    triggers: new Set(ADR_095_INVENTORY.keptLive.keptTriggers),
  };
  const errors = checkR5(mutated, /* phase4Landed */ false);
  assert.ok(errors.some((e) => e.includes('factory_work_intents')),
    `dropping the kept shared-protocol table must RED (got: ${errors.join(' | ')})`);
});

// ===========================================================================
// R6 — live v2 behavior: the hosted executor surface cannot silently widen
// ===========================================================================

test('R6a: the discovery-live-v2 matrix group is EXACTLY the eight inventory live-v2 files (no glob widening)', () => {
  const runnerSource = readFileSync(path.join(REPO_ROOT, 'tools', 'run-acceptance-matrix.mjs'), 'utf8');
  const groupBlock = extractGroupGlobs(runnerSource, 'discovery-live-v2');
  const globs = [...groupBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const expected = [
    'tests/discovery/d7-settlement-lifecycle-classification.test.mjs',
    'tests/discovery/order-constraint-register.test.mjs',
    'tests/matrix/e-constraint-loss.test.mjs',
    'tests/modules/discovery/discovery-check-providers.test.mjs',
    'tests/discovery/d1-1-authority.test.mjs',
    'tests/discovery/d1-1-binding.test.mjs',
    'tests/discovery/d3-readiness-domain.test.mjs',
    'tests/discovery/d4-settlement-policy.test.mjs',
  ];
  assert.deepEqual([...globs].sort(), [...expected].sort(),
    'the ratchet-6 executor group must host EXACTLY the eight proven-live suites — no directory glob, no silent widening');
  assert.ok(!globs.some((g) => g.includes('*')), 'a glob entry would let the hosted live-v2 surface widen silently');
});

function extractGroupGlobs(source, groupName) {
  const decl = source.indexOf(`'${groupName}': {`);
  assert.ok(decl !== -1, `group not found in run-acceptance-matrix.mjs: ${groupName}`);
  const open = source.indexOf('globs: [', decl);
  const close = source.indexOf(']', open);
  assert.ok(open !== -1 && close !== -1, `globs array not found for group ${groupName}`);
  return source.slice(open, close);
}

// ===========================================================================
// R7 — existing-DB boot: anti-gut pin on the owning boot-regression suite
// ===========================================================================

test('R7a: the boot-regression owner still carries the F5 drift oracle (MODULE_INSTALLATION_INCOMPATIBLE_DRIFT)', () => {
  const owner = readFileSync(
    path.join(REPO_ROOT, 'tests', 'process-modules', 'discovery-legacy-removal-boot-regression.test.mjs'),
    'utf8',
  );
  assert.match(owner, /MODULE_INSTALLATION_INCOMPATIBLE_DRIFT/,
    'the F5 STOP-SHIP drift oracle must stay in the boot-regression suite (hosting is pinned by G2h; this pin refuses a gutted-but-green file)');
  assert.match(owner, /installProductionModules/,
    'the proof must keep binding to the engine boot entry (the Phase-1 red-team correction)');
  assert.match(owner, /rehydrate/,
    'the pinned-run exact-package rehydration assertion must stay');
});

// ===========================================================================
// P3 — Phase-3 executed/pending truth in the CANONICAL merged lineage
// (products.ts block = Phase 3.1; settlement-debug block = Phase 3.2;
// runtimePersistence construction + ModuleSharedDeps field = Phase 3.3;
// pending set EMPTY — the Phase-3 exit state)
// ===========================================================================

test('P3a: the phase-3 executed set is ALL FOUR code-blocks (3.1+3.2+3.3) with an EMPTY pending set; the inventory validates against disk', () => {
  // Canonical merged-tree truth (Phase-3 exit): every deadPhase3 entry is
  // EXECUTED — products.ts projection block (3.1), settlement-debug legacy
  // query (3.2, canonical), runtimePersistence construction (3.3), and the
  // ModuleSharedDeps field (3.3). No phase-3 slice remains pending; Phase 4
  // is the next (pending) phase.
  const byPath = Object.fromEntries(ADR_095_INVENTORY.deadPhase3.map((e) => [e.path, e]));
  assert.equal(byPath['src/tools/products.ts'].status, 'executed',
    'Phase 3.1 executes exactly the products.ts projection block');
  assert.equal(byPath['src/tools/settlement-debug.ts'].status, 'executed',
    'Phase 3.2 executes exactly the settlement-debug legacy query block');
  assert.equal(byPath['src/app/product-lifecycle-runtime.ts'].status, 'executed',
    'Phase 3.3 executes the runtimePersistence construction removal');
  assert.equal(byPath['src/modules/module-registration.ts'].status, 'executed',
    'Phase 3.3 executes the ModuleSharedDeps.runtimePersistence field removal');
  assert.deepEqual(
    ADR_095_INVENTORY.deadPhase3.map((e) => e.executedIn).sort(),
    ['Phase 3.1', 'Phase 3.2', 'Phase 3.3', 'Phase 3.3'],
    'the canonical merged lineage executed all four phase-3 slices with exact attribution',
  );
  assert.equal(
    ADR_095_INVENTORY.deadPhase3.filter((e) => e.status === 'pending').length,
    0,
    'the phase-3 pending set is EMPTY (Phase-3 exit)',
  );
  // And the full validator (including the BOTH-direction contentMarker
  // enforcement over the on-disk host files) passes on the real tree.
  validateAdr095Inventory(REPO_ROOT);
});

test('P3b: MUTATION — a LYING phase-3 status is rejected by the inventory validator in both directions', () => {
  // (a) Lying 'executed': since the Phase-3 exit left no REAL pending entry
  //     (whose markers are on disk) to flip, this direction is proven with a
  //     SYNTHETIC mutated inventory (an honest mutation of the DATA, never
  //     of the validator): an executed entry gains a marker that IS
  //     genuinely present in its host file, so the executed claim becomes a
  //     lie the validator must reject on the exact same code path a real
  //     premature execution claim would take.
  const lyingExecutedRuntime = structuredClone(ADR_095_INVENTORY);
  const re = lyingExecutedRuntime.deadPhase3.find(
    (e) => e.path === 'src/app/product-lifecycle-runtime.ts');
  re.contentMarkers = [...re.contentMarkers, 'createProductLifecycleRuntime'];
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, lyingExecutedRuntime),
    /createProductLifecycleRuntime.*untruthful executed state/,
    'claiming execution while a claimed-removed marker is still on disk must throw (runtime host)',
  );

  const lyingExecutedSharedDeps = structuredClone(ADR_095_INVENTORY);
  const me = lyingExecutedSharedDeps.deadPhase3.find(
    (e) => e.path === 'src/modules/module-registration.ts');
  me.contentMarkers = [...me.contentMarkers, 'ModuleSharedDeps'];
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, lyingExecutedSharedDeps),
    /ModuleSharedDeps.*untruthful executed state/,
    'claiming execution while a claimed-removed marker is still on disk must throw (module-registration host)',
  );

  // (b) Lying 'pending': flip an EXECUTED block back to pending — its
  //     markers are ABSENT from disk, so the validator must refuse
  //     (prevents quietly un-executing a landed removal; all four executed
  //     entries are covered — the two flipped here plus the two synthetic
  //     (a)-direction hosts above).
  const lyingPendingSettlement = structuredClone(ADR_095_INVENTORY);
  const se = lyingPendingSettlement.deadPhase3.find(
    (e) => e.path === 'src/tools/settlement-debug.ts');
  se.status = 'pending';
  delete se.executedAt;
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, lyingPendingSettlement),
    /factory_discovery_settlements.*untruthful pending state/,
    'claiming the settlement-debug block is still present must throw',
  );

  const lyingPendingProducts = structuredClone(ADR_095_INVENTORY);
  const pe = lyingPendingProducts.deadPhase3.find(
    (e) => e.path === 'src/tools/products.ts');
  pe.status = 'pending';
  delete pe.executedAt;
  delete pe.executedIn;
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, lyingPendingProducts),
    /projectDiscoveryProposal.*untruthful pending state/,
    'claiming the products.ts projection block is still present must throw',
  );

  const lyingPendingRuntime = structuredClone(ADR_095_INVENTORY);
  const rp = lyingPendingRuntime.deadPhase3.find(
    (e) => e.path === 'src/app/product-lifecycle-runtime.ts');
  rp.status = 'pending';
  delete rp.executedAt;
  delete rp.executedIn;
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, lyingPendingRuntime),
    /discoveryRuntimePersistence.*untruthful pending state/,
    'claiming the runtimePersistence construction is still present must throw',
  );

  const lyingPendingSharedDeps = structuredClone(ADR_095_INVENTORY);
  const mp = lyingPendingSharedDeps.deadPhase3.find(
    (e) => e.path === 'src/modules/module-registration.ts');
  mp.status = 'pending';
  delete mp.executedAt;
  delete mp.executedIn;
  assert.throws(
    () => validateAdr095Inventory(REPO_ROOT, lyingPendingSharedDeps),
    /runtimePersistence.*untruthful pending state/,
    'claiming the ModuleSharedDeps field is still present must throw',
  );
});

// ===========================================================================
// R8 — consolidated gate: every checker GREEN over the real tree, today
// ===========================================================================

test('R8: consolidated real-tree gate — R1..R5 checkers all GREEN after Phase 5', async () => {
  const r1 = checkR1(depTestSource).errors;
  const r2 = checkR2(state, { ...manifestFacts, srcVersion: state.srcVersion, distVersion: state.distVersion });
  const r3 = checkR3(srcScan, state.phase4Landed, state.closureInSchema);
  const r4 = checkR4(state);
  const fresh = await createFreshDbObjects(REPO_ROOT);
  const r5 = checkR5(fresh, state.phase4Landed);
  const all = { r1, r2, r3, r4, r5 };
  for (const [name, errors] of Object.entries(all)) {
    assert.deepEqual(errors, [], `${name} must be green on the real tree (arm selected by the true markers)`);
  }
  // Marker semantics sanity: semver boundary of the phase-4 discriminator.
  assert.equal(semverGt('3.0.3', LEGACY_VERSION), true);
  assert.equal(semverGt('3.1.0', LEGACY_VERSION), true);
  assert.equal(semverGt(LEGACY_VERSION, LEGACY_VERSION), false);
});
