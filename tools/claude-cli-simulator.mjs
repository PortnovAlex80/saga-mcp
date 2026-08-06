#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import {
  createStreamEmitter,
  enrichContext,
  executeSteps,
  heartbeat,
  loadSagaRuntime,
  parseClaudeArgv,
  parseSagaPrompt,
  resolveDbPath,
} from './claude-simulator/runtime.mjs';
import { maybeIntegrateApprovedReview } from './claude-simulator/post-scenario.mjs';
import { selectButtonColorScenario } from './claude-simulator/scenarios/button-color.mjs';

async function main() {
  const startedAt = Date.now();
  const stream = createStreamEmitter(process.stdout);
  const { mcpConfigPath, prompt: argvPrompt } = parseClaudeArgv(process.argv);

  // The claude-runner passes the prompt via stdin (child.stdin.write(prompt))
  // when no positional prompt is present in argv. Read stdin synchronously
  // when argv yielded no prompt.
  let prompt = argvPrompt;
  if (!prompt) {
    try {
      prompt = readFileSync(0, 'utf8');
    } catch {
      prompt = '';
    }
  }

  const promptContext = parseSagaPrompt(prompt);
  stream.init();

  if (!Number.isInteger(promptContext.task_id) || !promptContext.worker_id) {
    const message = 'SIMULATOR_PROMPT_INVALID: task_id and worker_id are required';
    stream.result({ durationMs: Date.now() - startedAt, success: false, summary: message, error: message });
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
    return;
  }

  const dbPath = resolveDbPath(mcpConfigPath, process.env);
  if (!dbPath) {
    const message = 'SIMULATOR_DB_PATH_MISSING: DB_PATH was not found in --mcp-config or environment';
    stream.result({ durationMs: Date.now() - startedAt, success: false, summary: message, error: message });
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
    return;
  }

  let ctx = promptContext;
  try {
    const runtime = await loadSagaRuntime(dbPath);
    ctx = enrichContext(runtime, promptContext);
    heartbeat(ctx, 'SIM_CLAIMED', `scenario=${process.env.SAGA_SIM_SCENARIO || 'button-color'}`);
    stream.text(
      `simulator: task=${ctx.task_id} module=${ctx.process_module_ref ?? 'legacy'} `
      + `node=${ctx.process_node_id ?? 'legacy'} role=${ctx.role} attempt=${ctx.attempt}`,
    );

    const scenarioName = process.env.SAGA_SIM_SCENARIO || 'button-color';
    if (scenarioName !== 'button-color') {
      throw new Error(`SIMULATOR_SCENARIO_UNKNOWN: ${scenarioName}`);
    }
    const scenario = selectButtonColorScenario(ctx, process.env);
    stream.text(`simulator: selected ${scenario.id}`);
    await executeSteps(runtime, ctx, scenario, stream);
    maybeIntegrateApprovedReview(runtime, ctx, scenario, stream);

    const durationMs = Date.now() - startedAt;
    heartbeat(ctx, 'SIM_DONE', `scenario=${scenario.id} duration=${durationMs}ms`);
    stream.result({ durationMs, success: true, summary: `deterministic scenario '${scenario.id}' completed` });
    process.exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startedAt;
    heartbeat(ctx, 'SIM_FAILED', message);
    stream.text(`simulator failure: ${message}`);
    stream.result({ durationMs, success: false, summary: message, error: message });
    process.stderr.write(`saga-claude-simulator: ${error instanceof Error ? error.stack : message}\n`);
    process.exitCode = process.env.SAGA_SIM_EXIT_ZERO_ON_FAILURE === '1' ? 0 : 1;
  }
}

main().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
