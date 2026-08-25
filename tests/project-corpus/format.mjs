/**
 * tests/project-corpus/format.mjs - the versioned EK-9 PROJECT-CORPUS
 * descriptor contract (WP-13D, plan phase EK-9 "20-project corpus").
 *
 * One descriptor per scripted project. The format EXTENDS the WP-13A
 * scenario contract (tests/workflow-kernel/engine/scenario.mjs): the
 * `scenario` section carries the same closed-vocabulary shape (identity,
 * fresh seed through public commands, actor program, dependency topology,
 * concurrency cap, fault schedule, expectations, product verification
 * commands, time budgets), and the project layer adds:
 *
 *   - projectId / projectKind / description (the corpus inventory);
 *   - product { class, verification, fixture } - what the project DELIVERS
 *     and how the product is verified hermetically (the simple-server
 *     pattern: build + loopback + smoke on a temp copy; never docker,
 *     never network beyond 127.0.0.1, never a model call);
 *   - drive { mode } - which public-command engine executes the project:
 *       durable-session      - WP-13B actor programs over sole-writer
 *                              repositories + the fault scheduler;
 *       planning-conveyor    - the WP-09 dependency conveyor (topologies);
 *       development-vertical - the WP-08 capsule ingress -> material chain;
 *   - authored actor steps (the WP-13B ActorStep data shape; the driver
 *     compiles them with compileActorProgram, then the COMPILED steps form
 *     the WP-13A scenario actorProgram and must pass validateScenario);
 *   - expectedWorld { heads } + expectation section policies;
 *   - expectedRefusal (the honest typed-refusal terminal family);
 *   - expectedInvariants - the closed invariant vocabulary the driver
 *     evaluates over the observed normalized world.
 *
 * LAWS inherited from WP-13A and kept closed here:
 *   - the 53-command universe is CLOSED (fault anchors and authored steps
 *     must name frozen commands);
 *   - the scenario faultSchedule holds ONLY scheduler-level classes
 *     (crash/worker-loss/projection): input-level faults (stale hash,
 *     foreign refs, omissions, duplicates) are AUTHORED AS ACTOR BEHAVIORS
 *     in the program - the single honest place where they exist;
 *   - a schedule arming MORE THAN ONE crash is a crash MATRIX (one process
 *     dies once per execution): the driver runs one armed crash per
 *     execution and every settled world must equal the clean golden world.
 */

export const PROJECT_CORPUS_FORMAT_VERSION = 'ek.project-corpus.ek9.v1';

/* ------------------------------------------------------------------ */
/* Closed project vocabularies                                         */
/* ------------------------------------------------------------------ */

/** The corpus inventory kinds (what each project exercises). */
export const PROJECT_KINDS = [
  'interactive-served',
  'static',
  'batch',
  'scheduled',
  'autonomous',
  'cross-module',
  'topology',
  'honest-failure',
  'human-wait',
  'effect-uncertainty',
  'restart-heavy',
  'idempotency',
];

/** What the project delivers (the product families). */
export const PRODUCT_CLASSES = [
  'served-html-app',
  'static-site',
  'batch-report',
  'autonomous-decision',
  'cross-module-pair',
  'none',
];

/** Hermetic product verification profiles. */
export const PRODUCT_VERIFICATIONS = [
  'build-loopback-smoke',
  'build-structure-determinism',
  'build-determinism-replay',
  'none',
];

/** Public-command execution engines. */
export const DRIVE_MODES = [
  'durable-session',
  'planning-conveyor',
  'development-vertical',
];

/**
 * Expectation section policies. 'exact' is the WP-13A law (declared must
 * equal demonstrated, both directions); 'declared-subset' keeps the missing
 * direction only (every declared entry must be demonstrated) and MUST carry
 * a justification - it is reserved for sections whose demonstrated multiset
 * includes mode-internal lane rows the universe tables do not determine
 * (e.g. per-application obligation lanes left open by design).
 */
