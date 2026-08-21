// tests/factory-proof/k2-spawn-override.mjs
//
// K2-A — the workerSpawn seam override (conformance-engine plan §K2).
//
// Returns a spawn function for FactoryCompositionOverrides.workerSpawn. The
// PRODUCTION runner still builds the entire worker envelope (argv, prompt via
// stdin, pinned cwd, sanitized env, per-execution --mcp-config, heartbeats,
// exit classification, finalization, recovery); this override swaps ONLY the
// physical executable: the worker CLI invocation becomes
// `node k2-scripted-child.mjs <same argv>`. No runner/executor code changes,
// no authority moves — the K2 checklist "preserve the production runner and
// replace only model cognition".
//
// Every interception is appended to a JSONL log (K2_SPAWN_LOG) so tests can
// prove the strict path really spawned a child (vs the in-process
// workerExecutorFactory fast lane).

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';

const CHILD_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'k2-scripted-child.mjs');

/**
 * @param {object} opts
 * @param {string} opts.programPath  Actor program (JSON steps or an .mjs module — see k2-scripted-child.mjs).
 * @param {string} opts.spawnLog     JSONL interception log for assertions.
 * @param {string} [opts.variant]    K2_ACTOR_VARIANT — the actor's constitution (W1-1 pattern).
 * @param {boolean} [opts.stripMcpConfig] K2-D negative: remove --mcp-config from the
 *                                        envelope — the strict scenario must fail BEFORE
 *                                        any handler runs (the child cannot reach the server).
 */
export function createScriptedChildSpawn(opts) {
  if (!opts?.programPath) throw new Error('K2_SPAWN_PROGRAM_REQUIRED');
  if (!opts?.spawnLog) throw new Error('K2_SPAWN_LOG_REQUIRED');
  return function workerSpawn(command, args, options) {
    appendFileSync(opts.spawnLog, `${JSON.stringify({
      intercepted: true,
      originalCommand: command,
      argvHead: args.slice(0, 6),
      cwd: options?.cwd ?? null,
      hasMcpConfig: args.includes('--mcp-config'),
      promptViaStdin: true,
    })}\n`);
    const env = {
      ...options.env,
      K2_ACTOR_PROGRAM: opts.programPath,
      ...(opts.variant ? { K2_ACTOR_VARIANT: opts.variant } : {}),
    };
    // K2-D negative: the envelope WITHOUT the MCP config is unlawful — the
    // argv-compatible child rejects it (exit 3) before any tool call.
    const childArgs = opts.stripMcpConfig
      ? args.filter((flag, i) => flag !== '--mcp-config' && args[i - 1] !== '--mcp-config')
      : args;
    const child = nodeSpawn(
      process.execPath,
      [CHILD_PATH, ...childArgs],
      { ...options, env, windowsHide: true },
    );
    // Debug rail: the child's typed failures land in the spawn log so drives
    // and tests can see WHY a strict actor exited (never feeds decisions).
    child.stderr?.on('data', chunk => {
      try {
        appendFileSync(opts.spawnLog, `${JSON.stringify({ stderr: String(chunk).slice(0, 600) })}\n`);
      } catch { /* best effort */ }
    });
    return child;
  };
}
