// Provider-retry in the agent-proxy shim — tests (docs/architecture/PROVIDER-RETRY-DESIGN.md).
//
// NOTE (base): repair/es1-loop-detector (stream-json translation + its
// tests/architecture/claude-shim-stream-json.test.mjs) is NOT merged into the
// branch this work is based on. These tests are therefore independent of it;
// the tee in the shim is structured so the es1 translator can later sit
// between the capture and the forward without touching the retry logic.
//
// Hermetic: every integration case runs the shim against
// tests/architecture/fixtures/opencode-stub.mjs through
// SAGA_PROXY_OPENCODE_PATH — no network, no ~/.claude, no real opencode/GLM,
// no factory state. Unit cases import pure functions only.
//
// T1 — discriminator table
// T2 — ladder + jitter + heartbeat (injected clock/sleep/writers)
// T3 — integration with a stub opencode binary
// T4 — tee byte-identity when no retries happen

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyFailure,
  computeLadderDelayMs,
  nextRetryDelayMs,
  sleepWithRetryHeartbeat,
  MAX_ATTEMPTS_PRE_TOOL,
  MAX_ATTEMPTS_POST_TOOL,
  HEARTBEAT_INTERVAL_MS,
  RETRY_JITTER_MAX_MS,
} from '../../tools/agent-proxy/claude-shim.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIM = path.join(repoRoot, 'tools', 'agent-proxy', 'claude-shim.mjs');
const STUB = path.join(repoRoot, 'tests', 'architecture', 'fixtures', 'opencode-stub.mjs');

// ---------------------------------------------------------------------------
// T1 — discriminator table
// ---------------------------------------------------------------------------

const TEXT_CASES = [
  ['429 Too Many Requests', 'HTTP 429'],
  ['rate limit exceeded', 'rate limit (spaced)'],
  ['Rate-Limited: slow down', 'rate-limit hyphenated'],
  ['the service is currently overloaded', 'overloaded'],
  ['Too many requests for this model', 'too many requests'],
  ['Error: status 503 Service Unavailable', '5xx via "status " (spaced)'],
  ['AI_APICallError: status:500 Internal Server Error', '5xx via "status:" (compact)'],
  ['socket connection was closed unexpectedly', 'socket closed'],
  ['Error: connect ECONNRESET 1.2.3.4:443', 'ECONNRESET'],
  ['Error: ETIMEDOUT 1.2.3.4:443', 'ETIMEDOUT'],
  ['TypeError: fetch failed', 'fetch failed'],
];

for (const [text, label] of TEXT_CASES) {
  test(`T1: retryable text on stderr, exit 1, pre-tool → retry (full ladder): ${label}`, () => {
    const v = classifyFailure({ exitCode: 1, signal: null, stdout: '', stderr: `${text}\n` });
    assert.equal(v.retry, true, `should retry on "${text}"`);
    assert.equal(v.postTool, false);
    assert.equal(v.class, 'text');
    assert.ok(v.detail, 'records the matched fragment for the summary');
    assert.ok(text.startsWith(v.detail) || v.detail.length > 0);
  });
  test(`T1: retryable text on STDOUT tail also retries: ${label}`, () => {
    const v = classifyFailure({ exitCode: 1, signal: null, stdout: `${text}\n`, stderr: '' });
    assert.equal(v.retry, true);
  });
}

test('T1: clean exit (0, no text, no marker) → never retry', () => {
  const v = classifyFailure({ exitCode: 0, signal: null, stdout: 'final answer\n', stderr: '' });
  assert.equal(v.retry, false);
  assert.equal(v.class, 'clean');
});

test('T1: saga_worker_done present → NEVER retry, even with 429 text (double-complete guard)', () => {
  const v = classifyFailure({
    exitCode: 1,
    signal: null,
    stdout: '⚙ saga_worker_done {"ok":true}\n',
    stderr: 'AI_APICallError: 429 Too Many Requests\n',
  });
  assert.equal(v.retry, false);
  assert.equal(v.class, 'worker-done');
});

test('T1: saga_worker_done in plain (non-⚙) stdout text still guards', () => {
  const v = classifyFailure({
    exitCode: 0,
    signal: null,
    stdout: 'I completed the card via saga_worker_done successfully\n',
    stderr: '',
  });
  assert.equal(v.retry, false);
  assert.equal(v.class, 'worker-done');
});

test('T1: translated claude result event in child output → never retry (es1-composition guard)', () => {
  const v = classifyFailure({
    exitCode: 1,
    signal: null,
    stdout: '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":1}}\n',
    stderr: '429 rate limit\n',
  });
  assert.equal(v.retry, false);
  assert.equal(v.class, 'worker-done');
});

