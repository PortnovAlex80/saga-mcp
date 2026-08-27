/**
 * workflow-kernel/workshops/formalization/cells/what-freeze/persistence.mjs -
 * the immutable kernel-evidence persistence of the WHAT-freeze desk and
 * its typed waits (FRF-WP07).
 *
 * LAWS:
 *   - The frozen baseline is an IMMUTABLE KERNEL EVIDENCE PRODUCT,
 *     submitted exactly once per content digest through the workshop
 *     product-submission pattern: content-addressed ref, recomputed
 *     digest, idempotent by an exact action key (evidence kind + case
 *     identity + content digest). Re-submitting the SAME digest settles
 *     'already-applied' (a replay is not a second mutation); submitting a
 *     DIFFERENT baseline digest under the same case identity is a typed
 *     DRIFT_DETECTED refusal - there is exactly ONE whole-WHAT freeze
 *     authority per case, and it has no update path at all (no mutation
 *     API exists in this module).
 *   - TYPED WAITS (D5/D12 vocabulary ONLY, from the frozen kernel
 *     registry; nothing here invents a wait kind or wake command):
 *       * freeze-drift human decision: TypedWait:effect-uncertainty
 *         (D12) - wakes ONLY on the operator disposition receipt naming
 *         the exact drift evidence digest; an automatic redrive is
 *         refused typed (it would re-freeze uncertain authority);
 *       * indeterminate desk (missing exact surfaces): TypedWait:
 *         human-input (D5) - discharged by the frozen wake commands with
 *         the missing-surface evidence.
 *
 * PURITY: pure bookkeeping (a deterministic in-process applied-key
 * ledger). No SQL, no clock, no network - the same law the installed
 * workshops' effects follow; the owning repositories own all durable
 * writes.
 */

import { refused, sha256OfCanonical } from './shared.mjs';

/* ------------------------------------------------------------------ */
/* The immutable kernel-evidence ledger                                */
/* ------------------------------------------------------------------ */

/** The evidence kinds this desk submits (immutable products). */
export const WHAT_FREEZE_EVIDENCE_KINDS = Object.freeze([
  'KernelEvidence:what-baseline',
  'KernelEvidence:solution-contract',
]);

/**
 * The immutable evidence ledger: exactly-once submission per action key.
 * Pure in-process bookkeeping mirroring the workshop effect executor.
 */
export class KernelEvidenceLedger {
  /** actionKey -> submitted artifact digest. */
  #applied = new Map();
  /** evidenceKind + caseRef -> the ONE submitted digest (immutability). */
  #sealed = new Map();

  /** The exact idempotency action key of one submission (content-addressed). */
  static actionKeyOf(evidenceKind, caseRef, contentDigest) {
    return `${evidenceKind}#${caseRef}#${sha256OfCanonical({ caseRef, contentDigest, evidenceKind })}`;
  }

  /**
   * Submit one immutable kernel evidence product. Same content again ->
   * 'already-applied'; different content under the same kind+case ->
   * DRIFT_DETECTED (there is no second freeze authority).
   */
  submit(evidenceKind, caseRef, artifact) {
    if (!WHAT_FREEZE_EVIDENCE_KINDS.includes(evidenceKind)) {
      return refused('SCOPE_VIOLATION', `evidence kind ${String(evidenceKind)} is outside the WHAT-freeze desk's immutable evidence vocabulary`);
    }
    if (artifact === null || typeof artifact !== 'object' || typeof artifact.ref !== 'string' || typeof artifact.digest !== 'string') {
      return refused('MALFORMED_PRODUCT', 'an evidence submission requires a content-addressed artifact (ref + recomputed digest)');
    }
    const recomputed = sha256OfCanonical(artifact.content ?? null);
    if (artifact.ref !== `sha256:${artifact.digest}` || (artifact.content !== undefined && recomputed !== artifact.digest)) {
      return refused('DRIFT_DETECTED', 'the submitted artifact is not content-addressed (the digest must verify over the canonical content)');
    }
    const sealKey = `${evidenceKind}#${caseRef}`;
    const sealed = this.#sealed.get(sealKey);
    if (sealed !== undefined && sealed !== artifact.digest) {
      return refused('DRIFT_DETECTED', `evidence ${evidenceKind} for case ${caseRef} was already sealed at digest ${sealed}; a second different submission (${artifact.digest}) is refused (the frozen authority is immutable; lawful change is a new case, never an update)`);
    }
    const actionKey = KernelEvidenceLedger.actionKeyOf(evidenceKind, caseRef, artifact.digest);
    const already = this.#applied.get(actionKey);
    if (already !== undefined) {
      return { ok: true, outcome: 'already-applied', actionKey, receiptDigest: already };
    }
    const receiptDigest = `receipt:${evidenceKind}:${artifact.digest}`;
    this.#applied.set(actionKey, receiptDigest);
    this.#sealed.set(sealKey, artifact.digest);
    return { ok: true, outcome: 'success', actionKey, receiptDigest };
  }

  /** True when the exact action key already settled (idempotency oracle). */
  hasSubmitted(evidenceKind, caseRef, contentDigest) {
    return this.#applied.has(KernelEvidenceLedger.actionKeyOf(evidenceKind, caseRef, contentDigest));
  }

