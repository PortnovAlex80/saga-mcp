/**
 * tools/frf-corpus/format.mjs - the ADDITIVE FRF scenario-contract extension
 * of the EK-9 scenario format (FRF-WP10).
 *
 * The EK scenario contract (tests/workflow-kernel/engine/scenario.mjs) is
 * CLOSED: its validator refuses unknown top-level keys. This module extends
 * it the only lawful way - additively, without editing the EK-owned file:
 *
 *   validateFr fScenario(doc) =
 *     1. split the document into the EK base sections and the new `frf`
 *        block (an unknown top-level key to the EK validator);
 *     2. validate the base sections with the EK validator unchanged
 *        (identity/seedInput/topology/expectations/verification/timeBudgets);
 *     3. validate the `frf` block against THIS module's closed vocabulary:
 *        the formalization desk chain, the WP03 typed-refusal vocabulary,
 *        the cell gate verdicts, the twelve frozen binding domains, the
 *        F-2 closure verdicts, the mutation classes, and the crash windows
 *        whose resume points are the WP07 persistence module's D12/D5
 *        waits.
 *
 * Every vocabulary below is CLOSED and mirrored from the frozen sources
 * (the WP03 contract validators, the cell protocol declarations); the
 * test suite (tests/frf-corpus/format.test.mjs) pins every mirror against
 * its source of truth by identity/set-equality, never by eyeball.
 *
 * PURITY: node builtins + the EK scenario contract module + the WP03
 * docs-tree validator constants. No database, no network, no cells.
 */

import { createHash } from 'node:crypto';
import { SCENARIO_FORMAT_VERSION, validateScenario } from '../../tests/workflow-kernel/engine/scenario.mjs';
import { HANDOFF_BINDING_KINDS as WP03_HANDOFF_BINDING_KINDS } from '../../docs/refactoring/formalization-frf/contracts/validators/what-baseline.mjs';

/** The FRF extension block's own format version. */
export const FRF_BLOCK_FORMAT_VERSION = 'frf.scenario-block.frf10.v1';

/** The EK base format the extension rides on (pinned by tests). */
export const EK_BASE_FORMAT_VERSION = SCENARIO_FORMAT_VERSION;

/* ------------------------------------------------------------------ */
/* Closed vocabularies (mirrored from the frozen sources)              */
/* ------------------------------------------------------------------ */

/**
 * The formalization desk chain of the NEW semantic chain (cell protocol
 * declarations, FRF-WP04..09): product-intent -> UC -> system-requirements
 * -> acceptance -> reconciliation -> WHAT-freeze -> SRS realization ->
 * settlement -> the DevelopmentCase/plan handoff.
 */
export const FRF_DESK_CHAIN = Object.freeze([
  'define-product-intent',
  'model-use-cases',
  'derive-system-requirements',
  'define-acceptance-contract',
  'reconcile-what',
  'freeze-what-baseline',
  'define-architecture-contract',
  'settle-formalization',
  'admit-development-case',
  'plan-development',
]);

/** The per-desk verdict vocabularies (cell gates + desk outcome tables). */
export const FRF_DESK_VERDICTS = Object.freeze({
  'define-product-intent': Object.freeze(['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject']),
  'model-use-cases': Object.freeze(['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject']),
  'derive-system-requirements': Object.freeze(['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject']),
  'define-acceptance-contract': Object.freeze(['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject']),
  'reconcile-what': Object.freeze(['consistent', 'gaps']),
  'freeze-what-baseline': Object.freeze(['frozen', 'drift-detected', 'indeterminate', 'upstream-repair', 'repair', 'failed']),
  'define-architecture-contract': Object.freeze(['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject']),
  'settle-formalization': Object.freeze(['formalized', 'inconsistent', 'failed']),
  'admit-development-case': Object.freeze(['admitted', 'refused']),
  'plan-development': Object.freeze(['planned', 'refused']),
});

