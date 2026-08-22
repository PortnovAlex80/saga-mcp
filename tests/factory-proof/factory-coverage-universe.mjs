// tests/factory-proof/factory-coverage-universe.mjs
//
// The GLOBAL coverage layer over the four workshop packs
// (docs/testing/DELIVERY-KERNEL-REPAIR-PLAN.md §2):
//
//   Factory Coverage Universe = the union of every workshop's declared
//   coverage universe + pending universe + platform fault edges (K4-owned),
//   each token namespaced by workshop.
//
//   MONOTONICITY (operator review 2026-08-22): the universe U never shrinks.
//   Landing an obligation MOVES its token pending → required (demonstrated);
//   the token never leaves U. Shrinking U to shrink "uncovered" is the
//   coverage-model defect this layer must make impossible: a landed token
//   that vanished from the denominator would silently inflate coverage.
//
//   Workshop closure status is DATA, derived from set-equality of what the
//   packs DECLARE — never from prose:
//     CLOSED  the declared required universe is fully covered by declared
//             scenarios (buildScenarioCoverageMatrix set-equality) AND the
//             pending universe is empty;
//     SPINE   the positive spine scenarios exist and pass-classify, but the
//             pending universe is non-empty;
//     PENDING no positive spine yet.
//
//   The ratchet: the global report is deterministic — the uncovered set may
//   only shrink by DECLARING a covering scenario in a pack, never silently.
//
// Demonstrated coverage (PASS bundles from real drives) remains the
// coverage-kernel's job; this module is the declared-universe ledger.

import {
  DISCOVERY_CLOSURE_SCENARIOS,
  DISCOVERY_CLOSURE_COVERAGE_UNIVERSE,
  DISCOVERY_PLATFORM_FAULT_EDGES,
} from './discovery-resilience-pack.mjs';
import {
  FORMALIZATION_CLOSURE_SCENARIOS,
  FORMALIZATION_CLOSURE_COVERAGE_UNIVERSE,
} from './formalization-resilience-pack.mjs';
import { FORMALIZATION_PLATFORM_FAULT_EDGES } from './formalization-scenario-pack.mjs';
import {
  DEVELOPMENT_SCENARIOS,
  DEVELOPMENT_REQUIRED_UNIVERSE,
  DEVELOPMENT_PENDING_UNIVERSE,
  DEVELOPMENT_PLATFORM_FAULT_EDGES,
} from './development-scenario-pack.mjs';
import {
  DELIVERY_SCENARIOS,
  DELIVERY_REQUIRED_UNIVERSE,
  DELIVERY_PENDING_UNIVERSE,
} from './delivery-scenario-pack.mjs';
import { buildScenarioCoverageMatrix } from './coverage-kernel.mjs';

const WORKSHOPS = Object.freeze([
  {
    id: 'discovery',
    scenarios: DISCOVERY_CLOSURE_SCENARIOS,
    requiredUniverse: DISCOVERY_CLOSURE_COVERAGE_UNIVERSE,
    pendingUniverse: [],
    platformFaultEdges: DISCOVERY_PLATFORM_FAULT_EDGES,
  },
  {
    id: 'formalization',
    scenarios: FORMALIZATION_CLOSURE_SCENARIOS,
    requiredUniverse: FORMALIZATION_CLOSURE_COVERAGE_UNIVERSE,
    pendingUniverse: [],
    platformFaultEdges: FORMALIZATION_PLATFORM_FAULT_EDGES,
  },
  {
    id: 'development',
    scenarios: DEVELOPMENT_SCENARIOS,
    requiredUniverse: DEVELOPMENT_REQUIRED_UNIVERSE,
    pendingUniverse: DEVELOPMENT_PENDING_UNIVERSE,
    platformFaultEdges: DEVELOPMENT_PLATFORM_FAULT_EDGES,
  },
  {
    id: 'delivery',
    scenarios: DELIVERY_SCENARIOS,
    requiredUniverse: DELIVERY_REQUIRED_UNIVERSE,
    pendingUniverse: DELIVERY_PENDING_UNIVERSE,
    platformFaultEdges: [],
  },
]);

