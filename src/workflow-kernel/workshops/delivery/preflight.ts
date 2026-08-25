/**
 * workflow-kernel/workshops/delivery/preflight.ts - the release preflight:
 * CheckPlan + semantic gates over the verified bundle (WP-11L, plan EK-8).
 *
 * DETERMINISTIC DECLARED PROVIDERS, FAIL-CLOSED (assignment point 4):
 * every check of the declared release policy is executed by its declared
 * provider from the installed manifest (manifest.ts DECLARED_CHECK_PROVIDERS
 * + DELIVERY_CHECK_IDS). An undeclared check id is refused typed
 * (UNDECLARED_CHECK - never silently skipped); a failing check refuses
 * typed (PREFLIGHT_FAILED - the failed preflight mutation); a policy that
 * declares external deployment or any credential is refused typed
 * (POLICY_NOT_LOCAL - qualification never depends on them).
 *
 * The preflight snapshot is content-addressed over the exact triple the
 * legacy bridge bound: candidate hash + policy hash + every check outcome
 * digest. The preflightHash participates in the approval request binding
 * (approval.ts) exactly as the legacy inbox bound it.
 *
 * PURITY: deterministic functions of the passed values. No I/O, no clock.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import type { VerifiedDevelopmentBundle } from './bundle.js';
import {
  DECLARED_CHECK_PROVIDERS,
  DELIVERY_RELEASE_POLICY,
  type DeclaredReleasePolicy,
  type DeliveryCheckId,
  isDeclaredCheck,
} from './manifest.js';

/* ------------------------------------------------------------------ */
/* The preflight value                                                 */
/* ------------------------------------------------------------------ */

export const DELIVERY_PREFLIGHT_SCHEMA = 'delivery.preflight.v1';

/** One executed preflight check (deterministic provider + outcome). */
export interface PreflightCheckResult {
  readonly checkId: DeliveryCheckId | string;
  readonly outcome: 'passed' | 'failed';
  readonly detail: string;
  readonly evidenceDigest: string;
}

/** The content-addressed preflight snapshot over the exact candidate/policy pair. */
export interface PreflightSnapshot {
  readonly schemaVersion: typeof DELIVERY_PREFLIGHT_SCHEMA;
  readonly candidateDigest: string;
  readonly policyDigest: string;
  readonly checks: readonly PreflightCheckResult[];
  readonly complete: boolean;
  readonly preflightDigest: string;
}

/* ------------------------------------------------------------------ */
/* Typed refusals (closed set)                                         */
/* ------------------------------------------------------------------ */

export type PreflightRefusalReason =
  | 'UNDECLARED_CHECK'
  | 'PREFLIGHT_FAILED'
  | 'POLICY_NOT_LOCAL'
  | 'BUNDLE_UNVERIFIED';

export interface PreflightRefusal {
  readonly refused: true;
  readonly reason: PreflightRefusalReason;
  readonly detail: string;
  /** The exact failed/undeclared checks (never a vague failure). */
  readonly checkIds?: readonly string[];
}

export type PreflightOutcome = PreflightSnapshot | PreflightRefusal;

/* ------------------------------------------------------------------ */
/* The deterministic check bodies                                      */
/* ------------------------------------------------------------------ */

/**
 * The deterministic outcome computation of each declared check over the
 * bundle. These are pure functions of the verified bundle facts; the
 * provider table above owns EXECUTION, this map owns SEMANTICS.
 */
function computeCheck(checkId: string, bundle: VerifiedDevelopmentBundle, policy: DeclaredReleasePolicy): { readonly ok: boolean; readonly detail: string } {
  switch (checkId) {
    case 'bundle-digest-verify':
      return { ok: bundle.bundleRef === `sha256:${bundle.bundleDigest}`, detail: `bundle self-address ${bundle.bundleRef}` };
    case 'certificate-verified': {
      const decision = bundle.developmentCertificate.content;
      const ok = decision !== null && typeof decision === 'object' && (decision as { readonly decision?: unknown }).decision === 'verified';
      return { ok, detail: `development certificate decision ${JSON.stringify(ok ? 'verified' : 'not-verified')}` };
    }
    case 'policy-bound-candidate':
      return { ok: bundle.integratedCandidate.digest.length === 64, detail: `integrated candidate ${bundle.integratedCandidate.ref}` };
    case 'packaging-input-assemblable':
      return { ok: /^[0-9a-f]{64}$/.test(bundle.packageBytesDigest), detail: `packaging input digest ${bundle.packageBytesDigest}` };
    case 'local-only-policy':
      return {
        ok: policy.externalDeployment === false && policy.credentials === 'none',
        detail: `externalDeployment=${String(policy.externalDeployment)} credentials=${String(policy.credentials)}`,
      };
    default:
      return { ok: false, detail: `no deterministic body for check ${checkId}` };
  }
}

