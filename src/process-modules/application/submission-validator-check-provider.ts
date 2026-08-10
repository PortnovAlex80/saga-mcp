import { sha256Hex } from '../../shared/canonical-json.js';
import type { CandidateSetReaderPort } from '../../application/ports/candidate-set-reader.js';
import type { CheckProvider } from '../domain/workplace/gate.js';
import type {
  ContractRef,
  NodeSubmissionValidator,
} from './node-submission-policy.js';

interface DbHandle {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
  };
}

export function submissionValidatorCheckProviderRef(input: {
  validatorId: string;
  validatorVersion: string;
  nodeId: string;
  contractRef?: ContractRef;
  requireManagedProduction?: boolean;
}) {
  const providerId = `factory.submission-validator.${input.validatorId}`;
  const version = input.validatorVersion;
  const providerDigest = sha256Hex({
    providerId,
    version,
    validatorId: input.validatorId,
    validatorVersion: input.validatorVersion,
    nodeId: input.nodeId,
    contractRef: input.contractRef ?? null,
    requireManagedProduction: input.requireManagedProduction === true,
  });
  return { providerId, version, providerDigest } as const;
}

export function submissionValidatorCheckProvider(input: {
  db: DbHandle;
  candidateSets: CandidateSetReaderPort;
  validator: NodeSubmissionValidator;
  nodeId: string;
  contractRef?: ContractRef;
  requireManagedProduction?: boolean;
}): CheckProvider & { readonly providerDigest: string } {
  const ref = submissionValidatorCheckProviderRef({
    validatorId: input.validator.validatorId,
    validatorVersion: input.validator.validatorVersion,
    nodeId: input.nodeId,
    ...(input.contractRef ? { contractRef: input.contractRef } : {}),
    requireManagedProduction: input.requireManagedProduction,
  });
  return {
    ...ref,
    run({ subjectCandidateSetRef, parameters }) {
      try {
        const candidate = input.candidateSets.read(subjectCandidateSetRef);
        if (!candidate || candidate.role !== 'author') return 'error';
        const processRunId = Number(parameters.processRunId);
        const moduleRef = String(parameters.moduleRef ?? '');
        if (
          !Number.isSafeInteger(processRunId)
          || processRunId < 1
          || candidate.workplaceRef.processRunId !== processRunId
          || !moduleRef
        ) return 'error';
        if (input.requireManagedProduction) {
          const produced = input.db.prepare(
            `SELECT 1 AS present
               FROM factory_managed_artifact_productions
              WHERE process_run_id=? AND execution_id=?
              LIMIT 1`,
          ).get(processRunId, candidate.producerExecutionRef) as
            | { present: number }
            | undefined;
          const traced = input.db.prepare(
            `SELECT 1 AS present
               FROM factory_managed_trace_productions
              WHERE process_run_id=? AND execution_id=?
              LIMIT 1`,
          ).get(processRunId, candidate.producerExecutionRef) as
            | { present: number }
            | undefined;
          if (!produced && !traced) return 'failed';
        }
        const row = input.db.prepare(
          `SELECT t.id AS task_id,t.epic_id,e.project_id
             FROM worker_executions we
             JOIN tasks t ON t.id=we.task_id
             JOIN epics e ON e.id=t.epic_id
            WHERE we.execution_id=?`,
        ).get(candidate.producerExecutionRef) as {
          task_id: number;
          epic_id: number;
          project_id: number;
        } | undefined;
        if (!row) return 'error';
        const result = input.validator.validate({
          processRunId,
          moduleRef,
          nodeId: input.nodeId,
          executionId: candidate.producerExecutionRef,
          taskId: row.task_id,
          epicId: row.epic_id,
          projectId: row.project_id,
          ...(input.contractRef ? { contractRef: input.contractRef } : {}),
        });
        return result.accepted ? 'passed' : 'failed';
      } catch {
        return 'error';
      }
    },
  };
}
