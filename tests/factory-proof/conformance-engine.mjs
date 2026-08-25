#!/usr/bin/env node
// tests/factory-proof/conformance-engine.mjs
//
// Factory Conformance Engine v1 — the DEMONSTRATED coverage layer and the
// one honest global report.
//
//   Declared universe U   (factory-coverage-universe.mjs) — the constant,
//                          monotonic catalog of obligations.
//   Demonstrated set C    (this module) — obligations with PASS
//                          ScenarioEvidenceBundles from REAL drives through
//                          the ONE kernel (runScenario).
//   Coverage              = C / U, per workshop and per dimension.
//
//   A scenario that exists only in code proves NOTHING: bundles with verdict
//   !== 'pass' are excluded from C. Declared-but-not-demonstrated tokens are
//   reported as uncovered — that gap is the difference between the declared
//   layer and reality, and it is the point of this instrument.
//
// Modes:
//   --harvest   run every scenario of all four workshops (child processes,
//               isolated like production), write bundles to
//               tests/factory-evidence/<workshop>/<scenario>.json, then
//               report from the fresh evidence.
//   (default)   report from the committed evidence snapshot — reproducible
//               without re-running drives.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync }
  from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFactoryCoverageUniverse } from './factory-coverage-universe.mjs';
import { validateScenarioEvidenceBundle } from './scenario-evidence.mjs';
import { DELIVERY_BLOCKED_OBLIGATIONS } from './delivery-scenario-pack.mjs';
import { DEVELOPMENT_PENDING_UNIVERSE } from './development-scenario-pack.mjs';
import { DISCOVERY_CLOSURE_SCENARIOS } from './discovery-resilience-pack.mjs';
import { FORMALIZATION_CLOSURE_SCENARIOS } from './formalization-resilience-pack.mjs';
import { DEVELOPMENT_SCENARIOS } from './development-scenario-pack.mjs';
import { DELIVERY_SCENARIOS } from './delivery-scenario-pack.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const EVIDENCE_ROOT = path.join(HERE, '..', 'factory-evidence');
const HARVEST = process.argv.includes('--harvest');
// W2 (2026-08-25): the Development universe now hosts production-sized
// drives (the 59-card satisfiability scenarios run ~5 min each; the
// three-start restart proof ~7 min) — the per-drive ceiling must admit
// them or the harvest kills them at 300s.
const DRIVE_TIMEOUT_MS = Number(process.env.CONFORMANCE_DRIVE_TIMEOUT_MS ?? 900_000);

const WORKSHOPS = [
  {
    id: 'discovery',
    scenarios: DISCOVERY_CLOSURE_SCENARIOS,
    drive: 'discovery-scenario-drive.mjs',
    env: 'DISCOVERY_SCENARIO',
  },
  {
    id: 'formalization',
    scenarios: FORMALIZATION_CLOSURE_SCENARIOS,
    drive: 'formalization-scenario-drive.mjs',
    env: 'FORMALIZATION_SCENARIO',
  },
  {
    id: 'development',
    scenarios: DEVELOPMENT_SCENARIOS,
    drive: 'development-scenario-drive.mjs',
    env: 'DEVELOPMENT_SCENARIO',
  },
  {
    id: 'delivery',
    scenarios: DELIVERY_SCENARIOS,
    drive: 'delivery-scenario-drive.mjs',
    env: 'DELIVERY_SCENARIO',
  },
];

function parseBundle(stdout) {
  const lines = String(stdout ?? '').trim().split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed?.bundleDigest && parsed?.scenario?.id) return parsed;
    } catch {
      // diagnostic line — keep scanning backwards
    }
  }
  return null;
}

const fileSafe = id => id.replace(/[^a-zA-Z0-9._-]/g, '_');

