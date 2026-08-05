/**
 * W9-A5 — Delivery flow-node protocols + package-local resources.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md`
 *       lane W9-A5.
 * Task: `docs/refactor-management/05-subagent-tasks/W09-a5.md`.
 * Plan: §0.12 (remaining production module migrations), §8.2 (NodeProtocol).
 *
 * This module owns the `NodeProtocolDefinition`s for the five Flow nodes of
 * the Delivery/Release process module (`delivery-release@1.0.0`):
 *
 *   - `preflight-release`  (kernel)   — deterministic release-guard evidence.
 *   - `approve-release`    (human)    — authorized-decision interaction.
 *   - `publish-deploy`     (external) — desired-state action application.
 *   - `observe-release`    (external) — authoritative target-state read.
 *   - `settle-delivery`    (kernel)   — exact-product + immutability settlement.
 *
 * Node ids, handler ids, adapter ids and schema ids mirror the frozen Delivery
 * Flow in `delivery-process-module.ts` / `delivery-kernel-ports.ts` /
 * `delivery-schemas.ts` VERBATIM — the package does not invent new node
 * identities, it pins the already-contractual ones behind package-local
 * resources (WAVE9 exit gate §2.2: no global resource lookup).
 *
 * Pure canonical data only (plan §3.5): every exported value is a plain,
 * serializable constant. The file imports ONLY pure domain SPI types
 * (`import type`) plus the pure validator (`validateNodeProtocolDefinition`,
 * which itself only imports `shared/canonical-json.ts`). It touches no
 * persistence adapter, no infrastructure, no db.ts — so it introduces zero
 * dependency-direction violations (Rules 1, 2, 5). Resource digests use the
 * documented Wave-2 placeholder; the Wave 2 content-addressed installer fills
 * them at install time, exactly as the manifest envelope does
 * (`PENDING_DIGEST` in `module-manifest.ts`).
 *
 * Anti-scope (WAVE9-PRODUCTION-MIGRATION-SPEC §3): this lane does NOT define
 * the concrete handler/adapter implementations (A6 owns ports + external
 * effects + human approval + idempotency + receipts + contributions), does
 * NOT edit the central Runtime/runner/gateway, and does NOT remove the legacy
 * delivery path (Wave 13). It is additive.
 */

import type {
  NodeProtocolDefinition,
  EvidenceRequirement,
  ValidationResult,
  ValidationError,
} from '../../../../domain/spi/node-protocol.js';
import { validateNodeProtocolDefinition } from '../../../../domain/spi/node-protocol.js';

// ---------------------------------------------------------------------------
// Flow node ids these protocols own (mirror delivery-process-module.ts flow).
// ---------------------------------------------------------------------------

/**
 * The five Flow node ids these protocols own. Mirrors the delivery Flow's
 * `nodes[]` entries exactly. Exported as a frozen constant so downstream lanes
 * (A6) and tests reference the exact strings without re-quoting them.
 *
 * @readonly
 */
export const DELIVERY_NODE_FLOW_IDS = Object.freeze({
  /** Kernel node: deterministic release-guard preflight. */
  preflight: 'preflight-release',
  /** Human node: authorized-decision approval. */
  approval: 'approve-release',
  /** External node: desired-state publish/deploy. */
  publication: 'publish-deploy',
  /** External node: authoritative target-state observation. */
  observation: 'observe-release',
  /** Kernel node: exact-product + immutability settlement. */
  settlement: 'settle-delivery',
} as const);

// ---------------------------------------------------------------------------
// Evidence requirements (plan §8.4 / §8.5). The Runtime understands the
// CATEGORY; the module-specific meaning is enforced by the versioned handler /
// adapter. Contracts use the Wave-2 placeholder digest.
// ---------------------------------------------------------------------------

const EXTERNAL_RECEIPT_EVIDENCE: EvidenceRequirement = Object.freeze({
  category: 'external-receipt',
  contractRef: {
    schemaId: 'factory.evidence.external-receipt.v1',
    version: '1.0.0',
    digest: 'pending@wave-2',
  },
  required: true,
});

const HUMAN_RECEIPT_EVIDENCE: EvidenceRequirement = Object.freeze({
  category: 'human-receipt',
  contractRef: {
    schemaId: 'factory.evidence.human-receipt.v1',
    version: '1.0.0',
    digest: 'pending@wave-2',
  },
  required: true,
});

const MODULE_VERIFIER_RECEIPT_EVIDENCE: EvidenceRequirement = Object.freeze({
  category: 'module-verifier-receipt',
  contractRef: {
    schemaId: 'factory.evidence.module-verifier-receipt.v1',
    version: '1.0.0',
    digest: 'pending@wave-2',
  },
  required: true,
});

