// Verification Accounting — HTTP adapter (route-only).
//
// CC-GAP-8 terminal accounting: the truthful user-facing projection of the
// Development criterion-key verification ledger, served by the existing
// tracker/board backend. Every response is built from the append-only ledger
// projection and passes through the RENDER GUARD
// (`assertRenderedAccountingTruthful`) before it is published: a surface fed
// by this endpoint can never fabricate executed verification — rendering a
// pending / executed-failed / terminal-unknown / terminal-blocked /
// terminal-human-required / legacy-unaccounted obligation as discharged (or
// as a state the ledger does not hold) fails the request loudly.
//
// Clean-architecture boundary (mirrors lifecycle-pipeline/pipeline-api.mjs):
// this module knows HTTP and nothing else. The ledger projection, integrity
// invariant and render guard live in the Development module
// (`dist/modules/development/...`); this adapter only reads them per epic
// and translates the result into JSON.
//
// Route (wired in tracker-view.mjs):
//   GET /api/development/verification-accounting?epic_id=N
//     -> { ok:true, epicId, runs:[ { processRunId, accountingType,
//          terminalRouteRecorded, summary, entries:[...] } ] }
//     -> { ok:true, epicId, runs:[] }   (nothing materialized to account)
//
// The published entry shape is EXACTLY the ledger projection entry (state,
// outcome, discharged, terminal route/reason codes/provenance/attribution,
// stage coordinates) — the board renders these strings as-is.

import {
  listDevelopmentVerificationAccountingByEpic,
} from '../dist/modules/development/infrastructure/development-verification-ledger.js';
import {
  assertRenderedAccountingTruthful,
} from '../dist/modules/development/domain/verification-accounting.js';

export function createVerificationAccountingApi({ withDb, respondJson }) {
  /** GET /api/development/verification-accounting?epic_id=N */
  async function handleVerificationAccounting(req, res, url) {
    const epicId = Number(url.searchParams.get('epic_id'));
    if (!Number.isSafeInteger(epicId) || epicId <= 0) {
      return respondJson(res, 400, { ok: false, error: 'epic_id required' });
    }
    try {
      const accounting = withDb(db =>
        listDevelopmentVerificationAccountingByEpic(db, { epicId }));
      const runs = accounting.map(projection => {
        // Render guard: prove the rows this endpoint is about to publish are
        // truthful against the ledger projection BEFORE publishing them.
        assertRenderedAccountingTruthful({
          rendered: projection.entries.map(entry => ({
            criterionKey: entry.criterionKey,
            discharged: entry.discharged,
            renderedState: entry.state,
          })),
          projection,
        });
        return {
          processRunId: projection.processRunId,
          accountingType: projection.accountingType,
          terminalRouteRecorded: projection.terminalRouteRecorded,
          summary: projection.summary,
          entries: projection.entries.map(entry => ({
            criterionKey: entry.criterionKey,
            verificationItemKey: entry.verificationItemKey,
            required: entry.required,
            criticality: entry.criticality,
            state: entry.state,
            outcome: entry.outcome,
            ordinal: entry.ordinal,
            executionStage: entry.stage.executionStage,
            gatedBy: entry.stage.gatedBy,
            owner: entry.owner,
            unblockCondition: entry.unblockCondition,
            discharged: entry.discharged,
            terminalRoute: entry.terminalRoute,
            terminalReasonCodes: entry.terminalReasonCodes,
            terminalProvenanceRef: entry.terminalProvenanceRef,
            terminalAttributedTo: entry.terminalAttributedTo,
            lastEventAt: entry.lastEventAt,
          })),
        };
      });
      return respondJson(res, 200, { ok: true, epicId, runs });
    } catch (e) {
      // Honest failure: a guard/integrity violation must not be masked.
      return respondJson(res, 500, {
        ok: false,
        error: 'verification-accounting: ' + (e && e.message ? e.message : String(e)),
      });
    }
  }

  return { handleVerificationAccounting };
}
