#!/usr/bin/env node
// CI-02 — deterministic Factory acceptance matrix runner.
//
// Replaces the blanket `npm test` (= `tsc && node --test`), which discovered and
// ran EVERY *.test.mjs under the tree — including FLAKY and pre-existing-RED
// files — so its exit code was never a trustworthy blocking signal. This runner
// is the opposite: it runs ONLY the deterministic Factory acceptance suites,
// each as its own isolated `node --test` process (group), and EXCLUDES every
// quarantined suite/file with a documented reason. Nothing is hidden: no
// `|| true`, no continue-on-error, no retries. A red group fails the matrix.
//
// Why isolated groups instead of one blanket invocation: running the whole tree
// in a single `node --test` process causes cross-suite state contention (shared
// SQLite temp DBs, served-process ports, orchestrate-cli replay capsules) that
// turns deterministically-green suites red. The integrator classified each suite
// in isolation; the matrix reproduces that isolation. See
// docs/factory/CI-02-ACCEPTANCE-MATRIX.md for the full classification evidence.
//
// Usage:
//   node tools/run-acceptance-matrix.mjs                 # run every group (blocking)
//   node tools/run-acceptance-matrix.mjs --group architecture
//   node tools/run-acceptance-matrix.mjs --list          # coverage proof, run nothing (human)
//   node tools/run-acceptance-matrix.mjs --list-json     # machine-readable export (ADR-092)
//
// Mirrors the directory-scan + --list style of run-process-module-tests.mjs.
// The quarantine table below is the single source of truth; the coverage test
// tests/infrastructure/acceptance-matrix-coverage.test.mjs asserts it.
//
// ADR-092 (CC-U1 proof registration): --list-json is the STRUCTURED group
// registry consumed by validation and tests (acceptance-matrix-coverage,
// cc-proof-hosting). Consumers MUST NOT regex-parse the human --list text:
// the JSON export is the only supported machine surface, so notes/prose can
// change without breaking a validator.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// CI-03: the *.mjs suites import from dist/, so dist/ MUST exist. In CI it is
// built by the `npm run build` step; for standalone/local invocations the runner
// builds it on demand (once) so `node tools/run-acceptance-matrix.mjs` is
// self-contained on a clean checkout.
let distEnsured = false;
function ensureDist() {
  if (distEnsured || existsSync(path.join(root, 'dist'))) { distEnsured = true; return; }
  console.log('[acceptance-matrix] dist/ absent — running `npm run build` (tsc emit)…');
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true });
  if (build.status !== 0) {
    console.error('[acceptance-matrix] build failed — cannot run matrix without dist/');
    process.exit(build.status ?? 1);
  }
  distEnsured = true;
}

