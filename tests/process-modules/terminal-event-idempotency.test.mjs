// tests/process-modules/terminal-event-idempotency.test.mjs
//
// CC-GAP-4 — deterministic idempotent `run.terminal` uniqueness per
// terminalized scope.
//
// THE DEFECT (traced): the engine-adapter boundary
// (lifecycle-orchestration-engine-adapter.ts) is re-entered by TWO competing
// terminal paths for the same lifecycle run:
//
//   1. the DISPATCH path — engine.run() -> baseEngine.run(command)
//      (product-lifecycle-runtime.ts, end of engine.run);
//   2. the TRANSITION-OBLIGATION RE-DRIVE path — the route-lifecycle handler
//      -> baseEngine.run(command) (product-lifecycle-runtime.ts, inside the
//      obligation handler), which the reconcile sweep executes at the TOP of
//      the very same engine.run() call.
//
// Both replay the durable terminal record through the orchestrator
// (orchestrator.run -> repo.start replays the row -> early terminal return),
// and the old status guard (`!== 'paused' && !== 'running'`) gated nothing on
// replay — every replay of a terminalized scope appended ANOTHER run.terminal
// line. The stage-11 comment claimed "the guard keeps it exactly-once"; it
// did not. One terminalization could journal N terminal events (Elite-6
// evidence style: duplicate terminal lines in factory-run-journal.jsonl).
//
// THE FIX under test: emission is gated by a durable exactly-once claim on
// the authority (factory_run_terminal_event_receipts, keyed by lifecycle run
// id) taken BEFORE the journal append. Exactly one competing path — across
// replays, resumes, re-drives, and separate engine processes/repositories —
// ever claims; everyone else stays silent. Historical journal lines and
// historical terminal rows are never rewritten: a scope terminalized before
// the fix simply has no receipt row until its first post-fix replay.
//
// Proves:
//   T1  the authority claim is exactly-once per terminalized scope, refuses
//       to claim (and does not burn) on non-terminal/missing rows, and
//       agrees across independent repository instances AND across truly
//       separate SQLite connections on the same database file — whichever
//       connection claims first, exactly one winner (SQLite serializes the
//       claimants across connections);
//   T2  dispatch -> terminal emits exactly ONE run.terminal; the obligation
//       re-drive (same engine.run shape: sweep re-drive + dispatch replay)
//       adds NOTHING; concurrent competing replays add NOTHING;
//   T3  an operator-cancelled scope (a third terminal path) journals exactly
//       one run.terminal via whichever path first crosses the adapter;
//   T4  pause cycles never emit and never burn the claim; the eventual
//       terminalization still emits exactly once;
//   T5  a PRE-FIX terminalized scope (terminal row, no receipt — the Elite-6
//       shape) emits exactly once on its first post-fix adapter replay, then
//       never again (forward-only; no history rewrite);
//   T6  obligation receipts/fencing inputs survive: every re-drive still
//       returns the full terminal lifecycleRun result (id/status/
//       terminalStatus — the exact fields the route-lifecycle completion
//       receipt digest consumes) and the durable receipt/fence rows are
//       intact;
//   T7  (red-team N1) the claim/journal pair is observation: a
//       claimTerminalEvent that throws a post-commit DB error never
//       propagates into engine behavior — the terminal result still returns
//       on dispatch AND on the re-drive replay, nothing is emitted, nothing
//       is burned, and the SAME scope later emits exactly once when the
//       claim plane works again (the honest 0..1 envelope per terminalized
//       scope: at most one, possibly zero, never two).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteLifecycleRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js'
);
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { LifecycleOrchestrator } = await import(
  '../../dist/process-modules/application/lifecycle-orchestrator.js'
);
const { LifecycleOrchestrationEngineAdapter } = await import(
  '../../dist/process-modules/application/lifecycle-orchestration-engine-adapter.js'
);
const { canonicalJson, sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);

