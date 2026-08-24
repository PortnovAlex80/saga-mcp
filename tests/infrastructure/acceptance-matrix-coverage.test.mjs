// CI-02 — acceptance-matrix coverage & no-hidden-failure guard.
//
// Proves the deterministic Factory acceptance matrix is complete and trustworthy:
//   G1  every quarantined file is a real file on disk that is DELIBERATELY
//       skipped (never silently dropped) — and none leaks into a blocking run-set;
//   G2  every required deterministic Factory suite IS in a blocking run-set
//       (factory-model, transition-obligation, local-runnability, the ADR-053
//       cutover gates, the C5 adversarial matrix, the LR-07 readiness binding);
//   G3  the specific known flaky / pre-existing-red files are quarantined;
//   G4  ci.yml has no hidden failures on blocking steps (no `|| true`, no
//       continue-on-error), every matrix group is invoked by CI, and no CI
//       step invokes a group the matrix no longer defines. Both G4d
//       directions use EXACT membership in the comment-stripped extracted
//       invocation set — a group name that merely shares a prefix with an
//       invoked name does not count (CC-U1 repair 2026-08-23).
//   G5  ADR-092 cross-guard: the CC proof-hosting manifest's declared
//       registryGroup must exist in the matrix export and be exactly invoked
//       by CI. This test is hosted in the INDEPENDENT matrix-coverage group
//       (not cc-proof-registry), so a coordinated removal of the registry
//       group AND its CI step AND the registry's own test still leaves THIS
//       check red — the registry cannot bootstrap itself out of existence.
//       The group name is derived from the manifest, never hardcoded.
//
// This is the "small workflow-validation test" required by CI-02: it makes the
// "no required deterministic suite is silently omitted" exit rule machine-checked.
//
// ADR-092: facts come from the MACHINE-READABLE matrix export
// (run-acceptance-matrix.mjs --list-json) — the human --list text is never
// parsed — and the required CI group set is DERIVED from that export (no
// hardcoded group list can lag a rename or a new group).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractInvokedGroups } from '../../tools/cc-proof-hosting-registry.mjs';
import { CC_PROOF_HOSTING_MANIFEST } from './cc-proof-hosting-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runner = path.join(root, 'tools', 'run-acceptance-matrix.mjs');
const ciPath = path.join(root, '.github', 'workflows', 'ci.yml');

const list = spawnSync(process.execPath, [runner, '--list-json'], { cwd: root, encoding: 'utf8' });
assert.equal(list.status, 0, `runner --list-json must exit 0 (got ${list.status})\n${list.stderr}`);
let matrix;
try {
  matrix = JSON.parse(list.stdout);
} catch (error) {
  assert.fail(`--list-json must emit parseable JSON (ADR-092 machine surface): ${error.message}`);
}
assert.ok(matrix.groups && typeof matrix.groups === 'object', 'matrix export must carry a groups object');
assert.ok(Array.isArray(matrix.quarantine), 'matrix export must carry a quarantine array');

const runFiles = Object.values(matrix.groups).flatMap((g) => g.files);
const quarantine = matrix.quarantine;

const runSet = new Set(runFiles);
const qSet = new Set(quarantine.map(q => q.path));

// G1 — quarantined files are real, deliberate skips; no leak into run-sets.
test('G1a: every quarantined file exists on disk', () => {
  assert.ok(quarantine.length >= 6, 'expected at least 6 quarantined files');
  for (const q of quarantine) {
    assert.ok(
      existsSync(path.join(root, q.path)),
      `quarantined file missing on disk: ${q.path}`,
    );
  }
});

test('G1b: no quarantined file leaks into a blocking run-set', () => {
  for (const q of qSet) {
    assert.ok(!runSet.has(q), `quarantined file leaked into a run-set: ${q}`);
  }
});

test('G1c: every quarantine entry has a non-empty kind and reason', () => {
  for (const q of quarantine) {
    assert.match(q.kind, /^(FLAKY|PRE-EXISTING-RED)$/, `bad kind for ${q.path}`);
    assert.ok(q.reason.length > 10, `empty reason for ${q.path}`);
  }
});

// G2 — required deterministic suites are covered (blocking).
test('G2a: factory-model suite is covered', () => {
  assert.ok(runFiles.some(f => f.startsWith('tests/factory-model/')), 'factory-model missing');
});

