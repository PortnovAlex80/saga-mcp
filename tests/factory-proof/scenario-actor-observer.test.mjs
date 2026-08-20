// tests/factory-proof/scenario-actor-observer.test.mjs
//
// W0-3 acceptance (brief revision a8014c03):
//
//   A1 the reference scenario validates; the validator REJECTS scenarios
//      without declared fairness / budget(diagnosability+terminalBudget) /
//      injection prohibition — and harvested oracles without marking;
//   A2 the actor is deterministic: identical visible input → identical
//      output+digests regardless of call order or hidden attempt counters;
//   A3 the actor is non-omniscient: attempt number / scenario id are not on
//      the visible surface and CANNOT change the reaction;
//   A4 the counterfactual quartet: exact nonce feedback → repair; absent /
//      stale / corrupted → NO magical repair;
//   A5 the trace observer opens the DB readonly, writes no authority table,
//      and imports no reducer;
//   A6 the progress oracle classifies every lawful nonterminal and names an
//      anonymous stall.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateCausalFaultScenario,
  assertValidScenario,
  REFERENCE_SCENARIO,
  scenarioDigest,
} from './scenario-dsl.mjs';
import {
  createScriptedActor,
  visibleInputDigest,
  runCounterfactualQuartet,
  projectFeedbackVariant,
} from './scripted-actor.mjs';
import { classifyPostDrainProgress } from './trace-observer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// A1 — DSL validation.
// ---------------------------------------------------------------------------

test('A1: the reference scenario validates; malformed scenarios fail named', () => {
  assert.deepEqual(validateCausalFaultScenario(REFERENCE_SCENARIO), []);
  assert.match(scenarioDigest(REFERENCE_SCENARIO), /^[0-9a-f]{64}$/);

  const drop = (mutation, needle) => {
    const bad = structuredClone(REFERENCE_SCENARIO);
    mutation(bad);
    const errors = validateCausalFaultScenario(bad);
    assert.ok(errors.some(e => e.includes(needle)),
      `expected a '${needle}' violation, got: ${errors.join(';')}`);
  };

  drop(s => { delete s.assumptions.fairness; }, 'fairness');
  drop(s => { delete s.expected.diagnosability; }, 'diagnosability');
  drop(s => { delete s.expected.terminalBudget; }, 'terminalBudget');
  drop(s => { delete s.injection.forbidden; }, 'direct-outcome-write');
  drop(s => { s.oracle = { class: 'harvested' }; }, 'independentMarking');
  drop(s => { s.faultClass = 'cosmic-rays'; }, 'faultClass');
  drop(s => { delete s.counterfactualFeedback; }, 'counterfactualFeedback');
  drop(s => { s.repair.triggerReasonCode = 'SOME_OTHER_CODE'; }, 'EXACT feedback');
  drop(s => {
    s.mutant = { obligationId: 'x', mutantId: 'y', operatorId: 'z', violatedConstraint: 'w' };
  }, 'seedDigest');
  assert.throws(() => assertValidScenario({ ...REFERENCE_SCENARIO, faultClass: 'not-a-class' }),
    /CAUSAL_SCENARIO_INVALID/);
});

// ---------------------------------------------------------------------------
// A2/A3 — actor determinism + non-omniscience.
// ---------------------------------------------------------------------------

const REJECTION = {
  reasonCode: 'ARTIFACT_CONTENT_HASH_UNVERIFIABLE',
  subjectRef: 'docs/formalization/AC-1.md',
  evidence: { expectedPath: 'docs/formalization/AC-1.md', hint: 'write the bytes; omit the digest' },
};

function buildReferenceActor() {
  return createScriptedActor({
    rules: [
      {
        // The repair rule matches the EXACT visible evidence — nonce-bound.
        when: v => v.recoveryFeedback?.reasonCode === 'ARTIFACT_CONTENT_HASH_UNVERIFIABLE'
          && v.recoveryFeedback?.subjectRef === 'docs/formalization/AC-1.md'
          && v.recoveryFeedback?.evidence?.expectedPath === 'docs/formalization/AC-1.md',
        act: () => ({ action: 'resubmit', writeBytes: 'docs/formalization/AC-1.md', omitDigest: true }),
      },
    ],
    fallback: () => ({ action: 'worker-done-noop' }),
  });
}

test('A2: identical visible input → identical output and digests (any order, any count)', () => {
  const actor = buildReferenceActor();
  const visible = { prompt: 'author the acceptance contract', recoveryFeedback: REJECTION };
  const r1 = actor.react(visible);
  const r2 = actor.react({ recoveryFeedback: REJECTION, prompt: 'author the acceptance contract' });
  const r3 = actor.react(structuredClone(visible));
  assert.equal(r1.actorOutputDigest, r2.actorOutputDigest);
  assert.equal(r1.actorOutputDigest, r3.actorOutputDigest);
  assert.equal(r1.output.action, 'resubmit');
  assert.equal(r1.output.omitDigest, true);
  // The digest log is the causality witness.
  assert.equal(actor.digestLog().length, 3);
  assert.ok(actor.digestLog().every(e => e.visibleInputDigest === r1.visibleInputDigest));
});

