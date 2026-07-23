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
  if (found !== expected) {
    throw new Error(`${file}: expected ${expected} anchor(s), found ${found}: ${needle.slice(0, 160)}`);
  }
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

const orchestrate = 'src/orchestrate.ts';

replaceExact(orchestrate, `import {
  existsSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  statSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb } from './db.js';
import type { Saga2RuntimePersistence } from './application/ports/saga2-runtime-persistence.js';`, `import type { Saga2HostRuntime } from './application/ports/saga2-host-runtime.js';
import type { Saga2RuntimePersistence } from './application/ports/saga2-runtime-persistence.js';`);

replaceExact(orchestrate, `/** Reconcile durable worker executions every 6 cycles (30s). */
const ZOMBIE_CHECK_TICKS = 6;
let zombieCheckCounter = 0;`, `/** Reconcile durable worker executions every 6 cycles (30s). */
const ZOMBIE_CHECK_TICKS = 6;`);

replaceExact(orchestrate, `const RATE_LIMIT_PATTERN = /api_retry[^\\n]*"error_status":429[^\\n]*"error":"rate_limit"/;
let rateLimitCheckCounter = 0;
let lastRateLimitAt = 0;                  // ms epoch of last 429 detection`, `interface Saga2PumpState {
  zombieCheckCounter: number;
  rateLimitCheckCounter: number;
  lastRateLimitAt: number;
  healRetries: Map<string, number>;
}`);

replaceExact(orchestrate, `/** Track heal attempts per (epic, stage, diagnosis) to enforce max_retries. */
const healRetries = new Map<string, number>();

// ESM does not define __dirname; derive it once from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
`, '');

replaceExact(orchestrate, `export interface OrchestrateOptions {
  projectId: number;
  epicId: number;
  concurrency?: number;
  claudePath?: string;
  dbPath: string;
  lmStudioUrl: string;
  workerExecutorFactory: WorkerExecutorFactory;
  persistence: Saga2RuntimePersistence;
  sagaEntry?: string;
  sagaSkillRoot?: string;
  logRoot?: string;
  heartbeatLog?: string;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}`, `export interface OrchestrateOptions {
  projectId: number;
  epicId: number;
  concurrency?: number;
  claudePath?: string;
  dbPath: string;
  lmStudioUrl: string;
  workerExecutorFactory: WorkerExecutorFactory;
  persistence: Saga2RuntimePersistence;
  host: Saga2HostRuntime;
}`);

replaceBetween(orchestrate,
  'function engineHeartbeat(opts: OrchestrateOptions, event: string, message: string, now = Date.now): void {',
  '\n\n/**\n * Returns the current episode stage',
`function engineHeartbeat(opts: OrchestrateOptions, event: string, message: string): void {
  opts.host.heartbeat(
    { projectId: opts.projectId, epicId: opts.epicId },
    event,
    message,
  );
}`);

replaceExact(orchestrate, `function resetHealRetriesForEpic(epicId: number): void {
  for (const key of [...healRetries.keys()]) {
    if (key.startsWith(\`${'${epicId}'}:\`)) healRetries.delete(key);
  }
}`, `function resetHealRetriesForEpic(epicId: number, state: Saga2PumpState): void {
  for (const key of [...state.healRetries.keys()]) {
    if (key.startsWith(\`${'${epicId}'}:\`)) state.healRetries.delete(key);
  }
}`);

replaceExact(orchestrate, `  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const startedAt = now();`, `  const startedAt = opts.host.now();`);
replaceExact(orchestrate, `    if (now() - startedAt > MAX_PAUSE_MIN * 60_000) {`, `    if (opts.host.now() - startedAt > MAX_PAUSE_MIN * 60_000) {`);
replaceExact(orchestrate, `    await sleep(RESUME_POLL_MS);`, `    await opts.host.sleep(RESUME_POLL_MS);`);

replaceExact(orchestrate, `  gateError: string,
  opts: OrchestrateOptions,
): {`, `  gateError: string,
  opts: OrchestrateOptions,
  state: Saga2PumpState,
): {`);
replaceExact(orchestrate, `  const retries = healRetries.get(healKey) ?? 0;`, `  const retries = state.healRetries.get(healKey) ?? 0;`);
replaceExact(orchestrate, `  healRetries.set(healKey, retries + 1);`, `  state.healRetries.set(healKey, retries + 1);`);

replaceBetween(orchestrate,
  '/**\n * Resolve the JSONL log path for an active worker task.',
  '\n/**\n * Reconcile process truth independently from task status.',
  '');

