// tests/execution/structured-context-hook.test.mjs
//
// W5-A5 — contract tests for tracker-view/structured-context-hook.mjs.
//
// This hook replaces tracker-reminder.mjs and reads a STRUCTURED
// agent-assistance.json projection (C031) instead of parsing Markdown (C027).
// It is generic + package-configured (C032) and bounds + deduplicates messages
// by state version (C033).
//
// Covers the security/bounding surface called out in plan §15.15:
//   - untrusted error escaping
//   - size limits
//   - state-version deduplication
//   - cross-execution event rejection
//
// The hook is invoked as a subprocess (it is a script, not an importable
// module), exactly like the legacy tracker-reminder tests. We read stdout JSON.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'tracker-view', 'structured-context-hook.mjs');

function runHook({
  assistancePath,
  executionId,
  stdin = '{}',
  extraEnv = {},
  cwd,
} = {}) {
  const env = {
    ...process.env,
    SAGA_AGENT_ASSISTANCE_PATH: assistancePath ?? '',
    ...(executionId !== undefined ? { SAGA_EXECUTION_ID: executionId } : {}),
    ...extraEnv,
  };
  return spawnSync(process.execPath, [HOOK_PATH], {
    env,
    input: stdin,
    encoding: 'utf8',
    timeout: 10000,
    cwd,
  });
}

