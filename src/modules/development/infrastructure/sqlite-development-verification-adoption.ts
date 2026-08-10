import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { KernelHandler } from '../../../process-modules/application/kernel-handler-registry.js';
import { SqliteProcessProductRepository } from '../../../process-modules/persistence/sqlite-process-product-repository.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import { createGitPort, createMachinePort } from '../../../infrastructure/process-modules/git-machine-ports.js';
import type { DevelopmentModuleInstallationDependencies } from '../domain/development-kernel-ports.js';
import type {
  DevelopmentCase,
  DevelopmentImplementationWorkset,
  DevelopmentTaskGraphSnapshot,
  IntegratedReleaseCandidate,
} from '../domain/development-schemas.js';
import { SqliteDevelopmentModuleStore } from './sqlite-development-settlement-state.js';

export interface DevelopmentVerificationAdoption {
  adoptionRef: string;
  evidenceDigest: string;
  sourceProcessRunId: number;
}

export function recordDevelopmentVerificationObserverConfirmation(
  db: Database.Database,
  input: {
    adoptionRef: string;
    observerId: string;
    statement: string;
  },
): readonly string[] {
  if (!input.observerId.trim() || !input.statement.trim()) {
    throw new Error('DEVELOPMENT_VERIFICATION_OBSERVER_IDENTITY_REQUIRED');
  }
  const row = db.prepare(
    `SELECT evidence_snapshot,evidence_digest
       FROM factory_development_verification_adoptions WHERE adoption_ref=?`,
  ).get(input.adoptionRef) as {
    evidence_snapshot: string;
    evidence_digest: string;
  } | undefined;
  if (!row) throw new Error('DEVELOPMENT_VERIFICATION_OBSERVER_ADOPTION_MISSING');
  const adoption = JSON.parse(row.evidence_snapshot) as VerificationAdoptionEvidence;
  if (sha256Hex(adoption) !== row.evidence_digest) {
    throw new Error('DEVELOPMENT_VERIFICATION_OBSERVER_ADOPTION_DRIFT');
  }
  const observations: string[] = [];
  for (const criterion of adoption.acceptanceCriteria) {
    const criterionCode = criterion.code;
    if (!criterionCode) {
      throw new Error('DEVELOPMENT_VERIFICATION_OBSERVER_CRITERION_CODE_MISSING');
    }
    const obligations = adoption.verificationMethodPlan.obligations.filter(
      obligation => obligation.parentCriterionCode === criterionCode,
    );
    if (obligations.length === 0) {
      throw new Error('DEVELOPMENT_VERIFICATION_OBSERVER_METHOD_COVERAGE_MISSING');
    }
    const evidence = {
      schemaVersion: 'factory.authorized-verification-observation.v1',
      adoptionRef: input.adoptionRef,
      adoptionDigest: row.evidence_digest,
      candidateHash: adoption.integratedCandidate.candidateHash,
      methodPlanHash: adoption.verificationMethodPlan.planHash,
      criterionCode,
      acceptedCriterionHash: criterion.acceptedHash,
      obligations,
      observerId: input.observerId,
      statement: input.statement,
      verdict: 'passed' as const,
    };
    const evidenceDigest = sha256Hex(evidence);
    const observationRef = `authorized-verification-observation:${evidenceDigest}`;
    const existing = db.prepare(
      `SELECT observation_ref,evidence_digest FROM factory_authorized_verification_observations
        WHERE candidate_hash=? AND method_plan_hash=? AND criterion_code=? AND observer_id=?`,
    ).get(
      evidence.candidateHash,
      evidence.methodPlanHash,
      criterionCode,
      input.observerId,
    ) as { observation_ref: string; evidence_digest: string } | undefined;
    if (existing) {
      observations.push(existing.observation_ref);
      continue;
    }
    db.prepare(
      `INSERT INTO factory_authorized_verification_observations
        (observation_ref,candidate_hash,method_plan_hash,criterion_code,
         observer_id,verdict,evidence_snapshot,evidence_digest)
       VALUES (?,?,?,?,?,'passed',?,?)`,
    ).run(
      observationRef,
      evidence.candidateHash,
      evidence.methodPlanHash,
      criterionCode,
      input.observerId,
      JSON.stringify(evidence),
      evidenceDigest,
    );
    observations.push(observationRef);
  }
  return observations;
}

