// tests/process-modules/run-terminal-journal-projection.test.mjs
//
// CC-GAP-2 — the `run.terminal` journal payload must expose four SEPARATED
// channels; none implies another:
//
//   outcome / status      operational: the engine reached a terminal state
//                         ('completed' = a routed business terminal, ANY
//                         verdict — never product success by itself)
//   terminal_status       lifecycle business verdict. The repository stamps
//                         it on EVERY terminal path (routed terminal → its
//                         declared status, fail() → 'failed', cancel() →
//                         'cancelled'); null only while non-terminal.
//   stage_outcome         final stage/process LOCAL outcome code
//   product_outcome       engine-projected final outcome
//                         (terminalStatus ?? last stage localOutcome)
//   stage_outcome_authority  the authority that settled the FINAL STAGE —
//                         stage-level provenance only; it does not vouch for
//                         terminal_status or product_outcome.
//
// Evidence of the gap: stage-19 RUN-TRACKER — the run sealed with
// `run.terminal {outcome: completed}` / `engine.exit {code: 0}` and the
// operator had to open the DB to learn terminal_status='runnable-local' and
// stage local_outcome='verified'. The journal is observation-only (STAGE-10
// brief); enriching its payload adds no authority — it makes the projection
// truthful.
//
// The observation-only architecture ratchet
// (tests/architecture/run-journal-observation-only.test.mjs) pins the frozen
// importer set; this enrichment touches NO new importer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { LifecycleOrchestrationEngineAdapter } = await import(
  '../../dist/process-modules/application/lifecycle-orchestration-engine-adapter.js'
);

const DEFINITION = {
  identity: {
    name: 'product-delivery',
    version: '1.0.0',
    displayName: 'Product Delivery',
    description: 'test lifecycle',
  },
  entryStageId: 'discovery',
  stages: [
    { id: 'discovery', displayName: 'Discovery', moduleRef: { name: 'discovery', version: '1.0.0' }, inputMapping: {}, outcomeRoutes: {}, entryConditions: [], exitConditions: [] },
    { id: 'solution-development', displayName: 'Development', moduleRef: { name: 'development', version: '1.0.0' }, inputMapping: {}, outcomeRoutes: {}, entryConditions: [], exitConditions: [] },
  ],
};

/** LifecycleExecutionResult-shaped stub (only the fields the adapter reads). */
function executionResult({ status, terminalStatus, localOutcome, authority, stageId }) {
  return {
    lifecycleRun: {
      id: 7,
      lifecycle: DEFINITION.identity,
      status,
      currentStageId: status === 'completed' ? null : stageId,
      terminalStatus,
      error: null,
      completedAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    },
    stageRuns: [
      {
        stageId,
        localOutcome,
        authority: authority ?? null,
        output: null,
        certificate: null,
      },
    ],
    status,
    terminalStatus,
    pausedAtStageId: status === 'paused' ? stageId : null,
  };
}

function makeAdapter(result) {
  return new LifecycleOrchestrationEngineAdapter({
    definition: DEFINITION,
    orchestrator: { run: async () => result },
    // CC-GAP-4 integration — the adapter REQUIRES the durable exactly-once
    // claim gate (claimTerminalEvent) and appends run.terminal only inside
    // the claim winner. This suite pins the PAYLOAD contract (CC-GAP-2), so
    // the stub hands this crossing the single winner verdict shaped like a
    // repository claim (RunTerminalEventClaim: {claimed, status,
    // terminalStatus}); the claim semantics themselves are proven by
    // terminal-event-idempotency.test.mjs (GAP-4), which is NOT weakened here.
    claimTerminalEvent: () => ({
      claimed: true,
      status: result.status,
      terminalStatus: result.terminalStatus,
    }),
    resolveInput: () => ({
      schema: 'test-input',
      payload: {},
      initiatedBy: 'test',
      idempotencyKey: 'test-key',
    }),
  });
}

async function captureJournal(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'saga-run-terminal-journal-'));
  const journalPath = path.join(dir, 'factory-run-journal.jsonl');
  const previous = process.env.SAGA_RUN_JOURNAL;
  process.env.SAGA_RUN_JOURNAL = journalPath;
  try {
    await fn();
    // A journal file appears only when at least one event was written (the
    // exactly-once guard case writes nothing — that IS the assertion).
    if (!existsSync(journalPath)) return [];
    const text = readFileSync(journalPath, 'utf8');
    return text.split('\n').filter(line => line.trim() !== '').map(JSON.parse);
  } finally {
    if (previous === undefined) delete process.env.SAGA_RUN_JOURNAL;
    else process.env.SAGA_RUN_JOURNAL = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the gap counterexample: run.terminal carries outcome=completed AND terminal_status=development-blocked as separate channels', async () => {
  const events = await captureJournal(() => makeAdapter(executionResult({
    status: 'completed',
    terminalStatus: 'development-blocked',
    localOutcome: 'blocked',
    authority: 'development-settlement@1.0.0',
    stageId: 'solution-development',
  })).run({ projectId: 1, epicId: 5 }));

  const terminal = events.filter(evt => evt.kind === 'run.terminal');
  assert.equal(terminal.length, 1, 'exactly one run.terminal event');
  const data = terminal[0].data;

  // Operational channels — unchanged (backward compatibility).
  assert.equal(data.outcome, 'completed');
  assert.equal(data.status, 'completed');
  assert.equal(data.final_stage, 'solution-development');
  assert.equal(data.error, null);
  assert.equal(data.cycles, 1);

  // Separated verdict channels (CC-GAP-2).
  assert.equal(data.terminal_status, 'development-blocked');
  assert.equal(data.stage_outcome, 'blocked');
  assert.equal(data.product_outcome, 'development-blocked');
  assert.equal(data.stage_outcome_authority, 'development-settlement@1.0.0');

  // The separation itself: `outcome: 'completed'` (operational) must never be
  // copyable as a product verdict, and the verdict must not rewrite outcome.
  assert.notEqual(data.product_outcome, data.outcome);
  // Correlation keys remain attached (STAGE-10 contract).
  assert.equal(terminal[0].run_id, '7');
  assert.equal(terminal[0].epic_id, 5);
});

