/**
 * tests/workflow-kernel/engine/compare.mjs - the EK-9 model-comparison core
 * (WP-13A, plan phase EK-9 "Engine requirements"):
 *
 *   - drive the PURE REFERENCE MODEL (dist/workflow-kernel/domain/explorer)
 *     from the scenario input (public commands only; the harness never
 *     writes authority tables and never fabricates factory receipts);
 *   - materialize the INPUT-LEVEL fault classes of the schedule on the
 *     command stream and REFUSE LOUDLY on scheduler-level faults (the
 *     WP-13B fault scheduler owns crash/restart and projection injection -
 *     silently skipping a scheduled fault is a harness lie, never an option);
 *   - NORMALIZE traces: timestamps, PIDs, row ids, sequence numbers,
 *     idempotency keys, payload digests and raw evidence refs are excluded;
 *     instance ids are renumbered per aggregate by first appearance; and
 *     INDEPENDENT-TASK ORDERING is canonicalized (concurrent steps with no
 *     static dependency edge between them are window-sorted by command);
 *   - compare normalized traces and final evidence (heads, obligations,
 *     waits, proofs, evidence-kind multisets, invariant violations) and
 *     compare the demonstrated outcome against the scenario's authored
 *     expectations (declared must equal demonstrated).
 *
 * WP-13B plugs real actors and the fault scheduler behind the same
 * driveScenario surface; production traces (WP-06+) compare through the
 * same normalize/compare functions.
 */

import {
  applyCommand,
  createWorld,
  findInvariantViolations,
  staticDependencyEdges,
} from '../../../dist/workflow-kernel/domain/explorer.js';
import { COMMANDS } from '../../../dist/workflow-kernel/domain/universe.js';
import { canonicalJson } from '../../../dist/workflow-kernel/domain/digest.js';
import {
  assertValidScenario,
  INPUT_FAULT_CLASSES,
  MATERIAL_EVIDENCE_KINDS,
  SCHEDULER_FAULT_CLASSES,
} from './scenario.mjs';

/* ------------------------------------------------------------------ */
/* Errors (fail-closed, never a silent skip)                            */
/* ------------------------------------------------------------------ */

export class EngineFaultSchedulerRequiredError extends Error {
  constructor(faults) {
    super(
      `scenario schedules fault classes owned by the WP-13B fault scheduler (${faults
        .map((f) => f.fault)
        .join(', ')}); the engine core refuses to drive them silently`,
    );
    this.name = 'EngineFaultSchedulerRequiredError';
    this.faults = faults;
  }
}

export class FaultAnchorMissingError extends Error {
  constructor(fault) {
    super(
      `fault "${fault.fault}" anchors ${fault.anchor.command}@${fault.anchor.instanceId}` +
        ` (occurrence ${fault.anchor.occurrence ?? 1}) but that command application is absent from the stream`,
    );
    this.name = 'FaultAnchorMissingError';
    this.fault = fault;
  }
}

/* ------------------------------------------------------------------ */
/* Scenario -> command stream                                          */
/* ------------------------------------------------------------------ */

const AGGREGATE_OF_COMMAND = new Map(COMMANDS.map((descriptor) => [descriptor.name, descriptor.aggregate]));

function commandInputOf(step, defaultKey) {
  const input = {
    command: step.command,
    instanceId: step.instanceId,
    expectedRevision: step.expectedRevision,
    idempotencyKey: step.idempotencyKey ?? defaultKey,
  };
  for (const key of ['evidenceRefs', 'rolePin', 'protocolRole', 'workIntentRef', 'gateVerdict', 'effectOutcome', 'terminalOutcome', 'stageRoute']) {
    if (step[key] !== undefined) input[key] = step[key];
  }
  return input;
}

/** The ordered scenario command-step objects (ingress first, then actors). */
export function scenarioSteps(scenario) {
  return [...scenario.seedInput.ingress, ...scenario.actorProgram];
}

