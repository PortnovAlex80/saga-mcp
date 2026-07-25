import type { LifecycleDefinition } from '../domain/lifecycle.js';
import { DISCOVERY_PROCESS_MODULE_REF } from '../modules/discovery/discovery-process-module.js';
import { FORMALIZATION_PROCESS_MODULE_REF } from '../modules/formalization/formalization-process-module.js';

/**
 * First Lifecycle composition over Process Modules.
 *
 * It intentionally stops after Formalization: Development is not yet migrated
 * to the Process Module boundary. The Lifecycle proves that Discovery and
 * Formalization are connected only through Stage Bindings and local outcomes;
 * neither module imports or starts the other.
 */
export const discoveryToFormalizationLifecycle: LifecycleDefinition = {
  identity: {
    name: 'discovery-to-formalization',
    version: '1.0.0',
    displayName: 'Discovery to Formalization',
    description: 'Turns an initiative into an authoritative discovery result and then a frozen solution contract.',
  },
  entryStageId: 'initial-discovery',
  stages: [
    {
      id: 'initial-discovery',
      displayName: 'Initial Discovery',
      moduleRef: DISCOVERY_PROCESS_MODULE_REF,
      inputMapping: {
        subject: '$.initiative.subject',
        context: '$.initiative.context',
        evidence: '$.initiative.evidence',
        constraints: '$.initiative.constraints',
      },
      outputMapping: {
        certificate: '$.processOutcome.outputRef',
        decision: '$.processOutcome.code',
      },
      outcomeRoutes: {
        go: { type: 'stage', stageId: 'solution-formalization' },
        clarify: { type: 'terminal', status: 'clarification-required' },
        reject: { type: 'terminal', status: 'rejected' },
        defer: { type: 'terminal', status: 'deferred' },
        inconclusive: { type: 'terminal', status: 'inconclusive' },
        failed: { type: 'terminal', status: 'failed' },
      },
      entryConditions: ['initiative.subject exists'],
      exitConditions: ['local Discovery outcome is settled or infrastructure failure is recorded'],
    },
    {
      id: 'solution-formalization',
      displayName: 'Solution Formalization',
      moduleRef: FORMALIZATION_PROCESS_MODULE_REF,
      inputMapping: {
        discoveryCertificate: '$.stages.initial-discovery.certificate',
        subject: '$.initiative.subject',
        constraints: '$.initiative.constraints',
      },
      outputMapping: {
        solutionContractCertificate: '$.processOutcome.outputRef',
        decision: '$.processOutcome.code',
      },
      outcomeRoutes: {
        accepted: { type: 'terminal', status: 'ready-for-development' },
        'clarification-required': { type: 'terminal', status: 'clarification-required' },
        inconsistent: { type: 'terminal', status: 'formalization-inconsistent' },
        infeasible: { type: 'terminal', status: 'infeasible' },
        failed: { type: 'terminal', status: 'failed' },
      },
      entryConditions: ['initial-discovery outcome is go', 'discovery certificate exists'],
      exitConditions: ['local Formalization outcome is settled or infrastructure failure is recorded'],
    },
  ],
};