replaceBetween(orchestrate,
  'function detectRateLimits(epicId: number, projectId: number, opts: OrchestrateOptions): number {',
  '\n\n/**\n * Compute the effective concurrency',
`function detectRateLimits(
  epicId: number,
  projectId: number,
  opts: OrchestrateOptions,
  state: Saga2PumpState,
): number {
  const rateLimited = opts.host.scanRateLimitSignals(
    { projectId, epicId },
    opts.persistence.tasks.listRateLimitTasks(epicId),
  );
  if (rateLimited > 0) {
    state.lastRateLimitAt = opts.host.now();
    engineHeartbeat(
      opts,
      'RATE_LIMIT',
      \`${'${rateLimited}'} worker(s) hit 429 — lowering concurrency ceiling\`,
    );
  }
  return rateLimited;
}`);

replaceExact(orchestrate, `function computeEffectiveConcurrency(target: number, current: number): number {
  if (lastRateLimitAt === 0) return target;
  const sinceLimit = (Date.now() - lastRateLimitAt) / 1000;
  if (sinceLimit < RATE_LIMIT_COOLDOWN_SEC) {
    // Still in cooldown — hold current (don't increase).
    return Math.min(current, target);
  }
  // Cooldown elapsed — recover by 1 per call (caller runs this every RATE_LIMIT_SCAN_TICKS).
  return Math.min(current + 1, target);
}`, `function computeEffectiveConcurrency(
  target: number,
  current: number,
  lastRateLimitAt: number,
  now: number,
): number {
  if (lastRateLimitAt === 0) return target;
  const sinceLimit = (now - lastRateLimitAt) / 1000;
  if (sinceLimit < RATE_LIMIT_COOLDOWN_SEC) {
    return Math.min(current, target);
  }
  return Math.min(current + 1, target);
}`);

replaceExact(orchestrate, `  let effectiveConcurrency = targetConcurrency;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  // === SINGLETON GUARD (PID-lock) ===`, `  let effectiveConcurrency = targetConcurrency;
  const context = { projectId, epicId };
  const state: Saga2PumpState = {
    zombieCheckCounter: 0,
    rateLimitCheckCounter: 0,
    lastRateLimitAt: 0,
    healRetries: new Map(),
  };
  const now = () => opts.host.now();
  const sleep = (ms: number) => opts.host.sleep(ms);

  // === SINGLETON GUARD (PID-lock) ===`);

replaceBetween(orchestrate,
  '  // === SINGLETON GUARD (PID-lock) ===',
  '\n  // Resolve the project\'s workspace',
`  // === SINGLETON GUARD (PID-lock) ===
  const lock = opts.host.acquireEngineLock(context);
  if (lock.status === 'duplicate') {
    const owner = lock.ownerPid ?? '?';
    engineHeartbeat(
      opts,
      'DUPLICATE_EXIT',
      \`engine PID ${'${owner}'} already owns project=${'${projectId}'} epic=${'${epicId}'} — exiting\`,
    );
    writeEpisodeMeta(epicId, {
      engine_rejected: true,
      engine_rejected_reason: \`PID ${'${owner}'} already running\`,
    }, opts);
    return {
      projectId,
      epicId,
      finalStage: currentStage(epicId, opts) ?? 'unknown',
      endedAt: new Date(now()).toISOString(),
      reason: 'failed',
      cycles: 0,
      lastError: \`duplicate engine — PID ${'${owner}'} already running\`,
    };
  }
  if (lock.status === 'unavailable') {
    engineHeartbeat(opts, 'LOCK_WARN', \`PID-lock failed: ${'${lock.error}'}\`);
  }
`);

replaceExact(orchestrate, `    sagaEntry: opts.sagaEntry ?? path.join(__dirname, '..', 'dist', 'index.js'),
    sagaSkillRoot: opts.sagaSkillRoot ?? path.join(__dirname, '..', 'skills'),
    claudePath: opts.claudePath,
    logRoot: opts.logRoot,
    heartbeatLog: opts.heartbeatLog,`, `    sagaEntry: opts.host.workerPaths.sagaEntry,
    sagaSkillRoot: opts.host.workerPaths.sagaSkillRoot,
    claudePath: opts.claudePath,
    logRoot: opts.host.workerPaths.logRoot,
    heartbeatLog: opts.host.workerPaths.heartbeatLog,`);

replaceExact(orchestrate, `    engine_pid: process.pid,
    engine_started_at: new Date().toISOString(),`, `    engine_pid: opts.host.processId,
    engine_started_at: new Date(now()).toISOString(),`);

replaceExact(orchestrate, `      zombieCheckCounter += 1;
      if (zombieCheckCounter >= ZOMBIE_CHECK_TICKS) {
        zombieCheckCounter = 0;`, `      state.zombieCheckCounter += 1;
      if (state.zombieCheckCounter >= ZOMBIE_CHECK_TICKS) {
        state.zombieCheckCounter = 0;`);
