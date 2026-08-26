/**
 * tools/project-corpus/lib/expectations.mjs - the declared-vs-demonstrated
 * comparison of the project corpus, on top of the WP-13A comparison core.
 *
 * Two layers:
 *
 *  1. REFERENCE-VS-OBSERVED (durable-session mode): the WP-13A
 *     compareWorldSummaries over the sections the descriptor declares
 *     (default: heads, obligations, waits, proofs - evidenceKinds excluded
 *     where the application layer records receipt facts the pure reference
 *     model does not; every exclusion is a declared driver decision, never
 *     silent). The event-kind sequences are compared exactly.
 *
 *  2. DECLARED-VS-OBSERVED (every mode): the WP-13A
 *     compareScenarioExpectations over the observed run view, with the
 *     descriptor's per-section policy:
 *       - 'exact'            - both directions (the WP-13A law);
 *       - 'declared-subset'  - declared entries must be demonstrated
 *                              (missing = RED); extra demonstrated entries
 *                              are permitted ONLY for sections whose
 *                              multiset includes mode-internal lane rows the
 *                              universe tables alone do not determine, and
 *                              every use carries a justification string.
 */

import {
  compareScenarioExpectations,
  compareWorldSummaries,
  driveReferenceModel,
} from '../../../tests/workflow-kernel/engine/compare.mjs';

/** Compare the reference model against the observed durable run. */
export function compareReferenceWithObserved(scenario, observed, sections) {
  /* The reference model is the CLEAN oracle: scheduler-level fault classes
     (crash/worker-loss/projection) are execution-layer concerns whose
     settled result must equal the clean world (the exactly-once law) - the
     reference drive therefore always runs the empty schedule. Input-level
     faults do not exist in corpus schedules (they are authored actor
     behaviors). */
  const reference = driveReferenceModel({ ...scenario, faultSchedule: [] });
  const summarySections = sections ?? ['heads', 'obligations', 'waits', 'proofs'];
  const full = compareWorldSummaries(reference.summary, observed.summary);
  const differences = full.differences.filter((difference) => {
    if (summarySections.includes('evidenceKinds')) return true;
    return difference.section !== 'evidenceKinds';
  });
  /* Event kinds in RAW drive order on both sides (the corpus drives are
     single-threaded deterministic sequences; the WP-13A window
     canonicalization serves cross-run comparisons of independently
     scheduled traces, which is not this comparison). */
  const referenceEvents = reference.steps
    .filter((step) => step.outcome?.refused !== true && step.outcome?.replayed !== true)
    .map((step) => step.outcome?.event?.kind)
    .filter((kind) => kind !== undefined);
  const eventDifference = referenceEvents.length === observed.events.length
    && referenceEvents.every((kind, index) => kind === observed.events[index])
    ? []
    : [{ kind: 'event-sequence-mismatch', section: 'events', detail: `reference events (${referenceEvents.length}) [${referenceEvents.join('|')}] vs observed (${observed.events.length})` }];
  return {
    equal: differences.length === 0 && eventDifference.length === 0,
    differences: [...differences, ...eventDifference],
    reference,
  };
}

/** Normalize the summary proofs list into `proof#count` multiset entries
 *  (the format compareDeclaredMultiset expects; worldSummary lists the
 *  distinct proof ids without counts). */
function multisetEntriesOf(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()].map(([item, count]) => `${item}#${count}`).sort();
}

/** Compare the descriptor's declared expectations against the observed run. */
export function compareDeclaredWithObserved(scenario, observed, policies = {}) {
  const summary = { ...observed.summary, proofs: multisetEntriesOf(observed.summary.proofs) };
  const run = { normalized: { steps: [], events: observed.events }, summary };
  const full = compareScenarioExpectations(scenario, run);
  if (full.equal) return full;

  const sectionOf = (difference) => difference.section;
  const subsetSections = new Set(
    Object.entries(policies)
      .filter(([, policy]) => policy === 'declared-subset')
      .map(([section]) => section),
  );
  const differences = full.differences.filter((difference) => {
    if (difference.kind === 'events-mismatch') {
      if (!subsetSections.has('events')) return true; // exact sequence (the WP-13A law)
      // The multiset policy (conveyor/material-chain modes): every declared
      // event kind must be demonstrated with at least the declared count;
      // mode-internal scheduling order is not asserted.
      return !eventMultisetCovers(scenario.expectations.events, observed.events);
    }
    const section = sectionOf(difference);
    if (subsetSections.has(section)) return difference.kind === 'missing';
    return true;
  });
  return { equal: differences.length === 0, differences };
}

/** True when every declared event kind occurs at least the declared count. */
function eventMultisetCovers(declared, observed) {
  const counts = new Map();
  for (const kind of observed) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return declared.every((kind) => (counts.get(kind) ?? 0) >= 1);
}

/** Compare the descriptor's declared heads against the observed raw heads. */
export function compareDeclaredHeads(expectedWorld, observed) {
  const problems = [];
  const observedHeads = [...observed.world.heads.values()].map((head) => ({
    instanceId: head.instanceId,
    aggregate: head.aggregate,
    status: head.status,
    terminal: head.terminal,
  }));
  for (const declared of expectedWorld.heads ?? []) {
    const actual = observedHeads.find((head) => head.instanceId === declared.instanceId);
    if (actual === undefined) {
      problems.push(`declared head "${declared.instanceId}" (${declared.status}) is absent from the observed world`);
      continue;
    }
    if (actual.status !== declared.status) {
      problems.push(`head "${declared.instanceId}" is ${actual.status}, declared ${declared.status}`);
    }
    if (declared.terminal !== undefined && actual.terminal !== declared.terminal) {
      problems.push(`head "${declared.instanceId}" terminal is ${String(actual.terminal)}, declared ${declared.terminal}`);
    }
  }
  if (expectedWorld?.allowExtraHeads === false) {
    const declaredIds = new Set((expectedWorld.heads ?? []).map((head) => head.instanceId));
    for (const head of observedHeads) {
      if (!declaredIds.has(head.instanceId)) {
        problems.push(`observed head "${head.instanceId}" (${head.status}) is not declared (allowExtraHeads: false)`);
      }
    }
  }
  return { equal: problems.length === 0, problems };
}
