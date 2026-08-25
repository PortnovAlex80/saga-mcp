/**
 * tests/workflow-kernel/engine/scenario.mjs - the versioned EK-9 scenario
 * contract and its CLOSED-VOCABULARY schema validator (WP-13A, plan phase
 * EK-9 "Scenario contract").
 *
 * One versioned scenario format drives the L1 pure reference model and the
 * L3/L4 production composition from the SAME input (compare.mjs), carrying:
 *
 *   - protocol/build/package/capsule identities;
 *   - fresh seed input through PUBLIC COMMANDS only (no SQL, no direct
 *     authority-table writes - the harness never writes authority tables);
 *   - the actor program (protocol role, semantic profile, actor behavior and
 *     the allowed tool sequence) - WP-13B plugs real actors into these steps;
 *   - dependency topology and concurrency cap;
 *   - the fault schedule with EXACT anchors (fault class + anchored command
 *     occurrence + optional restart boundary);
 *   - expected normalized events, obligations, waits and terminal proofs;
 *   - expected material/gate/effect evidence;
 *   - product verification commands and time budgets.
 *
 * Every vocabulary (commands, event/obligation/wait/proof/evidence kinds,
 * verdicts, outcomes, roles, behaviors, fault classes, restart boundaries) is
 * CLOSED: the validator checks membership against the frozen EK-1 transition
 * universe (dist/workflow-kernel/domain/universe.js) plus the frozen domain
 * type sets (src/workflow-kernel/domain/types.ts). Expected outcomes are
 * therefore authored from the independent universe, never copied from
 * production output (plan law: "Stop if expected results were copied from
 * production output").
 *
 * PURITY of the engine core: node builtins + dist domain only; no database,
 * no network, no provider, no workshop module.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../dist/workflow-kernel/domain/digest.js';
import {
  COMMAND_NAMES,
  EVIDENCE_KINDS,
  OBLIGATION_KINDS,
  PROOF_KINDS,
  UNIVERSE_SCHEMA_VERSION,
  WAIT_KINDS,
  WORKFLOW_EVENT_KINDS,
} from '../../../dist/workflow-kernel/domain/universe.js';

/* ------------------------------------------------------------------ */
/* The versioned format                                                */
/* ------------------------------------------------------------------ */

export const SCENARIO_FORMAT_VERSION = 'ek.workflow-scenario.ek9.v1';

/* ------------------------------------------------------------------ */
/* Closed vocabularies (frozen domain type sets, mirrored here)         */
/* ------------------------------------------------------------------ */

/** The only two Workplace protocol roles (types.ts ProtocolRole). */
export const PROTOCOL_ROLES = ['author', 'reviewer'];

/** Semantic profiles select a contract slot, never a transition owner. */
export const SEMANTIC_PROFILES = ['planner', 'implementer', 'reviewer', 'certifier'];

/** Required actor-behavior dimension (EK-9 "Required dimensions"). */
export const ACTOR_BEHAVIORS = [
  'compliant',
  'omission',
  'extra-paths',
  'malformed-product',
  'repairing',
  'stale-hash',
  'foreign-ref',
  'duplicate-completion',
  'prose-only-review',
  'timeout',
  'crash',
  'tool-misuse',
];

/** Gate verdict set of the frozen universe (R1). */
export const GATE_VERDICTS = ['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject'];

/** Effect outcome set of the frozen universe (D2). */
export const EFFECT_OUTCOMES = [
  'success',
  'already-applied',
  'retryable',
  'unknown',
  'human-wait',
  'policy-terminal',
  'repair',
];

/** Terminal outcomes expressible as proofs. */
export const TERMINAL_OUTCOMES = ['success', 'truthful-failure', 'cancellation', 'unreachable'];

/** Lifecycle routing targets of lifecycleRun.routeOutcome. */
export const STAGE_ROUTES = [
  'initial-discovery',
  'solution-formalization',
  'solution-development',
  'delivery-release',
  'verify-terminal-claims',
];

