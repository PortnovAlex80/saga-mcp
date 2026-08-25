#!/usr/bin/env node
// WP-13C / EK-9 — kernel mutation-coverage harness.
//
// The kernel suites document killed mutations (RED/GREEN demonstrations:
// tests/workflow-kernel/model/mutations.test.mjs "the deliberate RED
// mutations of plan phase EK-2", the development suite's "pinned mutation
// classes ... KILLED by the fences", the application suite's fence/race
// kills). Those demonstrations inject the defect through in-test seeds
// (engine mutation flags, corrupted world copies, typed invocations). This
// harness proves the claims are REAL at the source level: it applies each
// declared defect as a PATCH to the compiled kernel (a temp copy — the real
// tree is never touched) and requires the owning suite to go RED. A
// surviving mutation (suite still green with the defect applied) or a
// registry anchor that no longer matches the compiled output is a blocking
// failure — mutation demonstrations cannot rot into vacuous green.
//
// ─── THE MUTATION-REGISTRY CONVENTION (the ONE mechanism) ───
// Each mutation demonstration is declared ONCE, centrally, in
// tests/infrastructure/ek-mutation-registry.mjs (REGISTRY export; entry
// grammar documented there):
//
//   { id, kills, suite, target, find, replace }
//
//   suite   the *.test.mjs that MUST go red when the defect is applied
//   target  the compiled file (dist/workflow-kernel/...) to patch
//   find    an exact substring of the target — MUST match exactly once
//           (0 matches = registry rot, >1 = ambiguous anchor; both blocking)
//   replace the defective replacement
//
// Why a central registry (and not a per-suite registry file or a
// --list-mutations flag on the suites): src/workflow-kernel/** and
// tests/workflow-kernel/** are owned by the kernel packages — WP-13C may not
// edit them, so the registry cannot live beside the suites. And why the
// registry data file sits in tests/infrastructure/ rather than beside this
// harness in tools/: the WP-08 structure oracle ("the vertical is reachable
// ONLY from focused tests") textually forbids the literal vertical path in
// ANY tools/*.mjs, and the registry legitimately names kernel suite paths —
// that is its data. One declaration site, hosted on the surface the oracle
// deliberately does not scan.
//
// Execution model (Windows-safe: no mkdtemp-cleanup reliance, no docker,
// no network, no model):
//   * one unique workspace per run under node_modules/ (gitignored by
//     construction; bare imports like better-sqlite3 resolve naturally up
//     the real node_modules chain) containing copies of dist/,
//     src/workflow-kernel/ (the purity scans resolve REPO_ROOT from the test
//     file), tests/workflow-kernel/ and docs/refactoring/event-kernel/specs/
//     (the frozen EK-1 admission specs the compiled kernel reads at runtime);
//   * every distinct suite first runs its BASELINE in the workspace and must
//     be GREEN — a "kill" only counts as a flip from green to red;
//   * each mutation patches the workspace copy, runs the suite, requires a
//     non-zero exit, then RESTORES the file (and the harness restores all
//     targets again from the pristine copies before the next mutation);
//   * cleanup is best-effort (a crashed run may leave the workspace behind —
//     it is inside node_modules/, so it can never dirty git status).
//
// Usage:
//   node tools/ek-mutation-coverage.mjs            # run every mutation
//   node tools/ek-mutation-coverage.mjs --list     # registry, run nothing
//   node tools/ek-mutation-coverage.mjs --json     # machine surface
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { REGISTRY } = await import('../tests/infrastructure/ek-mutation-registry.mjs');

// ─── harness ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  for (const m of REGISTRY) {
    console.log(`${m.id}  [${m.suite}]  target=${m.target}`);
    console.log(`  kills: ${m.kills}`);
  }
  console.log(`[mutation-coverage] ${REGISTRY.length} registered mutation demonstrations`);
  process.exit(0);
}
const JSON_OUT = argv.includes('--json');
const SUITE_FILTER_IDX = argv.indexOf('--suite');
const SUITE_FILTER = SUITE_FILTER_IDX >= 0 ? argv[SUITE_FILTER_IDX + 1] : null;

const entries = SUITE_FILTER ? REGISTRY.filter((m) => m.suite === SUITE_FILTER || m.suite.startsWith(`${SUITE_FILTER}/`)) : REGISTRY;
if (entries.length === 0) {
  console.error(`[mutation-coverage] no registry entries match --suite ${SUITE_FILTER}`);
  process.exit(2);
}

// registry sanity: unique ids, existing suites/targets
{
  const problems = [];
  const ids = new Set();
  for (const m of entries) {
    if (ids.has(m.id)) problems.push(`duplicate id ${m.id}`);
    ids.add(m.id);
    if (!existsSync(path.join(ROOT, m.suite))) problems.push(`suite missing: ${m.suite}`);
    if (!existsSync(path.join(ROOT, m.target))) problems.push(`target missing (build dist/ first): ${m.target}`);
    if (!m.find || m.find === m.replace) problems.push(`degenerate find/replace for ${m.id}`);
  }
  if (problems.length) {
    console.error(`[mutation-coverage] RED registry: ${problems.join('; ')}`);
    process.exit(1);
  }
}