// ---------------------------------------------------------------------------
// Resource logical ids referenced by the protocol steps below. Each id is
// pinned by exactly one entry in the central manifest's resourceIndex
// (manifest.ts DELIVERY_RESOURCE_INDEX). Keeping them in one frozen object
// prevents the protocol steps and the resource index from drifting apart.
// ---------------------------------------------------------------------------

const RESOURCE_IDS = Object.freeze({
  preflightInstructions: 'delivery.instruction.preflight-release',
  preflightChecklist: 'delivery.checklist.preflight-release',
  approvalInstructions: 'delivery.instruction.approve-release',
  publicationInstructions: 'delivery.instruction.publish-deploy',
  observationInstructions: 'delivery.instruction.observe-release',
  settlementInstructions: 'delivery.instruction.settle-delivery',
  errorHints: 'delivery.hint.error-catalog',
} as const);

// ---------------------------------------------------------------------------
// NodeProtocolDefinition: preflight-release (kernel).
//
// The deterministic release-guard node. It assembles complete trusted
// preflight evidence for the exact certified candidate and routes to approval
// on `domain.ready`, or to settlement on `domain.blocked` / `domain.failed`.
// Steps are unconditional (Wave 1 / Wave 9 conservative ratchet: only
// `undefined` conditions are supported — plan §7.4.3 / C065).
// ---------------------------------------------------------------------------

export const PREFLIGHT_RELEASE_NODE_PROTOCOL: NodeProtocolDefinition =
  Object.freeze({
    id: 'delivery.preflight-release',
    version: '1.0.0',
    owningFlowNodeId: DELIVERY_NODE_FLOW_IDS.preflight,
    entryStep: 'read-release-case',
    steps: Object.freeze([
      {
        id: 'read-release-case',
        instructions:
          'Re-read the exact DeliveryReleaseCase bound to this fenced run. ' +
          'Confirm the development certificate is verified, the integrated ' +
          'candidate hash is immutable, and the release policy is complete. ' +
          'Never trust self-reported input; read the durable frame.',
        resources: Object.freeze([RESOURCE_IDS.preflightInstructions]),
        allowedTools: Object.freeze(['Read', 'Grep']),
        evidenceRequirements: Object.freeze([EXTERNAL_RECEIPT_EVIDENCE]),
      },
      {
        id: 'assemble-preflight-evidence',
        instructions:
          'Build the complete preflight snapshot from the injected preflight ' +
          'state port: every required guard check for the exact candidate ' +
          'hash, each backed by a trusted deterministic-evidence provider. ' +
          'Use the preflight checklist to confirm the guard set is complete.',
        resources: Object.freeze([
          RESOURCE_IDS.preflightInstructions,
          RESOURCE_IDS.preflightChecklist,
        ]),
        allowedTools: Object.freeze(['Read']),
        evidenceRequirements: Object.freeze([
          MODULE_VERIFIER_RECEIPT_EVIDENCE,
          EXTERNAL_RECEIPT_EVIDENCE,
        ]),
      },
      {
        id: 'evaluate-guards',
        instructions:
          'Evaluate the assembled preflight against the release policy. Emit ' +
          'domain.ready when every required guard passed, domain.blocked when ' +
          'a guard failed or a provider is unavailable, or domain.failed on ' +
          'infrastructure error. Surface the error-hint catalog on failure.',
        resources: Object.freeze([RESOURCE_IDS.errorHints]),
        allowedTools: Object.freeze([]),
        evidenceRequirements: Object.freeze([MODULE_VERIFIER_RECEIPT_EVIDENCE]),
      },
    ]),
    transitions: Object.freeze([
      {
        from: 'read-release-case',
        to: 'assemble-preflight-evidence',
        kind: 'linear' as const,
      },
      {
        from: 'assemble-preflight-evidence',
        to: 'evaluate-guards',
        kind: 'linear' as const,
      },
    ]),
    nodeCompletionEvidence: Object.freeze([
      MODULE_VERIFIER_RECEIPT_EVIDENCE,
      EXTERNAL_RECEIPT_EVIDENCE,
    ]),
    recoveryEntrySteps: Object.freeze(['assemble-preflight-evidence']),
    retrySemantics: 'runtime-implemented-linear',
  });

// ---------------------------------------------------------------------------
// NodeProtocolDefinition: approve-release (human).
//
// The authorized-decision node. It materializes a human decision bound to the
// exact candidate, preflight result and release policy. Routes to
// publish-deploy on `domain.approved` / `domain.not-required`, or to
// settlement on `domain.approval-required` / `domain.denied` / `domain.failed`.
// ---------------------------------------------------------------------------