/** Required dependency dimension (EK-9 "Required dimensions"). */
export const TOPOLOGY_SHAPES = [
  'none',
  'chain',
  'diamond',
  'fan-in',
  'fan-out',
  'cycle-refusal',
  'failed-predecessor',
];

/**
 * Fault classes the ENGINE CORE can materialize on the command stream with
 * no scheduler: they are pure input transformations. WP-13B owns the real
 * fault scheduler for the process-level classes below.
 */
export const INPUT_FAULT_CLASSES = [
  'stale-expected-revision',
  'duplicate-idempotency-key',
  'evidence-omission',
  'foreign-evidence-ref',
  'gate-verdict-mutation',
  'effect-outcome-mutation',
];

/**
 * Fault classes that need the WP-13B fault scheduler (crash/restart and
 * projection injection). A scenario MAY declare them (the contract carries
 * the full schedule); driving one through the reference model refuses
 * loudly instead of silently skipping (compare.mjs).
 */
export const SCHEDULER_FAULT_CLASSES = [
  'crash-before-commit',
  'crash-after-event',
  'worker-loss',
  'projection-wipe',
  'projection-stale-write',
];

export const FAULT_CLASSES = [...INPUT_FAULT_CLASSES, ...SCHEDULER_FAULT_CLASSES];

/** Restart-boundary dimension: every durable commit seam is addressable. */
export const FAULT_BOUNDARIES = [
  'before-event',
  'after-event',
  'before-evidence',
  'after-evidence',
  'before-obligation',
  'after-obligation',
  'before-worker',
  'after-worker',
  'before-gate',
  'after-gate',
  'before-effect',
  'after-effect',
  'before-settlement-commit',
  'after-settlement-commit',
];

/** Material-evidence class (production material a gate judges). */
export const MATERIAL_EVIDENCE_KINDS = [
  'WorkplaceProductionRevision',
  'CandidateSet:author',
  'CandidateSet:reviewer',
  'ActivityAttemptContribution',
  'AcceptedCandidateAuthority',
  'CellFinalAcceptance',
];

export const OBLIGATION_STATES = ['open', 'completed'];
export const WAIT_STATES = ['pending', 'discharged', 'converted'];

/* ------------------------------------------------------------------ */
/* Closed key sets                                                     */
/* ------------------------------------------------------------------ */

export const TOP_LEVEL_KEYS = [
  'formatVersion',
  'identity',
  'seedInput',
  'actorProgram',
  'topology',
  'faultSchedule',
  'expectations',
  'verification',
  'timeBudgets',
];

export const IDENTITY_KEYS = ['protocolVersion', 'buildDigest', 'packageDigest', 'capsuleId', 'capsuleDigest'];
export const SEED_INPUT_KEYS = ['fresh', 'seed', 'ingress'];
export const TOPOLOGY_KEYS = ['shape', 'nodes', 'edges', 'concurrencyCap'];
export const FAULT_KEYS = ['fault', 'anchor', 'boundary'];
export const ANCHOR_KEYS = ['command', 'instanceId', 'occurrence'];
export const EXPECTATION_KEYS = ['events', 'obligations', 'waits', 'proofs', 'evidence'];
export const EVIDENCE_EXPECTATION_KEYS = ['material', 'gate', 'effect'];
export const VERIFICATION_KEYS = ['productCommands'];
export const TIME_BUDGET_KEYS = ['totalMs', 'perStepMs'];

/**
 * The closed command-step shape: exactly the CommandInput fields the pure
 * kernel accepts (explorer ALLOWED_INPUT_KEYS) - no free-form payload, no
 * manifest bag an attempt could re-resolve (mutation j).
 */
export const COMMAND_STEP_KEYS = [
  'command',
  'instanceId',
  'expectedRevision',
  'idempotencyKey',
  'evidenceRefs',
  'rolePin',
  'protocolRole',
  'workIntentRef',
  'gateVerdict',
  'effectOutcome',
  'terminalOutcome',
  'stageRoute',
];

/** An actor step is a command step plus the actor-program metadata. */
export const ACTOR_STEP_KEYS = [...COMMAND_STEP_KEYS, 'stepId', 'semanticProfile', 'behavior', 'toolSequence'];

