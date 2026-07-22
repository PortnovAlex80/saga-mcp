/**
 * Saga 3 — Incident and recovery authority.
 *
 * The ONE retry authority per episode. All failures route here.
 * Loop prevention: unchanged fingerprints are rejected.
 * R0-R9 rungs selected by failure class — no mechanical climbing.
 */

import type {
  FailureClass,
  RecoveryRung,
  TerminalOutcome,
  ControlIncident,
} from '../domain/types.js';

/**
 * Build a stable failure fingerprint. Same fingerprint + no causal change = reject.
 */
export function fingerprintFailure(input: {
  readonly failureClass: FailureClass;
  readonly generation: number;
  readonly sourceTreeHash: string;
  readonly environmentHash: string;
  readonly normalizedErrorHash: string;
  readonly actionType: string;
  readonly actionParameters: string;
}): string {
  return [
    input.failureClass,
    `g${input.generation}`,
    `src:${input.sourceTreeHash}`,
    `env:${input.environmentHash}`,
    `err:${input.normalizedErrorHash}`,
    `act:${input.actionType}`,
    `params:${input.actionParameters}`,
  ].join('|');
}

/**
 * Causal change detection. Repetition requires a real change — not just
 * reworded hypothesis or different rung label.
 */
export interface CausalChange {
  readonly worldOrRepoState?: boolean;
  readonly dependencyState?: boolean;
  readonly externalEvidence?: boolean;
  readonly actionStrategy?: boolean;
  readonly toolProviderModelEnv?: boolean;
  readonly verificationMethod?: boolean;
  readonly elapsedTransientMs?: number;
}

export function isRepeatPermitted(change: CausalChange, failureClass: FailureClass): boolean {
  if (failureClass === 'transient_provider' && change.elapsedTransientMs && change.elapsedTransientMs > 0)
    return true;
  return Boolean(
    change.worldOrRepoState ||
    change.dependencyState ||
    change.externalEvidence ||
    change.actionStrategy ||
    change.toolProviderModelEnv ||
    change.verificationMethod,
  );
}

/**
 * Map failure class → applicable rungs (plan §15).
 */
export function applicableRungs(failureClass: FailureClass): readonly RecoveryRung[] {
  const map: Record<FailureClass, readonly RecoveryRung[]> = {
    transient_provider: ['R0', 'R1'],
    lost_worker: ['R0', 'R2'],
    ambiguous_effect: ['R0'],
    environment: ['R0', 'R3'],
    deterministic_product: ['R0', 'R4', 'R5', 'R6'],
    oracle_defect: ['R0', 'R4'],
    specification_conflict: ['R0'],
    unobservable_mandatory: ['R0'],
    merge_coordination: ['R0', 'R6'],
    state_corruption: ['R0', 'R7'],
    budget_exhaustion: ['R0', 'R8'],
  };
  return map[failureClass];
}

/**
 * Select the next recovery rung for an incident. No mechanical climbing —
 * only applicable rungs for the failure class. R9 = terminal, not a retry.
 */
export function selectNextRung(input: {
  readonly failureClass: FailureClass;
  readonly currentRung: RecoveryRung | null;
  readonly usedStrategies: readonly RecoveryRung[];
  readonly maxAttemptsPerRung: Readonly<Record<RecoveryRung, number>>;
  readonly attemptCounts: Readonly<Record<RecoveryRung, number>>;
}): RecoveryRung | null {
  const applicable = applicableRungs(input.failureClass);
  const startIdx = input.currentRung ? applicable.indexOf(input.currentRung) + 1 : 0;
  for (let i = startIdx; i < applicable.length; i++) {
    const rung = applicable[i];
    if (rung === 'R9') continue;
    const attempts = input.attemptCounts[rung] ?? 0;
    const max = input.maxAttemptsPerRung[rung] ?? 1;
    if (attempts < max) return rung;
  }
  return null; // exhausted → terminal
}

/**
 * Terminal outcome for an exhausted failure class.
 */
