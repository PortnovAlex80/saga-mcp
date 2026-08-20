// tests/factory-e2e/w9-06-scope-widening.test.mjs
//
// W9-06 — scope insufficiency as a lawful transition (stage-13 brief TASK 1).
// Each test spawns the isolated drive script (determinism without module
// state contamination) for one scenario and succeeds only on its exit 0 +
// JSON evidence line. The drive script carries the scenario assertions.

import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVE = path.join(HERE, 'w9-06-scope-widening-drive.mjs');

function drive(scenario) {
  return spawnSync(process.execPath, [DRIVE], {
    cwd: process.cwd(),
    env: { ...process.env, W9_SCENARIO: scenario, W9_DRIVE_LABEL: scenario },
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    windowsHide: true,
  });
}

test('w9-06 grant: trajectory-declared insufficiency → contention grant → wider revision → lifecycle completes', () => {
  const run = drive('grant');
  const evidenceLine = (run.stdout || '').trim().split('\n').pop() || '';
  if (run.status !== 0) {
    console.error(run.stderr);
  }
  if (run.status === 0 && evidenceLine.startsWith('{')) {
    const evidence = JSON.parse(evidenceLine);
    console.log(`[w9-06 grant] cycles=${evidence.cycles} invocations=${evidence.scriptedInvocationCount} scopeReceipts=${evidence.scopeReceiptCount}`);
  }
  if (run.status !== 0) {
    throw new Error(`drive exited ${run.status}: ${(run.stderr || '').slice(-4000)}`);
  }
});

test('w9-06 declared: worker concludes scope-insufficient → grant → retry passes → lifecycle completes', () => {
  const run = drive('declared');
  const evidenceLine = (run.stdout || '').trim().split('\n').pop() || '';
  if (run.status !== 0) {
    console.error(run.stderr);
  }
  if (run.status === 0 && evidenceLine.startsWith('{')) {
    const evidence = JSON.parse(evidenceLine);
    console.log(`[w9-06 declared] cycles=${evidence.cycles} invocations=${evidence.scriptedInvocationCount} scopeReceipts=${evidence.scopeReceiptCount}`);
  }
  if (run.status !== 0) {
    throw new Error(`drive exited ${run.status}: ${(run.stderr || '').slice(-4000)}`);
  }
});
