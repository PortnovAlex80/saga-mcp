/**
 * CONVEYOR §23 L3 item 7 + §27: the outcome vocabulary is MECHANICALLY closed.
 *
 * A declared route with no producer is worse than no route: it creates false
 * confidence and code paths that first execute in production (the
 * W9-04-UNREACHABLE-EDGE-EVIDENCE dossier found eight of them — now deleted).
 * This ratchet replaces that prose dossier with executable checks, so a route
 * whose producer disappears fails CI in the same commit:
 *
 *   1. every lifecycle route code is a DECLARED outcome of its stage's module;
 *   2. every module-declared outcome has a terminal `complete-<code>` emitter
 *      node reachable in the module's flow;
 *   3. the worker-facing recommendation enums are subsets of the module's
 *      emittable outcomes minus the runtime-only 'failed' — a worker must not
 *      be able to recommend an outcome the factory cannot emit from a
 *      recommendation (deleted words are invalid input, never translated).
 *
 * The closed TypeScript decision unions (FormalizationDecision,
 * DevelopmentDecision, DiscoveryOutcome) are the compile-time proof; these
 * runtime mirrors keep the declarations honest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { productBuildLifecycle } from '../../dist/process-modules/lifecycles/product-build-lifecycle.js';
import { discoveryProcessModule } from '../../dist/process-modules/modules/discovery/discovery-process-module.js';
import { formalizationProcessModule } from '../../dist/process-modules/modules/formalization/formalization-process-module.js';
import { developmentProcessModule } from '../../dist/process-modules/modules/development/development-process-module.js';
import { deliveryProcessModule } from '../../dist/process-modules/modules/delivery/delivery-process-module.js';
import { DISCOVERY_OUTCOMES } from '../../dist/modules/discovery/domain/discovery-proposal.js';

const MODULE_BY_STAGE = new Map([
  ['initial-discovery', discoveryProcessModule],
  ['solution-formalization', formalizationProcessModule],
  ['solution-development', developmentProcessModule],
  // delivery-release routes exist in the parent lifecycle but the build
  // lifecycle filters that stage out; nothing to check for it here.
]);

const moduleOutcomeCodes = (module) => module.outcomes.map(o => o.code);

const moduleTerminalOutcomes = (module) => module.flow.nodes
  .filter(node => node.kind === 'kernel' && node.emitsOutcome)
  .map(node => node.emitsOutcome);

test('every lifecycle route code is a declared outcome of its stage module', () => {
  for (const stage of productBuildLifecycle.stages) {
    const module = MODULE_BY_STAGE.get(stage.id);
    if (!module) continue;
    const declared = new Set(moduleOutcomeCodes(module));
    for (const code of Object.keys(stage.outcomeRoutes ?? {})) {
      assert.ok(
        declared.has(code),
        `stage '${stage.id}' routes '${code}' but its module does not declare it — `
        + `a declared route with no producer is the false-confidence defect `
        + `this ratchet exists to catch (declared: ${[...declared].join(', ')})`,
      );
    }
  }
});

test('every declared module outcome has a terminal emitter node in its flow', () => {
  for (const [stageId, module] of MODULE_BY_STAGE) {
    const emitters = new Set(moduleTerminalOutcomes(module));
    for (const code of moduleOutcomeCodes(module)) {
      assert.ok(
        emitters.has(code),
        `${stageId} declares outcome '${code}' but its flow has no `
        + `complete-${code} emitter node — nothing can produce it`,
      );
    }
  }
});

test('the worker recommendation grammar cannot exceed the emittable outcomes', () => {
  // Discovery is the only module whose WORKER recommends an outcome code.
  // 'failed' is runtime-only (process/kernel failure): no worker may
  // recommend it; every worker-recommendable word must be emittable FROM a
  // recommendation. Deleted words are structurally absent from the enum —
  // a submission carrying one is invalid input at the gate, never rewritten.
  const emittable = new Set(moduleOutcomeCodes(discoveryProcessModule));
  for (const word of DISCOVERY_OUTCOMES) {
    assert.ok(
      emittable.has(word),
      `workers may recommend '${word}' but the discovery module cannot emit it`,
    );
    assert.notEqual(
      word, 'failed',
      'failed is a runtime-only outcome: no worker may recommend it',
    );
  }
});


// ---------------------------------------------------------------------------
// Instruction side: the package resources the model literally reads.
//
// The enforcement side rejecting a word does not stop it from costing money if
// the checklist still teaches it (the stage-3 addendum: two discovery
// checklists offered defer/inconclusive for ~30 paid gate rejections per run).
// This scan keeps the taught vocabulary inside the module's emittable set.
//
// Scope is OUTCOME vocabulary only: lines that OFFER an outcome enumeration
// (recommended_outcome / "outcome ... one of"). Provider and observation
// states that merely reuse an English word — preflight-check-inconclusive,
// observation-inconclusive, the advisor's overall_readiness rating — do not
// offer lifecycle outcomes and are deliberately not flagged.
// ---------------------------------------------------------------------------

const ALL_MODULES = [
  ['discovery', discoveryProcessModule],
  ['formalization', formalizationProcessModule],
  ['development', developmentProcessModule],
  ['delivery', deliveryProcessModule],
];

/** Every word that ever was an outcome code: emittable ∪ deleted. */
const OUTCOME_WORD_UNIVERSE = new Set([
  ...ALL_MODULES.flatMap(([, module]) => moduleOutcomeCodes(module)),
  // deleted with the stage-3 purge — must never be offered again
  'defer', 'inconclusive', 'infeasible', 'rework-required', 'clarification-required',
]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const offersOutcomeEnumeration = (line) =>
  /recommended_outcome/.test(line) || /outcome[^.]{0,80}one of/i.test(line);

test('no package resource offers an outcome word outside its module emittable set', () => {
  const violations = [];
  for (const [moduleName, module] of ALL_MODULES) {
    const emittable = new Set(moduleOutcomeCodes(module));
    const resourcesDir = path.join(
      repoRoot, 'src/process-modules/modules', moduleName, 'package/resources',
    );
    let files;
    try {
      files = readdirSync(resourcesDir).filter(f => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const file of files) {
      const lines = readFileSync(path.join(resourcesDir, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!offersOutcomeEnumeration(line)) return;
        for (const word of OUTCOME_WORD_UNIVERSE) {
          if (new RegExp(`\\b${word}\\b`).test(line) && !emittable.has(word)) {
            violations.push(
              `${moduleName}/package/resources/${file}:${index + 1} offers '${word}' `
              + `(emittable: ${[...emittable].join(', ')}) — ${line.trim()}`,
            );
          }
        }
      });
    }
  }
  assert.deepEqual(
    violations, [],
    'a resource teaching an outcome the module cannot emit is a cost defect: '
    + 'the worker pays for the attempt, the gate rejects it. '
    + `Violations: ${JSON.stringify(violations)}`,
  );
});