replaceExact(orchestrate, `      rateLimitCheckCounter += 1;
      if (rateLimitCheckCounter >= RATE_LIMIT_SCAN_TICKS) {
        rateLimitCheckCounter = 0;`, `      state.rateLimitCheckCounter += 1;
      if (state.rateLimitCheckCounter >= RATE_LIMIT_SCAN_TICKS) {
        state.rateLimitCheckCounter = 0;`);
replaceExact(orchestrate, `        const rlDetected = detectRateLimits(epicId, projectId, opts);`, `        const rlDetected = detectRateLimits(epicId, projectId, opts, state);`);
replaceExact(orchestrate, `        effectiveConcurrency = computeEffectiveConcurrency(targetConcurrency, effectiveConcurrency);`, `        effectiveConcurrency = computeEffectiveConcurrency(
          targetConcurrency,
          effectiveConcurrency,
          state.lastRateLimitAt,
          now(),
        );`);
replaceExact(orchestrate, `          const heal = attemptHeal(epicId, stage, advance.error, opts);`, `          const heal = attemptHeal(epicId, stage, advance.error, opts, state);`);
replaceExact(orchestrate, `          const genericRetries = healRetries.get(genericHealKey) ?? 0;`, `          const genericRetries = state.healRetries.get(genericHealKey) ?? 0;`);
replaceExact(orchestrate, `            healRetries.set(genericHealKey, genericRetries + 1);`, `            state.healRetries.set(genericHealKey, genericRetries + 1);`);
replaceExact(orchestrate, `          resetHealRetriesForEpic(epicId);`, `          resetHealRetriesForEpic(epicId, state);`);

replaceBetween(orchestrate,
  '    // Release PID-lock so the next engine can start.',
  '\n    engineHeartbeat(opts, \'ENGINE_EXIT\'',
`    // Release the host-owned singleton lock so the next engine can start.
    opts.host.releaseEngineLock(context);`);

replaceExact(orchestrate, `

/** Re-export for tests. */
export { closeDb };`, '');

// E2E uses the same Node host adapter as production, with accelerated sleep.
replaceExact('tests/e2e-pipeline.test.mjs', `const { SqliteWorkspaceResolver } = await import(
  '../dist/infrastructure/workspaces/sqlite-workspace-resolver.js'
);`, `const { SqliteWorkspaceResolver } = await import(
  '../dist/infrastructure/workspaces/sqlite-workspace-resolver.js'
);
const { NodeSaga2HostRuntime } = await import(
  '../dist/infrastructure/runtime/node-saga2-host-runtime.js'
);`);
replaceExact('tests/e2e-pipeline.test.mjs', `    workerExecutorFactory,
    persistence,
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 100))),`, `    workerExecutorFactory,
    persistence,
    host: new NodeSaga2HostRuntime({
      homeDirectory: temp,
      sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 100))),
    }),`);

// ADR-012 tests use the same host boundary with per-fixture lock/log isolation.
replaceExact('tests/track-pipeline.test.mjs', `  const { SqliteWorkspaceResolver } = await import(
    '../dist/infrastructure/workspaces/sqlite-workspace-resolver.js'
  );`, `  const { SqliteWorkspaceResolver } = await import(
    '../dist/infrastructure/workspaces/sqlite-workspace-resolver.js'
  );
  const { NodeSaga2HostRuntime } = await import(
    '../dist/infrastructure/runtime/node-saga2-host-runtime.js'
  );`);
replaceExact('tests/track-pipeline.test.mjs', `    workerExecutorFactory,
    persistence,
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 50))),`, `    workerExecutorFactory,
    persistence,
    host: new NodeSaga2HostRuntime({
      homeDirectory: fixture.temp,
      sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 50))),
    }),`);

const finalSource = read(orchestrate);
const forbidden = [
  "from 'node:fs'",
  "from 'node:os'",
  "from 'node:path'",
  'fileURLToPath',
  'process.pid',
  'process.kill',
  'Date.now',
  'setTimeout(',
  'existsSync(',
  'readFileSync(',
  'writeFileSync(',
  'appendFileSync(',
  'readdirSync(',
  'openSync(',
  'readSync(',
  'closeSync(',
];
for (const token of forbidden) {
  if (finalSource.includes(token)) throw new Error(`orchestrate.ts retained host mechanic: ${token}`);
}
for (const required of [
  'host: Saga2HostRuntime',
  'opts.host.acquireEngineLock(context)',
  'opts.host.releaseEngineLock(context)',
  'opts.host.scanRateLimitSignals',
  'opts.host.heartbeat',
  'state.healRetries',
]) {
  if (!finalSource.includes(required)) throw new Error(`orchestrate.ts missing pure-engine anchor: ${required}`);
}

console.log('Phase B pure Saga2Engine migration applied.');
