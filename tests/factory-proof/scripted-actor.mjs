// tests/factory-proof/scripted-actor.mjs
//
// W0-3 — the NON-OMNISCIENT scripted actor. It replaces ONLY model cognition
// (the canonical workerExecutorFactory seam already proven by W0-1) and sees
// EXACTLY what a production worker sees:
//
//     the WorkIntent / prompt text, the desk files, the MCP tool results or
//     errors, and the recovery feedback projected onto the desk.
//
// It NEVER sees: the scenario id, the attempt number, the hidden test state,
// the expected outcome, or the DB beyond its task's visible projection. Its
// reaction is selected by VISIBLE content (nonce / reason / evidence in the
// feedback), so the same visible input always produces the same output —
// determinism without omniscience. Every invocation records
// visibleInputDigest → actorOutputDigest, the causality witness the
// counterfactual runner asserts against.

import { createHash } from 'node:crypto';

const sha = v => createHash('sha256').update(JSON.stringify(v), 'utf8').digest('hex');

/**
 * Canonicalize the VISIBLE input surface. Field order is canonical (sorted)
 * so equal visible content yields an equal digest regardless of producer.
 */
export function canonicalVisibleInput(input) {
  return {
    prompt: input.prompt ?? null,
    deskFiles: input.deskFiles
      ? Object.fromEntries(Object.entries(input.deskFiles).sort(([a], [b]) => a.localeCompare(b)))
      : null,
    lastToolError: input.lastToolError ?? null,
    recoveryFeedback: input.recoveryFeedback ?? null,
  };
}

export function visibleInputDigest(input) {
  return sha(canonicalVisibleInput(input));
}

/**
 * Build an actor from REACTION RULES keyed by visible evidence.
 *
 * @param {object} opts
 * @param {Array<{when: (visible) => boolean, act: (visible) => object}>} opts.rules
 *        Ordered rules; the first match wins. `when` may only inspect the
 *        VISIBLE surface passed to it (enforced below by construction).
 * @param {(visible) => object} [opts.fallback] Required terminal behavior
 *        when no rule matches (an honest actor without a reaction declares
 *        a no-op worker_done — never a magical repair).
 */
export function createScriptedActor({ rules, fallback }) {
  if (!Array.isArray(rules)) throw new Error('ACTOR_RULES_REQUIRED');
  if (typeof fallback !== 'function') {
    throw new Error('ACTOR_FALLBACK_REQUIRED: an unmatched input must map to an honest no-op, not to a guess');
  }
  const digestLog = [];
  return {
    /**
     * React to VISIBLE input only.
     * @returns {{output: object, visibleInputDigest: string, actorOutputDigest: string}}
     */
    react(visibleInput) {
      const canonical = canonicalVisibleInput(visibleInput);
      const vid = sha(canonical);
      const rule = rules.find(r => r.when(canonical));
      const output = rule ? rule.act(canonical) : fallback(canonical);
      digestLog.push({ visibleInputDigest: vid, actorOutputDigest: sha({ output }) });
      return { output, visibleInputDigest: vid, actorOutputDigest: sha({ output }) };
    },
    /** The causality witness: visibleInputDigest → actorOutputDigest pairs. */
    digestLog: () => digestLog.slice(),
  };
}

// ---------------------------------------------------------------------------
// The counterfactual runner: proves the repair is CAUSED by the exact
// feedback, not by attempt counting or scenario knowledge.
// ---------------------------------------------------------------------------

export const FEEDBACK_VARIANTS = Object.freeze(['exact', 'absent', 'stale', 'corrupted']);

/**
 * Project feedback onto the visible surface under one variant.
 * - exact:      the true typed rejection (reason + path/evidence nonce);
 * - absent:     no feedback reaches the desk (typed silence);
 * - stale:      feedback from a PREVIOUS subject (wrong nonce);
 * - corrupted:  the same shape but a mangled nonce/reason payload.
 */
export function projectFeedbackVariant(exactFeedback, variant) {
  switch (variant) {
    case 'exact':
      return exactFeedback ? { ...exactFeedback } : null;
    case 'absent':
      return null;
    case 'stale':
      return exactFeedback
        ? { ...exactFeedback, subjectRef: `${exactFeedback.subjectRef ?? 'subject'}@revision-0` }
        : null;
    case 'corrupted':
      return exactFeedback
        ? { ...exactFeedback, reasonCode: '��corrupted��', evidence: null }
        : null;
    default:
      throw new Error(`UNKNOWN_FEEDEDBACK_VARIANT: ${variant}`);
  }
}

/**
 * Run one scenario family's counterfactual quartet.
 *
 * @param {object} opts
 * @param {object} opts.actor                    from createScriptedActor
 * @param {object} opts.baseVisible              the visible input sans feedback
 * @param {object} opts.exactFeedback            the true typed rejection
 * @param {(output: object) => boolean} opts.isRepair
 *        Classifies an actor output as THE repair action (e.g. 'resubmitted
 *        without the digest, bytes written'). Mechanical — no oracle magic.
 * @returns per-variant results + the causality verdict.
 */
export function runCounterfactualQuartet({ actor, baseVisible, exactFeedback, isRepair }) {
  if (typeof isRepair !== 'function') {
    throw new Error('REPAIR_CLASSIFIER_REQUIRED: the quartet needs a mechanical repair predicate');
  }
  const results = {};
  for (const variant of FEEDBACK_VARIANTS) {
    const visible = { ...baseVisible, recoveryFeedback: projectFeedbackVariant(exactFeedback, variant) };
    const reaction = actor.react(visible);
    results[variant] = {
      ...reaction,
      repaired: isRepair(reaction.output),
    };
  }
  const causal = results.exact.repaired
    && !results.absent.repaired
    && !results.stale.repaired
    && !results.corrupted.repaired;
  return {
    results,
    causal,
    verdict: causal
      ? 'repair is caused by the exact feedback (nonce-bound); counterfactual variants produce no magical repair'
      : 'CAUSALITY BROKEN: a counterfactual variant produced (or the exact variant failed to produce) the repair',
  };
}
