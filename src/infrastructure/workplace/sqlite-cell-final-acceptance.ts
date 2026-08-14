import type Database from 'better-sqlite3';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import type { WorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import type { PostAcceptanceEffectResult } from '../../process-modules/application/post-acceptance-effects.js';

export interface CellEffectReceipt {
  readonly effectReceiptRef: string;
  readonly receiptDigest: string;
  readonly gateDecisionKey: string;
}

export class SqliteCellFinalAcceptance {
  constructor(private readonly db: Database.Database) {}

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  readEffectReceipt(
    workplaceRef: WorkplaceRef,
    effectId: string,
    candidateSetRef: string,
  ): CellEffectReceipt | null {
    const row = this.db.prepare(
      `SELECT effect_receipt_ref,receipt_digest,gate_decision_key
         FROM factory_cell_effect_receipts
        WHERE workplace_ref=? AND effect_id=? AND candidate_set_ref=?`,
    ).get(serializeWorkplaceRef(workplaceRef), effectId, candidateSetRef) as {
      effect_receipt_ref: string;
      receipt_digest: string;
      gate_decision_key: string;
    } | undefined;
    return row ? {
      effectReceiptRef: row.effect_receipt_ref,
      receiptDigest: row.receipt_digest,
      gateDecisionKey: row.gate_decision_key,
    } : null;
  }

  recordEffectReceipt(input: {
    readonly workplaceRef: WorkplaceRef;
    readonly effectId: string;
    readonly candidateSetRef: string;
    readonly result: Extract<PostAcceptanceEffectResult, { outcome: 'succeeded' }>;
  }): CellEffectReceipt {
    const workplace = serializeWorkplaceRef(input.workplaceRef);
    const decision = this.readAcceptedDecision(workplace, input.candidateSetRef);
    const body = {
      schema: 'factory.cell-effect-receipt.v1',
      workplaceRef: workplace,
      effectId: input.effectId,
      candidateSetRef: input.candidateSetRef,
      gateDecisionKey: decision.decision_key,
      providerReceiptRef: input.result.receiptRef,
      providerReceiptDigest: input.result.receiptDigest,
      evidence: input.result.evidence ?? {},
    } as const;
    const receiptDigest = sha256Hex(body);
    const effectReceiptRef = `cell-effect-receipt:${receiptDigest}`;
    const existing = this.readEffectReceipt(
      input.workplaceRef,
      input.effectId,
      input.candidateSetRef,
    );
    if (existing) {
      if (existing.receiptDigest !== receiptDigest) {
        throw new Error('CELL_EFFECT_RECEIPT_REPLAY_MISMATCH');
      }
      return existing;
    }
    this.db.prepare(
      `INSERT INTO factory_cell_effect_receipts
        (effect_receipt_ref,workplace_ref,effect_id,candidate_set_ref,
         gate_decision_key,provider_receipt_ref,provider_receipt_digest,
         evidence_snapshot,receipt_digest)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      effectReceiptRef,
      workplace,
      input.effectId,
      input.candidateSetRef,
      decision.decision_key,
      input.result.receiptRef,
      input.result.receiptDigest,
      canonicalJson(input.result.evidence ?? {}),
      receiptDigest,
    );
    return { effectReceiptRef, receiptDigest, gateDecisionKey: decision.decision_key };
  }

  recordFinalAcceptance(input: {
    readonly workplaceRef: WorkplaceRef;
    readonly candidateSetRef: string;
    readonly effectReceiptRefs: readonly string[];
    readonly acceptedAt: string;
  }): string {
    const workplace = serializeWorkplaceRef(input.workplaceRef);
    const state = this.db.prepare(
      `SELECT loop_state,terminal_reason FROM factory_workplaces WHERE workplace_ref=?`,
    ).get(workplace) as { loop_state: string; terminal_reason: string | null } | undefined;
    if (!state || state.loop_state !== 'terminal' || state.terminal_reason !== 'accepted') {
      throw new Error(`CELL_FINAL_ACCEPTANCE_WORKPLACE_NOT_TERMINAL: ${workplace}`);
    }
    const decision = this.readAcceptedDecision(workplace, input.candidateSetRef);
    const effectReceiptRefs = [...input.effectReceiptRefs].sort();
    for (const receiptRef of effectReceiptRefs) {
      const receipt = this.db.prepare(
        `SELECT 1 FROM factory_cell_effect_receipts
          WHERE effect_receipt_ref=? AND workplace_ref=? AND candidate_set_ref=?`,
      ).get(receiptRef, workplace, input.candidateSetRef);
      if (!receipt) throw new Error(`CELL_FINAL_ACCEPTANCE_EFFECT_RECEIPT_MISSING: ${receiptRef}`);
    }
    const body = {
      schema: 'factory.cell-final-acceptance.v1',
      workplaceRef: workplace,
      candidateSetRef: input.candidateSetRef,
      gateDecisionKey: decision.decision_key,
      effectReceiptRefs,
    } as const;
    const acceptanceDigest = sha256Hex(body);
    const finalAcceptanceRef = `cell-final-acceptance:${acceptanceDigest}`;
    const existing = this.db.prepare(
      `SELECT final_acceptance_ref,acceptance_digest
         FROM factory_cell_final_acceptances WHERE workplace_ref=?`,
    ).get(workplace) as {
      final_acceptance_ref: string;
      acceptance_digest: string;
    } | undefined;
    if (existing) {
      if (existing.acceptance_digest !== acceptanceDigest) {
        throw new Error('CELL_FINAL_ACCEPTANCE_REPLAY_MISMATCH');
      }
      return existing.final_acceptance_ref;
    }
    this.db.prepare(
      `INSERT INTO factory_cell_final_acceptances
        (final_acceptance_ref,workplace_ref,candidate_set_ref,gate_decision_key,
         effect_receipt_refs,acceptance_digest,accepted_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      finalAcceptanceRef,
      workplace,
      input.candidateSetRef,
      decision.decision_key,
      JSON.stringify(effectReceiptRefs),
      acceptanceDigest,
      input.acceptedAt,
    );
    return finalAcceptanceRef;
  }

  /**
   * ADR-053 Phase 7 — read the accepted CandidateSet ref for a workplace by
   * EXACT workplace match (factory_cell_final_acceptances.workplace_ref is
   * UNIQUE). This replaces the recency-based `latestCandidate` lookup in
   * post-acceptance code paths. Returns null when no final acceptance exists
   * (the workplace has not been accepted yet).
   */
  getAcceptedCandidateSetRef(workplaceRef: string): string | null {
    const row = this.db.prepare(
      `SELECT candidate_set_ref FROM factory_cell_final_acceptances WHERE workplace_ref = ?`,
    ).get(workplaceRef) as { candidate_set_ref: string } | undefined;
    return row?.candidate_set_ref ?? null;
  }

  /**
   * ADR-053 C6/C17 — the EXACT accepted GateDecision key for a candidate set.
   * Fail closed: if no accepted decision exists the caller has a real bug
   * (effects / final-acceptance running before the gate accepted), so this
   * throws rather than returning a nullable '' placeholder. Downstream
   * (replay-capture / replay-claim-binder / obligations) resolves the accepted
   * decision by this exact key instead of decided_at recency.
   */
  getAcceptedGateDecisionKey(workplaceRef: string, candidateSetRef: string): string {
    return this.readAcceptedDecision(workplaceRef, candidateSetRef).decision_key;
  }

  getAcceptedPrimaryOutput(workplaceRef: string, candidateSetRef: string): {
    productRefs: import('../../process-modules/domain/spi/production-envelope.js').ProductRef[];
    productContractRef: import('../../process-modules/application/post-acceptance-effects.js').AcceptedCandidateAuthority['productContractRef'];
  } {
    const decision = this.readAcceptedDecision(workplaceRef, candidateSetRef) as {
      decision_key: string;
      accepted_output_bindings: string;
    };
    const bindings = JSON.parse(decision.accepted_output_bindings) as Array<{
      binding: string;
      productRefs: import('../../process-modules/domain/spi/production-envelope.js').ProductRef[];
      productContractRef?: import('../../process-modules/application/post-acceptance-effects.js').AcceptedCandidateAuthority['productContractRef'];
    }>;
    const primary = bindings.filter(binding => binding.binding === 'primary-output');
    if (primary.length !== 1 || primary[0]!.productRefs.length !== 1) {
      throw new Error(`CELL_FINAL_ACCEPTANCE_PRIMARY_OUTPUT_INVALID: ${workplaceRef}/${candidateSetRef}`);
    }
    return {
      productRefs: primary[0]!.productRefs,
      productContractRef: primary[0]!.productContractRef ?? null,
    };
  }

  private readAcceptedDecision(workplaceRef: string, candidateSetRef: string): {
    decision_key: string;
    accepted_output_bindings: string;
  } {
    // ADR-053 C4 — read the accepted FINAL gate decision by EXACT (workplace,
    // subject, gate_phase='final'), NOT by decided_at recency. For a given
    // subject CandidateSet there is at most ONE accepted final-phase decision
    // (the final gate runs once per subject; replays produce the same
    // decision_key via INSERT OR IGNORE). The previous ORDER BY decided_at was a
    // fragile tiebreaker that, in a review cell, could otherwise not distinguish
    // the author-phase acceptance from the final-phase acceptance for the same
    // subject — filtering gate_phase='final' removes that ambiguity entirely.
    // Two accepted final decisions for one subject is an invariant violation and
    // must fail closed, not silently pick the "latest".
    const rows = this.db.prepare(
      `SELECT decision_key,accepted_output_bindings
         FROM factory_gate_decisions
        WHERE workplace_ref=? AND subject_candidate_set_ref=? AND verdict='accepted'
          AND gate_phase='final'`,
    ).all(workplaceRef, candidateSetRef) as Array<{
      decision_key: string;
      accepted_output_bindings: string;
    }>;
    if (rows.length === 0) {
      throw new Error(
        `CELL_FINAL_ACCEPTANCE_GATE_DECISION_MISSING: ${workplaceRef}/${candidateSetRef}`,
      );
    }
    if (rows.length > 1) {
      throw new Error(
        `CELL_FINAL_ACCEPTANCE_GATE_DECISION_NOT_UNIQUE: ${workplaceRef}/${candidateSetRef} has ${rows.length} accepted final decisions`,
      );
    }
    return rows[0]!;
  }
}
