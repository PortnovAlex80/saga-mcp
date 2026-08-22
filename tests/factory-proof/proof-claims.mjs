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
  'tests/factory-proof/k2-spawned-actor.test.mjs': {
    modes: ['Contract', 'Durable', 'CanonicalSpawn'],
    claims: ['K2-A strict seam: a REAL spawned child under the production envelope (argv+stdin prompt+pinned cwd+per-execution --mcp-config), effects through the real saga MCP server; the in-process fast lane is not composed'],
    notClaimed: ['crash/fault-schedule interleavings — K4'],
  },
  'tests/factory-proof/k2-strict-formalization.test.mjs': {
    modes: ['Durable', 'CanonicalSpawn'],
    claims: ['the STRICT L3 formalization vertical: every cell through spawned children (positive → formalized, capsule sealed); the fabricated-hash causal theorem on real processes — typed intake rejection, repair ONLY under exact feedback (exact → accepted; absent/stale/corrupt → bounded stasis park, never a terminal death); the no-mcp-config envelope negative fails BEFORE any handler'],
    notClaimed: ['FaultSchedule interleavings — K4', 'strict Development/Delivery stages — the corpus stops at the Formalization boundary'],
  },
  'tests/factory-proof/w1-4-two-lifecycles.test.mjs': {
    modes: ['Contract', 'Durable', 'CanonicalFast'],
    claims: ['ADR-078 two-lifecycle composition: cross-lifecycle isolation (A immutable, no adoption) + within-lifecycle conservation (capsule seals every accepted AC of the run) through two production launches on one epic'],
    notClaimed: ['strict L3 (workerSpawn) — K2', 'Development/Delivery stages of run B — scope is the Formalization boundary'],
  },

  // CC-10A: the Conformance Engine v1 measuring surface. All Contract-level —
  // every execution seam (runScenario drives, multi-phase restart/retry-exhaustion
  // runners with 61s recovery backoffs, harvest) stays OUTSIDE the blocking
  // group until the kernel packages land them.
  'tests/factory-proof/conformance-engine.test.mjs': {
    modes: ['Contract'],
    claims: [
      'the committed evidence snapshot validates: bundles parse, pass schema validation and classify PASS (zero invalid/unparseable)',
      'Discovery and Formalization are 100% DEMONSTRATED from PASS bundles — declarations alone do not close a workshop',
      'blocked obligations stay pending and uncovered (restart:delivery:idempotent-settlement is BLOCKED_BY, never counted covered)',
      'declared and demonstrated stay distinct layers; mutation kill rate stays honestly unmeasured until K3/K4',
    ],
    notClaimed: [
      'committed snapshot only — drives are not re-run here (--harvest is the manual path)',
      'the multi-phase restart/retry-exhaustion proofs are disclosed as special runners, not unified into runScenario',
    ],
  },
  'tests/factory-proof/coverage-kernel.test.mjs': {
    modes: ['Contract'],
    claims: [
      'L0 coverage-token algebra: gates, transitions, negative transitions and transition pairs',
      'scenario dimensions auto-derive obligations, fault taxonomy, injection boundary, detector, repair owner and counterfactuals',
      'exact set cover beats greedy on the adversarial corpus; unreachable required items report infeasible, never rounded green',
      'evidence coverage counts only PASS executions by default (diagnostic mode is explicit)',
    ],
    notClaimed: ['pure set-cover algebra — no composition, no SQLite, no live bundles'],
  },
  'tests/factory-proof/delivery-kernel-unification.test.mjs': {
    modes: ['Contract'],
    claims: [
      'the Delivery drive is a pure consumer of the unified kernel (imports runScenario; no private drive/oracle-evaluate/bundle pipeline)',
      'runScenario threads lifecycleDefinition into buildCanonicalProofComposition',
      'installed-identity fingerprints separate product-build from product-delivery for otherwise-identical inputs (evidence binds to the executed composition)',
    ],
    notClaimed: [
      'no drive executed — source pins plus identity algebra over the installed lifecycle data',
      'strict L3 — not attempted here',
    ],
  },
  'tests/factory-proof/development-scenario-pack.test.mjs': {
    modes: ['Contract'],
    claims: [
      'Development topology inventory matches the installed module declaration (solution-development@1.4.4, 8 nodes, 3 outcomes, continuation variants)',
      'every Development scenario is unique, KernelScenario-valid and runtime-mapped (handlers + oracles + cycle bound)',
      'honest tranche boundary: the D2–D10 pending universe and K4 platform fault edges stay declared — Development closure is NOT claimed',
    ],
    notClaimed: [
      'no live drive — the pack is validated as data; execution lives in development-scenario-drive.mjs',
      'K4 fault edges',
    ],
  },
  'tests/factory-proof/discovery-resilience-pack.test.mjs': {
    modes: ['Contract'],
    claims: [
      '27-scenario Discovery closure pack: unique, KernelScenario-valid, runtime-mapped (the restart specialDrive carries its own runner)',
      'planned closure coverage is exactly 100% and set-cover feasible over the closure universe',
      'every resilience axis is a load-bearing required token (exact-feedback repair, absent/stale/corrupted counterfactuals, bounded crash recovery, retry-exhaustion terminal, duplicate-submit, late-call, fence)',
      'only the settlement internal exception remains K4-owned',
    ],
    notClaimed: [
      'no Factory drive here — the restart/retry-exhaustion special proofs run through the dedicated multi-phase runners in the drives, not in this test',
      'K4 platform fault interleavings',
    ],
  },
  'tests/factory-proof/discovery-scenario-pack.test.mjs': {
    modes: ['Contract'],
    claims: [
      '8-scenario Discovery phase-1 pack: unique, KernelScenario-valid, runtime-mapped with ≥4 oracles each',
      'phase-1 planned coverage is complete and set-cover feasible',
      'full Discovery conformance stays honestly incomplete (recovery/fence/crash tokens uncovered) — phase 1 does not masquerade as closure',
      'positive outcomes prove all three permissive handoffs (go/clarify/reject)',
    ],
    notClaimed: [
      'no Factory drive — runtime execution lives in discovery-coverage-drive.mjs',
      'resilience closure — that is discovery-resilience-pack.test.mjs',
    ],
  },
  'tests/factory-proof/factory-coverage-universe.test.mjs': {
    modes: ['Contract'],
    claims: [
      'the declared universe is deterministic pack-derived data with a monotonic ratchet: landing moves tokens pending→required, they never leave U',
      'CLOSED means set-equality — zero uncovered, zero pending (discovery, formalization); SPINE carries the honest pending ledger',
      'a token is never pending and required at once; the delivery restart stays pending and BLOCKED_BY its upstream',
    ],
    notClaimed: ['DECLARED layer only — closure here proves declarations, not live drives; demonstrated coverage is the conformance engine layer'],
  },
  'tests/factory-proof/formalization-resilience-pack.test.mjs': {
    modes: ['Contract'],
    claims: [
      '26-scenario Formalization closure pack: unique, KernelScenario-valid, runtime-mapped (restart/retry-exhaustion specialDrives carry their own runners)',
      'planned closure coverage is exactly 100% and set-cover feasible',
      'every reviewed Cell carries bounded crash recovery, retry-exhaustion terminal and the complete-failed transition; causal feedback/fence/tool-lifecycle/restart tokens are load-bearing',
      'the five internal kernel/effect timing faults stay explicitly K4-owned',
    ],
    notClaimed: [
      'no Factory drive here — the multi-phase proofs run in the drives, not in this test',
      'K4 timing/effect faults',
    ],
  },
  'tests/factory-proof/scenario-evidence.test.mjs': {
    modes: ['Contract'],
    claims: [
      'evidence bundles are immutable, complete and validate; digests are stable under incidental observation-time changes',
      'a semantic durable-trace mutation moves both the trace digest and the bundle digest',
      'oracle failure or an anonymous stall fails the bundle closed',
    ],
    notClaimed: ['fixture traces only — no live drive, no SQLite'],
  },
  'tests/factory-proof/scenario-runner.test.mjs': {
    modes: ['Contract'],
    claims: [
      'the one generic runner accepts both scenario envelopes and emits the canonical evidence bundle with the progress oracle always appended',
      'anonymous stalls and oracle exceptions are recorded as evidence failures, never invisible crashes',
      'seam honesty is enforced before the drive: CanonicalSpawn without workerSpawn is refused, FaultSchedule is refused (SCENARIO_RUNNER_FAULT_SCHEDULER_NOT_LANDED), reserved drive keys rejected',
    ],
    notClaimed: [
      'composition/trace dependencies are injected test doubles — no real composition, gates or SQLite here',
      'FaultSchedule is REFUSED, not exercised — K4',
      'strict L3 — K2',
    ],
  },
  'tests/factory-proof/workshop-descriptor.test.mjs': {
    modes: ['Contract'],
    claims: [
      'all four installed workshops fit the BuiltInWorkshop target shape (manifest identity + definition identity + flow graph) without a runtime switch',
      'Delivery fits with zero LM execution profiles',
      'the capability inventory is the single global manifest; the reconciliation-report contract is registered exactly once',
    ],
    notClaimed: ['dist characterization only — no source parity, no composition, no runtime cutover'],
  },
  'tests/factory-proof/workshop-inventory.test.mjs': {
    modes: ['Contract'],
    claims: [
      'the inventory covers all four workshops with non-empty declared topologies and a 64-hex digest',
      'the dual root is real: the cross-tree dependency map has edges in both directions (≥20)',
      'NON-VACUITY: node-drop and dependency-hide mutations change the digest — the drift check cannot sleep',
    ],
    notClaimed: ['structural src scan — no dist, no DB, no scenario execution'],
  },
});

