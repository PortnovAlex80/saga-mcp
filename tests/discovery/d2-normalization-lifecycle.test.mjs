import assert from 'node:assert/strict';
import test from 'node:test';

const { Saga3DiscoveryNormalizationService } = await import(
  '../../dist/modules/discovery/application/discovery-normalization-service.js'
);
const {
  fakeWorkAssignment,
  fakeIdGenerator,
  TEST_MACHINE_ID,
} = await import('./_conveyor-fakes.mjs');

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
    workAssignment: fakeWorkAssignment(),
    idGenerator: fakeIdGenerator(),
    machineId: TEST_MACHINE_ID,
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
