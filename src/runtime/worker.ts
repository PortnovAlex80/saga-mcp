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
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDb, closeDb } from '../db.js';
import { getRun, getEvents } from '../events.js';
import {
  getExecution,
  heartbeatExecution,
  completeActivity,
  failActivity,
  type EffectSettlement,
  type ModelUsage,
} from '../kernel/executions.js';
import { readActivityInputs, nodeDefinitionFor } from '../kernel/runner.js';
import { renderTemplateString, type Item } from '../kernel/node-types.js';

interface LlmParameters {
  prompt?: string;
  mode?: 'echo' | 'api' | 'opencode' | 'git';
  /** command node: declared command, product repo, budget. */
  run?: string;
  label?: string;
  timeout_s?: number;
  /** 'items' — судить КАНДИДАТА во временном каталоге, а не репозиторий. */
  workdir?: 'items';
  /** attach tool: accepted product artifacts pasted into the prompt. */
  attach?: Array<{ path: string; label?: string }>;
  model?: string;
  system?: string;
  temperature?: number;
  sleep_ms?: number;
  crash_attempt?: number;
  crash_after_effect?: number;
  repo?: string;
  branch?: string;
  message?: string;
  files?: Array<{ path: string; field?: string }>;
  /** git effect: build the file set from input items ({path, content}). */
  files_from?: 'items';
  effect_key?: string;
}

/** Typed effect conflict: carries its own durable settlement. */
class EffectConflict extends Error {
  settlement: EffectSettlement;
  constructor(message: string, settlement: EffectSettlement) {
    super(message);
    this.settlement = settlement;
  }
}

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Models often wrap code in ```lang fences even when told not to. */
function stripCodeFences(text: string): string {
  const match = text.trim().match(/^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```$/);
  return match ? match[1] : text.trim();
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

interface DesiredFile {
  path: string;
  content: string;
}

