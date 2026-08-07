#!/usr/bin/env node
/**
 * Model-routing proxy for the Claude CLI.
 *
 * Sits between the factory runtime and the actual Claude CLI (or simulator).
 * Reads --model from argv: when model is "mock", routes to the deterministic
 * simulator; any other value is forwarded to the real Claude CLI verbatim.
 *
 * This lets the factory use per-module model routing (factory-models.json)
 * without the runtime needing to know which binary to spawn. The runtime
 * always calls this proxy; the proxy decides the backend by model name.
 *
 * Usage (set as SAGA_CLAUDE_PATH):
 *   node tools/proxy-claude.mjs --model glm-5.2 -p ...
 *   node tools/proxy-claude.mjs --model mock -p ...
 *
 * Env:
 *   SAGA_PROXY_REAL_CLAUDE  — path to real claude binary (default: "claude")
 *   SAGA_PROXY_SIMULATOR    — path to simulator script (default: auto-detect)
 *   SAGA_SIM_SCENARIO       — scenario name for simulator (passed through)
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const REAL_CLAUDE = process.env.SAGA_PROXY_REAL_CLAUDE ?? 'claude';
const SIMULATOR = process.env.SAGA_PROXY_SIMULATOR
  ?? `node ${join(repoRoot, 'tools', 'claude-cli-simulator.mjs')}`;

// Parse --model from argv (the runner always passes it)
const argv = process.argv.slice(2);
let modelIdx = argv.indexOf('--model');
let model = null;
if (modelIdx !== -1 && modelIdx + 1 < argv.length) {
  model = argv[modelIdx + 1];
}

// Decide backend
if (model === 'mock' || model === 'saga-deterministic-simulator') {
  // Route to simulator: strip --model (simulator doesn't need it)
  const simArgs = argv.filter((_, i) => i !== modelIdx && i !== modelIdx + 1);
  const parts = SIMULATOR.trim().split(/\s+/);
  const child = spawn(parts[0], [...parts.slice(1), ...simArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', code => process.exit(code ?? 1));
} else {
  // Forward to real claude verbatim
  const child = spawn(REAL_CLAUDE, argv, {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', code => process.exit(code ?? 1));
}
