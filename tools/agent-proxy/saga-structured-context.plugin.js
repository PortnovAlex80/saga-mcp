// OpenCode plugin — port of the saga factory's PostToolUse structured-context
// hook (tracker-view/structured-context-hook.mjs).
//
// The claude backend wires PostToolUse/PostToolUseFailure command hooks that
// emit `{ hookSpecificOutput: { additionalContext } }`. OpenCode has no
// command-hook surface; the equivalent is this plugin on `tool.execute.after`,
// which:
//   1. decodes the runner-transported hook source
//      (SAGA_STRUCTURED_CONTEXT_HOOK_SOURCE_B64 — the exact same hook module,
//      base64'd by claude-runner to survive Windows path encoding);
//   2. invokes it as a child process with a synthesized claude-style stdin
//      payload (hook_event_name/tool_name/tool_response), so ALL hook
//      semantics — projection fencing (executionId), state-version dedup,
//      budgets, sanitization — stay in the one canonical hook file;
//   3. injects the returned additionalContext into the worker's session with
//      `session.prompt({ noReply: true })` (documented plugin mechanism for
//      adding context without triggering a reply).
//
// Env-gated no-op: without SAGA_STRUCTURED_CONTEXT_HOOK_SOURCE_B64 (i.e. any
// non-factory opencode use) the plugin does nothing. All failures are
// swallowed — the hook must never break the worker.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let hookFile = null;

function ensureHookFile() {
  if (hookFile !== null) return hookFile;
  hookFile = false;
  const b64 = process.env.SAGA_STRUCTURED_CONTEXT_HOOK_SOURCE_B64;
  if (!b64) return hookFile;
  try {
    const src = Buffer.from(b64, 'base64').toString('utf8');
    hookFile = path.join(tmpdir(), `saga-ctx-hook-${process.pid}.mjs`);
    writeFileSync(hookFile, src);
  } catch {
    hookFile = false;
  }
  return hookFile;
}

function looksFailed(output) {
  if (!output || typeof output !== 'object') return false;
  if (output.error !== undefined && output.error !== null) return true;
  if (output.status === 'error') return true;
  return false;
}

function sessionIdOf(input) {
  if (!input || typeof input !== 'object') return null;
  return input.sessionID ?? input.sessionId
    ?? input.session?.id ?? input.info?.sessionID ?? input.info?.sessionId ?? null;
}

export const SagaStructuredContext = async ({ client }) => {
  return {
    'tool.execute.after': async (input, output) => {
      try {
        const hook = ensureHookFile();
        if (!hook) return;
        const payload = JSON.stringify({
          hook_event_name: looksFailed(output) ? 'PostToolUseFailure' : 'PostToolUse',
          tool_name: typeof input?.tool === 'string' ? input.tool : '',
          tool_response: output && typeof output === 'object' ? output : {},
        });
        const res = spawnSync('node', [hook], { input: payload, encoding: 'utf8', timeout: 15000 });
        if (!res || res.status !== 0 || !res.stdout) return;
        let parsed;
        try { parsed = JSON.parse(res.stdout); } catch { return; }
        const ctx = parsed?.hookSpecificOutput?.additionalContext;
        if (typeof ctx !== 'string' || !ctx.trim()) return;
        const sessionId = sessionIdOf(input);
        if (!sessionId) return;
        await client.session.prompt({
          path: { id: sessionId },
          body: { noReply: true, parts: [{ type: 'text', text: ctx }] },
        });
      } catch {
        // The hook is advisory steering; never fail the tool loop.
      }
    },
  };
};
