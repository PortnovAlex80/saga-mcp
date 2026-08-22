// tests/factory-proof/scenario-evidence.mjs
//
// Unified immutable evidence contract for the Saga conformance kernel.
//
// The bundle is deliberately TEST-SIDE evidence, never transition authority.
// It binds one validated scenario to the exact canonical composition/install
// fingerprint, read-only durable trace, actor/fault journals and independent
// oracle results. The digest excludes incidental wall-clock observation bytes
// by hashing the K0-normalized trace rather than the raw observer snapshot.

import { createHash } from 'node:crypto';
import { normalizeTrace, traceDigest } from './k0-baseline.mjs';

export const SCENARIO_EVIDENCE_SCHEMA_VERSION
  = 'factory.proof.scenario-evidence-bundle.v1';

const sha = value => createHash('sha256')
  .update(JSON.stringify(stable(value)), 'utf8')
  .digest('hex');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function nonEmptyStrings(values, field) {
  if (!Array.isArray(values) || values.length === 0
    || values.some(v => typeof v !== 'string' || v.length === 0)) {
    throw new Error(`SCENARIO_EVIDENCE_${field.toUpperCase()}_REQUIRED`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`SCENARIO_EVIDENCE_${field.toUpperCase()}_DUPLICATE`);
  }
  return [...values];
}

function normalizeOracleResult(result, index) {
  if (!result || typeof result !== 'object') {
    throw new Error(`SCENARIO_EVIDENCE_ORACLE_INVALID: result ${index} must be an object`);
  }
  if (typeof result.id !== 'string' || result.id.length === 0) {
    throw new Error(`SCENARIO_EVIDENCE_ORACLE_ID_REQUIRED: result ${index}`);
  }
  if (typeof result.passed !== 'boolean') {
    throw new Error(`SCENARIO_EVIDENCE_ORACLE_VERDICT_REQUIRED: ${result.id}`);
  }
  return {
    id: result.id,
    passed: result.passed,
    evidenceRefs: Array.isArray(result.evidenceRefs)
      ? result.evidenceRefs.map(String)
      : [],
    details: result.details ?? null,
  };
}

function deriveVerdict(oracleResults, progress) {
  if (progress?.ok === false) return 'fail';
  if (oracleResults.some(result => result.passed === false)) return 'fail';
  if (oracleResults.length === 0) return 'inconclusive';
  return 'pass';
}

/**
 * Build one deterministic ScenarioEvidenceBundle.
 *
 * Required inputs are facts produced by the real canonical drive and the
 * read-only observer. No expected production transition is synthesized here.
 */
