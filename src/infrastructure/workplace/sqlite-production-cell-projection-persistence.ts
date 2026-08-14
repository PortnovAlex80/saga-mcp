import type Database from 'better-sqlite3';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import type { ProductionCellProjectionPersistence } from '../../process-modules/application/node-executors/production-cell-node-executor.js';
import { assertValidTargetRecoveryIssue } from '../../process-modules/domain/workplace/index.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { decodeCheckDiagnostic } from '../../process-modules/domain/workplace/check-diagnostic.js';

/**
 * Factory-wide SQLite projection adapter for Production Cells.
 *
 * This is infrastructure owned by the Factory, not by Discovery/Formalization/
 * Development. A workshop only declares ProductionCellDefinition; every cell
 * gets the same WorkIntent/task projection and the same repair-feedback path.
 */
export function createSqliteProductionCellProjectionPersistence(
  db: Database.Database,
): Pick<
  ProductionCellProjectionPersistence,
  'ensureExecutionPlan'
  | 'bindProjectedTaskProcessContext'
  | 'readTaskProjectRepositoryId'
  | 'sealWorkplaceGraph'
  | 'readProjectedRoleTask'
> {
  return {
    ensureExecutionPlan(input) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.prepare(
          `SELECT id, json_extract(metadata, '$.work_intent_id') AS intent_id
             FROM tasks
            WHERE epic_id=? AND generation_key=?`,
        ).get(input.task.epicId, input.task.generationKey) as
          | { id: number; intent_id: number | null }
          | undefined;

        if (existing) {
          if (!existing.intent_id) {
            throw new Error(
              `PRODUCTION_CELL_PLAN_INVALID: projected task ${existing.id} has no work_intent_id`,
            );
          }
          const intent = readIntent(db, existing.intent_id);
          if (
            intent.epic_id !== input.intent.epicId
            || intent.kind !== input.intent.kind
            || intent.output_schema !== input.intent.outputSchema
          ) {
            throw new Error(
              `PRODUCTION_CELL_PLAN_BINDING_MISMATCH: ${input.task.generationKey}`,
            );
          }
          if (
            intent.projected_task_id !== null
            && intent.projected_task_id !== existing.id
          ) {
            throw new Error(
              `PRODUCTION_CELL_PLAN_TASK_MISMATCH: intent ${intent.id} is projected `
              + `to task ${intent.projected_task_id}, not ${existing.id}`,
            );
          }
          if (intent.projected_task_id === null) {
            setProjectedTask(db, intent.id, existing.id);
          }
          const reboundTaskId = ensureProjectedTask(db, {
            ...input.task,
            intentId: intent.id,
          });
          if (reboundTaskId !== existing.id) {
            throw new Error(
              `PRODUCTION_CELL_PLAN_REPLAY_MISMATCH: expected task ${existing.id}, `
              + `resolved ${reboundTaskId}`,
            );
          }
          db.exec('COMMIT');
          return { intentId: intent.id, taskId: existing.id, replayed: true };
        }

        const intentId = createIntent(db, input.intent);
        const taskId = ensureProjectedTask(db, {
          ...input.task,
          intentId,
        });
        setProjectedTask(db, intentId, taskId);
        db.exec('COMMIT');
        return { intentId, taskId, replayed: false };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
        throw error;
      }
    },

    bindProjectedTaskProcessContext(input) {
      const row = db.prepare(
        'SELECT metadata FROM tasks WHERE id=?',
      ).get(input.taskId) as { metadata: string } | undefined;
      if (!row) {
        throw new Error(`PRODUCTION_CELL_PROJECTED_TASK_NOT_FOUND: ${input.taskId}`);
      }
      const metadata = parseObject(row.metadata, input.taskId);
      const bindings: Record<string, unknown> = {
        process_run_id: input.processRunId,
        process_node_id: input.nodeId,
        process_module_ref: input.moduleRef,
        process_input_hash: input.processInputHash,
        process_node_input: input.nodeInput,
        process_node_input_hash: input.nodeInputHash,
        semantic_input_digest: input.semanticInputDigest,
      };

      // REG-19 / E2E-03..05: repair feedback is Factory-owned desk input.
      // It is deliberately NOT embedded in process_node_input: replay semantic
      // identity stays tied to business input while the exact latest rejected
      // GateDecision/CandidateSet is refreshed for the replacement execution.
      const recoveryFeedback = readCurrentProductionCellRecoveryFeedback(
        db,
        input.taskId,
        metadata,
      );
      if (recoveryFeedback !== null) {
        bindings.recovery_feedback = recoveryFeedback;
      } else if (metadata.recovery_feedback !== undefined) {
        // A later accepted gate or a non-repair role projection invalidates an
        // older defect sheet. Never leak stale repair authority to a new run.
        bindings.recovery_feedback = null;
      }

      if (
        input.projectRepositoryId !== undefined
        && input.projectRepositoryId !== null
      ) {
        bindings.project_repository_id = input.projectRepositoryId;
      }

      for (const [key, value] of Object.entries(bindings)) {
        if (
          metadata[key] !== undefined
          && canonicalJson(metadata[key]) !== canonicalJson(value)
        ) {
          const sameWorkplace =
            metadata.process_run_id === input.processRunId
            && metadata.process_node_id === input.nodeId;
          if (!sameWorkplace) {
            throw new Error(
              `PRODUCTION_CELL_METADATA_REBIND_DENIED: task ${input.taskId} metadata.${key}`,
            );
          }
        }
        metadata[key] = value;
      }

      db.prepare(
        `UPDATE tasks SET metadata=?, updated_at=datetime('now') WHERE id=?`,
      ).run(JSON.stringify(metadata), input.taskId);
    },

    readTaskProjectRepositoryId(taskId) {
      const row = db.prepare(
        'SELECT project_repository_id FROM tasks WHERE id=?',
      ).get(taskId) as { project_repository_id: number | null } | undefined;
      if (!row) throw new Error(`PRODUCTION_CELL_PROJECTED_TASK_NOT_FOUND: ${taskId}`);
      return row.project_repository_id;
    },

    readProjectedRoleTask(workplaceRef, role) {
      const serialized = serializeWorkplaceRef(workplaceRef);
      const row = db.prepare(
        `SELECT id AS taskId FROM tasks
          WHERE workplace_ref=? AND json_extract(metadata,'$.role')=?
          ORDER BY id DESC LIMIT 1`,
      ).get(serialized, role) as { taskId: number } | undefined;
      return row ?? null;
    },

    sealWorkplaceGraph(input) {
      const expectedDigest = sha256Hex({
        productionCellId: input.productionCellId,
        items: input.items.map(item => ({
          ordinal: item.ordinal,
          itemId: item.itemId,
          workplaceRef: item.workplaceRef,
          taskId: item.taskId,
          dependencyItemIds: item.dependencyItemIds,
          dependencyWorkplaceRefs: item.dependencyWorkplaceRefs,
          dependencyTaskIds: item.dependencyTaskIds,
        })),
      });
      if (
        input.graphDigest !== expectedDigest
        || input.graphRef !== `workplace-graph:${expectedDigest}`
      ) {
        throw new Error(
          `PRODUCTION_CELL_GRAPH_DIGEST_INVALID: ${input.productionCellId}`,
        );
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.prepare(
          `SELECT graph_ref,graph_digest,item_count,edge_count
             FROM factory_workplace_graphs
            WHERE process_run_id=? AND module_ref=? AND production_cell_id=?`,
        ).get(
          input.processRunId,
          input.moduleRef,
          input.productionCellId,
        ) as {
          graph_ref: string;
          graph_digest: string;
          item_count: number;
          edge_count: number;
        } | undefined;
        const edgeCount = input.items.reduce(
          (total, item) => total + item.dependencyWorkplaceRefs.length,
          0,
        );
        if (existing) {
          if (
            existing.graph_ref !== input.graphRef
            || existing.graph_digest !== input.graphDigest
            || existing.item_count !== input.items.length
            || existing.edge_count !== edgeCount
          ) {
            throw new Error(
              `PRODUCTION_CELL_GRAPH_REPLAY_MISMATCH: ${input.productionCellId}`,
            );
          }
          assertStoredGraphEquals(db, input);
        } else {
          db.prepare(
            `INSERT INTO factory_workplace_graphs
               (graph_ref,process_run_id,module_ref,production_cell_id,
                graph_digest,item_count,edge_count,sealed_at)
             VALUES (?,?,?,?,?,?,?,?)`,
          ).run(
            input.graphRef,
            input.processRunId,
            input.moduleRef,
            input.productionCellId,
            input.graphDigest,
            input.items.length,
            edgeCount,
            input.sealedAt,
          );
          const insertItem = db.prepare(
            `INSERT INTO factory_workplace_graph_items
               (graph_ref,ordinal,item_id,workplace_ref,task_id)
             VALUES (?,?,?,?,?)`,
          );
          const insertEdge = db.prepare(
            `INSERT INTO factory_workplace_dependencies
               (graph_ref,workplace_ref,depends_on_workplace_ref)
             VALUES (?,?,?)`,
          );
          for (const item of input.items) {
            insertItem.run(
              input.graphRef,
              item.ordinal,
              item.itemId,
              item.workplaceRef,
              item.taskId,
            );
            for (const dependencyRef of item.dependencyWorkplaceRefs) {
              insertEdge.run(input.graphRef, item.workplaceRef, dependencyRef);
            }
          }
        }

        // Kanban dependencies are a projection of the sealed graph. Rebuild
        // every row from the complete immutable set in this one transaction;
        // never evaluate or rewrite task status while publishing topology.
        const deleteDependencies = db.prepare(
          'DELETE FROM task_dependencies WHERE task_id=?',
        );
        const insertTaskDependency = db.prepare(
          `INSERT INTO task_dependencies (task_id,depends_on_task_id)
           VALUES (?,?)`,
        );
        for (const item of input.items) {
          deleteDependencies.run(item.taskId);
          for (const dependencyTaskId of item.dependencyTaskIds) {
            insertTaskDependency.run(item.taskId, dependencyTaskId);
          }
        }
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
        throw error;
      }
    },
  };
}

