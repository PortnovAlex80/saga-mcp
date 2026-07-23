#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

function read(file) { return readFileSync(file, 'utf8'); }
function write(file, value) { writeFileSync(file, value, 'utf8'); }
function count(source, needle) {
  let total = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    total += 1;
    offset += needle.length;
  }
  return total;
}
function replaceExact(file, needle, replacement, expected = 1) {
  const source = read(file);
  const found = count(source, needle);
  if (found !== expected) throw new Error(`${file}: expected ${expected}, found ${found}: ${needle.slice(0, 160)}`);
  write(file, source.split(needle).join(replacement));
}
function replaceBetween(file, start, end, replacement) {
  const source = read(file);
  if (count(source, start) !== 1) throw new Error(`${file}: non-unique start anchor: ${start}`);
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`${file}: end anchor missing: ${end}`);
  write(file, source.slice(0, from) + replacement + source.slice(to));
}

const architecture = 'tests/architecture/saga2-boundaries.test.mjs';
replaceExact(
  architecture,
  "import { mkdtempSync, readFileSync, rmSync } from 'node:fs';",
  "import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';",
);
replaceExact(
  architecture,
  `const { LegacyEngineAdministration } = await import(
  '../../dist/infrastructure/engine/legacy-engine-administration.js'
);`,
  `const { LegacyEngineAdministration } = await import(
  '../../dist/infrastructure/engine/legacy-engine-administration.js'
);
const { NodeSaga2HostRuntime } = await import(
  '../../dist/infrastructure/runtime/node-saga2-host-runtime.js'
);`,
);

replaceBetween(
  architecture,
  "test('Saga2Engine delegates through the legacy runtime port', async () => {",
  "\n\ntest('Saga application coordinates engine, board and administration ports'",
`test('Saga2Engine owns the pump and consumes only injected runtime ports', async () => {
  const heartbeats = [];
  const patches = [];
  let workerFactoryCalls = 0;
  const host = {
    processId: 77,
    workerPaths: { sagaEntry: '/dist/index.js', sagaSkillRoot: '/skills' },
    now: () => Date.parse('2026-07-23T00:00:00.000Z'),
    sleep: async () => {},
    heartbeat(context, event, message) { heartbeats.push([context, event, message]); },
    acquireEngineLock: () => ({ status: 'duplicate', ownerPid: 123 }),
    releaseEngineLock: () => { throw new Error('duplicate run must not release another owner lock'); },
    scanRateLimitSignals: () => 0,
  };
  const persistence = {
    episodes: {
      readTargetConcurrency: (_epicId, fallback) => fallback,
      patchMetadata: (epicId, patch) => patches.push([epicId, patch]),
      currentStage: () => 'development',
    },
    tasks: {},
    executions: {},
    workspaces: {},
  };
  const engine = new Saga2Engine({
    config: fullConfig(),
    host,
    persistence,
    workerExecutorFactory: () => {
      workerFactoryCalls += 1;
      throw new Error('duplicate engine must not construct worker runtime');
    },
  });

  const result = await engine.run({ projectId: 11, epicId: 22, concurrency: 3 });
  assert.equal(result.reason, 'failed');
  assert.equal(result.finalStage, 'development');
  assert.match(result.lastError, /PID 123/);
  assert.equal(workerFactoryCalls, 0);
  assert.equal(heartbeats[0][1], 'DUPLICATE_EXIT');
  assert.equal(patches[0][0], 22);
  assert.equal(patches[0][1].engine_rejected, true);
});

test('Node Saga2 host runtime owns lock, heartbeat and rate-limit telemetry', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-host-runtime-'));
  const context = { projectId: 1, epicId: 2 };
  const cliRoot = path.join(temp, '.zcode', 'cli');
  const lockPath = path.join(cliRoot, 'engine-1-2.pid');
  const runDir = path.join(cliRoot, 'board-runs', 'board-1-100');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(lockPath, '999', 'utf8');
  writeFileSync(
    path.join(runDir, 'task-7-worker-1.jsonl'),
    '{"type":"api_retry","error_status":429,"error":"rate_limit"}\n',
    'utf8',
  );

  try {
    const host = new NodeSaga2HostRuntime({
      processId: 4242,
      homeDirectory: temp,
      now: () => Date.parse('2026-07-23T01:02:03.000Z'),
      isProcessAlive: pid => pid === 999,
    });
    assert.deepEqual(host.acquireEngineLock(context), { status: 'duplicate', ownerPid: 999 });

    unlinkSync(lockPath);
    assert.deepEqual(host.acquireEngineLock(context), { status: 'acquired', ownerPid: 4242 });
    assert.equal(readFileSync(lockPath, 'utf8'), '4242');

    host.heartbeat(context, 'CYCLE', 'stage=development');
    const heartbeat = readFileSync(path.join(cliRoot, 'engine-heartbeat.log'), 'utf8');
    assert.match(heartbeat, /2026-07-23T01:02:03.000Z engine project=1 epic=2 CYCLE stage=development/);

    assert.equal(host.scanRateLimitSignals(context, [{ id: 7, assigned_to: 'worker-1' }]), 1);
    host.releaseEngineLock(context);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});`);

const characterization = 'tests/characterization/saga2-runtime-contracts.test.mjs';
replaceExact(
  characterization,
  "  'src/application/ports/worker-executor.ts',",
  "  'src/application/ports/worker-executor.ts',\n  'src/application/ports/saga2-host-runtime.ts',",
);
replaceExact(
  characterization,
  "  'src/infrastructure/engine/legacy-engine-administration.ts',",
  "  'src/infrastructure/engine/legacy-engine-administration.ts',\n  'src/infrastructure/runtime/node-saga2-host-runtime.ts',",
);
replaceExact(
  characterization,
  `    'workerExecutorFactory',
    'persistence',`,
  `    'workerExecutorFactory',
    'persistence',
    'host: Saga2HostRuntime',
    'opts.host.acquireEngineLock(context)',
    'opts.host.releaseEngineLock(context)',
    'opts.host.scanRateLimitSignals',`,
);
replaceExact(
  characterization,
  `test('persistence adapters keep the moved SQLite and execution anchors', () => {`,
  `test('orchestration pump contains decisions but no host implementation mechanics', () => {
  const source = read('src/orchestrate.ts');
  for (const forbidden of [
    "from 'node:fs'", "from 'node:os'", "from 'node:path'",
    'process.pid', 'process.kill', 'Date.now', 'setTimeout(',
    'readFileSync(', 'writeFileSync(', 'readdirSync(', 'openSync(',
  ]) {
    assert.ok(!source.includes(forbidden), \`orchestrate.ts retained host mechanic: ${'${forbidden}'}\`);
  }
  const engine = read('src/engines/saga2-engine.ts');
  assertIncludesAll(engine, [
    'orchestrate({', 'workerExecutorFactory', 'persistence', 'host',
  ], 'src/engines/saga2-engine.ts');
  assert.ok(!engine.includes('LegacySaga2Runner'), 'Saga2Engine still depends on legacy bridge');
});

test('Node host adapter preserves PID, heartbeat and JSONL contracts', () => {
  const source = read('src/infrastructure/runtime/node-saga2-host-runtime.ts');
  assertIncludesAll(source, [
    "flag: 'wx'",
    'process.kill(pid, 0)',
    'engine-heartbeat.log',
    'board-runs',
    'error_status":429',
    'releaseEngineLock',
  ], 'node-saga2-host-runtime.ts');
});

test('persistence adapters keep the moved SQLite and execution anchors', () => {`,
);

console.log('Phase B pure-engine tests adapted.');
