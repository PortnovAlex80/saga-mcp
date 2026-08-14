import type { PostAcceptanceEffect } from '../../process-modules/application/post-acceptance-effects.js';
import { SqliteProductionCellIntegration } from './sqlite-production-cell-integration.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import type {
  ExternalEffectActionRecord,
  ExternalEffectLedger,
} from '../../process-modules/persistence/external-effect-ledger.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';

export const GIT_INTEGRATION_EFFECT_ID = 'git-integration';
export const GIT_INTEGRATION_EFFECT_VERSION = '1.0.0';
export const GIT_INTEGRATION_EFFECT_DIGEST = sha256Hex({
  effectId: GIT_INTEGRATION_EFFECT_ID,
  version: GIT_INTEGRATION_EFFECT_VERSION,
  invariant: 'accepted-authority-external-effect-ledger-cas-integration',
});

export function createGitIntegrationEffect(
  integration: SqliteProductionCellIntegration,
  ledger: ExternalEffectLedger,
): PostAcceptanceEffect {
  return {
    effectId: GIT_INTEGRATION_EFFECT_ID,
    version: GIT_INTEGRATION_EFFECT_VERSION,
    effectDigest: GIT_INTEGRATION_EFFECT_DIGEST,
    run(input) {
      // ADR-053 B-4 — material coordinates come ONLY from the authority.
      const { authority } = input;
      integration.assertAuthority(authority);
      const processRunId = authority.workplaceRef.processRunId;
      const moduleSeparator = authority.workplaceRef.moduleRef.lastIndexOf('@');
      if (moduleSeparator <= 0) throw new Error('AUTHORITY_MODULE_REF_INVALID');
      const moduleRef = {
        name: authority.workplaceRef.moduleRef.slice(0, moduleSeparator),
        version: authority.workplaceRef.moduleRef.slice(moduleSeparator + 1),
      };
      const expectedProductSchema = authority.productSchema;
      const request = {
        schema: 'factory.git-integration-request.v1',
        workplaceRef: serializeWorkplaceRef(authority.workplaceRef),
        candidateSetRef: authority.candidateSetRef,
        productionRevisionRef: authority.productionRevisionRef,
        gateDecisionKey: authority.gateDecisionKey,
        expectedProductSchema,
      } as const;
      const actionKey = sha256Hex(request);
      let action = ledger.start({
        providerNamespace: 'factory.git-integration.v1',
        actionKey,
        processRunId,
        moduleRef,
        nodeId: authority.workplaceRef.productionCellId,
        request,
        requestHash: sha256Hex(request),
      }).record;
      if (action.state === 'succeeded') return succeeded(action);
      if (action.state === 'blocked') {
        return { outcome: 'human_required', reason: action.lastError ?? 'integration blocked' };
      }
      if (action.state === 'executing' || action.state === 'failed' || action.state === 'unknown') {
        const observationClaim = ledger.claimObservation({
          actionId: action.id,
          owner: `cell-effect-observer:${processRunId}`,
          leaseSeconds: 60,
        });
        if (!observationClaim) {
          return { outcome: 'pending', reason: 'integration execution/observation is still leased' };
        }
        const observation = integration.observeAcceptedWorkplace({
          workplaceRef: authority.workplaceRef,
          processRunId,
          candidateSetRef: authority.candidateSetRef,
          gateDecisionKey: authority.gateDecisionKey,
          expectedProductSchema,
        });
        action = ledger.recordObservation({ claim: observationClaim.claim, observation });
        if (action.state === 'succeeded') return succeeded(action);
        if (action.state === 'retry-authorized') {
          return { outcome: 'pending', reason: 'absence proven; retry authorized' };
        }
        return {
          outcome: observation.outcome === 'blocked' && observation.reason.includes('CONFLICT')
            ? 'repair_required'
            : 'human_required',
          reason: observation.outcome === 'blocked' ? observation.reason : 'integration observation blocked',
          evidence: observation.evidence,
        };
      }
      const executionClaim = ledger.claim({
        actionId: action.id,
        owner: `cell-effect-executor:${processRunId}`,
        leaseSeconds: 60,
      });
      if (!executionClaim) {
        return { outcome: 'pending', reason: 'integration execution is already claimed' };
      }
      try {
        const result = integration.integrateAcceptedWorkplace({
          workplaceRef: authority.workplaceRef,
          processRunId,
          candidateSetRef: authority.candidateSetRef,
          gateDecisionKey: authority.gateDecisionKey,
          expectedProductSchema,
        });
        if (result.outcome === 'repair_required') {
          ledger.recordExecutionResult({
            claim: executionClaim.claim,
            result: { outcome: 'failed', error: result.reason, details: result },
          });
          return { outcome: 'repair_required', reason: result.reason, evidence: result };
        }
        action = ledger.recordExecutionResult({
          claim: executionClaim.claim,
          result: { outcome: 'succeeded', receipt: result, providerEffectId: result.afterHead },
        });
        return succeeded(action);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ledger.recordExecutionResult({
          claim: executionClaim.claim,
          result: { outcome: 'unknown', error: reason },
        });
        return { outcome: 'pending', reason: `integration outcome requires observation: ${reason}` };
      }
    },
  };
}

function succeeded(action: ExternalEffectActionRecord): {
  outcome: 'succeeded';
  receiptRef: string;
  receiptDigest: string;
  evidence: Readonly<Record<string, unknown>>;
} {
  const receiptDigest = action.executionResultHash ?? action.observationHash;
  if (!receiptDigest) throw new Error(`GIT_INTEGRATION_RECEIPT_MISSING: action ${action.id}`);
  return {
    outcome: 'succeeded',
    receiptRef: `external-effect-action:${action.id}`,
    receiptDigest,
    evidence: {
      actionId: action.id,
      providerEffectId: action.providerEffectId,
      executionResultHash: action.executionResultHash,
      observationHash: action.observationHash,
    },
  };
}