function desiredFiles(params: LlmParameters, inputs: Item[]): DesiredFile[] {
  // Dynamic mode: each input item IS a file ({path, content}) — used by the
  // integration effect after the development fan-out.
  if (params.files_from === 'items') {
    return inputs
      .map((item) => ({ path: String(item.json.path ?? ''), content: String(item.json.content ?? '') }))
      .filter((f) => f.path.length > 0)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  return (params.files ?? [])
    .map((f) => ({
      path: f.path,
      content: inputs.map((item) => (item.json[f.field ?? 'text'] ?? '')).join('\n'),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function findCommitByKey(repo: string, key: string): string | null {
  let log: string;
  try {
    log = git(repo, ['log', '--format=%H%x00%B%x00']);
  } catch {
    return null; // empty repository — no prior effect commits
  }
  const parts = log.split('\0');
  // entries alternate hash / body
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i + 1].includes(`Effect-Key: ${key}`)) return parts[i];
  }
  return null;
}

function fileAt(repo: string, commit: string, filePath: string): string | null {
  try {
    return git(repo, ['show', `${commit}:${filePath}`]);
  } catch {
    return null;
  }
}

/** git_commit effect: idempotent by key, typed outcomes, no silent retries
 *  of already-applied state. */
function performGitEffect(
  execution: { run_id: string; node_id: string; attempt: number },
  params: LlmParameters,
  inputs: Item[]
): { items: Item[]; effect: EffectSettlement; crashAfter: boolean } {
  const repo = params.repo ?? '';
  if (!repo || !existsSync(repo)) {
    throw new Error(`EFFECT_REPO_MISSING: '${repo}'`);
  }
  const branch = params.branch ?? 'main';
  const desired = desiredFiles(params, inputs);
  const desiredDigest = sha(JSON.stringify(desired));
  const key = params.effect_key ?? sha(`${execution.run_id}:${execution.node_id}:${desiredDigest}`);
  const baseSettlement = {
    key,
    desired_digest: desiredDigest,
  };

  // Idempotency first: observe external state before repeating (§26.3).
  const existing = findCommitByKey(repo, key);
  if (existing) {
    const matches = desired.every((f) => fileAt(repo, existing, f.path) === f.content);
    if (matches) {
      return {
        items: [{ json: { effect_key: key, outcome: 'already_applied', commit: existing, branch } }],
        effect: {
          ...baseSettlement,
          outcome: 'already_applied',
          receipt: { commit: existing, branch },
        },
        crashAfter: false,
      };
    }
    throw new EffectConflict(
      `effect key reused with different desired state (commit ${existing})`,
      {
        ...baseSettlement,
        outcome: 'conflict',
        receipt: { reason: 'key_reuse_different_content', commit: existing },
      }
    );
  }

  if (git(repo, ['status', '--porcelain']).length > 0) {
    throw new EffectConflict('worktree is dirty', {
      ...baseSettlement,
      outcome: 'conflict',
      receipt: { reason: 'worktree_dirty' },
    });
  }

  const headBefore = safeHead(repo);
  for (const file of desired) {
    const fullPath = path.join(repo, file.path);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, 'utf8');
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', params.message ?? 'saga5 effect', '-m', `Effect-Key: ${key}`]);
  const commit = git(repo, ['rev-parse', 'HEAD']);

  return {
    items: [{ json: { effect_key: key, outcome: 'applied', commit, branch, head_before: headBefore } }],
    effect: {
      ...baseSettlement,
      outcome: 'applied',
      receipt: { commit, branch, head_before: headBefore },
    },
    crashAfter: params.crash_after_effect === execution.attempt,
  };
}

function safeHead(repo: string): string | null {
  try {
    return git(repo, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
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

/** Live window into what the worker is doing. Read by the heartbeat, shown in
 *  the operator's monitor — never by a decision.
 *
 *  Honest limitation: `opencode run` does not stream tokens — measured, the
 *  whole answer arrives in one chunk at the end. So this is NOT a thought
 *  stream; it is a PHASE log built from `--format json` events (step started,
 *  answer received, tool used). That is the truth the CLI can actually tell,
 *  and it is what distinguishes "the model is thinking" from "the call hung
 *  before it ever started". */
const live = { text: '' };

/** Best-effort final write of the phase log. Operational only. */
function flushProgress(db: ReturnType<typeof getDb>, executionId: string, lease: string): void {
  if (!live.text) return;
  try {
    heartbeatExecution(db, executionId, lease, { progress: live.text });
  } catch {
    /* the attempt may already be reaped — the monitor is not worth a failure */
  }
}

function noteRaw(line: string): void {
  live.text = `${live.text}${line}\n`;
}

function note(started: number, line: string): void {
  noteRaw(`[+${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);
}

interface OpencodeResult {
  text: string;
  usage?: ModelUsage;
}

/** Parses opencode's NDJSON event stream. Falls back to raw stdout when a
 *  provider or version emits something we do not recognise — a monitor must
 *  never be the reason a worker fails. */
function runOpencode(prompt: string, model: string, timeoutMs: number): Promise<OpencodeResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    note(started, `запрос отправлен · ${model} · ${prompt.length} симв.`);
    const child = spawn(opencodeBin(), ['run', '--format', 'json', '-m', model, prompt], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let pending = '';
    const texts: string[] = [];
    let usage: ModelUsage | undefined;

    const consume = (line: string): void => {
      if (!line.trim()) return;
      let event: { type?: string; part?: Record<string, unknown> };
      try {
        event = JSON.parse(line) as { type?: string; part?: Record<string, unknown> };
      } catch {
        return; // not an event line — kept in stdout for the fallback
      }
      const part = event.part ?? {};
      if (event.type === 'step_start') {
        note(started, 'модель начала шаг');
      } else if (event.type === 'text' && typeof part.text === 'string') {
        texts.push(part.text);
        note(started, `получен ответ · ${part.text.length} симв.`);
      } else if (event.type === 'tool' || event.type === 'tool_use') {
        note(started, `инструмент: ${String(part.name ?? part.tool ?? '—')}`);
      } else if (event.type === 'step_finish') {
        const tokens = part.tokens as Record<string, unknown> | undefined;
        usage = {
          input: Number(tokens?.input ?? 0) || undefined,
          output: Number(tokens?.output ?? 0) || undefined,
          reasoning: Number(tokens?.reasoning ?? 0) || undefined,
          cost: Number(part.cost ?? 0) || undefined,
        };
        note(started, `шаг завершён · ${usage.output ?? '?'} токенов ответа`);
      }
    };

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) consume(line);
    });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const killTimer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (error) => { clearTimeout(killTimer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(killTimer);
      if (pending) consume(pending);
      if (code !== 0) {
        reject(new Error(`opencode exited ${code}: ${stderr.slice(-500)}`));
        return;
      }
      if (texts.length > 0) {
        resolve({ text: texts.join('\n'), usage });
        return;
      }
      note(started, 'событий не распознано — беру сырой вывод');
      resolve({ text: stdout, usage });
    });
  });
}

/** Runs a DECLARED command in the product repository. The outcome — including
 *  the output a failing test printed — becomes material, so the gate can
 *  reject on evidence and the repair prompt can carry that evidence back. */
function runCommand(
  params: LlmParameters,
  started: number,
  inputs: Item[]
): Promise<Item[]> {
  const run = String(params.run ?? '').trim();
  if (!run) throw new Error('COMMAND_MISSING: у узла command не задан parameters.run');
  // `workdir: 'items'` проверяет КАНДИДАТА: входные items ({path, content})
  // материализуются во временный каталог, и команда судит их, а не то, что уже
  // лежит в репозитории. Так «публикуем только то, что запускается» становится
  // выполнимым: приёмка проходит ДО эффекта.
  let cwd = params.repo ?? '';
  let scratch: string | undefined;
  if (params.workdir === 'items') {
    scratch = mkdtempSync(path.join(tmpdir(), 'saga5-candidate-'));
    let written = 0;
    for (const item of inputs) {
      const filePath = typeof item.json.path === 'string' ? item.json.path : '';
      if (!filePath) continue;
      const full = path.join(scratch, filePath);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, String(item.json.content ?? ''), 'utf8');
      written++;
    }
    note(started, `кандидат разложен во временный каталог: ${written} файл(ов)`);
    cwd = scratch;
  }
  if (!cwd || !existsSync(cwd)) throw new Error(`COMMAND_REPO_MISSING: '${cwd}'`);
  const timeoutMs = Math.max(1, params.timeout_s ?? 120) * 1000;
  note(started, `выполняю: ${run}`);

  return new Promise((resolve) => {
    const child = spawn(run, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let killed = false;
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    const killTimer = setTimeout(() => { killed = true; child.kill(); }, timeoutMs);
    const settle = (code: number | null, error?: string): void => {
      clearTimeout(killTimer);
      if (scratch) rmSync(scratch, { recursive: true, force: true });
      const ok = !killed && code === 0;
      note(started, ok ? 'команда прошла' : `команда не прошла (код ${code ?? '—'})`);
      resolve([{
        json: {
          ok,
          exit_code: code ?? -1,
          command: params.label ?? run,
          output: (killed ? `таймаут ${params.timeout_s ?? 120}s\n` : '') + (error ? `${error}\n` : '') + output.slice(-8000),
        },
      }]);
    };
    // Даже неудача — это МАТЕРИАЛ, а не отказ активности: гейт должен увидеть
    // исход и вернуть его в доработку, а не отправить попытку в ретрай.
    child.on('error', (error) => settle(-1, error.message));
    child.on('exit', (code) => settle(code));
  });
}

/** attach: принятые артефакты продукта, вложенные в промпт как контекст. */
function attachments(params: LlmParameters): string {
  const repo = params.repo ?? '';
  let text = '';
  for (const item of params.attach ?? []) {
    const full = path.join(repo, item.path);
    if (!existsSync(full)) continue;
    text += `\n\n=== ${item.label ?? item.path} ===\n${readFileSync(full, 'utf8')}`;
  }
  return text;
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

/** Repair feedback: the gate's rejection reasons travel into the retry's
 *  prompt, so the worker fixes WHAT failed — not just rolls the dice again. */
function readRepairFeedback(db: ReturnType<typeof getDb>, runId: string, nodeId: string): string | null {
  let last: { reasons?: unknown } | null = null;
  for (const event of getEvents(db, runId)) {
    if (event.type !== 'repair.requested') continue;
    const payload = JSON.parse(event.payload_json) as { target?: string; reasons?: string[] };
    if (payload.target === nodeId) last = payload;
  }
  const reasons = last?.reasons;
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  return reasons.map((r) => `- ${r}`).join('\n');
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
  // Static nodes live in the declared graph; spawned children (split fan-out)
  // resolve their definition through the kernel — from the event log.
  const definition = nodeDefinitionFor(db, execution.run_id, workflow.graph_json, execution.node_id);
  const params: LlmParameters = definition.parameters as LlmParameters;
  const timeouts = JSON.parse(execution.timeouts_json) as { heartbeat_s: number; start_to_close_s?: number };

  // Crash simulation: hard-exit without settling — the sweep must reap this.
  if (params.crash_attempt !== undefined && params.crash_attempt === execution.attempt) {
    console.error(`[worker] simulated crash on attempt ${execution.attempt}`);
    process.exit(1);
  }

  const beatMs = Math.max(200, Math.floor(((timeouts.heartbeat_s ?? 15) * 1000) / 3));
  const beat = setInterval(() => {
    try {
      heartbeatExecution(db, executionId, lease, { progress: live.text });
    } catch (error) {
      console.error('[worker] heartbeat failed:', error instanceof Error ? error.message : error);
      clearInterval(beat);
      process.exit(1);
    }
  }, beatMs);

  try {
    const inputs = readActivityInputs(db, execution.run_id, workflow.graph_json, execution.node_id);
    const feedback = execution.attempt > 1
      ? readRepairFeedback(db, execution.run_id, execution.node_id)
      : null;
    const repairNote = feedback
      ? `\n\nПрежняя попытка не прошла приёмку. Замечания приёмки:\n${feedback}\nУстрани их в новой версии.`
      : '';
    if (typeof params.sleep_ms === 'number' && params.sleep_ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, params.sleep_ms));
    }

    let output: Item[];
    let effectSettlement: EffectSettlement | undefined;
    let crashAfterEffect = false;
    let usage: ModelUsage | undefined;
    if (definition.type === 'command') {
      output = await runCommand(params, Date.now(), inputs);
    } else if ((params.mode ?? 'echo') === 'git') {
      const applied = performGitEffect(execution, params, inputs);
      output = applied.items;
      effectSettlement = applied.effect;
      crashAfterEffect = applied.crashAfter;
    } else if ((params.mode ?? 'echo') === 'opencode') {
      const prompt = renderPrompt(params.prompt ?? '{{text}}', inputs) + attachments(params) + repairNote;
      const model = params.model ?? 'zai-coding-plan/glm-5.3-flash';
      const answer = await runOpencode(prompt, model, (timeouts.start_to_close_s ?? 180) * 1000);
      // Usage is provenance of the ATTEMPT, not of the material: keeping it out
      // of the item keeps identical answers content-identical.
      usage = answer.usage;
      output = [{ json: { text: stripCodeFences(answer.text), model } }];
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
      // Scripted worker: echoes the rendered prompt back — same physics as a
      // real model call (the text field flows downstream exactly like a reply).
      output = [{
        json: {
          text: renderPrompt(params.prompt ?? '', inputs) + repairNote,
          echo: inputs.map((item) => item.json),
          note: 'scripted activity worker',
        },
      }];
    }

    clearInterval(beat);
    // The last phases land after the final beat; flush them so the finished
    // card shows the whole story. A monitor write must never block a settle.
    flushProgress(db, executionId, lease);
    if (crashAfterEffect) {
      // Kill-test seam: the external change happened, the receipt did not.
      console.error(`[worker] simulated crash AFTER effect on attempt ${execution.attempt}`);
      closeDb();
      process.exit(1);
    }
    completeActivity(db, executionId, lease, output, {
      ...(effectSettlement ? { effect: effectSettlement } : {}),
      ...(usage ? { usage } : {}),
    });
    closeDb();
    process.exit(0);
  } catch (error) {
    clearInterval(beat);
    const message = error instanceof Error ? error.message : String(error);
    console.error('[worker] failed:', message);
    noteRaw(`ОТКАЗ: ${message.slice(0, 300)}`);
    flushProgress(db, executionId, lease);
    try {
      if (error instanceof EffectConflict) {
        failActivity(db, executionId, lease, 'effect_conflict', message, { effect: error.settlement });
      } else {
        failActivity(db, executionId, lease, 'llm_error', message);
      }
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