/** Map scenario command-step objects to kernel CommandInputs. */
export function scenarioCommandInputs(steps, seed) {
  void seed;
  return steps.map((step, index) => commandInputOf(step, step.stepId !== undefined ? `key:${step.stepId}` : `ingress:${index}`));
}

/* ------------------------------------------------------------------ */
/* Fault materialization (input-level classes only)                     */
/* ------------------------------------------------------------------ */

function anchorIndexOf(steps, anchor) {
  const occurrence = anchor.occurrence ?? 1;
  let seen = 0;
  for (let index = 0; index < steps.length; index += 1) {
    if (steps[index].command === anchor.command && steps[index].instanceId === anchor.instanceId) {
      seen += 1;
      if (seen === occurrence) return index;
    }
  }
  return -1;
}

function cloneStep(step) {
  return { ...step, ...(step.evidenceRefs !== undefined ? { evidenceRefs: [...step.evidenceRefs] } : {}) };
}

/**
 * Materialize the INPUT-LEVEL fault classes on the command-step stream.
 * Scheduler-level classes are reported as `unsupported` (the caller refuses
 * loudly); a missing anchor throws FaultAnchorMissingError.
 */
export function applyInputLevelFaults(steps, faultSchedule) {
  const out = steps.map(cloneStep);
  const applied = [];
  const unsupported = [];
  for (const fault of faultSchedule) {
    if (!INPUT_FAULT_CLASSES.includes(fault.fault)) {
      if (SCHEDULER_FAULT_CLASSES.includes(fault.fault)) unsupported.push(fault);
      continue;
    }
    const index = anchorIndexOf(out, fault.anchor);
    if (index < 0) throw new FaultAnchorMissingError(fault);
    const step = out[index];
    switch (fault.fault) {
      case 'stale-expected-revision':
        step.expectedRevision = (step.expectedRevision ?? 0) + 1;
        break;
      case 'duplicate-idempotency-key': {
        // Re-issue the anchored application verbatim right after itself:
        // the kernel must answer with an idempotent replay, never a second
        // commit (the duplicate-completion actor behavior).
        out.splice(index + 1, 0, cloneStep(step));
        break;
      }
      case 'evidence-omission':
        delete step.evidenceRefs;
        break;
      case 'foreign-evidence-ref':
        step.evidenceRefs = ['evidence:foreign#ref'];
        break;
      case 'gate-verdict-mutation':
        step.gateVerdict = 'terminal-reject';
        break;
      case 'effect-outcome-mutation':
        step.effectOutcome = 'policy-terminal';
        break;
      default:
        throw new Error(`unhandled input fault class ${fault.fault}`);
    }
    applied.push({ fault: fault.fault, index });
  }
  return { steps: out, applied, unsupported };
}

/* ------------------------------------------------------------------ */
/* The reference-model driver                                          */
/* ------------------------------------------------------------------ */

/**
 * Drive the pure reference model over kernel CommandInputs. Stops at the
 * first typed refusal; idempotent replays are recorded and the drive
 * continues (a replay is the kernel's answer, not a stop condition).
 */
export function driveCommandInputs(world, inputs) {
  let current = world;
  const steps = [];
  let refusal;
  for (const input of inputs) {
    const applied = applyCommand(current, input);
    steps.push({ input, outcome: applied.outcome });
    if (applied.outcome?.refused === true) {
      refusal = applied.outcome;
      break;
    }
    if (applied.outcome?.replayed !== true) {
      current = applied.world;
    }
  }
  return { world: current, steps, refusal };
}

/**
 * Drive the pure reference model from a raw scenario command-step list plus
 * a fault schedule and seed (used by driveReferenceModel and the minimizer).
 */
export function driveCommandSteps(steps, faultSchedule, seed) {
  const materialized = applyInputLevelFaults(steps, faultSchedule);
  if (materialized.unsupported.length > 0) {
    throw new EngineFaultSchedulerRequiredError(materialized.unsupported);
  }
  const run = driveCommandInputs(createWorld(seed), scenarioCommandInputs(materialized.steps, seed));
  return { ...run, appliedFaults: materialized.applied, seed };
}

