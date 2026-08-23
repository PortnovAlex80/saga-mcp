#!/usr/bin/env node
// tests/factory-proof/w1-1-fabricated-hash-drive.mjs
//
// W1-1 — the fabricated-derived-evidence causal proof drive. ONE isolated
// child process per variant. The run goes through the CANONICAL proof
// composition (W0-1) over the production fresh harness: real assignment,
// real MCP handlers, real gates, real SQLite — only inference is scripted.
//
// The acceptance-contract cell is driven by the W0-3 NON-OMNISCIENT actor:
// its first artifact_create carries a FABRICATED shape-valid 64-hex digest
// (or a malformed one, per variant) — the Factory must reject it typed with
// zero durable mutation, and only the EXACT visible feedback may cause the
// repair (write bytes, resubmit WITHOUT the digest).
//
// Variants (env W11_VARIANT):
//   positive        — the honest path: file bytes first, NO digest field;
//   negative-shape  — malformed digest (not 64-hex) → typed intake rejection;
//   negative-semantic — shape-valid fabricated digest, bytes unavailable →
//                     ARTIFACT_CONTENT_HASH_UNVERIFIABLE, then the actor
//                     gets the EXACT feedback and repairs in-session;
//   cf-absent / cf-stale / cf-corrupted — the same rejection, but the
//                     feedback reaching the actor is projected absent/stale/
//                     corrupted: the actor must NOT repair (honest no-op),
//                     the cell enters bounded typed recovery, never a
//                     magical repair and never an anonymous stall.
//
// Emits one JSON evidence line: durable-trace facts (via the W0-3 observer),
// the actor's visibleInputDigest→actorOutputDigest log, and the authority
// assertions' raw inputs (independently computed by this script, never by
// the factory).

import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const VARIANT = process.env.W11_VARIANT ?? 'positive';

const harness = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href);
const { bootstrapFreshHarness } = harness;
const { HARNESS_CONCURRENCY_CEILING } = await import(
  pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/run-manifest.js')).href
);
const { buildCanonicalProofComposition, driveCanonicalProof, createScriptedObserver }
  = await import('./canonical-proof-composition.mjs');
const { createScriptedActor, projectFeedbackVariant } = await import('./scripted-actor.mjs');
const { W9_HAPPY_HANDLERS, coveredConstraintIdsFromBriefDb } = await import('../factory-e2e/w9-happy-handlers.mjs');

const sha256 = t => createHash('sha256').update(t, 'utf8').digest('hex');
// Module-scope record of the fabricated first attempt: the in-process worker
// calls the artifact handler directly (same typed errors as the MCP boundary,
// but command_receipts are written by the MCP wrapper) — the record keeps the
// detector evidence honest without fabricating receipts.
let firstAttemptRecord = null;
const FRM = 'solution-formalization@1.0.0';
const AC_PATH = 'docs/formalization/AC-1.md';
const AC_TITLE = 'AC-1: Pipeline Completes';
// The exact defect class from the live incident: a shape-valid 64-hex digest
// the worker could not have computed (md5 of a known string, padded).
const FABRICATED = 'dcddb474aa26b7f8ff7a81f5324bbf4c1cb1f1e5b3b8f1f6d5f9d0c2b8a7e4f1';

// ---------------------------------------------------------------------------
// The non-omniscient actor: repairs ONLY on the exact visible nonce.
// ---------------------------------------------------------------------------
const exactRejection = {
  reasonCode: 'ARTIFACT_CONTENT_HASH_UNVERIFIABLE',
  subjectRef: AC_PATH,
  evidence: { expectedPath: AC_PATH, hint: 'write the bytes; omit the digest' },
};
const actor = createScriptedActor({
  rules: [
    {
      when: v => v.recoveryFeedback?.reasonCode === 'ARTIFACT_CONTENT_HASH_UNVERIFIABLE'
        && v.recoveryFeedback?.subjectRef === AC_PATH
        && v.recoveryFeedback?.evidence?.expectedPath === AC_PATH,
      act: () => ({ action: 'repair', writeBytes: AC_PATH, omitDigest: true }),
    },
    {
      when: v => v.recoveryFeedback?.reasonCode === 'ARTIFACT_CONTENT_HASH_INVALID',
      act: () => ({ action: 'repair', writeBytes: AC_PATH, omitDigest: true }),
    },
  ],
  fallback: () => ({ action: 'worker-done-noop' }),
});

// Feedback the actor is ALLOWED to see, per variant (W0-3 projection).
const FEEDBACK_MODE = {
  'negative-semantic': 'exact',
  'cf-absent': 'absent',
  'cf-stale': 'stale',
  'cf-corrupted': 'corrupted',
}[VARIANT] ?? null;