interface VerificationAdoptionEvidence {
  schemaVersion: 'factory.development-verification-adoption.v1';
  continuationRef: string;
  sourceLifecycleRunId: number;
  sourceStageRunId: number;
  sourceProcessRunId: number;
  taskGraph: DevelopmentTaskGraphSnapshot;
  taskGraphRef: string;
  implementationWorkset: DevelopmentImplementationWorkset;
  integratedCandidate: IntegratedReleaseCandidate;
  integratedCandidateRef: string;
  repositories: readonly {
    projectRepositoryId: number;
    branch: string;
    commitSha: string;
    treeHash: string;
    localPath: string;
  }[];
  acceptanceCriteria: DevelopmentCase['acceptanceCriteria'];
  verificationMethodPlan: VerificationMethodPlan;
  implementationFinalAcceptanceRefs: readonly string[];
  effectReceiptRefs: readonly string[];
}

interface VerificationMethodPlan {
  schemaVersion: 'factory.verification-method-plan.v1';
  sourceArtifactPath: string;
  sourceAcceptedHash: string;
  obligations: readonly {
    obligationId: string;
    parentCriterionCode: string;
    title: string;
    requiredMethods: readonly string[];
  }[];
  planHash: string;
}

/** Authorize an exact integrated candidate as a read-only verification subject. */
export function adoptDevelopmentVerificationBaseline(
  db: Database.Database,
  input: { continuationRef: string; parentLifecycleRunId: number },
): DevelopmentVerificationAdoption {
  const existing = db.prepare(
    `SELECT adoption_ref,evidence_digest,source_process_run_id
       FROM factory_development_verification_adoptions WHERE continuation_ref=?`,
  ).get(input.continuationRef) as {
    adoption_ref: string;
    evidence_digest: string;
    source_process_run_id: number;
  } | undefined;
  if (existing) return {
    adoptionRef: existing.adoption_ref,
    evidenceDigest: existing.evidence_digest,
    sourceProcessRunId: existing.source_process_run_id,
  };

  const inherited = reauthorizePreviousVerificationAdoption(db, input);
  if (inherited) return inherited;

  const boundary = db.prepare(
    `SELECT sr.id AS stage_run_id,sr.status AS stage_status,sr.local_outcome,
            pr.id AS process_run_id,pr.status AS process_status,pr.local_outcome AS process_outcome,
            pr.input_snapshot
       FROM factory_stage_runs sr
       JOIN factory_process_runs pr ON pr.id=sr.process_run_id
      WHERE sr.lifecycle_run_id=? AND sr.stage_id='solution-development'
      ORDER BY sr.attempt DESC,sr.id DESC LIMIT 1`,
  ).get(input.parentLifecycleRunId) as {
    stage_run_id: number;
    stage_status: string;
    local_outcome: string | null;
    process_run_id: number;
    process_status: string;
    process_outcome: string | null;
    input_snapshot: string;
  } | undefined;
  if (
    !boundary
    || boundary.stage_status !== 'completed'
    || boundary.local_outcome !== 'blocked'
    || boundary.process_status !== 'completed'
    || boundary.process_outcome !== 'blocked'
  ) throw new Error('DEVELOPMENT_VERIFICATION_ADOPTION_BOUNDARY_INVALID');

  const developmentCase = parseDevelopmentCase(boundary.input_snapshot);
  const products = new SqliteProcessProductRepository(db);
  const store = new SqliteDevelopmentModuleStore(
    db,
    products,
    createGitPort(),
    createMachinePort(),
  );
  const settlement = store.buildSettlementInput({
    processRunId: boundary.process_run_id,
    developmentCase,
  });
  if (
    !settlement.taskGraph
    || !settlement.implementationWorkset?.complete
    || !settlement.integratedCandidate
    || !settlement.productReferences.taskGraph
    || !settlement.productReferences.integratedCandidate
  ) throw new Error('DEVELOPMENT_VERIFICATION_ADOPTION_PRODUCTION_INCOMPLETE');

  const repositories = settlement.integratedCandidate.repositories.map(repository => {
    const row = db.prepare(
      `SELECT local_path,integration_branch FROM project_repositories WHERE id=?`,
    ).get(repository.projectRepositoryId) as {
      local_path: string | null;
      integration_branch: string;
    } | undefined;
    if (!row?.local_path || row.integration_branch !== repository.branch) {
      throw new Error('DEVELOPMENT_VERIFICATION_ADOPTION_REPOSITORY_MISSING');
    }
    const commitSha = git(row.local_path, 'rev-parse', `refs/heads/${repository.branch}`);
    const treeHash = git(row.local_path, 'rev-parse', `${commitSha}^{tree}`);
    if (commitSha !== repository.commitSha || treeHash !== repository.treeHash) {
      throw new Error('DEVELOPMENT_VERIFICATION_ADOPTION_REPOSITORY_DRIFT');
    }
    return { ...repository, localPath: row.local_path };
  });

  const implementationFinalAcceptanceRefs = (db.prepare(
    `SELECT cfa.final_acceptance_ref
       FROM factory_cell_final_acceptances cfa
       JOIN factory_workplaces w ON w.workplace_ref=cfa.workplace_ref
      WHERE w.process_run_id=? AND w.production_cell_id='development-implementation'
      ORDER BY cfa.final_acceptance_ref`,
  ).all(boundary.process_run_id) as Array<{ final_acceptance_ref: string }>)
    .map(row => row.final_acceptance_ref);
  if (implementationFinalAcceptanceRefs.length !== settlement.taskGraph.implementationItems.length) {
    throw new Error('DEVELOPMENT_VERIFICATION_ADOPTION_FINAL_ACCEPTANCE_INCOMPLETE');
  }
  const effectReceiptRefs = [...settlement.integratedCandidate.integrationIntentRefs];
  if (effectReceiptRefs.length === 0) {
    throw new Error('DEVELOPMENT_VERIFICATION_ADOPTION_EFFECT_RECEIPT_MISSING');
  }
  const verificationMethodPlan = readVerificationMethodPlan(
    db,
    developmentCase,
    repositories[0]!.localPath,
  );
  for (const decoratedRef of effectReceiptRefs) {
    const receiptRef = decoratedRef.split(':task:')[0]!;
    const count = (db.prepare(
      `SELECT COUNT(*) AS count FROM factory_cell_effect_receipts WHERE effect_receipt_ref=?`,
    ).get(receiptRef) as { count: number }).count;
    if (count !== 1) throw new Error('DEVELOPMENT_VERIFICATION_ADOPTION_EFFECT_RECEIPT_DRIFT');
  }

  const evidence: VerificationAdoptionEvidence = {
    schemaVersion: 'factory.development-verification-adoption.v1',
    continuationRef: input.continuationRef,
    sourceLifecycleRunId: input.parentLifecycleRunId,
    sourceStageRunId: boundary.stage_run_id,
    sourceProcessRunId: boundary.process_run_id,
    taskGraph: settlement.taskGraph,
    taskGraphRef: settlement.productReferences.taskGraph.ref,
    implementationWorkset: settlement.implementationWorkset,
    integratedCandidate: settlement.integratedCandidate,
    integratedCandidateRef: settlement.productReferences.integratedCandidate.ref,
    repositories,
    acceptanceCriteria: developmentCase.acceptanceCriteria,
    verificationMethodPlan,
    implementationFinalAcceptanceRefs,
    effectReceiptRefs,
  };
  const evidenceDigest = sha256Hex(evidence);
  const adoptionRef = `development-verification-adoption:${evidenceDigest}`;
  db.prepare(
    `INSERT INTO factory_development_verification_adoptions
      (adoption_ref,continuation_ref,source_lifecycle_run_id,source_stage_run_id,
       source_process_run_id,task_graph_ref,task_graph_hash,implementation_workset_hash,
       integrated_candidate_ref,integrated_candidate_hash,repository_snapshot,
       acceptance_snapshot,verification_method_plan_hash,evidence_snapshot,evidence_digest)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    adoptionRef,
    input.continuationRef,
    input.parentLifecycleRunId,
    boundary.stage_run_id,
    boundary.process_run_id,
    evidence.taskGraphRef,
    evidence.taskGraph.graphHash,
    evidence.implementationWorkset.worksetHash,
    evidence.integratedCandidateRef,
    evidence.integratedCandidate.candidateHash,
    JSON.stringify(repositories),
    JSON.stringify(developmentCase.acceptanceCriteria),
    verificationMethodPlan.planHash,
    JSON.stringify(evidence),
    evidenceDigest,
  );
  return { adoptionRef, evidenceDigest, sourceProcessRunId: boundary.process_run_id };
}

function reauthorizePreviousVerificationAdoption(
  db: Database.Database,
  input: { continuationRef: string; parentLifecycleRunId: number },
): DevelopmentVerificationAdoption | null {
  const parent = db.prepare(
    `SELECT input_snapshot FROM factory_lifecycle_runs WHERE id=?`,
  ).get(input.parentLifecycleRunId) as { input_snapshot: string } | undefined;
  if (!parent) return null;
  const parentInput = JSON.parse(parent.input_snapshot) as {
    continuation?: { verificationAdoption?: { ref?: unknown; digest?: unknown } };
  };
  const priorRef = parentInput.continuation?.verificationAdoption?.ref;
  const priorDigest = parentInput.continuation?.verificationAdoption?.digest;
  if (typeof priorRef !== 'string' || typeof priorDigest !== 'string') return null;
  const prior = db.prepare(
    `SELECT evidence_snapshot,evidence_digest
       FROM factory_development_verification_adoptions WHERE adoption_ref=?`,
  ).get(priorRef) as { evidence_snapshot: string; evidence_digest: string } | undefined;
  if (!prior || prior.evidence_digest !== priorDigest) {
    throw new Error('DEVELOPMENT_VERIFICATION_PRIOR_ADOPTION_DRIFT');
  }
  const source = JSON.parse(prior.evidence_snapshot) as VerificationAdoptionEvidence;
  if (sha256Hex(source) !== prior.evidence_digest) {
    throw new Error('DEVELOPMENT_VERIFICATION_PRIOR_ADOPTION_EVIDENCE_DRIFT');
  }
  for (const repository of source.repositories) {
    const commit = git(repository.localPath, 'rev-parse', `refs/heads/${repository.branch}`);
    const tree = git(repository.localPath, 'rev-parse', `${commit}^{tree}`);
    if (commit !== repository.commitSha || tree !== repository.treeHash) {
      throw new Error('DEVELOPMENT_VERIFICATION_PRIOR_ADOPTION_REPOSITORY_DRIFT');
    }
  }
  const evidence: VerificationAdoptionEvidence = {
    ...source,
    continuationRef: input.continuationRef,
  };
  const evidenceDigest = sha256Hex(evidence);
  const adoptionRef = `development-verification-adoption:${evidenceDigest}`;
  db.prepare(
    `INSERT INTO factory_development_verification_adoptions
      (adoption_ref,continuation_ref,source_lifecycle_run_id,source_stage_run_id,
       source_process_run_id,task_graph_ref,task_graph_hash,implementation_workset_hash,
       integrated_candidate_ref,integrated_candidate_hash,repository_snapshot,
       acceptance_snapshot,verification_method_plan_hash,evidence_snapshot,evidence_digest)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    adoptionRef,
    input.continuationRef,
    evidence.sourceLifecycleRunId,
    evidence.sourceStageRunId,
    evidence.sourceProcessRunId,
    evidence.taskGraphRef,
    evidence.taskGraph.graphHash,
    evidence.implementationWorkset.worksetHash,
    evidence.integratedCandidateRef,
    evidence.integratedCandidate.candidateHash,
    JSON.stringify(evidence.repositories),
    JSON.stringify(evidence.acceptanceCriteria),
    evidence.verificationMethodPlan.planHash,
    JSON.stringify(evidence),
    evidenceDigest,
  );
  return { adoptionRef, evidenceDigest, sourceProcessRunId: evidence.sourceProcessRunId };
}