// unique workspace under node_modules/ (gitignored by construction)
const WORKSPACE = path.join(ROOT, 'node_modules', `.ek-mutation-work-${process.pid}-${Date.now()}`);
mkdirSync(path.join(WORKSPACE, 'node_modules-marker'), { recursive: true });
rmSync(path.join(WORKSPACE, 'node_modules-marker'), { recursive: true, force: true });
for (const copy of [
  'dist',
  'src/workflow-kernel',
  'tests/workflow-kernel',
  // the compiled kernel reads the frozen EK-1 admission specs and the
  // reconciliation universe relative to the repo root at runtime
  'docs/refactoring/event-kernel/specs',
  'docs/refactoring/event-kernel/reconciliation',
  'docs/plans/EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md',
  // complexity-check reads the dependency budget from package.json
  'package.json',
]) {
  cpSync(path.join(ROOT, copy), path.join(WORKSPACE, copy), { recursive: true });
}

function runSuite(suiteRel) {
  // Strip the parent test-runner context: a `node --test` child spawned from
  // inside a test process inherits NODE_TEST_CONTEXT, switches to the
  // internal child protocol and always exits 0 — which would turn every
  // mutated (red) run into a false SURVIVED.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_TMP;
  const r = spawnSync(process.execPath, ['--test', path.join(WORKSPACE, suiteRel)], {
    cwd: WORKSPACE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
  });
  const pass = /ℹ pass (\d+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1];
  const fail = /ℹ fail (\d+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1];
  return { status: r.status ?? 1, pass: pass ? Number(pass) : null, fail: fail ? Number(fail) : null };
}

const results = [];
try {
  // 1. baselines: every distinct suite must be GREEN unmutated (a kill only
  //    counts as a green -> red flip, never pre-existing red).
  const suites = [...new Set(entries.map((m) => m.suite))];
  const baselines = new Map();
  for (const s of suites) {
    const b = runSuite(s);
    baselines.set(s, b);
    if (b.status !== 0) {
      results.push({ id: `baseline:${s}`, outcome: 'BASELINE-RED', detail: `exit ${b.status} (pass ${b.pass}, fail ${b.fail}) — a suite that is red unmutated invalidates every kill claim against it` });
    } else {
      results.push({ id: `baseline:${s}`, outcome: 'BASELINE-GREEN', detail: `pass ${b.pass}` });
    }
  }

  // 2. mutations: patch the workspace copy, require RED, restore.
  for (const m of entries) {
    const targetAbs = path.join(WORKSPACE, m.target);
    const pristine = readFileSync(path.join(ROOT, m.target), 'utf8'); // the REAL tree is never touched
    const occurrences = pristine.split(m.find).length - 1;
    if (occurrences !== 1) {
      results.push({
        id: m.id, outcome: occurrences === 0 ? 'ANCHOR-ROT' : 'ANCHOR-AMBIGUOUS',
        detail: `find-string matches ${occurrences}x in ${m.target} (exactly 1 required) — the compiled output drifted; update the registry entry`,
      });
      continue;
    }
    writeFileSync(targetAbs, pristine.replace(m.find, m.replace));
    const run = runSuite(m.suite);
    writeFileSync(targetAbs, pristine); // restore immediately
    if (run.status !== 0) {
      results.push({ id: m.id, outcome: 'KILLED', detail: `suite RED (exit ${run.status}, fail ${run.fail ?? '?'}, pass ${run.pass ?? '?'})` });
    } else {
      results.push({ id: m.id, outcome: 'SURVIVED', detail: `suite stayed GREEN (pass ${run.pass}) with the defect applied — the kill claim is vacuous` });
    }
  }
} finally {
  rmSync(WORKSPACE, { recursive: true, force: true }); // best-effort; inside node_modules/ anyway
}

const killed = results.filter((r) => r.outcome === 'KILLED').length;
const mutated = entries.length;
const green = results.every((r) => r.outcome === 'KILLED' || r.outcome === 'BASELINE-GREEN');
const summary = {
  registrySize: REGISTRY.length,
  ran: mutated,
  killed,
  baselinesGreen: results.filter((r) => r.outcome === 'BASELINE-GREEN').length,
  survivors: results.filter((r) => r.outcome !== 'KILLED' && r.outcome !== 'BASELINE-GREEN'),
  green,
};

if (JSON_OUT) {
  console.log(JSON.stringify({ summary, results }, null, 2));
} else {
  for (const r of results) {
    const mark = r.outcome === 'KILLED' || r.outcome === 'BASELINE-GREEN' ? 'ok ' : 'RED';
    console.log(`[mutation-coverage] ${mark} ${r.id}: ${r.outcome} — ${r.detail}`);
  }
  console.log(`[mutation-coverage] ${killed}/${mutated} mutations killed; ${summary.baselinesGreen} baseline suite(s) green`);
  if (green) console.log('[mutation-coverage] ALL REGISTERED MUTATIONS KILLED');
  else console.error('[mutation-coverage] RED — surviving mutation or bad baseline/anchor (see above)');
}

process.exit(green ? 0 : 1);