export const APPROVE_RELEASE_NODE_PROTOCOL: NodeProtocolDefinition =
  Object.freeze({
    id: 'delivery.approve-release',
    version: '1.0.0',
    owningFlowNodeId: DELIVERY_NODE_FLOW_IDS.approval,
    entryStep: 're-read-preflight',
    steps: Object.freeze([
      {
        id: 're-read-preflight',
        instructions:
          'Re-read the exact durable preflight production for this run and ' +
          'assert it is still ready. Approval binds the candidate hash, ' +
          'preflight hash and release-policy hash and cannot float to a later ' +
          'revision (invariant delivery.approval-binds-exact-input).',
        resources: Object.freeze([RESOURCE_IDS.approvalInstructions]),
        allowedTools: Object.freeze(['Read']),
        evidenceRequirements: Object.freeze([MODULE_VERIFIER_RECEIPT_EVIDENCE]),
      },
      {
        id: 'obtain-authorized-decision',
        instructions:
          'Materialize an authorized decision through the injected approval ' +
          'port bound to the exact candidate + preflight + policy. When the ' +
          'policy requires human approval, the decision MUST carry a trusted ' +
          'authorized-decision provider. A pending decision pauses the run.',
        resources: Object.freeze([RESOURCE_IDS.approvalInstructions]),
        allowedTools: Object.freeze([]),
        evidenceRequirements: Object.freeze([
          HUMAN_RECEIPT_EVIDENCE,
          EXTERNAL_RECEIPT_EVIDENCE,
        ]),
      },
      {
        id: 'route-approval',
        instructions:
          'Emit the domain event the Flow transitions on: domain.approved / ' +
          'domain.not-required to begin external effects, or ' +
          'domain.approval-required / domain.denied / domain.failed to settle ' +
          'without release effects. The module never starts publish-deploy ' +
          'directly; the Flow owns the transition.',
        resources: Object.freeze([RESOURCE_IDS.errorHints]),
        allowedTools: Object.freeze([]),
        evidenceRequirements: Object.freeze([HUMAN_RECEIPT_EVIDENCE]),
      },
    ]),
    transitions: Object.freeze([
      {
        from: 're-read-preflight',
        to: 'obtain-authorized-decision',
        kind: 'linear' as const,
      },
      {
        from: 'obtain-authorized-decision',
        to: 'route-approval',
        kind: 'linear' as const,
      },
    ]),
    nodeCompletionEvidence: Object.freeze([
      HUMAN_RECEIPT_EVIDENCE,
      EXTERNAL_RECEIPT_EVIDENCE,
    ]),
    recoveryEntrySteps: Object.freeze(['obtain-authorized-decision']),
    retrySemantics: 'runtime-implemented-linear',
  });

// ---------------------------------------------------------------------------
// NodeProtocolDefinition: publish-deploy (external).
//
// The desired-state action node. It applies every required release action
// through explicit providers using deterministic cross-run action keys.
// Routes to observe-release on `runtime.completed` or `runtime.failed`
// (observe-before-retry invariant: even a failed publish is observed).
// ---------------------------------------------------------------------------

export const PUBLISH_DEPLOY_NODE_PROTOCOL: NodeProtocolDefinition =
  Object.freeze({
    id: 'delivery.publish-deploy',
    version: '1.0.0',
    owningFlowNodeId: DELIVERY_NODE_FLOW_IDS.publication,
    entryStep: 're-read-authorization',
    steps: Object.freeze([
      {
        id: 're-read-authorization',
        instructions:
          'Re-read the exact durable preflight + approval productions and ' +
          'assert the release is authorized (invariant ' +
          'delivery.explicit-operator-authorization + ' +
          'delivery.no-default-provider). No fallback provider may perform ' +
          'release effects.',
        resources: Object.freeze([RESOURCE_IDS.publicationInstructions]),
        allowedTools: Object.freeze(['Read']),
        evidenceRequirements: Object.freeze([
          HUMAN_RECEIPT_EVIDENCE,
          MODULE_VERIFIER_RECEIPT_EVIDENCE,
        ]),
      },
      {
        id: 'apply-desired-state-actions',
        instructions:
          'Apply every required release action through the injected ' +
          'publication port using each action deterministic actionKey. ' +
          'Adapters must NOT force push, bypass branch protection, bypass ' +
          'registry immutability or bypass deployment policy (invariant ' +
          'delivery.no-force-or-bypass). Persist uncertain results for the ' +
          'observation adapter instead of blind retry.',
        resources: Object.freeze([RESOURCE_IDS.publicationInstructions]),
        allowedTools: Object.freeze([]),
        evidenceRequirements: Object.freeze([EXTERNAL_RECEIPT_EVIDENCE]),
      },
      {
        id: 'collect-receipts',
        instructions:
          'Collect the desired-state action receipts. Emit ' +
          'runtime.completed when every required action succeeded, or ' +
          'runtime.failed when any receipt is incomplete or uncertain. A ' +
          'successful command response alone never establishes release ' +
          '(invariant delivery.push-is-not-release).',
        resources: Object.freeze([RESOURCE_IDS.errorHints]),
        allowedTools: Object.freeze([]),
        evidenceRequirements: Object.freeze([EXTERNAL_RECEIPT_EVIDENCE]),
      },
    ]),
    transitions: Object.freeze([
      {
        from: 're-read-authorization',
        to: 'apply-desired-state-actions',
        kind: 'linear' as const,
      },
      {
        from: 'apply-desired-state-actions',
        to: 'collect-receipts',
        kind: 'linear' as const,
      },
    ]),
    nodeCompletionEvidence: Object.freeze([EXTERNAL_RECEIPT_EVIDENCE]),
    recoveryEntrySteps: Object.freeze(['apply-desired-state-actions']),
    retrySemantics: 'runtime-implemented-linear',
  });

