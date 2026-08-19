#!/usr/bin/env node
// Agent proxy — claude-CLI-compatible shim over `opencode run` (Z.AI Coding Plan).
//
// Purpose: the saga factory spawns worker agents through the claude CLI surface
// (claude -p --bare --model X --mcp-config Y ...). This shim accepts that exact
// argv + stdin-prompt contract and translates it to an official OpenCode CLI
// invocation, so the factory can run workers on OpenCode without touching the
// runner. Wiring:
//
//   SAGA_REAL_CLAUDE_PATH="node D:/Development/saga-mcp/tools/agent-proxy/claude-shim.mjs"
//
// (claude-runner's spawnClaude splits compound paths on spaces; keep this path
// space-free.) Claude remains the default/reserve backend when the env is unset.
//
// Translation table:
//   claude -p + stdin prompt        → opencode run (prompt piped via stdin)
//   --model glm-4.7 / glm-5-*       → --model zai-coding-plan/<id> (registry map)
//   --mcp-config <path>             → OPENCODE_CONFIG with opencode "mcp" section
//   --settings <hooks json>         → saga-structured-context plugin (copied to
//                                     ~/.config/opencode/plugins/), which ports
//                                     PostToolUse/PostToolUseFailure via
//                                     tool.execute.after + session.prompt(noReply)
//   --disallowedTools <list>        → OPENCODE_PERMISSION deny JSON (both claude
//                                     and opencode MCP tool naming, best-effort;
//                                     the saga gateway remains the real authority)
//   --effort                        → ignored (reasoning is model-picked here), logged
//   --bare / --disable-slash-...    → accepted no-op for this backend
//   --output-format stream-json     → `opencode run --format json` + live translation
//                                     of the REAL opencode events (tool_use/text/
//                                     step_finish) into claude stream-json lines on
//                                     stdout, so every claude-stream-json consumer
//                                     works unmodified: the repeated-tool-loop
//                                     detector (claude-runner.mjs kill path, E-S1),
//                                     the /api/worker/tail events view and the
//                                     token accounting in lifecycle-endpoints.mjs.
//                                     Without this flag the passthrough behavior is
//                                     byte-identical to before (ANSI TUI, no
//                                     translation). Captured real event shapes
//                                     (opencode 1.18.18): {"type":"tool_use",
//                                     "part":{"tool":"read","callID":"...",
//                                     "state":{"status":"completed","input":{...}}}},
//                                     {"type":"text","part":{"type":"text","text":...}},
//                                     {"type":"step_finish","part":{"tokens":{...}}}.
//   --verbose / --forward-subagent-text / --no-session-persistence
//                                  → accepted no-op bools (part of the runner argv
//                                     surface, claude-runner.mjs spawn args)
//
// Exit code and stdout/stderr are passed through; stdout is only a progress
// signal for the foreman (markExecutionProgress), so opencode's ANSI output is
// safe. All SAGA_* env is inherited so the MCP gateway and the hook plugin see
// the execution identity.