test('T1: pre-first-tool death (exit≠0, no marker, no text) → retry, full ladder', () => {
  const v = classifyFailure({ exitCode: 1, signal: null, stdout: 'some plain output\n', stderr: '' });
  assert.equal(v.retry, true);
  assert.equal(v.postTool, false);
  assert.equal(v.class, 'pre-tool-death');
});

test('T1: death by signal counts as exit≠0 → retry (pre-tool)', () => {
  const v = classifyFailure({ exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '' });
  assert.equal(v.retry, true);
  assert.equal(v.postTool, false);
});

test('T1: post-tool death with retryable text → retry but post-tool (reduced ladder only)', () => {
  const v = classifyFailure({
    exitCode: 1,
    signal: null,
    stdout: '⚙ saga_trace_add {"x":1}\n',
    stderr: 'AI_APICallError: 429\n',
  });
  assert.equal(v.retry, true);
  assert.equal(v.postTool, true);
});

test('T1: post-tool death WITHOUT text → reduced ladder only (≤ MAX_ATTEMPTS_POST_TOOL)', () => {
  const v = classifyFailure({
    exitCode: 1,
    signal: null,
    stdout: '⚙ saga_task_get {}\nworking...\n',
    stderr: '',
  });
  assert.equal(v.retry, true);
  assert.equal(v.postTool, true, 'marker seen → ladder capped at MAX_ATTEMPTS_POST_TOOL');
  assert.ok(MAX_ATTEMPTS_POST_TOOL <= 3, 'post-tool ladder must stay reduced (design: 2-3)');
});

test('T1: stream-json tool_use event counts as a tool marker (composes with es1 backend)', () => {
  const v = classifyFailure({
    exitCode: 1,
    signal: null,
    stdout: '{"type":"tool_use","part":{"tool":"read","callID":"c1"}}\n',
    stderr: '',
  });
  assert.equal(v.retry, true);
  assert.equal(v.postTool, true);
});

test('T1: recovered-mid-run 429 (text far from the tail, clean end) → not text-class', () => {
  // Tail-based matching: a 429 the backend recovered from must not trigger a
  // retry of a finished run. The tail window keeps the end of the capture.
  const filler = 'x'.repeat(200 * 1024); // far beyond the tail window
  const v = classifyFailure({
    exitCode: 0,
    signal: null,
    stdout: `429 rate limit (recovered)\n${filler}\nfinal answer\n`,
    stderr: '',
  });
  assert.equal(v.retry, false);
});

// ---------------------------------------------------------------------------
// T2 — ladder, jitter, heartbeat
// ---------------------------------------------------------------------------

test('T2: ladder constants — 8 pre-tool attempts, 3 post-tool, 20s heartbeat, ≤250ms jitter', () => {
  assert.equal(MAX_ATTEMPTS_PRE_TOOL, 8);
  assert.equal(MAX_ATTEMPTS_POST_TOOL, 3);
  assert.equal(HEARTBEAT_INTERVAL_MS, 20_000);
  assert.equal(RETRY_JITTER_MAX_MS, 250);
});

test('T2: ladder delays are min(2^(n-1), 256) seconds', () => {
  const expected = [1, 2, 4, 8, 16, 32, 64, 128].map((s) => s * 1000);
  const actual = Array.from({ length: 8 }, (_, i) => computeLadderDelayMs(i + 1));
  assert.deepEqual(actual, expected);
  // The cap binds from n=9 on — the formula must stay bounded even if the
  // attempt cap is ever raised.
  assert.equal(computeLadderDelayMs(9), 256_000);
  assert.equal(computeLadderDelayMs(20), 256_000);
});

test('T2: total sleep budget of a full pre-tool ladder stays ≤ 10 minutes', () => {
  // 8 attempts = at most 7 sleeps (n = 1..7): 1+2+4+8+16+32+64 = 127s.
  let total = 0;
  for (let n = 1; n <= MAX_ATTEMPTS_PRE_TOOL - 1; n++) total += computeLadderDelayMs(n);
  total += (MAX_ATTEMPTS_PRE_TOOL - 1) * RETRY_JITTER_MAX_MS; // worst-case jitter
  assert.ok(total <= 10 * 60 * 1000, `full-ladder sleep budget ${total}ms exceeds 10min`);
});