test('G2b: transition-obligation fencing suites are covered', () => {
  const tos = runFiles.filter(f => /transition-obligation-.*\.test\.mjs$/.test(f));
  assert.ok(tos.length >= 8, `expected >=8 transition-obligation files, got ${tos.length}`);
});

test('G2c: local-runnability-check-provider is covered (run OR quarantined as flaky)', () => {
  const file = 'tests/infrastructure/local-runnability-check-provider.test.mjs';
  assert.ok(
    runSet.has(file) || qSet.has(file),
    'local-runnability-check-provider neither run nor quarantined',
  );
});

test('G2d: ADR-053 cutover gate architecture tests are covered', () => {
  const adr = runFiles.filter(f => /adr-053-.*\.test\.mjs$/.test(f));
  assert.ok(adr.length >= 3, `expected >=3 adr-053 files, got ${adr.length}`);
  assert.ok(
    runSet.has('tests/architecture/adr-053-cutover-gates.test.mjs'),
    'adr-053-cutover-gates must be blocking',
  );
});

test('G2e: C5 carry-forward adversarial matrix is covered', () => {
  assert.ok(
    runSet.has('tests/factory-contract/c5-carry-forward-adversarial-matrix.test.mjs'),
    'C5 adversarial matrix missing',
  );
});

test('G2f: LR-07 development-local-readiness binding is covered', () => {
  assert.ok(
    runSet.has('tests/process-modules/development-local-readiness-binding.test.mjs'),
    'LR-07 readiness binding missing',
  );
});

test('G2g: CC-GAP-8 terminal-exit accounting oracle is covered (proof hosting)', () => {
  // tests/modules/development/development-terminal-exit-accounting.test.mjs
  // is the structural CC-GAP-8 proof (settlement-accounted vs pre-ledger
  // terminal exits, with a RED/GREEN mutation oracle). It was committed but
  // orphaned — no GROUPS entry ran it, so CI never executed the proof.
  // Removing the exact file from the process-modules group must fail HERE,
  // not silently orphan the proof again. Asserted against runSet only (not
  // run-or-quarantined): reclassifying the proof as FLAKY/PRE-EXISTING-RED
  // is not an honest way to drop it.
  assert.ok(
    runSet.has('tests/modules/development/development-terminal-exit-accounting.test.mjs'),
    'development-terminal-exit-accounting must stay in a blocking run-set (CC-GAP-8 proof hosting)',
  );
});

test('G2h: ADR-095 Phase-1 Discovery legacy-removal boot regression is covered (proof hosting)', () => {
  // tests/process-modules/discovery-legacy-removal-boot-regression.test.mjs
  // is the ADR-095 F5 STOP-SHIP proof: same-version Discovery handler
  // logical-ID drift fails closed (MODULE_INSTALLATION_INCOMPATIBLE_DRIFT)
  // and the atomic module-version bump keeps the legacy installation
  // retained while the pinned nonterminal run rehydrates its exact persisted
  // package at boot. Removing the exact file (or dropping it from the
  // process-modules run-set) must fail HERE, not silently orphan the proof.
  // Asserted against runSet only: quarantining the drift proof is not an
  // honest way to drop it.
  assert.ok(
    runSet.has('tests/process-modules/discovery-legacy-removal-boot-regression.test.mjs'),
    'discovery-legacy-removal-boot-regression must stay in a blocking run-set (ADR-095 Phase-1 proof hosting)',
  );
});

