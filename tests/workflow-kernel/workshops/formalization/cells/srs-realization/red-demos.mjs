#!/usr/bin/env node
/**
 * red-demos.mjs - FRF-WP08 RED demonstration runner: applies ONE deliberate
 * source mutation per validator family, rebuilds, runs the pinned suite and
 * RESTORES. Never leaves a mutation behind.
 *
 * Families (>= 1 killed source mutation each):
 *   parser-closed-vocabulary-fence     family: parser
 *   realization-coverage-fence         family: realization-validator
 *   contract-missing-entrypoint-fence  family: contract-validator (Elite kill 1)
 *   contract-missing-composition-fence family: contract-validator (Elite kill 2)
 *   desk-checkplan-seam-fence          family: desk-binding
 *   seam-fail-closed-fence             family: seam (the WP03 universe seam)
 *
 * Every mutation keeps the tree TypeScript-valid under noUnusedLocals (the
 * fence expression is weakened, never deleted), so the demonstration always
 * runs against a real rebuild of the mutated source.
 *
 * Usage: node tests/workflow-kernel/workshops/formalization/cells/srs-realization/red-demos.mjs <name|all>
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..');
const SUITE_DIR = 'tests/workflow-kernel/workshops/formalization/cells/srs-realization';
const VALIDATOR = 'src/workflow-kernel/workshops/formalization/cells/srs-realization/validator.ts';

const MUTATIONS = {
  'parser-closed-vocabulary-fence': {
    file: 'src/workflow-kernel/workshops/formalization/cells/srs-realization/parser.ts',
    old: "  if (typeof value !== 'string' || !vocabulary.includes(value as T)) {",
    new: "  /* MUTATION: closed-vocabulary fence weakened (open values pass) */ if (typeof value !== 'string' && !vocabulary.includes(value as T)) {",
    suite: `${SUITE_DIR}/parser.test.mjs`,
  },
  'realization-coverage-fence': {
    file: VALIDATOR,
    old: '    if (!realizedByScenario.has(scenarioId)) {',
    new: '    /* MUTATION: frozen-scenario coverage disabled */ if (!realizedByScenario.has(scenarioId) && realizedByScenario.size < 0) {',
    suite: `${SUITE_DIR}/validator.test.mjs`,
  },
  'contract-missing-entrypoint-fence': {
    file: VALIDATOR,
    old: '      if (!declaredSurfaceIds.includes(surfaceRef)) {',
    new: '      /* MUTATION: required-surface resolution disabled (missing-entrypoint survives) */ if (!declaredSurfaceIds.includes(surfaceRef) && declaredSurfaceIds.length < 0) {',
    suite: `${SUITE_DIR}/elite-kills.test.mjs`,
  },
  'contract-missing-composition-fence': {
    file: VALIDATOR,
    old: '    if (surface.realizedScenarioRefs.length === 0) {',
    new: '    /* MUTATION: missing-composition fence disabled */ if (surface.realizedScenarioRefs.length < 0) {',
    suite: `${SUITE_DIR}/elite-kills.test.mjs`,
  },
  'desk-checkplan-seam-fence': {
    file: 'src/workflow-kernel/workshops/formalization/cells/srs-realization/desk.ts',
    old: '  return checkPlanEvidenceFor(declaration.declaration.checkProvider);',
    new: "  /* MUTATION: the desk re-derives its own CheckPlan digest (no longer the sibling gate surface) */\n  return { ...checkPlanEvidenceFor(declaration.declaration.checkProvider), payloadDigest: sha256OfCanonical({ providerId: declaration.declaration.checkProvider.providerId }) };",
    suite: `${SUITE_DIR}/desk.test.mjs`,
  },
  'seam-fail-closed-fence': {
    file: VALIDATOR,
    old: `  const universeRefusal = requireUniverse(universe);
  if (universeRefusal !== null) return universeRefusal;

  // Lineage pins: the section derives from the frozen WHAT baseline only.`,
    new: `  /* MUTATION: fail-closed universe seam disabled */ const universeRefusal = null as ProductRefusal | null;
  if (universeRefusal !== null) return universeRefusal;

  // Lineage pins: the section derives from the frozen WHAT baseline only.`,
    suite: `${SUITE_DIR}/seam.test.mjs`,
  },
};

function run(cmd) {
  try {
    return { status: 0, output: execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ''}\n${error.stderr ?? ''}` };
  }
}

/** The suite failed: spec reporter (fail N > 0 / failing-tests block) or TAP (not ok / # fail N). */
function suiteIsRed(output) {
  const failCounts = [...output.matchAll(/(?:^|\n)\s*(?:ℹ|#)\s*fail\s+(\d+)/g)].map((match) => Number(match[1]));
  const reportedFailures = failCounts.length > 0 && failCounts[failCounts.length - 1] > 0;
  const failingBlock = /(?:^|\n)\s*(?:not ok|✖)/.test(output);
  return reportedFailures || failingBlock;
}

function main() {
  const names = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(MUTATIONS);
  const failures = [];
  for (const name of names) {
    const mutation = MUTATIONS[name];
    if (mutation === undefined) {
      console.log(`UNKNOWN MUTATION ${name} (known: ${Object.keys(MUTATIONS).join(', ')})`);
      failures.push(name);
      continue;
    }
    const absolute = path.join(REPO_ROOT, mutation.file);
    const original = readFileSync(absolute, 'utf8');
    if (!original.includes(mutation.old)) {
      console.log(`PATTERN NOT FOUND for ${name} (source drifted; update the demonstration)`);
      failures.push(name);
      continue;
    }
    writeFileSync(absolute, original.replace(mutation.old, mutation.new), 'utf8');
    try {
      const build = run('npm run build');
      if (build.status !== 0) {
        console.log(`=== ${name}: BUILD FAILED (mutation not TS-valid) ===`);
        failures.push(name);
        continue;
      }
      const result = run(`node --test "${mutation.suite}"`);
      const red = result.status !== 0 && suiteIsRed(result.output);
      console.log(`=== ${name}: ${red ? 'RED (killed)' : 'NOT RED (mutation survived!)'} ===`);
      if (!red) failures.push(name);
    } finally {
      writeFileSync(absolute, original, 'utf8');
    }
  }
  run('npm run build');
  const restored = run(`node --test "${SUITE_DIR}/*.test.mjs"`);
  console.log(`=== restored (must be GREEN): exit ${restored.status} ===`);
  if (failures.length > 0) {
    console.log(`SURVIVED/BROKEN MUTATIONS: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('ALL MUTATIONS KILLED');
}

main();