// ---------------------------------------------------------------------------
// NodeProtocolDefinition: observe-release (external).
//
// The authoritative target-state read node. It observes every required
// destination after the publish/deploy response, including uncertain and
// failed responses. Routes to settlement on `runtime.completed` or
// `runtime.failed`.
// ---------------------------------------------------------------------------

export const OBSERVE_RELEASE_NODE_PROTOCOL: NodeProtocolDefinition =
  Object.freeze({
    id: 'delivery.observe-release',
    version: '1.0.0',
    owningFlowNodeId: DELIVERY_NODE_FLOW_IDS.observation,
    entryStep: 're-read-publication',
    steps: Object.freeze([
      {
        id: 're-read-publication',
        instructions:
          'Re-read the exact durable publication production and assert ' +
          'lineage (candidate / preflight / approval / publication hashes). ' +
          'Observation binds the publication hash and cannot float.',
        resources: Object.freeze([RESOURCE_IDS.observationInstructions]),
        allowedTools: Object.freeze(['Read']),
        evidenceRequirements: Object.freeze([EXTERNAL_RECEIPT_EVIDENCE]),
      },
      {
        id: 'observe-target-state',
        instructions:
          'Read authoritative target state for every published destination ' +
          'through the injected observation port, including destinations whose ' +
          'publication response was uncertain or failed. Retries use the ' +
          'deterministic action key and observe before acting (invariant ' +
          'delivery.observe-before-retry).',
        resources: Object.freeze([RESOURCE_IDS.observationInstructions]),
        allowedTools: Object.freeze([]),
        evidenceRequirements: Object.freeze([EXTERNAL_RECEIPT_EVIDENCE]),
      },
      {
        id: 'classify-observations',
        instructions:
          'Classify each destination as matched / mismatched / unknown / error. ' +
          'Emit runtime.completed when every observation is complete and ' +
          'matched, or runtime.failed when any observation is uncertain. The ' +
          'observation snapshot is the input to settlement.',
        resources: Object.freeze([RESOURCE_IDS.errorHints]),
        allowedTools: Object.freeze([]),
        evidenceRequirements: Object.freeze([
          EXTERNAL_RECEIPT_EVIDENCE,
          MODULE_VERIFIER_RECEIPT_EVIDENCE,
        ]),
      },
    ]),
    transitions: Object.freeze([
      {
        from: 're-read-publication',
        to: 'observe-target-state',
        kind: 'linear' as const,
      },
      {
        from: 'observe-target-state',
        to: 'classify-observations',
        kind: 'linear' as const,
      },
    ]),
    nodeCompletionEvidence: Object.freeze([
      EXTERNAL_RECEIPT_EVIDENCE,
      MODULE_VERIFIER_RECEIPT_EVIDENCE,
    ]),
    recoveryEntrySteps: Object.freeze(['observe-target-state']),
    retrySemantics: 'runtime-implemented-linear',
  });

// ---------------------------------------------------------------------------
// NodeProtocolDefinition: settle-delivery (kernel).
//
// The settlement node. It validates exact durable products and candidate
// immutability, then issues a canonical release record (on released) and a
// delivery certificate. Routes to the matching terminal outcome emitter.
// ---------------------------------------------------------------------------