/**
 * Drive the pure reference model from a validated scenario. Returns the
 * final world, the raw trace, the normalized trace and the normalized
 * final-evidence summary.
 */
export function driveReferenceModel(scenario) {
  assertValidScenario(scenario);
  const run = driveCommandSteps(scenarioSteps(scenario), scenario.faultSchedule, scenario.seedInput.seed);
  const instanceTable = instanceRenumbering(run.steps.map((step) => step.input));
  return {
    seed: scenario.seedInput.seed,
    world: run.world,
    steps: run.steps,
    refusal: run.refusal,
    appliedFaults: run.appliedFaults,
    normalized: normalizeTrace(run.steps),
    summary: worldSummary(run.world, instanceTable),
  };
}

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

/**
 * Instance-id normalization: raw ids (row UUIDs, "workplace:1", ...) become
 * `<Aggregate>#<first-appearance ordinal>` per aggregate. Identity
 * relationships (same instance across steps) are preserved; id SCHEMES and
 * raw row ids are not semantic.
 */
export function instanceRenumbering(inputs) {
  const table = new Map();
  const counters = new Map();
  for (const input of inputs) {
    if (table.has(input.instanceId)) continue;
    const aggregate = AGGREGATE_OF_COMMAND.get(input.command) ?? 'Unknown';
    const next = (counters.get(aggregate) ?? 0) + 1;
    counters.set(aggregate, next);
    table.set(input.instanceId, `${aggregate}#${next}`);
  }
  return table;
}

const dependsOn = (a, b) => staticDependencyEdges().get(a)?.has(b) === true;

/**
 * Canonicalize independent-task ordering: the trace is cut into maximal
 * windows; a window closes when the next step statically depends on any
 * step inside it (command-level dependency graph of the frozen universe).
 * Inside a window the steps have no static dependency on each other, so
 * their order is an artifact of scheduling and is sorted by
 * (command, normalized instance) - the same multiset of concurrent steps
 * always normalizes to the same sequence.
 */
export function canonicalStepOrder(steps) {
  const windows = [];
  let current = [];
  for (const step of steps) {
    if (current.length > 0 && current.some((earlier) => dependsOn(step.command, earlier.command))) {
      windows.push(current);
      current = [step];
    } else {
      current.push(step);
    }
  }
  if (current.length > 0) windows.push(current);
  return windows.flatMap((window) => [...window].sort((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : a.instance < b.instance ? -1 : 1)));
}

/**
 * Normalize a raw trace ({ input, outcome } steps): keep the semantic facts
 * (command, instance identity, committed/refused/replayed, event kind,
 * resulting status, obligation/wait/proof/evidence KINDS); drop timestamps,
 * sequence numbers, revisions, idempotency keys, payload digests, raw
 * evidence refs and instance-id scheme; canonicalize independent ordering.
 */
export function normalizeTrace(steps) {
  const table = instanceRenumbering(steps.map((step) => step.input));
  const normalized = steps.map((step) => {
    const instance = table.get(step.input.instanceId) ?? step.input.instanceId;
    const outcome = step.outcome ?? {};
    if (outcome.refused === true) {
      return { command: step.input.command, instance, outcome: `refused:${outcome.reason}` };
    }
    if (outcome.replayed === true) {
      return { command: step.input.command, instance, outcome: 'replayed' };
    }
    return {
      command: step.input.command,
      instance,
      outcome: 'committed',
      event: outcome.event ? outcome.event.kind : null,
      status: outcome.plan.nextStatus,
      obligations: outcome.obligations.map((o) => o.kind).sort(),
      waits: outcome.waits.map((w) => w.kind).sort(),
      proofs: outcome.proofs.map((p) => p.id).sort(),
      evidence: outcome.evidence.map((e) => e.kind).sort(),
    };
  });
  // A refusal is the terminal step: window-sort everything before it and
  // keep it last.
  const lastRefusal = normalized.length > 0 && normalized[normalized.length - 1].outcome.startsWith('refused:')
    ? normalized[normalized.length - 1]
    : undefined;
  const body = lastRefusal ? normalized.slice(0, -1) : normalized;
  const ordered = canonicalStepOrder(body).concat(lastRefusal ? [lastRefusal] : []);
  return { steps: ordered, events: ordered.map((s) => s.event).filter((kind) => kind) };
}

