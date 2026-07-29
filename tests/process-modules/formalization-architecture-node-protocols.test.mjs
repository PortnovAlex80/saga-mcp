// tests/process-modules/formalization-architecture-node-protocols.test.mjs
//
// W8-A5 — Architecture + recovery node protocols + package-local resources.
//
// Spec: docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md
//       lane W8-A5.
// Plan: §0.11.6 (architecture + recovery node protocols + package-local
//       resources), §8.2 (NodeProtocol), §3.5 (canonical-serializable), §5.5.1
//       (resources resolved under package root).
// Wave 4 contract: docs/refactor-management/09-contracts/WAVE4-PROTOCOL-RECOVERY-SPEC.md
//       (RecoveryIssue → RecoveryAction → RecoveryFeedback).
//
// Coverage:
//   - Every architecture-lane NodeProtocolDefinition is structurally valid
//     (validateArchitectureLaneProtocols + the per-protocol Wave 1 validator).
//   - Owning Flow node ids match the formalization Flow declarations.
//   - The SRS LM node gates completion on the architecture kernel gate
//     (module-verifier-receipt) — the WHAT/HOW cutover cannot complete
//     without it.
//   - The resolver twin re-reads exact provenance (no authoring tools).
//   - The recovery protocol mirrors the Flow-level repair binding: trigger
//     events, resolved events, acceptance criteria, and the escalate
//     on-exhausted policy.
//   - Package-local resources: unique logicalIds, known kinds, package-relative
//     POSIX paths (no absolute / traversal — plan §5.5.1), every protocol
//     resource reference resolves to a declared entry.
//   - Round-trip: every protocol is canonical-serializable (digest stability).
//   - Ratchet: the architecture lane owns the post-baseline surface
//     (baseline-freezer + architecture + resolver + recovery) and nothing
//     outside it.

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  ARCHITECTURE_NODE_PROTOCOL,
  ARCHITECTURE_RESOLVER_NODE_PROTOCOL,
  ARCHITECTURE_BASELINE_FREEZER_NODE_PROTOCOL,
  ARCHITECTURE_RECOVERY_NODE_PROTOCOL,
  ARCHITECTURE_LANE_NODE_PROTOCOLS,
  ARCHITECTURE_RESOURCE_ENTRIES,
  ARCHITECTURE_RESOURCE_IDS,
  ARCHITECTURE_CONTRACT_REFS,
  ARCHITECTURE_RECOVERY_BINDING_ID,
  ARCHITECTURE_RECOVERY_POLICY,
  ARCHITECTURE_RECOVERY_ACCEPTANCE_CRITERIA,
  ARCHITECTURE_RECOVERY_TRIGGER_EVENTS,
  ARCHITECTURE_RECOVERY_RESOLVED_EVENTS,
  validateArchitectureLaneProtocols,
} = await import(
  '../../dist/process-modules/modules/formalization/package/nodes/architecture/index.js'
);

const { validateNodeProtocolDefinition } = await import(
  '../../dist/process-modules/domain/spi/node-protocol.js'
);
const { RESOURCE_KINDS } = await import(
  '../../dist/process-modules/domain/spi/resource-index.js'
);
const { canonicalJson, sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);

// ---------------------------------------------------------------------------
// Flow node ids the architecture lane owns (mirrors formalization-process-module.ts).
// ---------------------------------------------------------------------------

const FLOW_NODE_IDS = Object.freeze({
  baselineFreezer: 'freeze-acceptance-baseline',
  architecture: 'define-architecture-contract',
  resolver: 'resolve-architecture-contract',
});

// ---------------------------------------------------------------------------
// 1. Structural validity — every protocol passes the Wave 1 validator.
// ---------------------------------------------------------------------------

test('validateArchitectureLaneProtocols reports the lane is structurally valid', () => {
  const result = validateArchitectureLaneProtocols();
  assert.equal(result.ok, true, `expected ok, got errors: ${JSON.stringify(result.errors)}`);
  assert.equal(result.errors.length, 0);
});

test('each architecture-lane protocol independently passes validateNodeProtocolDefinition', () => {
  for (const proto of ARCHITECTURE_LANE_NODE_PROTOCOLS) {
    const result = validateNodeProtocolDefinition(proto);
    assert.equal(result.ok, true, `${proto.id}: ${JSON.stringify(result.errors)}`);
  }
});

test('the lane owns exactly four protocols covering the post-baseline surface', () => {
  assert.equal(ARCHITECTURE_LANE_NODE_PROTOCOLS.length, 4);
  const ids = ARCHITECTURE_LANE_NODE_PROTOCOLS.map(p => p.id).sort();
  assert.deepEqual(ids, [
    'formalization.architecture.freeze-acceptance-baseline',
    'formalization.architecture.define-architecture-contract',
    'formalization.architecture.repair-architecture-contract',
    'formalization.architecture.resolve-architecture-contract',
  ].sort());
});

