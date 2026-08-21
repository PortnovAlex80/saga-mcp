import type Database from 'better-sqlite3';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import type { ProductionCellProjectionPersistence } from '../../process-modules/application/node-executors/production-cell-node-executor.js';
import { assertValidTargetRecoveryIssue } from '../../process-modules/domain/workplace/index.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { decodeCheckDiagnostic } from '../../process-modules/domain/workplace/check-diagnostic.js';
import { decodeSeamRepairIssue } from '../../process-modules/domain/workplace/seam-repair-issue.js';
import {
  isPathOutsideAuthorityKey,
  trajectory as trajectoryBetween,
} from '../../process-modules/domain/workplace/finding-trajectory.js';
import {
  assertRecoveryIssue,
  type RecoveryIssue,
} from '../../process-modules/domain/recovery.js';
import { cellEffectRepairReceiptBody } from './sqlite-cell-final-acceptance.js';
import {
  decodeFindingsForDecision,
  SqliteGateFindingSetChain,
} from './sqlite-gate-finding-set-chain.js';

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
            || intent.objective !== input.intent.objective
            || canonicalJson(JSON.parse(intent.authority_scope))
              !== canonicalJson(input.intent.authorityScope)
            || intent.output_schema !== input.intent.outputSchema
            || intent.token_budget !== input.intent.tokenBudget
            || intent.retry_budget !== input.intent.retryBudget
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
      // K7 — the role-task projection is unique by construction (generationKey
      // `${workplaceRef}:${role}`); a duplicate would mean a broken
      // idempotence fence. Fail closed instead of silently picking the newest
      // row: this reader feeds the accepted-authority head (C5-02) and a
      // latest-wins tiebreak could bind the head to the WRONG task in a
      // repair cycle.
      const rows = db.prepare(
        `SELECT id AS taskId FROM tasks
          WHERE workplace_ref=? AND json_extract(metadata,'$.role')=?`,
      ).all(serialized, role) as Array<{ taskId: number }>;
      if (rows.length > 1) {
        throw new Error(
          `PRODUCTION_CELL_ROLE_TASK_PROJECTION_NOT_UNIQUE: ${serialized}/${role} has ${rows.length} rows`,
        );
      }
      return rows[0] ?? null;
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
  objective: string;
  authority_scope: string;
  output_schema: string;
  token_budget: number;
  retry_budget: number;
  projected_task_id: number | null;
}

