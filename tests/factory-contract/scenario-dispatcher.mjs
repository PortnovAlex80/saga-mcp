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

import { readFileSync, writeFileSync } from 'node:fs';
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

// Load the invocation log path — if set, every invocation is appended to this file
const invocationLogPath = process.env.SAGA_INVOCATION_LOG;

const { runScenarioWorker, scenarioKey, scenarioKeyString } = await import('./scenario-engine.mjs');

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

  // Each physical worker is a fresh OS process. Attempt identity therefore
  // cannot live only in this process's array: preload the durable history that
  // prior workers appended, then record only this worker in invocationLog.
  let priorInvocations = [];
  if (invocationLogPath) {
    try {
      const parsed = JSON.parse(readFileSync(invocationLogPath, 'utf8').trim() || '[]');
      if (Array.isArray(parsed)) priorInvocations = parsed;
    } catch {}
  }
  const invocationLog = [];
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
      priorInvocations,
      repoPath,
      desk,
    });
    emit('result', { subtype: 'success', is_error: false });
  } catch (err) {
    process.stderr.write(`[scenario-dispatcher] FATAL: ${err.message}\n`);
    emit('result', { subtype: 'error', is_error: true });
    // Write invocation log even on failure so tests can inspect
    if (invocationLogPath && invocationLog.length > 0) {
      try {
        const existing = JSON.parse(readFileSync(invocationLogPath, 'utf8').trim() || '[]');
        existing.push(...invocationLog);
        writeFileSync(invocationLogPath, JSON.stringify(existing, null, 2));
      } catch {}
    }
    process.exit(1);
  }

  // Persist invocation log
  if (invocationLogPath && invocationLog.length > 0) {
    try {
      const { readFileSync: rd, writeFileSync: wr } = await import('node:fs');
      let existing = [];
      try { existing = JSON.parse(rd(invocationLogPath, 'utf8').trim() || '[]'); } catch {}
      existing.push(...invocationLog);
      wr(invocationLogPath, JSON.stringify(existing, null, 2));
    } catch {}
  }

  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`[scenario-dispatcher] TOP-LEVEL FATAL: ${err.message}\n`);
  process.exit(1);
});
