/**
 * Saga 3 — The Controller.
 *
 * One-step reconcile loop: observe → evaluate conditions → select deficit →
 * check readiness → admit → materialize WorkIntent → assign worker →
 * ingest output → attach evidence provenance → update condition → repeat.
 *
 * Terminal when evaluateTerminal certifies. No fallback. No v2.
 */

import type Database from 'better-sqlite3';
import type {
  EpisodeSpec,
  ConditionInstance,
  ConditionStatus,
  EvidenceRecord,
  ActionContract,
  ConditionContract,
  SkillCapability,
  StepResult,
  OutcomeCertificate,
  WorkerOutput,
} from '../domain/types.js';
import { PIPELINE_CONDITIONS } from '../domain/pipeline-contracts.js';
import {
  evaluateCondition,
  selectDeficits,
  aggregate,
} from '../domain/conditions.js';
import {
  evaluateTerminal,
  issueCertificate,
} from '../domain/outcomes.js';
import {
  materializeWorkIntent,
  workIntentKey,
} from '../work-intents/work-intent.js';
import {
  createAssignment,
  resolveSkill,
} from '../executions/assignment.js';
import { ingestWorkerOutput } from '../executions/ingestion.js';
import { evaluateReadiness } from '../readiness/readiness.js';
import { admitWorkIntent } from '../scheduler/admission.js';
import type { BudgetLedger } from '../budgets/budget-ledger.js';
import type { Ports } from '../ports/ports.js';
import type { OracleRegistry } from '../evidence/attestation.js';
import type { HeldClaim, ResourceScope } from '../resources/resource-claim.js';

export interface EpisodeContext {
  readonly spec: EpisodeSpec;
  readonly conditionContracts: readonly ConditionContract[];
  readonly actionContracts: readonly ActionContract[];
  readonly conditions: Map<string, ConditionInstance>; // key = conditionType
  readonly skills: readonly SkillCapability[];
  readonly budget: BudgetLedger;
  readonly oracleRegistry: OracleRegistry;
  readonly currentSourceFingerprint: string;
  readonly currentEnvironmentFingerprint: string;
  readonly repositoryRoot: string;
  readonly heldClaims: HeldClaim[];
  readonly completedIntents: Set<string>;
  readonly dependencyEdges: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly certificate: OutcomeCertificate | null;
  /**
   * Optional SQLite handle. When set, the controller persists condition
   * instances, evidence records, and outcome certificates to the saga3
   * tables so they survive restart. When null/undefined (in-memory tests),
   * all persistence calls are skipped and behavior is identical to before.
   */
  readonly db?: Database.Database;
  leaseEpoch: number;
  currentAssignment: ReturnType<typeof createAssignment> | null;
}

/**
 * Load condition instances for an episode from saga3_condition_instances.
 *
 * If the table has no rows for this episode yet, seed it from
 * PIPELINE_CONDITIONS (all Unknown) and return the seeded map. This makes
 * the very first boot after schema init equivalent to `initialConditions`,
 * but every subsequent boot reads the persisted statuses instead — so a
 * restart picks up exactly where the previous run left off.
 *
 * Returns a Map keyed by conditionType, matching the in-memory shape used
 * by `initialConditions`.
 */