export const EXPECTATION_POLICIES = ['exact', 'declared-subset'];
export const EXPECTATION_SECTIONS = [
  'events',
  'obligations',
  'waits',
  'proofs',
  'evidence.material',
  'evidence.gate',
  'evidence.effect',
];

/**
 * The closed invariant vocabulary evaluated by the driver over the observed
 * normalized world (see tools/project-corpus/lib/invariants.mjs).
 */
export const EXPECTED_INVARIANTS = [
  'no-invariant-violations',
  'no-obligation-completed-twice',
  'no-open-terminal-drain-obligations',
  'one-admitted-receipt-per-attempt',
  'workplace-terminal-success',
  'truthful-failure-ladder',
  'typed-refusal-family',
  'worker-loss-classified-never-failed',
  'operator-discharges-human-wait',
  'd12-uncertainty-pending-operator-only',
  'readiness-boundary-intact',
  'idempotent-replay-no-double-commit',
  'exactly-once-under-schedule',
  'crash-matrix-covers-registry',
  'projection-rehydrates-from-ledger',
  'stale-write-refused-and-ineffective',
  'product-verification-green',
  'product-determinism',
  'determinism-replay',
  'time-budget',
];

/** The WP-13B scheduler-level fault classes a schedule may declare. */
export const SCHEDULER_FAULT_CLASSES = [
  'crash-before-commit',
  'crash-after-event',
  'worker-loss',
  'projection-wipe',
  'projection-stale-write',
];

/* ------------------------------------------------------------------ */
/* Closed key sets                                                     */
/* ------------------------------------------------------------------ */

export const DESCRIPTOR_KEYS = [
  'formatVersion',
  'projectId',
  'projectKind',
  'description',
  'product',
  'drive',
  'scenario',
  'expectedWorld',
  'expectedRefusal',
  'expectedInvariants',
  'notes',
];

export const PRODUCT_KEYS = ['class', 'verification', 'fixture'];
export const DRIVE_KEYS = ['mode', 'conveyorTopology', 'comparison'];
export const COMPARISON_KEYS = [
  'referenceSections',
  'expectationPolicies',
  'justifications',
];

/** The authored actor-step keys (WP-13B ActorStep data shape). */
export const AUTHORED_STEP_KEYS = [
  'stepId',
  'semanticProfile',
  'behavior',
  'command',
  'instance',
  'key',
  'evidenceRefs',
  'pin',
  'protocolRole',
  'intentOf',
  'gateVerdict',
  'effectOutcome',
  'terminalOutcome',
  'stageRoute',
  'revisionOffset',
  'manifestBag',
  'dropFields',
  'duplicate',
  'tools',
];

/** The authored program section keys. */
export const PROGRAM_KEYS = ['steps', 'allowedTools', 'seed', 'expectAdmissionReceipts'];
export const EXPECTED_WORLD_KEYS = ['heads', 'allowExtraHeads'];
export const HEAD_KEYS = ['instanceId', 'status', 'terminal'];

export const PROJECT_ID_PATTERN = /^p[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$/;

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export class ProjectDescriptorValidationError extends Error {
  constructor(errors) {
    super(
      `project descriptor invalid (${errors.length} error${errors.length === 1 ? '' : 's'}):\n${errors
        .map((e) => `  ${e.path}: [${e.code}] ${e.message}`)
        .join('\n')}`,
    );
    this.name = 'ProjectDescriptorValidationError';
    this.errors = errors;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

function closedKeys(obj, allowed, path, err) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      err(path, 'unknown-key', `key "${key}" is not part of the closed descriptor shape (allowed: ${allowed.join(', ')})`);
    }
  }
}

function inVocabulary(value, allowed, path, err, label) {
  if (!allowed.includes(value)) {
    err(path, 'not-in-vocabulary', `${label} "${value}" is not in the closed corpus vocabulary`);
    return false;
  }
  return true;
}

