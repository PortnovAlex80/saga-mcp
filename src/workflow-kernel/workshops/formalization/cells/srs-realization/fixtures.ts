/**
 * workflow-kernel/workshops/formalization/cells/srs-realization/fixtures.ts
 * - FRF-WP08: the deterministic GREEN fixtures of the SRS scenario-realization
 * cell (plan phase FRF-8: interactive, API, batch, autonomous and Elite
 * fixtures; the Elite interactive composition path is the kill surface of
 * the plan's "Elite and simple-server kill tests").
 *
 * The fixture models the Elite/simple-server shape the plan names: browser
 * bootstrap entrypoint, input-to-controller edge, state-to-renderer edge,
 * composition owner, HUD terminal observable result, test evidence - plus
 * one API (external-system), one scheduled/batch (clock) and one autonomous
 * (sensor/environment) scenario, all through the SAME contract (no
 * game-specific or human-only branch).
 *
 * DETERMINISM: every digest is computed from literal content (canonical
 * rule); no clock, no randomness, no I/O. Two builds of the same fixture
 * are byte-identical.
 *
 * The RED kill material (mutated drafts/contracts) lives in the tests
 * directory - production fixtures stay green-only.
 */

import {
  SRS_TRACE_RULE,
  deterministicDigest,
} from './contract.js';
import type { SrsRealizationUniverse } from './contract.js';
import { authorArchitectureContract } from './desk.js';

/** The frozen scenario id set of the fixture universe (four product profiles). */
export const ELITE_SCENARIO_IDS = Object.freeze([
  'uc:elite-api',
  'uc:elite-autonomous',
  'uc:elite-batch',
  'uc:elite-interactive',
] as const);

/** The frozen evidence-method binding id set of the fixture universe. */
export const ELITE_EVIDENCE_BINDING_IDS = Object.freeze([
  'ev:elite-api-receipt',
  'ev:elite-autonomous-monitoring',
  'ev:elite-batch-audit',
  'ev:elite-browser-smoke',
] as const);

/** The frozen WHAT baseline revision digest of the fixture universe. */
export function eliteWhatBaselineDigest(): string {
  return deterministicDigest({ fixture: 'frf-wp08-elite', authority: 'what-baseline' });
}

/** The accepted SRS revision digest of the fixture universe. */
export function eliteSrsRevisionDigest(): string {
  return deterministicDigest({ fixture: 'frf-wp08-elite', authority: 'srs-revision' });
}

/** The accepted id-set universe of the Elite fixture (the WP03 seam input). */
export function eliteUniverse(): SrsRealizationUniverse {
  return {
    idSets: {
      ucScenarioIds: [...ELITE_SCENARIO_IDS],
      evidenceBindingIds: [...ELITE_EVIDENCE_BINDING_IDS],
    },
    revisionPins: {
      whatBaselineDigest: eliteWhatBaselineDigest(),
      srsRevisionDigest: eliteSrsRevisionDigest(),
    },
  };
}

const ALL_SCENARIOS = [...ELITE_SCENARIO_IDS].sort();

/**
 * The green SRS scenario-realization DRAFT of the Elite fixture (the exact
 * input the desk parser consumes; authored data, never derived from the
 * validators).
 */
