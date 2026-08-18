import type Database from 'better-sqlite3';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import type { LifecycleDefinition } from '../domain/lifecycle.js';
import {
  LIFECYCLE_CONTINUATION_SCHEMA,
  sliceLifecycleForContinuation,
  type InheritedLifecycleStageFrame,
} from '../domain/lifecycle-continuation.js';
import type { LifecycleRunRepository } from './lifecycle-run-repository.js';
import type {
  AuthorizeLifecycleContinuationCommand,
  ConsumeLifecycleContinuationResult,
  LifecycleContinuationAuthorization,
  LifecycleContinuationRepository,
} from './lifecycle-continuation-repository.js';

interface AuthorizationRow {
  authorization_ref: string;
  order_ref: string;
  parent_lifecycle_run_id: number;
  child_lifecycle_run_id: number | null;
  resume_stage_id: string;
  expected_parent_version: number;
  expected_parent_error: string;
  parent_definition_hash: string;
  parent_input_hash: string;
  prefix_snapshot: string;
  prefix_hash: string;
  child_definition_snapshot: string;
  child_definition_hash: string;
  child_idempotency_key: string;
  external_baseline_snapshot: string;
  external_baseline_hash: string;
  actor_id: string;
  reason: string;
  state: 'authorized' | 'consumed';
}

interface PrefixStageEvidence {
  readonly stageId: string;
  readonly frame: Readonly<Record<string, unknown>>;
  readonly authority: Readonly<Record<string, unknown>>;
}

interface PrefixEvidence {
  readonly stages: readonly PrefixStageEvidence[];
  readonly transitions: readonly unknown[];
}

/**
 * Append-only continuation authority. It does not reopen a failed aggregate:
 * it certifies an exact completed prefix and creates a new suffix LifecycleRun.
 */
