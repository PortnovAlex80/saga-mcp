/**
 * tools/frf-corpus/scenarios/scaffold.mjs - the FRF scenario descriptor
 * shape builder: one EK-9 base document (validated by the EK scenario
 * contract unchanged) plus the additive `frf` block of the FRF-WP10
 * extension. Deterministic pure data; no I/O beyond the frozen module
 * constants.
 */

import { SCENARIO_FORMAT_VERSION } from '../../../tests/workflow-kernel/engine/scenario.mjs';
import { FRF_BLOCK_FORMAT_VERSION, FRF_DESK_CHAIN } from '../format.mjs';

const HEX64 = 'a'.repeat(64);
const protocolVersionOf = async () => (await import('../../../dist/workflow-kernel/domain/universe.js')).UNIVERSE_SCHEMA_VERSION;

let cachedProtocolVersion = null;

/**
 * Build one FRF scenario descriptor.
 *   { scenarioId, dimension, seedFixture?, seed?, mutations?, faultSchedule?,
 *     expectedWorld, notes? }
 */
export async function frfScenario(over) {
  if (cachedProtocolVersion === null) cachedProtocolVersion = await protocolVersionOf();
  const chainEdges = FRF_DESK_CHAIN.slice(1).map((desk, index) => [FRF_DESK_CHAIN[index], desk]);
  return {
    formatVersion: SCENARIO_FORMAT_VERSION,
    identity: {
      protocolVersion: cachedProtocolVersion,
      buildDigest: HEX64,
      packageDigest: HEX64,
      capsuleId: `capsule:frf-${over.scenarioId}`,
      capsuleDigest: HEX64,
    },
    seedInput: { fresh: true, seed: over.seed ?? 20260827, ingress: [] },
    actorProgram: [],
    topology: { shape: 'chain', nodes: [...FRF_DESK_CHAIN], edges: chainEdges, concurrencyCap: 1 },
    faultSchedule: [],
    expectations: {
      events: [],
      obligations: [],
      waits: [],
      proofs: [],
      evidence: { material: [], gate: [], effect: [] },
    },
    verification: { productCommands: [] },
    timeBudgets: { totalMs: 600000, perStepMs: 60000 },
    frf: {
      scenarioId: over.scenarioId,
      formatVersion: FRF_BLOCK_FORMAT_VERSION,
      dimension: over.dimension,
      seedFixture: over.seedFixture ?? 'wp03-frozen-green',
      seed: over.seed ?? 20260827,
      mutations: over.mutations ?? [],
      faultSchedule: over.faultSchedule ?? [],
      expectedWorld: over.expectedWorld,
      notes: over.notes ?? [],
    },
  };
}
