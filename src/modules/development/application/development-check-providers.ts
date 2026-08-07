import type Database from 'better-sqlite3';
import type { CheckProvider } from '../../../process-modules/domain/workplace/gate.js';
import type { SqliteCandidateSetRepository } from '../../../infrastructure/workplace/sqlite-candidate-set-repository.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import {
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  type DevelopmentCase,
} from '../domain/development-schemas.js';
import {
  buildCanonicalDevelopmentTaskGraph,
  decodeDevelopmentTaskGraphProposal,
} from '../domain/development-task-graph.js';
import {
  ReferenceDevelopmentTaskGraphPolicy,
  type DevelopmentTaskGraphPolicyPort,
} from '../domain/development-settlement-policy.js';

export const DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID =
  'development.task-graph-contract.v1';
export const DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION = '1.0.0';
export const DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID,
  version: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION,
  invariant: 'development-task-graph-validates-before-cell-acceptance',
});

interface SubmissionRow {
  schema_version: string;
  payload_snapshot: string;
  content_hash: string;
  id: number;
}

export function createDevelopmentTaskGraphCheckProvider(input: {
  db: Database.Database;
  candidateSets: SqliteCandidateSetRepository;
  taskGraphPolicy?: DevelopmentTaskGraphPolicyPort;
}): CheckProvider {
  const policy = input.taskGraphPolicy ?? new ReferenceDevelopmentTaskGraphPolicy();
  return {
    providerId: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION,
    run({ subjectCandidateSetRef, parameters }) {
      try {
        const processRunId = Number(parameters.processRunId);
        if (!Number.isInteger(processRunId) || processRunId <= 0) return 'error';
        const candidate = input.candidateSets.read(subjectCandidateSetRef);
        if (!candidate || candidate.role !== 'author') return 'error';
        const row = input.db.prepare(
          `SELECT id,schema_version,payload_snapshot,content_hash
             FROM factory_managed_node_submissions
            WHERE process_run_id=? AND execution_id=?
            ORDER BY id DESC LIMIT 1`,
        ).get(processRunId, candidate.producerExecutionRef) as SubmissionRow | undefined;
        if (!row || row.schema_version !== DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA) {
          return 'failed';
        }
        const decoded = decodeDevelopmentTaskGraphProposal(
          JSON.parse(row.payload_snapshot),
        );
        if (!decoded.ok) return 'failed';
        const processRun = input.db.prepare(
          `SELECT input_schema,input_snapshot FROM factory_process_runs WHERE id=?`,
        ).get(processRunId) as { input_schema: string; input_snapshot: string } | undefined;
        if (!processRun || processRun.input_schema !== DEVELOPMENT_CASE_SCHEMA) return 'error';
        const developmentCase = JSON.parse(processRun.input_snapshot) as DevelopmentCase;
        const graph = buildCanonicalDevelopmentTaskGraph(
          developmentCase,
          decoded.value,
          {
            schema: row.schema_version,
            ref: `managed-node-submission:${row.id}`,
            hash: row.content_hash,
          },
        );
        return policy.validate(developmentCase, graph).valid ? 'passed' : 'failed';
      } catch {
        return 'error';
      }
    },
  };
}