function readIntent(db: Database.Database, intentId: number): IntentRow {
  const row = db.prepare(
    `SELECT id,epic_id,kind,objective,authority_scope,output_schema,
            token_budget,retry_budget,projected_task_id
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
    canonicalJson(input.authorityScope),
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
    taskTitle(db, input),
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

function taskTitle(db: Database.Database, input: PlannedTask): string {
  // The objective is the worker-facing authority text and is equality-checked
  // on replay (PRODUCTION_CELL_PLAN_BINDING_MISMATCH); the title is not. So the
  // kanban card subject is derived here from display-only fields, never by
  // editing the objective.
  if (
    input.taskKind === 'verification.ac'
    && typeof input.verificationTargetArtifactId === 'number'
  ) {
    const artifact = db.prepare('SELECT title FROM artifacts WHERE id=?')
      .get(input.verificationTargetArtifactId) as
      | { title: string | null }
      | undefined;
    if (artifact?.title) {
      return `verify ${artifact.title}`;
    }
  }
  if (input.titleSubject) {
    return input.titleSubject;
  }
  const prefix = input.titlePrefix ?? 'Production Cell: ';
  const unprefixed = input.objective.startsWith(prefix)
    ? input.objective.slice(prefix.length)
    : input.objective;
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


/**
 * SEAM-ARCHITECT Layer 2 (c) — the typed seam repair-issues behind a set of
 * check receipts, for the recovery-feedback sheet's `issue.seamIssues` slot.
 * Read through the same receipt substrate as the findings decoder: one source
 * of truth, no second authority path.
 */
export interface DecodedSeamIssue {
  readonly checkReceiptRef: string;
  readonly providerId: string;
  readonly seamKind: string;
  readonly producingTaskRef: string;
  readonly localization: {
    readonly phase: string;
    readonly substrate: string;
    readonly command?: string;
    readonly fileHints: readonly string[];
  };
  readonly evidence: {
    readonly summary: string;
    readonly digestRef: string;
  };
  readonly subjectCandidateSetRef: string;
}

export function decodeSeamIssuesForReceipts(
  db: Database.Database,
  checkReceiptRefs: readonly string[],
): DecodedSeamIssue[] {
  if (checkReceiptRefs.length === 0) return [];
  const placeholders = checkReceiptRefs.map(() => '?').join(',');
  const receipts = db.prepare(
    `SELECT check_receipt_ref,provider_id,outcome,evidence_refs
       FROM factory_check_receipts
      WHERE check_receipt_ref IN (${placeholders})
      ORDER BY check_run_ref`,
  ).all(...checkReceiptRefs) as Array<{
    check_receipt_ref: string;
    provider_id: string;
    outcome: string;
    evidence_refs: string;
  }>;
  const issues: DecodedSeamIssue[] = [];
  for (const receipt of receipts) {
    if (receipt.outcome === 'passed') continue;
    for (const ref of parseStringArray(receipt.evidence_refs)) {
      const issue = decodeSeamRepairIssue(ref);
      if (issue === null) continue;
      issues.push({
        checkReceiptRef: receipt.check_receipt_ref,
        providerId: receipt.provider_id,
        seamKind: issue.seamKind,
        producingTaskRef: issue.producingTaskRef,
        localization: issue.localization,
        evidence: issue.evidence,
        subjectCandidateSetRef: issue.subjectCandidateSetRef,
      });
    }
  }
  return issues;
}

interface GateDecisionRow {
  decision_key: string;
  decision_digest: string;
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
    `SELECT gd.decision_key,gd.decision_digest,gd.gate_run_ref,gd.gate_ref,gd.gate_phase,
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
  if (decision.verdict !== 'repair_required' || decision.repair_target_role !== role) {
    // Fix-2 — an ACCEPTED head with the author back in repair means the
    // POST-ACCEPTANCE EFFECT failed, not the gate. The typed cause lives in
    // the append-only external-effect ledger; without this branch the desk
    // feedback was wiped to null and the repair hire started blind (the
    // stopwatch case: an accepted candidate parked after
    // PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH with zero feedback).
    if (decision.verdict === 'accepted' && role === 'author') {
      return readAcceptanceEffectRecoveryFeedback(db, taskId, metadata, workplaceRef, decision);
    }
    return null;
  }
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
    // FINDING-TRAJECTORY BUDGET: decoded through the ONE shared
    // decodeFindingsForDecision — the feedback sheet and the convergence
    // budget read findings through the same decoder by construction.
    findings: decodeFindingsForDecision(
      db,
      receiptRefs,
      rejectedCandidateSetRef,
    ),
    // SEAM L2 (c): the typed seam repair-issues ride the SAME finding/rejection
    // sheet — the repair author reads the seam kind, the owning task and the
    // localized files here, not "integration failed".
    seamIssues: decodeSeamIssuesForReceipts(db, receiptRefs),
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
    // BLINDSIGHT C1a — the WHOLE same-scope finding-trajectory chain + a
    // human trajectory label ride with the sheet: the author must understand
    // the TRAJECTORY (converging/spinning/churning/scope-impossible), not
    // only the latest rejection (CONVEYOR §15: the reason sequence is the
    // signal, never the bare iteration count).
    findingTrajectory: readFindingTrajectoryForSheet(db, workplaceRef, role),
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

// ---------------------------------------------------------------------------
// BLINDSIGHT C6 — durable reviewer round history. The reviewer's prior
// verdict submissions for one workplace, read from the append-only managed
// submission ledger at PROJECTION time: the reviewer prompt must carry the
// round number, the past verdicts and the rejected author candidates, so a
// cosmetically patched resubmission is structurally visible to the only
// actor who can call it out.
// ---------------------------------------------------------------------------

export interface ReviewerRoundHistory {
  /** 1-based ordinal of the review being projected (prior verdicts + 1). */
  readonly round: number;
  readonly priorVerdicts: readonly {
    readonly round: number;
    readonly subjectCandidateSetRef: string;
    readonly verdict: 'approved' | 'changes_requested' | 'unknown';
    readonly findings: readonly string[];
    readonly submittedAt: string;
  }[];
  /** Distinct subjects of prior changes_requested verdicts, in order. */
  readonly rejectedCandidateSetRefs: readonly string[];
}

const REVIEWER_HISTORY_FINDING_CAP = 5;
const REVIEWER_HISTORY_FINDING_LENGTH = 240;

export function readReviewerRoundHistory(
  db: Database.Database,
  workplaceRef: string,
): ReviewerRoundHistory {
  const rows = db.prepare(
    `SELECT s.payload_snapshot AS payload, s.submitted_at AS submitted_at
       FROM factory_managed_node_submissions s
       JOIN tasks t ON t.id=s.task_id
      WHERE t.workplace_ref=? AND json_extract(t.metadata,'$.role')='reviewer'
      ORDER BY s.id`,
  ).all(workplaceRef) as Array<{ payload: string; submitted_at: string }>;
  const priorVerdicts: ReviewerRoundHistory['priorVerdicts'][number][] = [];
  const rejected: string[] = [];
  for (const [index, row] of rows.entries()) {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.payload) as unknown;
      payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      payload = {};
    }
    const subject = typeof payload.subject_candidate_set_ref === 'string'
      ? payload.subject_candidate_set_ref
      : '(unbound subject)';
    const verdict = payload.verdict === 'approved' || payload.verdict === 'changes_requested'
      ? payload.verdict
      : 'unknown';
    const findings = (Array.isArray(payload.findings) ? payload.findings : [])
      .map(finding => {
        if (typeof finding === 'string') return finding;
        if (finding && typeof finding === 'object' && typeof (finding as { message?: unknown }).message === 'string') {
          return (finding as { message: string }).message;
        }
        return '';
      })
      .filter(message => message.trim() !== '')
      .slice(0, REVIEWER_HISTORY_FINDING_CAP)
      .map(message => message.slice(0, REVIEWER_HISTORY_FINDING_LENGTH));
    priorVerdicts.push({
      round: index + 1,
      subjectCandidateSetRef: subject,
      verdict,
      findings,
      submittedAt: row.submitted_at,
    });
    if (verdict === 'changes_requested' && !rejected.includes(subject)) rejected.push(subject);
  }
  return {
    round: priorVerdicts.length + 1,
    priorVerdicts,
    rejectedCandidateSetRefs: rejected,
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

// ---------------------------------------------------------------------------
// BLINDSIGHT C1a — finding-trajectory delivery for the recovery-feedback
// sheet. Reads the SAME append-only factory_gate_finding_set_chain the
// convergence budget reads, with the SAME scope semantics (the latest row of
// the (workplace, role) pair derives the gate + check-plan scope; the chain
// RESETS on a check-plan change). Derived data only: excluded from the
// recoveryIssueDigest by construction.
// ---------------------------------------------------------------------------

const SHEET_CHAIN_LIMIT = 20;

export interface RecoverySheetTrajectory {
  /** The check-plan digest of the chain scope (null when no chain rows). */
  readonly scopeCheckPlanDigest: string | null;
  /** Same-scope chain rows, OLDEST first. */
  readonly chain: readonly {
    readonly gateDecisionKey: string;
    readonly digest: string;
    readonly count: number;
    readonly keys: readonly string[];
    readonly fatalKeys: readonly string[];
    readonly createdAt: string;
  }[];
  readonly label: 'first-rejection' | 'converging' | 'spinning' | 'churning' | 'scope-impossible';
  /** Human explanation of what the label MEANS for the next repair attempt. */
  readonly explanation: string;
  readonly lastTransition: {
    readonly removedKeys: readonly string[];
    readonly addedKeys: readonly string[];
  } | null;
}

function readFindingTrajectoryForSheet(
  db: Database.Database,
  workplaceRef: string,
  role: 'author' | 'reviewer',
): RecoverySheetTrajectory {
  const empty: RecoverySheetTrajectory = {
    scopeCheckPlanDigest: null,
    chain: [],
    label: 'first-rejection',
    explanation: 'First recorded rejection under the current check plan — no trajectory yet. '
      + 'Address every finding listed above.',
    lastTransition: null,
  };
  // Single blessed owner of the chain recency selector (K7/K8 freeze): the
  // scope semantics live in ONE module together with the convergence budget.
  const scope = new SqliteGateFindingSetChain(db).readScopeRows(
    workplaceRef, role, SHEET_CHAIN_LIMIT,
  );
  if (scope === null) return empty;
  const chain = scope.rows.map(row => ({
    gateDecisionKey: row.gateDecisionKey,
    digest: row.set.digest,
    count: row.set.count,
    keys: row.set.keys,
    fatalKeys: row.set.fatalKeys,
    createdAt: row.createdAt,
  }));
  const base = {
    scopeCheckPlanDigest: scope.checkPlanDigest,
    chain,
  };
  if (chain.length < 2) {
    return { ...base, ...empty, scopeCheckPlanDigest: scope.checkPlanDigest, chain };
  }
  const previous = chain[chain.length - 2]!;
  const current = chain[chain.length - 1]!;
  const removedKeys = previous.keys.filter(key => !current.keys.includes(key));
  const addedKeys = current.keys.filter(key => !previous.keys.includes(key));
  const survivingScopeKeys = current.keys
    .filter(key => previous.keys.includes(key) && isPathOutsideAuthorityKey(key));
  const label = trajectoryBetween(previous, current);
  const explanations: Record<typeof label, string> = {
    converging: `Converging: the previous rejection's finding set strictly contains this one `
      + `(${removedKeys.length} key(s) removed, none new). The defect chain is shrinking — `
      + `keep removing the remaining keys and do not reintroduce the fixed ones.`,
    spinning: `Spinning: this rejection repeats the previous finding keys exactly `
      + `(${current.keys.length} returning). Repeating the same repair will not pass — `
      + `the CAUSE behind the returning keys must change, not the symptom.`,
    churning: `Churning: ${addedKeys.length} new finding key(s) appeared and/or severity grew `
      + `vs the previous rejection. The last repair introduced new defects — re-examine `
      + `exactly what it touched.`,
    'scope-impossible': `Scope-impossible: the same path-outside-authority finding(s) survived `
      + `the repair (${survivingScopeKeys.length}). The defect lives in files this work item `
      + `must not write — a re-plan (scope re-carve) is required, not another resubmission.`,
  };
  return {
    ...base,
    label,
    explanation: explanations[label],
    lastTransition: { removedKeys, addedKeys },
  };
}

interface EffectRepairIssueRow {
  effect_repair_ref: string;
  effect_id: string;
  effect_version: string;
  effect_digest: string;
  candidate_set_ref: string;
  production_revision_ref: string;
  gate_decision_key: string;
  gate_decision_digest: string;
  acceptance_digest: string;
  expected_workplace_revision: number;
  resulting_workplace_revision: number;
  issue_snapshot: string;
  issue_digest: string;
  receipt_digest: string;
}

/** Resolve the exact immutable effect-repair issue bound to the Gate head. */
function readAcceptanceEffectRecoveryFeedback(
  db: Database.Database,
  taskId: number,
  metadata: Record<string, unknown>,
  workplaceRef: string,
  decision: GateDecisionRow,
): Record<string, unknown> | null {
  const rows = db.prepare(
    `SELECT effect_repair_ref,effect_id,effect_version,effect_digest,candidate_set_ref,
            production_revision_ref,gate_decision_key,gate_decision_digest,acceptance_digest,
            expected_workplace_revision,resulting_workplace_revision,
            issue_snapshot,issue_digest,receipt_digest
       FROM factory_cell_effect_repair_issues
      WHERE workplace_ref=? AND gate_decision_key=?`,
  ).all(workplaceRef, decision.decision_key) as EffectRepairIssueRow[];
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new Error(
      `PRODUCTION_CELL_EFFECT_REPAIR_AUTHORITY_AMBIGUOUS: ${decision.decision_key}`,
    );
  }
  const row = rows[0]!;
  if (
    row.candidate_set_ref !== decision.subject_candidate_set_ref
    || row.gate_decision_digest !== decision.decision_digest
  ) {
    throw new Error(`PRODUCTION_CELL_EFFECT_REPAIR_CANDIDATE_MISMATCH: ${row.effect_repair_ref}`);
  }
  let issue: RecoveryIssue;
  try {
    issue = JSON.parse(row.issue_snapshot) as RecoveryIssue;
  } catch {
    throw new Error(`PRODUCTION_CELL_EFFECT_REPAIR_ISSUE_INVALID: ${row.effect_repair_ref}`);
  }
  assertRecoveryIssue(issue);
  if (sha256Hex(issue) !== row.issue_digest) {
    throw new Error(`PRODUCTION_CELL_EFFECT_REPAIR_ISSUE_DIGEST_MISMATCH: ${row.effect_repair_ref}`);
  }
  const receiptBody = cellEffectRepairReceiptBody({
    workplaceRef,
    effect: {
      effectId: row.effect_id,
      version: row.effect_version,
      effectDigest: row.effect_digest,
    },
    candidateSetRef: row.candidate_set_ref,
    productionRevisionRef: row.production_revision_ref,
    gateDecisionKey: row.gate_decision_key,
    gateDecisionDigest: row.gate_decision_digest,
    acceptanceDigest: row.acceptance_digest,
    expectedWorkplaceRevision: row.expected_workplace_revision,
    resultingWorkplaceRevision: row.resulting_workplace_revision,
    issue,
  });
  if (
    sha256Hex(receiptBody) !== row.receipt_digest
    || row.effect_repair_ref !== `cell-effect-repair:${row.receipt_digest}`
  ) {
    throw new Error(`PRODUCTION_CELL_EFFECT_REPAIR_RECEIPT_MISMATCH: ${row.effect_repair_ref}`);
  }
  const context = issue.context ?? {};
  if (
    context.source !== 'acceptance-effect'
    || context.effectId !== row.effect_id
    || context.effectVersion !== row.effect_version
    || context.effectDigest !== row.effect_digest
    || context.workplaceRef !== workplaceRef
    || context.candidateSetRef !== row.candidate_set_ref
    || context.productionRevisionRef !== row.production_revision_ref
    || context.gateDecisionKey !== row.gate_decision_key
    || context.acceptanceDigest !== row.acceptance_digest
  ) {
    throw new Error(`PRODUCTION_CELL_EFFECT_REPAIR_SUBJECT_MISMATCH: ${row.effect_repair_ref}`);
  }

  const intentId = Number(metadata.work_intent_id ?? 0);
  const retry = Number.isSafeInteger(intentId) && intentId > 0
    ? db.prepare(
        'SELECT retry_budget FROM factory_work_intents WHERE id=?',
      ).get(intentId) as { retry_budget: number } | undefined
    : undefined;
  const attemptRow = db.prepare(
    `SELECT COUNT(*) AS n
       FROM factory_cell_effect_repair_issues
      WHERE workplace_ref=? AND effect_id=?`,
  ).get(workplaceRef, row.effect_id) as { n: number };

  return {
    schemaVersion: 'factory.acceptance-effect-recovery-feedback.v1',
    recoveryCaseRef: row.effect_repair_ref,
    workplaceRef,
    taskId,
    repairTargetRole: 'author',
    attempt: attemptRow.n,
    maxAttempts: retry?.retry_budget ?? null,
    source: {
      kind: 'acceptance-effect',
      effectId: row.effect_id,
      effectVersion: row.effect_version,
      effectDigest: row.effect_digest,
      repairReceiptRef: row.effect_repair_ref,
      repairReceiptDigest: row.receipt_digest,
      expectedWorkplaceRevision: row.expected_workplace_revision,
      resultingWorkplaceRevision: row.resulting_workplace_revision,
    },
    acceptedAuthority: {
      candidateSetRef: row.candidate_set_ref,
      productionRevisionRef: row.production_revision_ref,
      gateDecisionKey: row.gate_decision_key,
      gateDecisionDigest: row.gate_decision_digest,
      acceptanceDigest: row.acceptance_digest,
    },
    issueRef: row.effect_repair_ref,
    issueHash: row.issue_digest,
    issue,
  };
}

/**
 * Fix-1 — decoded finding messages of the FAILING (non-passed) check receipts
 * of one decision. Shared by the recovery-feedback collector and the
 * recovery-budget park reason so both speak the exact same decoded causes.
 */
export function decodeFailingCheckReceipts(
  db: Database.Database,
  receiptRefs: readonly string[],
): Array<{
  providerId: string;
  providerVersion: string;
  outcome: 'passed' | 'failed' | 'unknown' | 'error';
  receiptRef: string;
  messages: string[];
}> {
  if (receiptRefs.length === 0) return [];
  const placeholders = receiptRefs.map(() => '?').join(',');
  const receipts = db.prepare(
    `SELECT check_receipt_ref,provider_id,provider_version,outcome,evidence_refs
       FROM factory_check_receipts
      WHERE check_receipt_ref IN (${placeholders})
      ORDER BY check_run_ref`,
  ).all(...receiptRefs) as Array<{
    check_receipt_ref: string;
    provider_id: string;
    provider_version: string;
    outcome: 'passed' | 'failed' | 'unknown' | 'error';
    evidence_refs: string;
  }>;
  return receipts
    .filter(receipt => receipt.outcome !== 'passed')
    .map(receipt => {
      const evidenceRefs = parseStringArray(receipt.evidence_refs);
      const diagnostics = evidenceRefs
        .map(decodeCheckDiagnostic)
        .filter((value): value is NonNullable<typeof value> => value !== null);
      const messages = diagnostics.length > 0
        ? diagnostics.map(diagnostic => diagnostic.message)
        : [`Check ${receipt.provider_id}@${receipt.provider_version} returned ${receipt.outcome}.`];
      return {
        providerId: receipt.provider_id,
        providerVersion: receipt.provider_version,
        outcome: receipt.outcome,
        receiptRef: receipt.check_receipt_ref,
        messages,
      };
    });
}

/**
 * Fix-3 — count sealed CandidateSets of a role whose gate decision was
 * REJECTED (repair_required targeting that role). An ACCEPTED attempt must not
 * consume recovery budget. Author sets appear as the decision SUBJECT of an
 * author-targeted repair; reviewer sets appear in the ASSESSMENT refs of a
 * reviewer-targeted repair (invalid-output retry).
 */
export function countGateRejectedCandidateSets(
  db: Database.Database,
  workplaceRef: string,
  role: 'author' | 'reviewer',
): number {
  const decisions = db.prepare(
    `SELECT subject_candidate_set_ref AS subjectRef,
            assessment_candidate_set_refs AS assessmentRefs
       FROM factory_gate_decisions
      WHERE workplace_ref=? AND verdict='repair_required'
        AND repair_target_role=?`,
  ).all(workplaceRef, role) as Array<{
    subjectRef: string;
    assessmentRefs: string;
  }>;
  const rejected = new Set<string>();
  for (const decision of decisions) {
    if (role === 'author') {
      rejected.add(decision.subjectRef);
    } else {
      for (const ref of parseStringArray(decision.assessmentRefs)) {
        rejected.add(ref);
      }
    }
  }
  const sets = db.prepare(
    'SELECT candidate_set_ref AS ref FROM factory_candidate_sets WHERE workplace_ref=? AND role=?',
  ).all(workplaceRef, role) as Array<{ ref: string }>;
  return sets.filter(set => rejected.has(set.ref)).length;
}

/**
 * Fix-1 — decoded findings of the exact current repair GateDecision head,
 * used as the RECOVERY_BUDGET_EXHAUSTED park reason.
 */
export function readLastRepairRequiredDiagnosis(
  db: Database.Database,
  workplaceRef: string,
  role: 'author' | 'reviewer',
): {
  gateRef: string;
  decisionKey: string;
  findings: readonly string[];
  checkReceiptRefs: readonly string[];
} | null {
  const decision = db.prepare(
    `SELECT gd.decision_key,gd.gate_ref,gd.check_receipt_refs
       FROM factory_workplace_gate_decision_heads h
       JOIN factory_gate_decisions gd ON gd.decision_key=h.decision_key
      WHERE h.workplace_ref=? AND gd.verdict='repair_required'
        AND gd.repair_target_role=?`,
  ).get(workplaceRef, role) as {
    decision_key: string;
    gate_ref: string;
    check_receipt_refs: string;
  } | undefined;
  if (!decision) return null;
  const failing = decodeFailingCheckReceipts(
    db,
    parseStringArray(decision.check_receipt_refs),
  );
  return {
    gateRef: decision.gate_ref,
    decisionKey: decision.decision_key,
    findings: failing.flatMap(receipt => receipt.messages).slice(0, 20),
    checkReceiptRefs: failing.map(receipt => receipt.receiptRef),
  };
}

/**
 * Layer-3 supervision (ADR-075 + CONVEYOR §15) — the subject of the newest
 * FINAL repair_required decision for a Workplace. An author round that seals
 * the SAME immutable CandidateSet ref re-presents bytes that already carry a
 * final rejecting verdict; the executor uses this ref equality to detect the
 * identical re-seal without re-arming a reviewer that content addressing
 * would deduplicate away.
 */
export function readLatestFinalRepairRequiredSubjectSet(
  db: Database.Database,
  workplaceRef: string,
): { candidateSetRef: string; decisionKey: string } | null {
  try {
    const row = db.prepare(
      `SELECT subject_candidate_set_ref AS ref, decision_key AS decisionKey
         FROM factory_gate_decisions
        WHERE workplace_ref=? AND gate_phase='final'
          AND verdict='repair_required'
        ORDER BY rowid DESC LIMIT 1`,
    ).get(workplaceRef) as { ref: string; decisionKey: string } | undefined;
    return row ? { candidateSetRef: row.ref, decisionKey: row.decisionKey } : null;
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) return null;
    throw error;
  }
}