function harvest() {
  const manifest = [];
  for (const workshop of WORKSHOPS) {
    const dir = path.join(EVIDENCE_ROOT, workshop.id);
    mkdirSync(dir, { recursive: true });
    for (const scenario of workshop.scenarios) {
      const child = spawnSync(
        process.execPath,
        [path.join(HERE, workshop.drive)],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, [workshop.env]: scenario.id },
          encoding: 'utf8',
          windowsHide: true,
          timeout: DRIVE_TIMEOUT_MS,
          // W2: production-scale drives print evidence bundles whose
          // rawDurableTrace alone is multiple MB (59 workplaces + their
          // executions/submissions/receipts). spawnSync's default 1MB
          // maxBuffer TERMINATES the child (SIGTERM, no-evidence) — the
          // bundle must fit or the harvest lies about the drive.
          maxBuffer: 256 * 1024 * 1024,
        },
      );
      const bundle = parseBundle(child.stdout);
      const entry = {
        workshop: workshop.id,
        scenario: scenario.id,
        exitStatus: child.status,
        signal: child.signal ?? null,
        verdict: bundle?.verdict ?? 'no-evidence',
        bundleDigest: bundle?.bundleDigest ?? null,
      };
      if (bundle) {
        writeFileSync(
          path.join(dir, `${fileSafe(scenario.id)}.json`),
          JSON.stringify(bundle, null, 2) + '\n',
        );
      }
      if (child.status !== 0 || entry.verdict !== 'pass') {
        entry.stderrTail = String(child.stderr ?? '').trim().slice(-1200);
      }
      manifest.push(entry);
      process.stderr.write(
        `[harvest] ${entry.workshop}/${entry.scenario} -> ${entry.verdict}\n`,
      );
    }
  }
  writeFileSync(
    path.join(EVIDENCE_ROOT, 'harvest-manifest.json'),
    JSON.stringify({ harvestedAt: new Date().toISOString(), runs: manifest }, null, 2) + '\n',
  );
  return manifest;
}

function loadCommittedEvidence() {
  const bundles = [];
  const runs = [];
  for (const workshop of WORKSHOPS) {
    const dir = path.join(EVIDENCE_ROOT, workshop.id);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) {
      try {
        const bundle = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
        const errors = validateScenarioEvidenceBundle(bundle);
        runs.push({
          workshop: workshop.id,
          scenario: bundle.scenario?.id ?? name,
          verdict: errors.length > 0 ? 'invalid-bundle' : bundle.verdict,
          bundleDigest: bundle.bundleDigest ?? null,
          evidenceFile: `${workshop.id}/${name}`,
        });
        if (errors.length === 0) bundles.push(bundle);
      } catch {
        runs.push({
          workshop: workshop.id,
          scenario: name,
          verdict: 'unparseable',
          bundleDigest: null,
          evidenceFile: `${workshop.id}/${name}`,
        });
      }
    }
  }
  return { bundles, runs };
}

const percent = (covered, total) => (total === 0 ? null
  : Math.round((covered / total) * 1000) / 10);

// ── The report ────────────────────────────────────────────────────────────

const universe = buildFactoryCoverageUniverse();

// Blocked obligations (data from the packs).
const blocked = { ...DELIVERY_BLOCKED_OBLIGATIONS };

const manifestRuns = HARVEST
  ? harvest().map(r => ({ ...r, source: 'harvest' }))
  : loadCommittedEvidence().runs;
const bundles = HARVEST
  ? null
  : loadCommittedEvidence().bundles;

const passRuns = manifestRuns.filter(r => r.verdict === 'pass');
const passBundles = HARVEST
  ? passRuns.map(run => {
    const p = path.join(EVIDENCE_ROOT, run.workshop, `${fileSafe(run.scenario)}.json`);
    return JSON.parse(readFileSync(p, 'utf8'));
  })
  : bundles.filter(b => b.verdict === 'pass');

// Demonstrated C: coverage items of PASS bundles only. A bundle's `proves`
// list carries UNPREFIXED obligation ids — normalize them to the universe's
// 'obligation:' token form so obligations demonstrated by reference
// workshops count.
const demonstratedByWorkshop = new Map();
for (const bundle of passBundles) {
  const workshop = WORKSHOPS.find(w => bundle.scenario.id.startsWith(`${w.id}/`))?.id;
  if (!workshop) continue;
  const set = demonstratedByWorkshop.get(workshop) ?? new Set();
  for (const item of bundle.scenario.coverageItems ?? []) set.add(item);
  for (const proved of bundle.scenario.proves ?? []) {
    set.add(`obligation:${proved}`);
  }
  demonstratedByWorkshop.set(workshop, set);
}

const tokenOwners = new Map();
for (const w of universe.perWorkshop) {
  for (const token of [
    ...w.requiredUniverseItems ?? [],
    ...w.pendingItems,
    ...w.platformFaultEdges,
  ]) {
    const owners = tokenOwners.get(token) ?? new Set();
    owners.add(w.workshop);
    tokenOwners.set(token, owners);
  }
}