export const SETTLE_DELIVERY_NODE_PROTOCOL: NodeProtocolDefinition =
  Object.freeze({
    id: 'delivery.settle-delivery',
    version: '1.0.0',
    owningFlowNodeId: DELIVERY_NODE_FLOW_IDS.settlement,
    entryStep: 'read-settlement-state',
    steps: Object.freeze([
      {
        id: 'read-settlement-state',
        instructions:
          'Re-read the exact settlement input from the injected settlement ' +
          'state port: the durable preflight, approval, publication and ' +
          'observation productions plus the current candidate hash. Even a ' +
          'preflight failure reaches settlement because the worker may have ' +
          'committed durable writes.',
        resources: Object.freeze([RESOURCE_IDS.settlementInstructions]),
        allowedTools: Object.freeze(['Read']),
        evidenceRequirements: Object.freeze([MODULE_VERIFIER_RECEIPT_EVIDENCE]),
      },
      {
        id: 'validate-exact-products',
        instructions:
          'Validate every content-addressed reference matches its durable ' +
          'production, the candidate hash is immutable (invariant ' +
          'delivery.candidate-is-immutable), and the observation authoritatively ' +
          'matches every desired state. A push response alone never establishes ' +
          'release (invariant delivery.push-is-not-release).',
        resources: Object.freeze([
          RESOURCE_IDS.settlementInstructions,
          RESOURCE_IDS.errorHints,
        ]),
        allowedTools: Object.freeze([]),
        evidenceRequirements: Object.freeze([
          MODULE_VERIFIER_RECEIPT_EVIDENCE,
          EXTERNAL_RECEIPT_EVIDENCE,
        ]),
      },
      {
        id: 'emit-certificate',
        instructions:
          'On released, persist the canonical ReleaseRecord through the output ' +
          'repository and emit the delivery certificate. On any other decision, ' +
          'emit the certificate WITHOUT a release record. Emit the domain event ' +
          '(released / approval-required / blocked / failed) the Flow terminal ' +
          'transitions on. The module emits a local outcome and does not decide ' +
          'lifecycle routing (invariant delivery.module-does-not-route).',
        resources: Object.freeze([RESOURCE_IDS.settlementInstructions]),
        allowedTools: Object.freeze([]),
        evidenceRequirements: Object.freeze([MODULE_VERIFIER_RECEIPT_EVIDENCE]),
      },
    ]),
    transitions: Object.freeze([
      {
        from: 'read-settlement-state',
        to: 'validate-exact-products',
        kind: 'linear' as const,
      },
      {
        from: 'validate-exact-products',
        to: 'emit-certificate',
        kind: 'linear' as const,
      },
    ]),
    nodeCompletionEvidence: Object.freeze([MODULE_VERIFIER_RECEIPT_EVIDENCE]),
    recoveryEntrySteps: Object.freeze(['validate-exact-products']),
    retrySemantics: 'runtime-implemented-linear',
  });

// ---------------------------------------------------------------------------
// Lane aggregation + structural self-check.
// ---------------------------------------------------------------------------

/**
 * The complete set of delivery-lane NodeProtocolDefinitions (one per Flow
 * node). W9-A5 merges these into the manifest's protocol surface; W9-A8
 * conformance tests assert over this set.
 */
export const DELIVERY_NODE_PROTOCOLS: readonly NodeProtocolDefinition[] =
  Object.freeze([
    PREFLIGHT_RELEASE_NODE_PROTOCOL,
    APPROVE_RELEASE_NODE_PROTOCOL,
    PUBLISH_DEPLOY_NODE_PROTOCOL,
    OBSERVE_RELEASE_NODE_PROTOCOL,
    SETTLE_DELIVERY_NODE_PROTOCOL,
  ]);

/**
 * Structural self-check for every delivery-lane protocol.
 *
 * Delegates to the Wave 1 SPI `validateNodeProtocolDefinition` (canonical
 * serializability + retry-semantics + entry/transition/recovery-step
 * invariants). Returns the FIRST failure (protocols are independently valid;
 * one bad entry is enough to reject the lane). Tests call this; the manifest
 * may call it at merge time.
 */
export function validateDeliveryLaneProtocols(): ValidationResult {
  for (const proto of DELIVERY_NODE_PROTOCOLS) {
    const result = validateNodeProtocolDefinition(proto);
    if (!result.ok) {
      return {
        ok: false,
        errors: result.errors.map((e: ValidationError) => ({
          code: e.code,
          path: `${proto.id}.${e.path}`,
          message: e.message,
        })),
      };
    }
  }
  return { ok: true, errors: [] };
}

export { validateNodeProtocolDefinition };