test('A3: attempt numbers and scenario ids are not visible and cannot steer the actor', () => {
  const actor = buildReferenceActor();
  // A hidden test harness may KNOW this is attempt 3 of scenario X; the actor
  // receives only the visible surface. Two invocations at (fictional)
  // attempts 1 and 7 with identical visible input must not differ...
  const visible = { prompt: 'author', recoveryFeedback: null };
  const first = actor.react(visible);
  const seventh = actor.react(visible);
  assert.deepEqual(first.output, seventh.output);
  // ...and without the exact feedback the actor does NOT repair:
  assert.equal(first.output.action, 'worker-done-noop');
  // The visible surface has no scenario/attempt field at all:
  const digest1 = visibleInputDigest({ prompt: 'x', recoveryFeedback: REJECTION, attempt: 1, scenarioId: 'S-1' });
  const digest2 = visibleInputDigest({ prompt: 'x', recoveryFeedback: REJECTION, attempt: 9, scenarioId: 'S-other' });
  assert.equal(digest1, digest2,
    'canonicalVisibleInput must ignore attempt/scenario fields — they are not worker-visible');
});

// ---------------------------------------------------------------------------
// A4 — the counterfactual quartet.
// ---------------------------------------------------------------------------

test('A4: exact nonce feedback repairs; absent/stale/corrupted do not', () => {
  const actor = buildReferenceActor();
  const { results, causal, verdict } = runCounterfactualQuartet({
    actor,
    baseVisible: { prompt: 'author the acceptance contract' },
    exactFeedback: REJECTION,
    isRepair: output => output.action === 'resubmit' && output.omitDigest === true,
  });
  assert.equal(causal, true, verdict);
  assert.equal(results.exact.repaired, true);
  assert.equal(results.absent.repaired, false);
  assert.equal(results.stale.repaired, false, 'stale subject → the nonce rule must not match');
  assert.equal(results.corrupted.repaired, false, 'corrupted reason → the nonce rule must not match');

  // Negative control: an omniscient actor (repairs regardless of feedback)
  // is CAUGHT by the quartet — this is the W0-4 mutation 'actor secretly
  // looks at the attempt number' in miniature.
  const omniscient = createScriptedActor({
    rules: [{ when: () => true, act: () => ({ action: 'resubmit', omitDigest: true }) }],
    fallback: () => ({ action: 'worker-done-noop' }),
  });
  const omni = runCounterfactualQuartet({
    actor: omniscient,
    baseVisible: { prompt: 'x' },
    exactFeedback: REJECTION,
    isRepair: o => o.action === 'resubmit',
  });
  assert.equal(omni.causal, false, 'the quartet must catch a feedback-blind repair');
});

test('A4b: feedback variants project the declared shapes', () => {
  assert.equal(projectFeedbackVariant(REJECTION, 'absent'), null);
  assert.match(projectFeedbackVariant(REJECTION, 'stale').subjectRef, /@revision-0$/);
  assert.equal(projectFeedbackVariant(REJECTION, 'corrupted').reasonCode.includes('UNVERIFIABLE'), false);
  assert.deepEqual(projectFeedbackVariant(REJECTION, 'exact'), REJECTION);
});

// ---------------------------------------------------------------------------
// A5 — observer purity.
// ---------------------------------------------------------------------------

test('A5: the observer opens readonly, writes nothing, imports no reducer', () => {
  const source = readFileSync(path.join(HERE, 'trace-observer.mjs'), 'utf8');
  assert.ok(source.includes("readonly: true"), 'the DB handle must be readonly');
  assert.ok(!/INSERT|UPDATE|DELETE FROM/.test(source),
    'the observer must contain no mutation SQL');
  assert.ok(!/from\s+'[^']*dist\//.test(source),
    'the observer must not import or reconstruct reducer logic');
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(imports.filter(i => i.includes('dist/')), [],
    'the observer must not depend on production modules');
  assert.ok(!/(INSERT|UPDATE|DELETE)/.test(source), 'no mutation SQL anywhere in the observer');
});

// ---------------------------------------------------------------------------
// A6 — the progress oracle.
// ---------------------------------------------------------------------------

function traceWith(workplaces, { obligations = [], executions = [], tasks = [] } = {}) {
  return {
    workplaces,
    transitionObligations: obligations,
    workerExecutions: executions,
    workIntents: tasks,
  };
}

test('A6: every lawful nonterminal classifies; an anonymous stall is named', () => {
  const trace = traceWith([
    { workplace_ref: 'w/terminal', loop_state: 'terminal', terminal_reason: 'accepted', kanban_phase: 'done' },
    { workplace_ref: 'w/owned', loop_state: 'authoring', kanban_phase: 'doing' },
    { workplace_ref: 'w/waiting', loop_state: 'paused', kanban_phase: 'doing' },
    { workplace_ref: 'w/stalled', loop_state: 'authoring', kanban_phase: 'doing' },
  ], {
    tasks: [{ id: 11, workplace_ref: 'w/owned', task_kind: 'k', status: 'in_progress' }],
    executions: [{ execution_ref: 'e1', task_id: 11, state: 'running', voided_at: null }],
    obligations: [{ obligation_key: 'obl-1', source_kind: 's', source_ref: 'factory_workplaces/w/owned', handoff_kind: 'h', state: 'pending', last_error: null }],
  });
  const verdict = classifyPostDrainProgress(trace);
  const byWp = Object.fromEntries(verdict.rows.map(r => [r.workplace, r.classification]));
  assert.equal(byWp['w/terminal'], 'typed-terminal');
  assert.equal(byWp['w/owned'], 'runnable-owner');
  assert.equal(byWp['w/waiting'], 'typed-wait');
  assert.equal(byWp['w/stalled'], 'ANONYMOUS-STALL');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.stalls.length, 1);

  const clean = classifyPostDrainProgress(traceWith([
    { workplace_ref: 'w/ok', loop_state: 'terminal', terminal_reason: 'accepted', kanban_phase: 'done' },
  ]));
  assert.equal(clean.ok, true);
});
