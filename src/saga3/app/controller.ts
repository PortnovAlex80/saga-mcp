/**
 * Saga 3 — The Controller.
 *
 * One-step reconcile loop: observe → evaluate conditions → select deficit →
 * check readiness → admit → materialize WorkIntent → assign worker →
 * ingest output → attach evidence provenance → update condition → repeat.
 *
 * Terminal when evaluateTerminal certifies. No fallback. No v2.
 */

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
  leaseEpoch: number;
  currentAssignment: ReturnType<typeof createAssignment> | null;
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
      return { kind: 'terminal', outcome: terminalDecision.outcome, certificate: cert };
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
        // Direct condition — needs evidence.
        // Evidence lookup is domain-specific; for the walking skeleton
        // we treat all conditions as Unknown until evidence is ingested.
        statuses[contract.conditionType] = evaluateCondition(
          condition,
          null, // no evidence yet — will be filled by ingestion
          this.ctx.spec.generation,
          this.ctx.currentSourceFingerprint,
        );
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
      }
    }

    return { artifacts, evidence };
  }
}