/** Validate: known modes; no premature strict claims; claim/group sets equal BOTH ways. */
export function validateProofClaims(groupFiles = []) {
  const errors = [];
  const registryFiles = Object.keys(PROOF_CLAIMS);
  for (const [file, claim] of Object.entries(PROOF_CLAIMS)) {
    for (const m of claim.modes) {
      if (!PROOF_MODES.includes(m)) errors.push(`${file}: unknown mode '${m}'`);
    }
    // K2-B LANDED (this commit): strict spawned-actor scenarios exist and are
    // blocking — CanonicalSpawn is now a CLAIMABLE mode. The floor below stays
    // for modes whose machinery has not landed yet.
    if (claim.modes.includes('FaultSchedule')) {
      errors.push(`${file}: FaultSchedule claimed before K4 landed the fault scheduler`);
    }
  }
  for (const f of groupFiles) {
    if (!registryFiles.includes(f)) {
      errors.push(`${f}: in the blocking group WITHOUT a proof claim — every group file must declare its modes (K1 exit gate)`);
    }
  }
  // CC-10A: bidirectional closure — the registry and the blocking group must be
  // the SAME set. A claim that is not blocking is dead prose; a blocking file
  // without a claim is an honesty hole. Neither may pass silently.
  for (const f of registryFiles) {
    if (!groupFiles.includes(f)) {
      errors.push(`${f}: claimed in the registry but ABSENT from the blocking group — claim/group sets must be exactly equal both ways (CC-10A ratchet)`);
    }
  }
  return errors;
}