test('G2i: the LIVE Discovery v2 suites are hosted blocking (ADR-095 Phase-2 ratchet-6 executor surface)', () => {
  // ADR-095 Phase-2 blocker (a): the Phase-2A four proven-live oracles were
  // CI orphans — committed, green in isolation, executed by nobody. They are
  // the hosted executor surface for ratchet 6 ("live v2 behavior") and
  // ADR-095 Decision 5 preserves them untouched through the entire removal.
  //
  // Phase-2B (audit correction C3): FOUR MORE proven-live orphans joined
  // them (d1-1-authority, d1-1-binding, d3-readiness-domain,
  // d4-settlement-policy — zero dead-surface imports, 62/62 green in
  // isolation 2026-08-24). Removing any exact file (deletion OR de-hosting
  // from the discovery-live-v2 group) must fail HERE. Asserted against
  // runSet only: quarantining a live-v2 oracle is not an honest way to
  // drop it.
  const required = [
    'tests/discovery/d7-settlement-lifecycle-classification.test.mjs',
    'tests/discovery/order-constraint-register.test.mjs',
    'tests/matrix/e-constraint-loss.test.mjs',
    'tests/modules/discovery/discovery-check-providers.test.mjs',
    'tests/discovery/d1-1-authority.test.mjs',
    'tests/discovery/d1-1-binding.test.mjs',
    'tests/discovery/d3-readiness-domain.test.mjs',
    'tests/discovery/d4-settlement-policy.test.mjs',
  ];
  for (const f of required) {
    assert.ok(
      runSet.has(f),
      `${f} must stay in a blocking run-set (ADR-095 Phase-2 live-v2 hosting; ratchet 6)`,
    );
  }
});

test('G2j: migration-conformance is hosted blocking green-on-legacy-baseline (ADR-095 Phase-2 blocker (b) resolution)', () => {
  // tests/execution/migration-conformance.test.mjs was unhosted. What it
  // actually hard-pins on the Discovery side (red-team F2 scope correction):
  // the dist imports of the DEAD discovery-settlement-repository.js
  // (restart lane) and discovery-outcome-certificate-projection.js
  // (exact-output lane), plus the fresh-DB factory_proposals INSERT seed.
  // It does NOT assert the six-handler count/IDs — its package-isolation
  // lane validates discoveryPackageManifest structurally only; handler
  // shape is owned by
  // tests/architecture/handler-digest-runtime-consistency.test.mjs + the
  // Phase-4 hard ratchet (same-commit repin to the one-handler
  // production-cell digest). It is green on exactly that legacy baseline
  // (35/35, 2026-08-24) WITHOUT repinning (the production surface has not
  // changed yet). Its MANDATORY same-commit Phase-4 migration (the two dead
  // imports + the factory_proposals seed) is recorded machine-readably in
  // tests/infrastructure/adr-095-removal-inventory.mjs
  // (mandatoryPhase4Repins). Removing the exact file or dropping it from the
  // process-modules run-set must fail HERE — an unhosted migration proof
  // proves nothing.
  assert.ok(
    runSet.has('tests/execution/migration-conformance.test.mjs'),
    'migration-conformance must stay in a blocking run-set (ADR-095 Phase-2 hosting; Phase-4 same-commit repin owed)',
  );
});

test('G2k: the ADR-095 eight-ratchet suite is hosted blocking (Phase-2C proof hosting)', () => {
  // tests/architecture/adr-095-ratchet-suite.test.mjs is the COMPLETE
  // eight-ratchet set required by ADR-095 Phase 2 ("ratchets first") plus
  // the machine-executed mutation negatives (ratchet 8 non-vacuity): the
  // shrinking-allowlist ceiling, the two-armed one-handler manifest/digest
  // ratchet keyed on the atomic version bump, the src symbol/table absence
  // scan (inventory removalSymbols, schemaVersion 3), the dist-aware
  // clean-build absence, and the fresh-DB closure state machine. Removing
  // the exact file (deletion OR de-hosting from the architecture run-set)
  // must fail HERE, not silently orphan the ratchet set. Asserted against
  // runSet only: quarantining the ratchet suite is not an honest way to
  // drop it.
  assert.ok(
    runSet.has('tests/architecture/adr-095-ratchet-suite.test.mjs'),
    'adr-095-ratchet-suite must stay in a blocking run-set (ADR-095 Phase-2C eight-ratchet proof hosting)',
  );
});

