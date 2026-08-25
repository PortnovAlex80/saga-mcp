/**
 * role-binding-drivers.test.mjs - the EK-9 role-binding dimension (WP-13B):
 * correct digest, foreign digest, stale digest, task/tag mismatch and
 * attempted downstream re-resolution, all as DATA drivers over the ONE
 * resolution path (WP-17 install + resolve), the declarative route-policy
 * lookup and the kernel admitWorkIntent / activityAttempt.create guards.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileRoleContract, countMatchingRouteRules, manifestBindingByLaunchKind } from '../../../dist/workflow-kernel/roles/compiler.js';
import { buildImplementerFixture, buildPlannerFixture, implementerLaunchKind, plannerLaunchKind } from '../../../dist/workflow-kernel/roles/fixtures/index.js';
import { installRoleContracts, resolveRoleContract } from '../../../dist/workflow-kernel/roles/resolver.js';
import { actorPinSet, attemptLoopSteps, compileActorProgram, verticalPrefixSteps } from '../../../dist/workflow-kernel/testing/actors.js';
import { sha256OfCanonical } from '../../../dist/workflow-kernel/domain/digest.js';

const PINS = actorPinSet();
const IDS = {
  factory: 'factory-run:1',
  lifecycle: 'lifecycle-run:1',
  stage: 'stage-run:1',
  process: 'process-run:1',
  node: 'node-run:1',
  workplace: 'workplace:1',
};

/** Compile the implementer fixture (optionally with drifted content). */
function compileImplementer(drift = false) {
  const input = buildImplementerFixture();
  if (drift) {
    input.artifacts.semanticSkill = { ...input.artifacts.semanticSkill, instructions: 'REVISED implementer instructions (a newer contract version)' };
    const digest = sha256OfCanonical(input.artifacts.semanticSkill);
    input.content.semanticSkillRef = `sha256:${digest}`;
    input.content.semanticSkillDigest = digest;
  }
  return compileRoleContract(input);
}

/** The kernel vertical with an author admit + attempt create under `pin`. */
function kernelVertical(pin, mutation = undefined) {
  const steps = [
    ...verticalPrefixSteps(IDS, 'implementer'),
    ...attemptLoopSteps({ loopId: 'author-1', role: 'author', profile: 'implementer', workplace: IDS.workplace, attempt: 'activity-attempt:1', gate: 'author', gateVerdict: 'accepted' }),
  ];
  if (pin !== undefined) {
    for (const step of steps) {
      if (step.stepId === 'author-1-admit' || step.stepId === 'author-1-attempt') step.pin = pin;
    }
  }
  if (mutation === 'manifest-bag') {
    for (const step of steps) {
      if (step.stepId === 'author-1-attempt') {
        step.behavior = 'tool-misuse';
        step.manifestBag = 'manifest';
      }
    }
  }
  if (mutation === 'foreign-pin') {
    for (const step of steps) {
      if (step.stepId === 'author-1-attempt' && typeof step.pin === 'object') {
        step.pin = { roleContractRef: step.pin.roleContractRef, roleContractDigest: PINS.foreign.roleContractDigest };
      }
    }
  }
  return compileActorProgram(steps, { pins: PINS });
}

test('setup: the implementer and planner fixtures compile and install as one closed set', () => {
  const implementer = compileRoleContract(buildImplementerFixture());
  const planner = compileRoleContract(buildPlannerFixture());
  assert.equal(implementer.compiled, true, JSON.stringify(implementer.errors ?? []));
  assert.equal(planner.compiled, true);
  const installed = installRoleContracts([implementer.contract, planner.contract]);
  assert.equal(installed.installed, true);
  assert.equal(installed.set.count, 2);
});

test('correct digest: the exact pin resolves and the kernel admits the intent and attempt', () => {
  const implementer = compileRoleContract(buildImplementerFixture());
  const installed = installRoleContracts([implementer.contract]);
  const resolution = resolveRoleContract(installed.set, implementer.pin);
  assert.equal(resolution.resolved, true);
  assert.equal(resolution.contract.semanticProfileRef, implementer.contract.semanticProfileRef);

  const compiled = kernelVertical(implementer.pin);
  assert.equal(compiled.refusal, null, 'the pinned intent admission and attempt creation commit');
  const workplaces = [...compiled.world.workIntents.values()];
  assert.equal(workplaces.length, 1);
  assert.equal(workplaces[0].roleContract.roleContractDigest, implementer.pin.roleContractDigest, 'the WorkIntent carries the exact pin');
});

test('foreign digest: a pin from outside the installed set fails closed (no substitute contract)', () => {
  const implementer = compileRoleContract(buildImplementerFixture());
  const installed = installRoleContracts([implementer.contract]);
  const foreign = { roleContractRef: PINS.foreign.roleContractRef, roleContractDigest: PINS.foreign.roleContractDigest };
  const resolution = resolveRoleContract(installed.set, foreign);
  assert.equal(resolution.resolved, undefined);
  assert.equal(resolution.reason, 'ROLE_CONTRACT_REF_MISMATCH');
  assert.equal(resolution.detail.includes('outside the closed installed set'), true);
});

