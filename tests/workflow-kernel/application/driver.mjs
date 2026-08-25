/**
 * driver.mjs - the EK-4 stateless crash-recovery driver (WP-07 test support).
 *
 * The driver is a SCRIPTED conveyor vertical over the fresh protocol:
 *
 *   bootstrap -> importCapsule -> [consumer] factoryRun.start
 *     -> [consumer] lifecycleRun.create -> [consumer] stageRun.create
 *     -> [driver] stageRun.activate -> [consumer] processRun.create
 *     -> [consumer] processRun.enterNode -> [driver] nodeRun.create
 *     -> [consumer] workplace.materialize
 *     -> author loop: admitWorkIntent -> attempt -> admission -> provider
 *        send -> worker outcome -> contribution -> seal -> present
 *        -> author gate (accepted) -> [consumer] reviewer desk
 *     -> reviewer loop (same shape) -> final gate (accepted)
 *     -> [consumer] effect settlement -> final acceptance
 *     -> [consumer] presentation close -> workplace terminal proof.
 *
 * STATELESS OVER DURABLE FACTS: every step checks its own durable
 * postcondition before applying, and every key is deterministic, so
 * re-driving the same database after ANY crash converges to the identical
 * logical outcome. The driver reads only kernel tables through public
 * surfaces - never Kanban, never a task status, never a heartbeat/clock.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { openKernelDatabase } = await import('../../../dist/workflow-kernel/persistence/database.js');
const { KernelPersistenceSession } = await import('../../../dist/workflow-kernel/persistence/session.js');
const { COMMANDS } = await import('../../../dist/workflow-kernel/domain/universe.js');
const consumer = await import('../../../dist/workflow-kernel/application/obligation-consumer.js');
const { FaultScheduler, commandFaultPoints } = await import('../../../dist/workflow-kernel/application/faults.js');

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

const COMMAND_AGGREGATE = new Map(COMMANDS.map((descriptor) => [descriptor.name, descriptor.aggregate]));

/** The external Input-authority evidence (CheckPlan + verifier actor results). */
export const EXTERNAL_INPUTS = [
  { kind: 'CheckPlan', ref: 'evidence:CheckPlan#external', producer: 'external-input', payloadDigest: sha256('checkplan') },
  { kind: 'ProductVerificationEvidence', ref: 'evidence:ProductVerificationEvidence#external', producer: 'external-input', payloadDigest: sha256('pve') },
  { kind: 'ProductVerificationFailure', ref: 'evidence:ProductVerificationFailure#external', producer: 'external-input', payloadDigest: sha256('pvf') },
];

/** Positive finite limits (EK-1 law: never zero, never unlimited). */
export const LIMITS = {
  providerContextLimitTokens: 200000,
  reservedOutputTokens: 16000,
  providerOverheadReserveTokens: 2000,
  safetyMarginTokens: 2000,
  maxTotalInputTokens: 120000,
  maxCumulativeSessionInputTokens: 400000,
  maxProviderRequests: 20,
};

export const envelopeOf = (attempt, tokens = 5000) => ({
  providerModel: 'zai/opencode-pin',
  requestInputTokens: tokens,
  envelopeDigest: `sha256:${sha256(`envelope:${attempt}:${tokens}`)}`,
});

/** Content-addressed role-contract pins (author and reviewer desks). */
export const authorPin = { roleContractRef: `sha256:${sha256('contract:author')}`, roleContractDigest: sha256('contract:author:body') };
export const reviewerPin = { roleContractRef: `sha256:${sha256('contract:reviewer')}`, roleContractDigest: sha256('contract:reviewer:body') };

export function freshDatabase(prefix = 'ek-wp07-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, 'kernel.sqlite');
  return { path, dir, open: () => new KernelPersistenceSession(openKernelDatabase(path)) };
}

const world = (session) => session.hydrateWorld().world;
const eventExists = (session, transition, instanceId) =>
  world(session).events.some((event) => event.transition === transition && event.sourceInstanceId === instanceId);
const intentOf = (session, workplaceId, role) =>
  [...world(session).workIntents.values()].find((intent) => intent.workplaceInstanceId === workplaceId && intent.protocolRole === role);
const headOf = (session, instanceId) => world(session).heads.get(instanceId);

function repoFor(session, command) {
  return consumer.repositoryOf(session, COMMAND_AGGREGATE.get(command));
}

/**
 * Apply one driver-direct command idempotently: skip when its durable
 * postcondition already holds, fire the fault boundaries, apply through the
 * owning repository.
 */
function ensureCommand(session, { command, instanceId, key, done, fields = {}, faults }) {
  if (done(session)) return { skipped: true };
  const head = headOf(session, instanceId);
  const input = {
    command,
    instanceId,
    expectedRevision: head === undefined ? 0 : head.revision,
    idempotencyKey: key,
    ...fields,
  };
  const options = { externalEvidence: EXTERNAL_INPUTS };
  for (const point of commandFaultPoints(command)) {
    if (point.startsWith('before-')) faults?.fire(point);
  }
  faults?.fire('before-durable-write');
  const outcome = repoFor(session, command).applyCommand(input, options);
  if (outcome.refused === true) {
    return { refused: outcome };
  }
  faults?.fire('after-durable-write');
  for (const point of commandFaultPoints(command)) {
    if (point.startsWith('after-')) faults?.fire(point);
  }
  return { committed: outcome };
}