export class SqliteLifecycleContinuationRepository
implements LifecycleContinuationRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly lifecycleRuns: LifecycleRunRepository,
  ) {
    this.assertSchema();
  }

  authorize(
    command: AuthorizeLifecycleContinuationCommand,
  ): LifecycleContinuationAuthorization {
    return this.db.transaction(() => {
      const parent = this.requireEligibleParent(command);
      const definition = parseDefinition(parent.definitionSnapshot);
      const slicedDefinition = sliceLifecycleForContinuation(
        definition,
        command.resumeStageId,
      );
      const childDefinition = applyStageOverrides(
        slicedDefinition,
        command.stageOverrides ?? [],
      );
      const prefix = this.buildPrefixEvidence(
        command.parentLifecycleRunId,
        definition,
        command.resumeStageId,
      );
      const prefixHash = sha256Hex(prefix);
      const childDefinitionHash = sha256Hex(childDefinition);
      const externalBaseline = command.externalBaselineSnapshot ?? {};
      const externalBaselineHash = sha256Hex(externalBaseline);
      const authorizationRef = `continuation:${sha256Hex({
        orderRef: command.orderRef,
        parentLifecycleRunId: command.parentLifecycleRunId,
        parentVersion: parent.version,
        parentError: command.expectedParentError,
        parentDefinitionHash: parent.definitionHash,
        parentInputHash: parent.inputHash,
        resumeStageId: command.resumeStageId,
        prefixHash,
        childDefinitionHash,
        stageOverrides: command.stageOverrides ?? [],
        externalBaselineHash,
        actorId: command.actorId,
        reason: command.reason,
      })}`;
      const childIdempotencyKey = `${authorizationRef}:child`;

      const existing = this.readAuthorizationByParent(
        command.parentLifecycleRunId,
      );
      if (existing) {
        if (existing.authorization_ref !== authorizationRef) {
          throw new Error(
            'CONTINUATION_PARENT_ALREADY_AUTHORIZED_WITH_DIFFERENT_EVIDENCE',
          );
        }
        return this.result(existing, true);
      }

      this.db.prepare(
        `INSERT INTO factory_continuation_authorizations
          (authorization_ref,schema_id,order_ref,parent_lifecycle_run_id,
           resume_stage_id,expected_parent_version,expected_parent_error,
           parent_definition_hash,parent_input_hash,prefix_snapshot,prefix_hash,
           child_definition_snapshot,child_definition_hash,child_idempotency_key,
           external_baseline_snapshot,external_baseline_hash,actor_id,reason,state)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'authorized')`,
      ).run(
        authorizationRef,
        LIFECYCLE_CONTINUATION_SCHEMA,
        command.orderRef,
        command.parentLifecycleRunId,
        command.resumeStageId,
        parent.version,
        command.expectedParentError,
        parent.definitionHash,
        parent.inputHash,
        canonicalJson(prefix),
        prefixHash,
        canonicalJson(childDefinition),
        childDefinitionHash,
        childIdempotencyKey,
        canonicalJson(externalBaseline),
        externalBaselineHash,
        command.actorId,
        command.reason,
      );
      for (const [ordinal, stage] of prefix.stages.entries()) {
        this.db.prepare(
          `INSERT INTO factory_continuation_prefix_stages
            (authorization_ref,ordinal,stage_id,stage_snapshot,stage_snapshot_hash)
           VALUES (?,?,?,?,?)`,
        ).run(
          authorizationRef,
          ordinal,
          stage.stageId,
          canonicalJson(stage.frame),
          sha256Hex(stage.frame),
        );
      }
      return this.result(this.requireAuthorization(authorizationRef), false);
    })();
  }

  consume(authorizationRef: string): ConsumeLifecycleContinuationResult {
    return this.db.transaction(() => {
      const row = this.requireAuthorization(authorizationRef);
      if (row.state === 'consumed') {
        if (!row.child_lifecycle_run_id) {
          throw new Error('CONTINUATION_CONSUMPTION_CORRUPT');
        }
        return this.consumedResult(row, true);
      }
      const parent = this.lifecycleRuns.read(row.parent_lifecycle_run_id);
      if (
        !parent
        || !this.isContinuableTerminal(parent, row.resume_stage_id)
        || parent.version !== row.expected_parent_version
        || this.parentTerminalEvidence(parent) !== row.expected_parent_error
        || parent.definitionHash !== row.parent_definition_hash
        || parent.inputHash !== row.parent_input_hash
      ) {
        throw new Error('CONTINUATION_PARENT_DRIFT');
      }
      this.assertNoActiveWorkers(parent.epicId);
      const definition = parseDefinition(parent.definitionSnapshot);
      const currentPrefix = this.buildPrefixEvidence(
        parent.id,
        definition,
        row.resume_stage_id,
      );
      if (sha256Hex(currentPrefix) !== row.prefix_hash) {
        throw new Error('CONTINUATION_PREFIX_DRIFT');
      }
      const childDefinition = parseDefinition(row.child_definition_snapshot);
      if (sha256Hex(childDefinition) !== row.child_definition_hash) {
        throw new Error('CONTINUATION_CHILD_DEFINITION_DRIFT');
      }
      const parentInput = parseRecord(parent.inputSnapshot, 'parent lifecycle input');
      // A continuation-of-continuation carries the original business input,
      // not the previous recovery command. The new immutable continuation
      // envelope supersedes the prior envelope while the prior authorization
      // remains in the append-only OrderRun chain.
      const { continuation: _priorContinuation, ...businessInput } = parentInput;
      const adoptionRows = this.db.prepare(
        `SELECT adoption_ref,evidence_digest
           FROM factory_production_adoption_decisions
          WHERE continuation_ref=? ORDER BY adoption_ref`,
      ).all(authorizationRef) as Array<{
        adoption_ref: string;
        evidence_digest: string;
      }>;
      const verificationAdoption = this.db.prepare(
        `SELECT adoption_ref,evidence_digest
           FROM factory_development_verification_adoptions
          WHERE continuation_ref=?`,
      ).get(authorizationRef) as {
        adoption_ref: string;
        evidence_digest: string;
      } | undefined;
      const inputPayload = {
        ...businessInput,
        continuation: {
          schemaVersion: LIFECYCLE_CONTINUATION_SCHEMA,
          authorizationRef,
          parentLifecycleRunId: parent.id,
          prefixHash: row.prefix_hash,
          externalBaseline: JSON.parse(row.external_baseline_snapshot) as unknown,
          adoptions: adoptionRows.map(adoption => ({
            ref: adoption.adoption_ref,
            digest: adoption.evidence_digest,
          })),
          verificationAdoption: verificationAdoption ? {
            ref: verificationAdoption.adoption_ref,
            digest: verificationAdoption.evidence_digest,
          } : null,
        },
      };
      const started = this.lifecycleRuns.start({
        lifecycle: childDefinition.identity,
        definitionSnapshot: row.child_definition_snapshot,
        definitionHash: row.child_definition_hash,
        entryStageId: childDefinition.entryStageId,
        input: {
          schema: parent.inputSchema,
          payload: inputPayload,
          contentHash: sha256Hex(inputPayload),
        },
        invocationContext: {
          projectId: parent.projectId,
          epicId: parent.epicId,
          initiatedBy: row.actor_id,
          idempotencyKey: row.child_idempotency_key,
        },
      });
      const ordinal = this.nextOrderOrdinal(row.order_ref);
      this.db.prepare(
        `INSERT INTO factory_order_runs
          (order_ref,lifecycle_run_id,ordinal,parent_lifecycle_run_id,kind,continuation_ref)
         VALUES (?,?,?,?, 'continuation', ?)`,
      ).run(
        row.order_ref,
        started.record.id,
        ordinal,
        row.parent_lifecycle_run_id,
        authorizationRef,
      );
      this.db.prepare(
        `UPDATE factory_continuation_authorizations
            SET state='consumed',child_lifecycle_run_id=?,consumed_at=datetime('now')
          WHERE authorization_ref=? AND state='authorized'`,
      ).run(started.record.id, authorizationRef);
      return this.consumedResult(
        this.requireAuthorization(authorizationRef),
        false,
      );
    })();
  }

  readInheritedStageFrame(
    childLifecycleRunId: number,
  ): Readonly<Record<string, unknown>> {
    return Object.fromEntries(
      this.listInheritedStages(childLifecycleRunId)
        .map(stage => [stage.stageId, stage.snapshot]),
    );
  }

  listInheritedStages(
    childLifecycleRunId: number,
  ): readonly InheritedLifecycleStageFrame[] {
    const rows = this.db.prepare(
      `SELECT p.stage_id,p.stage_snapshot,p.stage_snapshot_hash
         FROM factory_continuation_authorizations a
         JOIN factory_continuation_prefix_stages p
           ON p.authorization_ref=a.authorization_ref
        WHERE a.child_lifecycle_run_id=? AND a.state='consumed'
        ORDER BY p.ordinal`,
    ).all(childLifecycleRunId) as Array<{
      stage_id: string;
      stage_snapshot: string;
      stage_snapshot_hash: string;
    }>;
    return rows.map(row => {
      const snapshot = parseRecord(row.stage_snapshot, 'continuation stage frame');
      if (sha256Hex(snapshot) !== row.stage_snapshot_hash) {
        throw new Error(`CONTINUATION_INHERITED_STAGE_DRIFT: ${row.stage_id}`);
      }
      return {
        stageId: row.stage_id,
        snapshot,
        snapshotHash: row.stage_snapshot_hash,
      };
    });
  }

  private requireEligibleParent(command: AuthorizeLifecycleContinuationCommand) {
    const order = this.db.prepare(
      `SELECT lifecycle_run_id FROM factory_orders WHERE order_ref=?`,
    ).get(command.orderRef) as { lifecycle_run_id: number | null } | undefined;
    if (!order?.lifecycle_run_id) throw new Error('CONTINUATION_ORDER_PARENT_MISMATCH');
    this.ensureRootOrderRun(command.orderRef, order.lifecycle_run_id);
    const leaf = this.db.prepare(
      `SELECT lifecycle_run_id
         FROM factory_order_runs
        WHERE order_ref=?
        ORDER BY ordinal DESC LIMIT 1`,
    ).get(command.orderRef) as { lifecycle_run_id: number } | undefined;
    if (leaf?.lifecycle_run_id !== command.parentLifecycleRunId) {
      throw new Error('CONTINUATION_PARENT_NOT_ACTIVE_LEAF');
    }
    const parent = this.lifecycleRuns.read(command.parentLifecycleRunId);
    if (
      !parent
      || !this.isContinuableTerminal(parent, command.resumeStageId)
      || this.parentTerminalEvidence(parent) !== command.expectedParentError
    ) {
      throw new Error('CONTINUATION_PARENT_NOT_ELIGIBLE');
    }
    const lease = this.db.prepare(
      `SELECT execution_lease_owner AS owner
         FROM factory_lifecycle_runs WHERE id=?`,
    ).get(parent.id) as { owner: string | null } | undefined;
    if (lease?.owner) throw new Error('CONTINUATION_PARENT_LEASED');
    this.assertNoActiveWorkers(parent.epicId);
    return parent;
  }

  /**
   * Continuations are allowed from an infrastructure-failed leaf and from a
   * terminal business-blocked leaf. The latter is not a successful order: it
   * must be backed by an exact completed StageRun/ProcessRun whose local
   * outcome is `blocked`. This keeps terminal rows immutable while allowing a
   * corrected suffix to be appended.
   */
  private isContinuableTerminal(
    parent: NonNullable<ReturnType<LifecycleRunRepository['read']>>,
    resumeStageId: string,
  ): boolean {
    if (
      parent.status === 'failed'
      && parent.terminalStatus === 'failed'
      && parent.currentStageId === resumeStageId
    ) return true;
    if (parent.status !== 'completed' || parent.currentStageId !== null) return false;
    const boundary = this.db.prepare(
      `SELECT sr.status AS stage_status,sr.local_outcome AS stage_outcome,
              pr.id AS process_run_id,
              pr.status AS process_status,pr.local_outcome AS process_outcome
         FROM factory_stage_runs sr
         JOIN factory_process_runs pr ON pr.id=sr.process_run_id
        WHERE sr.lifecycle_run_id=? AND sr.stage_id=?
        ORDER BY sr.attempt DESC,sr.id DESC LIMIT 1`,
    ).get(parent.id, resumeStageId) as {
      stage_status: string;
      stage_outcome: string | null;
      process_run_id: number;
      process_status: string;
      process_outcome: string | null;
    } | undefined;
    if (boundary?.stage_status !== 'completed'
      || boundary.process_status !== 'completed') return false;
    if (
      boundary.stage_outcome === 'blocked'
      && boundary.process_outcome === 'blocked'
    ) return true;
    if (
      boundary.stage_outcome === 'approval-required'
      && boundary.process_outcome === 'approval-required'
    ) {
      const certificate = readSingleOutcomeReasonCodes(this.db, boundary.process_run_id);
      if (!certificate) return false;
      try {
        const reasonCodes = JSON.parse(certificate.reason_codes) as unknown;
        return Array.isArray(reasonCodes)
          && reasonCodes.length === 1
          && reasonCodes[0] === 'operator-authorization-missing';
      } catch {
        return false;
      }
    }
    if (
      boundary.stage_outcome !== 'failed'
      || boundary.process_outcome !== 'failed'
    ) return false;
    const certificate = readSingleOutcomeReasonCodes(this.db, boundary.process_run_id);
    if (!certificate) return false;
    try {
      const reasonCodes = JSON.parse(certificate.reason_codes) as unknown;
      return Array.isArray(reasonCodes)
        && reasonCodes.length === 1
        && reasonCodes[0] === 'infrastructure-error';
    } catch {
      return false;
    }
  }

  private parentTerminalEvidence(
    parent: NonNullable<ReturnType<LifecycleRunRepository['read']>>,
  ): string {
    return parent.error
      ?? `TERMINAL_OUTCOME:${parent.terminalStatus ?? 'missing'}`;
  }

  private assertNoActiveWorkers(epicId: number | null): void {
    if (epicId === null) return;
    const active = this.db.prepare(
      `SELECT COUNT(*) AS count FROM worker_executions
        WHERE epic_id=? AND state IN ('reserved','running','cancel_requested')`,
    ).get(epicId) as { count: number };
    if (active.count !== 0) throw new Error('CONTINUATION_ACTIVE_WORKERS');
  }

  private buildPrefixEvidence(
    lifecycleRunId: number,
    definition: LifecycleDefinition,
    resumeStageId: string,
  ): PrefixEvidence {
    const resumeIndex = definition.stages.findIndex(stage => stage.id === resumeStageId);
    if (resumeIndex < 0) throw new Error('CONTINUATION_RESUME_STAGE_UNKNOWN');
    const inherited = this.readPriorPrefixEvidence(lifecycleRunId, definition);
    const expected = definition.stages.slice(0, resumeIndex);
    const stageRuns = this.lifecycleRuns.listStageRuns(lifecycleRunId);
    const localStages = expected.map(binding => {
      const matches = stageRuns.filter(
        stage => stage.stageId === binding.id && stage.status === 'completed',
      );
      if (matches.length !== 1) {
        throw new Error(
          `CONTINUATION_PREFIX_NOT_EXACT: stage ${binding.id} has ${matches.length} completed runs`,
        );
      }
      const stage = matches[0]!;
      if (!stage.mappedOutput || !stage.resultSnapshot || !stage.processRunId) {
        throw new Error(`CONTINUATION_PREFIX_STAGE_INCOMPLETE: ${binding.id}`);
      }
      return {
        stageId: binding.id,
        frame: {
          ...stage.mappedOutput,
          stageRunId: stage.id,
          processRunId: stage.processRunId,
          processOutcome: stage.resultSnapshot,
        },
        authority: {
          stageRunId: stage.id,
          processRunId: stage.processRunId,
          bindingHash: stage.bindingHash,
          inputHash: stage.inputHash,
          output: stage.output,
          certificate: stage.certificate,
          localOutcome: stage.localOutcome,
          authority: stage.authority,
        },
      };
    });
    const stageRunIds = new Set(localStages.map(stage => stage.authority.stageRunId));
    const localTransitions = this.lifecycleRuns.listTransitions(lifecycleRunId)
      .filter(transition => stageRunIds.has(transition.fromStageRunId))
      .map(transition => ({
        fromStageRunId: transition.fromStageRunId,
        outcome: transition.outcome,
        target: transition.target,
        handoffHash: transition.handoffHash,
        decisionHash: transition.decisionHash,
      }));
    if (expected.length > 0 && localTransitions.length !== expected.length) {
      throw new Error('CONTINUATION_PREFIX_TRANSITIONS_INCOMPLETE');
    }
    return {
      stages: [...inherited.stages, ...localStages],
      transitions: [...inherited.transitions, ...localTransitions],
    };
  }

  private readPriorPrefixEvidence(
    lifecycleRunId: number,
    definition: LifecycleDefinition,
  ): PrefixEvidence {
    const descriptors = definition.inheritedStages ?? [];
    const row = this.db.prepare(
      `SELECT prefix_snapshot,prefix_hash
         FROM factory_continuation_authorizations
        WHERE child_lifecycle_run_id=? AND state='consumed'`,
    ).get(lifecycleRunId) as {
      prefix_snapshot: string;
      prefix_hash: string;
    } | undefined;
    if (!row) {
      if (descriptors.length > 0) {
        throw new Error('CONTINUATION_INHERITED_PREFIX_AUTHORITY_MISSING');
      }
      return { stages: [], transitions: [] };
    }
    const parsed = parsePrefixEvidence(row.prefix_snapshot);
    if (sha256Hex(parsed) !== row.prefix_hash) {
      throw new Error('CONTINUATION_INHERITED_PREFIX_DRIFT');
    }
    const descriptorIds = descriptors.map(stage => stage.id);
    const evidenceIds = parsed.stages.map(stage => stage.stageId);
    if (canonicalJson(descriptorIds) !== canonicalJson(evidenceIds)) {
      throw new Error('CONTINUATION_INHERITED_PREFIX_DEFINITION_MISMATCH');
    }
    const verifiedFrames = this.listInheritedStages(lifecycleRunId);
    if (
      canonicalJson(verifiedFrames.map(stage => ({
        stageId: stage.stageId,
        snapshot: stage.snapshot,
      })))
      !== canonicalJson(parsed.stages.map(stage => ({
        stageId: stage.stageId,
        snapshot: stage.frame,
      })))
    ) {
      throw new Error('CONTINUATION_INHERITED_PREFIX_FRAME_MISMATCH');
    }
    return parsed;
  }

  private ensureRootOrderRun(orderRef: string, lifecycleRunId: number): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO factory_order_runs
        (order_ref,lifecycle_run_id,ordinal,parent_lifecycle_run_id,kind,continuation_ref)
       VALUES (?,?,0,NULL,'root',NULL)`,
    ).run(orderRef, lifecycleRunId);
    const root = this.db.prepare(
      `SELECT lifecycle_run_id FROM factory_order_runs
        WHERE order_ref=? AND ordinal=0`,
    ).get(orderRef) as { lifecycle_run_id: number } | undefined;
    if (root?.lifecycle_run_id !== lifecycleRunId) {
      throw new Error('CONTINUATION_ORDER_ROOT_DRIFT');
    }
  }

  private nextOrderOrdinal(orderRef: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(ordinal),-1)+1 AS ordinal
         FROM factory_order_runs WHERE order_ref=?`,
    ).get(orderRef) as { ordinal: number };
    return row.ordinal;
  }

  private readAuthorizationByParent(parentLifecycleRunId: number): AuthorizationRow | null {
    const row = this.db.prepare(
      `SELECT * FROM factory_continuation_authorizations
        WHERE parent_lifecycle_run_id=?`,
    ).get(parentLifecycleRunId) as AuthorizationRow | undefined;
    return row ?? null;
  }

  private requireAuthorization(authorizationRef: string): AuthorizationRow {
    const row = this.db.prepare(
      `SELECT * FROM factory_continuation_authorizations WHERE authorization_ref=?`,
    ).get(authorizationRef) as AuthorizationRow | undefined;
    if (!row) throw new Error('CONTINUATION_AUTHORIZATION_NOT_FOUND');
    return row;
  }

  private result(row: AuthorizationRow, replayed: boolean): LifecycleContinuationAuthorization {
    const childDefinition = parseDefinition(row.child_definition_snapshot);
    return {
      authorizationRef: row.authorization_ref,
      orderRef: row.order_ref,
      parentLifecycleRunId: row.parent_lifecycle_run_id,
      childLifecycleRunId: row.child_lifecycle_run_id,
      resumeStageId: row.resume_stage_id,
      prefixHash: row.prefix_hash,
      childDefinition,
      childDefinitionHash: row.child_definition_hash,
      childIdempotencyKey: row.child_idempotency_key,
      state: row.state,
      replayed,
    };
  }

  private consumedResult(
    row: AuthorizationRow,
    replayed: boolean,
  ): ConsumeLifecycleContinuationResult {
    const result = this.result(row, replayed);
    if (!result.childLifecycleRunId) throw new Error('CONTINUATION_CHILD_MISSING');
    return { ...result, childLifecycleRunId: result.childLifecycleRunId };
  }

  private assertSchema(): void {
    for (const table of [
      'factory_orders',
      'factory_order_runs',
      'factory_continuation_authorizations',
      'factory_continuation_prefix_stages',
    ]) {
      const row = this.db.prepare(
        `SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?`,
      ).get(table);
      if (!row) throw new Error(`CONTINUATION_SCHEMA_MISSING: ${table}`);
    }
  }
}

