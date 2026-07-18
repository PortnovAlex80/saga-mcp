#!/usr/bin/env node
/**
 * saga-mcp 3.0 — CLI entry point for the autonomous orchestration engine.
 *
 * Usage:
 *   node dist/orchestrate-cli.js <project_id> <epic_id> [--concurrency=4]
 *
 * This is the background process spawned by the tracker-view web UI when a
 * user clicks "New Project" (POST /api/project/create-from-idea). It runs
 * the pump loop in src/orchestrate.ts until the episode completes or pauses
 * for human attention. CLI is also the fallback when the web form is broken
 * (plan §Risks: "Web UI форма не POST'ит → CLI fallback").
 *
 * Env:
 *   DB_PATH             — saga SQLite database (required; same as saga server)
 *   SAGA_CLAUDE_PATH    — path to the claude CLI binary (default: 'claude')
 *   SAGA_ORCHESTRATION_LOG — directory for engine logs (default: ~/.zcode/cli)
 */

import { orchestrate } from './orchestrate.js';
import { closeDb } from './db.js';

function parseArgs(argv: string[]): {
  projectId: number;
  epicId: number;
  concurrency: number;
} {
  const positional: string[] = [];
  let concurrency = 4;
  for (const arg of argv.slice(2)) {
    const m = /^--concurrency=(\d+)$/.exec(arg);
    if (m) {
      concurrency = Number(m[1]);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
        throw new Error(`--concurrency must be an integer 1..10, got '${m[1]}'`);
      }
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'Usage: orchestrate-cli.js <project_id> <epic_id> [--concurrency=4]\n' +
        '  Runs the saga 3.0 autonomous engine until episode completion.\n',
      );
      process.exit(0);
    }
    positional.push(arg);
  }
  if (positional.length !== 2) {
    process.stderr.write(
      'Usage: orchestrate-cli.js <project_id> <epic_id> [--concurrency=4]\n',
    );
    process.exit(2);
  }
  const projectId = Number(positional[0]);
  const epicId = Number(positional[1]);
  if (!Number.isInteger(projectId) || projectId < 1) {
    process.stderr.write(`project_id must be a positive integer, got '${positional[0]}'\n`);
    process.exit(2);
  }
  if (!Number.isInteger(epicId) || epicId < 1) {
    process.stderr.write(`epic_id must be a positive integer, got '${positional[1]}'\n`);
    process.exit(2);
  }
  return { projectId, epicId, concurrency };
}

async function main() {
  // Parse args first so --help / -h work without DB_PATH.
  const { projectId, epicId, concurrency } = parseArgs(process.argv);
  if (!process.env.DB_PATH) {
    process.stderr.write(
      'DB_PATH env var is required (path to the saga SQLite database).\n',
    );
    process.exit(2);
  }
  process.stdout.write(
    `[orchestrate-cli] starting project=${projectId} epic=${epicId} concurrency=${concurrency}\n`,
  );

  try {
    const result = await orchestrate({
      projectId,
      epicId,
      concurrency,
      claudePath: process.env.SAGA_CLAUDE_PATH,
    });
    process.stdout.write(`[orchestrate-cli] done: ${JSON.stringify(result)}\n`);
    // Exit code: 0 on completion, 0 on paused_timeout (the engine waited its
    // full pause window; that's not a crash — a human will restart it). 1 on
    // other failures.
    process.exit(result.reason === 'failed' ? 1 : 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[orchestrate-cli] fatal: ${msg}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
    process.exit(1);
  } finally {
    try { closeDb(); } catch { /* best effort */ }
  }
}

main().catch(err => {
  process.stderr.write(`[orchestrate-cli] unhandled: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