const HEX64 = /^[0-9a-f]{64}$/;
const SHA256_REF = /^sha256:[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export class ScenarioValidationError extends Error {
  constructor(errors) {
    super(`scenario contract invalid (${errors.length} error${errors.length === 1 ? '' : 's'}):\n${errors.map((e) => `  ${e.path}: [${e.code}] ${e.message}`).join('\n')}`);
    this.name = 'ScenarioValidationError';
    this.errors = errors;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string';
const isNonEmptyString = (v) => isString(v) && v.length > 0;
const isUint = (v) => Number.isInteger(v) && v >= 0;

function closedKeys(obj, allowed, path, err) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      err(path, 'unknown-key', `key "${key}" is not part of the closed scenario shape (allowed: ${allowed.join(', ')})`);
    }
  }
}

function requiredKeys(obj, required, path, err) {
  for (const key of required) {
    if (!(key in obj)) {
      err(`${path}.${key}`, 'missing-key', `required key "${key}" is absent`);
    }
  }
}

function inVocabulary(value, allowed, path, err, label) {
  if (!allowed.includes(value)) {
    err(path, 'not-in-vocabulary', `${label} "${value}" is not in the frozen ${label} vocabulary`);
    return false;
  }
  return true;
}

function validateCommandStep(step, path, allowedKeys, err) {
  if (!isObject(step)) {
    err(path, 'wrong-type', 'a command step must be a JSON object');
    return;
  }
  closedKeys(step, allowedKeys, path, err);
  requiredKeys(step, ['command', 'instanceId', 'expectedRevision'], path, err);

  if ('command' in step) {
    if (!isNonEmptyString(step.command)) err(`${path}.command`, 'wrong-type', 'command must be a nonempty string');
    else inVocabulary(step.command, [...COMMAND_NAMES], `${path}.command`, err, 'command');
  }
  if ('instanceId' in step && !isNonEmptyString(step.instanceId)) {
    err(`${path}.instanceId`, 'wrong-type', 'instanceId must be a nonempty string');
  }
  if ('expectedRevision' in step && !isUint(step.expectedRevision)) {
    err(`${path}.expectedRevision`, 'wrong-type', 'expectedRevision must be a nonnegative integer');
  }
  if ('idempotencyKey' in step && !isNonEmptyString(step.idempotencyKey)) {
    err(`${path}.idempotencyKey`, 'wrong-type', 'idempotencyKey must be a nonempty string');
  }
  if ('evidenceRefs' in step) {
    if (!Array.isArray(step.evidenceRefs)) err(`${path}.evidenceRefs`, 'wrong-type', 'evidenceRefs must be an array of evidence refs');
    else step.evidenceRefs.forEach((ref, i) => { if (!isNonEmptyString(ref)) err(`${path}.evidenceRefs[${i}]`, 'wrong-type', 'an evidence ref must be a nonempty string'); });
  }
  if ('rolePin' in step) {
    const pin = step.rolePin;
    if (!isObject(pin)) err(`${path}.rolePin`, 'wrong-type', 'rolePin must be { roleContractRef, roleContractDigest }');
    else {
      closedKeys(pin, ['roleContractRef', 'roleContractDigest'], `${path}.rolePin`, err);
      if (!SHA256_REF.test(pin.roleContractRef ?? '')) err(`${path}.rolePin.roleContractRef`, 'invalid-value', 'roleContractRef must be "sha256:" + 64 hex');
      if (!HEX64.test(pin.roleContractDigest ?? '')) err(`${path}.rolePin.roleContractDigest`, 'invalid-value', 'roleContractDigest must be 64 hex');
    }
  }
  if ('protocolRole' in step && !inVocabulary(step.protocolRole, PROTOCOL_ROLES, `${path}.protocolRole`, err, 'protocol role')) { /* recorded */ }
  if ('workIntentRef' in step && !isNonEmptyString(step.workIntentRef)) {
    err(`${path}.workIntentRef`, 'wrong-type', 'workIntentRef must be a nonempty string');
  }
  if ('gateVerdict' in step) inVocabulary(step.gateVerdict, GATE_VERDICTS, `${path}.gateVerdict`, err, 'gate verdict');
  if ('effectOutcome' in step) inVocabulary(step.effectOutcome, EFFECT_OUTCOMES, `${path}.effectOutcome`, err, 'effect outcome');
  if ('terminalOutcome' in step) inVocabulary(step.terminalOutcome, TERMINAL_OUTCOMES, `${path}.terminalOutcome`, err, 'terminal outcome');
  if ('stageRoute' in step) inVocabulary(step.stageRoute, STAGE_ROUTES, `${path}.stageRoute`, err, 'stage route');
}