// ---------------------------------------------------------------------------
// 2. Owning Flow node correlation.
// ---------------------------------------------------------------------------

test('each protocol owns its declared Flow node id', () => {
  assert.equal(ARCHITECTURE_NODE_PROTOCOL.owningFlowNodeId, FLOW_NODE_IDS.architecture);
  assert.equal(ARCHITECTURE_RESOLVER_NODE_PROTOCOL.owningFlowNodeId, FLOW_NODE_IDS.resolver);
  assert.equal(
    ARCHITECTURE_BASELINE_FREEZER_NODE_PROTOCOL.owningFlowNodeId,
    FLOW_NODE_IDS.baselineFreezer,
  );
  // The recovery protocol owns the Flow-level repair binding id, not a Flow
  // node — the runtime materializes a synthetic recovery node.
  assert.equal(
    ARCHITECTURE_RECOVERY_NODE_PROTOCOL.owningFlowNodeId,
    ARCHITECTURE_RECOVERY_BINDING_ID,
  );
});

test('no two architecture-lane protocols own the same Flow node id', () => {
  const owners = [
    ARCHITECTURE_NODE_PROTOCOL,
    ARCHITECTURE_RESOLVER_NODE_PROTOCOL,
    ARCHITECTURE_BASELINE_FREEZER_NODE_PROTOCOL,
  ].map(p => p.owningFlowNodeId);
  assert.equal(new Set(owners).size, owners.length);
});

// ---------------------------------------------------------------------------
// 3. The SRS LM node gates completion on the architecture kernel gate.
// ---------------------------------------------------------------------------

test('the architecture LM node requires the module-verifier-receipt at completion', () => {
  const completion = ARCHITECTURE_NODE_PROTOCOL.nodeCompletionEvidence;
  const verifierReceipt = completion.find(
    e => e.category === 'module-verifier-receipt' && e.required,
  );
  assert.ok(verifierReceipt, 'architecture node must gate completion on a module-verifier-receipt');
  assert.equal(
    verifierReceipt.contractRef.schemaId,
    ARCHITECTURE_CONTRACT_REFS.architectureGate.schemaId,
  );
});

test('the architecture LM node also requires the canonical SRS artifact reference at completion', () => {
  const completion = ARCHITECTURE_NODE_PROTOCOL.nodeCompletionEvidence;
  const srsRef = completion.find(
    e => e.category === 'artifact-reference' &&
      e.contractRef.schemaId === ARCHITECTURE_CONTRACT_REFS.srs.schemaId,
  );
  assert.ok(srsRef, 'architecture node must record the canonical SRS artifact reference');
});

test('the architecture LM node entry step accepts the frozen work intent first', () => {
  assert.equal(ARCHITECTURE_NODE_PROTOCOL.entryStep, 'accept-work-intent');
  const entry = ARCHITECTURE_NODE_PROTOCOL.steps.find(s => s.id === 'accept-work-intent');
  assert.ok(entry);
  // The entry step requires the frozen baseline artifact reference.
  const baseline = entry.evidenceRequirements.find(
    e => e.contractRef.schemaId === ARCHITECTURE_CONTRACT_REFS.acceptanceBaseline.schemaId,
  );
  assert.ok(baseline, 'entry step must consume the frozen acceptance baseline');
});

test('the architecture LM node uses linear retry semantics (matches the execution profile)', () => {
  assert.equal(ARCHITECTURE_NODE_PROTOCOL.retrySemantics, 'runtime-implemented-linear');
});

// ---------------------------------------------------------------------------
// 4. The resolver twin re-reads exact provenance — no authoring tools.
// ---------------------------------------------------------------------------

test('the resolver protocol performs no authoring (no write tools on any step)', () => {
  const WRITE_TOOLS = new Set([
    'artifact_create', 'artifact_update', 'trace_add', 'worker_done',
    'Write', 'Edit', 'Bash',
  ]);
  for (const step of ARCHITECTURE_RESOLVER_NODE_PROTOCOL.steps) {
    for (const tool of step.allowedTools) {
      assert.equal(
        WRITE_TOOLS.has(tool), false,
        `resolver step ${step.id} must not use write tool ${tool}`,
      );
    }
  }
});