export function eliteRealizationDraft(): Record<string, unknown> {
  return {
    schemaVersion: 'formalization.srs-realization.v1',
    lineage: {
      traceRule: SRS_TRACE_RULE,
      baselineRef: `sha256:${eliteWhatBaselineDigest()}`,
    },
    realizationEntries: [
      {
        realizationEntryId: 'realization:elite-interactive',
        scenarioRef: 'uc:elite-interactive',
        entrypointSurfaceRef: 'arch:elite-browser-bootstrap',
        participatingSurfaceRefs: [
          'arch:elite-browser-bootstrap',
          'arch:elite-http-server',
          'arch:elite-input-controller',
          'arch:elite-domain',
          'arch:elite-state-store',
          'arch:elite-renderer',
          'arch:elite-hud',
        ],
        runtimeEdges: [
          { fromSurfaceRef: 'arch:elite-browser-bootstrap', toSurfaceRef: 'arch:elite-http-server' },
          { fromSurfaceRef: 'arch:elite-http-server', toSurfaceRef: 'arch:elite-input-controller' },
          { fromSurfaceRef: 'arch:elite-input-controller', toSurfaceRef: 'arch:elite-domain' },
          { fromSurfaceRef: 'arch:elite-domain', toSurfaceRef: 'arch:elite-state-store' },
          { fromSurfaceRef: 'arch:elite-state-store', toSurfaceRef: 'arch:elite-renderer' },
          { fromSurfaceRef: 'arch:elite-renderer', toSurfaceRef: 'arch:elite-hud' },
          { fromSurfaceRef: 'arch:elite-hud', toSurfaceRef: 'arch:elite-hud-terminal' },
        ],
        externalInterfaces: ['GET /elite', 'POST /elite/input'],
        implementationSurfaceRefs: ['arch:elite-test-harness'],
        compositionOwnerSurfaceRef: 'arch:elite-composition-owner',
        terminalResult: 'arch:elite-hud-terminal',
        evidenceBinding: { evidenceKind: 'test', evidenceBindingRef: 'ev:elite-browser-smoke' },
      },
      {
        realizationEntryId: 'realization:elite-api',
        scenarioRef: 'uc:elite-api',
        entrypointSurfaceRef: 'arch:elite-api-gateway',
        participatingSurfaceRefs: ['arch:elite-api-gateway', 'arch:elite-api-handler'],
        runtimeEdges: [
          { fromSurfaceRef: 'arch:elite-api-gateway', toSurfaceRef: 'arch:elite-api-handler' },
          { fromSurfaceRef: 'arch:elite-api-handler', toSurfaceRef: 'arch:elite-api-receipt-terminal' },
        ],
        externalInterfaces: ['POST /api/v1/reports'],
        implementationSurfaceRefs: ['arch:elite-test-harness'],
        compositionOwnerSurfaceRef: 'arch:elite-composition-owner',
        terminalResult: 'arch:elite-api-receipt-terminal',
        evidenceBinding: { evidenceKind: 'test', evidenceBindingRef: 'ev:elite-api-receipt' },
      },
      {
        realizationEntryId: 'realization:elite-batch',
        scenarioRef: 'uc:elite-batch',
        entrypointSurfaceRef: 'arch:elite-batch-scheduler',
        participatingSurfaceRefs: ['arch:elite-batch-scheduler', 'arch:elite-batch-worker'],
        runtimeEdges: [
          { fromSurfaceRef: 'arch:elite-batch-scheduler', toSurfaceRef: 'arch:elite-batch-worker' },
          { fromSurfaceRef: 'arch:elite-batch-worker', toSurfaceRef: 'arch:elite-batch-audit-terminal' },
        ],
        externalInterfaces: [],
        implementationSurfaceRefs: ['arch:elite-test-harness'],
        compositionOwnerSurfaceRef: 'arch:elite-composition-owner',
        terminalResult: 'arch:elite-batch-audit-terminal',
        evidenceBinding: { evidenceKind: 'audit', evidenceBindingRef: 'ev:elite-batch-audit' },
      },
      {
        realizationEntryId: 'realization:elite-autonomous',
        scenarioRef: 'uc:elite-autonomous',
        entrypointSurfaceRef: 'arch:elite-sensor-trigger',
        participatingSurfaceRefs: ['arch:elite-sensor-trigger', 'arch:elite-control-loop'],
        runtimeEdges: [
          { fromSurfaceRef: 'arch:elite-sensor-trigger', toSurfaceRef: 'arch:elite-control-loop' },
          { fromSurfaceRef: 'arch:elite-control-loop', toSurfaceRef: 'arch:elite-autonomous-terminal' },
        ],
        externalInterfaces: ['GET /telemetry'],
        implementationSurfaceRefs: ['arch:elite-test-harness'],
        compositionOwnerSurfaceRef: 'arch:elite-composition-owner',
        terminalResult: 'arch:elite-autonomous-terminal',
        evidenceBinding: { evidenceKind: 'monitoring', evidenceBindingRef: 'ev:elite-autonomous-monitoring' },
      },
    ],
    surfaces: [
      { surfaceId: 'arch:elite-browser-bootstrap', surfaceKind: 'composition', description: 'Serves and boots the browser application entrypoint.', realizedScenarioRefs: ['uc:elite-interactive'] },
      { surfaceId: 'arch:elite-http-server', surfaceKind: 'composition', description: 'Deterministic HTTP server surface of the elite product.', realizedScenarioRefs: ['uc:elite-interactive'] },
      { surfaceId: 'arch:elite-input-controller', surfaceKind: 'composition', description: 'Routes user input events into the domain.', realizedScenarioRefs: ['uc:elite-interactive'] },
      { surfaceId: 'arch:elite-domain', surfaceKind: 'composition', description: 'Pure domain behavior of the elite product.', realizedScenarioRefs: ['uc:elite-interactive'] },
      { surfaceId: 'arch:elite-state-store', surfaceKind: 'composition', description: 'Holds application state and propagates changes.', realizedScenarioRefs: ['uc:elite-interactive'] },
      { surfaceId: 'arch:elite-renderer', surfaceKind: 'composition', description: 'Renders state to the document.', realizedScenarioRefs: ['uc:elite-interactive'] },
      { surfaceId: 'arch:elite-hud', surfaceKind: 'composition', description: 'Heads-up display of the rendered terminal result.', realizedScenarioRefs: ['uc:elite-interactive'] },
      { surfaceId: 'arch:elite-composition-owner', surfaceKind: 'composition', description: 'Owns the composition of every elite scenario.', realizedScenarioRefs: ALL_SCENARIOS },
      { surfaceId: 'arch:elite-api-gateway', surfaceKind: 'composition', description: 'External-system API entrypoint with validation.', realizedScenarioRefs: ['uc:elite-api'] },
      { surfaceId: 'arch:elite-api-handler', surfaceKind: 'composition', description: 'Handles API requests and emits receipts.', realizedScenarioRefs: ['uc:elite-api'] },
      { surfaceId: 'arch:elite-batch-scheduler', surfaceKind: 'composition', description: 'Clock-driven scheduler entrypoint.', realizedScenarioRefs: ['uc:elite-batch'] },
      { surfaceId: 'arch:elite-batch-worker', surfaceKind: 'composition', description: 'Idempotent batch processing worker.', realizedScenarioRefs: ['uc:elite-batch'] },
      { surfaceId: 'arch:elite-sensor-trigger', surfaceKind: 'composition', description: 'Sensor/environment trigger entrypoint.', realizedScenarioRefs: ['uc:elite-autonomous'] },
      { surfaceId: 'arch:elite-control-loop', surfaceKind: 'composition', description: 'Autonomous decision and control loop.', realizedScenarioRefs: ['uc:elite-autonomous'] },
      { surfaceId: 'arch:elite-test-harness', surfaceKind: 'infrastructure', description: 'Typed construction surface: the elite test harness every scenario verifies through.', realizedScenarioRefs: ALL_SCENARIOS },
    ],
  };
}

export type EliteGreenAssembly = ReturnType<typeof eliteArchitectureContract>;

/**
 * The green architecture contract of the Elite fixture, assembled through
 * the desk path (parse -> validate -> seal). Throws if the fixture is not
 * green - a fixture that stops validating is a defect to fix, not a
 * runtime condition.
 */
export function eliteArchitectureContract() {
  const universe = eliteUniverse();
  const outcome = authorArchitectureContract(eliteRealizationDraft(), universe);
  if (!outcome.ok) {
    throw new Error(`the Elite fixture must stay green: ${outcome.reason}: ${outcome.detail}`);
  }
  return { product: outcome.product, section: outcome.section, universe };
}
