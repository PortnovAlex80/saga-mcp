import type { PostAcceptanceEffect } from '../../process-modules/application/post-acceptance-effects.js';
import { SqliteProductionCellIntegration } from './sqlite-production-cell-integration.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import type {
  ExternalEffectActionRecord,
  ExternalEffectLedger,
} from '../../process-modules/persistence/external-effect-ledger.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';

export const GIT_INTEGRATION_EFFECT_ID = 'git-integration';

export function createGitIntegrationEffect(
  integration: SqliteProductionCellIntegration,
  ledger: ExternalEffectLedger,
): PostAcceptanceEffect {
  return {
    effectId: GIT_INTEGRATION_EFFECT_ID,
    run(input) {
      const request = {
        schema: 'factory.git-integration-request.v1',
        workplaceRef: serializeWorkplaceRef(input.workplaceRef),
        candidateSetRef: input.candidateSetRef,
        producerExecutionRef: input.producerExecutionRef,
        expectedProductSchema: input.expectedProductSchema,
      } as const;
      const actionKey = sha256Hex(request);
      let action = ledger.start({
        providerNamespace: 'factory.git-integration.v1',
        actionKey,
        processRunId: input.processRunId,
        moduleRef: input.moduleRef,
        nodeId: input.nodeId,
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
          owner: `cell-effect-observer:${input.processRunId}`,
          leaseSeconds: 60,
        });
        if (!observationClaim) {
          return { outcome: 'pending', reason: 'integration execution/observation is still leased' };
        }
        const observation = integration.observeAcceptedWorkplace({
          workplaceRef: input.workplaceRef,
          processRunId: input.processRunId,
          candidateSetRef: input.candidateSetRef,
          expectedProductSchema: input.expectedProductSchema,
        });
        action = ledger.recordObservation({
          claim: observationClaim.claim,
          observation,
        });
        if (action.state === 'succeeded') return succeeded(action);
        if (action.state === 'retry-authorized') {
          return { outcome: 'pending', reason: 'absence proven; retry authorized' };
        }
        return {
          outcome: observation.outcome === 'blocked' && observation.reason.includes('CONFLICT')
            ? 'repair_required'
            : 'human_required',
          reason: observation.outcome === 'blocked'
            ? observation.reason
            : 'integration observation blocked',
          evidence: observation.evidence,
        };
      }

      const executionClaim = ledger.claim({
        actionId: action.id,
        owner: `cell-effect-executor:${input.processRunId}`,
        leaseSeconds: 60,
      });
      if (!executionClaim) {
        return { outcome: 'pending', reason: 'integration execution is already claimed' };
      }
      try {
        const result = integration.integrateAcceptedWorkplace({
          workplaceRef: input.workplaceRef,
          processRunId: input.processRunId,
          candidateSetRef: input.candidateSetRef,
          expectedProductSchema: input.expectedProductSchema,
        });
        if (result.outcome === 'repair_required') {
          ledger.recordExecutionResult({
            claim: executionClaim.claim,
            result: {
              outcome: 'failed',
              error: result.reason,
              details: result,
            },
          });
          return {
            outcome: 'repair_required',
            reason: result.reason,
            evidence: result,
          };
        }
        action = ledger.recordExecutionResult({
          claim: executionClaim.claim,
          result: {
            outcome: 'succeeded',
            receipt: result,
            providerEffectId: result.afterHead,
          },
        });
        return succeeded(action);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ledger.recordExecutionResult({
          claim: executionClaim.claim,
          result: { outcome: 'unknown', error: reason },
        });
        return {
          outcome: 'pending',
          reason: `integration outcome requires observation: ${reason}`,
        };
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
