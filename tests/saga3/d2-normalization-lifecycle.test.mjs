import assert from 'node:assert/strict';
import test from 'node:test';

const { Saga3DiscoveryNormalizationService } = await import(
  '../../dist/saga3/application/discovery-normalization-service.js'
);
const { Saga3DiscoveryEngine } = await import('../../dist/engines/saga3-discovery-engine.js');

const config = {
  dbPath: '/tmp/saga.db', claudePath: '/claude', lmStudioUrl: 'http://lm/v1',
  zaiBaseUrl: 'http://zai', trackerAutostart: false, trackerPort: 4321,
  trackerReloadSec: 5, trackerSpawned: false, trackerNoBrowser: true,
  orchestrationMode: 'saga3-discovery',
};

function host() {
  return {
    processId: 1,
    workerPaths: { sagaEntry: '/saga', sagaSkillRoot: '/skills' },
    now: () => new Date('2026-07-24T00:00:00.000Z'),
    sleep: async () => {},
    heartbeat: () => {},
    acquireEngineLock: () => ({ status: 'acquired', ownerPid: 1 }),
    releaseEngineLock: () => {},
    scanRateLimitSignals: () => 0,
  };
}

test('D2 normalization service pauses both intents when executor status throws', async () => {
  const transitions = [];
  const calls = [];
  const runtime = {
    ensureNormalizationControl: () => ({
      controlIntentId: 20, sourceSubmissionId: 5, controlStatus: 'open',
      authorityIntentId: 30, authorityIntentStatus: 'open', taskId: 40,
    }),
    prepareIntentForExecution: () => ({ state: 'ready', intentStatus: 'open', taskStatus: 'todo' }),
    setIntentStatus: (id, from, to) => { transitions.push(['intent', id, from, to]); return true; },
    setControlIntentStatus: (id, from, to) => { transitions.push(['control', id, from, to]); return true; },
    readTaskState: () => 'in_progress',
  };
  const executor = {
    start: () => { calls.push('start'); },
    status: () => { throw new Error('status exploded'); },
    stop: () => { calls.push('stop'); return null; },
    dispose: () => { calls.push('dispose'); },
    setConcurrency: () => {},
  };
  const service = new Saga3DiscoveryNormalizationService({
    config,
    workerExecutorFactory: () => executor,
    host: host(),
    runtimePersistence: runtime,
    sleep: async () => {},
  });
  const result = await service.normalize({
    projectId: 1, epicId: 10, sourceSubmissionId: 5,
    objective: 'normalize', workspaceRoot: '/workspace', heartbeat: () => {},
  });
  assert.equal(result.success, false);
  assert.match(result.error, /status exploded/);
  assert.deepEqual(calls, ['start', 'stop', 'dispose']);
  assert.ok(transitions.some(x => x.join(':') === 'intent:30:executing:paused'));
  assert.ok(transitions.some(x => x.join(':') === 'control:20:executing:paused'));
});

test('D2 engine restart resumes normalization when product task is already done', async () => {
  let normalized = false;
  let normalizationCalls = 0;
  const transitions = [];
  const payload = {
    problem_statement: 'p', observed_context: 'c', stakeholders_or_actors: [],
    assumptions: [], unknowns: [], risks: [], candidate_scope: 's',
    evidence_refs: [], recommended_outcome: 'clarify', rationale: 'r',
  };
  const proposal = {
    id: 9, intent_id: 1, task_id: 100, execution_id: 'normalizer-exec',
    kind: 'discovery', schema_version: 'saga3.discovery-proposal.v1',
    payload, content_hash: 'a'.repeat(64), status: 'submitted',
    provenance: {
      model: 'm', provider: 'p', effort: null, worker_id: 'w',
      execution_id: 'normalizer-exec', submitted_at: 't',
      normalization_mode: 'lm_transformation', source_submission_id: 5,
    },
    created_at: 't',
  };
  const runtime = {
    readOpenIntent: () => ({
      id: 1, epic_id: 10, kind: 'discovery', objective: 'discover',
      authority_scope: { snapshot_ref: 'episode:10', scope: 's', allowed_tools: [], enforcement: 'runtime' },
      output_schema: 'saga3.discovery-work-intent.v1', token_budget: 0,
      retry_budget: 0, projected_task_id: 100, status: 'paused', created_at: 't',
    }),
    ensureProjectedTask: () => 100,
    prepareIntentForExecution: () => ({ state: 'done', intentStatus: 'paused', taskStatus: 'done' }),
    readLatestProposal: () => normalized ? proposal : null,
    readLatestRawSubmission: () => ({ id: 5, status: 'normalization_required' }),
    setIntentStatus: (id, from, to) => { transitions.push([id, from, to]); return true; },
    setProjectedTask: () => {}, readEpicObjective: () => null,
  };
  const normalizationService = {
    normalize: async () => {
      normalizationCalls += 1;
      normalized = true;
      return { success: true, cycles: 2, error: null };
    },
  };
  const engine = new Saga3DiscoveryEngine({
    config,
    workerExecutorFactory: () => { throw new Error('product executor must not restart'); },
    persistence: {
      workspaces: { resolve: () => ({ workspaceRoot: '/workspace' }) },
      episodes: { currentStage: () => 'discovery' },
      tasks: {}, executions: {},
    },
    host: host(),
    runtimePersistence: runtime,
    normalizationService,
    sleep: async () => {},
  });
  const result = await engine.run({ projectId: 1, epicId: 10 });
  assert.equal(normalizationCalls, 1);
  assert.equal(result.reason, 'completed');
  assert.equal(result.scopeCompleted, true);
  assert.equal(result.outcome, 'clarify');
  assert.equal(result.outcomeAuthority, 'normalized_worker_proposal');
  assert.equal(result.cycles, 2);
  assert.ok(transitions.some(x => x.join(':') === '1:paused:concluded'));
});
