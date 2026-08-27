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
  // EK-8 HARD CUTOVER (WP-12, 2026-08-26): the legacy groups died with the
  // deleted trees (factory-model, readiness-fencing, factory-contract,
  // process-modules, discovery-live-v2, desk-coverage, e2e-deterministic,
  // k4-fault-edges, conveyor-app, conveyor-infra, conveyor-periphery,
  // factory-proof). Their invariant content is owned by the kernel suites
  // (workflow-kernel), the 20-project corpus, and the WP-13C guards below;
  // the implementation-mirroring suites were deleted per LEGACY-DELETION-
  // MANIFEST secE (amended: the EK-9 blocking replacements exist).
  'project-corpus': {
    globs: ['tests/project-corpus/**/*.test.mjs'],
    note: '20-project scripted corpus format + drivers + elite-kit replay',
  },
  // FRF-WP11 cutover hosting: the scenario corpus over the NEW semantic
  // chain and the FRF removal guards are BLOCKING groups (the plan's
  // FRF-10 exit: "Host every test and driver in blocking CI with removal
  // guards").
  'frf-corpus': {
    globs: ['tests/frf-corpus/*.test.mjs'],
    note: 'FRF-WP10/WP11: the Formalization scenario corpus over the NEW semantic chain (11 scenarios, smoke/full/tamper modes) - the installed cells are the desk authority since the WP11 cutover',
  },
  'frf-removal-guard': {
    globs: ['tests/infrastructure/frf-removal-guard.test.mjs'],
    note: 'FRF-WP11 removal guards: the deletion manifest validated (every listed old-flow artifact absent), the old desk validators gone (no dual path), the docs contract snapshots byte-equal to the canonical in-package tree, the dist mirrors byte-equal to src',
  },
  'workflow-kernel': {
    globs: ['tests/workflow-kernel/**/*.test.mjs'],
    note: 'EK event-projected kernel: model, persistence, roles, engine, application, context envelope, development vertical, projection, workshops, the EK-8 production composition',
  },
  architecture: {
    globs: ['tests/architecture/*.test.mjs'],
    note: 'ADR-053 cutover gates, dependency-direction ratchet, conveyor boundaries (re-pinned to the post-cutover tree by WP-12)',
  },
  'kept-tooling': {
    globs: [
      // secD KEEP tooling tests (blocking ratchet/gate tools that survived
      // the purge) + the agent-proxy transport guard tests (secE KEEP carve).
      'tools/adr-closure-registry.test.mjs',
      'tools/build-receipt.test.mjs',
      'tests/agent-proxy/*.test.mjs',
    ],
    note: 'ADR registry, build receipt, and the opencode-shim transport guard tests (the KEEP classes of the EK-8 purge)',
  },
  'ek-manifest-guard': {
    globs: ['tests/infrastructure/deletion-manifest-guard.test.mjs'],
    note: 'EK-1/WP-04b deletion-manifest stop-gate in its POST-CUTOVER shape (V1 inverted for DELETE: survivors are red; killed mutations updated by WP-12)',
  },
  'ek-admission': {
    globs: ['tests/infrastructure/ek-admission-validator.test.mjs'],
    note: 'EK-1 admission-spec validator wrapper - validate:ek-admission-specs blocking in the matrix',
  },
  'ek-removal-guard': {
    globs: ['tests/infrastructure/ek-removal-guard.test.mjs'],
    note: 'WP-13C removal guards in their POST-CUTOVER shape (RG1 secH absent / secI present, RG2 tables uncreatable, RG3 sets absent, RG4 legacy-zero --strict wiring flipped by WP-12)',
  },
  'ek-mutation-coverage': {
    globs: ['tests/infrastructure/ek-mutation-coverage.test.mjs'],
    note: 'WP-13C mutation coverage - the declared kernel mutation demonstrations are real kills (model/application/development suites)',
  },
  'ek-evidence-kit': {
    globs: ['tests/infrastructure/ek-evidence-kit-determinism.test.mjs'],
    note: 'WP-13C elite-evidence-kit determinism - two extractions byte-identical on the committed fixture + read-only source contract',
  },
  'matrix-coverage': {
    globs: ['tests/infrastructure/acceptance-matrix-coverage.test.mjs'],
    note: 'CI-02 self-check - matrix completeness + no-hidden-failure guard (re-pinned to the post-cutover matrix by WP-12)',
  },
  'cc-proof-registry': {
    globs: ['tests/infrastructure/cc-proof-hosting.test.mjs'],
    note: 'CC-U1/ADR-092 proof-hosting registry - post-cutover manifest (the old-runtime proof rows died with their suites; the registry row itself stays)',
  },
};

// --- Quarantine -------------------------------------------------------------
// EK-8 cutover (2026-08-26): every pre-cutover quarantine entry whose file
// was deleted by the purge left the table (a quarantine row for an absent
// file is a phantom skip). The one surviving entry is the architecture
// suite's pre-existing-red diagnostics file, which stays in the KEEP tree.
// EK-9 closure repair (2026-08-26, audit round 3): the LAST quarantine entry
// (submission-validator-diagnostics, PRE-EXISTING-RED) is REMOVED with its
// file — its subject module was deleted at the EK-8 purge and the file was
// retained only pending EK-10 disposition (passed). The diagnostic law it
// guarded has BLOCKING SUCCESSORS in the kernel: the capsule-ingress typed
// refusal battery + the check-diagnostic decode proofs in the
// workflow-kernel suites (development/capsule-ingress.test.mjs et al).
// The matrix now has ZERO quarantine entries (the EK-9 law).
const QUARANTINE = [];

// --- glob expansion (single-level '*', recursive '**', no deps) --------------
// WP-13C fix (2026-08-26): a '**' segment now matches ZERO OR MORE directory
// levels (the conventional meaning). Before, '**' behaved like '*' (one
// level), so the workflow-kernel group glob — whose declared intent is "NO
// kernel test file can ever be an orphan (G2p)" — silently missed deeper
// files (the WP-08 simple-server fixture's own unit.test.mjs was a G2p
// orphan that failed matrix-coverage at the base commit). Only the
// workflow-kernel group uses '**' today.
function expandGlob(pattern) {
  const parts = pattern.split('/');
  function expand(dirs, i) {
    if (i === parts.length) return dirs;
    const seg = parts[i];
    const isLast = i === parts.length - 1;
    if (seg === '**') {
      // zero or more directory levels: pass the current dirs through AND add
      // every descendant directory.
      const all = [...dirs];
      const stack = [...dirs];
      while (stack.length) {
        const d = stack.pop();
        let entries;
        try { entries = readdirSync(d); } catch { continue; }
        for (const entry of entries) {
          const p = path.join(d, entry);
          try {
            if (statSync(p).isDirectory()) { all.push(p); stack.push(p); }
          } catch { /* skip */ }
        }
      }
      return expand(all, i + 1);
    }
    const re = seg.includes('*')
      ? new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      : null;
    const next = [];
    for (const dir of dirs) {
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
    return expand(next, i + 1);
  }
  return expand([root], 0).sort();
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