function validateActorStep(step, path, err) {
  validateCommandStep(step, path, ACTOR_STEP_KEYS, err);
  if (!isObject(step)) return;
  if ('stepId' in step && !isNonEmptyString(step.stepId)) err(`${path}.stepId`, 'wrong-type', 'stepId must be a nonempty string');
  if ('semanticProfile' in step) inVocabulary(step.semanticProfile, SEMANTIC_PROFILES, `${path}.semanticProfile`, err, 'semantic profile');
  if ('behavior' in step) inVocabulary(step.behavior, ACTOR_BEHAVIORS, `${path}.behavior`, err, 'actor behavior');
  if ('toolSequence' in step) {
    if (!Array.isArray(step.toolSequence)) err(`${path}.toolSequence`, 'wrong-type', 'toolSequence must be an array of tool names');
    else step.toolSequence.forEach((tool, i) => { if (!isNonEmptyString(tool)) err(`${path}.toolSequence[${i}]`, 'wrong-type', 'a tool name must be a nonempty string'); });
  }
}

function validateEvidenceList(list, path, classOf, err) {
  list.forEach((kind, i) => {
    const at = `${path}[${i}]`;
    if (!isNonEmptyString(kind)) {
      err(at, 'wrong-type', 'an evidence kind must be a nonempty string');
      return;
    }
    if (!EVIDENCE_KINDS.includes(kind)) {
      err(at, 'not-in-vocabulary', `evidence kind "${kind}" is not in the frozen evidence universe`);
      return;
    }
    const cls = classOf(kind);
    if (cls === null) {
      err(at, 'invalid-value', `evidence kind "${kind}" does not belong in this evidence class list`);
    }
  });
}

/**
 * Validate a scenario document against the closed contract vocabulary.
 * Returns { valid, errors } - never throws; use assertValidScenario for the
 * throwing form. Every error names the exact offending path and code.
 */