function workshopStatus(workshop) {
  const matrix = buildScenarioCoverageMatrix(workshop.scenarios, {
    requiredItems: workshop.requiredUniverse,
  });
  const uncovered = matrix.uncovered ?? [];
  if (workshop.pendingUniverse.length === 0 && uncovered.length === 0) {
    return 'CLOSED';
  }
  return workshop.scenarios.length > 0 ? 'SPINE' : 'PENDING';
}

export function buildFactoryCoverageUniverse() {
  const perWorkshop = WORKSHOPS.map(workshop => {
    const matrix = buildScenarioCoverageMatrix(workshop.scenarios, {
      requiredItems: workshop.requiredUniverse,
    });
    return {
      workshop: workshop.id,
      status: workshopStatus(workshop),
      scenarioCount: workshop.scenarios.length,
      requiredUniverseSize: workshop.requiredUniverse.length,
      // The full required list (the demonstrated layer maps PASS bundles
      // onto these tokens — C/U needs the items, not just the size).
      requiredUniverseItems: [...workshop.requiredUniverse],
      uncoveredRequired: matrix.uncovered ?? [],
      pendingSize: workshop.pendingUniverse.length,
      pendingItems: [...workshop.pendingUniverse],
      platformFaultEdges: [...workshop.platformFaultEdges],
    };
  });

  // Token ownership: cross-cutting tokens (handoff/obligation/external —
  // e.g. 'obligation:handoff.route-lifecycle') are LEGITIMATELY shared by the
  // workshops that participate in the handoff — that shared set IS the
  // inter-workshop aggregate. Workshop-local namespaces (restart:<workshop>:,
  // transition:<workshop-cell>, recovery:<cell>) must stay single-owner.
  const owners = new Map();
  for (const workshop of WORKSHOPS) {
    for (const token of [
      ...workshop.requiredUniverse,
      ...workshop.pendingUniverse,
      ...workshop.platformFaultEdges,
    ]) {
      const set = owners.get(token) ?? new Set();
      set.add(workshop.id);
      owners.set(token, set);
    }
  }
  for (const [token, set] of owners) {
    if (set.size > 1 && /^[a-z]+:[a-z0-9-]+:/.test(token) === false && !token.startsWith('obligation:') && !token.startsWith('handoff:') && !token.startsWith('external:') && !token.startsWith('kernel:')) {
      throw new Error(
        `FACTORY_COVERAGE_TOKEN_SHADOWED: '${token}' declared by ${[...set].join('+')} without a cross-cutting namespace`,
      );
    }
  }
  const interWorkshopTokens = [...owners.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([token]) => token)
    .sort();

  return {
    schemaVersion: 'factory.proof.coverage-universe.v1',
    perWorkshop,
    totals: {
      workshops: perWorkshop.length,
      closed: perWorkshop.filter(w => w.status === 'CLOSED').length,
      spine: perWorkshop.filter(w => w.status === 'SPINE').length,
      universeTokens: owners.size,
      interWorkshopTokens: interWorkshopTokens.length,
      pendingTotal: perWorkshop.reduce((sum, w) => sum + w.pendingSize, 0),
      platformFaultEdges: perWorkshop.reduce(
        (sum, w) => sum + w.platformFaultEdges.length, 0),
    },
    interWorkshopTokens,
    globalUncovered: [
      ...new Set([
        ...perWorkshop.flatMap(w => w.uncoveredRequired),
        ...perWorkshop.flatMap(w => w.pendingItems),
      ]),
    ].sort(),
  };
}

export function renderFactoryCoverageReport(universe) {
  const lines = [
    '# Factory Coverage Universe',
    '',
    '| Workshop | Status | Scenarios | Required | Uncovered | Pending | K4 edges |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const w of universe.perWorkshop) {
    lines.push(`| ${w.workshop} | ${w.status} | ${w.scenarioCount} | ${w.requiredUniverseSize} | ${w.uncoveredRequired.length} | ${w.pendingSize} | ${w.platformFaultEdges.length} |`);
  }
  lines.push('');
  lines.push(`Universe tokens: ${universe.totals.universeTokens}; pending total: ${universe.totals.pendingTotal}; global uncovered: ${universe.globalUncovered.length}`);
  return lines.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('factory-coverage-universe.mjs')) {
  const universe = buildFactoryCoverageUniverse();
  process.stdout.write(
    `${JSON.stringify(universe, null, 2)}\n\n${renderFactoryCoverageReport(universe)}\n`,
  );
}
