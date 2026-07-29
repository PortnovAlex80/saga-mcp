#!/usr/bin/env node
// W5-A5 — Structured agent context hook (replaces tracker-reminder.mjs).
//
// Reads a STRUCTURED agent-assistance.json projection (written by W5-A4
// AgentAssistanceRenderer from authoritative ProtocolRun state — plan §10.4,
// §14.7.5, C031) instead of parsing Markdown checkboxes (C027 violation in the
// legacy hook).
//
// Contract notes (consumes the W5-A4 snapshot; no Markdown parsing here):
//
//   The runner pins the exact execution-scoped projection path via
//   SAGA_AGENT_ASSISTANCE_PATH. The file shape is the serialised
//   AgentAssistanceSnapshot produced by the W5-A4 renderer:
//
//     {
//       "schemaVersion": "saga3.agent-assistance.v1",
//       "stateVersion":  "<monotonic string set by renderer from ProtocolRun>",
//       "event":         "<step-enter|post-tool-success|post-tool-error|...>",
//       "executionId":   "<fencing token; cross-execution events are rejected>",
//       "mode":          "<compact|guided|intensive>",
//       "blocks": [
//         { "kind": "<goal|current-step|next-action|resource-path|...>",
//           "content": "<bounded human-readable text>" },
//         ...
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
// Output: `{ "additionalContext": "<bounded structured context>" }` on first
// sight of a new state version; `{}` when deduped, missing, malformed, or when
// the env path is unset/relative/nonexistent (identical fail-closed surface to
// the legacy hook so the platform adapter needs no change).
//
// The legacy tracker-reminder.mjs stays as fallback until the Wave 5 gate
// passes (spec §4 anti-scope). This file is the forward path.

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

// Consume the hook event payload from stdin. The platform adapter passes the
// PostToolUse event JSON here. We swallow read errors exactly like the legacy
// hook (stdin closed/empty is non-fatal).
try {
  readFileSync(0, 'utf8');
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
if (runnerExecId && snapExecId && runnerExecId !== snapExecId) {
  emitEmpty();
}

// ---------------------------------------------------------------------------
// Dedup by state version (C033, §10.9).
//
// The renderer stamps a monotonic stateVersion derived from ProtocolRun state.
// We persist the last emitted version in a sidecar next to the projection and
// skip emission when the version is unchanged — repeated tool calls on the same
// state produce no additional context. The sidecar is best-effort: any IO
// failure degrades to "emit" (safe default — never silently drop a new state).
// ---------------------------------------------------------------------------

const stateVersion = typeof snap.stateVersion === 'string' && snap.stateVersion.length > 0
  ? snap.stateVersion
  : null;

const sidecarPath = assistancePath + '.last-version';
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

if (stateVersion !== null) {
  const last = readLastVersion();
  if (last !== null && last === stateVersion) {
    // Repeated state — emit nothing.
    emitEmpty();
  }
}

// ---------------------------------------------------------------------------
// Render the bounded structured context from the snapshot's blocks.
// ---------------------------------------------------------------------------

const blocks = Array.isArray(snap.blocks) ? snap.blocks : [];
const mode = typeof snap.mode === 'string' ? snap.mode : 'guided';
const event = typeof snap.event === 'string' ? snap.event : 'post-tool-success';

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
if (stateVersion !== null) {
  writeLastVersion(stateVersion);
}

process.stdout.write(JSON.stringify({ additionalContext }));