function assertStoredGraphEquals(
  db: Database.Database,
  input: Parameters<
    NonNullable<ProductionCellProjectionPersistence['sealWorkplaceGraph']>
  >[0],
): void {
  const storedItems = db.prepare(
    `SELECT ordinal,item_id,workplace_ref,task_id
       FROM factory_workplace_graph_items
      WHERE graph_ref=? ORDER BY ordinal`,
  ).all(input.graphRef) as Array<{
    ordinal: number;
    item_id: string;
    workplace_ref: string;
    task_id: number;
  }>;
  const expectedItems = input.items.map(item => ({
    ordinal: item.ordinal,
    item_id: item.itemId,
    workplace_ref: item.workplaceRef,
    task_id: item.taskId,
  }));
  const storedEdges = db.prepare(
    `SELECT workplace_ref,depends_on_workplace_ref
       FROM factory_workplace_dependencies
      WHERE graph_ref=?
      ORDER BY workplace_ref,depends_on_workplace_ref`,
  ).all(input.graphRef) as Array<{
    workplace_ref: string;
    depends_on_workplace_ref: string;
  }>;
  const expectedEdges = input.items.flatMap(item =>
    item.dependencyWorkplaceRefs.map(dependencyRef => ({
      workplace_ref: item.workplaceRef,
      depends_on_workplace_ref: dependencyRef,
    }))).sort((left, right) =>
      left.workplace_ref.localeCompare(right.workplace_ref)
      || left.depends_on_workplace_ref.localeCompare(right.depends_on_workplace_ref));
  if (
    canonicalJson(storedItems) !== canonicalJson(expectedItems)
    || canonicalJson(storedEdges) !== canonicalJson(expectedEdges)
  ) {
    throw new Error(
      `PRODUCTION_CELL_GRAPH_REPLAY_MISMATCH: ${input.productionCellId}`,
    );
  }
}