/**
 * Consume the open obligation of one exact kind (frontier discipline: the
 * entry is by construction the lowest-id open obligation of its target).
 * Skips when none is open; a typed refusal is returned, never retried here.
 */
function consumeKind(session, kind, invocation, faults) {
  const frontier = consumer.openFrontier(session);
  const entry = frontier.find((candidate) => candidate.kind === kind);
  if (entry === undefined) return { skipped: true };
  if (entry.refusal !== undefined) {
    throw new Error(`driver: obligation ${kind} is unresolvable: ${entry.refusal.detail}`);
  }
  return consumer.consumeClaim(session, entry.claim, invocation, { externalEvidence: EXTERNAL_INPUTS, faults });
}

/* ------------------------------------------------------------------ */
/* The vertical                                                        */
/* ------------------------------------------------------------------ */

const ATTEMPT_1 = 'activity-attempt:1';
const ATTEMPT_2 = 'activity-attempt:2';
export const FACTORY = 'fr:1';
export const WORKPLACE = 'workplace:1';

/**
 * Drive the vertical from durable state. Stateless: call it after any crash
 * on a reopened session and it converges. `stopAfter` ends the run once the
 * named step completed (for wait/fault scenario staging).
 */
export function driveVertical(session, { faults = FaultScheduler.observing(), stopAfter = 'terminal-proof' } = {}) {
  let stopNow = false;
  const register = (id, run) => {
    if (stopNow) return;
    run();
    if (stopAfter === id) stopNow = true;
  };

  register('bootstrap', () => {
    ensureCommand(session, {
      command: 'factoryRun.bootstrap',
      instanceId: FACTORY,
      key: 'driver:bootstrap',
      done: (s) => eventExists(s, 'factoryRun.bootstrap', FACTORY),
      faults,
    });
  });
  register('import-capsule', () => {
    ensureCommand(session, {
      command: 'factoryRun.importCapsule',
      instanceId: FACTORY,
      key: 'driver:import-capsule',
      done: (s) => eventExists(s, 'factoryRun.importCapsule', FACTORY),
      faults,
    });
  });
  register('consume-start', () => consumeKind(session, 'obligation:ingestCapsuleFacts', {}, faults));
  register('consume-lifecycle-create', () => consumeKind(session, 'obligation:bootstrapLifecycleRun', {}, faults));
  register('consume-stage-create', () => consumeKind(session, 'obligation:enterStage.initial-discovery', {}, faults));
  register('activate-stage', () => {
    ensureCommand(session, {
      command: 'stageRun.activate',
      instanceId: 'stage-run:1',
      key: 'driver:activate-stage',
      done: (s) => eventExists(s, 'stageRun.activate', 'stage-run:1'),
      faults,
    });
  });
  register('consume-process-create', () => consumeKind(session, 'obligation:bindProcessModule', {}, faults));
  register('consume-enter-node', () => consumeKind(session, 'obligation:enterFirstNode', {}, faults));
  register('create-node', () => {
    ensureCommand(session, {
      command: 'nodeRun.create',
      instanceId: 'node-run:1',
      key: 'driver:create-node',
      done: (s) => eventExists(s, 'nodeRun.create', 'node-run:1'),
      faults,
    });
  });
  register('consume-workplace-materialize', () => consumeKind(session, 'obligation:materializeWorkplace.production-cell', {}, faults));
  register('admit-author-intent', () => {
    ensureCommand(session, {
      command: 'workplace.admitWorkIntent',
      instanceId: WORKPLACE,
      key: 'driver:admit-author',
      done: (s) => intentOf(s, WORKPLACE, 'author') !== undefined,
      fields: { protocolRole: 'author', rolePin: authorPin, evidenceRefs: ['evidence:driver-scope'] },
      faults,
    });
  });
  register('create-attempt-1', () => {
    const intent = intentOf(session, WORKPLACE, 'author');
    ensureCommand(session, {
      command: 'activityAttempt.create',
      instanceId: ATTEMPT_1,
      key: 'driver:attempt-1',
      done: (s) => headOf(s, ATTEMPT_1) !== undefined,
      fields: { workIntentRef: intent.intentRef, rolePin: intent.roleContract },
      faults,
    });
  });
  register('admission-1', () => consumeKind(session, 'obligation:launchAdmission', { admission: { envelope: envelopeOf(ATTEMPT_1), limits: LIMITS } }, faults));
  register('provider-send-1', () => consumeKind(session, 'obligation:providerSend', {}, faults));
  register('worker-return-1', () => {
    const intent = intentOf(session, WORKPLACE, 'author');
    ensureCommand(session, {
      command: 'activityAttempt.recordOutcome',
      instanceId: ATTEMPT_1,
      key: 'driver:outcome-1',
      done: (s) => headOf(s, ATTEMPT_1)?.status === 'outcome-recorded',
      fields: { evidenceRefs: [intent.intentRef] },
      faults,
    });
  });
  register('contribution-1', () => consumeKind(session, 'obligation:submitContribution', {}, faults));
  register('seal-1', () => consumeKind(session, 'obligation:sealRevision', {}, faults));
  register('present-1', () => consumeKind(session, 'obligation:presentCandidates', {}, faults));
  register('author-gate', () => consumeKind(session, 'obligation:runGate.author', { gateVerdict: 'accepted' }, faults));
  register('reviewer-desk', () => consumeKind(session, 'obligation:openReviewerDesk', { protocolRole: 'reviewer', rolePin: reviewerPin, evidenceRefs: ['evidence:reviewer-scope'] }, faults));
  register('create-attempt-2', () => {
    const intent = intentOf(session, WORKPLACE, 'reviewer');
    ensureCommand(session, {
      command: 'activityAttempt.create',
      instanceId: ATTEMPT_2,
      key: 'driver:attempt-2',
      done: (s) => headOf(s, ATTEMPT_2) !== undefined,
      fields: { workIntentRef: intent.intentRef, rolePin: intent.roleContract },
      faults,
    });
  });
  register('admission-2', () => consumeKind(session, 'obligation:launchAdmission', { admission: { envelope: envelopeOf(ATTEMPT_2), limits: LIMITS } }, faults));
  register('provider-send-2', () => consumeKind(session, 'obligation:providerSend', {}, faults));
  register('worker-return-2', () => {
    const intent = intentOf(session, WORKPLACE, 'reviewer');
    ensureCommand(session, {
      command: 'activityAttempt.recordOutcome',
      instanceId: ATTEMPT_2,
      key: 'driver:outcome-2',
      done: (s) => headOf(s, ATTEMPT_2)?.status === 'outcome-recorded',
      fields: { evidenceRefs: [intent.intentRef] },
      faults,
    });
  });
  register('contribution-2', () => consumeKind(session, 'obligation:submitContribution', {}, faults));
  register('seal-2', () => consumeKind(session, 'obligation:sealRevision', {}, faults));
  register('present-2', () => consumeKind(session, 'obligation:presentCandidates', {}, faults));
  register('final-gate', () => consumeKind(session, 'obligation:runGate.final', { gateVerdict: 'accepted' }, faults));
  register('effect-settle', () => consumeKind(session, 'obligation:runEffects', { effectOutcome: 'success' }, faults));
  register('final-acceptance', () => {
    ensureCommand(session, {
      command: 'workplace.recordFinalAcceptance',
      instanceId: WORKPLACE,
      key: 'driver:final-acceptance',
      done: (s) => eventExists(s, 'workplace.recordFinalAcceptance', WORKPLACE),
      faults,
    });
  });
  register('close-presentation', () => consumeKind(session, 'obligation:closePresentation', {}, faults));
  register('terminal-proof', () => {
    ensureCommand(session, {
      command: 'workplace.issueWorkplaceTerminalProof',
      instanceId: WORKPLACE,
      key: 'driver:terminal-proof',
      done: (s) => headOf(s, WORKPLACE)?.terminal !== undefined,
      fields: { terminalOutcome: 'success' },
      faults,
    });
  });
}

