/**
 * budget-drivers.test.mjs - the EK-9 context-budget dimension (WP-13B):
 * all twelve required drivers as DATA records over the public admission
 * command + the admitting transport, each with an independently authored
 * expectation (from the frozen accountant check order and refusal
 * vocabulary). Declared must equal demonstrated.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  budgetProfile,
  contextBudgetDrivers,
  driverEnvelope,
  envelopeTokenCount,
  requestInputCap,
  runBudgetDriver,
  effectiveInputLimit,
} from '../../../dist/workflow-kernel/testing/dimension-drivers.js';
import { serializeEnvelopeLayers, normalizeEnvelopeLayers } from '../../../dist/workflow-kernel/context-envelope/receipt.js';

test('the twelve required context-budget drivers exist as data with authored expectations', () => {
  const drivers = contextBudgetDrivers();
  assert.deepEqual(
    drivers.map((driver) => driver.id),
    [
      'one-token-below', 'exact-limit', 'one-token-above', 'reduced-provider-limit', 'duplicate-history',
      'raw-product-metadata', 'disabled-zero-cap', 'silent-truncation-attempt', 'large-reference',
      'token-counter-drift', 'concurrent-admission', 'output-limit-mismatch',
    ],
  );
  for (const driver of drivers) assert.ok(driver.requirement.length > 0, `${driver.id} carries its requirement text`);
});

test('declared equals demonstrated for every budget driver', async () => {
  for (const driver of contextBudgetDrivers()) {
    const run = await runBudgetDriver(driver);
    const expected = driver.expected;

    // Admission half.
    if (expected.admission === 'admitted') {
      assert.equal(run.admission.kind, 'admitted', `${driver.id}: admission is admitted`);
    } else {
      assert.equal(run.admission.kind, 'refused', `${driver.id}: admission is refused`);
      assert.equal(run.admission.violation, expected.admission.refusedWith, `${driver.id}: the typed violation is the authored one`);
    }

    // Transport half (present only when admission was expected to succeed).
    if (expected.transport !== undefined) {
      assert.ok(run.send, `${driver.id}: the send ran`);
      if (expected.transport === 'delivered') {
        assert.equal(run.send.kind, 'delivered', `${driver.id}: delivered`);
      } else if (expected.transport === 'effect-uncertainty') {
        assert.equal(run.send.kind, 'effect-uncertainty', `${driver.id}: D12 uncertainty`);
      } else {
        assert.equal(run.send.kind, 'refused', `${driver.id}: the send is refused`);
        assert.equal(run.send.refusal.kind, expected.transport.refusedWith, `${driver.id}: the typed pre-send refusal is the authored one`);
      }
    }

    // Concurrent-admission half.
    if (expected.secondAdmission !== undefined) {
      assert.ok(run.secondAdmission, `${driver.id}: the second admission ran`);
      if ('staleRevision' in expected.secondAdmission) {
        assert.equal(run.secondAdmission.kind, 'stale-revision', `${driver.id}: exactly one CAS win, one stale typed refusal`);
      }
    }
  }
});

test('the boundary drivers are exact: one below admits, exact admits, one above refuses', async () => {
  const profile = budgetProfile();
  const cap = requestInputCap(profile);
  assert.equal(cap, 5000, 'min(maxTotalInputTokens, effectiveInputLimit) with the driver profile');
  assert.equal(effectiveInputLimit(profile), 131072 - 8192 - 2048 - 4096);

  const below = await runBudgetDriver(contextBudgetDrivers().find((driver) => driver.id === 'one-token-below'));
  assert.equal(below.admission.kind, 'admitted');
  assert.equal(below.admission.receipt.requestInputTokens, cap - 1, 'the receipt records the exact token count');

  const exact = await runBudgetDriver(contextBudgetDrivers().find((driver) => driver.id === 'exact-limit'));
  assert.equal(exact.admission.kind, 'admitted');
  assert.equal(exact.admission.receipt.requestInputTokens, cap, 'exactly at the cap');

  const above = await runBudgetDriver(contextBudgetDrivers().find((driver) => driver.id === 'one-token-above'));
  assert.equal(above.admission.kind, 'refused');
  assert.ok(above.admission.violationDetail.includes('> per-request cap'), 'the refusal names the cap formula');
});

test('token-counter drift is a typed mismatch and never a silent recount', async () => {
  const run = await runBudgetDriver(contextBudgetDrivers().find((driver) => driver.id === 'token-counter-drift'));
  assert.equal(run.counterIdentityDrift, true, 'the driver profile pins a drifted counter digest');
  assert.equal(run.admission.kind, 'refused');
  assert.equal(run.admission.violation, 'TOKEN_COUNTER_MISMATCH');
  assert.ok(run.admission.violationDetail.includes('never a silent recount'));
});

test('the silent-truncation attempt is refused at the pre-send boundary (bytes equal the admitted receipt)', async () => {
  const driver = contextBudgetDrivers().find((entry) => entry.id === 'silent-truncation-attempt');
  const run = await runBudgetDriver(driver);
  assert.equal(run.admission.kind, 'admitted');
  assert.equal(run.send.kind, 'refused');
  assert.equal(run.send.refusal.kind, 'ENVELOPE_DIGEST_MISMATCH');
  // The admitted receipt serialized exactly the ORIGINAL bytes; the
  // truncated envelope serializes differently, and the boundary proves it.
  const normalized = normalizeEnvelopeLayers(driver.envelope.layers);
  const canonical = serializeEnvelopeLayers(normalized.ordered);
  assert.equal(Buffer.byteLength(canonical, 'utf8'), run.admission.receipt.serializedRequestBytes, 'the receipt counted exactly the admitted bytes');
});

test('an oversized hook additionalContext lands in the exact next receipt and is refused before network send', async () => {
  // Oversized hook layer: the dynamic budget refuses it; the refusal
  // receipt persists the rejected envelope digest (pre-network evidence).
  const profile = budgetProfile({ maxDynamicTokens: 100 });
  const driver = {
    id: 'oversized-hook-context',
    requirement: 'an oversized hook additionalContext is refused before network send',
    profile,
    envelope: driverEnvelope({ staticEach: 3, task: 10, workspace: 10, hook: 500 }),
    expected: { admission: { refusedWith: 'MAX_DYNAMIC_TOKENS_EXCEEDED' } },
  };
  const run = await runBudgetDriver(driver);
  assert.equal(run.admission.kind, 'refused');
  assert.equal(run.admission.violation, 'MAX_DYNAMIC_TOKENS_EXCEEDED');
  assert.equal(run.admission.receipt.decision, 'refused', 'the refused receipt persists the rejection');
  assert.ok(run.admission.receipt.rejectedEnvelopeDigest.startsWith('sha256:'), 'the rejected-envelope digest is recorded');
  assert.equal(run.send, undefined, 'the transport never serialized or sent');
});

test('RED kill: a transport that skips the pre-send boundary is caught (budget-bypass fence)', async () => {
  const driver = contextBudgetDrivers().find((entry) => entry.id === 'silent-truncation-attempt');

  // GREEN: the conforming transport refuses the truncated bytes.
  const clean = await runBudgetDriver(driver);
  assert.equal(clean.send.kind, 'refused');

  // The FENCE: whatever the transport claims, the bytes that would reach the
  // channel must equal the admitted receipt's serialization. Under the
  // MUTATION (a transport that skips the boundary check and sends the
  // truncated envelope), the fence is RED.
  const truncated = { layers: driver.envelope.layers.slice(0, -1) };
  const mutatedSerialized = serializeEnvelopeLayers(normalizeEnvelopeLayers(truncated.layers).ordered);
  const fence = (serialized, receipt) => {
    assert.equal(Buffer.byteLength(serialized, 'utf8'), receipt.serializedRequestBytes, 'FENCE RED: unaccounted bytes would reach the network');
  };
  let fenceRed = false;
  try {
    fence(mutatedSerialized, clean.admission.receipt); // the mutated transport "delivered" truncated bytes
  } catch {
    fenceRed = true;
  }
  assert.equal(fenceRed, true, 'the fence is red under the mutation (kill demonstrated)');

  // GREEN on the clean kernel: the ADMITTED bytes satisfy the fence.
  const admittedSerialized = serializeEnvelopeLayers(normalizeEnvelopeLayers(driver.envelope.layers).ordered);
  fence(admittedSerialized, clean.admission.receipt);
});

test('concurrent admission charges exactly once: the CAS win advances, the loser consumes nothing', async () => {
  const driver = contextBudgetDrivers().find((entry) => entry.id === 'concurrent-admission');
  const run = await runBudgetDriver(driver);
  assert.equal(run.admission.kind, 'admitted');
  assert.equal(run.secondAdmission.kind, 'stale-revision');
  assert.ok(run.secondAdmission.detail.includes('nothing consumed') || run.secondAdmission.detail.includes('stale'), 'the stale loser consumed nothing');
  assert.equal(run.admission.nextCounters.contextRevision, 1, 'exactly one revision advance');
  assert.equal(envelopeTokenCount(driver.envelope) <= requestInputCap(budgetProfile()), true);
});