/* ------------------------------------------------------------------ */
/* Final-evidence summary                                              */
/* ------------------------------------------------------------------ */

const counts = (list) => {
  const map = new Map();
  for (const item of list) map.set(item, (map.get(item) ?? 0) + 1);
  return map;
};

/** Multiset entries as sorted `${item}#${count}` strings. */
function multisetEntries(list) {
  const out = [];
  for (const [item, count] of counts(list)) out.push(`${item}#${count}`);
  return out.sort();
}

/** Compare a declared expectation list against demonstrated `item#count` entries. */
function compareDeclaredMultiset(section, declaredItems, demonstratedEntries) {
  const differences = [];
  const declared = new Set(multisetEntries(declaredItems));
  const demonstrated = new Set(demonstratedEntries);
  for (const entry of multisetEntries(declaredItems)) {
    if (!demonstrated.has(entry)) differences.push({ kind: 'missing', section, detail: `${section} "${entry}" is declared but not demonstrated` });
  }
  for (const entry of demonstratedEntries) {
    if (!declared.has(entry)) differences.push({ kind: 'unexpected', section, detail: `${section} "${entry}" is demonstrated but not declared` });
  }
  return differences;
}

/**
 * The normalized final-evidence summary of a world: aggregate heads
 * (renumbered instances; heads never touched by the trace keep their raw id
 * ordering inside the same aggregate), obligation/wait multisets by
 * kind:state, terminal proofs, evidence-kind multiset, and the world-level
 * invariant violations.
 */
export function worldSummary(world, instanceTable = new Map()) {
  const heads = [...world.heads.values()]
    .map((head) => ({
      aggregate: head.aggregate,
      instance: instanceTable.get(head.instanceId) ?? head.instanceId,
      status: head.status,
      ...(head.terminal !== undefined ? { terminal: head.terminal } : {}),
    }))
    .sort((a, b) => (a.instance < b.instance ? -1 : a.instance > b.instance ? 1 : a.status < b.status ? -1 : 1));
  return {
    heads,
    obligations: multisetEntries(world.obligations.map((o) => `${o.kind}:${o.state}`)),
    waits: multisetEntries(world.waits.map((w) => `${w.kind}:${w.state}`)),
    proofs: [...new Set(world.proofs.map((p) => p.id))].sort(),
    evidenceKinds: multisetEntries(world.evidence.map((e) => e.kind)),
    invariantViolations: findInvariantViolations(world),
  };
}

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

const stepKey = (step) => canonicalJson(step);

/** Compare two normalized traces; report every difference with positions. */
export function compareNormalizedTraces(a, b) {
  const differences = [];
  const length = Math.max(a.steps.length, b.steps.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.steps[index];
    const right = b.steps[index];
    if (left === undefined) {
      differences.push({ kind: 'extra-step', index, detail: `actual has an extra step at ${index}: ${stepKey(right)}` });
      break;
    }
    if (right === undefined) {
      differences.push({ kind: 'missing-step', index, detail: `actual is missing the step at ${index}: ${stepKey(left)}` });
      break;
    }
    if (stepKey(left) !== stepKey(right)) {
      differences.push({
        kind: 'step-mismatch',
        index,
        detail: `step ${index} diverges: reference ${stepKey(left)} vs actual ${stepKey(right)}`,
      });
      break;
    }
  }
  if (differences.length === 0 && a.events.join('|') !== b.events.join('|')) {
    differences.push({ kind: 'event-sequence-mismatch', index: -1, detail: `event sequences differ: ${a.events.join('|')} vs ${b.events.join('|')}` });
  }
  return { equal: differences.length === 0, differences };
}