import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the opencode executable. On Windows a bare spawn('opencode') hits
// npm's .cmd shim, which node's spawn (no shell) cannot execute — point at
// the real bin inside the global opencode-ai package instead.
function resolveOpenCodeBin() {
  if (process.env.SAGA_PROXY_OPENCODE_PATH && existsSync(process.env.SAGA_PROXY_OPENCODE_PATH)) {
    return { cmd: process.env.SAGA_PROXY_OPENCODE_PATH, shell: false };
  }
  if (process.platform === 'win32') {
    try {
      const prefix = execSync('npm config get prefix', { encoding: 'utf8' }).trim();
      const exe = path.join(prefix, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
      if (existsSync(exe)) return { cmd: exe, shell: false };
    } catch { /* fall through */ }
    return { cmd: 'opencode', shell: true };
  }
  return { cmd: 'opencode', shell: false };
}

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Model registry mapping (opencode zai-coding-plan provider, checked against
// `opencode models` on 2026-08-18). glm-5.3 is not yet in the opencode registry
// → falls back to glm-5.2 with a loud stderr note (same plan, same quota).
// ---------------------------------------------------------------------------

const MODEL_MAP = new Map([
  ['glm-4.5', 'zai-coding-plan/glm-4.5'],
  ['glm-4.5-air', 'zai-coding-plan/glm-4.5-air'],
  ['glm-4.6', 'zai-coding-plan/glm-4.6'],
  ['glm-4.7', 'zai-coding-plan/glm-4.7'],
  ['glm-5', 'zai-coding-plan/glm-5'],
  ['glm-5-turbo', 'zai-coding-plan/glm-5-turbo'],
  ['glm-5.1', 'zai-coding-plan/glm-5.1'],
  ['glm-5.2', 'zai-coding-plan/glm-5.2'],
  ['glm-5.2-highspeed', 'zai-coding-plan/glm-5.2-highspeed'],
  ['glm-5.3', 'zai-coding-plan/glm-5.3'],
]);
const DEFAULT_MODEL = process.env.SAGA_PROXY_DEFAULT_MODEL || 'zai-coding-plan/glm-4.7';

// glm-5.3 is not yet in opencode's built-in zai-coding-plan registry
// (checked 2026-08-18, opencode 1.18.18) but IS served by the same official
// coding endpoint and covered by the plan (Z.ai FAQ: GLM-5.3 / GLM-5-Turbo /
// GLM-4.7). Per the documented "add models to a built-in provider" pattern
// (opencode docs /providers: OpenRouter/Cloudflare examples), the generated
// config extends the built-in provider with a glm-5.3 entry — auth stays in
// opencode's auth.json, no key duplication.
// Models the official coding endpoint serves (GET .../coding/paas/v4/models,
// checked 2026-08-18: 9 ids incl. glm-4.5/4.5-air/4.6/5/5.1) but opencode's
// built-in zai-coding-plan registry lacks (1.18.18). The shim adds these to
// the built-in provider via the documented config pattern; auth stays in
// opencode's auth.json. When opencode ships them natively, these entries
// become harmless duplicates.
const REGISTRY_GAP_MODELS = {
  'glm-4.5': { name: 'GLM 4.5', limit: { context: 128000, output: 32768 } },
  'glm-4.5-air': { name: 'GLM 4.5 Air', limit: { context: 128000, output: 32768 } },
  'glm-4.6': { name: 'GLM 4.6', limit: { context: 200000, output: 65536 } },
  'glm-5': { name: 'GLM 5', limit: { context: 200000, output: 65536 } },
  'glm-5.1': { name: 'GLM 5.1', limit: { context: 200000, output: 65536 } },
  'glm-5.3': { name: 'GLM 5.3', limit: { context: 1048576, output: 65536 } },
};

const MODEL_53 = 'zai-coding-plan/glm-5.3';

function hasCodingPlanAuth() {
  try {
    const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
    const auth = JSON.parse(readFileSync(authPath, 'utf8'));
    return typeof auth?.['zai-coding-plan']?.key === 'string' && auth['zai-coding-plan'].key.length > 0;
  } catch {
    return false;
  }
}

function resolveModel(claudeModel) {
  if (!claudeModel) return DEFAULT_MODEL;
  const m = String(claudeModel).toLowerCase();
  if (m === 'glm-5.3') {
    if (hasCodingPlanAuth()) return MODEL_53;
    process.stderr.write('[agent-proxy] glm-5.3 requested but no zai-coding-plan key in opencode auth.json — falling back to glm-5.2\n');
    return 'zai-coding-plan/glm-5.2';
  }
  if (MODEL_MAP.has(m)) return MODEL_MAP.get(m);
  // claude aliases (opus/sonnet/haiku) resolve through the runner's
  // ANTHROPIC_DEFAULT_OPUS_MODEL when the factory set it.
  if (m === 'opus' || m === 'sonnet' || m === 'haiku') {
    const via = String(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || '').toLowerCase();
    if (via === 'glm-5.3') return resolveModel('glm-5.3');
    if (MODEL_MAP.has(via)) return MODEL_MAP.get(via);
    return DEFAULT_MODEL;
  }
  process.stderr.write(`[agent-proxy] unmapped claude model '${claudeModel}' — using ${DEFAULT_MODEL}\n`);
  return DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// argv parsing — accept the factory's claude surface, ignore the rest loudly.
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  '--model', '-m', '--effort', '--mcp-config', '--settings',
  '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools',
  '--cwd', '--session', '--resume', '--permission-mode', '--mode',
  '--output-format',
]);
const BOOL_FLAGS = new Set([
  '-p', '--print', '--bare', '--disable-slash-commands', '--strict-mcp-config',
  '--dangerously-skip-permissions', '--allow-main-worktree-yolo',
  '--verbose', '--forward-subagent-text', '--no-session-persistence',
]);

export function parseArgv(argv) {
  const out = { flags: new Set(), values: {}, ignored: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      out.values[a] = argv[++i];
    } else if (BOOL_FLAGS.has(a)) {
      out.flags.add(a);
    } else if (a === '--allowedTools'.toLowerCase() || a.startsWith('--')) {
      // Unknown flag: swallow an adjacent value heuristically? Too risky —
      // claude's flags we don't know are either bool or value; log and skip
      // just the flag. If a value follows and looks like a flag we keep going.
      out.ignored.push(a);
    } else {
      out.ignored.push(`positional:${a}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// E-S1 (stage-11 PREVENTIVE-HUNT Layer 3): stream-json translation.
//
// The runner spawns workers with `--output-format stream-json` and feeds the
// child's stdout to the repeated-tool-loop detector (claude-runner.mjs), the
// tail-events view and the token accounting — all of which parse CLAUDE
// stream-json lines ({"type":"assistant","message":{"content":[...]}}). opencode
// (1.18.18) has no claude-compatible stream mode, but `opencode run --format
// json` emits REAL structured events on stdout (verified live 2026-08-19):
//
//   {"type":"step_start","part":{"type":"step-start",...}}
//   {"type":"tool_use","part":{"type":"tool","tool":"read","callID":"...",
//                              "state":{"status":"completed","input":{...},...}}}
//   {"type":"text","part":{"type":"text","text":"...",...}}
//   {"type":"step_finish","part":{"reason":"stop"|"tool-calls",
//                              "tokens":{"input":N,"output":N,"cache":{"read":N}}}}
//
// This translator converts them line-by-line into the claude shapes those
// consumers already understand. Tool names keep opencode's native spelling
// (read/bash/edit/...) — the detector compares signatures, not names. A callID
// is emitted once: opencode may re-emit a part as its state advances
// (pending → completed), and the 12-repetition kill must count invocations,
// not state updates. step_finish tokens are accumulated and flushed as one
// claude `result` event with summed usage when the child closes (matches the
// claude CLI's terminal result event; omitted entirely when no step reported
// tokens so a dead child does not masquerade as a 0-token success).
// ----------------------------------------------------------------------------

export function createOpenCodeStreamTranslator() {
  let buffer = '';
  const seenCallIds = new Set();
  const usageTotals = { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  const line = obj => `${JSON.stringify(obj)}\n`;

  const handleEvent = (event) => {
    const part = event?.part;
    if (!part || typeof part !== 'object') return [];
    if (event.type === 'tool_use' && part.type === 'tool' && typeof part.tool === 'string') {
      const callId = typeof part.callID === 'string' && part.callID
        ? part.callID
        : `${part.tool}:${part.id ?? ''}`;
      if (seenCallIds.has(callId)) return [];
      seenCallIds.add(callId);
      return [line({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: callId,
            name: part.tool,
            input: part.state && typeof part.state.input === 'object' && part.state.input !== null
              ? part.state.input
              : {},
          }],
        },
      })];
    }
    if (event.type === 'text' && part.type === 'text' && typeof part.text === 'string') {
      return [line({ type: 'assistant', message: { content: [{ type: 'text', text: part.text }] } })];
    }
    if (event.type === 'step_finish' && part.tokens && typeof part.tokens === 'object') {
      usageTotals.input_tokens += Number(part.tokens.input) || 0;
      usageTotals.cache_read_input_tokens += Number(part.tokens.cache?.read) || 0;
      usageTotals.output_tokens += Number(part.tokens.output) || 0;
    }
    return [];
  };

  return {
    // Feed raw stdout chunks; returns translated claude stream-json lines ('' when none).
    push(chunk) {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      let out = '';
      for (const raw of lines) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }
        for (const translated of handleEvent(event)) out += translated;
      }
      return out;
    },
    // Flush at child close: any trailing unterminated JSON, then the result event.
    finish() {
      let out = '';
      const rest = buffer.trim();
      buffer = '';
      if (rest) {
        try { for (const translated of handleEvent(JSON.parse(rest))) out += translated; } catch { /* truncated tail — drop */ }
      }
      if (usageTotals.input_tokens || usageTotals.output_tokens || usageTotals.cache_read_input_tokens) {
        out += line({ type: 'result', subtype: 'success', is_error: false, usage: usageTotals });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// MCP config translation: { mcpServers: { saga: { command, args, env } } }
//                     →   { mcp: { saga: { type: "local", command: [...], ... } } }
// The saga MCP boot (node + better-sqlite3) can exceed opencode's 5s default
// MCP timeout on cold start — raise it explicitly.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Worker instructions for the opencode backend. Factory briefs document saga
// MCP tools with the claude spelling (mcp__saga__worker_done); opencode
// exposes them as saga_worker_done. Card-5 of the opencode-val run burned
// several turns discovering this — the note below is appended to every
// worker's system prompt through the generated config.
// ---------------------------------------------------------------------------

function writeBridgeInstructions(cfgDir) {
  const p = path.join(cfgDir, 'saga-opencode-bridge.md');
  writeFileSync(p, [
    '# Saga/OpenCode bridge notes',
    '',
    '- Saga MCP tools are exposed here WITHOUT the `mcp__saga__` prefix:',
    '  call `saga_worker_done`, `saga_artifact_create`, `saga_artifact_list`,',
    '  `saga_trace_add`, `saga_trace_list`, `saga_task_get`, `saga_product_submit`,',
    '  `saga_note_list`, etc. If a brief mentions `mcp__saga__<tool>`, the actual',
    '  callable name is `saga_<tool>`.',
    '- Complete work by CALLING the saga tools (product_submit / worker_done).',
    '  Never write status documents that describe tool calls instead of making them.',
    '',
  ].join('\n'));
  return p;
}

function buildOpenCodeConfig(mcpConfigPath, resolvedModel, instructionsFile) {
  const cfg = { $schema: 'https://opencode.ai/config.json' };
  if (instructionsFile) cfg.instructions = [instructionsFile];
  const gapModel = Object.entries(REGISTRY_GAP_MODELS)
    .find(([id]) => resolvedModel === `zai-coding-plan/${id}`);
  if (gapModel) {
    // Documented extension pattern: add the model to the BUILT-IN provider.
    // Auth comes from auth.json (opencode auth login) — no key here.
    cfg.provider = {
      'zai-coding-plan': {
        models: { [gapModel[0]]: gapModel[1] },
      },
    };
  }
  if (mcpConfigPath) {
    const raw = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
    const servers = raw && typeof raw === 'object' ? raw.mcpServers || {} : {};
    const mcp = {};
    for (const [name, s] of Object.entries(servers)) {
      if (!s || typeof s.command !== 'string') continue;
      mcp[name] = {
        type: 'local',
        command: [s.command, ...(Array.isArray(s.args) ? s.args : [])],
        enabled: true,
        timeout: Number(process.env.SAGA_PROXY_MCP_TIMEOUT_MS || 60000),
        ...(s.env && typeof s.env === 'object' ? { environment: s.env } : {}),
      };
    }
    if (Object.keys(mcp).length) cfg.mcp = mcp;
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Permissions: translate claude --disallowedTools into opencode deny rules.
// opencode names MCP tools differently from claude (no mcp__server__tool
// namespace guarantee), so deny under BOTH spellings. Best-effort only — the
// saga MCP gateway enforces the real authority (pretooluse-projection.ts:
// "Treat CLI denial as an optimization, not authority").
// ---------------------------------------------------------------------------

function buildPermissionJson(disallowed) {
  // Headless mode: allow everything the session asks for (the claude backend
  // runs the factory under bypassPermissions too), then layer explicit denials
  // on top. Object syntax is order-sensitive in opencode — "last matching rule
  // wins" — so the "*" allow comes first, denies last.
  const perm = { '*': 'allow' };
  if (disallowed) {
    const list = String(disallowed).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    for (const tool of list) {
      perm[tool] = 'deny';
      if (tool.startsWith('mcp__')) {
        perm[tool.replace(/^mcp__/, '').replace(/__/g, '_')] = 'deny';
      }
    }
  }
  return JSON.stringify(perm);
}

// ---------------------------------------------------------------------------
// Hook plugin materialization. When the runner passes --settings with
// PostToolUse hooks (the structured-context hook), copy the plugin port next
// to opencode's global plugin dir. The plugin is env-gated (no-op without
// SAGA_STRUCTURED_CONTEXT_HOOK_SOURCE_B64), so it is safe for every other
// opencode invocation on this machine.
// ---------------------------------------------------------------------------

function ensureHookPlugin(parsedSettings) {
  let hasPostToolHook = false;
  try {
    const s = JSON.parse(parsedSettings);
    const hooks = s && s.hooks;
    hasPostToolHook = Boolean(hooks && (hooks.PostToolUse || hooks.PostToolUseFailure));
  } catch {
    return false;
  }
  if (!hasPostToolHook) return false;
  const dir = path.join(os.homedir(), '.config', 'opencode', 'plugins');
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'saga-structured-context.js');
  const src = path.join(here, 'saga-structured-context.plugin.js');
  writeFileSync(dest, readFileSync(src));
  return true;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (parsed.ignored.length) {
    process.stderr.write(`[agent-proxy] ignored claude args: ${parsed.ignored.join(' ')}\n`);
  }
  if (parsed.values['--effort']) {
    process.stderr.write(`[agent-proxy] --effort ${parsed.values['--effort']} ignored on the opencode backend\n`);
  }

  const model = resolveModel(parsed.values['--model'] || parsed.values['-m']);
  const streamJson = parsed.values['--output-format'] === 'stream-json';

  // Config file (MCP + bridge instructions) → OPENCODE_CONFIG.
  const env = { ...process.env };
  const mcpPath = parsed.values['--mcp-config'];
  if (mcpPath) {
    const cfgDir = path.join(os.tmpdir(), `saga-opencode-${process.pid}`);
    mkdirSync(cfgDir, { recursive: true });
    const instructionsFile = writeBridgeInstructions(cfgDir);
    const cfgPath = path.join(cfgDir, 'opencode.json');
    writeFileSync(cfgPath, JSON.stringify(buildOpenCodeConfig(mcpPath, model, instructionsFile)));
    env.OPENCODE_CONFIG = cfgPath;
  }

  // NOTE: --auto is deliberately NOT used — with a stdin prompt opencode exits
  // silently without answering (verified 1.18.18). Headless permissions are
  // granted through OPENCODE_PERMISSION instead.
  env.OPENCODE_PERMISSION = buildPermissionJson(parsed.values['--disallowedTools'] || parsed.values['--disallowed-tools']);

  if (parsed.values['--settings']) {
    ensureHookPlugin(parsed.values['--settings']);
  }

  // Read the worker prompt fully from stdin (claude -p contract), then pipe it
  // into opencode run. opencode reads the prompt from stdin when no positional
  // message is given (verified 2026-08-18, opencode 1.18.18).
  const stdin = await new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks)));
    process.stdin.resume();
  });
  process.stderr.write(`[agent-proxy] opencode backend, model=${model}, format=${streamJson ? 'stream-json (translated)' : 'raw passthrough'}, prompt=${stdin.length} bytes\n`);

  const ocArgs = ['run', '--model', model];
  if (streamJson) ocArgs.push('--format', 'json');
  if (process.env.SAGA_RUN_ID) ocArgs.push('--title', process.env.SAGA_RUN_ID);

  const bin = resolveOpenCodeBin();
  // stream-json mode captures opencode's stdout (--format json) and translates
  // it live; every other mode inherits stdout unchanged, byte-identical to the
  // pre-E-S1 shim (ANSI TUI passthrough).
  let translator = null;
  if (streamJson) translator = createOpenCodeStreamTranslator();
  const childStdout = translator ? 'pipe' : 'inherit';
  const child = spawn(bin.cmd, bin.shell ? [ocArgs.join(' ')] : ocArgs, { stdio: ['pipe', childStdout, 'inherit'], env, shell: bin.shell });
  if (translator) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const out = translator.push(chunk);
      if (out) process.stdout.write(out);
    });
  }

  const fwd = (sig) => () => { try { child.kill(sig); } catch { /* already gone */ } };
  process.on('SIGTERM', fwd('SIGTERM'));
  process.on('SIGINT', fwd('SIGINT'));

  child.stdin.on('error', () => { /* opencode may exit early; close is handled below */ });
  child.stdin.end(stdin);

  child.on('error', (e) => {
    process.stderr.write(`[agent-proxy] failed to spawn opencode: ${e.message}\n`);
    process.exit(127);
  });
  child.on('close', (code, signal) => {
    if (translator) {
      try {
        const tail = translator.finish();
        if (tail) process.stdout.write(tail);
      } catch { /* translation must never mask the exit code */ }
    }
    process.exit(code ?? (signal ? 137 : 0));
  });
}

// Run only when executed as a CLI (node claude-shim.mjs ...), not when imported
// by tests for parseArgv/createOpenCodeStreamTranslator — main() awaits stdin
// 'end', which would hang an importing test process forever.
const invokedAsCli = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  main().catch((e) => {
    process.stderr.write(`[agent-proxy] fatal: ${e && e.stack || e}\n`);
    process.exit(1);
  });
}
