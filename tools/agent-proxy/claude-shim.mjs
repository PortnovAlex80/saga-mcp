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
//
// PROVIDER-RETRY: the child runs over pipes with a live tee (capture for the
// retry discriminator, byte-identical forwarding for the runner), and deaths
// that match a conservative transient class (429/5xx/socket, or a provably
// pre-first-tool death) climb a jittered exponential ladder inside the shim
// with a stdout heartbeat during sleeps — see the PROVIDER-RETRY block below
// and docs/architecture/PROVIDER-RETRY-DESIGN.md.

import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the opencode executable. On Windows a bare spawn('opencode') hits
// npm's .cmd shim, which node's spawn (no shell) cannot execute — point at
// the real bin inside the global opencode-ai package instead.
//
// SAGA_PROXY_OPENCODE_PATH follows the runner's SAGA_REAL_CLAUDE_PATH
// convention: a compound value ("node D:/tools/fake-opencode.mjs") splits on
// spaces into executable + fixed prefix args. Single-path values keep their
// exact previous behavior; the compound form lets tests (and exotic hosts)
// route the shim at a script-backed bin without a shell.
function resolveOpenCodeBin() {
  const custom = process.env.SAGA_PROXY_OPENCODE_PATH;
  if (custom) {
    const parts = custom.split(' ').filter(Boolean);
    if (parts.length > 1) return { cmd: parts[0], argsPrefix: parts.slice(1), shell: false };
    const p = parts[0];
    // A .js/.mjs/.cjs override is a node script (wrapper scripts, and the
    // hermetic shim tests) — run it with the current interpreter, args
    // appended after the script path. Any other value is trusted as the
    // binary path: a typo must fail loudly at spawn, not silently fall back
    // to the real opencode.
    if (/\.(mjs|cjs|js)$/i.test(p)) return { cmd: process.execPath, argsPrefix: [p], shell: false };
    return { cmd: p, argsPrefix: [], shell: false };
  }
  if (process.platform === 'win32') {
    try {
      const prefix = execSync('npm config get prefix', { encoding: 'utf8' }).trim();
      const exe = path.join(prefix, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
      if (existsSync(exe)) return { cmd: exe, argsPrefix: [], shell: false };
    } catch { /* fall through */ }
    return { cmd: 'opencode', argsPrefix: [], shell: true };
  }
  return { cmd: 'opencode', argsPrefix: [], shell: false };
}

// ---------------------------------------------------------------------------
// Session-directory pinning (worker disorientation fix).
//
// opencode 1.18.18 resolves the session base directory as
//   path.resolve(process.env.PWD ?? process.cwd())
// (Cli.run handler; verified in the 2026-08-18 disorient-lab: spawning with
// cwd=<product> but an inherited env.PWD=<factory root> anchors the session
// at the factory root — docs/factory-run/stage11/DISORIENTATION-INVESTIGATION.md).
// The factory process tree inherits PWD from the operator's shell at the
// factory root, so worker sessions resolved relative desk paths against the
// wrong tree (72% of sessions, ~1 min self-recovery tax each).
//
// The shim therefore pins the session directory explicitly:
//   - the declared-but-previously-swallowed `--cwd` claude flag is honored,
//   - otherwise the shim's own process cwd (the runner's spawn cwd) is used,
//   - the value is passed to opencode as `--dir` (documented `opencode run`
//     pinning flag; opencode chdirs there before creating the instance),
//   - env.PWD is overridden to the same value so no code path can
//     re-inherit the stale factory-root PWD,
//   - the opencode child is spawned with an explicit cwd.
// ---------------------------------------------------------------------------

function buildSessionPinning(parsedValues, fallbackCwd) {
  const raw = parsedValues && parsedValues['--cwd'];
  // Relative --cwd values resolve against the shim's cwd (the runner's spawn
  // cwd), matching how the runner would have interpreted them; absolute
  // values pass through path.resolve unchanged.
  const sessionDir = raw
    ? path.resolve(fallbackCwd, String(raw))
    : path.resolve(fallbackCwd);
  return {
    sessionDir,
    dirArgs: ['--dir', sessionDir],
    envPatch: { PWD: sessionDir },
    spawnCwd: sessionDir,
    inheritedPwdMismatch(candidate) {
      if (!candidate) return false;
      try {
        return path.resolve(String(candidate)) !== sessionDir;
      } catch {
        return false;
      }
    },
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Model registry mapping (opencode zai-coding-plan provider). glm-5.3-flash
// is natively in the opencode registry (rechecked 2026-08-27). An explicit
// but UNMAPPED model now fails closed (exit 86) - it never silently serves
// the default; the default applies only when no model is passed at all.
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
  ['glm-5.3-flash', 'zai-coding-plan/glm-5.3-flash'],
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
  // Fail closed: an explicit model the registry does not know is a
  // misconfigured pin. Serving a DIFFERENT model silently would mislabel
  // every kernel receipt - observed 2026-08-27: every glm-5.3-flash request
  // of a whole qualification series degraded to the glm-4.7 default and only
  // the executor-side opencode session records exposed it. The stderr note
  // below was invisible to the channel then; the exit is not negotiable now.
  process.stderr.write(`[agent-proxy] unmapped model '${claudeModel}' - REFUSING to serve ${DEFAULT_MODEL} instead (fail-closed; add the model to MODEL_MAP)\n`);
  process.exit(86);
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
// PROVIDER-RETRY (docs/architecture/PROVIDER-RETRY-DESIGN.md).
//
// The shim owns the worker's life cycle, so transient provider deaths
// (429/5xx storms, dropped sockets) are retried HERE — the factory never
// learns about the transient (zero factory changes, zero recovery-budget
// spend). Preconditions per the design:
//   * stdio pipes + live tee (the child's output is captured for the
//     discriminator while being forwarded byte-for-byte, so the runner keeps
//     seeing the exact stream it sees today);
//   * a heartbeat on stdout during every retry sleep (claude-runner's
//     progress_at is throttled to 30s and STUCK_SILENCE_MS is 10min — silence
//     accumulates ACROSS attempts, so an unheartbeated ladder would be
//     reaped mid-climb);
//   * a conservative discriminator (below) with a hard NEVER on
//     saga_worker_done — retrying a worker that completed its card would
//     double-complete it.
//
// Accounting is log-visible only: retry notes and the summary go to stderr,
// which the runner tees into the worker JSONL (/api/worker/tail).
// ----------------------------------------------------------------------------

export const MAX_ATTEMPTS_PRE_TOOL = 8;   // full ladder: side-effect-free deaths
export const MAX_ATTEMPTS_POST_TOOL = 3;  // reduced ladder (design: 2-3)
export const RETRY_JITTER_MAX_MS = 250;   // de-synchronizes parallel workers
export const HEARTBEAT_INTERVAL_MS = 20_000; // < the runner's 30s progress throttle

// How much captured output the text discriminator inspects (tail = proximate
// cause of death; a 429 the backend recovered from mid-run must not trigger a
// retry of a finished run) and how much is kept at all (rolling window, for
// the marker/done scans on very long ANSI outputs).
const CAPTURE_TAIL_BYTES = 16 * 1024;
const CAPTURE_WINDOW_BYTES = 2 * 1024 * 1024;

// Retryable provider-error classes, each alternative documented:
//   429 / too many requests     — provider rate limiting the plan
//   rate.?limit                 — same, in prose ("rate limit", "rate-limit")
//   overloaded                  — provider capacity (Anthropic-style wording)
//   status[: ]5\d\d             — any 5xx surfaced as "status 503" / "status:503"
//                                 (ONE separator char; "status: 503" with both
//                                 colon and space deliberately does NOT match —
//                                 keep the class narrow, miss > false-retry)
//   socket connection was closed— AI_APICallError transport death (observed ×5
//                                 in the live opencode private logs)
//   ECONNRESET / ETIMEDOUT      — node fetch/socket errors
//   fetch failed                — undici's generic transport failure
export const RETRYABLE_ERROR_RE = /429|rate.?limit|overloaded|too many requests|status[: ]5\d\d|socket connection was closed|ECONNRESET|ETIMEDOUT|fetch failed/i;

// A provider's DEFINITIVE request rejection — checked BEFORE any retryable
// text and before the pre/post-tool-death catch-alls. Elite-3 evidence
// (task13-evidence): the provider answered `400 / "Prompt exceeds max
// length" / "isRetryable":false` while the old classifier retried the SAME
// oversized request through the full 1s..64s ×8 ladder on every spawn (~3
// min per execution), then supervision respawned a new execution with the
// same prompt — burning the recovery budget on infrastructure. A permanent
// rejection is not transient: fail fast, let the typed factory recovery own
// the outcome. Statuses: 400 malformed/oversized request, 413 payload too
// large, 422 unprocessable — 429/408 stay with the retryable class above.
export const PROVIDER_REJECTED_RE = /Prompt exceeds max length|request too large|payload too large|"isRetryable"\s*:\s*false|"statusCode"\s*:\s*(400|413|422)|\bstatus(code)?[: =]+(400|413|422)\b/i;

// A "tool ran" marker in the captured child output:
//   ⚙                    — opencode TUI renders tool calls as `⚙ saga_<tool> {json}`
//                          lines on stdout (the factory's failure-log parses these)
//   "type":"tool_use"    — opencode `run --format json` stream events (the es1
//                          stream-json translation composes with this retry:
//                          its translator consumes the same captured stream)
const TOOL_MARKER_RE = /⚙|"type"\s*:\s*"tool_use"/;

// Completion guard — retrying past any of these would double-complete the card:
//   saga_worker_done       — the worker called its completion tool (any spelling:
//                            plain text, ⚙ render, or stream-json input)
//   "type":"result"        — a terminal claude-format result event (what the es1
//                            translation emits at child close)
const WORKER_DONE_RE = /saga_worker_done|"type"\s*:\s*"result"/;

export function computeLadderDelayMs(n) {
  // min(2^(n-1), 256s): 1,2,4,8,16,32,64,128s; capped at 256s so a future
  // raise of MAX_ATTEMPTS_PRE_TOOL keeps the total sleep budget bounded.
  return Math.min(2 ** (n - 1), 256) * 1000;
}

export function nextRetryDelayMs(n, rand = Math.random) {
  // + uniform jitter 0..250ms. Fixed steps synchronize parallel workers on the
  // same quota (the operator's ban concern); jitter de-synchronizes them.
  return computeLadderDelayMs(n) + Math.floor(rand() * (RETRY_JITTER_MAX_MS + 1));
}

function tailText(text, max) {
  return text.length > max ? text.slice(-max) : text;
}

// Conservative death classifier. Verdicts:
//   worker-done     NEVER retry — completion is already recorded upstream
//   text            retry — retryable provider error in the CURRENT attempt's
//                          output tail (per-attempt, so a successful attempt
//                          is never re-run on residue from an earlier one)
//   pre-tool-death  retry — exit≠0/signal AND no tool marker anywhere in the
//                          capture: provably died before its first tool, so the
//                          attempt was side-effect-free → full ladder
//   post-tool-death retry — death after at least one tool ran. The design
//                          sanctions this with the REDUCED ladder only ("the
//                          same risk class the factory recovery already
//                          accepts" — its 300ms respawn re-runs such cards);
//                          without a retryable text this is still gated to
//                          MAX_ATTEMPTS_POST_TOOL attempts, never the full 8
//   clean           no retry — exit 0 with no retryable text
//
// stdout/stderr are the FULL accumulated capture (marker/done scans — markers
// from any earlier attempt keep the ladder reduced, conservative); the
// optional attemptStdout/attemptStderr slices scope the text match to the
// attempt that just closed.
export function classifyFailure({ exitCode, signal, stdout, stderr, attemptStdout, attemptStderr }) {
  const out = String(stdout || '');
  const err = String(stderr || '');
  if (WORKER_DONE_RE.test(out) || WORKER_DONE_RE.test(err)) {
    return { retry: false, class: 'worker-done', postTool: true, detail: 'saga_worker_done/result event seen' };
  }
  const textOut = attemptStdout !== undefined ? String(attemptStdout) : out;
  const textErr = attemptStderr !== undefined ? String(attemptStderr) : err;
  const tail = `${tailText(textErr, CAPTURE_TAIL_BYTES)}\n${tailText(textOut, CAPTURE_TAIL_BYTES)}`;
  // Definitive provider rejection beats everything transient: the request
  // itself is unacceptable and a retry re-sends the same bytes.
  const rejected = PROVIDER_REJECTED_RE.test(tail);
  // Take the LAST match in the tail and report its whole line: the proximate
  // cause of this death, in operator-readable form for the retry summary.
  let match = null;
  for (const m of tail.matchAll(new RegExp(RETRYABLE_ERROR_RE.source, `${RETRYABLE_ERROR_RE.flags}g`))) match = m;
  // Markers accumulate across attempts (capture is not reset): if ANY attempt
  // ran a tool, every later attempt is treated as post-tool — conservative.
  const postTool = TOOL_MARKER_RE.test(out) || TOOL_MARKER_RE.test(err);
  if (rejected) {
    const rejectedLine = (() => {
      const idx = tail.search(PROVIDER_REJECTED_RE);
      if (idx < 0) return '';
      const lineStart = tail.lastIndexOf('\n', idx) + 1;
      const lineEndRaw = tail.indexOf('\n', idx);
      const lineEnd = lineEndRaw === -1 ? tail.length : lineEndRaw;
      return tail.slice(lineStart, lineEnd).trim().slice(0, 200);
    })();
    return {
      retry: false,
      class: 'provider-rejected',
      postTool,
      detail: rejectedLine || 'provider definitively rejected the request (non-retryable)',
    };
  }
  if (match) {
    const lineStart = tail.lastIndexOf('\n', match.index) + 1;
    const lineEndRaw = tail.indexOf('\n', match.index);
    const lineEnd = lineEndRaw === -1 ? tail.length : lineEndRaw;
    const detail = tail.slice(lineStart, lineEnd).trim().slice(0, 200);
    return { retry: true, class: 'text', postTool, detail: detail || match[0] };
  }
  const died = (exitCode !== null && exitCode !== undefined && exitCode !== 0) || Boolean(signal);
  if (died && !postTool) return { retry: true, class: 'pre-tool-death', postTool: false };
  if (died) return { retry: true, class: 'post-tool-death', postTool: true };
  return { retry: false, class: 'clean', postTool: false };
}

// Sleep totalMs while keeping the runner's progress_at fresh: one heartbeat
// line on stdout per HEARTBEAT_INTERVAL_MS (the runner throttles progress to
// 30s and reaps silence at 10min — silence accumulates across attempts).
// Injectable clock/sleep/writers for tests. Resolves true when aborted early.
export async function sleepWithRetryHeartbeat(totalMs, { attempt, className }, io = {}) {
  const now = io.now || Date.now;
  const sleepFn = io.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const out = io.stdout || process.stdout;
  const shouldAbort = io.shouldAbort || (() => false);
  const start = now();
  for (;;) {
    const remaining = totalMs - (now() - start);
    if (remaining <= 0) return false;
    await sleepFn(Math.min(remaining, HEARTBEAT_INTERVAL_MS));
    if (shouldAbort()) return true;
    const elapsed = now() - start;
    if (elapsed >= totalMs) return false;
    const secs = Math.ceil((totalMs - elapsed) / 1000);
    out.write(`[agent-proxy] retry #${attempt} in ${secs}s (${className}) — heartbeat\n`);
  }
}

// Rolling capture of one stream: keeps the last CAPTURE_WINDOW_BYTES for the
// discriminator while the tee forwards every chunk live. markAttempt() draws
// the boundary the text discriminator scopes itself to.
class OutputCapture {
  constructor() {
    this.chunks = [];
    this.bytes = 0;
    this.mark = 0;
  }
  append(chunk) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.chunks.push(b);
    this.bytes += b.length;
    while (this.bytes > CAPTURE_WINDOW_BYTES && this.chunks.length > 1) {
      this.bytes -= this.chunks[0].length;
      this.chunks.shift();
      if (this.mark > 0) this.mark -= 1;
    }
  }
  markAttempt() {
    this.mark = this.chunks.length;
  }
  text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
  attemptText() {
    return Buffer.concat(this.chunks.slice(this.mark)).toString('utf8');
  }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgv(argv);
  if (parsed.ignored.length) {
    process.stderr.write(`[agent-proxy] ignored claude args: ${parsed.ignored.join(' ')}\n`);
  }
  if (parsed.values['--effort']) {
    process.stderr.write(`[agent-proxy] --effort ${parsed.values['--effort']} ignored on the opencode backend\n`);
  }

  // Session-directory pinning: --cwd (claude contract) or the shim's cwd.
  const pinning = buildSessionPinning(parsed.values, process.cwd());
  if (pinning.inheritedPwdMismatch(process.env.PWD)) {
    process.stderr.write(
      `[agent-proxy] overriding inherited PWD=${process.env.PWD} -> ${pinning.sessionDir} `
      + `(opencode resolves the session base from env.PWD; stale values anchored sessions at the factory root)\n`);
  }

  const model = resolveModel(parsed.values['--model'] || parsed.values['-m']);
  const streamJson = parsed.values['--output-format'] === 'stream-json';

  // Config file (MCP + bridge instructions) → OPENCODE_CONFIG.
  const env = { ...process.env, ...pinning.envPatch };
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

  const ocArgs = ['run', '--model', model, ...pinning.dirArgs];
  if (streamJson) ocArgs.push('--format', 'json');
  if (process.env.SAGA_RUN_ID) ocArgs.push('--title', process.env.SAGA_RUN_ID);

  const bin = resolveOpenCodeBin();
  // Stream-json translation (es1) composes with the retry ladder
  // (provider-retry): the translator sits between the capture and the
  // forward — append to stdoutCapture first, then hand the chunk to the
  // translator instead of the raw write (the composition rule this branch's
  // own base comment prescribed). The translator is created per attempt
  // inside runOnce: a retried attempt is a fresh opencode session, and
  // half-translated state must not leak across attempts.
  const childArgs = [...(bin.argsPrefix || []), ...(bin.shell ? [ocArgs.join(' ')] : ocArgs)];

  // PROVIDER-RETRY loop. stdio is pipes+tee (was inherit): every child chunk
  // is captured for the discriminator and forwarded live, so the runner keeps
  // seeing the exact stdout/stderr stream it saw before (byte-identical when
  // no retry fires — shim notes go to stderr only). Composition with the es1
  // stream-json translation (not merged into this base): its translator sits
  // between the capture and the forward — append to stdoutCapture first, then
  // hand the chunk to the translator instead of the raw write.
  const stdoutCapture = new OutputCapture();
  const stderrCapture = new OutputCapture();
  let aborted = false;      // a forwarded SIGTERM/SIGINT must break the ladder
  let currentChild = null;  // kill target for forwarded signals
  const fwd = (sig) => () => {
    aborted = true;
    try { currentChild?.kill(sig); } catch { /* already gone */ }
  };
  process.on('SIGTERM', fwd('SIGTERM'));
  process.on('SIGINT', fwd('SIGINT'));

  const runOnce = () => new Promise((resolve, reject) => {
    stdoutCapture.markAttempt();
    stderrCapture.markAttempt();
    const translator = streamJson ? createOpenCodeStreamTranslator() : null;
    const child = spawn(bin.cmd, childArgs, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: pinning.spawnCwd, shell: bin.shell });
    currentChild = child;
    child.stdin.on('error', () => { /* opencode may exit early; close is handled below */ });
    child.stdin.end(stdin);
    // setEncoding keeps multi-byte characters intact across chunk boundaries;
    // OutputCapture.append accepts strings and re-encodes byte-accurately.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutCapture.append(chunk);
      if (translator) {
        const out = translator.push(chunk);
        if (out) process.stdout.write(out);
      } else {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on('data', (chunk) => { stderrCapture.append(chunk); process.stderr.write(chunk); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (translator) {
        try {
          const tail = translator.finish();
          if (tail) process.stdout.write(tail);
        } catch { /* translation must never mask the exit code */ }
      }
      resolve({ code, signal });
    });
  });

  // The tee turned the runner streams from inherited FDs into user-space
  // writes; on POSIX those are async — drain both pipes before ANY exit so
  // the runner never loses the tail of the stream.
  const flushStreams = () => new Promise((resolve) => {
    let pending = 2;
    const done = () => { pending -= 1; if (pending === 0) resolve(); };
    process.stdout.write('', done);
    process.stderr.write('', done);
  });

let attempt = 0;
let lastCode = null;
let lastSignal = null;
const classes = [];
for (;;) {
  attempt += 1;
  let res;
  try {
    res = await runOnce();
  } catch (e) {
    // Spawn failure is a wiring error, not a provider transient — never retried.
    process.stderr.write(`[agent-proxy] failed to spawn opencode: ${e.message}\n`);
    await flushStreams();
    process.exit(127);
  }
  lastCode = res.code;
  lastSignal = res.signal;
  if (aborted) break; // the runner/operator stopped us — do not climb further

  const verdict = classifyFailure({
    exitCode: res.code,
    signal: res.signal,
    stdout: stdoutCapture.text(),
    stderr: stderrCapture.text(),
    attemptStdout: stdoutCapture.attemptText(),
    attemptStderr: stderrCapture.attemptText(),
  });
  classes.push(verdict.detail ? `${verdict.class}:${verdict.detail}` : verdict.class);
  if (!verdict.retry) break;

  const maxAttempts = verdict.postTool ? MAX_ATTEMPTS_POST_TOOL : MAX_ATTEMPTS_PRE_TOOL;
  if (attempt >= maxAttempts) break;

  const delayMs = nextRetryDelayMs(attempt);
  const className = verdict.detail ? `${verdict.class}:${verdict.detail}` : verdict.class;
  process.stderr.write(
    `[agent-proxy] attempt ${attempt} failed (exit=${res.code ?? `signal:${res.signal}`}, `
    + `class=${verdict.class}${verdict.detail ? ` "${verdict.detail}"` : ''}, ladder=${verdict.postTool ? 'reduced' : 'full'}) `
    + `— retrying in ${Math.round(delayMs / 100) / 10}s (jitter ≤${RETRY_JITTER_MAX_MS}ms)\n`,
  );
  const abortedWhileSleeping = await sleepWithRetryHeartbeat(delayMs, { attempt, className }, { shouldAbort: () => aborted });
  if (abortedWhileSleeping || aborted) break;
}

process.stderr.write(`[agent-proxy] retry summary: ${attempt} attempts, classes seen: ${classes.join(', ')}\n`);
await flushStreams();
process.exit(lastCode ?? (lastSignal ? 137 : 0));
}

// Entry guard: run only when executed as a script (`node claude-shim.mjs`),
// so tests can import the pure helpers (parseArgv/buildSessionPinning/
// resolveOpenCodeBin/createOpenCodeStreamTranslator and the provider-retry
// units) without triggering the stdin-prompt pipeline.
const invokedAsCli = (() => {
  try {
    return Boolean(process.argv[1])
      && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

export { resolveOpenCodeBin, buildSessionPinning };

if (invokedAsCli) {
  main().catch((e) => {
    process.stderr.write(`[agent-proxy] fatal: ${e && e.stack || e}\n`);
    process.exit(1);
  });
}