/** The WP03 typed-refusal vocabulary (the seven frozen reasons). */
export const FRF_REFUSAL_REASONS = Object.freeze([
  'FOREIGN_LINEAGE',
  'MISSING_LINEAGE',
  'STALE_LINEAGE',
  'MALFORMED_PRODUCT',
  'COVERAGE_GAP',
  'DRIFT_DETECTED',
  'SCOPE_VIOLATION',
]);

/**
 * The twelve frozen Development handoff binding domains (the WP03
 * what-baseline validator's HANDOFF_BINDING_KINDS; pinned by tests).
 */
export const FRF_BINDING_DOMAIN_KINDS = Object.freeze([
  'acceptance-bindings',
  'formalization-certificate',
  'integration-and-construction-obligations',
  'prd-intent-bindings',
  'repository-and-policy-bindings',
  'requirement-bindings',
  'scenario-bindings',
  'scenario-realization-bindings',
  'solution-contract',
  'srs-reference-and-hash',
  'terminal-claim-bindings',
  'what-baseline-reference-and-hash',
]);

/** The F-2 closure verdicts (computed by the reconciliation report). */
export const FRF_CLOSURE_VERDICTS = Object.freeze(['consistent', 'gaps']);

/** The typed waits of the chain (the D12/D5 resume points). */
export const FRF_WAIT_KINDS = Object.freeze(['TypedWait:human-input', 'TypedWait:effect-uncertainty']);

/** The required scenario dimensions of the FRF flow (plan FRF-WP10). */
export const FRF_DIMENSIONS = Object.freeze([
  'desk-chain-happy',
  'binding-mutation-sweep',
  'reconciliation-drift',
  'what-freeze-authority-mutation',
  'srs-elite-kill',
  'planning-gate-kill',
  'replan-identity-cycle',
  'human-wait-disposition',
  'crash-restart-matrix',
]);

/** The seed fixture corpora the chain may start from (frozen evidence). */
export const FRF_SEED_FIXTURES = Object.freeze(['wp03-frozen-green', 'wp08-elite']);

/* ------------------------------------------------------------------ */
/* The mutation vocabulary (input faults, pure data transformations)   */
/* ------------------------------------------------------------------ */

/**
 * Mutation classes: input transformations applied to the green seed
 * material at a named target. One mutation per chain run (a refusal
 * stops the chain - the first failing desk decides).
 */
export const FRF_MUTATION_KINDS = Object.freeze([
  'foreign-binding',
  'stale-binding',
  'omitted-binding',
  'substituted-member',
  'folded-section',
  'missing-entrypoint',
  'missing-composition',
  'drifted-snapshot',
  'mutated-survivor',
  'scenario-incomplete',
]);

/** The closed mutation targets (desk + the binding surface mutated). */
export const FRF_MUTATION_TARGETS = Object.freeze([
  'define-product-intent:sourceClaimRefs',
  'model-use-cases:prdIntentRefs',
  'derive-system-requirements:prdRevisionPin',
  'derive-system-requirements:prdIntentRefs',
  'define-acceptance-contract:requirementRefs',
  'define-acceptance-contract:ucTerminalBranchRefs',
  'reconcile-what:snapshot',
  'freeze-what-baseline:containers.uc.members',
  'freeze-what-baseline:containers.fr+nfr',
  'freeze-what-baseline:surfaces.dispositions',
  'settle-formalization:handoff.scenario-bindings',
  'settle-formalization:handoff.requirement-bindings',
  'define-architecture-contract:entrypoint',
  'define-architecture-contract:composition',
  'admit-development-case:scenario-bindings',
  'plan-development:scenario-realization',
  'replan-development:mutated-survivor',
]);

