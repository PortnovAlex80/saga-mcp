// tests/factory-proof/scenario-runner.mjs
//
// One reusable execution kernel for declarative Factory proof scenarios.
//
// The runner owns orchestration of TEST concerns only:
//   validate scenario -> canonical composition -> production drive -> readonly
//   durable observation -> independent oracles -> ScenarioEvidenceBundle.
// It never implements a reducer, gate, retry policy, finalizer, lifecycle route
// or authority writer. Cognition is the only worker seam (in-process handlers
// or strict workerSpawn), exactly as ADR-084 requires.

import {
  SCENARIO_SCHEMA_VERSION,
  validateCausalFaultScenario,
} from './scenario-dsl.mjs';
import { buildScenarioEvidenceBundle } from './scenario-evidence.mjs';

export const KERNEL_SCENARIO_SCHEMA_VERSION = 'factory.proof.kernel-scenario.v1';
export const KERNEL_SCENARIO_KINDS = Object.freeze([
  'positive', 'causal-fault', 'recovery',
]);

const RESERVED_DRIVE_KEYS = Object.freeze([
  'bootstrap', 'composition', 'scriptedObserver',
]);

function strings(values) {
  return Array.isArray(values)
    && values.every(v => typeof v === 'string' && v.length > 0);
}

/**
 * Validate either the existing strict CausalFaultScenario or the small common
 * KernelScenario envelope used by positive/recovery paths. The causal DSL is
 * delegated unchanged — the common envelope does not weaken it.
 */
