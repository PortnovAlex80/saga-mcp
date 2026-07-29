#!/usr/bin/env node
// W5-A5 — Structured agent context hook (replaces tracker-reminder.mjs).
//
// Reads a STRUCTURED execution-scoped agent-assistance.json projection instead
// of parsing Markdown checkboxes (C027 violation in the legacy hook). The
// current projection is Flow-node scoped; a durable inner NodeProtocol cursor
// can later replace it with a finer step projection without changing the hook.
//
// Contract notes (consumes package data; no Markdown parsing here):
//
//   The runner pins the exact execution-scoped projection path via
//   SAGA_AGENT_ASSISTANCE_PATH. A package projection carries one bounded
//   assistance event list:
//
//     {
//       "schemaVersion": "saga3.agent-assistance-projection.v1",
//       "stateVersion":  "<hash of execution scope + package definition>",
//       "executionId":   "<fencing token; cross-execution events are rejected>",
//       "mode":          "<compact|guided|intensive>",
//       "events": [
//         { "event": "<post-tool-success|post-tool-error|...>",
//           "blocks": [
//             { "kind": "<goal|current-step|next-action|resource-path|...>",
//               "content": "<bounded human-readable text>" }
//           ] }
//       ]
//     }
//
//   This hook is GENERIC and PACKAGE-CONFIGURED (C032): it switches on NO
//   module/task/stage name. All content comes from the pinned JSON. It never
//   scans docs/ or resolves paths by convention — only the exact env path is
//   read (fail-closed, §13.5).
//
// Bounding + dedup (C033):
//   - The message is bounded by a per-invocation character budget
//     (SAGA_AGENT_ASSISTANCE_BUDGET_CHARS, default 4000). Each block is
//     individually capped (default 800 chars); over-budget blocks are
//     truncated with an explicit truncation marker so the model can see it.
//   - Repeated invocations with the same stateVersion emit an empty
//     additionalContext (dedup). The state version is compared to the last
//     version this hook emitted, persisted at a sidecar file alongside the
//     projection. This bounds repeated-state noise across many tool calls
//     (§10.9/§10.10 — full content is not repeated after every tool call).
//
// Output: `{ "hookSpecificOutput": { "hookEventName": "...",
// "additionalContext": "<bounded structured context>" } }` on first sight of
// a new state version; `{}` when deduped, missing, malformed, or when
// the env path is unset/relative/nonexistent (identical fail-closed surface to
// the legacy hook so the platform adapter needs no change).
//
// W13-A2: tracker-reminder.mjs has been deleted. This is the sole
// PostToolUse/PostToolUseFailure context hook wired by claude-runner.mjs.
// Missing or invalid projections fail closed to '{}' (no scan, no shell
// injection, always exit 0).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Tunables (env-overridable so a module/runner can configure bounds without
// code changes — C032 "package-configured").
// ---------------------------------------------------------------------------

const DEFAULT_BLOCK_CHARS = 800;
const DEFAULT_TOTAL_CHARS = 4000;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

const BLOCK_CHARS = envInt('SAGA_AGENT_ASSISTANCE_BUDGET_BLOCK_CHARS', DEFAULT_BLOCK_CHARS);
const TOTAL_CHARS = envInt('SAGA_AGENT_ASSISTANCE_BUDGET_CHARS', DEFAULT_TOTAL_CHARS);

// ---------------------------------------------------------------------------
// Fail-closed output. Always JSON on stdout, exit 0. Never throws out.
// ---------------------------------------------------------------------------

function emitEmpty() {
  process.stdout.write('{}');
  process.exit(0);
}

// Consume the hook event payload from stdin. New package projections may
// declare separate success/error assistance; the hook selects the physical
// event without knowing any module or tool vocabulary.
let hookInput = {};
try {
  const stdin = readFileSync(0, 'utf8');
  if (stdin.trim()) {
    const parsed = JSON.parse(stdin);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      hookInput = parsed;
    }
  }
} catch {
  // stdin optional; continue regardless.
}

