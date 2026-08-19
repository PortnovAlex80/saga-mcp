/**
 * SQLite-backed reference implementation of the Formalization kernel ports.
 *
 * This wires the formalization settlement policy to the EXISTING saga artifact
 * store (artifacts, artifact_traces, tasks tables). It reuses the same SQL
 * task-readiness semantics, exposed through the formalization port, with one
 * fix: areTasksReady(epicId, lifecycleRunId) scopes the gate to the CURRENT
 * lifecycle run (TB-11 — dead-run workplaces must not poison settlement).
 *
 * The policy itself is in a separate class so it can be unit-tested with a
 * fake graph port (no DB needed).
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
// CONVEYOR Wave 7 — saga3 cross-tree leak elimination: canonicalJson is
// re-exported by the process-modules shared layer, so this module no longer
// reaches into src/saga3/shared/**.
import { canonicalJson } from '../../../shared/canonical-json.js';
import {
  FORMALIZATION_SETTLEMENT_INPUT_SCHEMA,
  type FormalizationSettlementInput,
} from '../domain/formalization-schemas.js';
import type {
  FormalizationArtifactSnapshot,
  FormalizationArtifactGraphPort,
  FormalizationCanonicalGraphPort,
  FormalizationSettlementPolicyPort,
  FormalizationSettlementResult,
  FormalizationTraceSnapshot,
} from '../domain/formalization-kernel-ports.js';

// ---------------------------------------------------------------------------
// Artifact graph port (SQLite)
// ---------------------------------------------------------------------------

export class SqliteFormalizationArtifactGraph implements
  FormalizationArtifactGraphPort,
  FormalizationCanonicalGraphPort {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  readArtifactsByIds(ids: readonly number[]): readonly FormalizationArtifactSnapshot[] {
    const unique = [...new Set(ids.filter(Number.isInteger))].sort((a, b) => a - b);
    if (unique.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT id, project_id, epic_id, type, code, status, content_hash,
              accepted_hash, drift_state, tags, metadata
         FROM artifacts
        WHERE id IN (${unique.map(() => '?').join(',')})
        ORDER BY id`,
    ).all(...unique) as Array<{
      id: number;
      project_id: number;
      epic_id: number;
      type: string;
      code: string | null;
      status: FormalizationArtifactSnapshot['status'];
      content_hash: string | null;
      accepted_hash: string | null;
      drift_state: string;
      tags: string;
      metadata: string;
    }>;
    return rows.map(row => ({
      id: row.id,
      projectId: row.project_id,
      epicId: row.epic_id,
      type: row.type,
      code: row.code,
      status: row.status,
      contentHash: row.content_hash,
      acceptedHash: row.accepted_hash,
      driftState: row.drift_state,
      tags: parseTags(row.tags),
      metadata: parseMetadata(row.metadata),
    }));
  }

  readTracesByIds(ids: readonly number[]): readonly FormalizationTraceSnapshot[] {
    const unique = [...new Set(ids.filter(Number.isInteger))].sort((a, b) => a - b);
    if (unique.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT id, source_id, target_type, target_id, link_type
         FROM artifact_traces
        WHERE id IN (${unique.map(() => '?').join(',')})
        ORDER BY id`,
    ).all(...unique) as Array<{
      id: number;
      source_id: number;
      target_type: 'artifact' | 'task';
      target_id: number;
      link_type: string;
    }>;
    return rows.map(traceRowToSnapshot);
  }

  readOutgoingArtifactTraces(
    sourceArtifactIds: readonly number[],
  ): readonly FormalizationTraceSnapshot[] {
    const unique = [...new Set(sourceArtifactIds.filter(Number.isInteger))].sort((a, b) => a - b);
    if (unique.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT id, source_id, target_type, target_id, link_type
         FROM artifact_traces
        WHERE source_id IN (${unique.map(() => '?').join(',')})
        ORDER BY id`,
    ).all(...unique) as Array<{
      id: number;
      source_id: number;
      target_type: 'artifact' | 'task';
      target_id: number;
      link_type: string;
    }>;
    return rows.map(traceRowToSnapshot);
  }

  /**
   * ADR-078 (K6): the EXACT accepted-material read — scoped to the CURRENT
   * lifecycle run through the authoritative ownership chain (artifact ->
   * managed production ledger -> process_run -> factory_stage_runs).
   * Material of other lifecycle runs under the same epic is simply not part
   * of this settlement's input. Zero lifecycle-scoped material fails closed
   * at the policy layer (empty result here), never a fallback to epic scope.
   */
  readAcceptedArtifactsForLifecycle(epicId: number, lifecycleRunId: number) {
    const rows = this.db.prepare(
      `SELECT a.id AS id, a.type AS type
         FROM artifacts a
         JOIN factory_managed_artifact_productions p ON p.artifact_id = a.id
         JOIN factory_stage_runs sr ON sr.process_run_id = p.process_run_id
        WHERE a.epic_id=? AND a.status='accepted' AND sr.lifecycle_run_id=?
        GROUP BY a.id
        ORDER BY a.id`,
    ).all(epicId, lifecycleRunId) as Array<{ id: number; type: string }>;
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

  /**
   * AC-drift network 3 seam: the accepted brief's constraint dispositions for
   * the CURRENT lifecycle run — same ownership chain as
   * {@link readAcceptedArtifactsForLifecycle}, restricted to accepted briefs.
   * Returns the parsed metadata.constraint_dispositions object, or null when
   * no accepted brief / no dispositions exist.
   */
  readBriefConstraintDispositionsForLifecycle(
    epicId: number,
    lifecycleRunId: number,
  ): Readonly<Record<string, unknown>> | null {
    const row = this.db.prepare(
      `SELECT a.metadata AS metadata
         FROM artifacts a
         JOIN factory_managed_artifact_productions p ON p.artifact_id = a.id
         JOIN factory_stage_runs sr ON sr.process_run_id = p.process_run_id
        WHERE a.epic_id=? AND a.type='brief' AND a.status='accepted'
          AND sr.lifecycle_run_id=?
        GROUP BY a.id
        ORDER BY a.id DESC
        LIMIT 1`,
    ).get(epicId, lifecycleRunId) as { metadata: string | null } | undefined;
    if (!row || typeof row.metadata !== 'string') return null;
    try {
      const parsed = JSON.parse(row.metadata) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      const dispositions = (parsed as Record<string, unknown>).constraint_dispositions;
      if (
        typeof dispositions !== 'object'
        || dispositions === null
        || Array.isArray(dispositions)
      ) return null;
      return dispositions as Readonly<Record<string, unknown>>;
    } catch {
      return null;
    }
  }

  /**
   * ADR-078 (K6): lifecycle-scoped acceptance-baseline hash — same ownership
   * chain as {@link readAcceptedArtifactsForLifecycle}, restricted to AC
   * artifacts of the CURRENT lifecycle run.
   */
  readAcceptanceBaselineHashForLifecycle(epicId: number, lifecycleRunId: number) {
    const rows = this.db.prepare(
      `SELECT a.id AS id, a.status AS status,
              a.accepted_hash AS accepted_hash,
              a.content_hash AS content_hash,
              a.drift_state AS drift_state
         FROM artifacts a
         JOIN factory_managed_artifact_productions p ON p.artifact_id = a.id
         JOIN factory_stage_runs sr ON sr.process_run_id = p.process_run_id
        WHERE a.epic_id=? AND a.type='AC' AND sr.lifecycle_run_id=?
        GROUP BY a.id
        ORDER BY a.id`,
    ).all(epicId, lifecycleRunId) as Array<{
      id: number; status: string; accepted_hash: string | null;
      content_hash: string | null; drift_state: string;
    }>;
    return this.evaluateBaselineRows(rows);
  }

  private evaluateBaselineRows(rows: ReadonlyArray<{
    id: number; status: string; accepted_hash: string | null;
    content_hash: string | null; drift_state: string;
  }>): { hash: string; clean: boolean; dirty: number[] } {
    const dirty = rows
      .filter(r => r.status !== 'accepted'
        || r.accepted_hash === null
        || r.content_hash === null
        || r.accepted_hash !== r.content_hash
        || r.drift_state !== 'clean')
      .map(r => r.id);
    const hash = createHash('sha256')
      .update(rows.map(r => `${r.id}:${r.accepted_hash ?? ''}`).join('\n'))
      .digest('hex');
    return { hash, clean: dirty.length === 0, dirty };
  }

  /**
   * ADR-78 (K7): lifecycle-scoped traceability gap check — the canonical edge
   * rules (PRD→brief, SRS→PRD, UC→PRD/FR, AC→FR/NFR/UC) evaluated over source
   * artifacts scoped to the CURRENT lifecycle run through the production
   * ledger + stage-run ownership chain. Trace TARGETS may still reference
   * material outside the lifecycle (e.g. a brief) — targets are references,
   * not settlement input. The epic-scoped variant is DELETED (K7 cleanup).
   */
  findFirstTraceabilityGapForLifecycle(epicId: number, lifecycleRunId: number) {
    const scopedIds = (type: string): number[] => {
      const rows = this.db.prepare(
        `SELECT a.id AS id
           FROM artifacts a
           JOIN factory_managed_artifact_productions p ON p.artifact_id = a.id
           JOIN factory_stage_runs sr ON sr.process_run_id = p.process_run_id
          WHERE a.epic_id=? AND a.type=? AND sr.lifecycle_run_id=?
          GROUP BY a.id
          ORDER BY a.id`,
      ).all(epicId, type, lifecycleRunId) as Array<{ id: number }>;
      return rows.map(r => r.id);
    };

    const hasEdgeToType = (
      srcId: number,
      linkType: 'derived_from' | 'covers',
      targetType: 'brief' | 'PRD' | 'UC' | 'FR' | 'NFR',
    ): boolean => !!this.db.prepare(
      `SELECT 1 FROM artifact_traces at
        JOIN artifacts t ON t.id = at.target_id
       WHERE at.source_id=? AND at.link_type=? AND t.type=?
       LIMIT 1`,
    ).get(srcId, linkType, targetType);

    const prd = scopedIds('PRD')[0];
    if (prd !== undefined && !hasEdgeToType(prd, 'derived_from', 'brief')) {
      return {
        artifactType: 'PRD', artifactId: prd,
        missingEdge: 'derived_from → brief',
        description: `PRD #${prd} has no 'derived_from' trace to a brief artifact.`,
      };
    }
    const srs = scopedIds('SRS')[0];
    if (srs !== undefined && !hasEdgeToType(srs, 'derived_from', 'PRD')) {
      return {
        artifactType: 'SRS', artifactId: srs,
        missingEdge: 'derived_from → PRD',
        description: `SRS #${srs} has no 'derived_from' trace to PRD.`,
      };
    }
    for (const uc of scopedIds('UC')) {
      if (!hasEdgeToType(uc, 'derived_from', 'PRD')) {
        return {
          artifactType: 'UC', artifactId: uc,
          missingEdge: 'derived_from → PRD',
          description: `UC #${uc} has no 'derived_from' trace to PRD.`,
        };
      }
      if (!hasEdgeToType(uc, 'covers', 'FR')) {
        return {
          artifactType: 'UC', artifactId: uc,
          missingEdge: 'covers → FR',
          description: `UC #${uc} has no 'covers' trace to any FR.`,
        };
      }
    }
    for (const ac of scopedIds('AC')) {
      const hasFr = hasEdgeToType(ac, 'derived_from', 'FR');
      const hasNfr = hasEdgeToType(ac, 'derived_from', 'NFR');
      if (!hasFr && !hasNfr) {
        return {
          artifactType: 'AC', artifactId: ac,
          missingEdge: 'derived_from → FR/NFR',
          description: `AC #${ac} has no 'derived_from' trace to any FR or NFR.`,
        };
      }
      if (hasFr && !hasEdgeToType(ac, 'derived_from', 'UC')) {
        return {
          artifactType: 'AC', artifactId: ac,
          missingEdge: 'derived_from → UC',
          description: `FR-derived AC #${ac} has no 'derived_from' trace to a UC.`,
        };
      }
    }
    return null;
  }

  areTasksReady(epicId: number, lifecycleRunId: number) {
    // Factory workplace state is the unconditional orchestration authority.
    // task's done-ness is the AUTHORITATIVE factory_workplaces loop_state (terminal
    // integration_state / execution_mode / task_kind stay on tasks (DATA
    // columns — they describe the task, not its orchestration loop state).
    //
    // TB-11 (gate poisoning): scope the gate to the CURRENT lifecycle run.
    // Workplace rows accumulate across ALL lifecycle runs of an epic; a
    // workplace frozen by a DEAD previous run (e.g. stuck in effect_pending)
    // must not block the settlement of a new run. We only join tasks to
    // workplaces whose process_run_id belongs to a stage run of the given
    // lifecycle run; tasks of older runs drop out of the join entirely and
    // are therefore not gateable for this settlement.
    interface TaskRow {
      id: number; execution_mode: string; status: string;
      loop_state: string | null;
      integration_state: string; task_kind: string | null;
    }
    const rows: TaskRow[] = this.db.prepare(
          `SELECT t.id, t.execution_mode,
                  w.kanban_phase AS status,
                  w.loop_state AS loop_state,
                  t.integration_state, t.task_kind
             FROM tasks t
             JOIN factory_workplaces w ON w.workplace_ref = t.workplace_ref
            WHERE t.epic_id=? AND t.workflow_stage='formalization'
              AND w.process_run_id IN (
                SELECT sr.process_run_id
                  FROM factory_stage_runs sr
                 WHERE sr.lifecycle_run_id=?
              )`,
        ).all(epicId, lifecycleRunId) as TaskRow[];
    // Exclude bookkeeping tasks (summary/recovery) — same exclusion as lifecycle.ts.
    const gateable = rows.filter(t =>
      t.task_kind !== 'summary.stage' && t.task_kind !== 'recovery.heal');
    if (gateable.length === 0) {
      // Fail closed: for THIS lifecycle run there is nothing to settle — the
      // policy maps this to 'No formalization tasks exist for this episode'.
      return { ready: false, blockingTaskIds: [] };
    }
    const blocking = gateable
      .filter(t => {
        // A task blocks the gate unless it is fully done. In cutover mode the
        // authoritative signal is the workplace loop_state='terminal'; in
        // is data either way.
        const isDone = t.loop_state === 'terminal';
        return !isDone
          || (t.execution_mode === 'git_change' && t.integration_state !== 'merged');
      })
      .map(t => t.id);
    return { ready: blocking.length === 0, blockingTaskIds: blocking };
  }

  readOwningLifecycleRunId(processRunId: number): number | null {
    // TB-11: the settlement handler must scope the task-readiness gate to the
    // CURRENT lifecycle run, but KernelHandlerContext carries only
    // processRunId — the owning lifecycle run id would have to be threaded
    // through the process-modules executor context, outside this module's
    // boundary. factory_stage_runs is the authoritative ownership chain
    // (process_run_id is UNIQUE there), so this exact lookup is the
    // module-local way to recover it. Null means the process run is not
    // attached to any lifecycle run — callers fail closed on that.
    const row = this.db.prepare(
      `SELECT lifecycle_run_id FROM factory_stage_runs WHERE process_run_id=?`,
    ).get(processRunId) as { lifecycle_run_id: number } | undefined;
    return row?.lifecycle_run_id ?? null;
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
 * Decision matrix (vocabulary narrowed — see W9-04-UNREACHABLE-EDGE-EVIDENCE):
 *   - infrastructure-error or missing PRD/AC/SRS/baseline → 'failed'
 *   - traceability gap or dirty baseline → 'inconsistent'
 *   - tasks not ready → 'inconsistent' (the graph claims done but work remains)
 *   - otherwise → 'formalized'
 */
export class ReferenceFormalizationSettlementPolicy implements FormalizationSettlementPolicyPort {
  settle(
    graph: FormalizationArtifactGraphPort,
    input: FormalizationSettlementInput,
    lifecycleRunId: number,
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

    // ADR-078 (K6): exact lifecycle-scoped read — dead-run material
    // cannot enter the settlement validation input.
    const artifacts = graph.readAcceptedArtifactsForLifecycle(epicId, lifecycleRunId);
    const bundle = input.bundle;
    const expectedBundleHash = createHash('sha256')
      .update(canonicalJson({
        schemaVersion: bundle.schemaVersion,
        formalizationEpicId: bundle.formalizationEpicId,
        prdArtifactId: bundle.prdArtifactId,
        frArtifactIds: bundle.frArtifactIds,
        nfrArtifactIds: bundle.nfrArtifactIds,
        ruleArtifactIds: bundle.ruleArtifactIds,
        ucArtifactIds: bundle.ucArtifactIds,
        acArtifactIds: bundle.acArtifactIds,
        acceptanceBaselineHash: bundle.acceptanceBaselineHash,
        srsArtifactId: bundle.srsArtifactId,
      }))
      .digest('hex');
    const bundleMatchesGraph =
      bundle.formalizationEpicId === epicId
      && bundle.prdArtifactId === artifacts.prd
      && bundle.srsArtifactId === artifacts.srs
      && sameIds(bundle.frArtifactIds, artifacts.frs)
      && sameIds(bundle.nfrArtifactIds, artifacts.nfrs)
      && sameIds(bundle.ruleArtifactIds, artifacts.rules)
      && sameIds(bundle.ucArtifactIds, artifacts.ucs)
      && sameIds(bundle.acArtifactIds, artifacts.acs);
    if (!bundleMatchesGraph || bundle.bundleHash !== expectedBundleHash) {
      return fail(
        inputHash,
        ['infrastructure-error'],
        'Settlement bundle is not the exact canonical graph snapshot or its hash is invalid.',
      );
    }

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
    const baseline = graph.readAcceptanceBaselineHashForLifecycle(epicId, lifecycleRunId);
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
    // ADR-78 (K7): lifecycle-scoped gap check - dead-run artifacts
    // cannot poison this settlement's traceability verdict.
    const gap = graph.findFirstTraceabilityGapForLifecycle(epicId, lifecycleRunId);
    if (gap) {
      return fail(inputHash, ['traceability-gap'],
        `Traceability gap: ${gap.description}`);
    }

    // Tasks: all formalization tasks of the CURRENT lifecycle run must be
    // done+integrated (TB-11 — dead-run workplaces must not poison the gate).
    const tasks = graph.areTasksReady(epicId, lifecycleRunId);
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
  // 'clarification-required' was deleted (declared, never produced): the
  // missing-material reasons it classified are unreachable through normal
  // production — the per-node gates enforce PRD/AC/SRS presence and the
  // accept effect re-accepts every sealed artifact. If one ever fires anyway,
  // the pipeline lied about its guarantees: that is an infrastructure
  // failure, classified 'failed' — never silently rewritten.
  if (reasonCodes.includes('infrastructure-error')) return 'failed';
  if (reasonCodes.some(r => r === 'prd-missing' || r === 'acceptance-empty' || r === 'srs-missing')) {
    return 'failed';
  }
  // baseline-missing, traceability-gap, tasks-not-ready, invariant-violation
  return 'inconsistent';
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseTags(raw: string): readonly string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === 'string')
      : [];
  } catch {
    return [];
  }
}

function traceRowToSnapshot(row: {
  id: number;
  source_id: number;
  target_type: 'artifact' | 'task';
  target_id: number;
  link_type: string;
}): FormalizationTraceSnapshot {
  return {
    id: row.id,
    sourceArtifactId: row.source_id,
    targetType: row.target_type,
    targetId: row.target_id,
    linkType: row.link_type,
  };
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.every((id, index) => id === b[index]);
}
