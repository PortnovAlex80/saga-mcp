/**
 * C-1 (stage-11 PREVENTIVE-HUNT Layer 6) — the endpoint contract is part of the
 * frozen route.
 *
 * The frozen model route carries provider/model/effort, but the worker's actual
 * endpoint/auth used to resolve from LIVE state at spawn:
 *
 *   - LM Studio workers took ANTHROPIC_BASE_URL from the runner's constructor
 *     config (live SAGA_LMSTUDIO_URL / default), not from the claim-time route;
 *   - claude-CLI / agent-proxy workers inherited ambient ANTHROPIC_* routing
 *     env from the engine's process.env (and, through it, whatever a mid-run
 *     /api/model/set had flipped).
 *
 * One tracker /api/model/set between claim and spawn could send a zai-frozen
 * worker to localhost LM Studio (or vice versa) while provenance certified the
 * frozen route. The runner's backend env derivation must be a PURE FUNCTION of
 * the frozen route (+ fixed SAGA_* identity env): no live settings reads, no
 * ambient ANTHROPIC_* passthrough.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClaudeBoardRunner } from '../../tracker-view/claude-runner.mjs';

function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.prompt = '';
  child.stdin.on('data', chunk => { child.prompt += chunk.toString('utf8'); });
  child.kill = () => true;
  return child;
}

function makeHarness(overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'factory-runner-endpoint-'));
  const skills = path.join(root, 'package', 'skills');
  const protocolPath = path.join(skills, 'protocol', 'SKILL.md');
  const authorPath = path.join(skills, 'author', 'SKILL.md');
  const reviewerPath = path.join(skills, 'reviewer', 'SKILL.md');
  for (const file of [protocolPath, authorPath, reviewerPath]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `instructions:${path.basename(path.dirname(file))}`, 'utf8');
  }
  const spawns = [];
  const executionEvents = [];
  const task = {
    id: 201, title: 'Frozen endpoint target', status: 'in_progress', tags: '[]', description: 'test',
    task_kind: 'factory.author', workflow_stage: 'development', execution_mode: 'git_change',
  };
  const profile = {
    protocolSkill: 'protocol', semanticSkill: 'author', reviewSkill: 'reviewer',
  };
  const runner = new ClaudeBoardRunner({
    dbPath: path.join(root, 'saga.db'), sagaEntry: path.join(root, 'index.js'),
    sagaSkillRoot: path.join(root, 'unused'), logRoot: path.join(root, 'logs'),
    // ⛔ The factory moved to opencode (2026-08-20): the default 'claude'
    // executor path is forbidden (FACTORY_CLAUDE_BACKEND_FORBIDDEN). These
    // tests assert SPAWN ENV derivation, not the executor binary — construct
    // with the one blessed executor (the agent-proxy shim; spawn is faked).
    claudePath: `node ${path.resolve(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
      '../../tools/agent-proxy/claude-shim.mjs',
    )}`,
    // LIVE config deliberately different from the frozen endpoint: the spawn
    // must use the FROZEN route, not this constructor-time value.
    lmstudioBaseUrl: overrides.lmstudioBaseUrl ?? 'http://live-runner-config:1234/v1',
    realClaudePath: overrides.realClaudePath ?? null,
    getProject: id => ({ id, name: 'target-project', tags: '[]' }),
    resolveWorkspace: () => root, getTask: () => task,
    getTaskState: () => ({ id: task.id, status: 'review', assigned_to: null }),
    recoverAssignment: event => executionEvents.push(['recover', event]),
    resolveProfile: () => ({ profile }),
    resolveLaunchSpec: () => ({
      installationId: 78, role: profile, allowedToolIds: ['Read', 'Edit'],
      strictResources: true,
      resolveSkill: name => ({ protocol: protocolPath, author: authorPath, reviewer: reviewerPath })[name] ?? null,
    }),
    executionStore: {
      markExited: (...args) => executionEvents.push(['exited', args]),
      markProgress: () => {}, markRunning: () => {},
      markSpawnFailed: (...args) => executionEvents.push(['spawn-failed', args]),
      readBirthToken: () => 'birth-token',
    },
    spawn: (command, args, options) => {
      const child = fakeChild(2001);
      spawns.push({ command, args, options, child });
      setTimeout(() => child.emit('close', 0), 20);
      return child;
    },
  });
  const assignment = {
    taskId: task.id, epicId: 1, projectId: 7, status: 'in_progress', skill: 'author',
    workerExecutionId: 'exec-201', fenceToken: 'fence-201', runId: 'run-201',
    workerId: 'worker-201', machineId: 'test-host',
    repository: { name: 'product', local_path: root },
    executionContext: {
      policy_version: 'factory.execution.v2', authority: { enforcement: 'strict', allowed_saga_tools: ['task_get', 'worker_done'] },
      model_route: overrides.modelRoute
        ?? { provider: 'zai', model: null, effort: 'high' },
      captured_at: new Date().toISOString(),
    },
  };
  return { root, runner, assignment, spawns, executionEvents };
}

async function runOnce(h) {
  h.runner.start({ projectId: 7, epicId: 1, concurrency: 1, assignment: h.assignment });
  await waitFor(() => h.runner.status(7)?.status === 'completed');
}

const AMBIENT_ROUTING_ENV = {
  ANTHROPIC_BASE_URL: 'http://ambient-hijack:9999/v1',
  ANTHROPIC_AUTH_TOKEN: 'ambient-secret',
  ANTHROPIC_API_KEY: 'ambient-key',
};

/** Install ambient routing env (what a polluted engine shell would leak). */
function withAmbientRoutingEnv(fn) {
  const saved = {};
  for (const key of Object.keys(AMBIENT_ROUTING_ENV)) {
    saved[key] = process.env[key];
    process.env[key] = AMBIENT_ROUTING_ENV[key];
  }
  return () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

test('lmstudio spawn env derives from the FROZEN endpoint, not live runner config', async () => {
  const h = makeHarness({
    lmstudioBaseUrl: 'http://live-runner-config:1234/v1',
    modelRoute: {
      provider: 'lmstudio', model: 'qwen3.6-35b', effort: null,
      endpoint: { backend: 'lmstudio', base_url: 'http://frozen-endpoint:4321/v1' },
    },
  });
  try {
    await runOnce(h);
    assert.equal(h.spawns.length, 1);
    assert.equal(
      h.spawns[0].options.env.ANTHROPIC_BASE_URL,
      'http://frozen-endpoint:4321/v1',
      'ANTHROPIC_BASE_URL must come from the frozen route endpoint, not the live runner config',
    );
    assert.equal(h.spawns[0].options.env.ANTHROPIC_AUTH_TOKEN, 'lm-studio');
    assert.equal(h.spawns[0].options.env.CLAUDE_CODE_ATTRIBUTION_HEADER, '0');
  } finally { h.runner.dispose(); rmSync(h.root, { recursive: true, force: true }); }
});

test('agent-proxy frozen route never leaks ambient ANTHROPIC routing env to the shim', async () => {
  const restore = withAmbientRoutingEnv();
  const h = makeHarness({
    modelRoute: {
      provider: 'zai', model: 'glm-4.7', effort: 'high',
      endpoint: { backend: 'agent-proxy', base_url: null },
    },
  });
  try {
    await runOnce(h);
    assert.equal(h.spawns.length, 1);
    const env = h.spawns[0].options.env;
    assert.equal('ANTHROPIC_BASE_URL' in env, false,
      'ambient ANTHROPIC_BASE_URL must not reach an agent-proxy-frozen worker');
    assert.equal('ANTHROPIC_AUTH_TOKEN' in env, false,
      'ambient ANTHROPIC_AUTH_TOKEN must not reach an agent-proxy-frozen worker');
    assert.equal('ANTHROPIC_API_KEY' in env, false,
      'ambient ANTHROPIC_API_KEY must not reach an agent-proxy-frozen worker');
  } finally { restore(); h.runner.dispose(); rmSync(h.root, { recursive: true, force: true }); }
});

test('claude-cli zai route strips ambient ANTHROPIC routing env (settings.json owns auth, ambient env owns nothing)', async () => {
  const restore = withAmbientRoutingEnv();
  const h = makeHarness({
    modelRoute: { provider: 'zai', model: null, effort: 'high' },
  });
  try {
    await runOnce(h);
    assert.equal(h.spawns.length, 1);
    const env = h.spawns[0].options.env;
    assert.equal('ANTHROPIC_BASE_URL' in env, false,
      'ambient ANTHROPIC_BASE_URL must not reroute a claude-cli zai worker');
    assert.equal('ANTHROPIC_AUTH_TOKEN' in env, false);
    assert.equal('ANTHROPIC_API_KEY' in env, false);
  } finally { restore(); h.runner.dispose(); rmSync(h.root, { recursive: true, force: true }); }
});

test('pre-freeze lmstudio route (no endpoint field) keeps the legacy live-config behavior', async () => {
  const h = makeHarness({
    lmstudioBaseUrl: 'http://legacy-live:1234/v1',
    modelRoute: { provider: 'lmstudio', model: 'qwen3.6-35b', effort: null },
  });
  try {
    await runOnce(h);
    assert.equal(h.spawns.length, 1);
    assert.equal(
      h.spawns[0].options.env.ANTHROPIC_BASE_URL,
      'http://legacy-live:1234/v1',
      'routes frozen before the endpoint contract keep resolving from runner config',
    );
  } finally { h.runner.dispose(); rmSync(h.root, { recursive: true, force: true }); }
});

// Grep-pinned invariant (§27-ratchet style): the runner's env derivation is a
// pure function of the frozen route + fixed env. It must never READ
// ~/.claude/settings.json (or any settings file) to decide the child's route.
test('claude-runner source never reads ~/.claude settings for routing (ratchet)', () => {
  const runnerSource = readFileSync(
    new URL('../../tracker-view/claude-runner.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(runnerSource, /readFileSync\([^)]*\.claude/u,
    'claude-runner.mjs must not read ~/.claude/settings.json for routing decisions');
  assert.doesNotMatch(runnerSource, /readFileSync\([^)]*settings\.json/u,
    'claude-runner.mjs must not read any settings.json for routing decisions');
  assert.match(runnerSource, /FROZEN-ROUTE-ENV-INVARIANT/u,
    'the frozen-route env derivation block must carry the invariant marker comment');
});