test('the resolver protocol gates completion on the architecture gate receipt', () => {
  const completion = ARCHITECTURE_RESOLVER_NODE_PROTOCOL.nodeCompletionEvidence;
  assert.ok(
    completion.some(e => e.category === 'module-verifier-receipt' && e.required),
    'resolver must emit a module-verifier-receipt at completion',
  );
});

test('the baseline-freezer protocol is a single deterministic step with no transitions', () => {
  assert.equal(ARCHITECTURE_BASELINE_FREEZER_NODE_PROTOCOL.steps.length, 1);
  assert.equal(ARCHITECTURE_BASELINE_FREEZER_NODE_PROTOCOL.transitions.length, 0);
  assert.equal(
    ARCHITECTURE_BASELINE_FREEZER_NODE_PROTOCOL.entryStep,
    'compute-baseline',
  );
});

// ---------------------------------------------------------------------------
// 5. The recovery protocol mirrors the Flow-level repair binding.
// ---------------------------------------------------------------------------

test('the recovery protocol binding id matches the Flow-level repair-architecture-contract binding', () => {
  assert.equal(ARCHITECTURE_RECOVERY_BINDING_ID, 'repair-architecture-contract');
});

test('the recovery trigger events mirror the Flow binding (repair-required + acceptance-blocked)', () => {
  assert.deepEqual(
    [...ARCHITECTURE_RECOVERY_TRIGGER_EVENTS].sort(),
    ['domain.acceptance-blocked', 'domain.repair-required'],
  );
});

test('the recovery resolved event mirrors the Flow binding (domain.completed)', () => {
  assert.deepEqual([...ARCHITECTURE_RECOVERY_RESOLVED_EVENTS], ['domain.completed']);
});

test('the recovery policy escalates on exhaustion (matches the architect execution profile)', () => {
  assert.equal(ARCHITECTURE_RECOVERY_POLICY.onExhausted, 'escalate');
  assert.equal(ARCHITECTURE_RECOVERY_POLICY.resumeFromCheckpoint, true);
  assert.equal(ARCHITECTURE_RECOVERY_POLICY.reuseWorkIntent, true);
  assert.equal(ARCHITECTURE_RECOVERY_POLICY.reuseAcceptedOutput, true);
});

test('the recovery acceptance criteria pin the architecture gate invariants', () => {
  // Verbatim from formalization-installation.ts recoverySpec('repair-architecture-contract', ...).
  assert.equal(ARCHITECTURE_RECOVERY_ACCEPTANCE_CRITERIA.length, 3);
  assert.ok(
    ARCHITECTURE_RECOVERY_ACCEPTANCE_CRITERIA.some(c => c.includes('Exactly one SRS') && c.includes('exact PRD')),
    'must require exactly one SRS tracing to the exact PRD',
  );
  assert.ok(
    ARCHITECTURE_RECOVERY_ACCEPTANCE_CRITERIA.some(c => c.includes('baseline') && c.includes('drifted')),
    'must require the baseline has not drifted',
  );
  assert.ok(
    ARCHITECTURE_RECOVERY_ACCEPTANCE_CRITERIA.some(c => c.includes('kernel gate') && c.includes('accepted+clean')),
    'must require the reviewed candidate is accepted+clean by the kernel gate',
  );
});

test('the recovery protocol diagnoses before repairing and re-verifies after', () => {
  const ids = ARCHITECTURE_RECOVERY_NODE_PROTOCOL.steps.map(s => s.id);
  assert.deepEqual(ids, ['diagnose-architecture-issue', 'repair-architecture', 're-verify-architecture']);
  assert.equal(ARCHITECTURE_RECOVERY_NODE_PROTOCOL.entryStep, 'diagnose-architecture-issue');
});

test('the recovery protocol carries the RecoveryIssue receipt as entry evidence', () => {
  const diagnose = ARCHITECTURE_RECOVERY_NODE_PROTOCOL.steps
    .find(s => s.id === 'diagnose-architecture-issue');
  const issue = diagnose.evidenceRequirements.find(
    e => e.contractRef.schemaId === ARCHITECTURE_CONTRACT_REFS.recoveryIssue.schemaId,
  );
  assert.ok(issue, 'diagnose step must consume the durable RecoveryIssue');
});

test('the recovery protocol re-enters at the repair step on crash-resume (Wave 4 §0.7.11)', () => {
  assert.deepEqual(
    [...ARCHITECTURE_RECOVERY_NODE_PROTOCOL.recoveryEntrySteps].sort(),
    ['diagnose-architecture-issue', 'repair-architecture'].sort(),
  );
});

// ---------------------------------------------------------------------------
// 6. Package-local resources.
// ---------------------------------------------------------------------------

const RESOURCE_KIND_SET = new Set(RESOURCE_KINDS);

