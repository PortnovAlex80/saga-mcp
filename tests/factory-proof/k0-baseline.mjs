// tests/factory-proof/k0-baseline.mjs
//
// K0 (SAGA-KERNEL-CONFORMANCE-ENGINE-PLAN §11-K0) — the pre-cutover baseline:
//
//   K0-A composition inventory — every Factory test-composition surface and
//        its override surface, machine-readable (the ADR-085 cutover plan
//        consumes it; a NEW surface appearing without registration is red);
//   K0-B normalized authority-trace schema — the shared trace vocabulary:
//        normalizeTrace() canonicalizes an observer snapshot with the
//        semantic ignore list (generated IDs, timestamps, absolute paths,
//        DB row ids) so base/candidate revisions (ADR-085 P3) compare by
//        digest, not by incidental bytes;
//   K0-C floors — the recorded scenario/edge/mutation floors + quarantine
//        status of the K0 baseline (ratchets: shrinking is a deliberate act);
//   K0-D non-vacuity hooks — traceDigest() changes when any evidence class
//        mutates (pinned by the test, not trusted).

import { createHash } from 'node:crypto';

const sha = v => createHash('sha256').update(JSON.stringify(v), 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// K0-A — the composition inventory (test-side truth; update in the SAME
// commit that adds or retires a surface).
// ---------------------------------------------------------------------------

export const COMPOSITION_SURFACES = Object.freeze([
  {
    id: 'factory-proof/canonical',
    path: 'tests/factory-proof/canonical-proof-composition.mjs',
    driver: 'src/factory-e2e/fresh-harness.ts (production, in-process)',
    overrideSurface: ['workerExecutorFactory', 'resolveWorkerContext', 'delivery.providers'],
    status: 'canonical — the ONLY entrypoint for new causal proofs (W0-1)',
  },
  {
    id: 'legacy/factory-contract/scenario-composition',
    path: 'tests/factory-contract/scenario-composition.mjs',
    driver: 'orchestrate-cli child + spawn scenario-dispatcher',
    overrideSurface: ['workerExecutorFactory (spawn)', 'resolveWorkerContext', 'delivery providers', 'Reference policy mirrors'],
    status: 'migration debt — see tests/factory-proof/MIGRATION-MAP.md; new imports forbidden by ratchet',
  },
  {
    id: 'legacy/factory-temporal/temporal-composition',
    path: 'tests/factory-temporal/lib/temporal-composition.mjs',
    driver: 'orchestrate-cli child',
    overrideSurface: ['workerExecutorFactory (pluggable)', 'delivery providers', 'Reference policy mirrors'],
    status: 'migration debt — whole suite quarantined FLAKY; obligations migrate via W0-2 registry',
  },
  {
    id: 'legacy/factory-e2e/harness-composition',
    path: 'tests/factory-e2e/harness-composition.mjs',
    driver: 'src/factory-e2e/fresh-harness.ts (production, in-process)',
    overrideSurface: ['workerExecutorFactory (in-process)', 'resolveWorkerContext', 'delivery providers', 'Reference policy mirrors'],
    status: 'migration debt — W9-01..06 drives re-home onto the canonical adapter one by one',
  },
]);

// ---------------------------------------------------------------------------
// K0-B — the normalized authority-trace schema.
// ---------------------------------------------------------------------------

/** Semantic ignore list (K0 exit gate): exactly these value classes may
 *  differ between semantically equal traces. */
export const TRACE_SEMANTIC_IGNORE = Object.freeze({
  fields: ['observedAt', 'updated_at', 'decided_at', 'sealed_at', 'started_at', 'created_at', 'accepted_at'],
  transforms: {
    // absolute paths → repo-relative markers (machine-local layout ignored)
    path: v => (typeof v === 'string' ? v.replace(/^file:\/\/\/?/, '').replace(/^[A-Za-z]:[^"']*[\\/]saga-mcp(-w02)?[\\/]/, '<repo>/') : v),
    // DB row ids are per-fixture; identity rides on refs and keys
    rowIdFields: ['id', 'task_id', 'process_run_id', 'artifact_id'],
  },
});

/**
 * Normalize one observer snapshot (from trace-observer.mjs observeDurableTrace):
 * drop ignored timestamp fields, apply the path transform, sort arrays by
 * stable keys — the result is byte-stable for semantically equal traces and
 * changes for ANY semantic mutation (non-vacuity pinned in the test).
 */
export function normalizeTrace(trace) {
  const ignore = new Set(TRACE_SEMANTIC_IGNORE.fields);
  const pathize = TRACE_SEMANTIC_IGNORE.transforms.path;
  const normValue = v => {
    if (Array.isArray(v)) return v.map(normValue);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) {
        if (ignore.has(k)) continue;
        out[k] = typeof val === 'string' ? pathize(val) : normValue(val);
      }
      return out;
    }
    return typeof v === 'string' ? pathize(v) : v;
  };
  const normalized = {};
  for (const [key, value] of Object.entries(trace).sort(([a], [b]) => a.localeCompare(b))) {
    if (ignore.has(key)) continue;
    normalized[key] = normValue(value);
  }
  return normalized;
}

/** Deterministic digest of a normalized trace (the ADR-085 P3 diff key). */
export function traceDigest(trace) {
  return sha(normalizeTrace(trace));
}

// ---------------------------------------------------------------------------
// K0-C — recorded floors of THIS baseline (update deliberately, same commit
// as the change that moves them).
// ---------------------------------------------------------------------------

export const K0_FLOORS = Object.freeze({
  blockingFactoryProofFiles: 7,
  obligationContracts: 34,
  installedProtections: 33,
  mutationOperators: { structural: 7, relational: 21 },
  outcomeEdgeCoverage: { traced: 8, pending: 3, total: 11 },
  fullSuiteBaseline: { tests: 4217, fail: 0, note: 'c5f7f7aa (post-merge repair)' },
  quarantine: { flaky: 8, preExistingRed: 3 },
});

export function assertFloors(current) {
  const errors = [];
  for (const key of Object.keys(K0_FLOORS)) {
    if (!(key in current)) errors.push(`floor '${key}' not reported`);
  }
  return errors;
}