  /** The sealed digest of one evidence kind for one case (read-only view). */
  sealedDigestOf(evidenceKind, caseRef) {
    return this.#sealed.get(`${evidenceKind}#${caseRef}`);
  }
}

/* ------------------------------------------------------------------ */
/* The typed waits (D5/D12 vocabulary only)                            */
/* ------------------------------------------------------------------ */

/** The frozen wake-command vocabularies (D5/D12; asserted against the kernel registry by the tests). */
export const TYPED_WAIT_REGISTRY = Object.freeze({
  'TypedWait:human-input': {
    wakeCommands: ['workplace.resolveHumanResponse', 'nodeRun.recordHumanDecision'],
    disposition: 'wake-source-completion',
  },
  'TypedWait:effect-uncertainty': {
    wakeCommands: ['workplace.resolveHumanResponse'],
    disposition: 'operator-disposition-command-required',
  },
});

/**
 * The freeze-drift human decision wait (D12 vocabulary ONLY): wakes only
 * on the operator disposition receipt naming the exact drift evidence.
 */
export function freezeDriftWaitOf(driftEvidenceDigest) {
  const spec = TYPED_WAIT_REGISTRY['TypedWait:effect-uncertainty'];
  return {
    kind: 'TypedWait:effect-uncertainty',
    disposition: spec.disposition,
    wakeCommands: [...spec.wakeCommands],
    driftEvidenceDigest,
  };
}

/**
 * Resolve the freeze-drift wait. `disposition` MUST be an operator
 * disposition RECEIPT (the D12 law): a wake command from the frozen
 * vocabulary, a decision of resume-upstream-repair or
 * confirm-inconsistent, and the exact drift evidence digest. Anything
 * else - including an automatic redrive attempt with no receipt - is a
 * typed refusal; the uncertain freeze is never re-driven silently.
 */
export function resolveFreezeDriftDecision(wait, disposition) {
  if (wait?.kind !== 'TypedWait:effect-uncertainty') {
    return refused('MALFORMED_PRODUCT', 'the freeze-drift wait is a TypedWait:effect-uncertainty (D12); no other wait kind carries this decision');
  }
  if (disposition === undefined || disposition === null || typeof disposition !== 'object') {
    return refused('MISSING_LINEAGE', 'D12: the freeze-drift wait wakes only on an operator disposition receipt; an automatic redrive (no receipt) would re-freeze uncertain authority and is refused');
  }
  if (!wait.wakeCommands.includes(disposition.command)) {
    return refused('MALFORMED_PRODUCT', `D12: the disposition command ${String(disposition.command)} is not one of the wait's frozen wake commands [${wait.wakeCommands.join(', ')}]`);
  }
  if (disposition.driftEvidenceDigest !== wait.driftEvidenceDigest) {
    return refused('DRIFT_DETECTED', 'the disposition receipt names a different drift than the open wait (a receipt binds its exact drift evidence digest; recycled receipts are refused)');
  }
  if (disposition.decision === 'resume-upstream-repair') {
    // The ONLY lawful repair: a NEW immutable revision in the OWNING
    // upstream desk, invalidating the dependent cone - never a patch of
    // accepted material, never a re-freeze over mutated content.
    return { ok: true, decision: 'resume-upstream-repair', transition: null, note: 'the repair is a new immutable upstream revision; the freezer re-runs on the new exact surfaces only' };
  }
  if (disposition.decision === 'confirm-inconsistent') {
    return { ok: true, decision: 'confirm-inconsistent', transition: 'domain.drift-detected' };
  }
  return refused('MALFORMED_PRODUCT', `the operator decision ${String(disposition.decision)} is outside the freeze-drift decision vocabulary {resume-upstream-repair, confirm-inconsistent}`);
}

/** The indeterminate-desk wait (D5): discharged by the frozen wake commands. */
export function indeterminateWaitOf(missingSurfaceDetail) {
  const spec = TYPED_WAIT_REGISTRY['TypedWait:human-input'];
  return {
    kind: 'TypedWait:human-input',
    disposition: spec.disposition,
    wakeCommands: [...spec.wakeCommands],
    missingSurfaceDetail,
  };
}

/**
 * Discharge an indeterminate wait: the wake command must come from the
 * frozen vocabulary and carry the exact accepted surface that was
 * missing (fail-closed: the desk re-freezes only on complete surfaces).
 */
export function dischargeIndeterminateWait(wait, wake) {
  if (wait?.kind !== 'TypedWait:human-input') {
    return refused('MALFORMED_PRODUCT', 'the indeterminate wait is a TypedWait:human-input (D5)');
  }
  if (!wait.wakeCommands.includes(wake?.command)) {
    return refused('MALFORMED_PRODUCT', `D5: the wake command ${String(wake?.command)} is not one of the wait's frozen wake commands [${wait.wakeCommands.join(', ')}]`);
  }
  if (typeof wake?.evidenceRef !== 'string' || wake.evidenceRef.length === 0) {
    return refused('MISSING_LINEAGE', 'D5: the wake must carry the obligation-completion/human-response evidence ref (the exact accepted surface)');
  }
  return { ok: true, discharged: true, dischargeEvidence: `WakeDischarge:human-response-command#${wake.evidenceRef}` };
}
