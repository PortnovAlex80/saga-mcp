/**
 * support.mjs - shared fixtures for the WP-18 context-envelope scale tests.
 *
 * The provider/model limit table is the FROZEN illustrative example artifact
 * (docs/refactoring/event-kernel/specs/examples/): using it proves behavioral
 * equality between this package's table digest rule and the frozen admission
 * validator's. The profile pins the RUNNING counter identity (the example
 * profiles pin an illustrative counter digest by design - real production
 * profiles land at EK-8).
 *
 * Every engineered layer content is PURE tokenText, so token counts are
 * exact: tokenText(n) counts exactly n tokens under the pinned counter.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXAMPLE_TABLE_PATH = path.join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs', 'examples', 'provider-model-limit-table.example.json');

export const envelope = await import('../../../dist/workflow-kernel/context-envelope/index.js');

/** The frozen example limit-table artifact + its declared digest. */
export function frozenExampleTable() {
  const doc = JSON.parse(readFileSync(EXAMPLE_TABLE_PATH, 'utf8'));
  return { artifact: doc.table, declaredDigest: doc.computedRowsDigest };
}

/** The exact route pin of the glm-5.2 example row. */
export const EXAMPLE_ROUTE_PIN = { provider: 'zai', model: 'glm-5.2', version: 'catalog-2026-08-24' };

/**
 * A valid PromptBudgetProfile bound to the frozen example table + the
 * RUNNING counter identity. `overrides` mutates single fields for boundary
 * tests.
 */
export function testProfile(overrides = {}) {
  const { declaredDigest } = frozenExampleTable();
  return {
    providerModelLimitTableRef: {
      ref: 'content://provider-model-limit-tables/factory-illustrative-2026-08',
      digest: declaredDigest,
      digestAlgorithm: 'sha256',
    },
    providerContextLimitTokens: 131072,
    tokenCounterRef: { ...envelope.RUNNING_COUNTER_IDENTITY },
    maxProviderRequests: 40,
    maxStaticTokens: 40000,
    maxDynamicTokens: 30000,
    maxRecoveryTokens: 8000,
    maxToolResultTokens: 12000,
    maxTotalInputTokens: 100000,
    maxCumulativeSessionInputTokens: 800000,
    reservedOutputTokens: 8192,
    providerOverheadReserveTokens: 2048,
    safetyMarginTokens: 4096,
    maxPromptBytes: 393216,
    ...overrides,
  };
}

export function testPins(overrides) {
  return { profile: testProfile(overrides), limitTable: frozenExampleTable().artifact };
}

/** Text with an EXACT token count under the pinned counter: n 4-char words. */
export function tokenText(tokens) {
  if (tokens <= 0) return '';
  return Array.from({ length: tokens }, () => 'aaaa').join(' ');
}

/** The five mandatory-inline layers (CS-01..CS-05) with exact token counts. */
export function mandatoryLayers(eachTokens = 3) {
  return [
    { layer: 'initial-prompt-frame', content: tokenText(eachTokens) },
    { layer: 'protocol-skill', content: tokenText(eachTokens) },
    { layer: 'semantic-skill', content: tokenText(eachTokens) },
    { layer: 'tool-schemas', content: tokenText(eachTokens) },
    { layer: 'write-authority', content: tokenText(eachTokens) },
  ];
}

/**
 * A conforming envelope with EXACT per-layer token control:
 *   staticLayers  - token count of EACH mandatory layer (default 3, total 5x)
 *   task/workspace/hook/recovery/toolResults - token counts (0 = omitted)
 * Grammar-enforced layers declare boundedTransportForm unless raw* is set.
 */
export function conformingEnvelope(options = {}) {
  const {
    staticEach = 3,
    task = 10,
    workspace = 10,
    hook = 0,
    recovery = 0,
    toolResults = 0,
    rawTaskRow = false,
    rawWorkspace = false,
    deskReference = false,
  } = options;
  const layers = mandatoryLayers(staticEach);
  if (task > 0) layers.push({ layer: 'task-projection', content: tokenText(task), boundedTransportForm: !rawTaskRow });
  if (workspace > 0) layers.push({ layer: 'workspace-summary', content: tokenText(workspace), boundedTransportForm: !rawWorkspace });
  if (recovery > 0) layers.push({ layer: 'recovery-history', content: tokenText(recovery) });
  if (hook > 0) layers.push({ layer: 'hook-context', content: tokenText(hook) });
  if (toolResults > 0) layers.push({ layer: 'tool-results', content: tokenText(toolResults) });
  if (deskReference) {
    layers.push({
      layer: 'desk-reference',
      content: tokenText(2),
      externalReferences: [{ ref: 'content://desks/reviewer/2026-08', digest: `sha256:${'b'.repeat(64)}`, summary: 'reviewer desk (bounded pointer)' }],
    });
  }
  return { layers };
}

/** Initial CAS counters for one attempt under the example route pin. */
export function testAttemptCounters(overrides = {}) {
  const base = envelope.initialAttemptCounters({
    attemptRef: overrides.attemptRef ?? 'attempt:test-1',
    providerRoutePin: overrides.providerRoutePin ?? EXAMPLE_ROUTE_PIN,
    promptBudgetProfileRef: overrides.promptBudgetProfileRef ?? 'content://prompt-budget-profiles/test-glm-5.2',
    promptBudgetProfileDigest: overrides.promptBudgetProfileDigest ?? `sha256:${'c'.repeat(64)}`,
  });
  // counter-state overrides (contextRevision, nextRequestOrdinal,
  // cumulativeInputTokens) are applied AFTER the initial state
  return { ...base, ...overrides };
}

export function assertRefused(violation, expected) {
  assert.equal(violation.ok, false, `expected a refusal, got ok verdict: ${JSON.stringify(violation).slice(0, 300)}`);
  assert.equal(violation.violation, expected);
}