/* ------------------------------------------------------------------ */
/* The preflight run                                                   */
/* ------------------------------------------------------------------ */

/**
 * Run the declared preflight checks over the verified bundle. Fail-closed
 * in this order: policy locality, declared-check equality, then every
 * declared check through its deterministic provider.
 */
export function runPreflight(bundle: VerifiedDevelopmentBundle, policy: DeclaredReleasePolicy = DELIVERY_RELEASE_POLICY): PreflightOutcome {
  // 1. LOCAL PACKAGING ONLY: a policy that reaches outside never preflights.
  if (policy.externalDeployment !== false || policy.credentials !== 'none') {
    return {
      refused: true,
      reason: 'POLICY_NOT_LOCAL',
      detail: `release policy ${policy.policyId} declares externalDeployment=${String(policy.externalDeployment)} credentials=${String(policy.credentials)}; this workshop qualifies LOCAL packaging only and never depends on a credential`,
    };
  }

  // 2. Declared-check equality (fail-closed: an undeclared check id refuses).
  const undeclared = policy.requiredCheckIds.filter((checkId) => !isDeclaredCheck(checkId));
  if (undeclared.length > 0) {
    return {
      refused: true,
      reason: 'UNDECLARED_CHECK',
      detail: `release policy requires undeclared check ids [${undeclared.join(', ')}]; an undeclared check never runs (fail-closed, never guessed)`,
      checkIds: undeclared,
    };
  }

  // 3. Every declared check through its deterministic provider.
  const checks: PreflightCheckResult[] = [];
  for (const checkId of policy.requiredCheckIds) {
    const provider = DECLARED_CHECK_PROVIDERS[checkId];
    if (provider === undefined) {
      return {
        refused: true,
        reason: 'UNDECLARED_CHECK',
        detail: `check ${checkId} has no declared provider in the installed manifest`,
        checkIds: [checkId],
      };
    }
    const computed = computeCheck(checkId, bundle, policy);
    const executed = provider(computed);
    checks.push({
      checkId,
      outcome: executed.ok ? 'passed' : 'failed',
      detail: executed.detail,
      evidenceDigest: sha256OfCanonical({ checkId, computed, executed }),
    });
  }
  const failed = checks.filter((check) => check.outcome === 'failed');
  if (failed.length > 0) {
    return {
      refused: true,
      reason: 'PREFLIGHT_FAILED',
      detail: `preflight failed: ${failed.map((check) => `${check.checkId} (${check.detail})`).join('; ')}`,
      checkIds: failed.map((check) => check.checkId),
    };
  }

  const policyDigest = sha256OfCanonical({ ...policy });
  const body = {
    schemaVersion: DELIVERY_PREFLIGHT_SCHEMA,
    candidateDigest: bundle.integratedCandidate.digest,
    policyDigest,
    checks: checks.map((check) => ({ checkId: check.checkId, outcome: check.outcome, evidenceDigest: check.evidenceDigest })),
  };
  return {
    schemaVersion: DELIVERY_PREFLIGHT_SCHEMA,
    candidateDigest: bundle.integratedCandidate.digest,
    policyDigest,
    checks,
    complete: checks.every((check) => check.outcome === 'passed'),
    preflightDigest: sha256OfCanonical(body),
  };
}

/** The external Input-authority evidence of a completed preflight (the gate input). */
export function preflightEvidenceOf(preflight: PreflightSnapshot): readonly { kind: 'CheckPlan' | 'ProductVerificationEvidence'; ref: string; producer: 'external-input'; payloadDigest: string }[] {
  return [
    { kind: 'CheckPlan', ref: 'evidence:CheckPlan#external', producer: 'external-input', payloadDigest: preflight.preflightDigest },
    { kind: 'ProductVerificationEvidence', ref: 'evidence:ProductVerificationEvidence#external', producer: 'external-input', payloadDigest: preflight.preflightDigest },
  ];
}