export function createDevelopmentVerificationAdoptionHandler(
  db: Database.Database,
  deps: DevelopmentModuleInstallationDependencies,
): KernelHandler {
  return ctx => {
    const recovery = requireRecord(
      requireRecord(ctx.frame.runInput, 'development case').continuationRecovery,
      'continuation recovery',
    );
    const verificationAdoption = requireRecord(
      recovery.verificationAdoption,
      'verification adoption',
    );
    const adoptionRef = requireString(verificationAdoption.ref, 'adoption ref');
    const expectedDigest = requireString(verificationAdoption.digest, 'adoption digest');
    const row = db.prepare(
      `SELECT evidence_snapshot,evidence_digest
         FROM factory_development_verification_adoptions WHERE adoption_ref=?`,
    ).get(adoptionRef) as { evidence_snapshot: string; evidence_digest: string } | undefined;
    if (!row || row.evidence_digest !== expectedDigest) {
      throw new Error('DEVELOPMENT_VERIFICATION_ADOPTION_DRIFT');
    }
    const evidence = JSON.parse(row.evidence_snapshot) as VerificationAdoptionEvidence;
    if (sha256Hex(evidence) !== row.evidence_digest) {
      throw new Error('DEVELOPMENT_VERIFICATION_ADOPTION_EVIDENCE_DRIFT');
    }
    for (const repository of evidence.repositories) {
      const commit = git(repository.localPath, 'rev-parse', `refs/heads/${repository.branch}`);
      const tree = git(repository.localPath, 'rev-parse', `${commit}^{tree}`);
      if (commit !== repository.commitSha || tree !== repository.treeHash) {
        throw new Error('DEVELOPMENT_VERIFICATION_ADOPTION_REPOSITORY_DRIFT');
      }
    }
    const developmentCase = ctx.frame.runInput as DevelopmentCase;
    const references = deps.settlementState.adoptVerificationBaseline({
      processRunId: ctx.processRunId,
      developmentCase,
      taskGraph: evidence.taskGraph,
      implementationWorkset: evidence.implementationWorkset,
      integratedCandidate: evidence.integratedCandidate,
    });
    return {
      event: 'valid',
      production: {
        schema: 'factory.development-verification-adoption.v1',
        artifactRef: adoptionRef,
        contentHash: expectedDigest,
        semanticDigest: expectedDigest,
        bindings: {
          adoptionRef,
          taskGraph: evidence.taskGraph,
          taskGraphRef: references.taskGraph,
          verificationItems: evidence.taskGraph.verificationItems,
          candidate: evidence.integratedCandidate,
          integratedCandidateRef: references.integratedCandidate,
          implementationWorksetRef: references.implementationWorkset,
          verificationMethodPlan: evidence.verificationMethodPlan,
        },
      },
    };
  };
}