interface IntentRow {
  id: number;
  epic_id: number;
  kind: string;
  output_schema: string;
  projected_task_id: number | null;
}

function readIntent(db: Database.Database, intentId: number): IntentRow {
  const row = db.prepare(
    `SELECT id,epic_id,kind,output_schema,projected_task_id
       FROM factory_work_intents WHERE id=?`,
  ).get(intentId) as IntentRow | undefined;
  if (!row) throw new Error(`PRODUCTION_CELL_INTENT_NOT_FOUND: ${intentId}`);
  return row;
}

function createIntent(
  db: Database.Database,
  input: Parameters<ProductionCellProjectionPersistence['ensureExecutionPlan']>[0]['intent'],
): number {
  const info = db.prepare(
    `INSERT INTO factory_work_intents
       (epic_id,kind,objective,authority_scope,output_schema,token_budget,retry_budget,status)
     VALUES (?,?,?,?,?,?,?,'open')`,
  ).run(
    input.epicId,
    input.kind,
    input.objective,
    JSON.stringify(input.authorityScope),
    input.outputSchema,
    input.tokenBudget,
    input.retryBudget,
  );
  return Number(info.lastInsertRowid);
}

function setProjectedTask(
  db: Database.Database,
  intentId: number,
  taskId: number,
): void {
  db.prepare(
    `UPDATE factory_work_intents
        SET projected_task_id=?,updated_at=datetime('now') WHERE id=?`,
  ).run(taskId, intentId);
}