/**
 * Validate one project descriptor against the closed corpus contract.
 * The scenario SECTION shape (identity/seedInput/topology/faultSchedule/
 * expectations/verification/timeBudgets) is validated field-by-field here
 * against the same closed vocabularies; the driver additionally runs the
 * full WP-13A validateScenario over the compiled scenario document.
 */
export function validateProjectDescriptor(doc) {
  const errors = [];
  const err = (path, code, message) => errors.push({ path, code, message });

  if (!isObject(doc)) {
    err('$', 'wrong-type', 'a project descriptor must be a JSON object');
    return { valid: false, errors };
  }
  closedKeys(doc, DESCRIPTOR_KEYS, '$', err);
  const required = ['formatVersion', 'projectId', 'projectKind', 'description', 'product', 'drive', 'scenario', 'expectedWorld', 'expectedInvariants'];
  for (const key of required) {
    if (!(key in doc)) err(`$.${key}`, 'missing-key', `required key "${key}" is absent`);
  }

  if ('formatVersion' in doc && doc.formatVersion !== PROJECT_CORPUS_FORMAT_VERSION) {
    err('$.formatVersion', 'invalid-value', `formatVersion must be "${PROJECT_CORPUS_FORMAT_VERSION}"`);
  }
  if ('projectId' in doc && !(isNonEmptyString(doc.projectId) && PROJECT_ID_PATTERN.test(doc.projectId))) {
    err('$.projectId', 'invalid-value', `projectId must match ${PROJECT_ID_PATTERN}`);
  }
  if ('projectKind' in doc) inVocabulary(doc.projectKind, PROJECT_KINDS, '$.projectKind', err, 'project kind');
  if ('description' in doc && !isNonEmptyString(doc.description)) {
    err('$.description', 'wrong-type', 'description must be a nonempty string');
  }
  if ('notes' in doc) {
    if (!Array.isArray(doc.notes)) err('$.notes', 'wrong-type', 'notes must be an array of strings');
    else doc.notes.forEach((note, i) => { if (!isNonEmptyString(note)) err(`$.notes[${i}]`, 'wrong-type', 'a note must be a nonempty string'); });
  }

  /* product */
  if ('product' in doc) {
    const product = doc.product;
    if (!isObject(product)) err('$.product', 'wrong-type', 'product must be a JSON object');
    else {
      closedKeys(product, PRODUCT_KEYS, '$.product', err);
      for (const key of PRODUCT_KEYS) {
        if (!(key in product)) err(`$.product.${key}`, 'missing-key', `required key "${key}" is absent`);
      }
      if ('class' in product) inVocabulary(product.class, PRODUCT_CLASSES, '$.product.class', err, 'product class');
      if ('verification' in product) inVocabulary(product.verification, PRODUCT_VERIFICATIONS, '$.product.verification', err, 'product verification');
      if ('fixture' in product && product.fixture !== null && !isNonEmptyString(product.fixture)) {
        err('$.product.fixture', 'wrong-type', 'fixture must be a nonempty string or null');
      }
      if (product?.verification === 'none' && product?.class !== 'none' && product?.verification === undefined) {
        err('$.product.verification', 'invalid-value', 'a real product class needs a verification profile');
      }
    }
  }

  /* drive */
  if ('drive' in doc) {
    const drive = doc.drive;
    if (!isObject(drive)) err('$.drive', 'wrong-type', 'drive must be a JSON object');
    else {
      closedKeys(drive, DRIVE_KEYS, '$.drive', err);
      if ('mode' in drive) inVocabulary(drive.mode, DRIVE_MODES, '$.drive.mode', err, 'drive mode');
      const mode = drive.mode;
      if ('conveyorTopology' in drive) {
        const allowed = ['chain', 'diamond', 'fan-in', 'fan-out', 'independent', 'failed-predecessor', 'upstream-repair'];
        if (!allowed.includes(drive.conveyorTopology)) {
          err('$.drive.conveyorTopology', 'not-in-vocabulary', `conveyor topology "${drive.conveyorTopology}" is not a WP-09 topology`);
        }
        if (mode !== undefined && mode !== 'planning-conveyor') {
          err('$.drive.conveyorTopology', 'invalid-value', 'conveyorTopology is only meaningful in planning-conveyor mode');
        }
      }
      if ('comparison' in drive) {
        const comparison = drive.comparison;
        if (!isObject(comparison)) err('$.drive.comparison', 'wrong-type', 'comparison must be a JSON object');
        else {
          closedKeys(comparison, COMPARISON_KEYS, '$.drive.comparison', err);
          if ('referenceSections' in comparison) {
            if (!Array.isArray(comparison.referenceSections)) err('$.drive.comparison.referenceSections', 'wrong-type', 'referenceSections must be an array');
            else comparison.referenceSections.forEach((section, i) => {
              if (!['heads', 'obligations', 'waits', 'proofs', 'evidenceKinds'].includes(section)) {
                err(`$.drive.comparison.referenceSections[${i}]`, 'not-in-vocabulary', `"${section}" is not a world-summary section`);
              }
            });
          }
          if ('expectationPolicies' in comparison) {
            const policies = comparison.expectationPolicies;
            if (!isObject(policies)) err('$.drive.comparison.expectationPolicies', 'wrong-type', 'expectationPolicies must be an object');
            else {
              closedKeys(policies, EXPECTATION_SECTIONS, '$.drive.comparison.expectationPolicies', err);
              for (const [section, policy] of Object.entries(policies)) {
                if (!inVocabulary(policy, EXPECTATION_POLICIES, `$.drive.comparison.expectationPolicies.${section}`, err, 'expectation policy')) continue;
                if (policy === 'declared-subset') {
                  const note = comparison.justifications?.[section];
                  if (!isNonEmptyString(note)) {
                    err(`$.drive.comparison.justifications.${section}`, 'missing-key', `section "${section}" uses declared-subset and must carry a justification`);
                  }
                }
              }
              if (policies.events !== undefined && policies.events !== 'exact') {
                const mode = drive.mode;
                if (mode !== 'planning-conveyor' && mode !== 'development-vertical') {
                  err('$.drive.comparison.expectationPolicies.events', 'invalid-value', 'the events section is exact for durable-session mode (only the conveyor/material-chain modes may declare a multiset policy, justified)');
                }
              }
            }
          }
          if ('justifications' in comparison) {
            if (!isObject(comparison.justifications)) err('$.drive.comparison.justifications', 'wrong-type', 'justifications must be a JSON object');
            else closedKeys(comparison.justifications, EXPECTATION_SECTIONS, '$.drive.comparison.justifications', err);
          }
        }
      }
    }
  }

  /* scenario section (the WP-13A shape minus actorProgram, which lives in
     scenario.program as authored WP-13B steps for durable-session mode) */
  if ('scenario' in doc) {
    const scenario = doc.scenario;
    if (!isObject(scenario)) err('$.scenario', 'wrong-type', 'scenario must be a JSON object');
    else {
      const SCENARIO_SECTION_KEYS = ['identity', 'seedInput', 'topology', 'faultSchedule', 'expectations', 'verification', 'timeBudgets', 'program'];
      closedKeys(scenario, SCENARIO_SECTION_KEYS, '$.scenario', err);
      for (const key of ['identity', 'seedInput', 'topology', 'faultSchedule', 'expectations', 'verification', 'timeBudgets']) {
        if (!(key in scenario)) err(`$.scenario.${key}`, 'missing-key', `required scenario key "${key}" is absent`);
      }
      if ('identity' in scenario && !isObject(scenario.identity)) {
        err('$.scenario.identity', 'wrong-type', 'identity must be a JSON object');
      }
      if ('seedInput' in scenario) {
        const seed = scenario.seedInput;
        if (!isObject(seed)) err('$.scenario.seedInput', 'wrong-type', 'seedInput must be a JSON object');
        else {
          if (seed.fresh !== true) err('$.scenario.seedInput.fresh', 'invalid-value', 'fresh must be true (a project always starts from a new empty world)');
          if (!(Number.isInteger(seed.seed) && seed.seed >= 0 && seed.seed <= 0xffffffff)) {
            err('$.scenario.seedInput.seed', 'invalid-value', 'seed must be a uint32');
          }
          if (seed.ingress !== undefined && !Array.isArray(seed.ingress)) {
            err('$.scenario.seedInput.ingress', 'wrong-type', 'ingress must be an array of command steps');
          }
        }
      }
      if ('faultSchedule' in scenario) {
        if (!Array.isArray(scenario.faultSchedule)) err('$.scenario.faultSchedule', 'wrong-type', 'faultSchedule must be an array');
        else scenario.faultSchedule.forEach((fault, i) => {
          const at = `$.scenario.faultSchedule[${i}]`;
          if (!isObject(fault)) {
            err(at, 'wrong-type', 'a fault entry must be a JSON object');
            return;
          }
          closedKeys(fault, ['fault', 'anchor', 'boundary'], at, err);
          if ('fault' in fault) inVocabulary(fault.fault, SCHEDULER_FAULT_CLASSES, `${at}.fault`, err, 'scheduler fault class');
          if ('boundary' in fault) {
            const boundaries = [
              'before-event', 'after-event', 'before-evidence', 'after-evidence', 'before-obligation', 'after-obligation',
              'before-worker', 'after-worker', 'before-gate', 'after-gate', 'before-effect', 'after-effect',
              'before-settlement-commit', 'after-settlement-commit',
            ];
            inVocabulary(fault.boundary, boundaries, `${at}.boundary`, err, 'restart boundary');
          }
          if ('anchor' in fault) {
            const anchor = fault.anchor;
            if (!isObject(anchor)) err(`${at}.anchor`, 'wrong-type', 'anchor must be { command, instanceId, occurrence? }');
            else {
              closedKeys(anchor, ['command', 'instanceId', 'occurrence'], `${at}.anchor`, err);
              if ('occurrence' in anchor && !(Number.isInteger(anchor.occurrence) && anchor.occurrence >= 1)) {
                err(`${at}.anchor.occurrence`, 'invalid-value', 'occurrence must be an integer >= 1');
              }
            }
          }
        });
      }
      if ('expectations' in scenario) {
        const exp = scenario.expectations;
        if (!isObject(exp)) err('$.scenario.expectations', 'wrong-type', 'expectations must be a JSON object');
        else {
          closedKeys(exp, ['events', 'obligations', 'waits', 'proofs', 'evidence'], '$.scenario.expectations', err);
          for (const key of ['events', 'obligations', 'waits', 'proofs', 'evidence']) {
            if (!(key in exp)) err(`$.scenario.expectations.${key}`, 'missing-key', `required expectation key "${key}" is absent`);
          }
          if ('evidence' in exp && !isObject(exp.evidence)) {
            err('$.scenario.expectations.evidence', 'wrong-type', 'evidence must be { material, gate, effect }');
          }
        }
      }
      if ('verification' in scenario && !isObject(scenario.verification)) {
        err('$.scenario.verification', 'wrong-type', 'verification must be a JSON object');
      }
      if ('timeBudgets' in scenario) {
        const tb = scenario.timeBudgets;
        if (!isObject(tb)) err('$.scenario.timeBudgets', 'wrong-type', 'timeBudgets must be a JSON object');
        else if (!(Number.isInteger(tb.totalMs) && tb.totalMs > 0)) {
          err('$.scenario.timeBudgets.totalMs', 'invalid-value', 'totalMs must be a positive integer');
        }
      }
      /* the authored program (durable-session mode) */
      if ('program' in scenario) {
        const program = scenario.program;
        if (!isObject(program)) err('$.scenario.program', 'wrong-type', 'program must be a JSON object');
        else {
          closedKeys(program, PROGRAM_KEYS, '$.scenario.program', err);
          if ('steps' in program && !Array.isArray(program.steps)) {
            err('$.scenario.program.steps', 'wrong-type', 'steps must be an array of authored actor steps');
          }
          if ('steps' in program && Array.isArray(program.steps)) {
            program.steps.forEach((step, i) => {
              const at = `$.scenario.program.steps[${i}]`;
              if (!isObject(step)) {
                err(at, 'wrong-type', 'an authored step must be a JSON object');
                return;
              }
              closedKeys(step, AUTHORED_STEP_KEYS, at, err);
              for (const key of ['stepId', 'semanticProfile', 'behavior', 'command', 'instance']) {
                if (!(key in step)) err(`${at}.${key}`, 'missing-key', `required authored-step key "${key}" is absent`);
              }
              if ('tools' in step && !Array.isArray(step.tools)) err(`${at}.tools`, 'wrong-type', 'tools must be an array of tool names');
              if ('dropFields' in step && !Array.isArray(step.dropFields)) err(`${at}.dropFields`, 'wrong-type', 'dropFields must be an array');
            });
          }
        }
      }
    }
  }

  /* expectedWorld */
  if ('expectedWorld' in doc) {
    const world = doc.expectedWorld;
    if (!isObject(world)) err('$.expectedWorld', 'wrong-type', 'expectedWorld must be a JSON object');
    else {
      closedKeys(world, EXPECTED_WORLD_KEYS, '$.expectedWorld', err);
      if (!Array.isArray(world.heads)) err('$.expectedWorld.heads', 'wrong-type', 'heads must be an array');
      else world.heads.forEach((head, i) => {
        const at = `$.expectedWorld.heads[${i}]`;
        if (!isObject(head)) {
          err(at, 'wrong-type', 'a head expectation must be a JSON object');
          return;
        }
        closedKeys(head, HEAD_KEYS, at, err);
        if (!('instanceId' in head) || !isNonEmptyString(head.instanceId)) err(`${at}.instanceId`, 'wrong-type', 'instanceId must be a nonempty string');
        if (!('status' in head) || !isNonEmptyString(head.status)) err(`${at}.status`, 'wrong-type', 'status must be a nonempty string');
      });
      if ('allowExtraHeads' in world && typeof world.allowExtraHeads !== 'boolean') {
        err('$.expectedWorld.allowExtraHeads', 'wrong-type', 'allowExtraHeads must be a boolean');
      }
    }
  }

  /* expectedRefusal (optional, the honest typed-refusal terminal family) */
  if ('expectedRefusal' in doc && doc.expectedRefusal !== undefined) {
    const refusal = doc.expectedRefusal;
    if (!isObject(refusal)) err('$.expectedRefusal', 'wrong-type', 'expectedRefusal must be { stepId, reason }');
    else {
      closedKeys(refusal, ['stepId', 'reason'], '$.expectedRefusal', err);
      if (!isNonEmptyString(refusal.stepId ?? '')) err('$.expectedRefusal.stepId', 'wrong-type', 'stepId must be a nonempty string');
      if (!isNonEmptyString(refusal.reason ?? '')) err('$.expectedRefusal.reason', 'wrong-type', 'reason must be a nonempty string');
    }
  }

  /* expectedInvariants */
  if ('expectedInvariants' in doc) {
    if (!Array.isArray(doc.expectedInvariants)) err('$.expectedInvariants', 'wrong-type', 'expectedInvariants must be an array');
    else doc.expectedInvariants.forEach((invariant, i) => {
      inVocabulary(invariant, EXPECTED_INVARIANTS, `$.expectedInvariants[${i}]`, err, 'expected invariant');
    });
    if (Array.isArray(doc.expectedInvariants) && doc.expectedInvariants.includes('time-budget') && !(doc.scenario?.timeBudgets?.totalMs > 0)) {
      err('$.expectedInvariants', 'invalid-value', 'the time-budget invariant requires scenario.timeBudgets.totalMs');
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Throwing form. */
export function assertValidProjectDescriptor(doc) {
  const { valid, errors } = validateProjectDescriptor(doc);
  if (!valid) throw new ProjectDescriptorValidationError(errors);
  return doc;
}
