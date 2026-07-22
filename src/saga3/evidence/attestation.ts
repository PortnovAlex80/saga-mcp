/**
 * Saga 3 — Evidence attestation.
 *
 * The controller attaches provenance. The worker returns raw observations.
 * Evidence is never accepted from LM claims alone.
 *
 * Key principle (plan §9 Gate D): "The worker is not required to invent
 * authoritative provenance. Provenance is attached only to a real observation."
 */

import type {
  EvidenceRecord,
  EvidenceVerdict,
  TrustClass,
} from '../domain/types.js';

/**
 * Oracle registry: which oracles are trusted for which trust class.
 * Blocker conditions require deterministic or authoritative evidence.
 * Advisory alone cannot satisfy a blocker.
 */
export class OracleRegistry {
  private readonly oracles = new Map<string, OracleEntry>();

  register(entry: OracleEntry): void {
    this.oracles.set(`${entry.oracleId}@${entry.version}`, entry);
  }

  lookup(oracleId: string, version: string): OracleEntry | undefined {
    return this.oracles.get(`${oracleId}@${version}`);
  }

  trustClassFor(oracleId: string, version: string): TrustClass {
    return this.oracles.get(`${oracleId}@${version}`)?.trustClass ?? 'advisory';
  }

  canSatisfyBlocker(oracleId: string, version: string): boolean {
    const tc = this.trustClassFor(oracleId, version);
    return tc === 'deterministic' || tc === 'authoritative';
  }

  resolveProxy(oracleId: string, version: string): OracleEntry | null {
    const entry = this.oracles.get(`${oracleId}@${version}`);
    if (entry?.proxyAllowed && entry.proxyOracleId) {
      for (const p of this.oracles.values()) {
        if (p.oracleId === entry.proxyOracleId) return p;
      }
    }
    return null;
  }
}

export interface OracleEntry {
  readonly oracleId: string;
  readonly version: string;
  readonly trustClass: TrustClass;
  readonly scope: string;
  readonly proxyAllowed: boolean;
  readonly proxyOracleId?: string;
}

/**
 * Evidence currency check. Stale evidence NEVER satisfies current conditions.
 */
export type EvidenceCurrency =
  | { readonly current: true }
  | { readonly current: false; readonly reason: EvidenceStalenessReason };

export type EvidenceStalenessReason =
  | 'stale_generation'
  | 'source_changed'
  | 'environment_changed'
  | 'oracle_unregistered'
  | 'advisory_cannot_satisfy_blocker'
  | 'freshness_expired'
  | 'error_outcome';

export function validateEvidenceCurrency(
  evidence: EvidenceRecord,
  context: {
    readonly activeGeneration: number;
    readonly currentSourceFingerprint: string;
    readonly currentEnvironmentFingerprint: string;
    readonly nowMs: number;
    readonly registry: OracleRegistry;
    readonly isBlocker: boolean;
  },
): EvidenceCurrency {
  if (evidence.generation !== context.activeGeneration)
    return { current: false, reason: 'stale_generation' };
  if (evidence.sourceFingerprint !== context.currentSourceFingerprint)
    return { current: false, reason: 'source_changed' };
  if (evidence.environmentFingerprint !== context.currentEnvironmentFingerprint)
    return { current: false, reason: 'environment_changed' };
  if (!context.registry.lookup(evidence.oracleId, evidence.oracleVersion))
    return { current: false, reason: 'oracle_unregistered' };
  if (context.isBlocker && !context.registry.canSatisfyBlocker(evidence.oracleId, evidence.oracleVersion))
    return { current: false, reason: 'advisory_cannot_satisfy_blocker' };
  if (context.nowMs - evidence.observedAt > evidence.freshnessMaxAgeMs)
    return { current: false, reason: 'freshness_expired' };
  if (evidence.verdict === 'error')
    return { current: false, reason: 'error_outcome' };
  return { current: true };
}

/**
 * Classify a verification failure into defect type.
 * Determines which SEPARATE work intent is created (plan §16 Gate D):
 * product defect → dev remediation; oracle defect → oracle repair;
 * environment defect → environment recreation; provider error → transient.
 */
export type DefectClass = 'product' | 'oracle' | 'environment' | 'provider';

export function classifyDefect(input: {
  readonly verdict: EvidenceVerdict;
  readonly oracleRegistered: boolean;
  readonly oracleRanSuccessfully: boolean;
  readonly environmentAvailable: boolean;
}): DefectClass {
  if (!input.oracleRanSuccessfully) return 'provider';
  if (!input.environmentAvailable) return 'environment';
  if (!input.oracleRegistered || input.verdict === 'error') return 'oracle';
  return 'product';
}

/**
 * Verify independence: the verifier must differ from the implementer.
 * Same execution cannot certify its own work.
 */
export function isIndependentVerification(input: {
  readonly verifierExecutionId: string;
  readonly implementerExecutionId: string;
}): boolean {
  return input.verifierExecutionId !== input.implementerExecutionId;
}