/**
 * Layer-3 supervision (ADR-075 + CONVEYOR §15 "budget must count spin, not
 * work") — the number of byte-identical author rounds after the first
 * rejection, from the two durable per-round facts the production loop
 * actually leaves:
 *
 * 1. reviewed cells (identical ACCEPTED re-seal): the LEADING run of
 *    identical validated_set_digest receipts on the Workplace's author task,
 *    minus the first round. Written by the worker_done submission validator
 *    (payload-contract cells).
 * 2. unreviewed cells (identical REJECTED re-submit): the author gate runs
 *    every round and REPEATS a rejecting decision for the SAME immutable
 *    subject ref — repeats beyond the first per distinct subject are the
 *    spin count (2026-08-21 discovery exhaustion finding: 40 decisions, 1
 *    distinct set, zero receipts, zero epochs).
 *
 * A real repair changes the digest/ref and stops both taxes — convergence is
 * never charged; only reason-identical rejections are. Intentionally NOT
 * epoch-baselined: identical material across a rollover is cross-epoch spin,
 * which the F6 diagnosis-repeat deny converts into an honest terminal.
 */
export function countRepairSpinResealsForAuthor(
  db: Database.Database,
  workplaceRef: string,
): number {
  let spin = 0;
  try {
    const rows = db.prepare(
      `SELECT r.validated_set_digest AS digest
         FROM factory_submission_validation_receipts r
         JOIN tasks t ON t.id=r.task_id
        WHERE t.workplace_ref=?
          AND json_extract(t.metadata,'$.role')='author'
        ORDER BY r.id DESC LIMIT 40`,
    ).all(workplaceRef) as Array<{ digest: string }>;
    let run = 0;
    for (const row of rows) {
      if (run === 0 || row.digest === rows[0]!.digest) run += 1;
      else break;
    }
    spin += Math.max(0, run - 1);
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('no such table'))) throw error;
  }
  try {
    const repeats = db.prepare(
      `SELECT COUNT(*) AS repeats
         FROM factory_gate_decisions
        WHERE workplace_ref=? AND verdict='repair_required'
          AND repair_target_role='author'
          AND subject_candidate_set_ref IN (
            SELECT subject_candidate_set_ref
              FROM factory_gate_decisions
             WHERE workplace_ref=? AND verdict='repair_required'
               AND repair_target_role='author'
             GROUP BY subject_candidate_set_ref
            HAVING COUNT(*) > 1
          )`,
    ).get(workplaceRef, workplaceRef) as { repeats: number } | undefined;
    if (repeats) {
      const distinctSubjects = db.prepare(
        `SELECT COUNT(DISTINCT subject_candidate_set_ref) AS n
           FROM factory_gate_decisions
          WHERE workplace_ref=? AND verdict='repair_required'
            AND repair_target_role='author'`,
      ).get(workplaceRef) as { n: number };
      spin += Math.max(0, repeats.repeats - distinctSubjects.n);
    }
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('no such table'))) throw error;
  }
  return spin;
}

/**
 * Fix-3 companion (QA-E16 bound) — count failed/blocked post-acceptance
 * effect repair issues whose candidate belongs to this Workplace. Since accepted
 * attempts stopped consuming recovery budget, the accept → effect-fail →
 * repair cycle needs its own durable bound: every failed action certifies one
 * completed worker attempt whose integration did not land.
 */
export function countFailedAcceptanceEffectRepairs(
  db: Database.Database,
  workplaceRef: string,
): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n
       FROM factory_cell_effect_repair_issues
      WHERE workplace_ref=?`,
  ).get(workplaceRef) as { n: number };
  return row.n;
}