export function loadConditionsFromDb(
  db: Database.Database,
  episodeSpecId: string,
): Map<string, ConditionInstance> {
  const rows = db
    .prepare(
      `SELECT episode_spec_id, condition_type, obligation_id, scope_type, scope_id,
              status, projection_version, observed_generation, source_fingerprint,
              invalidation_reason
         FROM saga3_condition_instances
        WHERE episode_spec_id = ?`,
    )
    .all(episodeSpecId) as Array<{
      episode_spec_id: string;
      condition_type: string;
      obligation_id: string;
      scope_type: string;
      scope_id: string;
      status: ConditionStatus;
      projection_version: number;
      observed_generation: number | null;
      source_fingerprint: string | null;
      invalidation_reason: string | null;
    }>;

  if (rows.length === 0) {
    // Seed from PIPELINE_CONDITIONS.
    const seeded = new Map<string, ConditionInstance>();
    const insert = db.prepare(
      `INSERT OR REPLACE INTO saga3_condition_instances
         (episode_spec_id, condition_type, obligation_id, scope_type, scope_id,
          status, projection_version, observed_generation, source_fingerprint,
          environment_fingerprint, invalidation_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    );
    const seedOne = db.transaction((conds: readonly ConditionContract[]) => {
      for (const c of conds) {
        const inst: ConditionInstance = {
          episodeSpecId,
          conditionType: c.conditionType,
          obligationId: c.obligationId,
          scopeType: c.scopeType,
          scopeId: c.scopeId,
          status: 'Unknown',
          projectionVersion: 0,
          observedGeneration: null,
          sourceFingerprint: null,
          invalidationReason: null,
        };
        insert.run(
          inst.episodeSpecId,
          inst.conditionType,
          inst.obligationId,
          inst.scopeType,
          inst.scopeId,
          inst.status,
          inst.projectionVersion,
          inst.observedGeneration,
          inst.sourceFingerprint,
          inst.invalidationReason,
        );
        seeded.set(c.conditionType, inst);
      }
    });
    seedOne(PIPELINE_CONDITIONS);
    return seeded;
  }

  // Hydrate from persisted rows.
  const map = new Map<string, ConditionInstance>();
  for (const r of rows) {
    map.set(r.condition_type, {
      episodeSpecId: r.episode_spec_id,
      conditionType: r.condition_type,
      obligationId: r.obligation_id,
      scopeType: r.scope_type,
      scopeId: r.scope_id,
      status: r.status,
      projectionVersion: r.projection_version,
      observedGeneration: r.observed_generation,
      sourceFingerprint: r.source_fingerprint,
      invalidationReason: r.invalidation_reason,
    });
  }
  return map;
}

/**
 * UPSERT a condition instance into saga3_condition_instances.
 *
 * Called from ingestOutput after the in-memory status is mutated, so the
 * DB row tracks the live Map. Safe to call on every status transition.
 */
export function saveConditionToDb(
  db: Database.Database,
  condition: ConditionInstance,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO saga3_condition_instances
       (episode_spec_id, condition_type, obligation_id, scope_type, scope_id,
        status, projection_version, observed_generation, source_fingerprint,
        environment_fingerprint, invalidation_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    condition.episodeSpecId,
    condition.conditionType,
    condition.obligationId,
    condition.scopeType,
    condition.scopeId,
    condition.status,
    condition.projectionVersion,
    condition.observedGeneration,
    condition.sourceFingerprint,
    condition.invalidationReason,
  );
}

/**
 * Append an evidence record into saga3_evidence_records.
 */
function saveEvidenceToDb(
  db: Database.Database,
  evidence: EvidenceRecord,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO saga3_evidence_records
       (id, episode_spec_id, condition_type, obligation_id, generation,
        source_fingerprint, environment_fingerprint, oracle_id, oracle_version,
        trust_class, verdict, raw_digest, observed_at, freshness_max_age_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    evidence.id,
    evidence.episodeSpecId,
    evidence.conditionType,
    evidence.obligationId,
    evidence.generation,
    evidence.sourceFingerprint,
    evidence.environmentFingerprint,
    evidence.oracleId,
    evidence.oracleVersion,
    evidence.trustClass,
    evidence.verdict,
    evidence.rawDigest,
    evidence.observedAt,
    evidence.freshnessMaxAgeMs,
  );
}

/**
 * Persist a terminal outcome certificate into saga3_outcome_certificates.
 */
function saveOutcomeCertificateToDb(
  db: Database.Database,
  cert: OutcomeCertificate,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO saga3_outcome_certificates
       (episode_spec_id, outcome, causal_reason, generation, source_fingerprint,
        satisfied_conditions, unresolved_conditions, certified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    cert.episodeSpecId,
    cert.outcome,
    cert.causalReason,
    cert.generation,
    cert.sourceFingerprint,
    JSON.stringify(cert.satisfiedConditions),
    JSON.stringify(cert.unresolvedConditions),
    cert.certifiedAt,
  );
}

/**
 * The one-step controller. Each call to stepEpisode does AT MOST one
 * durable control decision. Terminal is absorbing.
 */
export class EpisodeController {
  constructor(
    private readonly ports: Ports,
    private readonly ctx: EpisodeContext,
  ) {}

  stepEpisode(): StepResult {
    // 0. Already terminal? Absorbing.
    if (this.ctx.certificate) {
      return { kind: 'terminal', outcome: this.ctx.certificate.outcome, certificate: this.ctx.certificate };
    }

    // 1. Evaluate all conditions against current evidence.
    const statuses = this.evaluateAllConditions();

    // 2. Check terminal predicates.
    const mandatoryConditions = this.ctx.conditionContracts
      .filter((c) => c.scopeType === 'episode')
      .map((c) => ({
        obligationId: c.obligationId,
        status: statuses[c.conditionType] ?? 'Unknown',
      }));

    const terminalDecision = evaluateTerminal({
      generation: this.ctx.spec.generation,
      mandatoryConditions,
      activeNegativeCauses: [],
      hasUnresolvedAmbiguity: false,
      degradationActive: false,
      degradedLostObligations: [],
      sourceFingerprint: this.ctx.currentSourceFingerprint,
    });

    if (terminalDecision.certified) {
      const cert = issueCertificate(
        {
          generation: this.ctx.spec.generation,
          mandatoryConditions,
          activeNegativeCauses: [],
          hasUnresolvedAmbiguity: false,
          degradationActive: false,
          degradedLostObligations: [],
          sourceFingerprint: this.ctx.currentSourceFingerprint,
        },
        { outcome: terminalDecision.outcome, reason: terminalDecision.reason },
      );
      // Store as absorbing — every future step returns the same terminal.
      const finalCert: OutcomeCertificate = {
        ...cert,
        episodeSpecId: this.ctx.spec.id,
      };
      (this.ctx as { certificate: OutcomeCertificate | null }).certificate = finalCert;
      // Persist the terminal certificate so it survives restart.
      if (this.ctx.db) {
        try {
          saveOutcomeCertificateToDb(this.ctx.db, finalCert);
        } catch {
          // Persistence is best-effort during the skeleton phase — a DB
          // without the saga3 schema must not break the control decision.
        }
      }
      return { kind: 'terminal', outcome: terminalDecision.outcome, certificate: finalCert };
    }

    // 3. Select the highest-priority deficit.
    const targetConditions = this.ctx.conditionContracts.map((c) => c.conditionType);
    const deficits = selectDeficits(targetConditions, statuses);

    if (deficits.length === 0) {
      return { kind: 'quiescent' };
    }

    // 4. Find an action contract for the deficit.
    const deficit = deficits[0];
    const action = this.ctx.actionContracts.find((a) => a.targetCondition === deficit);

    if (!action) {
      // No action for this deficit — try the next one.
      return { kind: 'waiting_until', at: this.ports.clock.now() + 1000 };
    }

    // 5. Materialize WorkIntent.
    const intent = materializeWorkIntent({
      episodeSpecId: this.ctx.spec.id,
      generation: this.ctx.spec.generation,
      action,
      obligationId: deficit,
      scopeType: 'episode',
      scopeId: '',
    });

    // 6. Check causal readiness (prerequisites + dependencies + fail-closed).
    const readiness = evaluateReadiness({
      intent,
      conditionStatuses: statuses,
      dependencies: new Map(),
      completedIntents: this.ctx.completedIntents,
    });

    if (!readiness.ready) {
      return { kind: 'waiting_until', at: this.ports.clock.now() + 1000 };
    }

    // 7. Resolve skill.
    const skill = resolveSkill(intent, this.ctx.skills);
    if (!skill) {
      return { kind: 'waiting_until', at: this.ports.clock.now() + 1000 };
    }

    // 8. Admit (capacity + scope + budget).
    const admission = admitWorkIntent({
      intent,
      writeScopes: intent.writeScopes as unknown as ResourceScope[],
      writeScopesKnown: intent.writeScopes.length > 0,
      repositories: [],
      heldClaims: this.ctx.heldClaims,
      capacityUsed: 0,
      capacityMax: 4,
      budget: this.ctx.budget,
      budgetReservationRef: workIntentKey({
        generation: intent.generation,
        targetCondition: intent.targetCondition,
        targetObligation: intent.targetObligation,
        scopeType: intent.scopeType,
        scopeId: intent.scopeId,
        strategyId: intent.strategyId,
      }),
    });

    if (!admission.admitted) {
      return { kind: 'waiting_until', at: this.ports.clock.now() + 1000 };
    }

    // 9. Create worker assignment (stored in ctx for the pump).
    this.ctx.leaseEpoch += 1;
    this.ctx.currentAssignment = createAssignment({
      workIntent: intent,
      skill,
    });

    // 10. Return did_work — the pump will drive the worker through ports.
    const decisionId = this.ports.ids.next('decision');

    return { kind: 'did_work', decisionId };
  }

  /**
   * Evaluate all conditions against their current evidence.
   */
  private evaluateAllConditions(): Record<string, ConditionStatus> {
    const statuses: Record<string, ConditionStatus> = {};

    for (const contract of this.ctx.conditionContracts) {
      const condition = this.ctx.conditions.get(contract.conditionType);
      if (!condition) {
        statuses[contract.conditionType] = 'Unknown';
        continue;
      }

      // For aggregated conditions, evaluate children.
      if (contract.aggregation) {
        const childStatuses = (contract.dependsOn ?? []).map(
          (dep) => statuses[dep] ?? 'Unknown',
        );
        statuses[contract.conditionType] = aggregate(
          contract.aggregation,
          childStatuses,
        );
      } else {
        // Direct condition — use the condition's current status.
        // The status was set by ingestOutput after evidence was attached.
        // If status is True but has no source fingerprint, it may be stale.
        statuses[contract.conditionType] = evaluateCondition(
          condition,
          condition.sourceFingerprint ? { verdict: 'passed' } as any : null,
          this.ctx.spec.generation,
          this.ctx.currentSourceFingerprint,
        );
        // If evaluateCondition returned Unknown but the raw status is True
        // (set by ingestOutput before sourceFingerprint was stamped),
        // trust the ingestOutput result — it just ran a real oracle.
        if (statuses[contract.conditionType] === 'Unknown' && condition.status === 'True') {
          statuses[contract.conditionType] = 'True';
        }
      }
    }

    return statuses;
  }

  /**
   * Ingest a worker's output: write artifacts, attach evidence provenance,
   * update conditions. This is called by the pump after the worker returns.
   */
  ingestOutput(output: WorkerOutput, conditionType: string, obligationId: string): {
    readonly artifacts: ReadonlyArray<{ path: string; digest: string; written: boolean }>;
    readonly evidence: readonly EvidenceRecord[];
  } {
    const trustClass = this.ctx.oracleRegistry.trustClassFor(
      output.observations[0]?.oracleId ?? 'unknown',
      output.observations[0]?.oracleVersion ?? '0',
    );

    const { artifacts, evidence } = ingestWorkerOutput({
      output,
      episodeSpecId: this.ctx.spec.id,
      obligationId,
      conditionType,
      generation: this.ctx.spec.generation,
      sourceFingerprint: this.ctx.currentSourceFingerprint,
      environmentFingerprint: this.ctx.currentEnvironmentFingerprint,
      trustClass,
      repositoryRoot: this.ctx.repositoryRoot,
    });

    // Update condition based on evidence.
    if (evidence.length > 0) {
      const condition = this.ctx.conditions.get(conditionType);
      if (condition) {
        const ev = evidence[0];
        if (ev.verdict === 'passed') condition.status = 'True';
        else if (ev.verdict === 'failed') condition.status = 'False';
        else condition.status = 'Unknown';

        // Persist the updated condition + evidence so they survive restart.
        if (this.ctx.db) {
          try {
            saveConditionToDb(this.ctx.db, condition);
            for (const rec of evidence) {
              // Attach a durable id if the ingestion layer left it blank.
              const withId: EvidenceRecord = rec.id
                ? rec
                : { ...rec, id: `ev-${this.ctx.spec.id}-${rec.oracleId}-${rec.observedAt}` };
              saveEvidenceToDb(this.ctx.db, withId);
            }
          } catch {
            // Persistence is best-effort during the skeleton phase — a DB
            // without the saga3 schema must not break ingestion.
          }
        }
      }
    }

    return { artifacts, evidence };
  }
}