// --- Factory acceptance matrix groups ---------------------------------------
// Each group is a deterministic-green Factory acceptance suite, run as ONE
// isolated `node --test` process (its own blocking CI step). Globs are expanded
// against the working tree; quarantined matches (see QUARANTINE) are removed
// before execution. `concurrency: 1` reproduces the proven process-modules
// runner sequencing where the suite needs strict ordering for determinism.
const GROUPS = {
  architecture: {
    globs: ['tests/architecture/*.test.mjs'],
    note: 'ADR-053 cutover gates, dependency-direction ratchet, conveyor boundaries',
  },
  'factory-model': {
    globs: ['tests/factory-model/*.test.mjs'],
    note: 'dual-cycle generated model',
  },
  'readiness-fencing': {
    globs: [
      'tests/infrastructure/transition-obligation-*.test.mjs',
    ],
    note: 'C7 monotonic lease fencing (deterministic). LR local-readiness real-execution is quarantined — see QUARANTINE.',
  },
  'factory-contract': {
    globs: ['tests/factory-contract/*.test.mjs'],
    note: 'C5 carry-forward adversarial matrix + production-cell transitions',
  },
  'process-modules': {
    globs: [
      'tests/process-modules/*.test.mjs',
      // CC-GAP-8: the criterion-key verification-accounting ledger suite
      // (terminal-route facts, no-poison, blocking mutations) is a BLOCKING
      // development-module acceptance proof — not blanket-`npm test` material.
      'tests/modules/development/verification-ledger.test.mjs',
      // CC-GAP-8 proof hosting: the terminal-exit accounting structural
      // oracle (every reachable Development terminal exit is settlement-
      // accounted or provably pre-ledger; RED/GREEN on the rejected
      // df7359fa edges) was committed but orphaned — no group ran it, so CI
      // never executed it. Exact file on purpose: no directory glob, so the
      // hosted CC-GAP-8 proof surface cannot silently widen. The coverage
      // test (G2g) fails if this entry is removed.
      'tests/modules/development/development-terminal-exit-accounting.test.mjs',
      // ELITE-8 seam (same orphan class): the worker prompt-assembly suite
      // (buildPrompt/projectTaskForPrompt contracts, incl. the G1.9
      // recovery_feedback prompt-snowball bound) lived at tests/ root —
      // matched by NO group glob, so CI never executed it. Exact file on
      // purpose: no directory glob, the surface cannot silently widen.
      'tests/worker-prompt-assembly.test.mjs',
      // The 2026-08-23 desk-coverage audit found SIX more orphans of the
      // same class (committed by the closure program, hosted by nobody):
      // the planner-desk GAP-6 suites and the readiness-desk substrate
      // suites. Exact files, same GAP-8 hosting pattern.
      'tests/modules/development/task-graph-register-conditional-coverage.test.mjs',
      'tests/modules/development/task-graph-gate-srs-manifest.test.mjs',
      'tests/infrastructure/local-runnability-substrate-retry.test.mjs',
      'tests/infrastructure/local-runnability-toctou-reprobe.test.mjs',
      'tests/infrastructure/environment-identity.test.mjs',
      'tests/infrastructure/local-runnability-seam-compose.test.mjs',
      // ADR-095 Phase-2A (blocker (b) resolution): the migration-conformance
      // suite was unhosted AND hard-pins legacy Discovery surfaces — the
      // dist imports of the dead discovery-settlement-repository.js /
      // discovery-outcome-certificate-projection.js plus the fresh-DB
      // factory_proposals INSERT seed. It does NOT assert the six-handler
      // count/IDs (its package-isolation lane validates the manifest
      // structurally only; handler shape is owned by the
      // handler-digest-runtime-consistency suite + the Phase-4 hard
      // ratchet). It is GREEN on the current legacy baseline (35/35,
      // 2026-08-24) and hosted here WITHOUT repinning — the production
      // surface has not changed yet. The mandatory SAME-COMMIT Phase-4
      // migration is recorded in
      // tests/infrastructure/adr-095-removal-inventory.mjs
      // (mandatoryPhase4Repins) and pinned by coverage guard G2j. Exact file
      // on purpose: no directory glob, the surface cannot silently widen.
      'tests/execution/migration-conformance.test.mjs',
      // ADR-095 Phase-3.1 canonical integration (Red Team LOW-1): the
      // conveyor v4.3 focused-invariants suite (11 live conveyor
      // invariants, including the Phase-3.1-migrated projection-free
      // product_submit invariant 5 with its negative proofs) was committed
      // but hosted in NO group — the same orphan class CC-GAP-8 closed.
      // Deterministic standalone (10/10 green, temp DB via DB_PATH, env
      // restored in finally; node --test isolates each file in its own
      // process). Exact file on purpose: no directory glob, so the hosted
      // surface cannot silently widen. The removal/de-hosting guard is G2l
      // in tests/infrastructure/acceptance-matrix-coverage.test.mjs; its
      // Phase-5 same-commit repin obligation (the factory_proposals
      // negative assertion) is recorded machine-readably in
      // tests/infrastructure/adr-095-removal-inventory.mjs
      // (mandatoryPhase5Repins).
      'tests/replay/conveyor-v4.3-focused-invariants.test.mjs',
    ],
    concurrency: 1,
    note: 'module composition + LR-07 development-local-readiness binding + CC-GAP-8 verification-accounting ledger + terminal-exit accounting oracle + worker prompt-assembly contracts + ADR-095 migration-conformance (green on legacy baseline, Phase-4 repin owed) + ADR-095 conveyor v4.3 focused-invariants (Phase-3.1 migrated live oracle, Phase-5 repin owed)',
  },
  // ADR-095 Phase-2A (blocker (a) resolution): the four proven LIVE Discovery
  // v2 oracles were CI orphans — no blocking run-set and no quarantine hosted
  // them, so ratchet 6 ("live v2 behavior") had no hosted executor. Narrowly
  // justified EXACT-FILE group (no directory globs — the hosted live-v2
  // surface cannot silently widen). Per-file removal guards G2i in
  // tests/infrastructure/acceptance-matrix-coverage.test.mjs make deletion or
  // de-hosting fail the coverage suite. ADR-095 Decision 5 preserves these
  // suites untouched through the whole removal.
  //
  // ADR-095 Phase-2B (audit correction C3): FOUR MORE proven-live orphans
  // were found unhosted by the same test — d1-1-authority, d1-1-binding
  // (D1 authority/binding over live db/schema/dispatcher infra),
  // d3-readiness-domain (live readiness-assessment domain), and
  // d4-settlement-policy (live settlement-policy/input/readiness domains).
  // All four import ZERO dead Discovery surfaces (verified by dist-import
  // scan 2026-08-24) and are green (62/62 combined in isolation). Hosted
  // here BLOCKING; exact files, same no-widening rule.
  'discovery-live-v2': {
    globs: [
      'tests/discovery/d7-settlement-lifecycle-classification.test.mjs',
      'tests/discovery/order-constraint-register.test.mjs',
      'tests/matrix/e-constraint-loss.test.mjs',
      'tests/modules/discovery/discovery-check-providers.test.mjs',
      'tests/discovery/d1-1-authority.test.mjs',
      'tests/discovery/d1-1-binding.test.mjs',
      'tests/discovery/d3-readiness-domain.test.mjs',
      'tests/discovery/d4-settlement-policy.test.mjs',
    ],
    note: 'ADR-095 Phase-2A/2B live-v2 hosting — settlement lifecycle classification (m1-m6), order-constraint register round-trip, E constraint-loss boundary matrix, live check providers, D1 authority + binding, D3 readiness domain, D4 settlement-policy domain. Ratchet-6 executor surface; never weakened, never quarantined.',
  },
  'matrix-coverage': {
    globs: ['tests/infrastructure/acceptance-matrix-coverage.test.mjs'],
    note: 'CI-02 self-check — matrix completeness + no-hidden-failure guard',
  },
  // ADR-092 / CC-U1: the CC closure proof-hosting registry. EXACT FILE on
  // purpose (no directory glob): the run-set of this group must equal the
  // manifest's blocking rows pinned to it (tools/cc-proof-hosting-registry.mjs
  // proves the bijection), so the hosted CC proof-registry surface cannot
  // silently widen or shrink.
  'cc-proof-registry': {
    globs: ['tests/infrastructure/cc-proof-hosting.test.mjs'],
    note: 'CC-U1/ADR-092 proof-hosting registry — bidirectional closure between the CC critical proof manifest and the CI-invoked blocking matrix groups',
  },
  'factory-proof': {
    globs: [
      'tests/factory-proof/canonical-composition.test.mjs',
      'tests/factory-proof/import-ratchet.test.mjs',
      'tests/factory-proof/obligation-compiler.test.mjs',
      'tests/factory-proof/scenario-actor-observer.test.mjs',
      'tests/factory-proof/kernel-self-mutations.test.mjs',
      'tests/factory-proof/w1-1-fabricated-hash.test.mjs',
      'tests/factory-proof/w1-4-two-lifecycles.test.mjs',
      'tests/factory-proof/k2-spawned-actor.test.mjs',
      'tests/factory-proof/k2-strict-formalization.test.mjs',
      'tests/factory-proof/proof-claims.test.mjs',
      'tests/factory-proof/k0-baseline.test.mjs',
      // CC-10A provisional 23-file floor: the Conformance Engine v1 measuring
      // surface. All Contract-level closure checks (packs validated as data,
      // evidence/universe algebra, registry honesty) — the drives with the
      // multi-phase 61s proofs stay in the manual harvest path, NOT here.
      'tests/factory-proof/conformance-engine.test.mjs',
      'tests/factory-proof/coverage-kernel.test.mjs',
      'tests/factory-proof/delivery-kernel-unification.test.mjs',
      'tests/factory-proof/development-scenario-pack.test.mjs',
      'tests/factory-proof/discovery-resilience-pack.test.mjs',
      'tests/factory-proof/discovery-scenario-pack.test.mjs',
      'tests/factory-proof/factory-coverage-universe.test.mjs',
      'tests/factory-proof/formalization-resilience-pack.test.mjs',
      'tests/factory-proof/scenario-evidence.test.mjs',
      'tests/factory-proof/scenario-runner.test.mjs',
      'tests/factory-proof/workshop-descriptor.test.mjs',
      'tests/factory-proof/workshop-inventory.test.mjs',
    ],
    note: 'W0 proof kernel + W1-1 reference causal vertical (ADR-084) + W1-4 two-lifecycle composition (ADR-078) + the Conformance Engine v1 measuring surface (CC-10A provisional ratchet; final K5 lands at CC-10B) — canonical composition, obligation contracts, mutation algebra/kill matrix, scenario DSL/actor/observer, self-mutations, fabricated-derived-evidence causal proof, pack/evidence/universe closure. BLOCKING: no quarantine, no continue-on-error.',
  },
};