// ---------------------------------------------------------------------------
// The acceptance-contract cell handler: the W9 happy shape, but the AC step
// is variant-controlled and actor-driven on the tool-error boundary.
// ---------------------------------------------------------------------------
function acceptanceActorHandler({ handlers, assignment, context, db }) {
  const taskRow = db.prepare(
    'SELECT t.epic_id, e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?',
  ).get(Number(assignment.taskId));
  const projectId = taskRow?.project_id ?? 1;
  const epicId = taskRow?.epic_id ?? 1;
  const repoPath = context.workspaceRoot;

  const accepted = type => db.prepare(
    `SELECT id FROM artifacts WHERE epic_id=? AND type=? AND status='accepted' ORDER BY id`,
  ).all(epicId, type);
  const frs = accepted('FR');
  const nfrs = accepted('NFR');
  const ucs = accepted('UC');
  if (!frs.length) throw new Error('w1-1: no accepted FR for acceptance');
  const coveredIds = coveredConstraintIdsFromBriefDb(db, epicId);

  const writeDoc = (p, title) => {
    const full = path.join(repoPath, p);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, `## ${title}\n\nDeterministic AC artifact for the w1-1 causal proof.\n`, 'utf8');
  };
  const create = (code, title, p, withDigest) => {
    writeDoc(p, title);
    return handlers.artifact_create({
      project_id: projectId, epic_id: epicId, type: 'AC', code, title,
      path: p, status: 'accepted',
      ...(withDigest ? { content_hash: withDigest } : {}),
      // ELITE-7 run-scoped register repair: the acceptance coverage gate now
      // fires for every formalization node, so the corpus closes coverage
      // exactly like the migrated golden path (the relay read back from the
      // accepted brief's dispositions — every non-waived id).
      ...(coveredIds.length > 0 ? { metadata: { covered_constraint_ids: coveredIds } } : {}),
    });
  };
  const trace = (sid, tid, lt) => handlers.trace_add({
    source_id: sid, target_type: 'artifact', target_id: tid, link_type: lt,
  });

  let firstAttempt = { kind: 'none' };
  if (VARIANT === 'positive') {
    // Honest path: bytes first, NO digest field — the Factory derives it.
    const ac1 = create('AC-1', AC_TITLE, AC_PATH, null);
    trace(ac1.id, frs[0].id, 'derived_from');
    if (ucs.length) trace(ac1.id, ucs[0].id, 'derived_from');
    const ac2 = create('AC-2', 'AC-2: NFR Compliance', 'docs/formalization/AC-2.md', null);
    if (nfrs.length) trace(ac2.id, nfrs[0].id, 'derived_from');
    firstAttempt = { kind: 'accepted-no-digest' };
  } else {
    // Fabricated first attempt. shape-valid (semantic variants) or malformed.
    const digest = VARIANT === 'negative-shape' ? 'not-hex-at-all' : FABRICATED;
    // The file must NOT resolve for ANY fabricated variant: if bytes
    // resolved, the server-side disk hash would rightly WIN and there would
    // be no defect — the malformed shape is checked at intake, the fabricated
    // shape is UNVERIFIABLE over unobservable bytes.
    try {
      handlers.artifact_create({
        project_id: projectId, epic_id: epicId, type: 'AC', code: 'AC-1',
        title: AC_TITLE, path: AC_PATH, status: 'accepted', content_hash: digest,
      });
      firstAttempt = { kind: 'unexpectedly-accepted' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      firstAttempt = {
        kind: 'rejected',
        code: message.includes('ARTIFACT_CONTENT_HASH_INVALID') ? 'ARTIFACT_CONTENT_HASH_INVALID'
          : message.includes('ARTIFACT_CONTENT_HASH_UNVERIFIABLE') ? 'ARTIFACT_CONTENT_HASH_UNVERIFIABLE'
            : message.slice(0, 120),
      };
      // The real tool-error boundary: the actor reacts to VISIBLE feedback only.
      const projected = projectFeedbackVariant(exactRejection, FEEDBACK_MODE ?? 'exact');
      const reaction = actor.react({
        prompt: 'define acceptance contract',
        lastToolError: message,
        recoveryFeedback: projected,
      });
      if (reaction.output.action === 'repair') {
        const ac1 = create('AC-1', AC_TITLE, AC_PATH, null);
        trace(ac1.id, frs[0].id, 'derived_from');
        if (ucs.length) trace(ac1.id, ucs[0].id, 'derived_from');
        const ac2 = create('AC-2', 'AC-2: NFR Compliance', 'docs/formalization/AC-2.md', null);
        if (nfrs.length) trace(ac2.id, nfrs[0].id, 'derived_from');
        firstAttempt.repaired = true;
      } else {
        firstAttempt.repaired = false;
        firstAttempt.actorAction = reaction.output.action;
      }
    }
  }
  firstAttemptRecord = firstAttempt;
  handlers.worker_done({
    task_id: Number(assignment.taskId),
    worker_id: assignment.workerId,
    execution_id: assignment.workerExecutionId,
    result: `w1-1 ${VARIANT}: ${JSON.stringify(firstAttempt)}`,
  });
  return { kind: 'worker-done-accepted', w11: firstAttempt };
}