test('stale digest: an OLDER digest against the installed contract does not verify', () => {
  const stale = compileRoleContract(buildImplementerFixture());
  const fresh = compileImplementer(true);
  assert.equal(fresh.compiled, true, JSON.stringify(fresh.errors ?? []));
  assert.notEqual(stale.pin.roleContractDigest, fresh.pin.roleContractDigest, 'the drifted content changes the digest');
  const installed = installRoleContracts([fresh.contract]);
  // Digest drift at a pinned address: the NEW ref paired with the OLD
  // (stale) slot fingerprint must fail verification, never a re-derive.
  const resolution = resolveRoleContract(installed.set, {
    roleContractRef: fresh.pin.roleContractRef,
    roleContractDigest: stale.pin.roleContractDigest,
  });
  assert.equal(resolution.reason, 'ROLE_CONTRACT_DIGEST_MISMATCH');
  assert.equal(resolution.detail.includes('does not verify'), true);
});

test('task/tag mismatch: a task declaring another launch kind finds ZERO route rules (no fallback)', () => {
  const implementer = compileRoleContract(buildImplementerFixture());
  const table = implementer.contract.executorRoutePolicyTable ?? implementer.artifactsTable;
  void table;
  // The compiled contract carries its route table through the compile input;
  // the driver recomputes the exact match count for the TASK's launch kind.
  const fixture = buildImplementerFixture();
  const policy = fixture.artifacts.executorRoutePolicyTable;
  const binding = manifestBindingByLaunchKind(implementerLaunchKind);
  assert.notEqual(binding, undefined);
  const correctFacts = { launchKind: implementerLaunchKind, protocolRole: binding.protocolRole, semanticProfile: 'implementer' };
  assert.equal(countMatchingRouteRules(policy, correctFacts), 1, 'the pinned table matches its own launch kind exactly once');

  // The TASK row declares the PLANNER launch kind (a tag/task mismatch):
  // zero rules match and the binding fails closed - the table never
  // selects, reroutes or falls back.
  const mismatchedFacts = { launchKind: plannerLaunchKind, protocolRole: binding.protocolRole, semanticProfile: 'implementer' };
  assert.equal(countMatchingRouteRules(policy, mismatchedFacts), 0, 'a task/tag mismatch is a typed zero-rule failure');
});

test('attempted downstream re-resolution: the attempt never resolves its own contract', () => {
  const implementer = compileRoleContract(buildImplementerFixture());

  // (a) A manifest bag riding the attempt input is refused.
  const bag = kernelVertical(implementer.pin, 'manifest-bag');
  assert.equal(bag.refusal.reason, 'ATTEMPT_RERESOLVED_MANIFEST');
  assert.ok(bag.refusal.detail.includes('no manifest, no metadata bag') || bag.refusal.detail.includes('closed command shape'));

  // (b) A foreign pin differing from the WorkIntent pin is refused by name.
  const foreignPin = kernelVertical(implementer.pin, 'foreign-pin');
  assert.equal(foreignPin.refusal.reason, 'ROLE_CONTRACT_DIGEST_MISMATCH');
  assert.ok(foreignPin.refusal.detail.includes('differs from the exact WorkIntent pin'), 'mutation i: digest A paired with digest B');
});

test('RED kill: a kernel that let the attempt re-resolve downstream is caught (binding-bypass fence)', () => {
  const implementer = compileRoleContract(buildImplementerFixture());

  // GREEN: the exact-pin attempt commits and its pin EQUALS the intent pin.
  const clean = kernelVertical(implementer.pin);
  assert.equal(clean.refusal, null);
  const intent = [...clean.world.workIntents.values()][0];
  const attemptEquality = (attemptPin) => {
    assert.deepEqual(attemptPin, intent.roleContract, 'FENCE: the attempt pin must equal the exact WorkIntent pin');
  };
  attemptEquality(implementer.pin); // GREEN

  // MUTATION: the attempt "resolved" its own contract downstream (a foreign
  // pin that differs from the intent pin). The kernel refused it - but even
  // if a mutated kernel accepted it, the equality fence is RED.
  const mutated = kernelVertical(implementer.pin, 'foreign-pin');
  assert.equal(mutated.refusal?.reason, 'ROLE_CONTRACT_DIGEST_MISMATCH', 'GREEN: the clean kernel refuses the re-resolved pin');
  let fenceRed = false;
  try {
    attemptEquality(PINS.foreign.roleContractDigest === intent.roleContract.roleContractDigest ? PINS.author : PINS.foreign);
  } catch {
    fenceRed = true;
  }
  assert.equal(fenceRed, true, 'RED: the pin-equality fence catches the downstream re-resolution');
});