// ---------------------------------------------------------------------------
// Resolve the pinned projection path (absolute, must exist).
// ---------------------------------------------------------------------------

const assistancePath = process.env.SAGA_AGENT_ASSISTANCE_PATH || '';
if (!assistancePath || !path.isAbsolute(assistancePath) || !existsSync(assistancePath)) {
  emitEmpty();
}

let raw;
try {
  raw = readFileSync(assistancePath, 'utf8');
} catch {
  emitEmpty();
}

let snap;
try {
  snap = JSON.parse(raw);
} catch {
  // Malformed JSON is a fail-closed case, not a crash.
  emitEmpty();
}

if (typeof snap !== 'object' || snap === null || Array.isArray(snap)) {
  emitEmpty();
}

// ---------------------------------------------------------------------------
// Cross-execution event rejection (§15.15 security test target).
//
// The snapshot carries an executionId (the worker's fencing token). If the
// runner passes SAGA_EXECUTION_ID and it does not match the snapshot's
// executionId, the snapshot is stale (from a prior/aborted execution) and is
// rejected. A snapshot with no executionId is accepted only when the runner
// did not pin one (lenient mode for the legacy fallback path).
// ---------------------------------------------------------------------------

const runnerExecId = process.env.SAGA_EXECUTION_ID || '';
const snapExecId = typeof snap.executionId === 'string' ? snap.executionId : '';
if (runnerExecId && (!snapExecId || runnerExecId !== snapExecId)) {
  emitEmpty();
}

function toolFailed(input) {
  if (!input || typeof input !== 'object') return false;
  if (input.hook_event_name === 'PostToolUseFailure') return true;
  if (input.error !== undefined && input.error !== null) return true;
  const response = input.tool_response;
  if (!response || typeof response !== 'object') return false;
  return response.is_error === true
    || response.success === false
    || (response.error !== undefined && response.error !== null);
}

const selectedEvent = toolFailed(hookInput)
  ? 'post-tool-error'
  : 'post-tool-success';
const configuredEvents = Array.isArray(snap.events) ? snap.events : null;
const selected = configuredEvents
  ? configuredEvents.find(candidate =>
      candidate
      && typeof candidate === 'object'
      && candidate.event === selectedEvent)
  : null;
const effectiveSnap = selected
  ? {
      ...snap,
      event: selectedEvent,
      blocks: Array.isArray(selected.blocks) ? selected.blocks : [],
    }
  : snap;

// ---------------------------------------------------------------------------
// Dedup by state version (C033, §10.9).
//
// The renderer stamps a monotonic stateVersion derived from ProtocolRun state.
// We persist the last emitted version in a sidecar next to the projection and
// skip emission when the version is unchanged — repeated tool calls on the same
// state produce no additional context. The sidecar is best-effort: any IO
// failure degrades to "emit" (safe default — never silently drop a new state).
// ---------------------------------------------------------------------------

const stateVersion = typeof effectiveSnap.stateVersion === 'string' && effectiveSnap.stateVersion.length > 0
  ? effectiveSnap.stateVersion
  : null;
const toolName = typeof hookInput.tool_name === 'string' ? hookInput.tool_name : '';
const dedupVersion = stateVersion === null
  ? null
  : `${stateVersion}:${selected ? selectedEvent : effectiveSnap.event || ''}:${toolName}`;

const sidecarPath = assistancePath + '.last-version';
const observationPath = assistancePath + '.hook-state.json';

