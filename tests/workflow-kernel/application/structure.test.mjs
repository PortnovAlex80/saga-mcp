/**
 * structure.test.mjs - structural laws of the EK-4 application layer
 * (WP-07): no progress may ever be inferred from a board, a heartbeat or a
 * clock; the fault-point registry is closed and complete; repository
 * routing fails closed; and the layer never widens the kernel vocabulary.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const applicationRoot = fileURLToPath(new URL('../../../src/workflow-kernel/application/', import.meta.url));
const applicationFiles = readdirSync(applicationRoot)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => join(applicationRoot, name));

const { FAULT_POINTS, FaultScheduler, commandFaultPoints } = await import('../../../dist/workflow-kernel/application/faults.js');
const consumer = await import('../../../dist/workflow-kernel/application/obligation-consumer.js');
const { freshDatabase } = await import('./driver.mjs');

/** Source with comments stripped: the guard scans CODE, not prose. */
function codeOf(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('the application layer never reads a board, a heartbeat or a clock', () => {
  const forbidden = [
    /\bkanban\b/i,
    /\bcard_id\b/i,
    /\blane\b/i,
    /Date\.now/,
    /performance\.now/,
    /setTimeout/,
    /setInterval/,
    /heartbeat/i,
    /process\.uptime/,
  ];
  const violations = [];
  for (const file of applicationFiles) {
    const source = codeOf(file);
    for (const pattern of forbidden) {
      const match = source.match(pattern);
      if (match) violations.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(violations, [], 'progress is never inferred from a board, a heartbeat or time');
});

test('the fault-point registry is closed: 16 points in before/after pairs over 8 boundaries', () => {
  assert.equal(FAULT_POINTS.length, 16);
  const before = FAULT_POINTS.filter((point) => point.startsWith('before-'));
  const after = FAULT_POINTS.filter((point) => point.startsWith('after-'));
  assert.equal(before.length, 8);
  assert.equal(after.length, 8);
  for (const point of before) {
    assert.ok(FAULT_POINTS.includes(`after-${point.slice('before-'.length)}`), `${point} has its after-pair`);
  }
  assert.throws(() => new FaultScheduler('before-not-a-real-point'), /unknown fault point/, 'arming an unknown point fails closed');
  assert.throws(() => new FaultScheduler('before-gate', 0), /positive integer/);
});

test('the command fault classification covers the send/outcome/gate/effect boundaries and nothing else', () => {
  assert.deepEqual([...commandFaultPoints('cognition.sendProviderRequest')], ['before-worker-spawn', 'before-provider-send', 'after-provider-send', 'after-worker-spawn']);
  assert.deepEqual([...commandFaultPoints('activityAttempt.recordOutcome')], ['before-worker-return', 'after-worker-return']);
  assert.deepEqual([...commandFaultPoints('workplace.runAuthorGate')], ['before-gate', 'after-gate']);
  assert.deepEqual([...commandFaultPoints('workplace.runFinalGate')], ['before-gate', 'after-gate']);
  assert.deepEqual([...commandFaultPoints('workplace.settleEffect')], ['before-effect', 'after-effect']);
  assert.deepEqual([...commandFaultPoints('workplace.materialize')], []);
});

test('repository routing fails closed on an unknown aggregate', () => {
  const db = freshDatabase('ek-wp07-structure-');
  const session = db.open();
  try {
    assert.throws(() => consumer.repositoryOf(session, 'NotAnAggregate'), /unknown target aggregate/);
  } finally {
    session.close();
  }
});

test('the application layer owns exactly the four WP-07 modules (one obligation-consumer protocol)', () => {
  assert.deepEqual(
    applicationFiles.map((file) => file.split(/[\\/]/).pop()).sort(),
    ['admission.ts', 'faults.ts', 'obligation-consumer.ts', 'waits.ts'],
    'exactly one obligation-consumer implementation - the EK-1 budget dimension counts this stem, target exact:1',
  );
});