export function validateRunnableScenario(scenario) {
  if (!scenario || typeof scenario !== 'object') return ['scenario must be an object'];
  if (scenario.schemaVersion === SCENARIO_SCHEMA_VERSION) {
    return validateCausalFaultScenario(scenario);
  }
  const errors = [];
  if (scenario.schemaVersion !== KERNEL_SCENARIO_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${KERNEL_SCENARIO_SCHEMA_VERSION} or ${SCENARIO_SCHEMA_VERSION}`);
  }
  if (typeof scenario.id !== 'string' || scenario.id.length === 0) {
    errors.push('id required');
  }
  if (!KERNEL_SCENARIO_KINDS.includes(scenario.kind)) {
    errors.push(`kind must be one of ${KERNEL_SCENARIO_KINDS.join('|')}`);
  }
  if (scenario.proves !== undefined && !strings(scenario.proves)) {
    errors.push('proves must be an array of non-empty obligation ids');
  }
  if (scenario.coverageItems !== undefined && !strings(scenario.coverageItems)) {
    errors.push('coverageItems must be an array of non-empty coverage ids');
  }
  const declared = (scenario.proves?.length ?? 0) + (scenario.coverageItems?.length ?? 0);
  if (declared === 0) {
    errors.push('at least one proves or coverageItems claim is required');
  }
  return errors;
}

export function assertRunnableScenario(scenario) {
  const errors = validateRunnableScenario(scenario);
  if (errors.length > 0) {
    const error = new Error(
      `KERNEL_SCENARIO_INVALID: ${scenario?.id ?? scenario?.defectId ?? '<anonymous>'}\n  ${errors.join('\n  ')}`,
    );
    error.code = 'KERNEL_SCENARIO_INVALID';
    error.errors = errors;
    throw error;
  }
  return scenario;
}

function assertProofModeHonesty(proofModes, workerSpawn) {
  if (!strings(proofModes) || proofModes.length === 0) {
    throw new Error('SCENARIO_RUNNER_PROOF_MODES_REQUIRED');
  }
  if (proofModes.includes('FaultSchedule')) {
    throw new Error(
      'SCENARIO_RUNNER_FAULT_SCHEDULER_NOT_LANDED: K4 must own FaultSchedule execution',
    );
  }
  if (workerSpawn) {
    if (!proofModes.includes('CanonicalSpawn')) {
      throw new Error('SCENARIO_RUNNER_MODE_MISMATCH: workerSpawn requires CanonicalSpawn');
    }
    if (proofModes.includes('CanonicalFast')) {
      throw new Error('SCENARIO_RUNNER_MODE_MISMATCH: one run cannot be both CanonicalFast and CanonicalSpawn');
    }
    return;
  }
  if (!proofModes.includes('CanonicalFast')) {
    throw new Error('SCENARIO_RUNNER_MODE_MISMATCH: in-process cognition requires CanonicalFast');
  }
  if (proofModes.includes('CanonicalSpawn')) {
    throw new Error('SCENARIO_RUNNER_MODE_MISMATCH: CanonicalSpawn requires workerSpawn');
  }
}

function assertDriveOptions(options) {
  for (const key of RESERVED_DRIVE_KEYS) {
    if (Object.hasOwn(options ?? {}, key)) {
      throw new Error(
        `SCENARIO_RUNNER_RESERVED_DRIVE_KEY: '${key}' is owned by the runner`,
      );
    }
  }
}

function observerEvidence(observer) {
  return {
    kind: 'scripted-observer-summary',
    invocationCount: observer?.getInvocationCount?.() ?? null,
    replayCount: observer?.getReplayCount?.() ?? null,
    maxConcurrency: observer?.getMaxConcurrency?.() ?? null,
    activeAtObservation: observer?.getActive?.() ?? null,
    outcomeCount: observer?.getOutcomes?.().length ?? null,
  };
}

async function evaluateOracle(oracle, context, index) {
  if (!oracle || typeof oracle !== 'object' || typeof oracle.id !== 'string'
    || oracle.id.length === 0 || typeof oracle.evaluate !== 'function') {
    throw new Error(`SCENARIO_RUNNER_ORACLE_INVALID: oracle ${index}`);
  }
  try {
    const result = await oracle.evaluate(context);
    if (typeof result === 'boolean') {
      return { id: oracle.id, passed: result, evidenceRefs: [], details: null };
    }
    if (!result || typeof result.passed !== 'boolean') {
      throw new Error('oracle must return boolean or {passed:boolean,...}');
    }
    return {
      id: oracle.id,
      passed: result.passed,
      evidenceRefs: Array.isArray(result.evidenceRefs) ? result.evidenceRefs : [],
      details: result.details ?? null,
    };
  } catch (error) {
    return {
      id: oracle.id,
      passed: false,
      evidenceRefs: [],
      details: {
        oracleError: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function terminalEvidence(result) {
  return {
    reachedTerminal: result?.reachedTerminal ?? null,
    terminalReason: result?.terminalReason ?? null,
    cycles: result?.cycles ?? null,
    stoppedByCycleBound: result?.stoppedByCycleBound ?? null,
    strandedActiveExecutions: result?.strandedActiveExecutions ?? null,
    effectiveConcurrency: result?.effectiveConcurrency ?? null,
    scriptedInvocationCount: result?.scriptedInvocationCount ?? null,
  };
}

/**
 * Execute one scenario through the real canonical Factory composition.
 *
 * Dependencies are injectable only for contract-level self-tests. Normal
 * callers omit them and therefore use canonical-proof-composition + the real
 * read-only trace observer.
 */
export async function runScenario(input, dependencies = {}) {
  const scenario = assertRunnableScenario(input?.scenario);
  const bootstrap = input?.bootstrap;
  if (!bootstrap?.dbPath || !bootstrap?.repoPath || !bootstrap?.sagaRepoRoot) {
    throw new Error('SCENARIO_RUNNER_BOOTSTRAP_REQUIRED');
  }
  assertProofModeHonesty(input.proofModes, input.workerSpawn);
  assertDriveOptions(input.driveOptions);

  if (input.assertCleanBootstrap !== false) {
    bootstrap.assertNoAuthorityWritesYet?.();
  }

  const canonical = dependencies.canonical
    ?? await import('./canonical-proof-composition.mjs');
  const traceApi = dependencies.traceApi
    ?? await import('./trace-observer.mjs');

  const observer = input.observer ?? canonical.createScriptedObserver();
  const composition = canonical.buildCanonicalProofComposition({
    observer,
    repoPath: bootstrap.repoPath,
    sagaRepoRoot: bootstrap.sagaRepoRoot,
    handlers: input.handlers,
    crashPoint: input.crashPoint,
    workerSpawn: input.workerSpawn,
    deliveryProviders: input.deliveryProviders,
  });

  const driven = await canonical.driveCanonicalProof({
    bootstrap,
    composition,
    ...(input.driveOptions ?? {}),
    scriptedObserver: observer,
  });

  const durableTrace = traceApi.observeDurableTrace(bootstrap.dbPath);
  const progress = traceApi.classifyPostDrainProgress(durableTrace);
  const oracleContext = Object.freeze({
    scenario,
    bootstrap,
    result: driven.result,
    identity: driven.identity,
    fingerprint: driven.fingerprint,
    durableTrace,
    progress,
    observer,
  });

  const oracleResults = [{
    id: 'kernel.post-drain-progress',
    passed: progress.ok,
    evidenceRefs: progress.stalls.map(stall => `workplace:${stall.workplace}`),
    details: progress.ok
      ? { classifications: progress.rows.length }
      : { stalls: progress.stalls },
  }];
  for (const [index, oracle] of (input.oracles ?? []).entries()) {
    oracleResults.push(await evaluateOracle(oracle, oracleContext, index));
  }

  return buildScenarioEvidenceBundle({
    scenario,
    proofModes: input.proofModes,
    fingerprint: driven.fingerprint,
    identity: driven.identity,
    durableTrace,
    progress,
    actorEvidence: [
      observerEvidence(observer),
      ...(Array.isArray(input.actorEvidence) ? input.actorEvidence : []),
    ],
    faultJournal: input.faultJournal ?? [],
    externalWorldJournal: input.externalWorldJournal ?? [],
    oracleResults,
    terminal: terminalEvidence(driven.result),
    mutationCoverage: input.mutationCoverage ?? null,
    counterexample: input.counterexample ?? null,
  });
}
