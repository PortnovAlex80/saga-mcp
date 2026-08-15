#!/usr/bin/env node
// tests/factory-contract/scenario-dispatcher.mjs
//
// Scenario-driven worker dispatcher. Replaces the hard-coded dispatcher.mjs.
// Receives the worker prompt via stdin (same as real claude), selects a
// scenario handler, and executes it through the real MCP boundary.
//
// The scenario set is loaded from the SAGA_SCENARIOS env variable (path to a
// .mjs module exporting a scenarios object). This allows different tests to
// inject different scenario sets without changing the dispatcher.

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

async function readStdin() {
  return new Promise(resolve => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { d += c; });
    process.stdin.on('end', () => resolve(d));
    setTimeout(() => resolve(d), 1000);
  });
}

function parsePrompt(text) {
  const kv = {};
  for (const line of text.split('\n')) {
    const m = /^([a-z_]+)=(.*)$/.exec(line.trim());
    if (m) kv[m[1]] = m[2];
  }
  return kv;
}

function emit(type, extra = {}) {
  process.stdout.write(JSON.stringify({ type, ...extra }) + '\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readInvocationLedger(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('SCENARIO_INVOCATION_LEDGER_INVALID: root must be an array');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function acquireLedgerLock(lockPath, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      mkdirSync(lockPath);
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    // The critical section is one read + atomic rename. A lock older than the
    // whole MCP timeout can only be orphaned by a dead scenario process.
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > timeoutMs) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`SCENARIO_INVOCATION_LEDGER_LOCK_TIMEOUT: ${lockPath}`);
    }
    await sleep(10);
  }
}

// Load scenario set from the env-specified module path
const scenariosPath = process.env.SAGA_SCENARIOS;
if (!scenariosPath) {
  process.stderr.write('[scenario-dispatcher] SAGA_SCENARIOS env required\n');
  process.exit(2);
}

let scenarios;
try {
  const mod = await import(pathToFileURL(path.resolve(scenariosPath)).href);
  scenarios = mod.scenarios || mod.goldenPathScenarios || mod.default;
} catch (e) {
  process.stderr.write(`[scenario-dispatcher] Failed to load scenarios from ${scenariosPath}: ${e.message}\n`);
  process.exit(2);
}

// Every physical worker reserves one invocation before its handler runs. The
// file is shared by all scenario processes in this test run.
const invocationLogPath = process.env.SAGA_INVOCATION_LOG;
const invocationLog = [];

async function reserveInvocation(baseRecord) {
  if (!invocationLogPath) {
    return {
      ...baseRecord,
      attempt: invocationLog.filter(item => item.keyStr === baseRecord.keyStr).length + 1,
    };
  }

  const lockPath = `${invocationLogPath}.lock`;
  let temporaryPath = null;
  await acquireLedgerLock(lockPath);
  try {
    const existing = readInvocationLedger(invocationLogPath);
    const record = {
      ...baseRecord,
      attempt: existing.filter(item => item.keyStr === baseRecord.keyStr).length + 1,
    };
    temporaryPath = `${invocationLogPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify([...existing, record], null, 2));
    renameSync(temporaryPath, invocationLogPath);
    temporaryPath = null;
    return record;
  } finally {
    if (temporaryPath) rmSync(temporaryPath, { force: true });
    rmSync(lockPath, { recursive: true, force: true });
  }
}

const { runScenarioWorker } = await import('./scenario-engine.mjs');

async function main() {
  // Parse argv for --mcp-config
  const args = process.argv.slice(2);
  let mcpConfigPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mcp-config' && i + 1 < args.length) { mcpConfigPath = args[i + 1]; i++; }
  }
  if (!mcpConfigPath) { process.stderr.write('--mcp-config required\n'); process.exit(2); }

  const prompt = parsePrompt(await readStdin());

  emit('system', { subtype: 'init' });

  // Git Desk parity: prefer the per-task worktree (SAGA_DESK_EXECUTION_PATH)
  // over the shared repository root. The scripted executor provisions a
  // worktree per git_change task (same as production RepositoryDeskProvisioner),
  // so each worker commits in isolation. Non-git tasks fall back to the shared
  // root (SAGA_BUTTON_REPO_PATH).
  const repoPath = process.env.SAGA_DESK_EXECUTION_PATH
    || process.env.SAGA_BUTTON_REPO_PATH
    || '.';
  const desk = process.env.SAGA_DESK_EXECUTION_PATH ? {
    executionPath: process.env.SAGA_DESK_EXECUTION_PATH,
    branch: process.env.SAGA_DESK_BRANCH,
    baseCommit: process.env.SAGA_DESK_BASE_COMMIT,
    headCommit: process.env.SAGA_DESK_HEAD_COMMIT || null,
    integrationBranch: process.env.SAGA_DESK_INTEGRATION_BRANCH,
    repositoryRoot: process.env.SAGA_DESK_REPOSITORY_ROOT,
    detached: process.env.SAGA_DESK_DETACHED === '1',
  } : null;

  try {
    await runScenarioWorker({
      mcpConfigPath,
      prompt,
      scenarios,
      invocationLog,
      reserveInvocation,
      repoPath,
      desk,
    });
    emit('result', { subtype: 'success', is_error: false });
  } catch (err) {
    process.stderr.write(`[scenario-dispatcher] FATAL: ${err.message}\n`);
    emit('result', { subtype: 'error', is_error: true });
    // The invocation was already reserved durably before the handler ran.
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`[scenario-dispatcher] TOP-LEVEL FATAL: ${err.message}\n`);
  process.exit(1);
});