function recordHookObservation(emitted) {
  try {
    let previous = null;
    if (existsSync(observationPath)) {
      const parsed = JSON.parse(readFileSync(observationPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        previous = parsed;
      }
    }
    const invocationCount = Number.isInteger(previous?.invocationCount)
      ? previous.invocationCount + 1
      : 1;
    const emittedCount = (Number.isInteger(previous?.emittedCount)
      ? previous.emittedCount
      : 0) + (emitted ? 1 : 0);
    writeFileSync(observationPath, `${JSON.stringify({
      schemaVersion: 'saga3.agent-assistance-hook-state.v1',
      executionId: snapExecId || null,
      event: selectedEvent,
      toolName: toolName || null,
      stateVersion,
      emitted,
      invocationCount,
      emittedCount,
    }, null, 2)}\n`, 'utf8');
  } catch {
    // Observability is best-effort and must never block the worker.
  }
}

function readLastVersion() {
  try {
    const v = readFileSync(sidecarPath, 'utf8');
    return v.trim();
  } catch {
    return null;
  }
}
function writeLastVersion(v) {
  try {
    const dir = path.dirname(sidecarPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(sidecarPath, v, 'utf8');
  } catch {
    // best-effort; a failed sidecar write does not fail the hook.
  }
}

if (dedupVersion !== null) {
  const last = readLastVersion();
  if (last !== null && last === dedupVersion) {
    // Repeated state — emit nothing.
    recordHookObservation(false);
    emitEmpty();
  }
}

// ---------------------------------------------------------------------------
// Render the bounded structured context from the snapshot's blocks.
// ---------------------------------------------------------------------------

const blocks = Array.isArray(effectiveSnap.blocks) ? effectiveSnap.blocks : [];
const mode = typeof effectiveSnap.mode === 'string' ? effectiveSnap.mode : 'guided';
const event = typeof effectiveSnap.event === 'string'
  ? effectiveSnap.event
  : selectedEvent;

// Escape any control characters in block content so untrusted error text (e.g.
// a last-error block sourced from a tool failure) cannot inject newlines or
// terminal escapes into the rendered context. §15.15 untrusted-error-escaping.
function sanitize(text) {
  if (typeof text !== 'string') return '';
  // Collapse CR/LF/tab to spaces and strip other C0 controls except space.
  return text.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1F\x7F]/g, '');
}

function truncate(text, cap) {
  if (text.length <= cap) return text;
  // Reserve room for the truncation marker.
  const marker = ' …[truncated]';
  return text.slice(0, Math.max(0, cap - marker.length)) + marker;
}

const labelFor = {
  goal: 'Goal',
  'current-step': 'Current step',
  'next-action': 'Next action',
  'resource-path': 'Resource',
  'allowed-tools': 'Allowed tools',
  'completion-criteria': 'Done when',
  'last-error': 'Last error',
  'repair-fields': 'Repair',
  'retry-instruction': 'Retry',
};

const lines = [];
lines.push('AGENT CONTEXT (structured)');
if (mode) lines.push(`Mode: ${sanitize(mode)}`);
if (event) lines.push(`Event: ${sanitize(event)}`);
lines.push('');

let used = lines.reduce((s, l) => s + l.length + 1, 0);
let emittedBlocks = 0;

for (const b of blocks) {
  if (used >= TOTAL_CHARS) break;
  if (emittedBlocks >= 32) break; // hard ceiling on block count (C033 bound).
  if (typeof b !== 'object' || b === null || Array.isArray(b)) continue;
  const kind = typeof b.kind === 'string' ? b.kind : '';
  const content = sanitize(typeof b.content === 'string' ? b.content : '');
  if (!kind && !content) continue;
  const label = labelFor[kind] || (kind ? sanitize(kind) : 'Note');
  const capped = truncate(content, BLOCK_CHARS);
  const line = `${label}: ${capped}`;
  if (used + line.length + 1 > TOTAL_CHARS) {
    // This block would overflow the total budget; stop.
    lines.push('…[context budget reached]');
    break;
  }
  lines.push(line);
  used += line.length + 1;
  emittedBlocks += 1;
}

if (emittedBlocks === 0) {
  // No usable blocks: treat as empty so the model gets no partial frame.
  emitEmpty();
}

lines.push('');
lines.push('ACTION: follow the structured blocks above. Do not parse Markdown trackers.');

const additionalContext = lines.join('\n');

// Record the state version we just emitted so the next identical state dedups.
if (dedupVersion !== null) {
  writeLastVersion(dedupVersion);
}
recordHookObservation(true);

const hookEventName = toolFailed(hookInput)
  ? 'PostToolUseFailure'
  : 'PostToolUse';
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName,
    additionalContext,
  },
}));
