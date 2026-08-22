// tests/factory-proof/coverage-kernel.mjs
//
// Pure mathematical coverage kernel for the unified Saga proof engine.
//
// It has NO Factory runtime imports and no DB access. It consumes declarative
// scenario definitions or completed ScenarioEvidenceBundles and answers:
//   - which obligations/gates/transitions/fault dimensions are covered;
//   - which required items remain uncovered;
//   - the smallest scenario subset for small corpora (exact set cover);
//   - a deterministic greedy approximation for larger corpora.
//
// Coverage tokens are intentionally open-ended namespaced strings. Workshop
// matrices can add `gate:*`, `transition:*`, `negative-transition:*` and
// `transition-pair:*` items without changing this engine.

export const COVERAGE_PREFIX = Object.freeze({
  obligation: 'obligation',
  gate: 'gate',
  transition: 'transition',
  negativeTransition: 'negative-transition',
  transitionPair: 'transition-pair',
  faultClass: 'fault-class',
  injectionBoundary: 'injection-boundary',
  detector: 'detector',
  counterfactual: 'counterfactual',
  scenarioKind: 'scenario-kind',
  repairOwner: 'repair-owner',
});

const nonEmpty = value => typeof value === 'string' && value.length > 0;
const uniqueSorted = values => [...new Set(values)].sort((a, b) => a.localeCompare(b));

export const coverageToken = Object.freeze({
  obligation: id => `${COVERAGE_PREFIX.obligation}:${id}`,
  gate: (gateId, outcome) => `${COVERAGE_PREFIX.gate}:${gateId}:${outcome}`,
  transition: (from, to) => `${COVERAGE_PREFIX.transition}:${from}->${to}`,
  negativeTransition: (from, attemptedTo) =>
    `${COVERAGE_PREFIX.negativeTransition}:${from}-/->${attemptedTo}`,
  transitionPair: (from, via, to) =>
    `${COVERAGE_PREFIX.transitionPair}:${from}->${via}->${to}`,
});

/** Derive the universal dimensions carried by a declarative scenario. */
export function coverageItemsFromScenario(scenario) {
  if (!scenario || typeof scenario !== 'object') return [];
  const items = [];
  for (const id of scenario.proves ?? []) {
    if (nonEmpty(id)) items.push(coverageToken.obligation(id));
  }
  for (const id of scenario.coverageItems ?? []) {
    if (nonEmpty(id)) items.push(id);
  }
  const kind = scenario.kind ?? (scenario.defectId ? 'causal-fault' : null);
  if (nonEmpty(kind)) items.push(`${COVERAGE_PREFIX.scenarioKind}:${kind}`);
  if (nonEmpty(scenario.faultClass)) {
    items.push(`${COVERAGE_PREFIX.faultClass}:${scenario.faultClass}`);
  }
  if (nonEmpty(scenario.injection?.boundary)) {
    items.push(`${COVERAGE_PREFIX.injectionBoundary}:${scenario.injection.boundary}`);
  }
  if (nonEmpty(scenario.expected?.detectorRef)) {
    items.push(`${COVERAGE_PREFIX.detector}:${scenario.expected.detectorRef}`);
  }
  if (nonEmpty(scenario.expected?.repairOwner)) {
    items.push(`${COVERAGE_PREFIX.repairOwner}:${scenario.expected.repairOwner}`);
  }
  for (const variant of scenario.counterfactualFeedback ?? []) {
    if (nonEmpty(variant)) items.push(`${COVERAGE_PREFIX.counterfactual}:${variant}`);
  }
  return uniqueSorted(items);
}

/** Same derivation from the compact scenario summary stored in an evidence bundle. */
export function coverageItemsFromEvidence(bundle, { requirePass = true } = {}) {
  if (!bundle || typeof bundle !== 'object') return [];
  if (requirePass && bundle.verdict !== 'pass') return [];
  const scenario = bundle.scenario ?? {};
  const items = [];
  for (const id of scenario.proves ?? []) {
    if (nonEmpty(id)) items.push(coverageToken.obligation(id));
  }
  for (const id of scenario.coverageItems ?? []) {
    if (nonEmpty(id)) items.push(id);
  }
  if (nonEmpty(scenario.kind)) {
    items.push(`${COVERAGE_PREFIX.scenarioKind}:${scenario.kind}`);
  }
  if (nonEmpty(scenario.faultClass)) {
    items.push(`${COVERAGE_PREFIX.faultClass}:${scenario.faultClass}`);
  }
  if (nonEmpty(scenario.injectionBoundary)) {
    items.push(`${COVERAGE_PREFIX.injectionBoundary}:${scenario.injectionBoundary}`);
  }
  if (nonEmpty(scenario.detectorRef)) {
    items.push(`${COVERAGE_PREFIX.detector}:${scenario.detectorRef}`);
  }
  if (nonEmpty(scenario.repairOwner)) {
    items.push(`${COVERAGE_PREFIX.repairOwner}:${scenario.repairOwner}`);
  }
  for (const variant of scenario.counterfactualFeedback ?? []) {
    if (nonEmpty(variant)) items.push(`${COVERAGE_PREFIX.counterfactual}:${variant}`);
  }
  return uniqueSorted(items);
}

