import { sha256Hex } from '../../shared/canonical-json.js';
import type { SqliteCandidateSetRepository } from '../../infrastructure/workplace/sqlite-candidate-set-repository.js';
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

export function submissionValidatorCheckProvider(input: {
  db: DbHandle;
  candidateSets: SqliteCandidateSetRepository;
  validator: NodeSubmissionValidator;
  nodeId: string;
  contractRef?: ContractRef;
}): CheckProvider & { readonly providerDigest: string } {
  const providerId = `factory.submission-validator.${input.validator.validatorId}`;
  const version = input.validator.validatorVersion;
  const providerDigest = sha256Hex({
    providerId,
    version,
    validatorId: input.validator.validatorId,
    validatorVersion: input.validator.validatorVersion,
    nodeId: input.nodeId,
    contractRef: input.contractRef ?? null,
  });
  return {
    providerId,
    version,
    providerDigest,
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