test('T2: jitter is uniform-bounded 0..250ms on top of the ladder step', () => {
  assert.equal(nextRetryDelayMs(3, () => 0), 4_000);
  const maxJitter = nextRetryDelayMs(3, () => 0.999999);
  assert.ok(maxJitter > 4_000 && maxJitter <= 4_000 + RETRY_JITTER_MAX_MS, `got ${maxJitter}`);
  // Sample the real RNG: every draw in [base, base+250], and the jitter is
  // actually alive (not a constant), which de-synchronizes parallel workers.
  const draws = new Set();
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < 300; i++) {
    const d = nextRetryDelayMs(3);
    draws.add(d);
    min = Math.min(min, d);
    max = Math.max(max, d);
    assert.ok(d >= 4_000 && d <= 4_250, `draw out of bounds: ${d}`);
  }
  assert.ok(min >= 4_000 && max <= 4_250);
  assert.ok(draws.size > 10, `jitter looks constant (${draws.size} distinct draws)`);
});

test('T2: heartbeat during sleeps — a heartbeat line every ≤ HEARTBEAT_INTERVAL_MS', async () => {
  const writes = [];
  const clock = { now: 0 };
  const sleeps = [];
  const io = {
    now: () => clock.now,
    sleep: async (ms) => { sleeps.push(ms); clock.now += ms; },
    stdout: { write: (s) => writes.push(s) },
  };
  await sleepWithRetryHeartbeat(65_000, { attempt: 2, className: 'text:429', remainingMs: 65_000 }, io);
  // 65s of sleep chunks into 20+20+20+5; a heartbeat follows each full chunk.
  assert.deepEqual(sleeps, [20_000, 20_000, 20_000, 5_000]);
  assert.equal(writes.length, 3, `expected 3 heartbeats, got ${JSON.stringify(writes)}`);
  for (const line of writes) {
    assert.match(line, /\[agent-proxy\] retry #2 in \d+s \(text:429\) — heartbeat/);
  }
  // Remaining seconds reported by the first heartbeat (65-20=45).
  assert.match(writes[0], /in 45s/);
  // No silent window longer than the heartbeat interval while sleeping.
  let t = 0;
  const marks = [];
  for (let i = 0; i < sleeps.length; i++) {
    t += sleeps[i];
    if (i < writes.length) marks.push(t);
  }
  let prev = 0;
  for (const m of marks) {
    assert.ok(m - prev <= HEARTBEAT_INTERVAL_MS, `silent gap ${m - prev}ms > ${HEARTBEAT_INTERVAL_MS}ms`);
    prev = m;
  }
});

test('T2: short sleeps emit no heartbeat (nothing to keep alive)', async () => {
  const writes = [];
  const clock = { now: 0 };
  const sleeps = [];
  await sleepWithRetryHeartbeat(1_500, { attempt: 1, className: 'text:429', remainingMs: 1_500 }, {
    now: () => clock.now,
    sleep: async (ms) => { sleeps.push(ms); clock.now += ms; },
    stdout: { write: (s) => writes.push(s) },
  });
  assert.deepEqual(sleeps, [1_500]);
  assert.deepEqual(writes, []);
});

// ---------------------------------------------------------------------------
// T3/T4 — integration with the stub opencode binary
// ---------------------------------------------------------------------------

function runShim(plan, { timeoutMs = 30_000 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-shim-retry-'));
  const statePath = path.join(dir, 'state.txt');
  const child = spawn(process.execPath, [SHIM, '-p', '--bare', '--model', 'glm-4.7'], {
    env: {
      ...process.env,
      // Hermetic backend: the shim spawns the stub instead of real opencode.
      SAGA_PROXY_OPENCODE_PATH: STUB,
      STUB_PLAN: JSON.stringify(plan),
      STUB_STATE: statePath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const done = new Promise((resolve, reject) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', reject);
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`shim timed out after ${timeoutMs}ms`));
    }, timeoutMs).unref();
  });
  child.stdin.write('hermetic provider-retry test prompt');
  child.stdin.end();
  return done.then(({ code, signal }) => {
    let invocations = 0;
    try { invocations = Number(readFileSync(statePath, 'utf8')) || 0; } catch { /* zero */ }
    return { code, signal, stdout, stderr, invocations, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  });
}

test('T3: stub fails twice with 429/503 then succeeds with a tool marker → shim retries, passes result through', async () => {
  const plan = [
    { stderr: 'AI_APICallError: 429 Too Many Requests\n', code: 1 },
    { stderr: 'Error: status 503 Service Unavailable\n', code: 1 },
    { stdout: '⚙ saga_trace_add {"x":1}\nfinal answer text\n', code: 0 },
  ];
  const r = await runShim(plan);
  try {
    assert.equal(r.code, 0, `shim exit code; stderr=${r.stderr}`);
    assert.equal(r.invocations, 3, 'two retries after two retryable deaths');
    // The runner-visible stream carries the successful attempt's output.
    assert.match(r.stdout, /⚙ saga_trace_add \{"x":1\}/);
    assert.match(r.stdout, /final answer text/);
    // One retry note per failed attempt on stderr (lands in the worker JSONL).
    assert.match(r.stderr, /\[agent-proxy\] attempt 1 failed[^\n]*429/);
    assert.match(r.stderr, /\[agent-proxy\] attempt 2 failed[^\n]*503/);
    assert.ok(!/attempt 3 failed/.test(r.stderr), 'no note for the successful attempt');
    // Summary line after the ladder ends.
    assert.match(r.stderr, /\[agent-proxy\] retry summary: 3 attempts/);
  } finally {
    r.cleanup();
  }
});

test('T3: a successful retry attempt is never re-run on stale 429 residue from earlier attempts', async () => {
  // Attempt 1 dies pre-tool with 429; attempt 2 answers with plain text (no
  // tools) and exits 0. The accumulated capture still contains the 429 — the
  // discriminator must scope its text match to the CURRENT attempt, or the
  // successful run would itself be retried (side-effect re-execution).
  const plan = [
    { stderr: 'AI_APICallError: 429 Too Many Requests\n', code: 1 },
    { stdout: 'plain answer, no tools\n', code: 0 },
  ];
  const r = await runShim(plan);
  try {
    assert.equal(r.code, 0);
    assert.equal(r.invocations, 2, 'the successful attempt must be the last');
    assert.match(r.stderr, /\[agent-proxy\] retry summary: 2 attempts[^\n]*clean/);
  } finally {
    r.cleanup();
  }
});

test('T3: stub exits 0 immediately → zero retries, single invocation', async () => {
  const r = await runShim([{ stdout: 'ok\n', code: 0 }]);
  try {
    assert.equal(r.code, 0);
    assert.equal(r.invocations, 1);
    assert.ok(!/attempt 1 failed/.test(r.stderr), 'no retry note on a clean run');
    assert.match(r.stderr, /\[agent-proxy\] retry summary: 1 attempts/);
  } finally {
    r.cleanup();
  }
});

test('T3: stub emits saga_worker_done then crashes with 429 → zero retries (double-complete guard)', async () => {
  const plan = [{ stdout: '⚙ saga_worker_done {"ok":true}\n', stderr: '429 rate limit\n', code: 1 }];
  const r = await runShim(plan);
  try {
    assert.equal(r.code, 1, 'exits with the LAST child exit code');
    assert.equal(r.invocations, 1, 'worker-done must never be retried');
    assert.match(r.stderr, /worker-done/);
    assert.match(r.stderr, /\[agent-proxy\] retry summary: 1 attempts/);
  } finally {
    r.cleanup();
  }
});

test('T3: post-tool death with retryable text every time → reduced ladder caps at 3 attempts', async () => {
  // Every attempt emits a tool marker then dies with 429: the marker keeps
  // the ladder at MAX_ATTEMPTS_POST_TOOL even though the text class itself
  // is retryable — the full 8-attempt ladder is pre-first-tool only.
  const plan = [{ stdout: '⚙ saga_trace_add {"x":1}\n', stderr: 'AI_APICallError: 429\n', code: 1 }];
  const r = await runShim(plan);
  try {
    assert.equal(r.code, 1, 'exits with the LAST child exit code');
    assert.equal(r.invocations, MAX_ATTEMPTS_POST_TOOL, `expected the reduced ladder cap (${MAX_ATTEMPTS_POST_TOOL})`);
    assert.match(r.stderr, /\[agent-proxy\] retry summary: 3 attempts/);
    assert.match(r.stderr, /ladder=reduced/);
  } finally {
    r.cleanup();
  }
});

test('T4: tee — with no retries the runner-visible stdout is byte-identical to the child stdout', async () => {
  const childStdout = 'line1\n⚙ saga_worker_done {"k":"v"}\ntail-without-newline';
  const childStderr = 'err-A\nerr-B\n';
  const r = await runShim([{ stdout: childStdout, stderr: childStderr, code: 0 }]);
  try {
    assert.equal(r.code, 0);
    assert.equal(r.stdout, childStdout, 'stdout must be the child bytes, nothing added');
    assert.ok(!r.stdout.includes('[agent-proxy]'), 'no shim noise on stdout');
    // stderr is teed too; the shim's own notes (pre-existing behavior) may
    // surround it, but the child's stderr must appear verbatim.
    assert.ok(r.stderr.includes(childStderr), `child stderr not teed verbatim: ${JSON.stringify(r.stderr)}`);
  } finally {
    r.cleanup();
  }
});