/* ------------------------------------------------------------------ */
/* Normalized world snapshot (exactly-once oracle)                      */
/* ------------------------------------------------------------------ */

/**
 * The normalized durable world: everything semantic, nothing volatile.
 * Two runs (faulted + restarted vs clean) settling to identical logical
 * outcomes produce identical snapshots - the exactly-once proof.
 */
export function normalizedWorld(session) {
  const w = world(session);
  return {
    sequence: w.sequence,
    heads: [...w.heads.values()]
      .map((head) => ({ instanceId: head.instanceId, status: head.status, revision: head.revision, ...(head.terminal !== undefined ? { terminal: head.terminal } : {}) }))
      .sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1)),
    events: w.events
      .map((event) => ({ transition: event.transition, source: event.sourceInstanceId, revision: event.sourceRevision, kind: event.kind }))
      .sort((a, b) => a.revision - b.revision || (a.transition < b.transition ? -1 : 1)),
    obligations: w.obligations
      .map((obligation) => ({
        kind: obligation.kind,
        key: obligation.idempotencyKey,
        state: obligation.state,
        ...(obligation.completionEvidenceRef !== undefined ? { completion: obligation.completionEvidenceRef } : {}),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : 1)),
    waits: w.waits
      .map((wait) => ({ kind: wait.kind, owner: wait.ownerInstanceId, state: wait.state, ...(wait.dischargeEvidenceRef !== undefined ? { discharge: wait.dischargeEvidenceRef } : {}) }))
      .sort((a, b) => (a.owner < b.owner ? -1 : 1) || (a.kind < b.kind ? -1 : 1)),
    proofs: w.proofs
      .map((proof) => ({ id: proof.id, owner: proof.ownerInstanceId, closure: [...proof.evidenceClosure].sort() }))
      .sort((a, b) => (a.owner < b.owner ? -1 : 1) || (a.id < b.id ? -1 : 1)),
    evidence: w.evidence.map((fact) => fact.ref).sort(),
  };
}