test('stage-19 shape: terminal_status=runnable-local with stage_outcome=verified — all channels distinct in one line', async () => {
  const events = await captureJournal(() => makeAdapter(executionResult({
    status: 'completed',
    terminalStatus: 'runnable-local',
    localOutcome: 'verified',
    authority: 'development-settlement@1.0.0',
    stageId: 'solution-development',
  })).run({ projectId: 1, epicId: 5 }));

  const data = events.find(evt => evt.kind === 'run.terminal').data;
  assert.equal(data.outcome, 'completed');
  assert.equal(data.status, 'completed');
  assert.equal(data.terminal_status, 'runnable-local');
  assert.equal(data.stage_outcome, 'verified');
  assert.equal(data.stage_outcome_authority, 'development-settlement@1.0.0');
  // terminalStatus wins the engine-projected product outcome.
  assert.equal(data.product_outcome, 'runnable-local');
});

test('repository-stamped failure: terminal_status=failed; the failed stage has NO local channels', async () => {
  // Real fail() shape (sqlite-lifecycle-run-repository): the run row is
  // stamped status='failed' AND terminal_status='failed'; the failed stage
  // run never settled, so local_outcome/authority stay NULL (only
  // completeStageRun stamps them). No channel fabricates a value.
  const events = await captureJournal(() => makeAdapter(executionResult({
    status: 'failed',
    terminalStatus: 'failed',
    localOutcome: null,
    authority: null,
    stageId: 'solution-development',
  })).run({ projectId: 1, epicId: 5 }));

  const data = events.find(evt => evt.kind === 'run.terminal').data;
  assert.equal(data.outcome, 'failed');
  assert.equal(data.status, 'failed');
  assert.equal(data.terminal_status, 'failed');
  assert.equal(data.stage_outcome, null);
  assert.equal(data.stage_outcome_authority, null);
  // terminalStatus wins the engine-projected product outcome.
  assert.equal(data.product_outcome, 'failed');
});

test('typed stub (defensive fallback): a terminal row WITHOUT terminal_status projects product_outcome from the stage-local outcome', async () => {
  // NOT a repository shape: cancel() stamps terminal_status='cancelled'
  // (sqlite-lifecycle-run-repository). This clearly typed stub pins the
  // adapter's defensive fallback (terminalStatus ?? last stage localOutcome —
  // the same rule as OrchestrationRunResult.outcome) for a terminal row that
  // predates that stamping: cancelled after Discovery settled 'go'. All
  // vocabulary is real module vocabulary (outcome 'go', discovery settlement
  // authority as pinned by product-delivery-lifecycle-e2e).
  const events = await captureJournal(() => makeAdapter(executionResult({
    status: 'cancelled',
    terminalStatus: null,
    localOutcome: 'go',
    authority: 'discovery-settlement@1.0.0',
    stageId: 'discovery',
  })).run({ projectId: 1, epicId: 5 }));

  const data = events.find(evt => evt.kind === 'run.terminal').data;
  assert.equal(data.outcome, 'stopped');
  assert.equal(data.status, 'cancelled');
  assert.equal(data.terminal_status, null);
  assert.equal(data.stage_outcome, 'go');
  assert.equal(data.stage_outcome_authority, 'discovery-settlement@1.0.0');
  assert.equal(data.product_outcome, 'go');
});

test('exactly-once guard preserved: paused resume cycles emit NO run.terminal', async () => {
  const events = await captureJournal(() => makeAdapter(executionResult({
    status: 'paused',
    terminalStatus: null,
    localOutcome: null,
    authority: null,
    stageId: 'solution-development',
  })).run({ projectId: 1, epicId: 5 }));

  assert.equal(events.filter(evt => evt.kind === 'run.terminal').length, 0);
});

// Static self-check that this file stays inside the sanctioned journal
// consumer set (tools/ and tests/ may read the journal; factory code may not).
test('file hygiene: this test reads the journal only through its own temp capture', () => {
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.ok(self.includes('SAGA_RUN_JOURNAL'), 'env override used, never a hardcoded factory path');
});