function readVerificationMethodPlan(
  db: Database.Database,
  developmentCase: DevelopmentCase,
  repositoryPath: string,
): VerificationMethodPlan {
  const ids = developmentCase.acceptanceCriteria.map(criterion => criterion.artifactId);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id,code,path,accepted_hash FROM artifacts WHERE id IN (${placeholders}) ORDER BY id`,
  ).all(...ids) as Array<{
    id: number;
    code: string | null;
    path: string | null;
    accepted_hash: string | null;
  }>;
  if (rows.length !== ids.length) {
    throw new Error('DEVELOPMENT_VERIFICATION_METHOD_SOURCE_INCOMPLETE');
  }
  const paths = [...new Set(rows.map(row => row.path?.split('#')[0] ?? null))];
  const hashes = [...new Set(rows.map(row => row.accepted_hash))];
  if (paths.length !== 1 || !paths[0] || hashes.length !== 1 || !hashes[0]) {
    throw new Error('DEVELOPMENT_VERIFICATION_METHOD_SOURCE_AMBIGUOUS');
  }
  const relativePath = paths[0]!.replaceAll('\\', '/');
  const content = readFileSync(`${repositoryPath}/${relativePath}`, 'utf8');
  const contentHash = createHash('sha256').update(content).digest('hex');
  if (contentHash !== hashes[0]) {
    throw new Error('DEVELOPMENT_VERIFICATION_METHOD_SOURCE_DRIFT');
  }
  const obligations: Array<{
    obligationId: string;
    parentCriterionCode: string;
    title: string;
    requiredMethods: string[];
  }> = [];
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^### (AC-(\d+)\.\d+):\s*(.+)$/u.exec(lines[index]!);
    if (!heading) continue;
    const methodLine = lines.slice(index + 1, index + 6)
      .find(line => line.startsWith('**Verification Method:**'));
    if (!methodLine) {
      throw new Error(`DEVELOPMENT_VERIFICATION_METHOD_MISSING:${heading[1]}`);
    }
    const methods = methodLine.slice('**Verification Method:**'.length)
      .trim()
      .split(/\s+\+\s+/u)
      .map(method => method.trim())
      .filter(Boolean);
    if (methods.length === 0) {
      throw new Error(`DEVELOPMENT_VERIFICATION_METHOD_EMPTY:${heading[1]}`);
    }
    obligations.push({
      obligationId: heading[1]!,
      parentCriterionCode: `AC-${heading[2]}`,
      title: heading[3]!.trim(),
      requiredMethods: methods,
    });
  }
  const acceptedCodes = new Set(rows.map(row => row.code));
  if (
    obligations.length === 0
    || obligations.some(item => !acceptedCodes.has(item.parentCriterionCode))
    || [...acceptedCodes].some(code =>
      !code || !obligations.some(item => item.parentCriterionCode === code))
  ) throw new Error('DEVELOPMENT_VERIFICATION_METHOD_COVERAGE_INVALID');
  const body = {
    schemaVersion: 'factory.verification-method-plan.v1' as const,
    sourceArtifactPath: relativePath,
    sourceAcceptedHash: hashes[0]!,
    obligations,
  };
  return { ...body, planHash: sha256Hex(body) };
}

function parseDevelopmentCase(snapshot: string): DevelopmentCase {
  const value = JSON.parse(snapshot) as DevelopmentCase;
  if (value.schemaVersion !== 'factory.development-case.v1') {
    throw new Error('DEVELOPMENT_VERIFICATION_ADOPTION_CASE_INVALID');
  }
  return value;
}

function git(repositoryPath: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repositoryPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`DEVELOPMENT_VERIFICATION_${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`DEVELOPMENT_VERIFICATION_${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  }
  return value;
}