process.env.SAGA_RUN_JOURNAL = 'off';

// ---------------------------------------------------------------------------
// Harness: real SQLite repos, real orchestrator, real adapter — the same
// shapes product-lifecycle-runtime wires; only the module executor is a
// scripted stub that settles the durable ProcessRun row.
// ---------------------------------------------------------------------------

const moduleDefinition = {
  identity: {
    name: 'gap4-module',
    version: '1.0.0',
    kind: 'test',
    displayName: 'GAP-4 Module',
    description: 'CC-GAP-4 terminal idempotency module.',
  },
  inputContract: { id: 'gap4.input.v1' },
  outputContract: { id: 'gap4.output.v1' },
  outcomes: [{ code: 'done', description: 'Done.', terminal: true }],
  flow: {
    id: 'gap4.flow',
    version: '1.0.0',
    entryNodeId: 'finish',
    nodes: [],
    transitions: [],
    terminalNodeIds: [],
  },
  artifacts: [],
  policies: [],
  invariants: [],
  executionProfiles: [],
};

const lifecycleDefinition = {
  identity: {
    name: 'gap4-lifecycle',
    version: '1.0.0',
    displayName: 'GAP-4 Lifecycle',
    description: 'One-stage lifecycle to a terminal outcome.',
  },
  entryStageId: 'stage-one',
  stages: [{
    id: 'stage-one',
    displayName: 'Stage One',
    moduleRef: {
      name: moduleDefinition.identity.name,
      version: moduleDefinition.identity.version,
    },
    inputMapping: { value: '$.value' },
    outputMapping: { observedOutcome: '$.processOutcome.outcome' },
    outcomeRoutes: {
      done: { type: 'terminal', status: 'done' },
    },
    entryConditions: [],
    exitConditions: [],
  }],
};

const leasedTransitionObligations = {
  onProcessSettled(input) {
    return {
      obligationKey: `process-settled:process-run:${input.processRunId}:route-lifecycle`,
      state: 'in_progress',
    };
  },
};