function writeSnapshot(dir, name, obj) {
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

function freshDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Happy path: structured JSON → bounded additionalContext.
// ---------------------------------------------------------------------------

test('structured-context-hook: emits bounded context from valid snapshot', () => {
  const tmp = freshDir('saga-w5a5-ok-');
  try {
    const p = writeSnapshot(tmp, 'agent-assistance.json', {
      schemaVersion: 'saga3.agent-assistance.v1',
      stateVersion: 'v1',
      event: 'post-tool-success',
      executionId: 'exec-1',
      mode: 'guided',
      blocks: [
        { kind: 'goal', content: 'Submit the proposal' },
        { kind: 'current-step', content: 'Compose proposal JSON' },
        { kind: 'next-action', content: 'Call proposal_submit' },
      ],
    });
    const r = runHook({ assistancePath: p });
    assert.equal(r.status, 0, `hook exited non-zero: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok('additionalContext' in out, 'additionalContext missing');
    const c = out.additionalContext;
    assert.match(c, /AGENT CONTEXT \(structured\)/);
    assert.match(c, /Mode: guided/);
    assert.match(c, /Event: post-tool-success/);
    assert.match(c, /Goal: Submit the proposal/);
    assert.match(c, /Current step: Compose proposal JSON/);
    assert.match(c, /Next action: Call proposal_submit/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fail-closed surface — mirrors legacy tracker-reminder invariants.
// ---------------------------------------------------------------------------

test('structured-context-hook: emits {} for missing SAGA_AGENT_ASSISTANCE_PATH', () => {
  const r = runHook({ assistancePath: '' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{}');
});

test('structured-context-hook: emits {} for relative path (must be absolute)', () => {
  // Fail-closed: a relative path is never resolved by convention.
  const r = runHook({ assistancePath: 'docs/agent-assistance.json' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{}');
});

test('structured-context-hook: emits {} for absolute-but-nonexistent path', () => {
  const r = runHook({ assistancePath: path.join(os.tmpdir(), 'definitely-absent.json') });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{}');
});

test('structured-context-hook: emits {} when path points at a directory', () => {
  const tmp = freshDir('saga-w5a5-dir-');
  try {
    const r = runHook({ assistancePath: tmp });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '{}');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('structured-context-hook: emits {} for malformed JSON', () => {
  const tmp = freshDir('saga-w5a5-bad-');
  try {
    const p = path.join(tmp, 'agent-assistance.json');
    writeFileSync(p, '{ not valid json ]]', 'utf8');
    const r = runHook({ assistancePath: p });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '{}');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('structured-context-hook: emits {} when snapshot is not a JSON object', () => {
  const tmp = freshDir('saga-w5a5-array-');
  try {
    const p = path.join(tmp, 'agent-assistance.json');
    writeFileSync(p, '[1,2,3]', 'utf8');
    const r = runHook({ assistancePath: p });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '{}');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('structured-context-hook: emits {} when blocks array is empty', () => {
  const tmp = freshDir('saga-w5a5-noblocks-');
  try {
    const p = writeSnapshot(tmp, 'agent-assistance.json', {
      stateVersion: 'v1',
      event: 'post-tool-success',
      blocks: [],
    });
    const r = runHook({ assistancePath: p });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '{}');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Anti-scan: the hook reads ONLY the exact env path, never docs/ (§13.5).
// ---------------------------------------------------------------------------

test('structured-context-hook: does NOT scan docs/, only the exact env path', () => {
  const tmp = freshDir('saga-w5a5-noscan-');
  try {
    const fakeDocs = path.join(tmp, 'docs', 'discovery', 'projects', '99');
    mkdirSync(fakeDocs, { recursive: true });
    const tempting = path.join(fakeDocs, 'agent-assistance.json');
    writeFileSync(tempting, JSON.stringify({
      stateVersion: 'v1',
      blocks: [{ kind: 'goal', content: 'TEMPTING-NEVER-EMITTED' }],
    }));
    // cwd inside tmp but env path unset → must NOT discover the file.
    const r = runHook({ assistancePath: '', cwd: tmp });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '{}');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C033: state-version deduplication.
// ---------------------------------------------------------------------------

test('structured-context-hook: dedups repeated state by stateVersion', () => {
  const tmp = freshDir('saga-w5a5-dedup-');
  try {
    const p = writeSnapshot(tmp, 'agent-assistance.json', {
      stateVersion: 'v-dedup-1',
      event: 'post-tool-success',
      blocks: [{ kind: 'current-step', content: 'step-1' }],
    });
    // First emission: non-empty.
    const r1 = runHook({ assistancePath: p });
    assert.equal(r1.status, 0);
    const o1 = JSON.parse(r1.stdout);
    assert.ok('additionalContext' in o1, 'first emission must contain context');
    assert.match(o1.additionalContext, /Current step: step-1/);

    // Sidecar last-version file must now exist.
    assert.ok(existsSync(p + '.last-version'), 'sidecar last-version file missing');

    // Second emission with SAME stateVersion: deduped → {}.
    const r2 = runHook({ assistancePath: p });
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout, '{}', 'identical stateVersion must dedup');

    // Third emission with a NEW stateVersion: non-empty again.
    writeFileSync(p, JSON.stringify({
      stateVersion: 'v-dedup-2',
      event: 'post-tool-success',
      blocks: [{ kind: 'current-step', content: 'step-2' }],
    }));
    const r3 = runHook({ assistancePath: p });
    assert.equal(r3.status, 0);
    const o3 = JSON.parse(r3.stdout);
    assert.ok('additionalContext' in o3, 'new stateVersion must re-emit');
    assert.match(o3.additionalContext, /Current step: step-2/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('structured-context-hook: snapshot without stateVersion never dedups', () => {
  // A snapshot missing stateVersion cannot be deduped; every call emits.
  const tmp = freshDir('saga-w5a5-noversion-');
  try {
    const p = writeSnapshot(tmp, 'agent-assistance.json', {
      event: 'post-tool-success',
      blocks: [{ kind: 'current-step', content: 'always-emit' }],
    });
    const r1 = runHook({ assistancePath: p });
    const r2 = runHook({ assistancePath: p });
    assert.ok('additionalContext' in JSON.parse(r1.stdout));
    assert.ok('additionalContext' in JSON.parse(r2.stdout));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §15.15: cross-execution event rejection.
// ---------------------------------------------------------------------------

test('structured-context-hook: rejects snapshot whose executionId mismatches the runner', () => {
  const tmp = freshDir('saga-w5a5-xexec-');
  try {
    const p = writeSnapshot(tmp, 'agent-assistance.json', {
      stateVersion: 'v1',
      executionId: 'exec-from-prior-run',
      blocks: [{ kind: 'current-step', content: 'stale-step' }],
    });
    // Runner pins its own execution id; the snapshot's is different → reject.
    const r = runHook({ assistancePath: p, executionId: 'exec-current' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '{}', 'cross-execution snapshot must be rejected');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('structured-context-hook: accepts snapshot when executionId matches', () => {
  const tmp = freshDir('saga-w5a5-exec-ok-');
  try {
    const p = writeSnapshot(tmp, 'agent-assistance.json', {
      stateVersion: 'v1',
      executionId: 'exec-current',
      blocks: [{ kind: 'current-step', content: 'fresh-step' }],
    });
    const r = runHook({ assistancePath: p, executionId: 'exec-current' });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.match(out.additionalContext, /Current step: fresh-step/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('structured-context-hook: lenient when neither side pins an executionId', () => {
  const tmp = freshDir('saga-w5a5-lenient-');
  try {
    const p = writeSnapshot(tmp, 'agent-assistance.json', {
      stateVersion: 'v1',
      // no executionId on snapshot
      blocks: [{ kind: 'current-step', content: 'lenient-step' }],
    });
    const r = runHook({ assistancePath: p /* no SAGA_EXECUTION_ID */ });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.match(out.additionalContext, /Current step: lenient-step/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §15.15: untrusted error escaping.
// ---------------------------------------------------------------------------

test('structured-context-hook: escapes CR/LF/tab and C0 controls in block content', () => {
  const tmp = freshDir('saga-w5a5-esc-');
  try {
    const p = writeSnapshot(tmp, 'agent-assistance.json', {
      stateVersion: 'v1',
      blocks: [
        {
          kind: 'last-error',
          // Untrusted error text with newlines, tabs, and a BEL control char.
          content: 'line1\nline2\tINJECTED\x07\x1b[0m',
        },
      ],
    });
    const r = runHook({ assistancePath: p });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    const c = out.additionalContext;
    // Newlines from content must NOT survive into the rendered block line:
    // they are collapsed to spaces so a weak model cannot be line-injected.
    assert.doesNotMatch(c, /line1\nline2/);
    assert.match(c, /line1 line2 INJECTED/);
    // No raw control chars or ANSI escapes survive.
    assert.doesNotMatch(c, /\x07/);
    assert.doesNotMatch(c, /\x1b\[/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §15.15: size limits (per-block and total budget).
// ---------------------------------------------------------------------------

test('structured-context-hook: truncates an over-long block to the block budget', () => {
  const tmp = freshDir('saga-w5a5-trunc-');
  try {
    const long = 'A'.repeat(2000);
    const p = writeSnapshot(tmp, 'agent-assistance.json', {
      stateVersion: 'v1',
      blocks: [{ kind: 'next-action', content: long }],
    });
    const r = runHook({
      assistancePath: p,
      extraEnv: { SAGA_AGENT_ASSISTANCE_BUDGET_BLOCK_CHARS: '100' },
    });
    assert.equal(r.status, 0);
    const c = JSON.parse(r.stdout).additionalContext;
    // Truncation marker present and run bounded.
    assert.match(c, /…\[truncated\]/);
    // No run of 95+ A's survives a 100-char block cap.
    assert.doesNotMatch(c, /A{95}/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('structured-context-hook: caps total emitted context at the total budget', () => {
  const tmp = freshDir('saga-w5a5-total-');
  try {
    // Many blocks, each well under the block budget, but together far over the
    // total budget. The hook must stop and emit a budget-reached marker.
    const blocks = [];
    for (let i = 0; i < 50; i++) {
      blocks.push({ kind: 'resource-path', content: `R${i}-` + 'B'.repeat(60) });
    }
    const p = writeSnapshot(tmp, 'agent-assistance.json', {
      stateVersion: 'v1',
      blocks,
    });
    const r = runHook({
      assistancePath: p,
      extraEnv: { SAGA_AGENT_ASSISTANCE_BUDGET_CHARS: '500' },
    });
    assert.equal(r.status, 0);
    const c = JSON.parse(r.stdout).additionalContext;
    assert.match(c, /…\[context budget reached\]/);
    assert.ok(c.length < 1000, `total context must be bounded, got ${c.length}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Generic / package-configured (C032): no module/stage name switching.
// ---------------------------------------------------------------------------

test('structured-context-hook: renders unknown block kinds with their kind as label', () => {
  const tmp = freshDir('saga-w5a5-generic-');
  try {
    const p = writeSnapshot(tmp, 'agent-assistance.json', {
      stateVersion: 'v1',
      blocks: [
        { kind: 'custom-block', content: 'module-defined content' },
        { kind: '', content: 'no kind' },
      ],
    });
    const r = runHook({ assistancePath: p });
    assert.equal(r.status, 0);
    const c = JSON.parse(r.stdout).additionalContext;
    // Unknown kind is rendered with the kind string itself (sanitized), proving
    // the hook switches on NO module/task vocabulary.
    assert.match(c, /custom-block: module-defined content/);
    assert.match(c, /Note: no kind/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('structured-context-hook: hook source contains no module/stage name switching', () => {
  // Static guarantee (C032): the hook must not hard-code discovery/formalization/
  // development/delivery or any task-kind. All content comes from the JSON.
  const src = readFileSync(HOOK_PATH, 'utf8');
  const forbidden = [
    /\bdiscovery\b/i,
    /\bformalization\b/i,
    /\bdevelopment\b/i,
    /\bdelivery\b/i,
    /\bsaga-product\b/i,
    /\bsaga-analyst\b/i,
    /task_kind/i,
    /workflow_stage/i,
  ];
  for (const re of forbidden) {
    assert.doesNotMatch(src, re, `hook must not switch on module/stage name: ${re}`);
  }
});