/** The lawful kind x target pairs (a mutation class targets its surfaces). */
export const FRF_MUTATION_KIND_TARGETS = Object.freeze({
  'foreign-binding': Object.freeze([
    'define-product-intent:sourceClaimRefs',
    'model-use-cases:prdIntentRefs',
    'derive-system-requirements:prdIntentRefs',
    'define-acceptance-contract:requirementRefs',
    'settle-formalization:handoff.requirement-bindings',
    'admit-development-case:scenario-bindings',
  ]),
  'stale-binding': Object.freeze([
    'derive-system-requirements:prdRevisionPin',
  ]),
  'omitted-binding': Object.freeze([
    'define-acceptance-contract:ucTerminalBranchRefs',
    'freeze-what-baseline:surfaces.dispositions',
    'settle-formalization:handoff.scenario-bindings',
  ]),
  'substituted-member': Object.freeze([
    'freeze-what-baseline:containers.uc.members',
  ]),
  'folded-section': Object.freeze([
    'freeze-what-baseline:containers.fr+nfr',
  ]),
  'missing-entrypoint': Object.freeze([
    'define-architecture-contract:entrypoint',
  ]),
  'missing-composition': Object.freeze([
    'define-architecture-contract:composition',
  ]),
  'drifted-snapshot': Object.freeze([
    'reconcile-what:snapshot',
  ]),
  'mutated-survivor': Object.freeze([
    'replan-development:mutated-survivor',
  ]),
  'scenario-incomplete': Object.freeze([
    'plan-development:scenario-realization',
  ]),
});

/* ------------------------------------------------------------------ */
/* The fault schedule vocabulary (crash windows + resume points)       */
/* ------------------------------------------------------------------ */

/**
 * Crash classes over the desk chain. The evidence-commit seams are the
 * immutable kernel-evidence submissions of the freeze/settle desks; the
 * wait-disposition seams are the D12/D5 resume points (a crash while a
 * typed wait is open resumes at the wait, never at a re-derived desk).
 */
export const FRF_FAULT_CLASSES = Object.freeze([
  'crash-before-desk',
  'crash-after-desk',
  'crash-before-evidence-commit',
  'crash-after-evidence-commit',
  'crash-before-wait-disposition',
  'crash-after-wait-disposition',
]);

/** Every crash window is anchored at a desk of the chain or a wait point. */
export const FRF_FAULT_ANCHORS = Object.freeze([...FRF_DESK_CHAIN, 'd5-human-wait', 'replan-development']);

/** The evidence-commit seam classes may only anchor at the evidence desks. */
export const FRF_EVIDENCE_COMMIT_ANCHORS = Object.freeze(['freeze-what-baseline', 'settle-formalization']);
/** The wait-disposition seam classes anchor only at the D5/D12 waits. */
export const FRF_WAIT_DISPOSITION_ANCHORS = Object.freeze(['d5-human-wait']);

/* ------------------------------------------------------------------ */
/* Closed key sets                                                     */
/* ------------------------------------------------------------------ */

export const FRF_BLOCK_KEYS = Object.freeze([
  'scenarioId',
  'formatVersion',
  'dimension',
  'seedFixture',
  'seed',
  'mutations',
  'faultSchedule',
  'expectedWorld',
  'notes',
]);

export const FRF_EXPECTED_WORLD_KEYS = Object.freeze([
  'verdicts',
  'sweep',
  'refusals',
  'bindingDomains',
  'closure',
  'waits',
  'terminal',
  'capsuleKinds',
  'crashLaw',
]);

export const FRF_VERDICT_ENTRY_KEYS = Object.freeze(['desk', 'verdict']);
export const FRF_SWEEP_ENTRY_KEYS = Object.freeze(['target', 'reason', 'verdict']);
export const FRF_REFUSAL_ENTRY_KEYS = Object.freeze(['target', 'reason']);
export const FRF_BINDING_DOMAIN_ENTRY_KEYS = Object.freeze(['kind', 'ids']);
export const FRF_CLOSURE_KEYS = Object.freeze(['verdict', 'gapReasons']);
export const FRF_WAIT_ENTRY_KEYS = Object.freeze(['kind', 'state']);
export const FRF_TERMINAL_KEYS = Object.freeze(['developmentCase', 'plan', 'replan']);
export const FRF_MUTATION_KEYS = Object.freeze(['kind', 'target']);
export const FRF_FAULT_KEYS = Object.freeze(['fault', 'anchor']);