test('G2l: the conveyor v4.3 focused-invariants suite is hosted blocking (ADR-095 Phase-3.1 migrated live oracle)', () => {
  // tests/replay/conveyor-v4.3-focused-invariants.test.mjs carries the 11
  // live conveyor invariants (executor-kind unification, capsule routing,
  // retired-simulator exclusion, replay-capsule payload shape, idempotency
  // binding, gate-rejected/failed-replay detectability, replay-certification
  // fail-closure) plus the Phase-3.1-migrated invariant 5 that drives the
  // REAL projection-free product_submit handler and proves the negative
  // (no discovery_proposal_id field, no factory_proposals row, no
  // proposal-ref side product, fenced resubmit). Red Team LOW-1 (canonical
  // Phase-3.1 integration): it was committed but hosted in NO group — the
  // same orphan class CC-GAP-8 closed, so CI never executed the migrated
  // oracle. Removing the exact file (deletion OR de-hosting from the
  // process-modules run-set) must fail HERE, not silently orphan the
  // oracle again. Asserted against runSet only: reclassifying the live
  // conveyor oracle as FLAKY/PRE-EXISTING-RED is not an honest way to drop
  // it. Its Phase-5 same-commit repin obligation (the factory_proposals
  // negative assertion must flip to table-absence when the fresh-schema
  // closure is removed) is recorded machine-readably in
  // tests/infrastructure/adr-095-removal-inventory.mjs
  // (mandatoryPhase5Repins).
  assert.ok(
    runSet.has('tests/replay/conveyor-v4.3-focused-invariants.test.mjs'),
    'conveyor-v4.3-focused-invariants must stay in a blocking run-set (ADR-095 Phase-3.1 migrated live conveyor oracle hosting)',
  );
});

test('G2m: BOTH BM-5 file-identity suites are hosted blocking (per-file de-hosting/removal guard)', () => {
  // GUARD ID NOTE (canonical BM-5 integration, 2026-08-24): this guard was
  // authored as `G2k` on the stage22/bm5-file-identity branch, whose base
  // predated ADR-095 Phase-2C/3. Canonical saga4 had already assigned G2k
  // (ADR-095 eight-ratchet suite) and G2l (conveyor v4.3 focused-invariants,
  // Phase-3.1); BOTH canonical guards are kept, and this BM-5 guard is
  // renamed to the next genuinely free ID G2m. Semantics unchanged: runSet
  // membership only, quarantine does not count.
  // The BM-5/MM-4 repair (Elite-8 counterexample, 2026-08-24) landed TWO
  // suites as exact-file adoptions in the process-modules group:
  //   - srs-file-identity-satisfiability.test.mjs — the §2.2 × §D2/§D1
  //     cross-section satisfiability proof (Elite-8 counterexample pass,
  //     genuine-gap rejection, ambiguous conflict + plan-independence, P08
  //     module-relative resolution, masking/directory/registerless
  //     corrections, no-fallback policy);
  //   - srs-derived-change-scopes.test.mjs — the derivation half (shared
  //     §D2/§D1 surface + EMPTY-when-underivable policy), previously an
  //     unhosted orphan (the TC-5/TC-7 guard gap the red team flagged).
  // Deleting either file OR dropping it from the run-set must fail HERE,
  // not silently orphan the proof again (the recurring orphan-hosting
  // death class, RED-TEAM-AUDIT §"per-file removal guards"). Asserted
  // against runSet only: reclassifying a BM-5 proof as FLAKY or
  // PRE-EXISTING-RED is not an honest way to drop it.
  const required = [
    'tests/modules/development/srs-file-identity-satisfiability.test.mjs',
    'tests/modules/development/srs-derived-change-scopes.test.mjs',
  ];
  for (const f of required) {
    assert.ok(
      runSet.has(f),
      `${f} must stay in a blocking run-set (BM-5 file-identity proof hosting)`,
    );
  }
});