function parseDefinition(snapshot: string): LifecycleDefinition {
  const parsed = JSON.parse(snapshot) as LifecycleDefinition;
  if (
    !parsed
    || typeof parsed !== 'object'
    || !parsed.identity
    || !Array.isArray(parsed.stages)
  ) {
    throw new Error('CONTINUATION_DEFINITION_INVALID');
  }
  return parsed;
}

function applyStageOverrides(
  definition: LifecycleDefinition,
  overrides: NonNullable<AuthorizeLifecycleContinuationCommand['stageOverrides']>,
): LifecycleDefinition {
  const byId = new Map(overrides.map(override => [override.stageId, override]));
  if (byId.size !== overrides.length) {
    throw new Error('CONTINUATION_STAGE_OVERRIDE_DUPLICATE');
  }
  for (const stageId of byId.keys()) {
    if (!definition.stages.some(stage => stage.id === stageId)) {
      throw new Error(`CONTINUATION_STAGE_OVERRIDE_OUTSIDE_SUFFIX: ${stageId}`);
    }
  }
  return {
    ...definition,
    stages: definition.stages.map(stage => {
      const override = byId.get(stage.id);
      if (!override) return stage;
      return {
        ...stage,
        moduleRef: { ...override.moduleRef },
        inputMapping: {
          ...stage.inputMapping,
          ...(override.additiveInputMapping ?? {}),
        },
      };
    }),
  };
}