function scenarioId(scenario, index) {
  const id = scenario?.id ?? scenario?.defectId;
  if (!nonEmpty(id)) throw new Error(`COVERAGE_SCENARIO_ID_REQUIRED: index ${index}`);
  return id;
}

function matrixFromColumns(columns, requiredItems = []) {
  const ids = columns.map(column => column.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('COVERAGE_SCENARIO_ID_DUPLICATE');
  }

  const derivedUniverse = uniqueSorted(columns.flatMap(column => column.covers));
  const items = requiredItems.length > 0
    ? uniqueSorted(requiredItems)
    : derivedUniverse;
  if (items.some(item => !nonEmpty(item))) {
    throw new Error('COVERAGE_ITEM_INVALID');
  }
  const itemSet = new Set(items);
  const normalizedColumns = columns.map(column => ({
    ...column,
    covers: uniqueSorted(column.covers.filter(item => itemSet.has(item))),
  }));
  const rows = items.map(item => ({
    item,
    coveredBy: normalizedColumns
      .filter(column => column.covers.includes(item))
      .map(column => column.id),
  }));
  const uncovered = rows.filter(row => row.coveredBy.length === 0).map(row => row.item);
  return {
    items,
    scenarios: normalizedColumns,
    rows,
    uncovered,
  };
}

/** Definition-level planning matrix. A declaration is NOT execution evidence. */
export function buildScenarioCoverageMatrix(scenarios, { requiredItems = [] } = {}) {
  if (!Array.isArray(scenarios)) throw new Error('COVERAGE_SCENARIOS_REQUIRED');
  return matrixFromColumns(scenarios.map((scenario, index) => ({
    id: scenarioId(scenario, index),
    covers: coverageItemsFromScenario(scenario),
    evidenceDigest: null,
  })), requiredItems);
}

/**
 * Evidence-level matrix. By default only PASS bundles contribute coverage;
 * failed/inconclusive executions remain listed in `excluded` and cannot make
 * a target look covered merely because the scenario declared it.
 */
export function buildEvidenceCoverageMatrix(bundles, {
  requiredItems = [],
  requirePass = true,
} = {}) {
  if (!Array.isArray(bundles)) throw new Error('COVERAGE_EVIDENCE_REQUIRED');
  const included = [];
  const excluded = [];
  for (const [index, bundle] of bundles.entries()) {
    const id = bundle?.scenario?.id;
    if (!nonEmpty(id)) throw new Error(`COVERAGE_EVIDENCE_SCENARIO_ID_REQUIRED: index ${index}`);
    const eligible = !requirePass || bundle.verdict === 'pass';
    if (!eligible) {
      excluded.push({ id, verdict: bundle.verdict ?? 'unknown', bundleDigest: bundle.bundleDigest ?? null });
      continue;
    }
    included.push({
      id,
      covers: coverageItemsFromEvidence(bundle, { requirePass: false }),
      evidenceDigest: bundle.bundleDigest ?? null,
    });
  }
  return {
    ...matrixFromColumns(included, requiredItems),
    excluded,
  };
}

export function summarizeCoverage(matrix) {
  const total = matrix?.items?.length ?? 0;
  const uncovered = matrix?.uncovered ?? [];
  const covered = Math.max(0, total - uncovered.length);
  return {
    total,
    covered,
    uncovered: [...uncovered],
    ratio: total === 0 ? 1 : covered / total,
    percent: total === 0 ? 100 : (covered * 100) / total,
  };
}

