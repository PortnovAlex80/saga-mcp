/**
 * tools/project-corpus/lib/execute.mjs - the project-corpus execution core
 * (WP-13D): run one validated project descriptor end to end against a
 * fresh greenfield database and report an honest check list.
 *
 * A project run is GREEN only when:
 *   - every mode check is green (drive, comparisons, probes);
 *   - every declared invariant evaluated green (unknown invariants are RED:
 *     the vocabulary is closed);
 *   - the declared expectations and heads matched (tamper detection).
 *
 * Failures are FINDINGS: they are reported honestly, never hidden. The
 * mutation hooks exist so the test suite can prove the comparisons detect
 * tampering (RED/GREEN); they are data transformations, never kernel code.
 */

import { evaluateWorldInvariants, unevaluatedInvariants } from './invariants.mjs';
import { runDurableSession, runPlanningConveyor, runDevelopmentVertical } from './modes.mjs';

/** The compact receipt-evidence view of one observed world (WP-15: the
 *  qualification wrapper evaluates the EK-11 receipt-completeness law over
 *  exactly these durable facts - no live kernel objects cross the boundary). */
export function receiptWorldOf(world) {
  return {
    evidence: (world?.evidence ?? []).map((fact) => ({ ref: fact.ref, kind: fact.kind })),
    proofs: [...new Set((world?.proofs ?? []).map((proof) => proof.id))].sort(),
    workIntents: [...(world?.workIntents?.values() ?? [])].map((intent) => ({
      intentRef: intent.intentRef,
      workplace: intent.workplaceInstanceId,
      role: intent.protocolRole,
      roleContract: intent.roleContract,
    })),
    heads: [...(world?.heads?.entries() ?? [])].map(([instanceId, head]) => ({ instanceId, status: head.status, ...(head.terminal !== undefined ? { terminal: head.terminal } : {}) })),
  };
}

/**
 * Run one project descriptor.
 *
 * options.mutations (test-only, data transformations):
 *   - tamperActorSteps(steps) -> steps     (actor-program violation family)
 *   - tamperExpectations(exp) -> exp       (expected-world tampering family)
 *   - tamperFaultSchedule(schedule) -> s.  (fault-schedule divergence family)
 *   - tamperInputs(inputs) -> inputs       (input-stream tampering family)
 */
export async function runProject(descriptor, options = {}) {
  const startedAt = Date.now();
  const { mutations = {}, includeInvariants = true } = options;
  let mode;
  try {
    if (descriptor.drive.mode === 'durable-session') mode = runDurableSession(descriptor, mutations);
    else if (descriptor.drive.mode === 'planning-conveyor') mode = await runPlanningConveyor(descriptor);
    else if (descriptor.drive.mode === 'development-vertical') mode = await runDevelopmentVertical(descriptor);
    else throw new Error(`unknown drive mode "${descriptor.drive.mode}"`);
  } catch (error) {
    return {
      projectId: descriptor.projectId,
      projectKind: descriptor.projectKind,
      driveMode: descriptor.drive.mode,
      status: 'red',
      checks: [{ id: 'drive', status: 'red', detail: `${error?.stack ?? String(error)}` }],
      invariants: [],
      observed: null,
      elapsedMs: Date.now() - startedAt,
      error: String(error?.message ?? error),
    };
  }

  const context = { ...mode.context, elapsedMs: Date.now() - startedAt };
  const invariants = includeInvariants
    ? evaluateWorldInvariants(descriptor, mode.observed ?? { world: { obligations: [], waits: [], evidence: [], heads: new Map(), proofs: [] }, summary: { heads: [], obligations: [], waits: [], proofs: [], evidenceKinds: [] }, events: [] }, context)
    : [];
  const unevaluated = includeInvariants ? unevaluatedInvariants(descriptor, invariants) : [];
  for (const invariant of unevaluated) {
    invariants.push({ id: invariant, status: 'red', detail: 'declared invariant was not evaluated (unknown to the driver - the vocabulary is closed)' });
  }

  const allChecks = [...mode.checks, ...invariants.map((result) => ({ id: `invariant:${result.id}`, status: result.status, detail: result.detail }))];
  const status = allChecks.every((check) => check.status === 'green') ? 'green' : 'red';
  return {
    projectId: descriptor.projectId,
    projectKind: descriptor.projectKind,
    driveMode: descriptor.drive.mode,
    status,
    checks: allChecks,
    invariants,
    elapsedMs: Date.now() - startedAt,
    ...(mode.observed !== undefined && mode.observed !== null
      ? { observed: { summary: mode.observed.summary, events: mode.observed.events, receiptWorld: receiptWorldOf(mode.observed.world) } }
      : { observed: null }),
  };
}

/** Render one project result as table rows (id, status, detail). */
export function resultRows(result) {
  return result.checks.map((check) => ({ projectId: result.projectId, id: check.id, status: check.status, detail: check.detail }));
}
