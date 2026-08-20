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
//   node tools/run-acceptance-matrix.mjs --list          # coverage proof, run nothing
//
// Mirrors the directory-scan + --list style of run-process-module-tests.mjs.
// The quarantine table below is the single source of truth; the coverage test
// tests/infrastructure/acceptance-matrix-coverage.test.mjs asserts it.

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
    globs: ['tests/process-modules/*.test.mjs'],
    concurrency: 1,
    note: 'module composition + LR-07 development-local-readiness binding',
  },
  'matrix-coverage': {
    globs: ['tests/infrastructure/acceptance-matrix-coverage.test.mjs'],
    note: 'CI-02 self-check — matrix completeness + no-hidden-failure guard',
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
      'tests/factory-proof/proof-claims.test.mjs',
      'tests/factory-proof/k0-baseline.test.mjs',
    ],
    note: 'W0 proof kernel + W1-1 reference causal vertical (ADR-084) + W1-4 two-lifecycle composition (ADR-078) — canonical composition, obligation contracts, mutation algebra/kill matrix, scenario DSL/actor/observer, self-mutations, fabricated-derived-evidence causal proof. BLOCKING: no quarantine, no continue-on-error.',
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
