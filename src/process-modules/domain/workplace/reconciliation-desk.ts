/**
 * RECONCILIATION DESK — SEAM-ARCHITECT Layer 3, pure decision
 * (docs/architecture/SEAM-ARCHITECT-DESIGN.md "Слой 3: ремонт через владельца").
 *
 * Integration verification routes every seam defect to the cell that OWNS the
 * path (scope-provider). But some defects sit on a seam that no frozen scope
 * owns — an ORPHAN SEAM. For those, the agreed pattern is bounded
 * reconciliation:
 *
 *   - BOUNDED RECORDS  — a reconciliation repair may only touch the paths of
 *     its admitted seam (enforced structurally at report assembly).
 *   - TYPED REPORT     — {repairs[], remainingGaps[], rationale}: what was
 *     fixed, what is acknowledged as uncovered, and why. Coverage
 *     conservation: every admitted seam appears exactly once across
 *     repairs+gaps; nothing is silently dropped (fail-closed).
 *   - SANCTION PATH    — reconciliation NEVER writes into authority directly.
 *     A record seals only with an independent reviewer ref AND a gate
 *     decision key: it travels the same acceptance route as any normal
 *     production, no shortcut, no weakened gate.
 *
 * Reconciliation COMPLEMENTS the re-plan cycle (Layer 1 —
 * finding-trajectory.ts scope-impossible + replan-cycle-policy.ts), it never
 * replaces it. Two anti-loop rules mirror the re-plan cap/ratchet:
 *
 *   CAP        — at most {@link RECONCILIATION_SEAM_CAP} sealed rounds per
 *                case lineage; further asks carry the full diagnosis and are
 *                refused (human decision), never an eternal loop.
 *
 *   STRUCTURAL — a seam whose key already survived a sealed reconciliation
 *                round, or that is already a surviving re-plan key, is
 *                STRUCTURAL: the same key surviving means the defect is not a
 *                local seam gap but a mis-carved graph — re-plan territory.
 *
 * Pure domain: no SQLite, no filesystem, no clocks. The durable count and
 * ratchet live in SqliteReconciliationLedger (K13 append-only house pattern).
 */

/** Maximum sealed reconciliation rounds per case lineage. */
export const RECONCILIATION_SEAM_CAP = 4;

/** A defect located on a seam between cells (not inside one frozen scope). */
export interface SeamDefect {
  /** Typed finding identity (`${code}::${normalized message}`) — stable key. */
  readonly seamKey: string;
  /** The seam's Git paths — the ONLY surface a bounded repair may touch. */
  readonly seamPaths: readonly string[];
  /** Human-readable description of what is broken at the seam. */
  readonly description: string;
}

/**
 * Scope-provider verdict for one seam: the live owning task whose frozen
 * scope covers the seam paths, or null when the seam is an orphan (the only
 * reconciliation input). An owned seam is NEVER reconciled — it is routed to
 * the owner cell's repair mode with its own check plan.
 */
export interface SeamOwnership {
  readonly ownedByTaskId: number | null;
}

/** A prior sealed reconciliation round of the same case lineage. */
export interface PriorReconciliation {
  /** Seam keys that round admitted (and reported on). */
  readonly seamKeys: readonly string[];
}

export type ReconciliationAdmission =
  | { readonly admitted: true; readonly reason: 'orphan-seam'; readonly diagnosis: string }
  | {
    readonly admitted: false;
    readonly reason: 'owned-seam' | 'structural-seam' | 'cap';
    readonly diagnosis: string;
  };

/**
 * Decide whether one seam defect may enter reconciliation. Pure: the same
 * input always yields the same verdict and diagnosis.
 *
 * Order of rules (cheapest routing first):
 *   1. owned-seam     — a live owner exists → deny, route to the owner.
 *   2. structural     — the key survived a reconciliation round or is a
 *                       surviving re-plan key → deny, replan territory.
 *   3. cap            — the lineage is at the cap → deny with full diagnosis.
 *   4. orphan-seam    — the only admission.
 */
