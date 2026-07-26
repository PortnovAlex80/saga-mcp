/**
 * SQLite-backed reference implementation of the Formalization kernel ports.
 *
 * This wires the formalization settlement policy to the EXISTING saga artifact
 * store (artifacts, artifact_traces, tasks tables). It reuses the same SQL
 * shape as the saga2 lifecycle tools (acceptedBaseline, assertTraceability,
 * assertTasksReady) — same semantics, exposed through the formalization port.
 *
 * The policy itself is in a separate class so it can be unit-tested with a
 * fake graph port (no DB needed).
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../saga3/shared/discovery-canonical.js';
import {
  FORMALIZATION_SETTLEMENT_INPUT_SCHEMA,
  type FormalizationSettlementInput,
} from './formalization-schemas.js';
import type {
  FormalizationArtifactGraphPort,
  FormalizationSettlementPolicyPort,
  FormalizationSettlementResult,
} from './formalization-kernel-ports.js';

// ---------------------------------------------------------------------------
// Artifact graph port (SQLite)
// ---------------------------------------------------------------------------

export class SqliteFormalizationArtifactGraph implements FormalizationArtifactGraphPort {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  readAcceptedArtifacts(epicId: number) {
    const rows = this.db.prepare(
      `SELECT id, type FROM artifacts
        WHERE epic_id=? AND status='accepted'
        ORDER BY id`,
    ).all(epicId) as Array<{ id: number; type: string }>;
    const byType = new Map<string, number[]>();
    for (const r of rows) {
      const list = byType.get(r.type) ?? [];
      list.push(r.id);
      byType.set(r.type, list);
    }
    return {
      prd: (byType.get('PRD') ?? [])[0] ?? null,
      frs: byType.get('FR') ?? [],
      nfrs: byType.get('NFR') ?? [],
      rules: byType.get('RULE') ?? [],
      ucs: byType.get('UC') ?? [],
      acs: byType.get('AC') ?? [],
      srs: (byType.get('SRS') ?? [])[0] ?? null,
    };
  }

  readAcceptanceBaselineHash(epicId: number) {
    // Same logic as lifecycle.ts:acceptedBaseline — refresh hashes, then check
    // status=accepted AND accepted_hash=content_hash AND drift_state=clean.
    const rows = this.db.prepare(
      `SELECT id, accepted_hash, content_hash, drift_state
        FROM artifacts
        WHERE epic_id=? AND type='AC'
        ORDER BY id`,
    ).all(epicId) as Array<{
      id: number; accepted_hash: string | null;
      content_hash: string | null; drift_state: string;
    }>;
    const dirty = rows
      .filter(r => r.accepted_hash === null
        || r.content_hash === null
        || r.accepted_hash !== r.content_hash
        || r.drift_state !== 'clean')
      .map(r => r.id);
    const hash = createHash('sha256')
      .update(rows.map(r => `${r.id}:${r.accepted_hash ?? ''}`).join('\n'))
      .digest('hex');
    return { hash, clean: dirty.length === 0, dirty };
  }

  findFirstTraceabilityGap(epicId: number) {
    const db = this.db;
    // hasEdge checks for an outgoing edge of given link_type to ANY artifact
    // of the target type. The epicId constrains the SOURCE artifact's epic;
    // the TARGET may live in a different epic (e.g. a PRD in formalization
    // tracing back to a brief in the discovery epic). The original saga2
    // lifecycle gate had the same cross-epic semantics for brief.
    const hasEdgeToType = (
      srcId: number,
      linkType: 'derived_from' | 'covers',
      targetType: 'brief' | 'PRD' | 'UC' | 'FR' | 'NFR',
    ): boolean => !!db.prepare(
      `SELECT 1 FROM artifact_traces at
        JOIN artifacts t ON t.id = at.target_id
       WHERE at.source_id=? AND at.link_type=? AND t.type=?
       LIMIT 1`,
    ).get(srcId, linkType, targetType);

    const prd = db.prepare(
      `SELECT id FROM artifacts WHERE epic_id=? AND type='PRD' ORDER BY id LIMIT 1`,
    ).get(epicId) as { id: number } | undefined;
    if (prd && !hasEdgeToType(prd.id, 'derived_from', 'brief')) {
      return {
        artifactType: 'PRD', artifactId: prd.id,
        missingEdge: 'derived_from → brief',
        description: `PRD #${prd.id} has no 'derived_from' trace to a brief artifact.`,
      };
    }

    const srs = db.prepare(
      `SELECT id FROM artifacts WHERE epic_id=? AND type='SRS' ORDER BY id LIMIT 1`,
    ).get(epicId) as { id: number } | undefined;
    if (srs && !hasEdgeToType(srs.id, 'derived_from', 'PRD')) {
      return {
        artifactType: 'SRS', artifactId: srs.id,
        missingEdge: 'derived_from → PRD',
        description: `SRS #${srs.id} has no 'derived_from' trace to PRD.`,
      };
    }

    const ucs = db.prepare(
      `SELECT id FROM artifacts WHERE epic_id=? AND type='UC' ORDER BY id`,
    ).all(epicId) as Array<{ id: number }>;
    for (const uc of ucs) {
      if (!hasEdgeToType(uc.id, 'derived_from', 'PRD')) {
        return {
          artifactType: 'UC', artifactId: uc.id,
          missingEdge: 'derived_from → PRD',
          description: `UC #${uc.id} has no 'derived_from' trace to PRD.`,
        };
      }
      if (!hasEdgeToType(uc.id, 'covers', 'FR')) {
        return {
          artifactType: 'UC', artifactId: uc.id,
          missingEdge: 'covers → FR',
          description: `UC #${uc.id} has no 'covers' trace to any FR.`,
        };
      }
    }

    const acs = db.prepare(
      `SELECT id FROM artifacts WHERE epic_id=? AND type='AC' ORDER BY id`,
    ).all(epicId) as Array<{ id: number }>;
    for (const ac of acs) {
      if (!hasEdgeToType(ac.id, 'derived_from', 'FR') && !hasEdgeToType(ac.id, 'derived_from', 'NFR')) {
        return {
          artifactType: 'AC', artifactId: ac.id,
          missingEdge: 'derived_from → FR/NFR',
          description: `AC #${ac.id} has no 'derived_from' trace to any FR or NFR.`,
        };
      }
    }
    return null;
  }

  areTasksReady(epicId: number) {
    const rows = this.db.prepare(
      `SELECT id, execution_mode, status, integration_state, task_kind
        FROM tasks WHERE epic_id=? AND workflow_stage='formalization'`,
    ).all(epicId) as Array<{
      id: number; execution_mode: string; status: string;
      integration_state: string; task_kind: string | null;
    }>;
    // Exclude bookkeeping tasks (summary/recovery) — same exclusion as lifecycle.ts.
    const gateable = rows.filter(t =>
      t.task_kind !== 'summary.stage' && t.task_kind !== 'recovery.heal');
    if (gateable.length === 0) {
      return { ready: false, blockingTaskIds: [] };
    }
    const blocking = gateable
      .filter(t => t.status !== 'done'
        || (t.execution_mode === 'git_change' && t.integration_state !== 'merged'))
      .map(t => t.id);
    return { ready: blocking.length === 0, blockingTaskIds: blocking };
  }
}

// ---------------------------------------------------------------------------
// Settlement policy (deterministic, no DB)
// ---------------------------------------------------------------------------

/**
 * The deterministic formalization settlement policy. Pure function of its
 * inputs (graph port + settlement input). It NEVER writes; it returns a
 * decision + payload that the pump persists.
 *
 * Decision matrix:
 *   - infrastructure-error → 'failed'
 *   - missing PRD/AC/SRS/baseline → 'clarification-required'
 *   - traceability gap or dirty baseline → 'inconsistent'
 *   - tasks not ready → 'inconsistent' (the graph claims done but work remains)
 *   - otherwise → 'formalized'
 *
 * 'infeasible' is reserved for cases where the SRS exists but declares a
 * constraint that cannot be met — this requires reading the SRS content, which
 * is module-specific and out of scope for the generic policy. The pump may
 * emit 'infeasible' from the architect node directly (it knows the SRS).
 */
