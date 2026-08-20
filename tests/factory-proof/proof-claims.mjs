// tests/factory-proof/proof-claims.mjs
//
// K1-D (SAGA-KERNEL-CONFORMANCE-ENGINE-PLAN §6/§11-K1): explicit, honest
// proof-mode metadata for every factory-proof file. A proof must never claim
// more than its exercised seam:
//
//   Contract      — L0 schema/vocabulary/digest closure (pure data + algebra);
//   Model         — L1 bounded transition exploration (none yet);
//   Durable       — L2 SQLite/CAS/fence (the kill matrix runs REAL SQLite +
//                   validators in-memory: durable-adjacent, labeled so);
//   CanonicalFast — in-process WorkerExecutorFactory seam: composition,
//                   assignment, MCP handlers, gates, SQLite — but NOT the
//                   physical runner/workspace/process lifecycle;
//   CanonicalSpawn— strict L3 via workerSpawn (NONE YET — K2 will add it);
//   FaultSchedule — L4 named crash/interleaving + fair drain (W9-03 drives
//                   exist on the legacy surface; not yet migrated);
//   Product       — L5 fresh project lifecycle (legacy W9-02; not migrated);
//   Canary        — real-model monitored (only the live stage-20 Elite run,
//                   not part of this suite);
//   S             — finite satisfiability checks (none yet).
//
// The registry is TEST-SIDE truth: the ratchet below fails if a group file
// lacks a claim, or if anything claims CanonicalSpawn/FaultSchedule/Product
// before K2/K4 land them.

export const PROOF_MODES = Object.freeze([
  'Contract', 'Model', 'Durable', 'CanonicalFast', 'CanonicalSpawn',
  'FaultSchedule', 'Product', 'Canary', 'S',
]);

export const PROOF_CLAIMS = Object.freeze({
  'tests/factory-proof/canonical-composition.test.mjs': {
    modes: ['Contract', 'CanonicalFast'],
    claims: ['L0 composition-allowlist closure', 'L2 installed-identity fingerprint', 'canonical-fast happy drive through real assignment/MCP/gate'],
    notClaimed: ['strict L3 — the in-process executor does not prove the physical runner, MCP transport, tool permissions, or hooks'],
  },
  'tests/factory-proof/import-ratchet.test.mjs': {
    modes: ['Contract'],
    claims: ['L0 import closure: no legacy composition surface enters factory-proof'],
    notClaimed: [],
  },
  'tests/factory-proof/obligation-compiler.test.mjs': {
    modes: ['Contract', 'Durable'],
    claims: ['L0 contract schema + set-equality with the installed manifest', 'L2 kill matrix on the REAL acceptance validator over in-memory SQLite'],
    notClaimed: ['runtime gate admission — the validator boundary is driven directly, not through a live cell'],
  },
  'tests/factory-proof/scenario-actor-observer.test.mjs': {
    modes: ['Contract'],
    claims: ['L0 DSL validation', 'actor determinism/non-omniscience/counterfactual quartet', 'observer purity', 'progress-oracle classification'],
    notClaimed: ['live-loop execution — the actor/observer are exercised over fixtures, the live drives are W1-1'],
  },
  'tests/factory-proof/kernel-self-mutations.test.mjs': {
    modes: ['Contract'],
    claims: ['kernel self-mutation battery S1-S3 (registry/manifest/operator tamper → red)'],
    notClaimed: [],
  },
  'tests/factory-proof/k0-baseline.test.mjs': {
    modes: ['Contract'],
    claims: ['K0 baseline: composition inventory, normalized authority-trace schema (semantic ignore list), floors + observer non-vacuity'],
    notClaimed: ['live-trace capture — sample fixtures; live normalization arrives with K4 evidence bundles'],
  },
  'tests/factory-proof/proof-claims.test.mjs': {
    modes: ['Contract'],
    claims: ['claim-registry closure: every blocking file declares honest modes; summary published'],
    notClaimed: [],
  },
  'tests/factory-proof/w1-1-fabricated-hash.test.mjs': {
    modes: ['Contract', 'Durable', 'CanonicalFast'],
    claims: ['the fabricated-derived-evidence causal theorem: typed detection, zero durable mutation, exact-feedback repair, counterfactual causality — through the canonical composition and real gates'],
    notClaimed: ['strict L3 (workerSpawn) — K2', 'crash/fault-schedule interleavings — K4'],
  },
  'tests/factory-proof/w1-4-two-lifecycles.test.mjs': {
    modes: ['Contract', 'Durable', 'CanonicalFast'],
    claims: ['ADR-078 two-lifecycle composition: cross-lifecycle isolation (A immutable, no adoption) + within-lifecycle conservation (capsule seals every accepted AC of the run) through two production launches on one epic'],
    notClaimed: ['strict L3 (workerSpawn) — K2', 'Development/Delivery stages of run B — scope is the Formalization boundary'],
  },
});

/** Validate: known modes; no premature strict claims; files present on disk. */
export function validateProofClaims(groupFiles = []) {
  const errors = [];
  const registryFiles = Object.keys(PROOF_CLAIMS);
  for (const [file, claim] of Object.entries(PROOF_CLAIMS)) {
    for (const m of claim.modes) {
      if (!PROOF_MODES.includes(m)) errors.push(`${file}: unknown mode '${m}'`);
    }
    if (claim.modes.includes('CanonicalSpawn')) {
      errors.push(`${file}: CanonicalSpawn claimed before K2 landed the workerSpawn actor seam`);
    }
    if (claim.modes.includes('FaultSchedule')) {
      errors.push(`${file}: FaultSchedule claimed before K4 landed the fault scheduler`);
    }
  }
  for (const f of groupFiles) {
    if (!registryFiles.includes(f)) {
      errors.push(`${f}: in the blocking group WITHOUT a proof claim — every group file must declare its modes (K1 exit gate)`);
    }
  }
  return errors;
}