/** Dimension-specific mandatory expectation sections (checked here, then by the driver). */
export const FRF_DIMENSION_REQUIRED_SECTIONS = Object.freeze({
  'desk-chain-happy': ['verdicts', 'bindingDomains', 'closure', 'terminal', 'capsuleKinds'],
  'binding-mutation-sweep': ['sweep'],
  'reconciliation-drift': ['closure'],
  'what-freeze-authority-mutation': ['sweep'],
  'srs-elite-kill': ['sweep'],
  'planning-gate-kill': ['refusals'],
  'replan-identity-cycle': ['terminal'],
  'human-wait-disposition': ['waits', 'terminal'],
  'crash-restart-matrix': ['crashLaw'],
});

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isUint32 = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

function closedKeys(obj, allowed, path, err) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      err(path, 'unknown-key', `key "${key}" is not part of the closed frf block shape (allowed: ${allowed.join(', ')})`);
    }
  }
}

function inVocabulary(value, allowed, path, err, label) {
  if (!allowed.includes(value)) {
    err(path, 'not-in-vocabulary', `${label} "${String(value)}" is not in the frozen ${label} vocabulary`);
    return false;
  }
  return true;
}

function checkDeskVerdict(desk, verdict, path, err) {
  const allowed = FRF_DESK_VERDICTS[desk];
  if (allowed === undefined) {
    err(path, 'not-in-vocabulary', `desk "${String(desk)}" is not part of the frozen FRF desk chain`);
    return;
  }
  inVocabulary(verdict, allowed, path, err, 'verdict');
}