export function selectTerminalOutcomeForFailure(failureClass: FailureClass): TerminalOutcome {
  const map: Record<FailureClass, TerminalOutcome> = {
    transient_provider: 'FAILED_UNRECOVERABLE',
    lost_worker: 'FAILED_UNRECOVERABLE',
    ambiguous_effect: 'EXTERNAL_STATE_UNKNOWN',
    environment: 'FAILED_UNRECOVERABLE',
    deterministic_product: 'FAILED_UNRECOVERABLE',
    oracle_defect: 'VERIFICATION_IMPOSSIBLE',
    specification_conflict: 'POLICY_CONFLICT',
    unobservable_mandatory: 'VERIFICATION_IMPOSSIBLE',
    merge_coordination: 'FAILED_UNRECOVERABLE',
    state_corruption: 'FAILED_UNRECOVERABLE',
    budget_exhaustion: 'RESOURCE_EXHAUSTED',
  };
  return map[failureClass];
}

/**
 * The incident authority. ONE per episode generation.
 * All failures file here. No other component authorizes retries.
 */
export class IncidentAuthority {
  private incidents = new Map<string, ControlIncident>();

  constructor(
    private readonly episodeSpecId: string,
    private readonly maxAttempts: Partial<Record<RecoveryRung, number>> = {},
  ) {
    this.maxAttempts = {
      R0: 1, R1: 3, R2: 2, R3: 2, R4: 2, R5: 1, R6: 1, R7: 1, R8: 1, R9: 1,
      ...this.maxAttempts,
    };
  }

  fileIncident(input: {
    readonly generation: number;
    readonly failureClass: FailureClass;
    readonly fingerprintInput: Parameters<typeof fingerprintFailure>[0];
    readonly causalChange?: CausalChange;
  }): {
    readonly incident: ControlIncident;
    readonly nextRung: RecoveryRung | null;
    readonly terminalOutcome: TerminalOutcome | null;
    readonly retryPermitted: boolean;
    readonly rejectionReason?: string;
  } {
    const fp = fingerprintFailure(input.fingerprintInput);
    const existing = this.incidents.get(fp);

    if (existing && existing.state !== 'terminal') {
      const permitted = isRepeatPermitted(input.causalChange ?? {}, input.failureClass);
      if (!permitted) {
        return {
          incident: existing,
          nextRung: null,
          terminalOutcome: null,
          retryPermitted: false,
          rejectionReason: `unchanged fingerprint — repeat rejected`,
        };
      }
    }

    if (existing && existing.state === 'terminal') {
      return { incident: existing, nextRung: null, terminalOutcome: existing.terminalOutcome, retryPermitted: false };
    }

    const firstRung = applicableRungs(input.failureClass)[0] ?? null;
    const incident: ControlIncident = {
      id: '',
      episodeSpecId: this.episodeSpecId,
      failureClass: input.failureClass,
      fingerprint: fp,
      occurrence: (existing?.occurrence ?? 0) + 1,
      state: firstRung ? 'recovering' : 'terminal',
      currentRung: firstRung,
      terminalOutcome: firstRung ? null : selectTerminalOutcomeForFailure(input.failureClass),
    };

    if (firstRung) {
      this.incidents.set(fp, incident);
    } else {
      const terminal = selectTerminalOutcomeForFailure(input.failureClass);
      const terminalIncident = { ...incident, state: 'terminal' as const, terminalOutcome: terminal };
      this.incidents.set(fp, terminalIncident);
      return { incident: terminalIncident, nextRung: null, terminalOutcome: terminal, retryPermitted: true };
    }

    this.incidents.set(fp, incident);
    return { incident, nextRung: firstRung, terminalOutcome: null, retryPermitted: true };
  }

  resolve(fingerprint: string): void {
    const inc = this.incidents.get(fingerprint);
    if (inc) this.incidents.set(fingerprint, { ...inc, state: 'resolved', currentRung: null });
  }

  getAll(): readonly ControlIncident[] {
    return [...this.incidents.values()];
  }
}