function makeFixture() {
  const temp = mkdtempSync(join(tmpdir(), 'gap4-terminal-'));
  process.env.DB_PATH = join(temp, 'gap4.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (7,'GAP-4','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (8,7,'E1')`).run();
  const lifecycleRunRepo = new SqliteLifecycleRunRepository(db);
  const processRunRepo = new SqliteProcessRunRepository(db);
  return { temp, db, lifecycleRunRepo, processRunRepo };
}

function cleanupFixture(fixture) {
  closeDb();
  rmSync(fixture.temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

/**
 * Scripted executor: settles the durable ProcessRun row, exactly like a
 * production module executor does. `script[call]` selects the behavior of
 * the nth execution ('complete' | 'pause').
 */
function makeExecutor(processRunRepo, script) {
  let call = 0;
  return {
    moduleRef: {
      name: moduleDefinition.identity.name,
      version: moduleDefinition.identity.version,
    },
    // A real ProcessRun row CHECKs executor_kind against the closed set —
    // the stub must present a lawful kind, not an invented one.
    kind: 'generic-flow',
    async execute(_definition, context) {
      const behavior = script[Math.min(call, script.length - 1)];
      call += 1;
      processRunRepo.update(context.processRunId, { status: 'running' });
      if (behavior === 'pause') {
        processRunRepo.update(context.processRunId, {
          status: 'paused',
          error: 'GAP4_SCRIPTED_PAUSE',
        });
        return { paused: true };
      }
      processRunRepo.update(context.processRunId, {
        status: 'completed',
        localOutcome: 'done',
        authority: 'gap4-test-policy',
        completedAt: new Date().toISOString(),
      });
      return { outcome: 'done' };
    },
  };
}

function makeAdapter(
  fixture,
  { script = ['complete'], idempotencyKey = 'gap4-run', claimTerminalEvent } = {},
) {
  const executor = makeExecutor(fixture.processRunRepo, script);
  const orchestrator = new LifecycleOrchestrator({
    lifecycleRunRepo: fixture.lifecycleRunRepo,
    processRunRepo: fixture.processRunRepo,
    moduleRegistry: { get: () => moduleDefinition, require: () => moduleDefinition },
    installationRegistry: {
      require: () => ({ definition: moduleDefinition, executor }),
    },
    transitionObligations: leasedTransitionObligations,
  });
  // The production wiring: the claim is the repo's durable exactly-once
  // verdict (product-lifecycle-runtime passes lifecycleRunRepo through).
  // T7 overrides it with a throwing stub to force the N1 failure shape.
  const adapter = new LifecycleOrchestrationEngineAdapter({
    definition: lifecycleDefinition,
    orchestrator,
    claimTerminalEvent: claimTerminalEvent ?? (lifecycleRunId =>
      fixture.lifecycleRunRepo.claimRunTerminalEvent(lifecycleRunId)),
    resolveInput: command => ({
      schema: 'gap4.lifecycle-input.v1',
      payload: { value: 'gap4' },
      initiatedBy: command.initiatedBy ?? 'gap4-test',
      idempotencyKey,
      resumePaused: command.resumePaused,
    }),
  });
  const command = {
    projectId: 7,
    epicId: 8,
    idempotencyKey,
    initiatedBy: 'gap4-test',
    resumePaused: false,
  };
  return { adapter, command, executor };
}

// A journal observer: points SAGA_RUN_JOURNAL at a temp file for the body and
// restores 'off' afterwards (tests are a sanctioned journal consumer).
function withJournal(body) {
  const dir = mkdtempSync(join(tmpdir(), 'gap4-journal-'));
  const journalPath = join(dir, 'factory-run-journal.jsonl');
  process.env.SAGA_RUN_JOURNAL = journalPath;
  const readTerminalEvents = () => (existsSync(journalPath)
    ? readFileSync(journalPath, 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(event => event.kind === 'run.terminal')
    : []);
  return Promise.resolve(body(readTerminalEvents)).finally(() => {
    process.env.SAGA_RUN_JOURNAL = 'off';
    rmSync(dir, { recursive: true, force: true });
  });
}

function startLifecycleRow(fixture, idempotencyKey) {
  const payload = { value: 'gap4' };
  return fixture.lifecycleRunRepo.start({
    lifecycle: lifecycleDefinition.identity,
    definitionSnapshot: canonicalJson(lifecycleDefinition),
    definitionHash: sha256Hex(lifecycleDefinition),
    entryStageId: lifecycleDefinition.entryStageId,
    input: {
      schema: 'gap4.lifecycle-input.v1',
      payload,
      contentHash: sha256Hex(payload),
    },
    invocationContext: {
      projectId: 7,
      epicId: 8,
      initiatedBy: 'gap4-test',
      idempotencyKey,
    },
  });
}

// ===========================================================================
// T1 — the durable claim: exactly-once per terminalized scope, authority-
// checked, cross-instance (process) safe, never burned by a premature probe.
// ===========================================================================
test('T1: claimRunTerminalEvent is exactly-once per terminalized scope and refuses non-terminal rows', () => {
  const fixture = makeFixture();
  try {
    const first = startLifecycleRow(fixture, 'gap4-claim');
    const runId = first.record.id;

    // Non-terminal (created) and missing rows: fail-closed, claim NOT burned.
    assert.equal(fixture.lifecycleRunRepo.claimRunTerminalEvent(runId), null,
      'a created run must not be claimable');
    assert.equal(fixture.lifecycleRunRepo.claimRunTerminalEvent(999999), null,
      'a missing run must not be claimable');
    assert.equal(
      fixture.db.prepare(
        'SELECT COUNT(*) AS n FROM factory_run_terminal_event_receipts',
      ).get().n,
      0,
      'a premature probe must not burn the claim',
    );

    // Terminalize through the authority (fail path).
    const lease = fixture.lifecycleRunRepo.acquireExecutionLease(
      runId, 't1-owner', new Date().toISOString(), '2099-01-01T00:00:00.000Z',
    );
    fixture.lifecycleRunRepo.fail(runId, null, 'GAP4 terminalization', lease);

    const claim1 = fixture.lifecycleRunRepo.claimRunTerminalEvent(runId);
    assert.deepEqual(
      { claimed: claim1.claimed, status: claim1.status },
      { claimed: true, status: 'failed' },
      'the first claimant wins',
    );
    const claim2 = fixture.lifecycleRunRepo.claimRunTerminalEvent(runId);
    assert.equal(claim2.claimed, false, 'the second claimant loses');

    // A second repository instance on the same DB (a second engine process)
    // reaches the same verdict — the claim is durable, not in-memory.
    const secondRepo = new SqliteLifecycleRunRepository(fixture.db);
    assert.equal(secondRepo.claimRunTerminalEvent(runId).claimed, false,
      'a second repository instance (process) must observe the burned claim');

    // N3 — a TRULY SEPARATE SQLite CONNECTION: a second engine process with
    // its own database handle open on the same file. SQLite serializes the
    // claimants across connections, so exactly one connection ever wins —
    // in EITHER direction, regardless of which connection claims first.
    const separateDb = new Database(process.env.DB_PATH);
    separateDb.pragma('journal_mode = WAL');
    separateDb.pragma('foreign_keys = ON');
    separateDb.pragma('busy_timeout = 5000');
    try {
      const separateRepo = new SqliteLifecycleRunRepository(separateDb);
      assert.equal(separateRepo.claimRunTerminalEvent(runId).claimed, false,
        'a separate connection must observe the claim already burned by the first connection');

      // Reverse direction: a THIRD scope where the separate connection is
      // the first (and only) claimant — the first connection then loses.
      const third = startLifecycleRow(fixture, 'gap4-claim-3');
      const lease3 = fixture.lifecycleRunRepo.acquireExecutionLease(
        third.record.id, 't1-owner', new Date().toISOString(), '2099-01-01T00:00:00.000Z',
      );
      fixture.lifecycleRunRepo.fail(third.record.id, null, 'GAP4 third', lease3);
      assert.equal(
        separateRepo.claimRunTerminalEvent(third.record.id).claimed,
        true,
        'the separate connection can be the single claim winner',
      );
      assert.equal(
        fixture.lifecycleRunRepo.claimRunTerminalEvent(third.record.id).claimed,
        false,
        '... and the first connection then loses that same claim',
      );
      assert.deepEqual(
        separateDb.prepare(
          `SELECT COUNT(*) AS n FROM factory_run_terminal_event_receipts
            WHERE lifecycle_run_id=?`,
        ).get(third.record.id),
        { n: 1 },
        'exactly ONE receipt row for the scope across both connections',
      );
    } finally {
      separateDb.close();
    }

    // Uniqueness is PER TERMINALIZED SCOPE, not global: a different run
    // terminalizing later gets its own single claim.
    const second = startLifecycleRow(fixture, 'gap4-claim-2');
    const lease2 = fixture.lifecycleRunRepo.acquireExecutionLease(
      second.record.id, 't1-owner', new Date().toISOString(), '2099-01-01T00:00:00.000Z',
    );
    fixture.lifecycleRunRepo.fail(second.record.id, null, 'GAP4 second', lease2);
    assert.equal(
      fixture.lifecycleRunRepo.claimRunTerminalEvent(second.record.id).claimed,
      true,
      'a different terminalized scope claims its own exactly-once event',
    );
  } finally {
    cleanupFixture(fixture);
  }
});

// ===========================================================================
// T2 — the two competing terminal paths: dispatch drives to terminal (ONE
// event); the obligation re-drive + dispatch replay inside the same
// engine.run shape, and concurrent competing replays, add NOTHING.
// ===========================================================================
test('T2: dispatch + obligation re-drive + concurrent replays produce exactly one effective run.terminal', async () => {
  const fixture = makeFixture();
  try {
    const { adapter, command } = makeAdapter(fixture);

    await withJournal(async readTerminalEvents => {
      // Path 1 — the dispatch: drives the lifecycle to its terminal state.
      const dispatched = await adapter.run(command);
      assert.equal(dispatched.lifecycleRun.status, 'completed');
      assert.equal(dispatched.lifecycleRun.terminalStatus, 'done');
      assert.equal(readTerminalEvents().length, 1,
        'the dispatch terminalization emits exactly one run.terminal');

      // Path 2 — the obligation re-drive: the route-lifecycle handler
      // re-drives the SAME lifecycle (same idempotency key, resumePaused)
      // and replays the terminal record. Before CC-GAP-4 this appended a
      // SECOND run.terminal line.
      const redrive = await adapter.run({ ...command, resumePaused: true });
      assert.equal(redrive.lifecycleRun.status, 'completed');

      // Path 3 — the same engine.run() shape as product-lifecycle-runtime:
      // a sweep re-drive and the trailing dispatch replay compete inside one
      // call, fired concurrently.
      await Promise.allSettled([
        adapter.run({ ...command, resumePaused: true }),
        adapter.run({ ...command, resumePaused: true }),
      ]);

      const events = readTerminalEvents();
      assert.equal(events.length, 1,
        `competing terminal paths must yield exactly ONE effective run.terminal; got ${events.length}`);

      // The effective event is the first terminalization's fact.
      const [event] = events;
      assert.equal(event.run_id, String(dispatched.lifecycleRun.id));
      assert.equal(event.data.status, 'completed');
      assert.equal(event.data.outcome, 'completed');
      assert.equal(event.data.final_stage, 'stage-one');
      assert.equal(event.data.cycles, 1);

      // The durable receipt records the single claim.
      assert.equal(
        fixture.db.prepare(
          'SELECT COUNT(*) AS n FROM factory_run_terminal_event_receipts',
        ).get().n,
        1,
      );
    });
  } finally {
    cleanupFixture(fixture);
  }
});

// ===========================================================================
// T3 — a third terminal path (operator cancellation) still yields exactly
// one event: whichever path first crosses the adapter claims.
// ===========================================================================
test('T3: an externally cancelled scope journals exactly one run.terminal via the re-drive', async () => {
  const fixture = makeFixture();
  try {
    const { adapter, command } = makeAdapter(fixture, { script: ['pause'] });

    await withJournal(async readTerminalEvents => {
      // Pause first so the operator can cancel a non-terminal run.
      const paused = await adapter.run(command);
      assert.equal(paused.lifecycleRun.status, 'paused');
      assert.equal(readTerminalEvents().length, 0,
        'a pause is not a terminalization — nothing is emitted or claimed');

      const runId = paused.lifecycleRun.id;
      const current = fixture.lifecycleRunRepo.read(runId);
      fixture.lifecycleRunRepo.cancel(runId, current.version, 'GAP4 operator stop');

      // The re-drive replays the cancelled terminal record — it is the first
      // path to cross the adapter, so IT is the effective single emitter.
      const redrive = await adapter.run({ ...command, resumePaused: true });
      assert.equal(redrive.lifecycleRun.status, 'cancelled');

      const events = readTerminalEvents();
      assert.equal(events.length, 1,
        'the externally-terminalized scope emits exactly one run.terminal');
      assert.equal(events[0].data.status, 'cancelled');
      assert.equal(events[0].data.outcome, 'stopped');
    });
  } finally {
    cleanupFixture(fixture);
  }
});

// ===========================================================================
// T4 — pause/resume cycles never emit and never burn the claim; the eventual
// terminalization still emits exactly once.
// ===========================================================================
test('T4: pause cycles burn nothing; the resumed terminalization emits exactly once', async () => {
  const fixture = makeFixture();
  try {
    const { adapter, command } = makeAdapter(fixture, { script: ['pause', 'complete'] });

    await withJournal(async readTerminalEvents => {
      const paused = await adapter.run(command);
      assert.equal(paused.lifecycleRun.status, 'paused');
      assert.equal(readTerminalEvents().length, 0);
      assert.equal(
        fixture.db.prepare(
          'SELECT COUNT(*) AS n FROM factory_run_terminal_event_receipts',
        ).get().n,
        0,
        'a pause must not burn the terminal claim',
      );

      const resumed = await adapter.run({ ...command, resumePaused: true });
      assert.equal(resumed.lifecycleRun.status, 'completed');

      const replay = await adapter.run({ ...command, resumePaused: true });
      assert.equal(replay.lifecycleRun.status, 'completed');

      assert.equal(readTerminalEvents().length, 1,
        'one terminalization after pause cycles — exactly one event');
    });
  } finally {
    cleanupFixture(fixture);
  }
});

// ===========================================================================
// T5 — forward-only history: a scope terminalized BEFORE the claim existed
// (the Elite-6 shape — terminal row, no receipt) emits exactly once on its
// first post-fix adapter crossing, then never again. Nothing is rewritten.
// ===========================================================================
test('T5: a pre-fix terminalized scope (Elite-6 shape) emits once on first replay, never again', async () => {
  const fixture = makeFixture();
  try {
    // Terminalize entirely through the authority, no adapter crossing —
    // exactly how every pre-CC-GAP-4 terminal row looks to the new code.
    const started = startLifecycleRow(fixture, 'gap4-prefix');
    const runId = started.record.id;
    const lease = fixture.lifecycleRunRepo.acquireExecutionLease(
      runId, 't5-owner', new Date().toISOString(), '2099-01-01T00:00:00.000Z',
    );
    fixture.lifecycleRunRepo.fail(runId, null, 'GAP4 pre-fix failure', lease);
    assert.equal(
      fixture.db.prepare(
        'SELECT COUNT(*) AS n FROM factory_run_terminal_event_receipts',
      ).get().n,
      0,
      'the historical terminal fact carries no receipt — and is not rewritten',
    );

    const { adapter, command } = makeAdapter(fixture, { idempotencyKey: 'gap4-prefix' });
    await withJournal(async readTerminalEvents => {
      const replay = await adapter.run({ ...command, resumePaused: true });
      assert.equal(replay.lifecycleRun.status, 'failed');
      assert.equal(readTerminalEvents().length, 1,
        'the first post-fix crossing claims and emits exactly once');

      await adapter.run({ ...command, resumePaused: true });
      await adapter.run({ ...command, resumePaused: true });
      assert.equal(readTerminalEvents().length, 1,
        'no later replay of the historical scope ever emits again');
    });
  } finally {
    cleanupFixture(fixture);
  }
});

// ===========================================================================
// T6 — obligation receipts/fencing preserved: every replay still returns the
// full terminal result the route-lifecycle completion receipt consumes.
// ===========================================================================
test('T6: re-drives keep returning full terminal results (receipt inputs intact)', async () => {
  const fixture = makeFixture();
  try {
    const { adapter, command } = makeAdapter(fixture);
    await withJournal(async () => {
      const results = [
        await adapter.run(command),
        await adapter.run({ ...command, resumePaused: true }),
        await adapter.run({ ...command, resumePaused: true }),
      ];
      for (const result of results) {
        // The exact fields product-lifecycle-runtime's obligation completion
        // receipt digest reads (lifecycleRunId / lifecycleStatus /
        // terminalStatus) must be present and terminal on EVERY path — the
        // emission gate must never degrade the result contract.
        assert.equal(result.lifecycleRun.status, 'completed');
        assert.equal(result.lifecycleRun.terminalStatus, 'done');
        assert.equal(result.reason, 'completed');
        assert.equal(result.scopeCompleted, true);
      }
      assert.equal(new Set(results.map(r => r.lifecycleRun.id)).size, 1,
        'all competing paths replays the SAME durable scope');
    });
  } finally {
    cleanupFixture(fixture);
  }
});

// ===========================================================================
// T7 (red-team N1) — the claim/journal pair is OBSERVATION ONLY: a
// claimTerminalEvent that throws a POST-COMMIT DB error must never
// propagate into engine behavior. The orchestrator's commits are already
// durable when the adapter crosses this boundary — propagating the error
// would break the dispatch return and the obligation re-drive (which re-enter
// this same adapter) and convert a lost projection line into a broken engine
// result. Proves: terminal result still returns (dispatch AND re-drive
// replay), nothing is emitted, nothing is burned, and the SAME scope emits
// exactly once on its first crossing with a working claim — the documented
// honest 0..1 JSONL envelope per terminalized scope (at most one, possibly
// zero, never two).
// ===========================================================================
test('T7: a throwing claimTerminalEvent never breaks the run — terminal result returns, no event, honest 0..1', async () => {
  const fixture = makeFixture();
  try {
    const broken = makeAdapter(fixture, {
      claimTerminalEvent: () => {
        throw new Error('GAP4_CLAIM_STORAGE_ERROR: post-commit claim failure');
      },
    });

    await withJournal(async readTerminalEvents => {
      // The dispatch path drives the lifecycle to its terminal state; the
      // claim throws AFTER the orchestrator's commits — the full terminal
      // result must still come back (observation must not break the engine).
      const dispatched = await broken.adapter.run(broken.command);
      assert.equal(dispatched.lifecycleRun.status, 'completed');
      assert.equal(dispatched.lifecycleRun.terminalStatus, 'done');
      assert.equal(dispatched.reason, 'completed');
      assert.equal(dispatched.scopeCompleted, true,
        'the terminal result contract is intact despite the throwing claim');

      // The obligation re-drive shape (route-lifecycle replay) re-enters the
      // same boundary and must survive the same failure.
      const redrive = await broken.adapter.run({ ...broken.command, resumePaused: true });
      assert.equal(redrive.lifecycleRun.status, 'completed');
      assert.equal(redrive.lifecycleRun.terminalStatus, 'done');

      assert.equal(readTerminalEvents().length, 0,
        'a failed observation plane emits nothing — zero for this crossing, never a duplicate');
      assert.equal(
        fixture.db.prepare(
          'SELECT COUNT(*) AS n FROM factory_run_terminal_event_receipts',
        ).get().n,
        0,
        'the throwing claim burned nothing — the scope was not silently claimed',
      );

      // The envelope is honestly 0..1, not 0 forever: once the claim plane
      // works again, the SAME durable scope (same idempotency key) emits
      // exactly one event on its next adapter crossing — and never more.
      const healed = makeAdapter(fixture);
      const replay = await healed.adapter.run({ ...healed.command, resumePaused: true });
      assert.equal(replay.lifecycleRun.id, dispatched.lifecycleRun.id,
        'the healed crossing replays the SAME durable scope');
      assert.equal(replay.lifecycleRun.status, 'completed');
      assert.equal(readTerminalEvents().length, 1,
        'the first working-claim crossing claims and emits exactly once');

      await healed.adapter.run({ ...healed.command, resumePaused: true });
      await broken.adapter.run({ ...broken.command, resumePaused: true });
      assert.equal(readTerminalEvents().length, 1,
        'no later crossing — working or broken — ever adds a second event');
      assert.equal(
        fixture.db.prepare(
          'SELECT COUNT(*) AS n FROM factory_run_terminal_event_receipts',
        ).get().n,
        1,
        'exactly one durable receipt backs the single event',
      );
    });
  } finally {
    cleanupFixture(fixture);
  }
});
