import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The module under test reads SAGA_ENGINE_LOG PER CALL (not at import), so
// the env can be flipped around individual calls. Import once, then control
// behavior through the env in each test.
const {
  engineLog,
  engineHeartbeatTouch,
  enginePhaseMark,
  initEngineMarkers,
} = await import('../../dist/runtime/engine-file-logger.js');

function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withEngineLogEnv(logPath, body) {
  const previous = process.env.SAGA_ENGINE_LOG;
  if (logPath === undefined) delete process.env.SAGA_ENGINE_LOG;
  else process.env.SAGA_ENGINE_LOG = logPath;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.SAGA_ENGINE_LOG;
    else process.env.SAGA_ENGINE_LOG = previous;
  }
}

test('engineLog appends one line per call to $SAGA_ENGINE_LOG', () => {
  const dir = tempDir('saga-engine-log-');
  const logPath = path.join(dir, 'engine.log');
  withEngineLogEnv(logPath, () => {
    engineLog('[test] first');
    engineLog('[test] second');
    assert.equal(readFileSync(logPath, 'utf8'), '[test] first\n[test] second\n');
  });
  rmSync(dir, { recursive: true, force: true });
});

test('engineLog appends a newline when the line lacks one', () => {
  const dir = tempDir('saga-engine-log-nl-');
  const logPath = path.join(dir, 'engine.log');
  withEngineLogEnv(logPath, () => {
    writeFileSync(logPath, '');
    engineLog('partial');
    engineLog('complete\n');
    assert.equal(readFileSync(logPath, 'utf8'), 'partial\ncomplete\n');
  });
  rmSync(dir, { recursive: true, force: true });
});

test('engineLog and markers are a silent NOOP when SAGA_ENGINE_LOG is unset', () => {
  const dir = tempDir('saga-engine-noop-');
  withEngineLogEnv(undefined, () => {
    // Must not throw and must not create any file — in-process hosts, tests
    // and the panel never set this env.
    engineLog('[test] must vanish');
    engineHeartbeatTouch();
    enginePhaseMark('must-vanish');
    initEngineMarkers();
    assert.equal(readdirSync(dir).length, 0, 'no files may appear without the env');
  });
  rmSync(dir, { recursive: true, force: true });
});

test('engineLog never throws when the log path is unwritable', () => {
  // A path inside a directory that does not exist: the append fails with
  // ENOENT, which must be swallowed — a broken log sink must not become a
  // broken engine.
  const missingDir = path.join(
    os.tmpdir(),
    `saga-missing-${Date.now()}-${process.pid}`,
    'nested',
  );
  withEngineLogEnv(path.join(missingDir, 'engine.log'), () => {
    assert.doesNotThrow(() => engineLog('[test] into the void'));
    assert.doesNotThrow(() => enginePhaseMark('void'));
    assert.doesNotThrow(() => engineHeartbeatTouch());
    assert.doesNotThrow(() => initEngineMarkers());
  });
});

test('initEngineMarkers creates the heartbeat file; touch bumps its mtime without growing it', () => {
  const dir = tempDir('saga-engine-hb-');
  const logPath = path.join(dir, 'engine.log');
  writeFileSync(logPath, '');
  withEngineLogEnv(logPath, () => {
    initEngineMarkers();
    const heartbeatPath = `${logPath}.heartbeat`;
    assert.ok(existsSync(heartbeatPath), 'heartbeat file must exist after init');
    // utimes-based touch must not grow the file.
    assert.equal(statSync(heartbeatPath).size, 0);

    // Simulate a stale heartbeat (freeze), then verify touch advances it.
    const past = new Date(Date.now() - 60_000);
    utimesSync(heartbeatPath, past, past);
    const staleMs = statSync(heartbeatPath).mtimeMs;
    engineHeartbeatTouch();
    const freshMs = statSync(heartbeatPath).mtimeMs;
    assert.ok(freshMs > staleMs, `mtime must advance on touch (${freshMs} > ${staleMs})`);
    assert.equal(statSync(heartbeatPath).size, 0, 'touch must keep the file empty');
  });
  rmSync(dir, { recursive: true, force: true });
});

test('enginePhaseMark appends short phase lines; init truncates an oversized phase file', () => {
  const dir = tempDir('saga-engine-phase-');
  const logPath = path.join(dir, 'engine.log');
  writeFileSync(logPath, '');
  const phasePath = `${logPath}.phase`;
  withEngineLogEnv(logPath, () => {
    enginePhaseMark('runEpisode');
    enginePhaseMark('dispatch');
    const lines = readFileSync(phasePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^[\dT:.Z-]+ runEpisode$/);
    assert.match(lines[1], /^[\dT:.Z-]+ dispatch$/);

    // An oversized phase file (>64KB after days of running) is truncated at
    // engine start so the last phase stays cheap to read after a freeze.
    writeFileSync(phasePath, 'x'.repeat(64 * 1024 + 1));
    initEngineMarkers();
    assert.equal(statSync(phasePath).size, 0, 'oversized phase file must be truncated');

    // A small phase file is left alone by init.
    enginePhaseMark('survivor');
    initEngineMarkers();
    assert.match(readFileSync(phasePath, 'utf8'), /survivor\n$/);
  });
  rmSync(dir, { recursive: true, force: true });
});