const multisetDiff = (label, expected, actual) => {
  const differences = [];
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const item of expected) {
    if (!actualSet.has(item)) differences.push({ kind: 'missing', section: label, detail: `${label} "${item}" is declared but not demonstrated` });
  }
  for (const item of actual) {
    if (!expectedSet.has(item)) differences.push({ kind: 'unexpected', section: label, detail: `${label} "${item}" is demonstrated but not declared` });
  }
  return differences;
};

/** Compare two normalized final-evidence summaries. */
export function compareWorldSummaries(a, b) {
  const differences = [];
  for (const section of ['obligations', 'waits', 'proofs', 'evidenceKinds']) {
    differences.push(...multisetDiff(section, a[section], b[section]));
  }
  // Heads are objects: compare by canonical JSON key multisets.
  const headKeysOf = (summary) => summary.heads.map((head) => canonicalJson(head)).sort();
  differences.push(...multisetDiff('heads', headKeysOf(a), headKeysOf(b)));
  if (canonicalJson(a.invariantViolations) !== canonicalJson(b.invariantViolations)) {
    differences.push({
      kind: 'invariant-violation-mismatch',
      section: 'invariantViolations',
      detail: `invariant violations differ: ${canonicalJson(a.invariantViolations)} vs ${canonicalJson(b.invariantViolations)}`,
    });
  }
  return { equal: differences.length === 0, differences };
}

/** Compare the demonstrated run against the scenario's authored expectations. */
export function compareScenarioExpectations(scenario, run) {
  const differences = [];
  const exp = scenario.expectations;

  const eventList = run.normalized.events;
  if (exp.events.join('|') !== eventList.join('|')) {
    differences.push({
      kind: 'events-mismatch',
      section: 'events',
      detail: `declared events ${JSON.stringify(exp.events)} but demonstrated ${JSON.stringify(eventList)}`,
    });
  }

  differences.push(...compareDeclaredMultiset('obligations', exp.obligations.map((o) => `${o.kind}:${o.state}`), run.summary.obligations));
  differences.push(...compareDeclaredMultiset('waits', exp.waits.map((w) => `${w.kind}:${w.state}`), run.summary.waits));
  differences.push(...compareDeclaredMultiset('proofs', exp.proofs, run.summary.proofs));

  const classOf = (kind) => {
    if (MATERIAL_EVIDENCE_KINDS.includes(kind)) return 'material';
    if (kind.startsWith('GateDecision:')) return 'gate';
    if (kind.startsWith('EffectReceipt:') || kind === 'EffectPolicyRefusal') return 'effect';
    return null;
  };
  const demonstrated = { material: [], gate: [], effect: [] };
  for (const entry of run.summary.evidenceKinds) {
    const kind = entry.slice(0, entry.lastIndexOf('#'));
    const cls = classOf(kind);
    if (cls) demonstrated[cls].push(entry);
  }
  for (const cls of ['material', 'gate', 'effect']) {
    differences.push(...compareDeclaredMultiset(`evidence.${cls}`, exp.evidence[cls], demonstrated[cls]));
  }

  return { equal: differences.length === 0, differences };
}

/**
 * The full scenario comparison: drive the reference model from the scenario,
 * then compare an ACTUAL run (reference re-run now; the WP-13B/06 production
 * composition later) against (1) the reference normalized trace,
 * (2) the reference final evidence, and (3) the authored expectations.
 */
export function compareScenarioRun(scenario, actual) {
  const reference = driveReferenceModel(scenario);
  const trace = compareNormalizedTraces(reference.normalized, actual.normalized);
  const summary = compareWorldSummaries(reference.summary, actual.summary);
  const expectations = compareScenarioExpectations(scenario, actual);
  return {
    equal: trace.equal && summary.equal && expectations.equal,
    trace,
    summary,
    expectations,
    reference,
    actual,
  };
}