// --- Quarantine -------------------------------------------------------------
// Every entry is EXCLUDED from the blocking matrix. Two kinds:
//   FLAKY            — non-deterministic (orchestrate-cli replay / temporal).
//   PRE-EXISTING-RED — deterministically red on the baseline; fails identically
//                      on a clean checkout (stale ref, deleted module, C5 cutover).
// Replacement for the flaky orchestrate-cli/replay-driven suites: the fresh W9
// scripted E2E harness (cards W9-01..W9-04) is their deterministic successor.
//
// NOTE: tests/dispatcher-race/worktree-isolation.mjs is ALSO quarantined but is
// a plain .mjs script (not a *.test.mjs), so it is excluded from the
// dispatcher-race CI step directly in ci.yml, not here. See the coverage test.
const QUARANTINE = [
  { glob: 'tests/factory-contract/golden-path.test.mjs',
    kind: 'FLAKY',
    reason: 'drives orchestrate-cli; REPLAY_CAPSULE_CONTEXT_INVALID (passes ~1/3). W9 scripted E2E replaces it.' },
  { glob: 'tests/factory-contract/parallel-git-desk.test.mjs',
    kind: 'FLAKY',
    reason: 'drives orchestrate-cli (concurrency=2 worktree isolation); REPLAY_CAPSULE_CONTEXT_INVALID. W9 scripted E2E replaces it.' },
  { glob: 'tests/factory-temporal/*.test.mjs',
    kind: 'FLAKY',
    reason: 'whole suite churns run-to-run (temporal / orchestrate-cli driven). W9 scripted E2E replaces it.' },
  { glob: 'tests/process-modules/development-task-graph-diagnostics.test.mjs',
    kind: 'PRE-EXISTING-RED',
    reason: 'stale producerExecutionRef mock; fails identically on the baseline.' },
  { glob: 'tests/architecture/submission-validator-diagnostics.test.mjs',
    kind: 'PRE-EXISTING-RED',
    reason: 'assertion mismatch (outcome expected "failed", got undefined) on a clean checkout.' },
  { glob: 'tests/infrastructure/local-runnability-check-provider.test.mjs',
    kind: 'FLAKY',
    reason: 'real command/process execution (npm/node on a fixture); cold-start timing produces outcome=undefined ~1/4 runs (e.g. LR-06 "error receipt not replayed" re-run path). LR-01..06 semantics are validated in isolation; the file is non-deterministic at the matrix level. served-process-runner.test.mjs is also real-process and kept out of the blocking matrix for the same reason. Stabilize the cold-start race (or split the deterministic replay tests out) to re-admit.' },
];