export function buildScenarioEvidenceBundle(input) {
  if (!input?.scenario || typeof input.scenario !== 'object') {
    throw new Error('SCENARIO_EVIDENCE_SCENARIO_REQUIRED');
  }
  if (!input?.fingerprint?.fingerprint) {
    throw new Error('SCENARIO_EVIDENCE_COMPOSITION_FINGERPRINT_REQUIRED');
  }
  if (!input?.identity || typeof input.identity !== 'object') {
    throw new Error('SCENARIO_EVIDENCE_INSTALLATION_IDENTITY_REQUIRED');
  }
  if (!input?.durableTrace || typeof input.durableTrace !== 'object') {
    throw new Error('SCENARIO_EVIDENCE_DURABLE_TRACE_REQUIRED');
  }

  const proofModes = nonEmptyStrings(input.proofModes, 'proof_modes');
  const normalizedTrace = normalizeTrace(input.durableTrace);
  const oracleResults = (input.oracleResults ?? []).map(normalizeOracleResult);
  const progress = input.progress ?? null;
  const verdict = input.verdict ?? deriveVerdict(oracleResults, progress);
  if (!['pass', 'fail', 'inconclusive'].includes(verdict)) {
    throw new Error(`SCENARIO_EVIDENCE_VERDICT_INVALID: ${String(verdict)}`);
  }

  const scenario = {
    id: String(input.scenario.defectId ?? input.scenario.id ?? '<anonymous>'),
    // Hash the COMPLETE declarative scenario, not only the causal-fault subset.
    // This keeps positive KernelScenario coverage/expectation changes bound to
    // different evidence and prevents later DSL fields from becoming invisible.
    digest: sha(input.scenario),
    kind: input.scenario.kind ?? (input.scenario.defectId ? 'causal-fault' : null),
    faultClass: input.scenario.faultClass ?? null,
    proves: Array.isArray(input.scenario.proves) ? [...input.scenario.proves] : [],
    injectionBoundary: input.scenario.injection?.boundary ?? null,
    detectorRef: input.scenario.expected?.detectorRef ?? null,
    repairOwner: input.scenario.expected?.repairOwner ?? null,
    counterfactualFeedback: Array.isArray(input.scenario.counterfactualFeedback)
      ? [...input.scenario.counterfactualFeedback]
      : [],
    coverageItems: Array.isArray(input.scenario.coverageItems)
      ? [...input.scenario.coverageItems]
      : [],
  };

  const composition = {
    fingerprint: String(input.fingerprint.fingerprint),
    overlayKeys: Array.isArray(input.fingerprint.overlayKeys)
      ? [...input.fingerprint.overlayKeys]
      : [],
    sections: input.fingerprint.sections ?? {},
  };
  const installationFingerprint = sha(input.identity);

  const actorEvidence = Array.isArray(input.actorEvidence)
    ? structuredClone(input.actorEvidence)
    : [];
  const faultJournal = Array.isArray(input.faultJournal)
    ? structuredClone(input.faultJournal)
    : [];
  const externalWorldJournal = Array.isArray(input.externalWorldJournal)
    ? structuredClone(input.externalWorldJournal)
    : [];

  const deterministicBody = {
    schemaVersion: SCENARIO_EVIDENCE_SCHEMA_VERSION,
    scenario,
    proofModes,
    composition,
    installationFingerprint,
    durableTraceDigest: traceDigest(input.durableTrace),
    normalizedTrace,
    progress,
    actorEvidence,
    faultJournal,
    externalWorldJournal,
    oracleResults,
    verdict,
    terminal: input.terminal ?? null,
    mutationCoverage: input.mutationCoverage ?? null,
    counterexample: input.counterexample ?? null,
  };

  const bundle = {
    ...deterministicBody,
    // Raw trace is retained for forensic drill-down but deliberately excluded
    // from bundleDigest; observedAt and equivalent incidental bytes are not
    // semantic evidence. normalizedTrace + durableTraceDigest are the proof key.
    rawDurableTrace: structuredClone(input.durableTrace),
    bundleDigest: sha(deterministicBody),
  };
  return deepFreeze(bundle);
}

/** Validate an already-built bundle without recomputing production facts. */
export function validateScenarioEvidenceBundle(bundle) {
  const errors = [];
  if (!bundle || typeof bundle !== 'object') return ['bundle must be an object'];
  if (bundle.schemaVersion !== SCENARIO_EVIDENCE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCENARIO_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (!bundle.scenario?.id || !/^[0-9a-f]{64}$/.test(bundle.scenario?.digest ?? '')) {
    errors.push('scenario id+digest required');
  }
  if (!Array.isArray(bundle.proofModes) || bundle.proofModes.length === 0) {
    errors.push('proofModes required');
  }
  if (!/^[0-9a-f]{64}$/.test(bundle.composition?.fingerprint ?? '')) {
    errors.push('composition fingerprint must be sha256 hex');
  }
  if (!/^[0-9a-f]{64}$/.test(bundle.installationFingerprint ?? '')) {
    errors.push('installation fingerprint must be sha256 hex');
  }
  if (!/^[0-9a-f]{64}$/.test(bundle.durableTraceDigest ?? '')) {
    errors.push('durableTraceDigest must be sha256 hex');
  }
  if (!['pass', 'fail', 'inconclusive'].includes(bundle.verdict)) {
    errors.push('verdict must be pass|fail|inconclusive');
  }
  if (!/^[0-9a-f]{64}$/.test(bundle.bundleDigest ?? '')) {
    errors.push('bundleDigest must be sha256 hex');
  }
  return errors;
}

export { sha as evidenceDigest };
