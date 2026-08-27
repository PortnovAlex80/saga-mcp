/**
 * tools/frf-corpus/lib/registry.mjs - the ordered registry of the FRF
 * scenario corpus (FRF-WP10), plus the fast smoke subset.
 */

import { validateFrfScenario } from '../format.mjs';

const modules = [
  '../scenarios/s01-desk-chain-happy.mjs',
  '../scenarios/s02-foreign-binding-mutations.mjs',
  '../scenarios/s03-stale-binding-mutations.mjs',
  '../scenarios/s04-omitted-binding-mutations.mjs',
  '../scenarios/s05-reconciliation-drift.mjs',
  '../scenarios/s06-what-freeze-authority-mutations.mjs',
  '../scenarios/s07-srs-elite-kills.mjs',
  '../scenarios/s08-planning-gate-kill.mjs',
  '../scenarios/s09-replan-identity-cycle.mjs',
  '../scenarios/s10-human-wait-d5.mjs',
  '../scenarios/s11-crash-restart-matrix.mjs',
];

/** Load, validate and order the corpus (fails loudly on any invalid descriptor). */
export async function loadFrfCorpus() {
  const corpus = [];
  for (const path of modules) {
    const module = await import(path);
    const descriptor = module.default;
    const { valid, errors } = validateFrfScenario(descriptor);
    if (!valid) {
      throw new Error(`descriptor ${path} is invalid:\n${errors.map((error) => `  ${error.path}: [${error.code}] ${error.message}`).join('\n')}`);
    }
    corpus.push(descriptor);
  }
  const ids = corpus.map((descriptor) => descriptor.frf.scenarioId);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`duplicate scenario ids in the corpus: ${ids.join(', ')}`);
  }
  return corpus;
}

/** The fast smoke subset: one scenario per major family. */
export const SMOKE_SCENARIO_IDS = [
  's01-desk-chain-happy',       // the full green desk chain + capsule
  's06-what-freeze-authority-mutations', // the WHAT-freeze authority kills
  's08-planning-gate-kill',     // the AC-complete/scenario-incomplete gate
  's10-human-wait-d5',          // the D5 public-command disposition
  's11-crash-restart-matrix',   // the crash/restart exactly-once law
];

let cache = null;
/** The corpus (cached; deterministic - descriptors are pure data builders). */
export async function frfCorpus() {
  if (cache === null) cache = await loadFrfCorpus();
  return cache;
}

export async function frfDescriptorOf(scenarioId) {
  const all = await frfCorpus();
  const found = all.find((descriptor) => descriptor.frf.scenarioId === scenarioId);
  if (found === undefined) throw new Error(`unknown scenario id "${scenarioId}" (known: ${all.map((d) => d.frf.scenarioId).join(', ')})`);
  return found;
}