export function admitReconciliation(input: {
  readonly seam: SeamDefect;
  readonly ownership: SeamOwnership;
  readonly priorReconciliations: readonly PriorReconciliation[];
  /** Surviving path-outside-authority keys of the re-plan trigger, if any. */
  readonly survivingReplanKeys?: readonly string[];
}): ReconciliationAdmission {
  const { seam, ownership, priorReconciliations } = input;
  const survivingReplanKeys = input.survivingReplanKeys ?? [];
  const lineageSize = priorReconciliations.length;

  if (ownership.ownedByTaskId !== null) {
    return {
      admitted: false,
      reason: 'owned-seam',
      diagnosis: `seam '${seam.seamKey}' has a live owner (task ${ownership.ownedByTaskId}): `
        + `route the repair-issue to the owning cell's repair mode with ITS check plan — `
        + `reconciliation never competes with an owner.`,
    };
  }

  const burnedHere = priorReconciliations.some(round =>
    round.seamKeys.includes(seam.seamKey));
  const burnedByReplan = survivingReplanKeys.includes(seam.seamKey);
  if (burnedHere || burnedByReplan) {
    return {
      admitted: false,
      reason: 'structural-seam',
      diagnosis: `seam '${seam.seamKey}' is structural: the same key already survived `
        + (burnedHere
          ? 'a sealed reconciliation round of this lineage'
          : 'a repair attempt as a path-outside-authority key')
        + `. A surviving key means the defect is not a local seam gap but a mis-carved `
        + `graph — re-plan territory (replan-cycle-policy), never another reconciliation.`,
    };
  }

  if (lineageSize >= RECONCILIATION_SEAM_CAP) {
    return {
      admitted: false,
      reason: 'cap',
      diagnosis: `reconciliation lineage is at the cap (${RECONCILIATION_SEAM_CAP} sealed `
        + `rounds). Seam '${seam.seamKey}' is refused another round — the full diagnosis `
        + `must reach a human decision, not an eternal loop.`,
    };
  }

  return {
    admitted: true,
    reason: 'orphan-seam',
    diagnosis: `seam '${seam.seamKey}' is an orphan (no live owner among the frozen scopes) `
      + `and no prior reconciliation of this lineage burned its key: admitted as round `
      + `${lineageSize + 1} of at most ${RECONCILIATION_SEAM_CAP}, bounded to paths `
      + `[${seam.seamPaths.join(', ')}], under independent reviewer + gate sanction.`,
  };
}

/** One bounded repair performed during a reconciliation round. */
export interface ReconciliationRepair {
  readonly seamKey: string;
  /** Must be EXACTLY the admitted seam's paths — the bounded write surface. */
  readonly seamPaths: readonly string[];
  readonly whatWasDone: string;
  /** Durable evidence receipt (check receipt / evidence ref). Non-empty. */
  readonly evidenceRef: string;
}

/** A seam acknowledged as NOT repaired, with the reason it stays uncovered. */
export interface ReconciliationRemainingGap {
  readonly seamKey: string;
  readonly acknowledgedBecause: string;
}

/**
 * The typed reconciliation report. `remainingGaps` is as load-bearing as
 * `repairs`: an honest round that fixes nothing but acknowledges everything
 * is valid; a round that silently drops a seam is not (fail-closed below).
 */
export interface ReconciliationReport {
  readonly repairs: readonly ReconciliationRepair[];
  readonly remainingGaps: readonly ReconciliationRemainingGap[];
  readonly rationale: string;
}

/**
 * Assemble (and validate) a reconciliation report. Fail-closed invariants:
 *
 *   - COVERAGE CONSERVATION — every admitted seam key appears EXACTLY once
 *     across repairs+gaps; an unknown key or a dropped/duplicated seam aborts.
 *   - BOUNDED SURFACE       — a repair's paths must equal its seam's paths.
 *   - EVIDENCE              — a repair without an evidence receipt aborts;
 *                             a gap without a reason aborts; a blank
 *                             rationale aborts.
 */