const handlers = {
  ...W9_HAPPY_HANDLERS,
  [`${FRM}/define-acceptance-contract/author/singleton`]: acceptanceActorHandler,
};

const bootstrap = await bootstrapFreshHarness({
  repoRoot: REPO_ROOT,
  concurrencyCap: HARNESS_CONCURRENCY_CEILING,
  idea: `W1-1 fabricated-derived-evidence causal proof (${VARIANT})`,
});

try {
  bootstrap.assertNoAuthorityWritesYet();
  const observer = createScriptedObserver();
  const composition = buildCanonicalProofComposition({
    observer,
    repoPath: bootstrap.repoPath,
    sagaRepoRoot: bootstrap.sagaRepoRoot,
    handlers,
  });

  // Counterfactual variants end in bounded typed recovery — cap the cycles
  // honestly and classify with the progress oracle instead of chasing a
  // terminal that must not come.
  const maxCycles = VARIANT.startsWith('cf-') ? 40 : 120;
  const { result } = await driveCanonicalProof({
    bootstrap,
    composition,
    scenarioConcurrencyCap: HARNESS_CONCURRENCY_CEILING,
    maxCycles,
    pollMs: 5,
    maxEmptyDispatchStreak: 10,
    scriptedObserver: observer,
  });

  // Independent facts + authority assertions (computed HERE, not by the factory).
  const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
  const db = getDb();
  const { readFileSync, existsSync } = await import('node:fs');
  // Counterfactual variants never repair — the AC file may not exist. The
  // independent hash is only meaningful where the presentation exists.
  const acPathAbs = path.join(bootstrap.repoPath, AC_PATH);
  const independentHash = existsSync(acPathAbs)
    ? sha256(readFileSync(acPathAbs, 'utf8'))
    : null;
  const ac1 = db.prepare(
    `SELECT id, content_hash, accepted_hash, status FROM artifacts WHERE code='AC-1' AND epic_id=? ORDER BY id`,
  ).all(bootstrap.epicId);
  const fabricatedInAuthority = db.prepare(
    `SELECT COUNT(*) AS n FROM artifacts WHERE content_hash=? OR accepted_hash=?`,
  ).get(FABRICATED, FABRICATED).n;
  const acceptanceGate = db.prepare(
    `SELECT gate_phase, verdict FROM factory_gate_decisions
      WHERE workplace_ref LIKE '%formalization-acceptance-contract%' ORDER BY decided_at`,
  ).all();
  const capsule = db.prepare(
    `SELECT payload FROM factory_formalization_acceptance_baselines ORDER BY id DESC LIMIT 1`,
  ).get();
  const stageRun = db.prepare(
    `SELECT local_outcome FROM factory_stage_runs WHERE stage_id='solution-formalization' ORDER BY id DESC LIMIT 1`,
  ).get();

  process.stdout.write(JSON.stringify({
    variant: VARIANT,
    drive: {
      cycles: result.cycles,
      terminalReason: result.terminalReason,
      stranded: result.strandedActiveExecutions,
      invocations: result.scriptedInvocationCount,
    },
    firstAttempt: firstAttemptRecord,
    intake: {
      // The durable rejection receipts where the MCP wrapper wrote them
      // (spawn-path workers); the in-process record above is the same typed
      // evidence for the in-process drive.
      rejections: db.prepare(
        `SELECT command_kind, accepted, rejection_code FROM command_receipts
          WHERE command_kind IN ('artifact_create','artifact_update') AND accepted=0
          ORDER BY accepted_at`,
      ).all(),
    },
    authority: {
      ac1Rows: ac1,
      fabricatedInAuthority,
      independentHash,
      acceptanceGate,
      stageOutcome: stageRun?.local_outcome ?? null,
      capsuleCardinality: capsule
        ? JSON.parse(capsule.payload).acceptanceCriteria?.length ?? null
        : null,
      capsuleHashes: capsule
        ? (JSON.parse(capsule.payload).acceptanceCriteria ?? [])
          .map(c => ({ accepted: c.acceptedHash?.slice(0, 12), criterion: c.criterionHash?.slice(0, 12) }))
        : null,
      capsuleMembersRaw: capsule
        ? (JSON.parse(capsule.payload).acceptanceCriteria ?? []).map(c =>
          Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 16) : v])))
        : null,
    },
    actorDigestLog: actor.digestLog(),
  }) + '\n');
} finally {
  bootstrap.cleanup();
}