test('G2n: the BM-5 upstream-routing proof is hosted blocking (per-file removal/de-hosting guard)', () => {
  // GUARD ID NOTE (canonical BM-5 integration, 2026-08-24): this guard was
  // authored as `G2l` on the stage22/bm5-file-identity branch, whose base
  // predated ADR-095 Phase-2C/3. Canonical saga4 had already assigned G2l
  // to the conveyor v4.3 focused-invariants suite (Phase-3.1 migrated live
  // oracle); that canonical guard is kept, and this BM-5 guard is renamed
  // to the next genuinely free ID G2n (G2m being the renamed BM-5
  // file-identity pair guard). runSet semantics unchanged: membership only,
  // quarantine does not count.
  // tests/factory-contract/srs-identity-upstream-routing.test.mjs — the BM-5
  // Red-Team correction follow-up (2026-08-24, gate v1.4.0): code-scoped
  // upstream routing for plan-independent frozen-SRS defects. The planner
  // check plans declare upstreamOwnedFailureCodes; the gate reducer
  // escalates EXACTLY receipts carrying srs-file-identity-conflict /
  // srs-artifact-drifted / srs-module-manifest-missing to the
  // producer-defect verdict 'failed' (no planner repair budget burned),
  // while genuine plan errors from the same entry keep author repair.
  // Unlike the G2m pair this suite has NO exact-file entry in
  // run-acceptance-matrix.mjs — it is hosted by the factory-contract GROUP
  // GLOB — so nothing else pins it per-file. Deleting the file, narrowing
  // the glob away from it, or dropping it from the run-set must fail HERE,
  // not silently orphan the proof again (the recurring orphan-hosting
  // death class, RED-TEAM-AUDIT §"per-file removal guards"). Asserted
  // against runSet only: reclassifying the routing proof as FLAKY or
  // PRE-EXISTING-RED is not an honest way to drop it.
  assert.ok(
    runSet.has('tests/factory-contract/srs-identity-upstream-routing.test.mjs'),
    'srs-identity-upstream-routing must stay in a blocking run-set (BM-5 upstream-routing proof hosting)',
  );
});

// G2k — STAGE-23 desk-zone completeness ratchet (2026-08-24 desk audit).
// The desk-coverage group closed the desk orphan class; this guard keeps it
// closed: every desk-zone suite must be hosted in a blocking run-set or
// quarantined with a reason. A new desk suite can never silently join the
// CC-GAP-8 orphan class again.
test('G2o: every workshop desk suite is hosted or quarantined (desk-zone completeness ratchet)', () => {
  const deskZones = [
    'tests/discovery',
    'tests/modules/discovery',
    'tests/modules/formalization',
    'tests/modules/development',
    'tests/modules/delivery',
    // second sweep (2026-08-24): the SRS-004 AC-9 planner directory is a
    // desk zone sitting outside tests/modules — same ratchet.
    'tests/planner-ac9',
  ];
  const orphans = [];
  for (const zone of deskZones) {
    const dir = path.join(root, zone);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.test.mjs')) continue;
      const rel = `${zone}/${name}`;
      if (!runSet.has(rel) && !qSet.has(rel)) orphans.push(rel);
    }
  }
  assert.deepEqual(orphans, [],
    'desk-zone orphans found — every workshop desk suite must be hosted in a blocking '
    + 'group (or quarantined with a documented reason) in the same commit it lands');
});

