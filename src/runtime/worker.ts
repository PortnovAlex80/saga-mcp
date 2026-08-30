#!/usr/bin/env node
// Activity worker process (M2). One process = one execution attempt.
//
//   node dist/runtime/worker.js --execution <id>
//   env: DB_PATH, SAGA_LEASE  (handed over by the bridge at claim time)
//
// The worker may only heartbeat and settle its own execution. Crashes leave
// no trace — which is the point: the sweep reaps stale heartbeats and the
// kernel decides retries. `mode: 'echo'` is the scripted worker: same physics
// as the real API call, deterministic, no network.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getDb, closeDb } from '../db.js';
import { getRun } from '../events.js';
import { getExecution, heartbeatExecution, completeActivity, failActivity } from '../kernel/executions.js';
import { readActivityInputs } from '../kernel/runner.js';
import { renderTemplateString, type Item } from '../kernel/node-types.js';

interface LlmParameters {
  prompt?: string;
  mode?: 'echo' | 'api' | 'opencode';
  model?: string;
  system?: string;
  temperature?: number;
  sleep_ms?: number;
  crash_attempt?: number;
}

/** Real model worker: the opencode CLI (auth lives in its own config,
 *  e.g. the Z.AI coding plan). Resolved without shell so prompts with any
 *  characters survive Windows. */
function opencodeBin(): string {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const candidate = path.join(
      process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'
    );
    if (existsSync(candidate)) return candidate;
  }
  return 'opencode';
}

function runOpencode(prompt: string, model: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(opencodeBin(), ['run', '-m', model, prompt], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const killTimer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (error) => { clearTimeout(killTimer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(killTimer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`opencode exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function parseArgs(): string {
  const index = process.argv.indexOf('--execution');
  const id = index >= 0 ? process.argv[index + 1] : undefined;
  if (!id) {
    console.error('usage: worker.js --execution <id>');
    process.exit(2);
  }
  return id;
}

function renderPrompt(tmpl: string, items: Item[]): string {
  const lines = items.map((item) => renderTemplateString(tmpl, item.json));
  return lines.join('\n\n');
}

async function callApi(
  baseUrl: string,
  apiKey: string,
  model: string,
  params: LlmParameters,
  prompt: string,
  timeoutMs: number
): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [];
  if (params.system) messages.push({ role: 'system', content: params.system });
  messages.push({ role: 'user', content: prompt });
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`LLM_HTTP_${response.status}: ${await response.text().catch(() => response.statusText)}`);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? '';
}

async function main(): Promise<void> {
  const executionId = parseArgs();
  const lease = process.env.SAGA_LEASE;
  if (!lease) {
    console.error('SAGA_LEASE is required (the bridge hands it over at claim time)');
    process.exit(2);
  }
  const db = getDb();
  const execution = getExecution(db, executionId);
  if (execution.status !== 'running') {
    console.error(`execution ${executionId} is not running (status=${execution.status})`);
    process.exit(2);
  }
  const run = getRun(db, execution.run_id);
  const workflow = db
    .prepare('SELECT graph_json FROM workflows WHERE id = ?')
    .get(run.workflow_id) as { graph_json: string };
  const graph = JSON.parse(workflow.graph_json) as {
    nodes: Record<string, { parameters?: LlmParameters }>;
  };
  const params: LlmParameters = graph.nodes[execution.node_id]?.parameters ?? {};
  const timeouts = JSON.parse(execution.timeouts_json) as { heartbeat_s: number; start_to_close_s?: number };

  // Crash simulation: hard-exit without settling — the sweep must reap this.
  if (params.crash_attempt !== undefined && params.crash_attempt === execution.attempt) {
    console.error(`[worker] simulated crash on attempt ${execution.attempt}`);
    process.exit(1);
  }

  const beatMs = Math.max(200, Math.floor(((timeouts.heartbeat_s ?? 15) * 1000) / 3));
  const beat = setInterval(() => {
    try {
      heartbeatExecution(db, executionId, lease);
    } catch (error) {
      console.error('[worker] heartbeat failed:', error instanceof Error ? error.message : error);
      clearInterval(beat);
      process.exit(1);
    }
  }, beatMs);

  try {
    const inputs = readActivityInputs(db, execution.run_id, workflow.graph_json, execution.node_id);
    if (typeof params.sleep_ms === 'number' && params.sleep_ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, params.sleep_ms));
    }

    let output: Item[];
    if ((params.mode ?? 'echo') === 'opencode') {
      const prompt = renderPrompt(params.prompt ?? '{{text}}', inputs);
      const model = params.model ?? 'zai-coding-plan/glm-5.3-flash';
      const text = await runOpencode(prompt, model, (timeouts.start_to_close_s ?? 180) * 1000);
      output = [{ json: { text: text.trim(), model } }];
    } else if ((params.mode ?? 'echo') === 'api') {
      const baseUrl = process.env.LLM_BASE_URL;
      if (!baseUrl) throw new Error('LLM_BASE_URL is required for mode=api');
      const prompt = renderPrompt(params.prompt ?? '{{text}}', inputs);
      const text = await callApi(
        baseUrl,
        process.env.LLM_API_KEY ?? '',
        params.model ?? process.env.LLM_MODEL ?? 'default',
        params,
        prompt,
        (timeouts.start_to_close_s ?? 120) * 1000
      );
      output = [{ json: { text, model: params.model ?? process.env.LLM_MODEL ?? 'default' } }];
    } else {
      output = [{
        json: {
          echo: inputs.flat().map((item) => item.json),
          note: 'scripted activity worker',
        },
      }];
    }

    clearInterval(beat);
    completeActivity(db, executionId, lease, output);
    closeDb();
    process.exit(0);
  } catch (error) {
    clearInterval(beat);
    const message = error instanceof Error ? error.message : String(error);
    console.error('[worker] failed:', message);
    try {
      failActivity(db, executionId, lease, 'llm_error', message);
    } catch (settleError) {
      console.error('[worker] could not settle failure:', settleError instanceof Error ? settleError.message : settleError);
    }
    closeDb();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[worker] fatal:', error);
  process.exit(1);
});