// --- glob expansion (single-level '*', no deps) -----------------------------
function expandGlob(pattern) {
  const parts = pattern.split('/');
  let current = [root];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const isLast = i === parts.length - 1;
    const re = seg.includes('*')
      ? new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      : null;
    const next = [];
    for (const dir of current) {
      let entries;
      try { entries = readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        if (re ? re.test(entry) : entry === seg) {
          const p = path.join(dir, entry);
          try {
            const st = statSync(p);
            if (isLast ? st.isFile() : st.isDirectory()) next.push(p);
          } catch { /* skip */ }
        }
      }
    }
    current = next;
  }
  return current.sort();
}

const toPosix = p => path.relative(root, p).split(path.sep).join('/');

// Quarantined absolute paths (single source of truth).
const quarantinedAbs = new Map();
for (const q of QUARANTINE) {
  for (const p of expandGlob(q.glob)) quarantinedAbs.set(p, q);
}

function groupFiles(name) {
  const def = GROUPS[name];
  const seen = new Set();
  const files = [];
  for (const g of def.globs) {
    for (const p of expandGlob(g)) {
      if (quarantinedAbs.has(p)) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      files.push(p);
    }
  }
  return files;
}

// --- --list: coverage proof (consumed by the coverage test) -----------------
function printList() {
  const groupNames = Object.keys(GROUPS);
  let totalRun = 0;
  for (const name of groupNames) {
    const files = groupFiles(name);
    totalRun += files.length;
    console.log(`[group] ${name} — ${GROUPS[name].note}`);
    for (const f of files) console.log(`  [run] ${toPosix(f)}`);
  }
  // Quarantined files that exist on disk (prove each is a real, deliberate skip).
  const qExisting = [];
  for (const [abs, q] of quarantinedAbs) {
    if (existsSync(abs)) qExisting.push({ abs, q });
  }
  for (const { abs, q } of qExisting) {
    console.log(`[quarantine] ${toPosix(abs)} :: ${q.kind} :: ${q.reason}`);
  }
  // Also list quarantine globs that matched nothing yet (e.g. factory-temporal
  // when run from a checkout that lacks them) so nothing is silently dropped.
  for (const q of QUARANTINE) {
    const matched = expandGlob(q.glob);
    if (matched.length === 0) {
      console.log(`[quarantine-empty-glob] ${q.glob} :: ${q.kind} :: ${q.reason}`);
    }
  }
  console.log(`[summary] groups=${groupNames.length} run-files=${totalRun} quarantined-files=${qExisting.length}`);
}