function parseRecord(snapshot: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(snapshot) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function parsePrefixEvidence(snapshot: string): PrefixEvidence {
  const parsed = JSON.parse(snapshot) as Partial<PrefixEvidence>;
  if (!parsed || !Array.isArray(parsed.stages) || !Array.isArray(parsed.transitions)) {
    throw new Error('CONTINUATION_PREFIX_SNAPSHOT_INVALID');
  }
  for (const stage of parsed.stages) {
    if (
      !stage
      || typeof stage !== 'object'
      || typeof stage.stageId !== 'string'
      || !stage.frame
      || typeof stage.frame !== 'object'
      || Array.isArray(stage.frame)
      || !stage.authority
      || typeof stage.authority !== 'object'
      || Array.isArray(stage.authority)
    ) {
      throw new Error('CONTINUATION_PREFIX_SNAPSHOT_INVALID');
    }
  }
  return parsed as PrefixEvidence;
}

/**
 * ADR-079 — the outcome-certificate reader for a process run. A terminal
 * ProcessRun owns exactly one outcome certificate; the table enforces
 * uniqueness by certificate_hash (content) but NOT by process_run_id, so a
 * duplicate run-scoped row is an invariant violation that must fail closed —
 * never silently resolve to the newest row.
 */
export function readSingleOutcomeReasonCodes(
  db: Database.Database,
  processRunId: number,
): { reason_codes: string } | null {
  const rows = db.prepare(
    `SELECT reason_codes FROM factory_process_outcome_certificates
      WHERE process_run_id=?`,
  ).all(processRunId) as Array<{ reason_codes: string }>;
  if (rows.length > 1) {
    throw new Error(
      `OUTCOME_CERTIFICATE_NOT_UNIQUE: process run ${processRunId} has ${rows.length} certificates`,
    );
  }
  return rows[0] ?? null;
}