export function validateScenario(doc) {
  const errors = [];
  const err = (path, code, message) => errors.push({ path, code, message });

  if (!isObject(doc)) {
    err('$', 'wrong-type', 'a scenario must be a JSON object');
    return { valid: false, errors };
  }
  closedKeys(doc, TOP_LEVEL_KEYS, '$', err);
  requiredKeys(doc, TOP_LEVEL_KEYS, '$', err);

  if ('formatVersion' in doc && doc.formatVersion !== SCENARIO_FORMAT_VERSION) {
    err('$.formatVersion', 'invalid-value', `formatVersion must be "${SCENARIO_FORMAT_VERSION}"`);
  }

  /* identity: protocol/build/package/capsule identities */
  if ('identity' in doc) {
    const identity = doc.identity;
    if (!isObject(identity)) err('$.identity', 'wrong-type', 'identity must be a JSON object');
    else {
      closedKeys(identity, IDENTITY_KEYS, '$.identity', err);
      requiredKeys(identity, IDENTITY_KEYS, '$.identity', err);
      if ('protocolVersion' in identity && identity.protocolVersion !== UNIVERSE_SCHEMA_VERSION) {
        err('$.identity.protocolVersion', 'invalid-value', `protocolVersion must equal the frozen universe version "${UNIVERSE_SCHEMA_VERSION}"`);
      }
      for (const key of ['buildDigest', 'packageDigest', 'capsuleDigest']) {
        if (key in identity && !HEX64.test(identity[key] ?? '')) {
          err(`$.identity.${key}`, 'invalid-value', `${key} must be 64 lowercase hex (sha256)`);
        }
      }
      if ('capsuleId' in identity && !isNonEmptyString(identity.capsuleId)) {
        err('$.identity.capsuleId', 'wrong-type', 'capsuleId must be a nonempty string');
      }
    }
  }

  /* seedInput: fresh seed through public commands */
  if ('seedInput' in doc) {
    const seedInput = doc.seedInput;
    if (!isObject(seedInput)) err('$.seedInput', 'wrong-type', 'seedInput must be a JSON object');
    else {
      closedKeys(seedInput, SEED_INPUT_KEYS, '$.seedInput', err);
      requiredKeys(seedInput, SEED_INPUT_KEYS, '$.seedInput', err);
      if ('fresh' in seedInput && seedInput.fresh !== true) {
        err('$.seedInput.fresh', 'invalid-value', 'fresh must be true (a scenario always starts from a new empty world)');
      }
      if ('seed' in seedInput && !(isUint(seedInput.seed) && seedInput.seed <= 0xffffffff)) {
        err('$.seedInput.seed', 'invalid-value', 'seed must be a uint32 (the retained random seed)');
      }
      if ('ingress' in seedInput) {
        if (!Array.isArray(seedInput.ingress)) err('$.seedInput.ingress', 'wrong-type', 'ingress must be an array of public command steps');
        else seedInput.ingress.forEach((step, i) => validateCommandStep(step, `$.seedInput.ingress[${i}]`, COMMAND_STEP_KEYS, err));
      }
    }
  }

  /* actorProgram */
  if ('actorProgram' in doc) {
    if (!Array.isArray(doc.actorProgram)) err('$.actorProgram', 'wrong-type', 'actorProgram must be an array of actor steps');
    else doc.actorProgram.forEach((step, i) => validateActorStep(step, `$.actorProgram[${i}]`, err));
  }

  /* topology: dependency shape + concurrency cap */
  if ('topology' in doc) {
    const topo = doc.topology;
    if (!isObject(topo)) err('$.topology', 'wrong-type', 'topology must be a JSON object');
    else {
      closedKeys(topo, TOPOLOGY_KEYS, '$.topology', err);
      requiredKeys(topo, TOPOLOGY_KEYS, '$.topology', err);
      if ('shape' in topo) inVocabulary(topo.shape, TOPOLOGY_SHAPES, '$.topology.shape', err, 'dependency shape');
      if ('nodes' in topo) {
        if (!Array.isArray(topo.nodes)) err('$.topology.nodes', 'wrong-type', 'nodes must be an array of node refs');
        else topo.nodes.forEach((node, i) => { if (!isNonEmptyString(node)) err(`$.topology.nodes[${i}]`, 'wrong-type', 'a node ref must be a nonempty string'); });
      }
      if ('edges' in topo) {
        if (!Array.isArray(topo.edges)) err('$.topology.edges', 'wrong-type', 'edges must be an array of [from, to] pairs');
        else topo.edges.forEach((edge, i) => {
          if (!Array.isArray(edge) || edge.length !== 2 || !edge.every(isNonEmptyString)) {
            err(`$.topology.edges[${i}]`, 'wrong-type', 'an edge must be a [from, to] pair of nonempty strings');
          }
        });
      }
      if ('concurrencyCap' in topo && !(Number.isInteger(topo.concurrencyCap) && topo.concurrencyCap >= 1)) {
        err('$.topology.concurrencyCap', 'invalid-value', 'concurrencyCap must be an integer >= 1');
      }
    }
  }

  /* faultSchedule: exact fault points, stably anchored */
  if ('faultSchedule' in doc) {
    if (!Array.isArray(doc.faultSchedule)) err('$.faultSchedule', 'wrong-type', 'faultSchedule must be an array of fault entries');
    else doc.faultSchedule.forEach((fault, i) => {
      const at = `$.faultSchedule[${i}]`;
      if (!isObject(fault)) {
        err(at, 'wrong-type', 'a fault entry must be a JSON object');
        return;
      }
      closedKeys(fault, FAULT_KEYS, at, err);
      requiredKeys(fault, ['fault', 'anchor'], at, err);
      if ('fault' in fault) inVocabulary(fault.fault, FAULT_CLASSES, `${at}.fault`, err, 'fault class');
      if ('boundary' in fault) inVocabulary(fault.boundary, FAULT_BOUNDARIES, `${at}.boundary`, err, 'restart boundary');
      if ('anchor' in fault) {
        const anchor = fault.anchor;
        if (!isObject(anchor)) err(`${at}.anchor`, 'wrong-type', 'anchor must be { command, instanceId, occurrence? }');
        else {
          closedKeys(anchor, ANCHOR_KEYS, `${at}.anchor`, err);
          requiredKeys(anchor, ['command', 'instanceId'], `${at}.anchor`, err);
          if ('command' in anchor && isNonEmptyString(anchor.command)) {
            inVocabulary(anchor.command, [...COMMAND_NAMES], `${at}.anchor.command`, err, 'command');
          } else if ('command' in anchor) {
            err(`${at}.anchor.command`, 'wrong-type', 'anchor.command must be a nonempty string');
          }
          if ('instanceId' in anchor && !isNonEmptyString(anchor.instanceId)) {
            err(`${at}.anchor.instanceId`, 'wrong-type', 'anchor.instanceId must be a nonempty string');
          }
          if ('occurrence' in anchor && !(Number.isInteger(anchor.occurrence) && anchor.occurrence >= 1)) {
            err(`${at}.anchor.occurrence`, 'invalid-value', 'occurrence must be an integer >= 1');
          }
        }
      }
    });
  }

  /* expectations: authored from the independent transition/claim universe */
  if ('expectations' in doc) {
    const exp = doc.expectations;
    if (!isObject(exp)) err('$.expectations', 'wrong-type', 'expectations must be a JSON object');
    else {
      closedKeys(exp, EXPECTATION_KEYS, '$.expectations', err);
      requiredKeys(exp, EXPECTATION_KEYS, '$.expectations', err);
      if ('events' in exp) {
        if (!Array.isArray(exp.events)) err('$.expectations.events', 'wrong-type', 'events must be an array of workflow event kinds');
        else exp.events.forEach((kind, i) => inVocabulary(kind, [...WORKFLOW_EVENT_KINDS], `$.expectations.events[${i}]`, err, 'workflow event kind'));
      }
      if ('obligations' in exp) {
        if (!Array.isArray(exp.obligations)) err('$.expectations.obligations', 'wrong-type', 'obligations must be an array of { kind, state }');
        else exp.obligations.forEach((entry, i) => {
          const at = `$.expectations.obligations[${i}]`;
          if (!isObject(entry)) {
            err(at, 'wrong-type', 'an obligation expectation must be a JSON object');
            return;
          }
          closedKeys(entry, ['kind', 'state'], at, err);
          if ('kind' in entry) inVocabulary(entry.kind, [...OBLIGATION_KINDS], `${at}.kind`, err, 'obligation kind');
          if ('state' in entry) inVocabulary(entry.state, OBLIGATION_STATES, `${at}.state`, err, 'obligation state');
        });
      }
      if ('waits' in exp) {
        if (!Array.isArray(exp.waits)) err('$.expectations.waits', 'wrong-type', 'waits must be an array of { kind, state }');
        else exp.waits.forEach((entry, i) => {
          const at = `$.expectations.waits[${i}]`;
          if (!isObject(entry)) {
            err(at, 'wrong-type', 'a wait expectation must be a JSON object');
            return;
          }
          closedKeys(entry, ['kind', 'state'], at, err);
          if ('kind' in entry) inVocabulary(entry.kind, [...WAIT_KINDS], `${at}.kind`, err, 'wait kind');
          if ('state' in entry) inVocabulary(entry.state, WAIT_STATES, `${at}.state`, err, 'wait state');
        });
      }
      if ('proofs' in exp) {
        if (!Array.isArray(exp.proofs)) err('$.expectations.proofs', 'wrong-type', 'proofs must be an array of terminal proof kinds');
        else exp.proofs.forEach((kind, i) => inVocabulary(kind, [...PROOF_KINDS], `$.expectations.proofs[${i}]`, err, 'terminal proof kind'));
      }
      if ('evidence' in exp) {
        const evd = exp.evidence;
        if (!isObject(evd)) err('$.expectations.evidence', 'wrong-type', 'evidence must be { material, gate, effect }');
        else {
          closedKeys(evd, EVIDENCE_EXPECTATION_KEYS, '$.expectations.evidence', err);
          requiredKeys(evd, EVIDENCE_EXPECTATION_KEYS, '$.expectations.evidence', err);
          const classOf = {
            material: (kind) => (MATERIAL_EVIDENCE_KINDS.includes(kind) ? 'material' : null),
            gate: (kind) => (kind.startsWith('GateDecision:') ? 'gate' : null),
            effect: (kind) => (kind.startsWith('EffectReceipt:') || kind === 'EffectPolicyRefusal' ? 'effect' : null),
          };
          for (const cls of EVIDENCE_EXPECTATION_KEYS) {
            if (cls in evd) {
              if (!Array.isArray(evd[cls])) err(`$.expectations.evidence.${cls}`, 'wrong-type', `${cls} must be an array of evidence kinds`);
              else validateEvidenceList(evd[cls], `$.expectations.evidence.${cls}`, classOf[cls], err);
            }
          }
        }
      }
    }
  }

  /* verification: product verification commands */
  if ('verification' in doc) {
    const ver = doc.verification;
    if (!isObject(ver)) err('$.verification', 'wrong-type', 'verification must be a JSON object');
    else {
      closedKeys(ver, VERIFICATION_KEYS, '$.verification', err);
      requiredKeys(ver, VERIFICATION_KEYS, '$.verification', err);
      if ('productCommands' in ver) {
        if (!Array.isArray(ver.productCommands)) err('$.verification.productCommands', 'wrong-type', 'productCommands must be an array of shell commands');
        else ver.productCommands.forEach((cmd, i) => { if (!isNonEmptyString(cmd)) err(`$.verification.productCommands[${i}]`, 'wrong-type', 'a product command must be a nonempty string'); });
      }
    }
  }

  /* timeBudgets */
  if ('timeBudgets' in doc) {
    const tb = doc.timeBudgets;
    if (!isObject(tb)) err('$.timeBudgets', 'wrong-type', 'timeBudgets must be a JSON object');
    else {
      closedKeys(tb, TIME_BUDGET_KEYS, '$.timeBudgets', err);
      requiredKeys(tb, ['totalMs'], '$.timeBudgets', err);
      if ('totalMs' in tb && !(Number.isInteger(tb.totalMs) && tb.totalMs > 0)) {
        err('$.timeBudgets.totalMs', 'invalid-value', 'totalMs must be a positive integer');
      }
      if ('perStepMs' in tb && !(Number.isInteger(tb.perStepMs) && tb.perStepMs > 0)) {
        err('$.timeBudgets.perStepMs', 'invalid-value', 'perStepMs must be a positive integer');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Throwing form of validateScenario (lists every violation). */
export function assertValidScenario(doc) {
  const { valid, errors } = validateScenario(doc);
  if (!valid) throw new ScenarioValidationError(errors);
  return doc;
}

/* ------------------------------------------------------------------ */
/* Canonical form + digest                                             */
/* ------------------------------------------------------------------ */

/**
 * The canonical in-memory form: recursively key-sorted deep clone (the one
 * kernel canonicalization rule, dist/workflow-kernel/domain/digest.js).
 * canonicalScenario(x) deepEquals x; JSON round-trips preserve it.
 */
export function canonicalScenario(doc) {
  return JSON.parse(canonicalJson(doc));
}

/** sha256 over the canonical JSON of the scenario (the scenario digest). */
export function scenarioDigest(doc) {
  return createHash('sha256').update(canonicalJson(doc), 'utf8').digest('hex');
}