// --- --list-json: machine-readable matrix export (ADR-092) ------------------
// The structured group registry consumed by validation/tests. Same truth as
// --list (identical expansion, identical quarantine), stable shape:
//   { schemaVersion, groups: { <name>: { files[], concurrency, note } },
//     quarantine: [{ path, kind, reason }], quarantineEmptyGlobs: [...] }
// Globs stay INTERNAL: only the expanded run-set is exported, so a consumer
// can never mistake a declared glob for a proof that CI actually runs.
function buildMatrixExport() {
  const groups = {};
  for (const name of Object.keys(GROUPS)) {
    groups[name] = {
      files: groupFiles(name).map(toPosix),
      concurrency: GROUPS[name].concurrency ?? null,
      note: GROUPS[name].note,
    };
  }
  const quarantine = [];
  for (const [abs, q] of quarantinedAbs) {
    if (existsSync(abs)) {
      quarantine.push({ path: toPosix(abs), kind: q.kind, reason: q.reason });
    }
  }
  const quarantineEmptyGlobs = QUARANTINE
    .filter((q) => expandGlob(q.glob).length === 0)
    .map((q) => ({ glob: q.glob, kind: q.kind, reason: q.reason }));
  return {
    schemaVersion: 1,
    groups,
    quarantine,
    quarantineEmptyGlobs,
  };
}

// --- run --------------------------------------------------------------------
function runGroup(name) {
  const files = groupFiles(name);
  if (files.length === 0) {
    console.error(`[acceptance-matrix:${name}] no files matched (glob drifted?) — BLOCKING`);
    process.exit(1);
  }
  const concurrency = GROUPS[name].concurrency;
  const args = ['--test'];
  if (concurrency) args.push(`--test-concurrency=${concurrency}`);
  args.push(...files);
  console.log(`\n[acceptance-matrix:${name}] ${files.length} file(s)${concurrency ? ' (concurrency=1)' : ''}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`[acceptance-matrix:${name}] FAILED (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

const args = process.argv.slice(2);
if (args.includes('--list')) {
  printList();
  process.exit(0);
}
if (args.includes('--list-json')) {
  console.log(JSON.stringify(buildMatrixExport(), null, 2));
  process.exit(0);
}

const groupIdx = args.indexOf('--group');
const requested = groupIdx >= 0 ? args[groupIdx + 1] : null;
if (requested !== null) {
  if (!Object.hasOwn(GROUPS, requested)) {
    console.error(`Unknown group '${requested}'. Known: ${Object.keys(GROUPS).join(', ')}`);
    process.exit(2);
  }
  ensureDist();
  runGroup(requested);
  process.exit(0);
}

ensureDist();
for (const name of Object.keys(GROUPS)) runGroup(name);
console.log('\n[acceptance-matrix] all groups green');