export function assembleReconciliationReport(input: {
  readonly admittedSeams: readonly SeamDefect[];
  readonly repairs: readonly ReconciliationRepair[];
  readonly remainingGaps: readonly ReconciliationRemainingGap[];
  readonly rationale: string;
}): ReconciliationReport {
  const { admittedSeams, repairs, remainingGaps, rationale } = input;
  if (typeof rationale !== 'string' || rationale.trim().length === 0) {
    throw new Error('RECONCILIATION_RATIONALE_REQUIRED');
  }
  const seamsByKey = new Map(admittedSeams.map(seam => [seam.seamKey, seam]));
  const seen = new Map<string, 'repair' | 'gap'>();
  for (const repair of repairs) {
    const seam = seamsByKey.get(repair.seamKey);
    if (!seam) {
      throw new Error(
        `RECONCILIATION_COVERAGE_VIOLATION: repair names seam '${repair.seamKey}' `
        + `that was never admitted.`,
      );
    }
    const priorKind = seen.get(repair.seamKey);
    if (priorKind) {
      throw new Error(
        `RECONCILIATION_COVERAGE_VIOLATION: seam '${repair.seamKey}' appears twice `
        + `(${priorKind} + repair); each admitted seam is reported exactly once.`,
      );
    }
    const bounded = seam.seamPaths.length === repair.seamPaths.length
      && seam.seamPaths.every(expected => repair.seamPaths.includes(expected));
    if (!bounded) {
      throw new Error(
        `RECONCILIATION_REPAIR_SCOPE_VIOLATION: repair for '${repair.seamKey}' names `
        + `paths [${repair.seamPaths.join(', ')}] but the admitted seam surface is `
        + `[${seam.seamPaths.join(', ')}] — records are bounded to the seam.`,
      );
    }
    if (typeof repair.evidenceRef !== 'string' || repair.evidenceRef.trim().length === 0) {
      throw new Error(
        `RECONCILIATION_REPAIR_EVIDENCE_REQUIRED: repair for '${repair.seamKey}' `
        + `carries no durable evidence receipt.`,
      );
    }
    seen.set(repair.seamKey, 'repair');
  }
  for (const gap of remainingGaps) {
    if (!seamsByKey.has(gap.seamKey)) {
      throw new Error(
        `RECONCILIATION_COVERAGE_VIOLATION: remaining gap names seam '${gap.seamKey}' `
        + `that was never admitted.`,
      );
    }
    const priorKind = seen.get(gap.seamKey);
    if (priorKind) {
      throw new Error(
        `RECONCILIATION_COVERAGE_VIOLATION: seam '${gap.seamKey}' appears twice `
        + `(${priorKind} + gap); each admitted seam is reported exactly once.`,
      );
    }
    if (typeof gap.acknowledgedBecause !== 'string'
      || gap.acknowledgedBecause.trim().length === 0) {
      throw new Error(
        `RECONCILIATION_GAP_REASON_REQUIRED: gap for '${gap.seamKey}' carries no `
        + `acknowledgement reason — an unexplained gap is a silent drop.`,
      );
    }
    seen.set(gap.seamKey, 'gap');
  }
  for (const seam of admittedSeams) {
    if (!seen.has(seam.seamKey)) {
      throw new Error(
        `RECONCILIATION_COVERAGE_VIOLATION: admitted seam '${seam.seamKey}' is absent `
        + `from both repairs and remainingGaps — coverage conservation forbids `
        + `silently dropping a seam.`,
      );
    }
  }
  return {
    repairs: repairs.map(repair => ({ ...repair, seamPaths: [...repair.seamPaths] })),
    remainingGaps: remainingGaps.map(gap => ({ ...gap })),
    rationale: rationale.trim(),
  };
}

/**
 * The sanction that authorizes a reconciliation record: an independent
 * reviewer AND a gate acceptance. Reconciliation does not write into
 * authority directly — the sealed record is the typed artifact that travels
 * the SAME acceptance path as any normal production.
 */
export interface ReconciliationSanction {
  readonly reviewerExecutionRef: string;
  readonly gateDecisionKey: string;
}

/** The append-only record a reconciliation ledger stores per sealed round. */
export interface SealedReconciliationRecord {
  readonly report: ReconciliationReport;
  /** Canonically ordered seam keys of the round (identity for ratchets). */
  readonly seamKeys: readonly string[];
  readonly sanction: ReconciliationSanction;
}

/**
 * Seal a reconciliation round. Fail-closed:
 *   - a missing/incomplete sanction aborts (RECONCILIATION_SANCTION_REQUIRED);
 *   - the report is re-validated against the admitted seams (defense in depth
 *     against a report swapped after admission).
 */
export function sealReconciliation(input: {
  readonly admittedSeams: readonly SeamDefect[];
  readonly report: ReconciliationReport;
  readonly sanction: ReconciliationSanction | null;
}): SealedReconciliationRecord {
  const { admittedSeams, report, sanction } = input;
  if (!sanction
    || typeof sanction.reviewerExecutionRef !== 'string'
    || !sanction.reviewerExecutionRef.trim()
    || typeof sanction.gateDecisionKey !== 'string'
    || !sanction.gateDecisionKey.trim()) {
    throw new Error(
      'RECONCILIATION_SANCTION_REQUIRED: reconciliation never writes into authority '
      + 'directly — an independent reviewer execution ref and a gate decision key '
      + 'are mandatory before sealing.',
    );
  }
  const validated = assembleReconciliationReport({
    admittedSeams,
    repairs: report.repairs,
    remainingGaps: report.remainingGaps,
    rationale: report.rationale,
  });
  return {
    report: validated,
    seamKeys: [...new Set(admittedSeams.map(seam => seam.seamKey))].sort(),
    sanction: {
      reviewerExecutionRef: sanction.reviewerExecutionRef.trim(),
      gateDecisionKey: sanction.gateDecisionKey.trim(),
    },
  };
}