function greedyCover(matrix) {
  const uncovered = new Set(matrix.items);
  const chosen = [];
  const columns = [...matrix.scenarios].sort((a, b) => a.id.localeCompare(b.id));
  while (uncovered.size > 0) {
    let best = null;
    let bestGain = 0;
    for (const column of columns) {
      if (chosen.includes(column.id)) continue;
      const gain = column.covers.reduce((n, item) => n + (uncovered.has(item) ? 1 : 0), 0);
      if (gain > bestGain || (gain === bestGain && gain > 0 && column.id < best.id)) {
        best = column;
        bestGain = gain;
      }
    }
    if (!best || bestGain === 0) break;
    chosen.push(best.id);
    for (const item of best.covers) uncovered.delete(item);
  }
  return {
    feasible: uncovered.size === 0,
    selected: chosen,
    uncovered: uniqueSorted([...uncovered]),
    method: 'greedy',
    exact: false,
  };
}

function lexicographicallyLess(a, b) {
  if (!b) return true;
  const aa = [...a].sort();
  const bb = [...b].sort();
  for (let i = 0; i < Math.min(aa.length, bb.length); i += 1) {
    const cmp = aa[i].localeCompare(bb[i]);
    if (cmp !== 0) return cmp < 0;
  }
  return aa.length < bb.length;
}

function exactCover(matrix) {
  if (matrix.uncovered.length > 0) {
    return {
      feasible: false,
      selected: [],
      uncovered: [...matrix.uncovered],
      method: 'exact',
      exact: true,
    };
  }

  const columns = [...matrix.scenarios].sort((a, b) => a.id.localeCompare(b.id));
  const byItem = new Map(matrix.items.map(item => [
    item,
    columns.filter(column => column.covers.includes(item)),
  ]));
  const seed = greedyCover(matrix);
  let best = seed.feasible ? [...seed.selected] : null;
  const memo = new Map();

  const search = (uncovered, chosen) => {
    if (uncovered.size === 0) {
      if (!best || chosen.length < best.length
        || (chosen.length === best.length && lexicographicallyLess(chosen, best))) {
        best = [...chosen];
      }
      return;
    }
    if (best && chosen.length >= best.length) return;

    const stateKey = uniqueSorted([...uncovered]).join('\u0000');
    const seenDepth = memo.get(stateKey);
    if (seenDepth !== undefined && seenDepth < chosen.length) return;
    memo.set(stateKey, chosen.length);

    let maxGain = 0;
    for (const column of columns) {
      const gain = column.covers.reduce((n, item) => n + (uncovered.has(item) ? 1 : 0), 0);
      if (gain > maxGain) maxGain = gain;
    }
    if (maxGain === 0) return;
    const lowerBound = Math.ceil(uncovered.size / maxGain);
    if (best && chosen.length + lowerBound > best.length) return;

    let pivot = null;
    let candidates = null;
    for (const item of uncovered) {
      const applicable = (byItem.get(item) ?? [])
        .filter(column => !chosen.includes(column.id))
        .map(column => ({
          column,
          gain: column.covers.reduce((n, covered) => n + (uncovered.has(covered) ? 1 : 0), 0),
        }))
        .filter(entry => entry.gain > 0);
      if (applicable.length === 0) return;
      if (candidates === null || applicable.length < candidates.length
        || (applicable.length === candidates.length && item < pivot)) {
        pivot = item;
        candidates = applicable;
      }
    }

    candidates.sort((a, b) => b.gain - a.gain || a.column.id.localeCompare(b.column.id));
    for (const { column } of candidates) {
      const next = new Set(uncovered);
      for (const item of column.covers) next.delete(item);
      search(next, [...chosen, column.id]);
    }
  };

  search(new Set(matrix.items), []);
  return best
    ? { feasible: true, selected: [...best].sort(), uncovered: [], method: 'exact', exact: true }
    : { feasible: false, selected: [], uncovered: [...matrix.items], method: 'exact', exact: true };
}

/**
 * Solve set cover over a coverage matrix. Exact branch-and-bound is used while
 * the corpus is small enough to be practical; larger corpora switch to the
 * standard greedy ln(n)-approximation strategy, deterministically tie-broken.
 */
export function selectScenarioCover(matrix, { exactLimit = 22 } = {}) {
  if (!matrix || !Array.isArray(matrix.items) || !Array.isArray(matrix.scenarios)) {
    throw new Error('COVERAGE_MATRIX_REQUIRED');
  }
  if (!Number.isInteger(exactLimit) || exactLimit < 0) {
    throw new Error('COVERAGE_EXACT_LIMIT_INVALID');
  }
  if (matrix.uncovered?.length > 0) {
    return {
      feasible: false,
      selected: [],
      uncovered: [...matrix.uncovered],
      method: matrix.scenarios.length <= exactLimit ? 'exact' : 'greedy',
      exact: matrix.scenarios.length <= exactLimit,
    };
  }
  return matrix.scenarios.length <= exactLimit
    ? exactCover(matrix)
    : greedyCover(matrix);
}