test('every architecture resource entry has a unique logicalId', () => {
  const ids = ARCHITECTURE_RESOURCE_ENTRIES.map(e => e.logicalId);
  assert.equal(new Set(ids).size, ids.length, `duplicate logicalIds: ${ids.join(', ')}`);
});

test('every architecture resource entry has a known kind', () => {
  for (const entry of ARCHITECTURE_RESOURCE_ENTRIES) {
    assert.ok(
      RESOURCE_KIND_SET.has(entry.kind),
      `unknown resource kind '${entry.kind}' on ${entry.logicalId}`,
    );
  }
});

test('every architecture resource path is package-relative POSIX (no absolute / traversal)', () => {
  for (const entry of ARCHITECTURE_RESOURCE_ENTRIES) {
    assert.ok(
      !entry.path.startsWith('/'),
      `${entry.logicalId}: absolute path forbidden (plan §5.5.1): ${entry.path}`,
    );
    assert.ok(
      !entry.path.includes('..'),
      `${entry.logicalId}: traversal path forbidden (plan §5.5.1): ${entry.path}`,
    );
    assert.ok(
      !entry.path.includes('\\'),
      `${entry.logicalId}: backslash path forbidden (POSIX only): ${entry.path}`,
    );
  }
});

test('every architecture resource entry uses the documented pending digest placeholder', () => {
  for (const entry of ARCHITECTURE_RESOURCE_ENTRIES) {
    assert.equal(
      entry.digest, 'pending@wave-2',
      `${entry.logicalId}: Wave 8 must use the pending digest until Wave 2 hashing lands`,
    );
  }
});

test('every resource referenced by a protocol step resolves to a declared entry', () => {
  const declared = new Set(ARCHITECTURE_RESOURCE_ENTRIES.map(e => e.logicalId));
  for (const proto of ARCHITECTURE_LANE_NODE_PROTOCOLS) {
    for (const step of proto.steps) {
      for (const res of step.resources) {
        assert.ok(
          declared.has(res),
          `${proto.id}/${step.id}: references undeclared resource '${res}'`,
        );
      }
    }
  }
});

test('the resource ids object keys line up 1:1 with the declared entries', () => {
  const declared = new Set(ARCHITECTURE_RESOURCE_ENTRIES.map(e => e.logicalId));
  const referenced = new Set(Object.values(ARCHITECTURE_RESOURCE_IDS));
  // Every declared entry must have an id constant.
  for (const d of declared) {
    assert.ok(referenced.has(d), `declared entry '${d}' has no resource-id constant`);
  }
  // Every id constant must be declared.
  for (const r of referenced) {
    assert.ok(declared.has(r), `id constant '${r}' is not declared in ARCHITECTURE_RESOURCE_ENTRIES`);
  }
});

// ---------------------------------------------------------------------------
// 7. Canonical-serializability + digest stability (plan §3.5).
// ---------------------------------------------------------------------------

test('every architecture protocol round-trips through canonical JSON with a stable digest', () => {
  for (const proto of ARCHITECTURE_LANE_NODE_PROTOCOLS) {
    const a = canonicalJson(proto);
    const b = canonicalJson(JSON.parse(a));
    assert.equal(a, b, `${proto.id}: canonical JSON not idempotent`);
    assert.equal(sha256Hex(proto), sha256Hex(JSON.parse(a)), `${proto.id}: digest unstable across round-trip`);
  }
});

test('the resource index round-trips through canonical JSON with a stable digest', () => {
  const a = canonicalJson(ARCHITECTURE_RESOURCE_ENTRIES);
  const b = canonicalJson(JSON.parse(a));
  assert.equal(a, b);
  assert.equal(
    sha256Hex(ARCHITECTURE_RESOURCE_ENTRIES),
    sha256Hex(JSON.parse(a)),
  );
});

// ---------------------------------------------------------------------------
// 8. Ratchet: the architecture lane owns ONLY the post-baseline surface.
// ---------------------------------------------------------------------------

test('the architecture lane protocols own no product/use-case/acceptance/reconciliation Flow nodes', () => {
  const FORBIDDEN = new Set([
    'define-product-contract', 'resolve-product-contract',
    'model-use-cases', 'resolve-use-cases',
    'define-acceptance-contract', 'resolve-acceptance-contract',
    'reconcile-what', 'resolve-reconciliation',
    'settle-formalization',
  ]);
  for (const proto of ARCHITECTURE_LANE_NODE_PROTOCOLS) {
    assert.ok(
      !FORBIDDEN.has(proto.owningFlowNodeId),
      `${proto.id} must not own a non-architecture Flow node (${proto.owningFlowNodeId})`,
    );
  }
});