function dimension(matcher, universeTokens, coveredByWorkshop) {
  const tokens = universeTokens.filter(matcher);
  const covered = tokens.filter(token =>
    [...coveredByWorkshop.entries()].some(([, items]) => items.has(token)));
  return {
    covered: covered.length,
    total: tokens.length,
    percent: percent(covered.length, tokens.length),
    uncovered: tokens.filter(token => !covered.includes(token)),
  };
}

const allUniverseTokens = [...tokenOwners.keys()].sort();

const perWorkshop = universe.perWorkshop.map(w => {
  const demonstrated = demonstratedByWorkshop.get(w.workshop) ?? new Set();
  const universeTokens = [
    ...w.requiredUniverseItems ?? [], ...w.pendingItems,
  ];
  const covered = universeTokens.filter(t => demonstrated.has(t));
  return {
    workshop: w.workshop,
    declaredStatus: w.status,
    universe: universeTokens.length,
    demonstratedCovered: covered.length,
    percent: percent(covered.length, universeTokens.length),
    uncovered: universeTokens.filter(t => !demonstrated.has(t)),
    blocked: universeTokens
      .filter(t => blocked[t] !== undefined)
      .map(t => ({ token: t, ...blocked[t] })),
    pendingNotBlocked: w.pendingItems
      .filter(t => blocked[t] === undefined),
  };
});

const crossCutting = tokens => tokens.filter(t =>
  tokenOwners.get(t)?.size > 1);
const kernelTokens = allUniverseTokens.filter(t => t.startsWith('kernel:')
  || t.startsWith('obligation:'));

const anyWorkshopCovered = new Set();
for (const items of demonstratedByWorkshop.values()) {
  for (const item of items) anyWorkshopCovered.add(item);
}

const mutationBundles = passBundles.filter(b => b.mutationCoverage !== null);
const report = {
  schemaVersion: 'factory.proof.conformance-coverage.v1',
  generatedAt: new Date().toISOString(),
  mode: HARVEST ? 'harvest' : 'committed-snapshot',
  declared: {
    universeTokens: allUniverseTokens.length,
    pendingTotal: universe.totals.pendingTotal,
    interWorkshopTokens: universe.interWorkshopTokens.length,
    platformFaultEdges: universe.totals.platformFaultEdges,
  },
  demonstrated: {
    passBundles: passBundles.length,
    nonPassRuns: manifestRuns.filter(r => r.verdict !== 'pass').length,
    byWorkshop: perWorkshop,
    dimensions: {
      // ACTUAL lifecycle handoffs (operator completion order): the
      // inter-workshop aggregate is the handoff:* obligations — the seams
      // one workshop's terminal outcome hands to the next workshop — not
      // merely tokens that happen to be multi-owned.
      interWorkshop: (() => {
        const tokens = allUniverseTokens.filter(t => t.startsWith('handoff:'));
        const covered = tokens.filter(t => anyWorkshopCovered.has(t));
        return {
          covered: covered.length,
          total: tokens.length,
          percent: percent(covered.length, tokens.length),
        };
      })(),
      transitions: dimension(
        t => t.startsWith('transition:'),
        allUniverseTokens,
        demonstratedByWorkshop,
      ),
      negativeTransitions: dimension(
        t => t.startsWith('negative-transition:'),
        allUniverseTokens,
        demonstratedByWorkshop,
      ),
      recovery: dimension(
        t => t.startsWith('restart:') || t.startsWith('recovery:'),
        allUniverseTokens,
        demonstratedByWorkshop,
      ),
      genericInvariants: dimension(
        t => t.startsWith('kernel:') || t.startsWith('obligation:'),
        kernelTokens.length > 0 ? kernelTokens : allUniverseTokens.filter(() => false),
        demonstratedByWorkshop,
      ),
      mutationKillRate: mutationBundles.length === 0
        ? {
          measured: false,
          note: 'mutation kills are K4-owned (fault scheduler not landed); '
            + 'measuring them is the Conformance Closure iteration, not v1',
        }
        : {
          measured: true,
          bundlesWithMutationData: mutationBundles.length,
        },
    },
  },
  platform: {
    k4Edges: universe.perWorkshop.flatMap(w =>
      w.platformFaultEdges.map(edge => ({ workshop: w.workshop, edge }))),
  },
  runs: manifestRuns,
  // HONEST DISCLOSURE (operator completion order): multi-phase proofs
  // (restart idempotency, retry exhaustion) run through their dedicated
  // multi-phase proof runners — they drive the REAL Factory and emit valid
  // ScenarioEvidenceBundles, but not through the single-run runScenario
  // path. Unifying them into one multi-phase kernel is a Conformance
  // Closure item; the report must not silently claim 'every scenario →
  // runScenario'.
  specialMultiPhaseProofs: [
    ...manifestRuns
      .filter(run => /restart-idempotency|retry-exhaustion/.test(run.scenario))
      .map(run => ({
        scenario: run.scenario,
        runner: 'multi-phase proof runner (runDiscoveryRestartProof/'
          + 'runFormalizationRestartProof family)',
        bundle: run.verdict,
      })),
  ],
};

