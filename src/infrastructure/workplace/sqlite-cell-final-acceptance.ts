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
   * ADR-053 Phase 6 — read the accepted GateDecision key for a specific
   * CandidateSet. Used to build AcceptedCandidateAuthority without execution-
   * scoped lookups.
   */
  getAcceptedGateDecisionKey(workplaceRef: string, candidateSetRef: string): string | null {
    return this.readAcceptedDecision(workplaceRef, candidateSetRef)?.decision_key ?? null;
  }

  private readAcceptedDecision(workplaceRef: string, candidateSetRef: string): {
    decision_key: string;
  } {
    const row = this.db.prepare(
      `SELECT decision_key
         FROM factory_gate_decisions
        WHERE workplace_ref=? AND subject_candidate_set_ref=? AND verdict='accepted'
        ORDER BY decided_at DESC,rowid DESC LIMIT 1`,
    ).get(workplaceRef, candidateSetRef) as { decision_key: string } | undefined;
    if (!row) {
      throw new Error(
        `CELL_FINAL_ACCEPTANCE_GATE_DECISION_MISSING: ${workplaceRef}/${candidateSetRef}`,
      );
    }
    return row;
  }
}