/** The scenario id pattern (sNN-kebab, one stable identity per scenario). */
export const FRF_SCENARIO_ID_PATTERN = /^s[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Validate one FRF scenario document (the EK base + the frf block).
 * Returns { valid, errors }; never throws.
 */
export function validateFrfScenario(doc) {
  const errors = [];
  const err = (path, code, message) => errors.push({ path, code, message });

  if (!isObject(doc)) {
    err('$', 'wrong-type', 'an FRF scenario must be a JSON object');
    return { valid: false, errors };
  }
  if (!('frf' in doc) || !isObject(doc.frf)) {
    err('$.frf', 'missing-key', 'the FRF scenario extension requires a `frf` block object');
    return { valid: false, errors };
  }

  // 1. The EK base sections, validated by the EK contract unchanged.
  const base = { ...doc };
  const frf = base.frf;
  delete base.frf;
  const baseResult = validateScenario(base);
  for (const error of baseResult.errors) errors.push(error);

  // 2. The frf block itself.
  closedKeys(frf, FRF_BLOCK_KEYS, '$.frf', err);
  if (!('scenarioId' in frf)) err('$.frf.scenarioId', 'missing-key', 'required key "scenarioId" is absent');
  else if (!FRF_SCENARIO_ID_PATTERN.test(frf.scenarioId)) {
    err('$.frf.scenarioId', 'invalid-value', `scenarioId must match ${FRF_SCENARIO_ID_PATTERN.source}`);
  }
  if (!('formatVersion' in frf)) err('$.frf.formatVersion', 'missing-key', 'required key "formatVersion" is absent');
  else if (frf.formatVersion !== FRF_BLOCK_FORMAT_VERSION) {
    err('$.frf.formatVersion', 'invalid-value', `formatVersion must be "${FRF_BLOCK_FORMAT_VERSION}"`);
  }
  if (!('dimension' in frf)) err('$.frf.dimension', 'missing-key', 'required key "dimension" is absent');
  else inVocabulary(frf.dimension, FRF_DIMENSIONS, '$.frf.dimension', err, 'dimension');
  if (!('seedFixture' in frf)) err('$.frf.seedFixture', 'missing-key', 'required key "seedFixture" is absent');
  else inVocabulary(frf.seedFixture, FRF_SEED_FIXTURES, '$.frf.seedFixture', err, 'seed fixture');
  if ('seed' in frf && !isUint32(frf.seed)) {
    err('$.frf.seed', 'invalid-value', 'seed must be a uint32 (the retained deterministic seed)');
  }
  if ('notes' in frf) {
    if (!Array.isArray(frf.notes)) err('$.frf.notes', 'wrong-type', 'notes must be an array of strings');
    else frf.notes.forEach((note, i) => { if (!isNonEmptyString(note)) err(`$.frf.notes[${i}]`, 'wrong-type', 'a note must be a nonempty string'); });
  }

  // 3. The mutation list (kind x target, closed).
  if ('mutations' in frf) {
    if (!Array.isArray(frf.mutations)) err('$.frf.mutations', 'wrong-type', 'mutations must be an array of { kind, target }');
    else frf.mutations.forEach((mutation, i) => {
      const at = `$.frf.mutations[${i}]`;
      if (!isObject(mutation)) {
        err(at, 'wrong-type', 'a mutation entry must be a JSON object');
        return;
      }
      closedKeys(mutation, FRF_MUTATION_KEYS, at, err);
      if (!('kind' in mutation)) err(`${at}.kind`, 'missing-key', 'required key "kind" is absent');
      if (!('target' in mutation)) err(`${at}.target`, 'missing-key', 'required key "target" is absent');
      if ('kind' in mutation && inVocabulary(mutation.kind, FRF_MUTATION_KINDS, `${at}.kind`, err, 'mutation kind')) {
        if ('target' in mutation) {
          if (!FRF_MUTATION_TARGETS.includes(mutation.target)) {
            err(`${at}.target`, 'not-in-vocabulary', `mutation target "${String(mutation.target)}" is not in the closed target vocabulary`);
          } else if (!FRF_MUTATION_KIND_TARGETS[mutation.kind].includes(mutation.target)) {
            err(`${at}.target`, 'invalid-value', `mutation kind "${mutation.kind}" may not target "${mutation.target}"`);
          }
        }
      }
      if ('target' in mutation && !isNonEmptyString(mutation.target)) {
        err(`${at}.target`, 'wrong-type', 'target must be a nonempty string');
      }
    });
  }

  // 4. The fault schedule (one crash per run: one process dies once).
  if ('faultSchedule' in frf) {
    if (!Array.isArray(frf.faultSchedule)) err('$.frf.faultSchedule', 'wrong-type', 'faultSchedule must be an array of { fault, anchor }');
    else {
      frf.faultSchedule.forEach((fault, i) => {
        const at = `$.frf.faultSchedule[${i}]`;
        if (!isObject(fault)) {
          err(at, 'wrong-type', 'a fault entry must be a JSON object');
          return;
        }
        closedKeys(fault, FRF_FAULT_KEYS, at, err);
        if ('fault' in fault && inVocabulary(fault.fault, FRF_FAULT_CLASSES, `${at}.fault`, err, 'fault class')) {
          if ('anchor' in fault && FRF_FAULT_ANCHORS.includes(fault.anchor)) {
            if (fault.fault.endsWith('evidence-commit') && !FRF_EVIDENCE_COMMIT_ANCHORS.includes(fault.anchor)) {
              err(`${at}.anchor`, 'invalid-value', `evidence-commit crashes anchor only at [${FRF_EVIDENCE_COMMIT_ANCHORS.join(', ')}]`);
            }
            if (fault.fault.endsWith('wait-disposition') && !FRF_WAIT_DISPOSITION_ANCHORS.includes(fault.anchor)) {
              err(`${at}.anchor`, 'invalid-value', `wait-disposition crashes anchor only at [${FRF_WAIT_DISPOSITION_ANCHORS.join(', ')}]`);
            }
          }
        }
        if ('anchor' in fault) inVocabulary(fault.anchor, FRF_FAULT_ANCHORS, `${at}.anchor`, err, 'fault anchor');
      });
      const crashes = frf.faultSchedule.filter((fault) => isObject(fault) && typeof fault.fault === 'string' && fault.fault.startsWith('crash-'));
      if (crashes.length > 1) {
        err('$.frf.faultSchedule', 'invalid-value', `the scenario schedules ${crashes.length} crashes; one process dies once`);
      }
    }
  }

  // 5. The expected world (authored from the WP03 vocabulary, never copied
  //    from production output - the tests pin the mirrors instead).
  if (!('expectedWorld' in frf) || !isObject(frf.expectedWorld)) {
    err('$.frf.expectedWorld', 'missing-key', 'required key "expectedWorld" (object) is absent');
  } else {
    const world = frf.expectedWorld;
    closedKeys(world, FRF_EXPECTED_WORLD_KEYS, '$.frf.expectedWorld', err);
    if ('verdicts' in world) {
      if (!Array.isArray(world.verdicts)) err('$.frf.expectedWorld.verdicts', 'wrong-type', 'verdicts must be an array of { desk, verdict }');
      else world.verdicts.forEach((entry, i) => {
        const at = `$.frf.expectedWorld.verdicts[${i}]`;
        if (!isObject(entry)) { err(at, 'wrong-type', 'a verdict expectation must be a JSON object'); return; }
        closedKeys(entry, FRF_VERDICT_ENTRY_KEYS, at, err);
        if ('desk' in entry && 'verdict' in entry) checkDeskVerdict(entry.desk, entry.verdict, `${at}.verdict`, err);
      });
    }
    if ('sweep' in world) {
      if (!Array.isArray(world.sweep)) err('$.frf.expectedWorld.sweep', 'wrong-type', 'sweep must be an array of { target, reason, verdict }');
      else world.sweep.forEach((entry, i) => {
        const at = `$.frf.expectedWorld.sweep[${i}]`;
        if (!isObject(entry)) { err(at, 'wrong-type', 'a sweep expectation must be a JSON object'); return; }
        closedKeys(entry, FRF_SWEEP_ENTRY_KEYS, at, err);
        if ('target' in entry && !FRF_MUTATION_TARGETS.includes(entry.target)) {
          err(`${at}.target`, 'not-in-vocabulary', `sweep target "${String(entry.target)}" is not in the closed target vocabulary`);
        }
        if ('reason' in entry) inVocabulary(entry.reason, FRF_REFUSAL_REASONS, `${at}.reason`, err, 'refusal reason');
        if ('target' in entry && 'reason' in entry && 'verdict' in entry) {
          const desk = String(entry.target).split(':')[0];
          checkDeskVerdict(desk, entry.verdict, `${at}.verdict`, err);
        }
      });
    }
    if ('refusals' in world) {
      if (!Array.isArray(world.refusals)) err('$.frf.expectedWorld.refusals', 'wrong-type', 'refusals must be an array of { target, reason }');
      else world.refusals.forEach((entry, i) => {
        const at = `$.frf.expectedWorld.refusals[${i}]`;
        if (!isObject(entry)) { err(at, 'wrong-type', 'a refusal expectation must be a JSON object'); return; }
        closedKeys(entry, FRF_REFUSAL_ENTRY_KEYS, at, err);
        if ('target' in entry && !isNonEmptyString(entry.target)) err(`${at}.target`, 'wrong-type', 'target must be a nonempty string');
        if ('reason' in entry) inVocabulary(entry.reason, FRF_REFUSAL_REASONS, `${at}.reason`, err, 'refusal reason');
      });
    }
    if ('bindingDomains' in world) {
      if (!Array.isArray(world.bindingDomains)) err('$.frf.expectedWorld.bindingDomains', 'wrong-type', 'bindingDomains must be an array of { kind, ids }');
      else world.bindingDomains.forEach((entry, i) => {
        const at = `$.frf.expectedWorld.bindingDomains[${i}]`;
        if (!isObject(entry)) { err(at, 'wrong-type', 'a binding-domain expectation must be a JSON object'); return; }
        closedKeys(entry, FRF_BINDING_DOMAIN_ENTRY_KEYS, at, err);
        if ('kind' in entry) inVocabulary(entry.kind, FRF_BINDING_DOMAIN_KINDS, `${at}.kind`, err, 'binding domain kind');
        if ('ids' in entry) {
          if (!Array.isArray(entry.ids) || entry.ids.length === 0 || !entry.ids.every(isNonEmptyString)) {
            err(`${at}.ids`, 'wrong-type', 'ids must be a nonempty array of binding ids');
          }
        }
      });
    }
    if ('closure' in world) {
      if (!isObject(world.closure)) err('$.frf.expectedWorld.closure', 'wrong-type', 'closure must be { verdict, gapReasons }');
      else {
        closedKeys(world.closure, FRF_CLOSURE_KEYS, '$.frf.expectedWorld.closure', err);
        if ('verdict' in world.closure) inVocabulary(world.closure.verdict, FRF_CLOSURE_VERDICTS, '$.frf.expectedWorld.closure.verdict', err, 'closure verdict');
        if ('gapReasons' in world.closure) {
          if (!Array.isArray(world.closure.gapReasons) || !world.closure.gapReasons.every((reason) => FRF_REFUSAL_REASONS.includes(reason))) {
            err('$.frf.expectedWorld.closure.gapReasons', 'not-in-vocabulary', 'gapReasons must be an array of typed refusal reasons');
          }
        }
      }
    }
    if ('waits' in world) {
      if (!Array.isArray(world.waits)) err('$.frf.expectedWorld.waits', 'wrong-type', 'waits must be an array of { kind, state }');
      else world.waits.forEach((entry, i) => {
        const at = `$.frf.expectedWorld.waits[${i}]`;
        if (!isObject(entry)) { err(at, 'wrong-type', 'a wait expectation must be a JSON object'); return; }
        closedKeys(entry, FRF_WAIT_ENTRY_KEYS, at, err);
        if ('kind' in entry) inVocabulary(entry.kind, FRF_WAIT_KINDS, `${at}.kind`, err, 'wait kind');
        if ('state' in entry) inVocabulary(entry.state, ['pending', 'discharged'], `${at}.state`, err, 'wait state');
      });
    }
    if ('terminal' in world) {
      if (!isObject(world.terminal)) err('$.frf.expectedWorld.terminal', 'wrong-type', 'terminal must be an object');
      else {
        closedKeys(world.terminal, FRF_TERMINAL_KEYS, '$.frf.expectedWorld.terminal', err);
        for (const key of ['developmentCase', 'plan', 'replan']) {
          if (key in world.terminal && !isNonEmptyString(world.terminal[key])) {
            err(`$.frf.expectedWorld.terminal.${key}`, 'wrong-type', `${key} must be a nonempty string`);
          }
        }
      }
    }
    if ('capsuleKinds' in world) {
      if (!Array.isArray(world.capsuleKinds) || !world.capsuleKinds.every(isNonEmptyString)) {
        err('$.frf.expectedWorld.capsuleKinds', 'wrong-type', 'capsuleKinds must be an array of capsule artifact kinds');
      }
    }
    if ('crashLaw' in world && world.crashLaw !== 'identical-normalized-world') {
      err('$.frf.expectedWorld.crashLaw', 'invalid-value', 'the crash law is "identical-normalized-world" (faulted+restarted settles to the clean world)');
    }

    // Dimension-specific mandatory sections.
    if ('dimension' in frf && FRF_DIMENSIONS.includes(frf.dimension)) {
      for (const section of FRF_DIMENSION_REQUIRED_SECTIONS[frf.dimension]) {
        if (!(section in world)) {
          err(`$.frf.expectedWorld.${section}`, 'missing-key', `dimension "${frf.dimension}" must declare "${section}" expectations`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Throwing form (lists every violation). */
export function assertValidFrfScenario(doc) {
  const { valid, errors } = validateFrfScenario(doc);
  if (!valid) {
    throw new Error(`FRF scenario contract invalid (${errors.length} error${errors.length === 1 ? '' : 's'}):\n${errors.map((e) => `  ${e.path}: [${e.code}] ${e.message}`).join('\n')}`);
  }
  return doc;
}

/* ------------------------------------------------------------------ */
/* Canonical form + digest                                             */
/* ------------------------------------------------------------------ */

/** The canonical JSON rule of the WP03 common module (single source). */
function canonicalJsonOf(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonOf).join(',');
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonOf(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 over the canonical JSON of the scenario (the scenario digest). */
export function frfScenarioDigest(doc) {
  return createHash('sha256').update(canonicalJsonOf(doc), 'utf8').digest('hex');
}

/**
 * The source-of-truth binding-kind list read from the frozen WP03
 * what-baseline validator (the test suite pins the mirror against this).
 */
export function wp03HandoffBindingKinds() {
  return [...WP03_HANDOFF_BINDING_KINDS];
}
