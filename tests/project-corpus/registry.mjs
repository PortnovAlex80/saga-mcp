/**
 * tests/project-corpus/registry.mjs - the ordered registry of the 20
 * scripted EK-9 project descriptors (WP-13D), plus the fast smoke subset.
 */

import { validateProjectDescriptor } from './format.mjs';

const modules = [
  './projects/p01-served-happy.mjs',
  './projects/p02-static-product.mjs',
  './projects/p03-served-repair.mjs',
  './projects/p04-batch-pipeline.mjs',
  './projects/p05-scheduled-independent.mjs',
  './projects/p06-autonomous-ladder.mjs',
  './projects/p07-autonomous-worker-loss.mjs',
  './projects/p08-cross-module-seams.mjs',
  './projects/p09-chain-topology.mjs',
  './projects/p10-diamond-topology.mjs',
  './projects/p11-fan-in-topology.mjs',
  './projects/p12-fan-out-topology.mjs',
  './projects/p13-independent-topology.mjs',
  './projects/p14-honest-refusal.mjs',
  './projects/p15-failed-predecessor.mjs',
  './projects/p16-human-wait-operator.mjs',
  './projects/p17-effect-uncertainty.mjs',
  './projects/p18-restart-matrix.mjs',
  './projects/p19-projection-faults.mjs',
  './projects/p20-idempotent-replay.mjs',
];

/** Load, validate and order the corpus (fails loudly on any invalid descriptor). */
export async function loadCorpus() {
  const corpus = [];
  for (const path of modules) {
    const module = await import(path);
    const descriptor = module.default;
    const { valid, errors } = validateProjectDescriptor(descriptor);
    if (!valid) {
      throw new Error(`descriptor ${path} is invalid:\n${errors.map((error) => `  ${error.path}: [${error.code}] ${error.message}`).join('\n')}`);
    }
    corpus.push(descriptor);
  }
  const ids = corpus.map((descriptor) => descriptor.projectId);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`duplicate project ids in the corpus: ${ids.join(', ')}`);
  }
  return corpus;
}

/** The fast smoke subset: one project per major family (5 projects). */
export const SMOKE_PROJECT_IDS = [
  'p01-served-happy',        // development vertical + real product verification
  'p09-chain-topology',      // planning conveyor topology
  'p14-honest-refusal',      // durable typed-refusal terminal
  'p16-human-wait-operator', // durable operator disposition
  'p19-projection-faults',   // durable fault-scheduler probes
];

let cache = null;
/** The corpus (cached; deterministic - descriptors are pure data builders). */
export async function corpus() {
  if (cache === null) cache = await loadCorpus();
  return cache;
}

export async function descriptorOf(projectId) {
  const all = await corpus();
  const found = all.find((descriptor) => descriptor.projectId === projectId);
  if (found === undefined) throw new Error(`unknown project id "${projectId}" (known: ${(await corpus()).map((d) => d.projectId).join(', ')})`);
  return found;
}