type PlannedTask = Parameters<
  ProductionCellProjectionPersistence['ensureExecutionPlan']
>[0]['task'] & { intentId: number };

function ensureProjectedTask(db: Database.Database, input: PlannedTask): number {
  const existing = db.prepare(
    'SELECT id,review_skill FROM tasks WHERE epic_id=? AND generation_key=?',
  ).get(input.epicId, input.generationKey) as
    | { id: number; review_skill: string | null }
    | undefined;
  if (existing) {
    if (input.reviewSkill && existing.review_skill === null) {
      db.prepare(
        `UPDATE tasks SET review_skill=?,updated_at=datetime('now') WHERE id=?`,
      ).run(input.reviewSkill, existing.id);
    } else if (
      input.reviewSkill
      && existing.review_skill !== null
      && existing.review_skill !== input.reviewSkill
    ) {
      throw new Error(
        `PRODUCTION_CELL_REVIEW_SKILL_REBIND_DENIED: task ${existing.id}`,
      );
    }
    bindArtifactProvenance(db, existing.id, input);
    return existing.id;
  }

  const repo = db.prepare(
    `SELECT id FROM project_repositories
      WHERE project_id=? AND status='active'
      ORDER BY id LIMIT 1`,
  ).get(input.projectId) as { id: number } | undefined;
  validateArtifactProvenance(db, input);
  const info = db.prepare(
    `INSERT INTO tasks
       (epic_id,title,description,status,priority,task_kind,workflow_stage,
        execution_skill,review_skill,execution_mode,project_repository_id,
        generation_key,tags,metadata,verification_target_artifact_id)
     VALUES (?, ?, ?, 'todo', 'high', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(
    input.epicId,
    taskTitle(input.titlePrefix, input.objective),
    JSON.stringify({ objective: input.objective, work_intent_id: input.intentId }),
    input.taskKind,
    input.workflowStage ?? null,
    input.executionSkill,
    input.reviewSkill ?? null,
    input.executionMode ?? 'tracker_only',
    repo?.id ?? null,
    input.generationKey,
    JSON.stringify({ ...(input.metadata ?? {}), work_intent_id: input.intentId }),
    input.verificationTargetArtifactId ?? null,
  );
  const taskId = Number(info.lastInsertRowid);
  bindArtifactProvenance(db, taskId, input);
  return taskId;
}

function taskTitle(titlePrefix: string | undefined, objective: string): string {
  const prefix = titlePrefix ?? 'Production Cell: ';
  const unprefixed = objective.startsWith(prefix)
    ? objective.slice(prefix.length)
    : objective;
  return `${prefix}${unprefixed.slice(0, 80)}`;
}

function validateArtifactProvenance(db: Database.Database, input: PlannedTask): void {
  const sourceIds = [...new Set(input.sourceArtifactIds ?? [])];
  const targetId = input.verificationTargetArtifactId ?? null;
  if (targetId !== null && input.taskKind !== 'verification.ac') {
    throw new Error(
      'PRODUCTION_CELL_VERIFICATION_TARGET_INVALID: only verification.ac may declare a target',
    );
  }
  if (input.taskKind === 'verification.ac' && targetId === null) {
    throw new Error(
      'PRODUCTION_CELL_VERIFICATION_TARGET_REQUIRED: verification.ac requires an AC target',
    );
  }
  for (const artifactId of new Set([
    ...sourceIds,
    ...(targetId === null ? [] : [targetId]),
  ])) {
    const artifact = db.prepare(
      'SELECT epic_id,type,status FROM artifacts WHERE id=?',
    ).get(artifactId) as
      | { epic_id: number; type: string; status: string }
      | undefined;
    if (!artifact || artifact.epic_id !== input.epicId || artifact.status !== 'accepted') {
      throw new Error(
        `PRODUCTION_CELL_SOURCE_ARTIFACT_INVALID: ${artifactId} must be accepted in epic ${input.epicId}`,
      );
    }
    if (
      ['development', 'verification'].includes(input.workflowStage ?? '')
      && artifact.type !== 'AC'
    ) {
      throw new Error(
        `PRODUCTION_CELL_SOURCE_ARTIFACT_NOT_AC: ${artifactId}`,
      );
    }
  }
  if (targetId !== null && !sourceIds.includes(targetId)) {
    throw new Error(
      `PRODUCTION_CELL_VERIFICATION_TARGET_NOT_SOURCE: ${targetId}`,
    );
  }
}

function bindArtifactProvenance(
  db: Database.Database,
  taskId: number,
  input: PlannedTask,
): void {
  validateArtifactProvenance(db, input);
  const targetId = input.verificationTargetArtifactId ?? null;
  const current = db.prepare(
    'SELECT verification_target_artifact_id FROM tasks WHERE id=?',
  ).get(taskId) as { verification_target_artifact_id: number | null } | undefined;
  if (!current) throw new Error(`PRODUCTION_CELL_PROJECTED_TASK_NOT_FOUND: ${taskId}`);
  if (
    current.verification_target_artifact_id !== null
    && current.verification_target_artifact_id !== targetId
  ) {
    throw new Error(
      `PRODUCTION_CELL_VERIFICATION_TARGET_REBIND_DENIED: task ${taskId}`,
    );
  }
  if (targetId !== null && current.verification_target_artifact_id === null) {
    db.prepare(
      `UPDATE tasks SET verification_target_artifact_id=?,updated_at=datetime('now') WHERE id=?`,
    ).run(targetId, taskId);
  }
  const linkType = input.workflowStage === 'development' ? 'implements' : 'depends_on';
  for (const artifactId of new Set(input.sourceArtifactIds ?? [])) {
    db.prepare(
      `INSERT OR IGNORE INTO artifact_traces
         (source_id,target_type,target_id,link_type)
       VALUES (?,'task',?,?)`,
    ).run(artifactId, taskId, linkType);
  }
}

function parseObject(raw: string, taskId: number): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* handled below */ }
  throw new Error(`PRODUCTION_CELL_TASK_METADATA_INVALID: ${taskId}`);
}

interface GateDecisionRow {
  decision_key: string;
  gate_run_ref: string;
  gate_ref: string;
  gate_phase: 'author' | 'final';
  subject_candidate_set_ref: string;
  assessment_candidate_set_refs: string;
  check_plan_ref: string;
  check_plan_digest: string;
  check_receipt_refs: string;
  verdict: string;
  repair_target_role: 'author' | 'reviewer' | null;
  recovery_issue_ref: string | null;
}

function readCurrentProductionCellRecoveryFeedback(
  db: Database.Database,
  taskId: number,
  metadata: Record<string, unknown>,
): Record<string, unknown> | null {
  const directFeedback = metadata.recovery_feedback;
  const submissionValidationFeedback =
    directFeedback
    && typeof directFeedback === 'object'
    && !Array.isArray(directFeedback)
    && (directFeedback as Record<string, unknown>).schemaVersion
      === 'factory.submission-validation-recovery-feedback.v1'
      ? directFeedback as Record<string, unknown>
      : null;
  const workplaceRef = typeof metadata.workplace_ref === 'string'
    ? metadata.workplace_ref
    : null;
  const role: 'author' | 'reviewer' | null =
    metadata.role === 'author' || metadata.role === 'reviewer'
      ? metadata.role
      : null;
  if (!workplaceRef || !role) return submissionValidationFeedback;

  // Only the explicit current GateDecision head can put a semantic defect sheet
  // on the desk. If a later decision accepted the work, stale feedback is
  // cleared even if older repair decisions still exist in the audit log.
  const decision = db.prepare(
    `SELECT gd.decision_key,gd.gate_run_ref,gd.gate_ref,gd.gate_phase,
            gd.subject_candidate_set_ref,gd.assessment_candidate_set_refs,
            gd.check_plan_ref,gd.check_plan_digest,gd.check_receipt_refs,gd.verdict,
            gd.repair_target_role,gd.recovery_issue_ref
       FROM factory_workplace_gate_decision_heads h
       JOIN factory_gate_decisions gd ON gd.decision_key=h.decision_key
      WHERE h.workplace_ref=?`,
  ).get(workplaceRef) as GateDecisionRow | undefined;
  // Submission-preflight rejection occurs before CandidateSet/GateDecision.
  // Its append-only rejection ledger is a separate authoritative repair input
  // and must survive task re-projection. Once any later gate exists, gate truth
  // owns staleness/repair and the normal decision logic below may clear it.
  if (!decision) return submissionValidationFeedback;
  if (
    decision.verdict !== 'repair_required'
    || decision.repair_target_role !== role
  ) return null;
  if (!decision.recovery_issue_ref) {
    throw new Error(
      `PRODUCTION_CELL_RECOVERY_ISSUE_REF_MISSING: decision ${decision.decision_key}`,
    );
  }

  const assessmentRefs = parseStringArray(decision.assessment_candidate_set_refs);
  const rejectedCandidateSetRef = role === 'reviewer' && assessmentRefs.length > 0
    ? assessmentRefs[assessmentRefs.length - 1]!
    : decision.subject_candidate_set_ref;
  const candidate = db.prepare(
    `SELECT candidate_set_digest,role,subject_candidate_set_ref
       FROM factory_candidate_sets WHERE candidate_set_ref=?`,
  ).get(rejectedCandidateSetRef) as
    | {
        candidate_set_digest: string;
        role: string;
        subject_candidate_set_ref: string | null;
      }
    | undefined;
  if (!candidate) {
    throw new Error(
      `PRODUCTION_CELL_RECOVERY_CANDIDATE_MISSING: ${rejectedCandidateSetRef}`,
    );
  }
  const productRefs = db.prepare(
    `SELECT product_schema,product_ref,product_digest
       FROM factory_candidate_set_members
      WHERE candidate_set_ref=? ORDER BY ordinal`,
  ).all(rejectedCandidateSetRef) as Array<{
    product_schema: string;
    product_ref: string;
    product_digest: string;
  }>;

  const receiptRefs = parseStringArray(decision.check_receipt_refs);
  if (receiptRefs.length === 0) {
    throw new Error(
      `PRODUCTION_CELL_RECOVERY_EVIDENCE_MISSING: repair decision ${decision.decision_key} has no check receipts`,
    );
  }
  const placeholders = receiptRefs.map(() => '?').join(',');
  const receipts = db.prepare(
    `SELECT check_receipt_ref,check_run_ref,provider_id,provider_version,provider_digest,
            outcome,evidence_refs
       FROM factory_check_receipts
      WHERE check_receipt_ref IN (${placeholders})
      ORDER BY check_run_ref`,
  ).all(...receiptRefs) as Array<{
    check_receipt_ref: string;
    check_run_ref: string;
    provider_id: string;
    provider_version: string;
    provider_digest: string;
    outcome: 'passed' | 'failed' | 'unknown' | 'error';
    evidence_refs: string;
  }>;
  const failing = receipts.filter(receipt => receipt.outcome !== 'passed');
  if (failing.length === 0) {
    throw new Error(
      `PRODUCTION_CELL_RECOVERY_EVIDENCE_MISSING: repair decision ${decision.decision_key} has no failing receipt`,
    );
  }

  const issueBody = {
    rejectedGateDecisionRef: decision.decision_key,
    subjectCandidateSetRef: rejectedCandidateSetRef,
    failingCheckReceiptRefs: failing.map(item => item.check_receipt_ref),
    repairTargetRole: role,
    reasonCode: `gate-${decision.gate_phase}-repair-required`,
    summary: `Gate '${decision.gate_ref}' rejected CandidateSet '${rejectedCandidateSetRef}'.`,
    findings: failing.flatMap(item => {
      const evidenceRefs = parseStringArray(item.evidence_refs);
      const diagnostics = evidenceRefs
        .map(decodeCheckDiagnostic)
        .filter((value): value is NonNullable<typeof value> => value !== null);
      if (diagnostics.length > 0) {
        return diagnostics.map(diagnostic => ({
          code: `${item.provider_id}:${diagnostic.code}`,
          severity: item.outcome === 'error' ? 'fatal' as const : 'error' as const,
          message: diagnostic.message,
          subjectRef: diagnostic.subjectRef ?? rejectedCandidateSetRef,
          evidenceRefs: [item.check_receipt_ref, ...evidenceRefs],
        }));
      }
      return [{
        code: `${item.provider_id}:${item.outcome}`,
        severity: item.outcome === 'error' ? 'fatal' as const : 'error' as const,
        message: `Check ${item.provider_id}@${item.provider_version} returned ${item.outcome}.`,
        subjectRef: rejectedCandidateSetRef,
        evidenceRefs: [item.check_receipt_ref, ...evidenceRefs],
      }];
    }),
    requiredAcceptance: failing.map(item =>
      `Check ${item.provider_id}@${item.provider_version} must return passed.`),
    allowedChanges: productRefs.map(product =>
      `${product.product_schema}:${product.product_ref}@${product.product_digest}`),
  };
  const issue = {
    recoveryIssueRef: decision.recovery_issue_ref,
    recoveryIssueDigest: sha256Hex(issueBody),
    ...issueBody,
  };
  assertValidTargetRecoveryIssue(issue);

  const intentId = Number(metadata.work_intent_id ?? 0);
  const retry = Number.isSafeInteger(intentId) && intentId > 0
    ? db.prepare(
        'SELECT retry_budget FROM factory_work_intents WHERE id=?',
      ).get(intentId) as { retry_budget: number } | undefined
    : undefined;
  const attemptRow = db.prepare(
    `SELECT COUNT(*) AS n
       FROM factory_gate_decisions
      WHERE workplace_ref=? AND gate_ref=? AND verdict='repair_required'
        AND repair_target_role=?`,
  ).get(workplaceRef, decision.gate_ref, role) as { n: number };

  return {
    schemaVersion: 'factory.production-cell-recovery-feedback.v1',
    recoveryCaseRef: `production-cell-recovery:${sha256Hex({
      workplaceRef,
      gateRef: decision.gate_ref,
      repairTargetRole: role,
    })}`,
    workplaceRef,
    taskId,
    repairTargetRole: role,
    attempt: attemptRow.n,
    maxAttempts: retry?.retry_budget ?? null,
    gateDecision: {
      decisionRef: decision.decision_key,
      gateRunRef: decision.gate_run_ref,
      gateRef: decision.gate_ref,
      gatePhase: decision.gate_phase,
      checkPlanRef: decision.check_plan_ref,
      checkPlanDigest: decision.check_plan_digest,
      checkReceiptRefs: parseStringArray(decision.check_receipt_refs),
    },
    issue,
    rejectedCandidateSet: {
      candidateSetRef: rejectedCandidateSetRef,
      candidateSetDigest: candidate.candidate_set_digest,
      role: candidate.role,
      subjectCandidateSetRef: candidate.subject_candidate_set_ref,
      productRefs: productRefs.map(product => ({
        schemaId: product.product_schema,
        ref: product.product_ref,
        digest: product.product_digest,
      })),
    },
  };
}

function parseStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}