export class ReferenceFormalizationSettlementPolicy implements FormalizationSettlementPolicyPort {
  settle(
    graph: FormalizationArtifactGraphPort,
    input: FormalizationSettlementInput,
  ): FormalizationSettlementResult {
    const epicId = input.formalizationEpicId;
    const inputHash = createHash('sha256')
      .update(canonicalJson(input))
      .digest('hex');

    // The bundle in the input MUST be self-consistent with what the graph
    // reports. If the caller lied about the bundle, that's an infrastructure
    // error.
    if (input.schemaVersion !== FORMALIZATION_SETTLEMENT_INPUT_SCHEMA) {
      return fail(inputHash, ['infrastructure-error'],
        `settlement input schema mismatch: expected ${FORMALIZATION_SETTLEMENT_INPUT_SCHEMA}, got ${input.schemaVersion}`);
    }

    const artifacts = graph.readAcceptedArtifacts(epicId);

    // WHAT-side completeness: PRD + ≥1 AC + baseline required.
    if (artifacts.prd === null) {
      return fail(inputHash, ['prd-missing'],
        'No accepted PRD artifact — the product contract is missing.');
    }
    if (artifacts.acs.length === 0) {
      return fail(inputHash, ['acceptance-empty'],
        'No accepted AC artifacts — the acceptance contract is empty.');
    }

    // Baseline must be frozen and clean.
    const baseline = graph.readAcceptanceBaselineHash(epicId);
    if (!baseline.clean) {
      return fail(inputHash, ['baseline-missing'],
        `Acceptance baseline is dirty: AC ids ${baseline.dirty.join(', ')} are not accepted+clean.`);
    }
    if (baseline.hash !== input.bundle.acceptanceBaselineHash) {
      return fail(inputHash, ['baseline-missing'],
        `Baseline hash mismatch: settlement input says '${input.bundle.acceptanceBaselineHash}', graph says '${baseline.hash}'.`);
    }

    // HOW-side completeness: SRS required.
    if (artifacts.srs === null) {
      return fail(inputHash, ['srs-missing'],
        'No accepted SRS artifact — the architecture contract is missing.');
    }

    // Traceability: the canonical edges must all exist.
    const gap = graph.findFirstTraceabilityGap(epicId);
    if (gap) {
      return fail(inputHash, ['traceability-gap'],
        `Traceability gap: ${gap.description}`);
    }

    // Tasks: all formalization tasks must be done+integrated.
    const tasks = graph.areTasksReady(epicId);
    if (!tasks.ready) {
      return fail(inputHash, ['tasks-not-ready'],
        tasks.blockingTaskIds.length > 0
          ? `Formalization tasks not ready: ${tasks.blockingTaskIds.map(id => `#${id}`).join(', ')}`
          : 'No formalization tasks exist for this episode.');
    }

    return {
      decision: 'formalized',
      reasonCodes: [],
      rationale: 'Solution contract is complete, traceable, baseline-frozen, and all formalization tasks are done.',
      inputHash,
    };
  }
}

function fail(
  inputHash: string,
  reasonCodes: FormalizationSettlementResult['reasonCodes'],
  rationale: string,
): FormalizationSettlementResult {
  return { inputHash, reasonCodes, rationale, decision: mapReasonsToDecision(reasonCodes) };
}

function mapReasonsToDecision(
  reasonCodes: FormalizationSettlementResult['reasonCodes'],
): FormalizationSettlementResult['decision'] {
  if (reasonCodes.includes('infrastructure-error')) return 'failed';
  if (reasonCodes.some(r => r === 'prd-missing' || r === 'acceptance-empty' || r === 'srs-missing')) {
    return 'clarification-required';
  }
  // baseline-missing, traceability-gap, tasks-not-ready, invariant-violation
  return 'inconsistent';
}
