// Worker-disorientation regression tests for the agent-proxy shim.
//
// Mechanism under test (docs/factory-run/stage11/DISORIENTATION-INVESTIGATION.md,
// sharpened by the 2026-08-18 lab run): opencode 1.18.18 resolves the session
// base directory as `path.resolve(process.env.PWD ?? process.cwd())`. A PWD
// inherited from the factory shell (rooted at the factory repository) beats the
// true spawn cwd (product sandbox), so every worker session anchors at the
// factory root and resolves relative desk paths against the wrong tree.
//
// The fix: the shim must pin the session directory explicitly —
//   - read the declared-but-swallowed `--cwd` claude flag (claude-shim VALUE_FLAGS),
//   - default to the shim's own process cwd,
//   - pass it to opencode as `--dir` (documented `opencode run` pinning flag),
//   - override env.PWD so no opencode code path can re-inherit the stale value,
//   - spawn opencode with an explicit `cwd`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import url from 'node:url';

const shimPath = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../tools/agent-proxy/claude-shim.mjs');

async function importShim() {
  return import(url.pathToFileURL(shimPath).href);
}

test('parseArgv: --cwd is a VALUE_FLAG and its value is captured', async () => {
  const { parseArgv } = await importShim();
  const parsed = parseArgv(['-p', '--bare', '--model', 'glm-4.7', '--cwd', 'D:/somewhere/product']);
  assert.equal(parsed.values['--cwd'], 'D:/somewhere/product',
    '--cwd must land in parsed.values (declared in VALUE_FLAGS since the shim origin)');
});

test('buildSessionPinning: pins shim cwd by default (dir args + env.PWD + spawn cwd)', async () => {
  const { buildSessionPinning } = await importShim();
  const pin = buildSessionPinning({}, process.cwd());
  assert.equal(pin.sessionDir, process.cwd());
  assert.deepEqual(pin.dirArgs, ['--dir', process.cwd()],
    'opencode run must receive --dir so the session base is explicit');
  assert.deepEqual(pin.envPatch, { PWD: process.cwd() },
    'env.PWD must be overridden — opencode prefers process.env.PWD over process.cwd()');
  assert.equal(pin.spawnCwd, process.cwd());
});

test('buildSessionPinning: honors --cwd when the runner passes it', async () => {
  const { buildSessionPinning } = await importShim();
  const custom = path.resolve(os.tmpdir(), 'runner-specified-product');
  const pin = buildSessionPinning({ '--cwd': custom }, '/default/cwd');
  assert.equal(pin.sessionDir, custom);
  assert.deepEqual(pin.dirArgs, ['--dir', custom]);
  assert.deepEqual(pin.envPatch, { PWD: custom });
  assert.equal(pin.spawnCwd, custom);
});

test('buildSessionPinning: resolves a relative --cwd against the shim cwd', async () => {
  const { buildSessionPinning } = await importShim();
  const pin = buildSessionPinning({ '--cwd': 'nested/product' }, '/base');
  assert.equal(pin.sessionDir, path.resolve('/base', 'nested/product'));
});

test('buildSessionPinning: flags an inherited mismatched PWD (loud, not silent)', async () => {
  const { buildSessionPinning } = await importShim();
  const pin = buildSessionPinning({}, process.cwd());
  // Explicit fixtures only — the ambient PWD form (posix/windows) differs by
  // host shell and must not decide this test.
  assert.equal(pin.inheritedPwdMismatch(path.join(process.cwd(), 'factory-root')), true,
    'a PWD pointing anywhere other than the session dir is a stale inheritance');
  assert.equal(pin.inheritedPwdMismatch(process.cwd()), false);
  assert.equal(pin.inheritedPwdMismatch(undefined), false);
});

// ---------------------------------------------------------------------------
// Integration: run the real shim as a child process against a fake opencode
// bin (compound SAGA_PROXY_OPENCODE_PATH, the runner's SAGA_REAL_CLAUDE_PATH
// convention) and verify what opencode actually receives.
// ---------------------------------------------------------------------------

function runShimAgainstFakeBin({ argv, env, stdin, cwd }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shim-cwd-test-'));
  const recordPath = path.join(root, 'opencode-saw.json');
  const fakeBin = path.join(root, 'fake-opencode.mjs');
  writeFileSync(fakeBin, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
    '  argv: process.argv.slice(2),',
    '  cwd: process.cwd(),',
    '  envPwd: process.env.PWD ?? null,',
    '}));',
    '',
  ].join('\n'));
  // The compound-path convention (like SAGA_REAL_CLAUDE_PATH) requires a
  // space-free executable path; node.exe lives under "Program Files", so the
  // compound entry is ComSpec (space-free) with a `/c node <script>` prefix.
  const launcher = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  const childEnv = {
    ...process.env,
    ...env,
    SAGA_PROXY_OPENCODE_PATH: `${launcher} /c node ${fakeBin}`,
    SAGA_TEST_RECORD_PATH: recordPath,
  };
  delete childEnv.SAGA_RUN_ID; // keep --title out of the assertion surface
  const res = spawnSync(process.execPath, [shimPath, ...argv], {
    cwd, env: childEnv, input: stdin ?? '', encoding: 'utf8', timeout: 30000,
  });
  let saw = null;
  try { saw = JSON.parse(readFileSync(recordPath, 'utf8')); } catch { /* not reached */ }
  return { res, saw, root };
}

test('integration: shim pins the session dir against an inherited stale PWD', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shim-product-'));
  const staleFactoryRoot = path.join(root, 'factory-root');
  const product = path.join(root, 'factory-root', 'product');
  mkdirSync(product, { recursive: true });
  const { res, saw, root: tmp } = runShimAgainstFakeBin({
    argv: ['-p', '--bare', '--model', 'glm-4.7'],
    env: { PWD: staleFactoryRoot }, // the disorientation payload: inherited PWD beats cwd
    stdin: 'do the task',
    cwd: product,
  });
  try {
    assert.equal(res.status, 0, `shim exited ${res.status}: ${res.stderr}`);
    assert.ok(saw, 'fake opencode must have been spawned');
    const dirIdx = saw.argv.indexOf('--dir');
    assert.notEqual(dirIdx, -1, `opencode argv must contain --dir, saw: ${saw.argv.join(' ')}`);
    assert.equal(saw.argv[dirIdx + 1], product, '--dir must point at the product cwd');
    assert.equal(saw.envPwd, product,
      'env.PWD handed to opencode must be pinned to the product, not the inherited factory root');
    assert.equal(saw.cwd, product, 'opencode must be spawned with cwd=product');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration: --cwd passed to the shim reaches opencode as --dir', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shim-product-'));
  const custom = path.join(root, 'runner-cwd-product');
  const unrelated = path.join(root, 'unrelated');
  mkdirSync(custom, { recursive: true });
  mkdirSync(unrelated, { recursive: true });
  const { res, saw, root: tmp } = runShimAgainstFakeBin({
    argv: ['-p', '--model', 'glm-4.7', '--cwd', custom],
    env: {},
    stdin: 'do the task',
    cwd: unrelated,
  });
  try {
    assert.equal(res.status, 0, `shim exited ${res.status}: ${res.stderr}`);
    const dirIdx = saw.argv.indexOf('--dir');
    assert.notEqual(dirIdx, -1, `opencode argv must contain --dir, saw: ${saw.argv.join(' ')}`);
    assert.equal(saw.argv[dirIdx + 1], custom, '--dir must mirror the claude-contract --cwd');
    assert.equal(saw.envPwd, custom);
    assert.equal(saw.cwd, custom);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