// ── Rendering ─────────────────────────────────────────────────────────────

function renderReport(r) {
  const lines = [];
  lines.push('# Factory Conformance Coverage v1');
  lines.push('');
  lines.push(`mode: ${r.mode}; generated ${r.generatedAt}`);
  lines.push(`declared universe U: ${r.declared.universeTokens} tokens `
    + `(pending ${r.declared.pendingTotal}, K4 edges ${r.declared.platformFaultEdges})`);
  lines.push(`demonstrated: ${r.demonstrated.passBundles} PASS bundles, `
    + `${r.demonstrated.nonPassRuns} non-pass runs`);
  lines.push('');
  lines.push('| Workshop | Declared | Demonstrated | Coverage | Uncovered | Blocked |');
  lines.push('|---|---|---|---|---|---|');
  for (const w of r.demonstrated.byWorkshop) {
    lines.push(`| ${w.workshop} | ${w.declaredStatus} | ${w.demonstratedCovered}/${w.universe} | ${w.percent ?? 'n/a'}% | ${w.uncovered.length} | ${w.blocked.length} |`);
  }
  lines.push('');
  const dim = r.demonstrated.dimensions;
  lines.push(`Inter-workshop         ${dim.interWorkshop.percent ?? 'n/a'}%  (${dim.interWorkshop.covered}/${dim.interWorkshop.total})`);
  lines.push(`Transitions            ${dim.transitions.percent ?? 'n/a'}%  (${dim.transitions.covered}/${dim.transitions.total})`);
  lines.push(`Negative transitions   ${dim.negativeTransitions.percent ?? 'n/a'}%  (${dim.negativeTransitions.covered}/${dim.negativeTransitions.total})`);
  lines.push(`Recovery               ${dim.recovery.percent ?? 'n/a'}%  (${dim.recovery.covered}/${dim.recovery.total})`);
  lines.push(`Generic invariants     ${dim.genericInvariants.percent ?? 'n/a'}%  (${dim.genericInvariants.covered}/${dim.genericInvariants.total})`);
  lines.push(dim.mutationKillRate.measured
    ? `Mutation kill rate     ${dim.mutationKillRate.percent ?? 'see bundles'}`
    : `Mutation kill rate     not measured — ${dim.mutationKillRate.note}`);
  lines.push('');
  const uncoveredAll = r.demonstrated.byWorkshop
    .flatMap(w => w.uncovered.map(t => `  ${w.workshop}: ${t}`));
  lines.push('Uncovered:');
  lines.push(...(uncoveredAll.length > 0 ? uncoveredAll : ['  (none)']));
  lines.push('');
  const blockedAll = r.demonstrated.byWorkshop
    .flatMap(w => w.blocked.map(b => `  ${w.workshop}: ${b.token} — BLOCKED_BY ${b.blockedBy} (${b.note})`));
  lines.push('Blocked:');
  lines.push(...(blockedAll.length > 0 ? blockedAll : ['  (none)']));
  lines.push('');
  lines.push('K4 platform edges:');
  if (r.platform.k4Edges.length === 0) lines.push('  (none)');
  for (const e of r.platform.k4Edges) lines.push(`  ${e.workshop}: ${e.edge}`);
  return lines.join('\n');
}

writeFileSync(
  path.join(EVIDENCE_ROOT, 'conformance-report.json'),
  JSON.stringify(report, null, 2) + '\n',
);
process.stdout.write(JSON.stringify(report) + '\n');
process.stderr.write('\n' + renderReport(report) + '\n');

const failed = manifestRuns.filter(r => r.verdict !== 'pass');
process.exitCode = HARVEST && failed.length > 0 ? 1 : 0;