// G2l — R1 omnibus closure ratchet (2026-08-24 orphan research): NO test file
// in the repository may be an orphan. Every *.test.mjs must be hosted in a
// blocking run-set, quarantined with a reason, or on the explicit LIVE
// allowlist (declared live-sandbox preconditions that skip everywhere —
// hosting them adds no CI signal and would fake coverage with a green dot).
// This makes the CC-GAP-8 orphan class (committed but never executed)
// structurally impossible repo-wide.
const LIVE_SANDBOX_ALLOWLIST = new Set([
  'tests/app/factory-redevelopment.test.mjs',
  'tests/infrastructure/development-verification-continuation-live.test.mjs',
]);
test('G2p: the repository has ZERO orphan test files (R1 omnibus ratchet)', () => {
  const tracked = spawnSync('git', ['ls-files', '*.test.mjs'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(tracked.status, 0, 'git ls-files must succeed');
  const ciText = readFileSync(ciPath, 'utf8');
  const ciInvoked = new Set(
    [...ciText.matchAll(/(?:node(?:\s+--test)?\s+)((?:tests|tools)\/[A-Za-z0-9_\/.-]+\.mjs)/g)].map((m) => m[1]),
  );
  const orphans = [];
  for (const file of tracked.stdout.trim().split('\n').filter(Boolean)) {
    if (runSet.has(file) || qSet.has(file) || LIVE_SANDBOX_ALLOWLIST.has(file) || ciInvoked.has(file)) continue;
    orphans.push(file);
  }
  assert.deepEqual(orphans, [],
    'orphan test files found — every suite must be hosted in a blocking group, quarantined '
    + 'with a reason, or (live-sandbox class) added to LIVE_SANDBOX_ALLOWLIST in the same '
    + 'commit it lands');
});

test('G2q: engine-start-adoption exact task-binding regressions stay blocking (task-shadow)', () => {
  assert.ok(
    runSet.has('tests/infrastructure/engine-start-adoption.test.mjs'),
    'engine-start-adoption must stay in a blocking run-set (task-shadow exact-binding proof hosting)',
  );
});

test('G2r: CC-GAP-7 warrant-oracle mutations stay blocking', () => {
  assert.ok(
    runSet.has('tests/infrastructure/local-runnability-warrant-oracle.test.mjs'),
    'CC-GAP-7 warrant-oracle proof must stay in a blocking run-set',
  );
});

// G2s — snapshot corpus port hosting (2026-08-24, canonical consistency plan
// Phase 2). The zero-token snapshot corpus regression
// (snapshot-reach-development: byte/trace-exact replay of the captured
// stage-11 run through the real orchestrate-cli/MCP seam) and its negative
// half (snapshot-corpus-negative: corrupted material / missing package
// bytes / invalid transition order / stale authority identity fail-closed)
// are hosted by the factory-contract GROUP GLOB — no exact-file matrix
// entry, so nothing else pins them per-file. Deleting either file, narrowing
// the glob away from it, or dropping it from the run-set must fail HERE,
// not silently orphan the corpus proof (the recurring orphan-hosting death
// class, RED-TEAM-AUDIT §"per-file removal guards"). The tape helper
// snapshot-stage11-scenarios.mjs is a non-test module (no *.test.mjs glob
// match by design); removing it turns both hosted suites red at import, so
// the pair guard covers it transitively. Asserted against runSet only:
// quarantining a corpus proof as FLAKY/PRE-EXISTING-RED is not an honest
// way to drop it.
test('G2s: BOTH snapshot corpus suites are hosted blocking (per-file removal/de-hosting guard)', () => {
  const required = [
    'tests/factory-contract/snapshot-reach-development.test.mjs',
    'tests/factory-contract/snapshot-corpus-negative.test.mjs',
  ];
  for (const f of required) {
    assert.ok(
      runSet.has(f),
      `${f} must stay in a blocking run-set (snapshot corpus port proof hosting)`,
    );
  }
});

// G2t — ADR-096 gate item 2 (W3, 2026-08-25): the K4 crash/fault edges are
// BLOCKING. The four ADR-048 worker-boundary crash suites (exit before
// product submission / exit after submission before worker_done / accepted
// receipt authoritative / terminal execution with stale host) were
// quarantined whole-directory as FLAKY by CI-02; re-validated green on the
// current baseline (isolation AND the hosted k4-fault-edges group form),
// they were de-quarantined into that blocking group — the STAGE-23
// revalidation precedent. Deleting any file, dropping it from the run-set,
// or re-quarantining it must fail HERE, not silently unblock the ADR-096
// gate. Asserted against runSet only: quarantining a crash-edge proof is
// not an honest way to drop it.
test('G2t: the four ADR-048 worker-boundary crash suites are hosted blocking (K4 fault edges, ADR-096 gate item 2)', () => {
  const required = [
    'tests/factory-temporal/worker-boundary-1-exit-pre-submit.test.mjs',
    'tests/factory-temporal/worker-boundary-2-exit-post-submit.test.mjs',
    'tests/factory-temporal/worker-boundary-3-receipt-authoritative.test.mjs',
    'tests/factory-temporal/worker-boundary-4-stale-host.test.mjs',
  ];
  for (const f of required) {
    assert.ok(
      runSet.has(f),
      `${f} must stay in a blocking run-set (K4 crash/fault edges are blocking per ADR-096 gate item 2)`,
    );
    assert.ok(
      !qSet.has(f),
      `${f} must NOT be re-quarantined — it was de-quarantined 2026-08-25 after per-file revalidation; a fresh failing run is required first`,
    );
  }
});

// G2u — ADR-096 gate item 2 (W3, 2026-08-25): the measured, non-zero,
// deterministic mutation-kill floor is BLOCKING.
// tests/factory-proof/mutation-kill-floor.test.mjs compiles the pinned
// register of architectural-ban mutants (execution-scoped lookup, latest-wins
// selection, scope-fence bypass, authority digest skip) through the shared
// mutation algebra and measures the kills against real dist/ rejection
// boundaries (21/21, zero survivors). Removing the exact file or dropping it
// from the factory-proof run-set must fail HERE — an unhosted kill floor
// proves nothing. Asserted against runSet only.
test('G2u: the ADR-096 mutation-kill floor suite is hosted blocking (measured, non-zero)', () => {
  assert.ok(
    runSet.has('tests/factory-proof/mutation-kill-floor.test.mjs'),
    'mutation-kill-floor must stay in a blocking run-set (ADR-096 gate item 2: non-zero mutation kill floor is blocking)',
  );
});

// G3 — specific known flaky / pre-existing-red files are quarantined.
// STAGE-23 (2026-08-24): development-task-graph-diagnostics was REMOVED from
// the required list — re-validated GREEN (2/2) on the current baseline; the
// stale producerExecutionRef mock rotted away upstream but the quarantine was
// never re-checked (the R2 defect). It now runs in the process-modules group.
test('G3: known flaky / pre-existing-red files are quarantined', () => {
  const required = [
    'tests/factory-contract/golden-path.test.mjs',
    'tests/factory-contract/parallel-git-desk.test.mjs',
    'tests/architecture/submission-validator-diagnostics.test.mjs',
  ];
  for (const f of required) {
    assert.ok(qSet.has(f), `required quarantine missing: ${f}`);
  }
  assert.ok(!qSet.has('tests/process-modules/development-task-graph-diagnostics.test.mjs'),
    'development-task-graph-diagnostics was de-quarantined 2026-08-24 (re-validated green) '
    + 'and must not be re-quarantined without a fresh failing run');
  // factory-temporal: the L3 composition files stay quarantined. The four
  // worker-boundary crash suites were de-quarantined 2026-08-25 (ADR-096
  // gate item 2, hosted blocking in k4-fault-edges, guard G2t) — only the
  // remaining composition files keep the FLAKY quarantine.
  const temporal = quarantine.filter(q => q.path.startsWith('tests/factory-temporal/'));
  assert.ok(temporal.length >= 5, `factory-temporal quarantine incomplete: ${temporal.length}`);
  for (const q of temporal) {
    assert.ok(!q.path.includes('worker-boundary'),
      `${q.path}: the worker-boundary crash suites were de-quarantined 2026-08-25 and must not be re-quarantined (G2t)`);
  }
});

test('G3b: flaky quarantine entries reference either the W9 replacement or a stabilization plan', () => {
  for (const q of quarantine) {
    if (q.kind === 'FLAKY') {
      assert.match(
        q.reason,
        /W9|stabilize|stabilization|cold-start|real (command|process) execution/i,
        `flaky quarantine must note W9 replacement OR a stabilization reason: ${q.path}`,
      );
    }
  }
});

// G4 — ci.yml has no hidden failures on blocking steps.
// Comments are stripped first so that documenting a forbidden pattern (e.g. an
// inline "no `|| true`" note) is not mistaken for the pattern itself.
const ciRaw = readFileSync(ciPath, 'utf8');
const ci = ciRaw.split(/\r?\n/).map(line => line.replace(/(^|\s)#.*$/, '$1')).join('\n');

// The comment-stripped EXTRACTED invocation set: the only form in which CI
// group invocations may be compared (CC-U1 repair 2026-08-23). Substring
// probes like ci.includes(`--group ${g}`) are prefix-colliding — a CI step
// invoking `--group process-modules-shadow` would satisfy a check for
// `process-modules` — so G4d/G5 use exact Set membership over the tokens
// extractInvokedGroups() actually parsed.
const ciInvokedList = [...new Set(extractInvokedGroups(ci))];
const ciInvokedExact = new Set(ciInvokedList);

test('G4a: ci.yml has no `|| true` hiding a blocking step failure', () => {
  // A bare `|| true` in any run command silently swallows non-zero exits.
  assert.ok(!/\|\|\s*true/.test(ci), 'ci.yml contains a hidden `|| true` failure');
});

test('G4b: ci.yml has no continue-on-error on any step', () => {
  assert.ok(!/continue-on-error/.test(ci), 'ci.yml contains continue-on-error');
});

test('G4c: ci.yml does not run the blanket `npm test` step', () => {
  // The blanket step ran every *.test.mjs (flaky + red); it must be gone.
  assert.ok(!/^\s*run:\s*npm\s+test\s*$/m.test(ci), 'ci.yml still runs blanket `npm test`');
});

test('G4d: ci.yml invokes EVERY acceptance-matrix group and no unknown group (derived from the machine-readable export, EXACT invocation membership)', () => {
  // ADR-092: the required group set is DERIVED from the matrix export — a
  // hardcoded list here could silently lag a group rename, a removal, or a
  // newly added group (exactly how the CC-GAP-8 proof went orphaned).
  // Direction 1: every matrix group must have a blocking CI step. EXACT
  // membership in the extracted invocation set: a prefix-sharing group name
  // (e.g. CI invoking `--group X-shadow` when the matrix defines `X`) must
  // NOT satisfy the requirement (CC-U1 repair 2026-08-23: the previous
  // substring `ci.includes(...)` probe was prefix-colliding).
  const matrixGroups = Object.keys(matrix.groups).sort();
  assert.ok(matrixGroups.length >= 7, `expected at least 7 matrix groups, got ${matrixGroups.length}`);
  for (const g of matrixGroups) {
    assert.ok(
      ciInvokedExact.has(g),
      `ci.yml missing blocking step for matrix group '${g}' (exact '--group ${g}' invocation required — a longer name sharing this prefix does not count)`,
    );
  }
  // Direction 2: every `--group X` CI invokes must be a group the matrix
  // still defines — a stale step after a rename/removal is dead wiring.
  assert.ok(ciInvokedList.length >= 7, `expected ci.yml to invoke at least 7 groups, got ${ciInvokedList.length}`);
  for (const g of ciInvokedList) {
    assert.ok(
      Object.hasOwn(matrix.groups, g),
      `ci.yml invokes '--group ${g}' but the acceptance matrix defines no such group (stale wiring)`,
    );
  }
});

// G5 — ADR-092 / CC-U1 coordinated-removal cross-guard (independently hosted).
//
// The registry layer (tools/cc-proof-hosting-registry.mjs +
// cc-proof-hosting.test.mjs) proves manifest <-> matrix <-> CI closure, but
// ALL of it runs inside the cc-proof-registry group — the very group it
// guards. Deleting that group AND its CI step together orphaned the registry's
// own test and left G4d green (both sides of the bijection shrank
// consistently): a silent bootstrap removal. This check lives in the
// SEPARATE matrix-coverage group, derives the registry group from the
// manifest (never hardcoded), and fails when the declared registryGroup is
// absent from the matrix export or not exactly invoked by CI — even when the
// registry group, its CI step, and the registry's own test file are all gone.
test('G5: the manifest-declared CC proof-registry group exists in the matrix export and is exactly invoked by CI (ADR-092 coordinated-removal cross-guard)', () => {
  const registryGroup = CC_PROOF_HOSTING_MANIFEST.registryGroup;
  assert.ok(
    typeof registryGroup === 'string' && registryGroup.trim().length > 0,
    'the CC proof-hosting manifest must declare a non-empty registryGroup',
  );
  assert.ok(
    Object.hasOwn(matrix.groups, registryGroup),
    `manifest.registryGroup '${registryGroup}' is missing from the matrix export — coordinated removal of the registry group and its CI step must not leave matrix-coverage green`,
  );
  assert.ok(
    ciInvokedExact.has(registryGroup),
    `ci.yml does not invoke '--group ${registryGroup}' exactly (real CI invocation set: [${ciInvokedList.join(', ')}]) — coordinated removal of the registry group and its CI step must not leave matrix-coverage green`,
  );
});

test('G4e: dispatcher-race step excludes pre-existing-red worktree-isolation.mjs', () => {
  // worktree-isolation.mjs is a plain .mjs (not *.test.mjs); it is excluded from
  // the dispatcher-race step directly. ci.yml must reference the green scripts
  // and must NOT invoke worktree-isolation.mjs.
  assert.ok(/dispatcher-race/.test(ci), 'ci.yml missing a dispatcher-race step');
  assert.ok(
    !/worktree-isolation\.mjs/.test(ci),
    'ci.yml invokes quarantined worktree-isolation.mjs',
  );
});

test('G4f: ci.yml runs the cgad-spec-lint unit test and the evidence validator', () => {
  assert.ok(ci.includes('tools/cgad-spec-lint.test.mjs'), 'cgad-spec-lint test missing');
  assert.ok(ci.includes('validate-completion-evidence.mjs'), 'evidence validator missing');
});
