// tests/factory-proof/development-resilience-pack.mjs
//
// Development closure extension (W2, ADR-096 gate item 1): the D2–D10
// resilience + restart + feedback + production-sized satisfiability corpus.
// Mirrors the Formalization resilience pack's discipline: the pack owns only
// deterministic cognition stimuli (scripted actor programs that branch on
// VISIBLE production feedback only), independent oracles over the read-only
// durable trace, and coverage declarations. Every gate/effect/kernel/
// settlement/recovery authority stays in the production Factory.
//
// Honest-outcome rule: a scenario proving a typed wait, typed park, typed
// terminal failure or a typed pre-worker refusal is VALID evidence for its
// obligation — nothing here fakes a success.
//
// Coverage map (pending tokens landed by this file):
//   D2:sibling-isolation / D4:review:changes-returns...  review-repair scenario
//   D4:git-effect:*                                     effect-binding scenario
//   D3:claim-monotonicity                               narrowing scenario
//   D6:readiness:declared-source-mismatch               mismatch park scenario
//   D8:verification:evidence-pins-exact-candidate-hash  tampered-evidence scenario
//   D8:verification:upstream-defect + D9:blocked        local-readiness-failed scenario
//   D9:failed + D1 unsat variant                         frozen-SRS unsat scenario
//   feedback:development:exact-repairs-and-absent        feedback pair
//   D1 production-scale satisfiability (SAT + UNSAT)     task-graph scale scenarios
//   restart:* + D5:freeze immutability                   development-restart-proof.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { W9_HAPPY_HANDLERS } from '../factory-e2e/w9-happy-handlers.mjs';

const DEVELOPMENT_STAGE = 'solution-development';
const FRM = 'solution-formalization@1.0.0';
const REVIEW_REPAIR_MARKER = 'impl-review-repair-marker';

// ---------------------------------------------------------------------------
// Shared oracle helpers (pack-local; the spine pack keeps its own).
// ---------------------------------------------------------------------------

function stageOutcomeOracle(expectedOutcome, stageId = DEVELOPMENT_STAGE) {
  return {
    id: `development.stage-outcome.${expectedOutcome}`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.stageRuns ?? [])
        .filter(row => row.stage_id === stageId && row.local_outcome === expectedOutcome);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => `stage-run:${row.id}`),
        details: { stageId, expectedOutcome, count: rows.length },
      };
    },
  };
}

function lifecycleTerminalOracle(expected) {
  return {
    id: `development.lifecycle-terminal.${expected}`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.lifecycleRuns ?? [])
        .filter(row => String(row.terminal_status ?? '') === expected);
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(row => `lifecycle-run:${row.id}`),
        details: {
          expected,
          statuses: (durableTrace.lifecycleRuns ?? []).map(r => r.terminal_status),
        },
      };
    },
  };
}

function noStrandedExecutionOracle() {
  return {
    id: 'factory.no-stranded-worker-executions',
    evaluate({ result }) {
      return {
        passed: result.strandedActiveExecutions === 0,
        details: { strandedActiveExecutions: result.strandedActiveExecutions },
      };
    },
  };
}

/**
 * REG-28 kanban-drain-at-terminal (scenario level): at the lifecycle terminal
 * boundary the board may hold NO anonymous todo/queued card. Typed parks
 * (paused human-required, repair_wait, verifying, effect_pending) are lawful
 * §23 waits and are explicitly listed, never counted as violations.
 */
function kanbanDrainAtTerminalOracle() {
  return {
    id: 'development.reg28.kanban-drain-at-terminal',
    evaluate({ durableTrace }) {
      const terminalLifecycles = (durableTrace.lifecycleRuns ?? [])
        .filter(row => row.terminal_status !== null && row.terminal_status !== undefined);
      if (terminalLifecycles.length === 0) {
        return { passed: false, details: { reason: 'no terminal lifecycle boundary reached' } };
      }
      const rows = durableTrace.workplaces ?? [];
      const anonymous = rows.filter(w =>
        (w.kanban_phase === 'todo' || w.kanban_phase === 'in_progress')
        && (w.loop_state === 'idle' || w.loop_state === 'queued'));
      const typedParks = rows.filter(w =>
        ['paused', 'repair_wait', 'verifying', 'effect_pending'].includes(w.loop_state));
      return {
        passed: anonymous.length === 0,
        evidenceRefs: terminalLifecycles.map(row => `lifecycle-run:${row.id}`),
        details: {
          terminalStatuses: terminalLifecycles.map(row => row.terminal_status),
          anonymousTodoQueued: anonymous.map(w => w.workplace_ref),
          typedParks: typedParks.map(w => ({ ref: w.workplace_ref, loop: w.loop_state })),
        },
      };
    },
  };
}

function implWorkplacesOf(durableTrace) {
  return (durableTrace.workplaces ?? [])
    .filter(w => String(w.workplace_ref).includes('development-implementation'));
}

/** Implementation workplaces keyed by their work-item key (task metadata). */
function implWorkplacesByKey(durableTrace) {
  const byWorkplace = new Map((durableTrace.workIntents ?? [])
    .filter(t => t.item_key && t.workplace_ref)
    .map(t => [t.workplace_ref, t.item_key]));
  const map = new Map();
  for (const w of implWorkplacesOf(durableTrace)) {
    const key = byWorkplace.get(w.workplace_ref);
    if (key) map.set(key, w);
  }
  return map;
}

function failedReceiptOracle(providerPattern, subjectFragment) {
  return {
    id: `development.fence.${subjectFragment}.typed-receipt`,
    evaluate({ durableTrace }) {
      const rows = (durableTrace.checkReceipts ?? []).filter(r =>
        r.outcome !== 'passed'
        && new RegExp(providerPattern).test(String(r.provider_id))
        && String(r.subject_candidate_set_ref).includes(subjectFragment));
      return {
        passed: rows.length > 0,
        evidenceRefs: rows.map(r => `check:${r.check_receipt_ref}`),
        details: { count: rows.length, providers: [...new Set(rows.map(r => r.provider_id))] },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared actor helpers.
// ---------------------------------------------------------------------------

function workItemKeyOf(meta) {
  const item = meta?.cell_input_item
    ?? (Array.isArray(meta?.process_node_input)
      ? meta.process_node_input.find(x => x?.kind === 'implementation')
      : undefined);
  return String(item?.key ?? '');
}

function repoBindingOf(ctx) {
  const binding = ctx.db
    ? ctx.db.prepare(
      `SELECT pr.local_path, pr.integration_branch
         FROM tasks t
         JOIN project_repositories pr ON pr.id = t.project_repository_id
        WHERE t.id = ?`,
    ).get(Number(ctx.assignment.taskId))
    : null;
  return {
    repoPath: binding?.local_path ?? ctx.context.workspaceRoot,
    integrationBranch: binding?.integration_branch || 'dev',
  };
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  }).trim();
}

function writeRepoFile(repoPath, filePath, content) {
  const fullPath = path.join(repoPath, filePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

function productionRecoveryFeedback(meta) {
  const raw = meta?.recovery_feedback
    ?? meta?.process_node_input?.bindings?.recoveryFeedback
    ?? null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return { evidenceText: JSON.stringify(raw) };
}

/** The deterministic author-side implementation commit used by fault actors. */
function commitImplementation(ctx, workItemKey, files, extra) {
  const safe = workItemKey.replace(/[^a-zA-Z0-9._-]/g, '-');
  const { repoPath, integrationBranch } = repoBindingOf(ctx);
  const branch = `task/${safe}-${ctx.assignment.taskId}`;
  git(repoPath, 'checkout', '-B', branch, integrationBranch);
  for (const [filePath, content] of files) {
    writeRepoFile(repoPath, filePath, content);
  }
  git(repoPath, 'add', ...files.map(([filePath]) => filePath));
  try {
    git(repoPath, 'commit', '-m', `w9: implement ${workItemKey}`);
  } catch (error) {
    if (git(repoPath, 'status', '--porcelain', '-uno').trim() !== '') throw error;
  }
  const commitSha = git(repoPath, 'rev-parse', 'HEAD');
  const treeSha = git(repoPath, 'rev-parse', `${commitSha}^{tree}`);
  const baseCommit = git(repoPath, 'merge-base', integrationBranch, branch)
    || git(repoPath, 'rev-parse', integrationBranch);
  git(repoPath, 'checkout', integrationBranch);
  const filePaths = files.map(([filePath]) => filePath);
  const item = ctx.meta?.cell_input_item
    ?? (Array.isArray(ctx.meta.process_node_input)
      ? ctx.meta.process_node_input.find(x => x?.kind === 'implementation')
      : undefined);
  ctx.handlers.product_submit({
    schema: 'factory.development-implementation-result.v1',
    content: {
      workItemKey,
      terminalStatus: 'complete',
      source: { branch, commitSha, workItemKey },
      snapshot: {
        commitSha, treeSha, files: filePaths, changedFiles: filePaths,
        ...(extra?.droppedFiles ? { droppedFiles: extra.droppedFiles } : {}),
      },
      repository: {
        projectRepositoryId: Number(item?.projectRepositoryId ?? 1),
        integrationBranch,
        baseCommit,
        name: 'fresh-harness-repo',
      },
      buildProducts: [],
      reasonCodes: [],
      readiness: extra?.readiness ?? {
        kind: 'static',
        commands: { installCommand: null, testCommand: 'node test.js' },
      },
    },
  });
  ctx.handlers.worker_done({
    task_id: Number(ctx.assignment.taskId),
    worker_id: ctx.assignment.workerId,
    execution_id: ctx.assignment.workerExecutionId,
    result: extra?.result ?? `implemented ${workItemKey}`,
  });
  return { kind: 'worker-done-accepted' };
}

const implFileFor = workItemKey =>
  [`src/w9/${workItemKey.replace(/[^a-zA-Z0-9._-]/g, '-')}.ts`,
    `// deterministic implementation for ${workItemKey}\nexport const k = true;\n`];

// ---------------------------------------------------------------------------
// Feedback pair actors (exact / absent) — also carry the same-workplace and
// sibling-isolation oracles in the exact configuration.
// ---------------------------------------------------------------------------

function buildFeedbackPairHandlers({ variant, repairItemKey }) {
  const handlers = { ...W9_HAPPY_HANDLERS };
  const authorKey = `${DEV}/implement-work-items/author/*`;
  const reviewerKey = `${DEV}/implement-work-items/reviewer/*`;
  const baseAuthor = handlers[authorKey];
  const baseReviewer = handlers[reviewerKey];
  const journal = [];
  let authorRound = 0;
  let repairedMaterialSeen = false;

  handlers[authorKey] = ctx => {
    const workItemKey = workItemKeyOf(ctx.meta);
    if (workItemKey !== repairItemKey) return baseAuthor(ctx);
    authorRound += 1;
    const feedback = variant === 'absent' ? null : productionRecoveryFeedback(ctx.meta);
    const exactVisible = feedback !== null
      && feedback.evidenceText.includes(REVIEW_REPAIR_MARKER);
    journal.push({
      kind: 'author-invocation', variant, round: authorRound,
      feedbackPresent: feedback !== null, exactVisible,
    });
    if (authorRound === 1) return baseAuthor(ctx);
    if (exactVisible) {
      const safe = workItemKey.replace(/[^a-zA-Z0-9._-]/g, '-');
      const { repoPath, integrationBranch } = repoBindingOf(ctx);
      const branch = `task/${safe}-${ctx.assignment.taskId}`;
      git(repoPath, 'checkout', '-B', branch, integrationBranch);
      const filePath = `src/w9/${safe}.ts`;
      writeRepoFile(repoPath, filePath,
        `// deterministic implementation for ${workItemKey}\n`
        + `export const k = true;\n// ${REVIEW_REPAIR_MARKER}\n`);
      git(repoPath, 'add', filePath);
      git(repoPath, 'commit', '-m', `w9: review repair ${workItemKey}`);
      const commitSha = git(repoPath, 'rev-parse', 'HEAD');
      const treeSha = git(repoPath, 'rev-parse', `${commitSha}^{tree}`);
      const baseCommit = git(repoPath, 'merge-base', integrationBranch, branch)
        || git(repoPath, 'rev-parse', integrationBranch);
      git(repoPath, 'checkout', integrationBranch);
      const item = ctx.meta?.cell_input_item;
      journal.push({ kind: 'author-repaired', round: authorRound, commitSha });
      ctx.handlers.product_submit({
        schema: 'factory.development-implementation-result.v1',
        content: {
          workItemKey,
          terminalStatus: 'complete',
          source: { branch, commitSha, workItemKey },
          snapshot: { commitSha, treeSha, files: [filePath], changedFiles: [filePath] },
          repository: {
            projectRepositoryId: Number(item?.projectRepositoryId ?? 1),
            integrationBranch,
            baseCommit,
            name: 'fresh-harness-repo',
          },
          buildProducts: [],
          reasonCodes: [],
          readiness: {
            kind: 'static',
            commands: { installCommand: null, testCommand: 'node test.js' },
          },
        },
      });
      ctx.handlers.worker_done({
        task_id: Number(ctx.assignment.taskId),
        worker_id: ctx.assignment.workerId,
        execution_id: ctx.assignment.workerExecutionId,
        result: 'repaired the visible review finding',
      });
      return { kind: 'worker-done-accepted' };
    }
    journal.push({ kind: 'author-repeated', round: authorRound });
    return baseAuthor(ctx);
  };

  handlers[reviewerKey] = ctx => {
    const workplaceRef = ctx.meta.workplace_ref ?? ctx.meta.workplaceRef;
    const cand = ctx.handlers.candidate_read({ workplace_ref: workplaceRef, role: 'author' });
    const implRef = (cand.product_refs || []).find(
      p => p.schemaId === 'factory.development-implementation-result.v1',
    );
    const read = ctx.handlers.product_read({
      schema_id: implRef.schemaId, ref: implRef.ref, digest: implRef.digest,
    });
    const impl = read.content || read;
    // The reviewer's own meta carries no cell_input_item — the reviewed
    // candidate's workItemKey IS the item identity for the review seat.
    const workItemKey = String(impl.workItemKey ?? '');
    if (workItemKey !== repairItemKey) return baseReviewer(ctx);
    // The reviewer approves only repaired material, verified against the
    // committed bytes (not the claim): the marker must exist in the blob.
    const safe = workItemKey.replace(/[^a-zA-Z0-9._-]/g, '-');
    let repaired = false;
    try {
      const repoRow = ctx.db.prepare(
        'SELECT local_path FROM project_repositories WHERE id=?',
      ).get(Number(impl.repository?.projectRepositoryId ?? 1));
      const blob = git(repoRow.local_path, 'show',
        `${impl.source.commitSha}:src/w9/${safe}.ts`);
      repaired = blob.includes(REVIEW_REPAIR_MARKER);
    } catch { repaired = false; }
    if (repaired && !repairedMaterialSeen) {
      repairedMaterialSeen = true;
      journal.push({ kind: 'review-verdict', verdict: 'approved', repaired: true });
      return baseReviewer(ctx);
    }
    journal.push({ kind: 'review-verdict', verdict: 'changes_requested', repaired });
    ctx.handlers.product_submit({
      schema: 'factory.development-review-verdict.v1',
      content: {
        subject_candidate_set_ref: cand.candidate_set_ref,
        verdict: 'changes_requested',
        findings: [`implementation must add ${REVIEW_REPAIR_MARKER} to its committed material`],
        workItemKey: impl.workItemKey,
        reviewedCandidate: {
          sourceCommit: impl.source?.commitSha,
          sourceTree: impl.snapshot?.treeSha,
        },
      },
    });
    ctx.handlers.worker_done({
      task_id: Number(ctx.assignment.taskId),
      worker_id: ctx.assignment.workerId,
      execution_id: ctx.assignment.workerExecutionId,
      result: 'review requested the visible marker repair',
    });
    return { kind: 'worker-done-accepted' };
  };

  return { handlers: Object.freeze(handlers), journal };
}

const DEV = 'solution-development@1.4.4';

// ---------------------------------------------------------------------------
// Claim monotonicity: attempt 1 wide claim, attempt 2 silent narrowing,
// attempt 3+ wide claim restored.
// ---------------------------------------------------------------------------

function buildClaimNarrowingHandlers() {
  const handlers = { ...W9_HAPPY_HANDLERS };
  const authorKey = `${DEV}/implement-work-items/author/*`;
  const base = handlers[authorKey];
  const journal = [];
  let invocation = 0;
  handlers[authorKey] = ctx => {
    const workItemKey = workItemKeyOf(ctx.meta);
    // Only the FIRST chain item carries the fault; every other item uses the
    // normal path (its own attempts are counted separately below).
    const faultItem = journal.length === 0 || journal[0].workItemKey === workItemKey;
    if (!faultItem) return base(ctx);
    invocation += 1;
    const safe = workItemKey.replace(/[^a-zA-Z0-9._-]/g, '-');
    const rogueFile = `rogue/${safe}-outside.ts`;
    // The monotonicity defect sequence (STAGE-18 R2 shape):
    //   attempt 1 — wide claim including an OUT-OF-SCOPE file (the scope
    //               fence rejects the rogue path);
    //   attempt 2 — SILENT NARROWING: claims only the in-scope file, with
    //               NO droppedFiles disposition (the prior claim's rogue
    //               path is dropped silently — the exact defect);
    //   attempt 3 — the LAWFUL exit: the narrowed claim plus an explicit
    //               droppedFiles disposition for the rogue path.
    let files;
    let extra = null;
    if (invocation === 1) {
      files = [
        [...implFileFor(workItemKey)],
        [rogueFile, `// rogue out-of-scope claim for ${workItemKey}\n`],
      ];
    } else if (invocation === 2) {
      files = [[...implFileFor(workItemKey)]];
    } else {
      files = [[...implFileFor(workItemKey)]];
      extra = {
        droppedFiles: [{
          path: rogueFile,
          reason: 'claim-monotonicity scenario: the rogue attempt was '
            + 'rejected by the scope fence; the drop is disposed explicitly',
        }],
      };
    }
    journal.push({
      kind: 'claim-attempt', workItemKey, invocation,
      narrowed: invocation === 2, files: files.map(([p]) => p),
    });
    return commitImplementation(ctx, workItemKey, files, extra);
  };
  return { handlers: Object.freeze(handlers), journal };
}

// ---------------------------------------------------------------------------
// Readiness / verification submission faults (wrap one product_submit).
// ---------------------------------------------------------------------------

function withProductSubmitFault(schema, tamperOnce, build = handlers => handlers) {
  const handlers = { ...build({ ...W9_HAPPY_HANDLERS }) };
  for (const key of Object.keys(handlers)) {
    if (!key.includes('/author/')) continue;
    if (!key.includes(schema.nodeFragment)) continue;
    const base = handlers[key];
    let fired = false;
    handlers[key] = ctx => {
      const submit = ctx.handlers.product_submit;
      const hs = { ...ctx.handlers, product_submit(input) {
        if (input?.schema === schema.id && tamperOnce && !fired) {
          fired = true;
          tamperOnce(input);
        }
        return submit(input);
      } };
      return base({ ...ctx, handlers: hs });
    };
  }
  return Object.freeze(handlers);
}

// ---------------------------------------------------------------------------
// Product-defect author (deterministic failing test inside frozen scope).
// ---------------------------------------------------------------------------

function buildProductDefectHandlers() {
  const handlers = { ...W9_HAPPY_HANDLERS };
  // The RUN CONTRACT is the readiness manifest's declaration (the certifier
  // owns it): the manifest executes the whole tests/ surface, so the
  // deterministic failing test inside the frozen tree is what readiness
  // observes.
  const certKey = Object.keys(handlers)
    .find(k => k.includes('certify-product-readiness/author'));
  const baseCert = handlers[certKey];
  handlers[certKey] = ctx => {
    const submit = ctx.handlers.product_submit;
    const hs = { ...ctx.handlers, product_submit(input) {
      if (input?.schema === 'factory.development-readiness-manifest.v1') {
        input.content.targets = (input.content.targets ?? []).map(target => ({
          ...target,
          readiness: {
            kind: 'static',
            commands: { installCommand: null, testCommand: 'node --test tests/' },
          },
        }));
      }
      return submit(input);
    } };
    return baseCert({ ...ctx, handlers: hs });
  };
  const authorKey = `${DEV}/implement-work-items/author/*`;
  const base = handlers[authorKey];
  let handled = false;
  handlers[authorKey] = ctx => {
    const workItemKey = workItemKeyOf(ctx.meta);
    if (handled) {
      // Every implementation item declares the failing-readiness profile:
      // the freeze propagates ONE declaration onto the frozen candidate and
      // the defect must hold regardless of which one it is.
      const submit = ctx.handlers.product_submit;
      const hs = { ...ctx.handlers, product_submit(input) {
        if (input?.schema === 'factory.development-implementation-result.v1') {
          input.content.readiness = {
            kind: 'static',
            commands: { installCommand: null, testCommand: 'node --test tests/' },
          };
        }
        return submit(input);
      } };
      return base({ ...ctx, handlers: hs });
    }
    if (!/AC-1/.test(workItemKey)) return base(ctx);
    handled = true;
    return commitImplementation(ctx, workItemKey, [
      implFileFor(workItemKey),
      ['tests/product-defect.test.js',
        '// DETERMINISTIC product defect: this test FAILS by construction.\n'
        + "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
        + "test('product-defect: fails', () => { assert.equal(1, 2); });\n"],
    ], {
      readiness: {
        kind: 'static',
        commands: { installCommand: null, testCommand: 'node --test tests/' },
      },
      result: 'implemented with a deterministic failing product test',
    });
  };
  return Object.freeze(handlers);
}

// ---------------------------------------------------------------------------
// Production-scale handlers: 16 atomic ACs upstream, 59-card graph at the
// planner (mirrors the Elite-9 board scale), optional first-proposal cycle.
// ---------------------------------------------------------------------------

function buildProductionScaleHandlers({ injectCycle }) {
  const handlers = { ...W9_HAPPY_HANDLERS };

  // 1. Scale acceptance: 16 atomic criteria.
  const acceptanceKey = `${FRM}/define-acceptance-contract/author/singleton`;
  handlers[acceptanceKey] = function scaleAcceptance({ handlers: hs, assignment, context, db }) {
    const row = db.prepare(
      'SELECT t.epic_id, e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?',
    ).get(Number(assignment.taskId));
    const projectId = row?.project_id ?? 1;
    const epicId = row?.epic_id ?? 1;
    const repoPath = context.workspaceRoot;
    const coveredIds = [];
    try {
      const brief = db.prepare(
        `SELECT metadata FROM artifacts
          WHERE epic_id=? AND type='brief' AND status='accepted'
          ORDER BY id DESC LIMIT 1`,
      ).get(epicId);
      const parsed = brief?.metadata ? JSON.parse(brief.metadata) : null;
      for (const [id, value] of Object.entries(parsed?.constraint_dispositions ?? {})) {
        if (value && value.disposition !== 'waived') coveredIds.push(id);
      }
    } catch { /* registerless */ }
    const ucs = db.prepare(
      `SELECT id FROM artifacts WHERE epic_id=? AND type='UC' AND status='accepted' ORDER BY id`,
    ).all(epicId);
    const frs = db.prepare(
      `SELECT id FROM artifacts WHERE epic_id=? AND type='FR' AND status='accepted' ORDER BY id`,
    ).all(epicId);
    for (let i = 1; i <= 16; i += 1) {
      const code = `AC-${i}`;
      const artifactPath = `docs/formalization/${code}.md`;
      writeRepoFile(repoPath, artifactPath,
        `## ${code}: Scale criterion ${i}\n\nDeterministic scale AC artifact for ${code}.\n`);
      const artifact = hs.artifact_create({
        project_id: projectId, epic_id: epicId, type: 'AC', code,
        title: `${code}: Scale criterion`, path: artifactPath, status: 'accepted',
        ...(i === 1 && coveredIds.length > 0
          ? { metadata: { covered_constraint_ids: coveredIds } }
          : {}),
      });
      // Every criterion derives from the (single) accepted FR + UC of the
      // W9 corpus — the acceptance gate requires at least one derived_from
      // FR/NFR per AC; several ACs may share one upstream requirement.
      if (frs[0]) hs.trace_add({
        source_id: artifact.id, target_type: 'artifact',
        target_id: frs[0].id, link_type: 'derived_from',
      });
      if (ucs[0]) hs.trace_add({
        source_id: artifact.id, target_type: 'artifact',
        target_id: ucs[0].id, link_type: 'derived_from',
      });
    }
    hs.worker_done({
      task_id: Number(assignment.taskId),
      worker_id: assignment.workerId,
      execution_id: assignment.workerExecutionId,
      result: 'formalization acceptance: 16 atomic scale criteria',
    });
    return { kind: 'worker-done-accepted' };
  };

  // 2. Scale SRS: a §D2 stanza + disjoint file surface for every criterion.
  const architectureKey = `${FRM}/define-architecture-contract/author/singleton`;
  const baseArchitecture = handlers[architectureKey];
  handlers[architectureKey] = ctx => {
    const artifactCreate = ctx.handlers.artifact_create;
    // The register relay: the §D2 stanza carrying AC-1 lists every non-waived
    // constraint id (read back from the accepted brief — the same source the
    // W9 base uses).
    let coveredIds = [];
    try {
      const taskRow = ctx.db.prepare(
        'SELECT t.epic_id FROM tasks t WHERE t.id=?',
      ).get(Number(ctx.assignment.taskId));
      const brief = ctx.db.prepare(
        `SELECT metadata FROM artifacts
          WHERE epic_id=? AND type='brief' AND status='accepted'
          ORDER BY id DESC LIMIT 1`,
      ).get(taskRow?.epic_id ?? 1);
      const parsed = brief?.metadata ? JSON.parse(brief.metadata) : null;
      for (const [cid, value] of Object.entries(parsed?.constraint_dispositions ?? {})) {
        if (value && value.disposition !== 'waived') coveredIds.push(cid);
      }
      coveredIds.sort();
    } catch { /* registerless */ }
    const coveredField = coveredIds.length > 0
      ? `\n  covered_constraint_ids: ${coveredIds.join(', ')}`
      : '';
    const hs = { ...ctx.handlers, artifact_create(input) {
      if (input?.type !== 'SRS') return artifactCreate(input);
      const stanza = i => [
        `- ac: AC-${i}`,
        `  title: Scale criterion ${i}`,
        '  module: src/factory-e2e',
        `  files: ["src/w9/impl-AC-${i}.ts"]`,
        `  invariants: ['Scale invariant ${i}']`,
        "  test_layers: ['e2e']",
        '  pattern: A',
        '  depends_on: []',
        '  ac_kind: implementation',
        `  criticality: blocker${i === 1 ? coveredField : ''}`,
      ].join('\n');
      const srs = [
        '# SRS',
        '',
        '## §D2 Acceptance Criteria Decomposition',
        '',
        '```yaml',
        ...Array.from({ length: 16 }, (_, i) => stanza(i + 1)),
        '```',
        '',
        '### 2.2 Module Manifest',
        '',
        '| Module | Files |',
        '|---|---|',
        '| w9-harness | `package.json` |',
        '',
        '## §12 Decision Log',
        '',
        '| # | Decision | Source/profile | Alternatives considered | Rationale | Date |',
        '|---|----------|---------------|------------------------|-----------|------|',
        '| 1 | Scale corpus | CONVEYOR §16 | Small graph | Mirror Elite-9 scale | 2026-08-25 |',
        '',
      ].join('\n');
      writeRepoFile(ctx.context.workspaceRoot, String(input.path).split('#')[0], srs);
      return artifactCreate(input);
    } };
    return baseArchitecture({ ...ctx, handlers: hs });
  };

  // 3. Scale planner: reshape the W9 proposal into the 59-card tiered DAG
  //    (first proposal optionally carries a dependency cycle for the UNSAT
  //    variant; the repair round proposes the clean acyclic graph).
  const planKey = Object.keys(handlers).find(key => key.includes('plan-task-graph/author'));
  const basePlan = handlers[planKey];
  let proposalRound = 0;
  handlers[planKey] = ctx => {
    proposalRound += 1;
    const inject = injectCycle && proposalRound === 1;
    const submit = ctx.handlers.product_submit;
    const hs = { ...ctx.handlers, product_submit(input) {
      if (input?.schema === 'factory.development-task-graph-proposal.v1') {
        reshapeProductionScale(input.content);
        if (inject) {
          const byKey = new Map(input.content.implementationItems
            .map(item => [item.key, item]));
          const a = byKey.get('impl-AC-1');
          const b1 = byKey.get('impl-burst-1');
          const b2 = byKey.get('impl-burst-2');
          if (a && b1 && b2) {
            a.dependsOnKeys = ['impl-burst-2'];
            b1.dependsOnKeys = ['impl-AC-1'];
            b2.dependsOnKeys = ['impl-burst-1'];
          }
        }
      }
      return submit(input);
    } };
    return basePlan({ ...ctx, handlers: hs });
  };
  return Object.freeze(handlers);
}

/**
 * Reshape the W9 proposal into the production-scale graph: the FIRST real
 * implementation item keeps the mandated shared scopes (package.json,
 * tests/); every other real item owns one disjoint single file; 27
 * infrastructure burst siblings depend on the first item only. 16 real + 27
 * burst implementation cards + 16 verification cards = 59 development
 * work-item card classes — the Elite-9 board scale.
 */
function reshapeProductionScale(content) {
  const real = (content.implementationItems ?? []).filter(item => /^impl-AC-/.test(item.key));
  const first = real[0];
  if (!first) return;
  const items = [first];
  for (let index = 1; index < real.length; index += 1) {
    items.push({
      ...real[index],
      changeScopes: [`src/w9/${real[index].key}.ts`],
      // Desk-base discipline: a card WITH dependencies bases its work on
      // the observed integration head at desk freeze (same synchronous
      // start), while a dep-less card bases on the lineage anchor — so
      // every post-root card declares the root as its dependency exactly
      // like the burst tier.
      dependsOnKeys: [first.key],
    });
  }
  for (let i = 1; i <= 27; i += 1) {
    items.push({
      key: `impl-burst-${i}`,
      kind: 'implementation',
      taskKind: 'development.code',
      executionSkill: 'saga-worker',
      executionMode: 'git_change',
      projectRepositoryId: first.projectRepositoryId,
      acceptanceCriterionKeys: [],
      dependsOnKeys: [first.key],
      changeScopes: [`src/w9/impl-burst-${i}.ts`],
      required: true,
      criticality: 'blocker',
    });
  }
  content.implementationItems = items;
  content.integrationTargets = (content.integrationTargets ?? []).map(target => ({
    ...target,
    sourceWorkItemKeys: items.map(item => item.key),
  }));
}

// ---------------------------------------------------------------------------
// Scenario declarations.
// ---------------------------------------------------------------------------

export const DEVELOPMENT_RESILIENCE_SCENARIOS = Object.freeze([
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/impl-review-changes-same-workplace',
    kind: 'causal-fault',
    faultClass: 'review-repair',
    proves: ['dev.impl-scope'],
    coverageItems: [
      'D4:review:changes-returns-to-same-workplace-author',
      'D2:sibling-isolation:accepted-sibling-conserved-during-repair',
    ],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/git-integration-after-final-acceptance-only',
    kind: 'positive',
    proves: ['dev.impl-scope'],
    coverageItems: [
      'D4:git-effect:integration-only-after-final-acceptance',
      'D4:git-effect:redrive-idempotent',
    ],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/claim-monotonicity-narrowing-rejected',
    kind: 'causal-fault',
    faultClass: 'authored-semantic',
    proves: ['dev.impl-scope'],
    coverageItems: ['D3:claim-monotonicity:silent-narrowing-rejected'],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/readiness-source-mismatch-rejected',
    kind: 'causal-fault',
    faultClass: 'authored-semantic',
    proves: ['dev.readiness-monotonicity'],
    coverageItems: ['D6:readiness:declared-source-mismatch-rejected'],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/verification-evidence-pins-exact-candidate-hash',
    kind: 'causal-fault',
    faultClass: 'authored-semantic',
    proves: ['dev.verification-lineage'],
    coverageItems: ['D8:verification:evidence-pins-exact-candidate-hash'],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/local-readiness-failed-upstream-blocked',
    kind: 'causal-fault',
    faultClass: 'product-defect-upstream',
    proves: ['factory.local-runnability'],
    coverageItems: [
      'D8:verification:upstream-defect-routes-to-settlement',
      'D9:settlement:blocked-and-failed-outcomes',
    ],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/planner-frozen-srs-unsat-failed',
    kind: 'causal-fault',
    faultClass: 'upstream-frozen-material',
    proves: ['dev.task-graph'],
    coverageItems: [
      'D9:settlement:blocked-and-failed-outcomes',
      'D1:task-graph:srs-file-identity-unsat-failed-terminal',
    ],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/impl-feedback-exact',
    kind: 'recovery',
    faultClass: 'feedback-fault',
    proves: ['factory.review-verdict'],
    coverageItems: ['feedback:development:exact-repairs-and-absent-does-not'],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/impl-feedback-absent',
    kind: 'causal-fault',
    faultClass: 'feedback-fault',
    proves: ['factory.review-verdict'],
    coverageItems: ['feedback:development:exact-repairs-and-absent-does-not'],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/task-graph-production-scale-satisfiable',
    kind: 'positive',
    proves: ['dev.task-graph'],
    coverageItems: ['D1:task-graph:production-scale-satisfiability-decided'],
  }),
  Object.freeze({
    schemaVersion: 'factory.proof.kernel-scenario.v1',
    id: 'development/task-graph-production-scale-cycle-unsat',
    kind: 'causal-fault',
    faultClass: 'authored-semantic',
    proves: ['dev.task-graph'],
    coverageItems: ['D1:task-graph:production-scale-cycle-unsat-typed-witness'],
  }),
]);

const resilienceById = new Map(DEVELOPMENT_RESILIENCE_SCENARIOS.map(s => [s.id, s]));

function scenario(id, extra) {
  const found = resilienceById.get(id);
  if (!found) throw new Error(`DEVELOPMENT_RESILIENCE_SCENARIO_UNKNOWN: ${id}`);
  return { scenario: found, ...extra };
}

const DRIVE = { maxCycles: 260, maxEmptyDispatchStreak: 14 };
const SCALE_DRIVE = { maxCycles: 1200, maxEmptyDispatchStreak: 18 };

// ---------------------------------------------------------------------------
// Runtime cases.
// ---------------------------------------------------------------------------

export function buildDevelopmentResilienceRuntimeCase(id) {
  switch (id) {
    case 'development/impl-review-changes-same-workplace':
    case 'development/impl-feedback-exact': {
      const isFeedback = id.endsWith('feedback-exact');
      const built = buildFeedbackPairHandlers({ variant: 'exact', repairItemKey: 'impl-AC-2' });
      return scenario(id, {
        handlers: built.handlers,
        actorEvidence: built.journal,
        driveOptions: DRIVE,
        oracles: isFeedback ? [
          {
            id: 'development.feedback.exact-causes-repair',
            evaluate() {
              const repairs = built.journal.filter(row => row.kind === 'author-repaired');
              const exactSeen = built.journal.some(row => row.exactVisible === true);
              return {
                passed: exactSeen && repairs.length >= 1,
                evidenceRefs: [],
                details: {
                  invocations: built.journal.filter(r => r.kind === 'author-invocation').length,
                  repairs: repairs.length,
                },
              };
            },
          },
          stageOutcomeOracle('verified'),
          noStrandedExecutionOracle(),
        ] : [
          {
            // SAME-WORKPLACE RETURN: exactly ONE implementation workplace
            // exists for the repaired item and it reaches final acceptance —
            // the changes_requested verdict returned to the SAME workplace
            // author frontier (a second workplace would be a different
            // author identity).
            id: 'development.review.changes-return-to-same-workplace',
            evaluate({ durableTrace }) {
              const repaired = implWorkplacesByKey(durableTrace).get('impl-AC-2');
              const workplaces = repaired ? [repaired] : [];
              const accepted = new Set(
                (durableTrace.finalAcceptances ?? []).map(row => row.workplace_ref));
              const repairGates = (durableTrace.gateDecisions ?? []).filter(g =>
                g.verdict === 'repair_required'
                && g.workplace_ref === repaired?.workplace_ref);
              return {
                passed: workplaces.length === 1
                  && accepted.has(workplaces[0].workplace_ref)
                  && repairGates.length >= 1,
                evidenceRefs: workplaces.map(w => `workplace:${w.workplace_ref}`),
                details: {
                  repairedItemWorkplaces: workplaces.length,
                  accepted: workplaces.filter(w => accepted.has(w.workplace_ref)).length,
                  repairRequiredGates: repairGates.length,
                },
              };
            },
          },
          {
            // SIBLING CONSERVATION: the first item's workplace holds exactly
            // ONE final acceptance and exactly ONE author execution — the
            // sibling's repair never reset or re-ran accepted work.
            id: 'development.sibling-isolation.accepted-sibling-conserved',
            evaluate({ durableTrace }) {
              const accepted = new Set(
                (durableTrace.finalAcceptances ?? []).map(row => row.workplace_ref));
              const sibling = implWorkplacesByKey(durableTrace).get('impl-AC-1');
              const siblingTasks = (durableTrace.workIntents ?? [])
                .filter(t => t.workplace_ref === sibling?.workplace_ref
                  && t.task_kind === 'development.code');
              const siblingExecs = (durableTrace.workerExecutions ?? [])
                .filter(e => siblingTasks.some(t => t.id === e.task_id));
              const siblingAcceptances = (durableTrace.finalAcceptances ?? [])
                .filter(a => a.workplace_ref === sibling?.workplace_ref);
              return {
                passed: Boolean(sibling) && accepted.has(sibling.workplace_ref)
                  && siblingAcceptances.length === 1
                  && siblingExecs.length === 1,
                evidenceRefs: sibling ? [`workplace:${sibling.workplace_ref}`] : [],
                details: {
                  accepted: Boolean(sibling) && accepted.has(sibling.workplace_ref),
                  acceptanceCount: siblingAcceptances.length,
                  authorExecutions: siblingExecs.length,
                },
              };
            },
          },
          stageOutcomeOracle('verified'),
          noStrandedExecutionOracle(),
        ],
      });
    }

    case 'development/impl-feedback-absent': {
      const built = buildFeedbackPairHandlers({ variant: 'absent', repairItemKey: 'impl-AC-2' });
      return scenario(id, {
        handlers: built.handlers,
        actorEvidence: built.journal,
        driveOptions: DRIVE,
        oracles: [
          {
            id: 'development.feedback.absent-no-magical-repair',
            evaluate() {
              const repairs = built.journal.filter(row => row.kind === 'author-repaired');
              const exactSeen = built.journal.some(row => row.exactVisible === true);
              const repeats = built.journal.filter(row => row.kind === 'author-repeated');
              return {
                passed: !exactSeen && repairs.length === 0 && repeats.length >= 1,
                evidenceRefs: [],
                details: {
                  exactFeedbackEverVisible: exactSeen,
                  repairs: repairs.length,
                  honestRepeats: repeats.length,
                },
              };
            },
          },
          {
            // NO convergence to verified on unchanged material: the run must
            // end in a typed non-verified state (never a fabricated success)
            // and no repaired material was ever accepted for the fault item.
            id: 'development.feedback.absent-typed-nonconvergence',
            evaluate({ durableTrace }) {
              const verified = (durableTrace.stageRuns ?? [])
                .some(row => row.stage_id === DEVELOPMENT_STAGE
                  && row.local_outcome === 'verified');
              const unaccepted = implWorkplacesOf(durableTrace)
                .filter(w => !(durableTrace.finalAcceptances ?? [])
                  .some(a => a.workplace_ref === w.workplace_ref));
              const typed = unaccepted.every(w =>
                w.loop_state === 'terminal' || w.loop_state === 'repair_wait'
                || w.loop_state === 'paused');
              const approved = built.journal
                .filter(row => row.kind === 'review-verdict' && row.verdict === 'approved');
              return {
                passed: !verified && unaccepted.length > 0 && typed
                  && approved.length === 0,
                evidenceRefs: unaccepted.map(w => `workplace:${w.workplace_ref}`),
                details: {
                  verified,
                  unacceptedStates: unaccepted.map(w => ({
                    loop: w.loop_state, terminal: w.terminal_reason,
                  })),
                  approvalsOfUnrepairedMaterial: approved.length,
                },
              };
            },
          },
          noStrandedExecutionOracle(),
        ],
      });
    }

    case 'development/git-integration-after-final-acceptance-only': {
      const built = buildFeedbackPairHandlers({ variant: 'exact', repairItemKey: 'impl-AC-2' });
      return scenario(id, {
        handlers: built.handlers,
        actorEvidence: built.journal,
        driveOptions: DRIVE,
        oracles: [
          {
            // EVERY git-integration effect receipt binds the exact final
            // acceptance decision key of the same workplace — integration
            // exists only as a post-acceptance fact, structurally.
            id: 'development.git-effect.bound-to-final-acceptance',
            evaluate({ durableTrace }) {
              const acceptanceKeysByWorkplace = new Map(
                (durableTrace.finalAcceptances ?? [])
                  .map(a => [a.workplace_ref, a.gate_decision_key]));
              const implReceipts = (durableTrace.cellEffectReceipts ?? [])
                .filter(r => String(r.workplace_ref).includes('development-implementation'));
              const unbound = implReceipts.filter(r =>
                acceptanceKeysByWorkplace.get(r.workplace_ref) !== r.gate_decision_key);
              return {
                passed: implReceipts.length > 0 && unbound.length === 0,
                evidenceRefs: implReceipts.map(r => `effect:${r.effect_receipt_ref}`),
                details: {
                  implementationEffectReceipts: implReceipts.length,
                  unboundToAcceptance: unbound.length,
                },
              };
            },
          },
          {
            // REDRIVE IDEMPOTENCY: per (workplace, effect) every attempt
            // shares ONE idempotency key, exactly one attempt succeeded, and
            // successful integrations equal accepted implementation
            // workplaces (no duplicate merge can hide in a redrive).
            id: 'development.git-effect.redrive-idempotent',
            evaluate({ durableTrace }) {
              const attempts = (durableTrace.cellEffectAttempts ?? [])
                .filter(a => String(a.workplace_ref).includes('development-implementation'));
              const groups = new Map();
              for (const a of attempts) {
                const key = `${a.workplace_ref}|${a.effect_id}`;
                const g = groups.get(key) ?? { keys: new Set(), succeeded: 0 };
                g.keys.add(a.idempotency_key);
                g.succeeded += a.outcome === 'succeeded' ? 1 : 0;
                groups.set(key, g);
              }
              const nonIdempotent = [...groups.entries()]
                .filter(([, g]) => g.keys.size > 1 || g.succeeded !== 1);
              const acceptedImplCount = implWorkplacesOf(durableTrace).filter(w =>
                (durableTrace.finalAcceptances ?? [])
                  .some(a => a.workplace_ref === w.workplace_ref)).length;
              const succeededTotal = [...groups.values()]
                .reduce((sum, g) => sum + g.succeeded, 0);
              return {
                passed: attempts.length > 0 && nonIdempotent.length === 0
                  && succeededTotal === acceptedImplCount,
                evidenceRefs: [...groups.keys()].map(k => `effect-group:${k}`),
                details: {
                  attemptGroups: groups.size,
                  nonIdempotentGroups: nonIdempotent.length,
                  succeededIntegrations: succeededTotal,
                  acceptedImplementationWorkplaces: acceptedImplCount,
                },
              };
            },
          },
          stageOutcomeOracle('verified'),
          noStrandedExecutionOracle(),
        ],
      });
    }

    case 'development/claim-monotonicity-narrowing-rejected': {
      const built = buildClaimNarrowingHandlers();
      return scenario(id, {
        handlers: built.handlers,
        actorEvidence: built.journal,
        driveOptions: DRIVE,
        oracles: [
          failedReceiptOracle('claim-monotonicity', 'development-implementation'),
          {
            id: 'development.claim-monotonicity.wide-claim-eventually-accepted',
            evaluate({ durableTrace }) {
              const narrow = built.journal.find(row => row.narrowed === true);
              const verified = (durableTrace.stageRuns ?? [])
                .some(r => r.stage_id === DEVELOPMENT_STAGE && r.local_outcome === 'verified');
              return {
                passed: Boolean(narrow) && verified,
                evidenceRefs: [],
                details: {
                  narrowAttemptRecorded: Boolean(narrow),
                  attempts: built.journal.map(row => ({
                    invocation: row.invocation, narrowed: row.narrowed,
                  })),
                },
              };
            },
          },
          stageOutcomeOracle('verified'),
          noStrandedExecutionOracle(),
        ],
      });
    }

    case 'development/readiness-source-mismatch-rejected': {
      const handlers = withProductSubmitFault(
        { id: 'factory.development-readiness-manifest.v1', nodeFragment: 'certify-product-readiness' },
        input => {
          const hash = String(input.content.sourceCandidate?.hash ?? '');
          if (hash.length === 64) {
            input.content.sourceCandidate = {
              ...input.content.sourceCandidate,
              hash: `${hash.slice(0, 62)}${hash.slice(62) === '00' ? '01' : '00'}`,
            };
          }
        },
      );
      return scenario(id, {
        handlers,
        driveOptions: DRIVE,
        oracles: [
          {
            // The mismatched declaration is REJECTED: the readiness cell
            // never reaches final acceptance, no runnable candidate is bound,
            // and the workplace ends in a TYPED state — never a fabricated
            // pass and never anonymous.
            id: 'development.readiness.mismatch-rejected-typed',
            evaluate({ durableTrace }) {
              const readiness = (durableTrace.workplaces ?? [])
                .filter(w => String(w.workplace_ref)
                  .includes('development-readiness-certification'));
              const accepted = new Set((durableTrace.finalAcceptances ?? [])
                .map(a => a.workplace_ref));
              const boundRunnable = (durableTrace.processProducts ?? [])
                .some(p => p.product_kind === 'development.runnable-candidate');
              const typed = readiness.every(w =>
                w.loop_state === 'terminal' || w.loop_state === 'paused'
                || w.loop_state === 'repair_wait');
              const errorReceipt = (durableTrace.checkReceipts ?? [])
                .some(r => r.outcome !== 'passed'
                  && String(r.subject_candidate_set_ref)
                    .includes('development-readiness-certification'));
              return {
                passed: readiness.length > 0
                  && readiness.every(w => !accepted.has(w.workplace_ref))
                  && !boundRunnable && typed && errorReceipt,
                evidenceRefs: readiness.map(w => `workplace:${w.workplace_ref}`),
                details: {
                  readinessWorkplaces: readiness.map(w => ({
                    loop: w.loop_state, terminal: w.terminal_reason,
                  })),
                  boundRunnable,
                  nonPassReceipt: errorReceipt,
                },
              };
            },
          },
          noStrandedExecutionOracle(),
        ],
      });
    }

    case 'development/verification-evidence-pins-exact-candidate-hash': {
      const handlers = withProductSubmitFault(
        { id: 'factory.candidate-verification-evidence-product.v2', nodeFragment: 'verify-acceptance' },
        input => {
          const hash = String(input.content.candidateHash ?? '');
          if (hash.length === 64) {
            input.content.candidateHash = `${hash.slice(0, 62)}${hash.slice(62) === '00' ? '01' : '00'}`;
          }
        },
      );
      return scenario(id, {
        handlers,
        driveOptions: DRIVE,
        oracles: [
          failedReceiptOracle('verification', 'development-verification'),
          {
            id: 'development.verification.evidence-pins-exact-candidate.converged',
            evaluate({ durableTrace }) {
              const verify = (durableTrace.workplaces ?? [])
                .filter(w => String(w.workplace_ref).includes('development-verification'));
              const accepted = new Set((durableTrace.finalAcceptances ?? [])
                .map(a => a.workplace_ref));
              const executed = (durableTrace.developmentVerificationLedger ?? [])
                .filter(row => row.entry_state === 'executed');
              return {
                passed: verify.length > 0
                  && verify.every(w => accepted.has(w.workplace_ref))
                  && executed.length >= verify.length,
                evidenceRefs: verify.map(w => `workplace:${w.workplace_ref}`),
                details: {
                  verificationWorkplaces: verify.length,
                  accepted: verify.filter(w => accepted.has(w.workplace_ref)).length,
                  executedLedgerFacts: executed.length,
                },
              };
            },
          },
          stageOutcomeOracle('verified'),
          noStrandedExecutionOracle(),
        ],
      });
    }

    case 'development/local-readiness-failed-upstream-blocked':
      return scenario(id, {
        handlers: buildProductDefectHandlers(),
        driveOptions: DRIVE,
        oracles: [
          {
            // The deterministic product defect reached SETTLEMENT (not an
            // infinite certifier repair loop): the development certificate
            // records 'blocked' with the local-readiness-failed reason
            // family, the failed runnability receipt belongs to the FROZEN
            // candidate (upstream ownership), and the certifier burned no
            // recovery epochs.
            id: 'development.upstream-defect.routes-to-settlement',
            evaluate({ durableTrace }) {
              const certs = (durableTrace.processOutcomeCertificates ?? [])
                .filter(c => String(c.module_ref_key ?? '').includes('development')
                  && c.decision !== 'formalized');
              const blocked = certs.find(c => c.decision === 'blocked');
              const reasons = blocked ? String(blocked.reason_codes ?? '') : '';
              const failedRunnability = (durableTrace.checkReceipts ?? [])
                .some(r => String(r.provider_id).includes('local-runnability')
                  && r.outcome === 'failed');
              const certifierRepairLoop = (durableTrace.recoveryEpochs ?? [])
                .filter(e => String(e.workplace_ref)
                  .includes('development-readiness-certification'));
              return {
                passed: Boolean(blocked)
                  && /local-readiness|candidate-missing/.test(reasons)
                  && failedRunnability && certifierRepairLoop.length === 0,
                evidenceRefs: certs.map(c => `process-certificate:${c.id}`),
                details: {
                  decisions: certs.map(c => c.decision),
                  blockedReasonCodes: reasons,
                  failedRunnabilityReceipt: failedRunnability,
                  certifierRecoveryEpochs: certifierRepairLoop.length,
                },
              };
            },
          },
          {
            // Terminal accounting on the blocked route: every verification
            // obligation carries an explicit terminal fact with provenance
            // (CC-GAP-8) — none stays a bare pending row.
            id: 'development.blocked.verification-ledger-terminal-facts',
            evaluate({ durableTrace }) {
              const ledger = durableTrace.developmentVerificationLedger ?? [];
              // Append-only fold (latest event per criterion wins): the
              // CURRENT state of every obligation must be terminal-* — the
              // historical proposed/pending rows stay as append-only
              // history, they are not bare-pending CURRENT states.
              const latestByCriterion = new Map();
              for (const row of ledger) {
                latestByCriterion.set(row.criterion_key, row);
              }
              const current = [...latestByCriterion.values()];
              const pending = current.filter(row =>
                row.entry_state === 'proposed' || row.entry_state === 'pending');
              const terminal = current.filter(row =>
                String(row.entry_state).startsWith('terminal-'));
              return {
                passed: ledger.length > 0 && pending.length === 0
                  && terminal.length > 0
                  && terminal.every(row => row.terminal_reason_codes
                    && String(row.terminal_reason_codes).length > 2
                    && row.terminal_provenance_ref),
                evidenceRefs: terminal.map(row =>
                  `ledger:${row.criterion_key}:${row.entry_state}`),
                details: {
                  totalEntries: ledger.length,
                  barePending: pending.length,
                  terminalFacts: terminal.length,
                  routes: [...new Set(terminal.map(row => row.entry_state))],
                },
              };
            },
          },
          stageOutcomeOracle('blocked'),
          lifecycleTerminalOracle('development-blocked'),
          kanbanDrainAtTerminalOracle(),
          noStrandedExecutionOracle(),
        ],
      });

    case 'development/planner-frozen-srs-unsat-failed': {
      // The §2.2 ambiguity counterexample (Elite-8 class): the FROZEN SRS
      // declares one bare basename matching TWO declared full-path surfaces —
      // no jointly satisfying plan exists, and the plan gate fails TYPED
      // (srs-file-identity-conflict, plan-independent) BEFORE any
      // implementation worker is spawned, terminating the stage 'failed'.
      const handlers = { ...W9_HAPPY_HANDLERS };
      const srsKey = Object.keys(handlers)
        .find(k => k.includes('define-architecture-contract/author'));
      const base = handlers[srsKey];
      handlers[srsKey] = ctx => {
        const artifactCreate = ctx.handlers.artifact_create;
        const hs = { ...ctx.handlers, artifact_create(input) {
          if (input?.type === 'SRS') {
            // Surgical mutation of the base-authored SRS (the base writes the
            // file BEFORE artifact_create, so its bytes — including the
            // register coverage relay and the full stanza grammar — are on
            // disk at this point):
            // 1. §2.2 declares the BARE basename `index.html`;
            // 2. a §D1 surface declares TWO files sharing that basename;
            // 3. §D2 maps the two criteria onto those full-path files.
            const filePath = String(input.path).split('#')[0];
            const baseContent = readFileSync(
              path.join(ctx.context.workspaceRoot, filePath), 'utf8');
            const ambiguous = baseContent
              .replace('| w9-harness | `package.json` |',
                '| web | Browser product | `index.html` |')
              .replace('files: ["src/factory-e2e/"]',
                'files: ["frontend/index.html"]')
              .replace('files: ["src/factory-e2e/"]',
                'files: ["legacy/index.html"]')
              .replace('## §D2 AC Map',
                ['## §D1 Canonical File/Module Surface',
                  '',
                  '| File | Module | Responsibility |',
                  '|---|---|---|',
                  '| `frontend/index.html` | web | Browser product entry |',
                  '| `legacy/index.html` | web | Legacy browser product entry |',
                  '',
                  '## §D2 AC Map'].join('\n'));
            writeRepoFile(ctx.context.workspaceRoot, filePath, ambiguous);
          }
          return artifactCreate(input);
        } };
        return base({ ...ctx, handlers: hs });
      };
      return scenario(id, {
        handlers: Object.freeze(handlers),
        driveOptions: DRIVE,
        oracles: [
          {
            // TYPED pre-worker refusal: the plan gate failed with the frozen
            // SRS identity conflict and ZERO implementation workplaces were
            // materialized (no worker budget burned on an unsatisfiable
            // frozen input).
            id: 'development.unsat.srs-file-identity-conflict-pre-worker',
            evaluate({ durableTrace }) {
              const impl = implWorkplacesOf(durableTrace);
              const receipts = (durableTrace.checkReceipts ?? []).filter(r =>
                String(r.provider_id).includes('task-graph-contract')
                && r.outcome === 'failed');
              const planWorkplace = (durableTrace.workplaces ?? [])
                .filter(w => String(w.workplace_ref)
                  .includes('development-plan-task-graph'));
              const typed = planWorkplace.every(w =>
                w.loop_state === 'terminal' || w.loop_state === 'repair_wait');
              return {
                passed: receipts.length > 0 && impl.length === 0 && typed,
                evidenceRefs: receipts.map(r => `check:${r.check_receipt_ref}`),
                details: {
                  failedPlanGateReceipts: receipts.length,
                  materializedImplementationWorkplaces: impl.length,
                  planWorkplaceStates: planWorkplace.map(w => ({
                    loop: w.loop_state, terminal: w.terminal_reason,
                  })),
                },
              };
            },
          },
          stageOutcomeOracle('failed'),
          lifecycleTerminalOracle('failed'),
          kanbanDrainAtTerminalOracle(),
          noStrandedExecutionOracle(),
        ],
      });
    }

    case 'development/task-graph-production-scale-satisfiable':
      return scenario(id, {
        handlers: buildProductionScaleHandlers({ injectCycle: false }),
        driveOptions: SCALE_DRIVE,
        oracles: [
          {
            id: 'development.production-scale.graph-decided-and-materialized',
            evaluate({ durableTrace }) {
              const impl = implWorkplacesOf(durableTrace);
              const verify = (durableTrace.workplaces ?? [])
                .filter(w => String(w.workplace_ref).includes('development-verification'));
              const accepted = new Set((durableTrace.finalAcceptances ?? [])
                .map(a => a.workplace_ref));
              const cards = impl.length + verify.length;
              return {
                passed: cards === 59
                  && impl.concat(verify).every(w => accepted.has(w.workplace_ref)),
                evidenceRefs: impl.concat(verify).map(w => `workplace:${w.workplace_ref}`),
                details: {
                  totalWorkItemCards: cards,
                  implementationCards: impl.length,
                  verificationCards: verify.length,
                  allAccepted: impl.concat(verify)
                    .every(w => accepted.has(w.workplace_ref)),
                },
              };
            },
          },
          {
            id: 'development.production-scale.first-proposal-accepted',
            evaluate({ durableTrace }) {
              const planRepairs = (durableTrace.gateDecisions ?? []).filter(g =>
                String(g.workplace_ref).includes('development-plan-task-graph')
                && g.verdict === 'repair_required');
              const planAccepted = (durableTrace.gateDecisions ?? []).filter(g =>
                String(g.workplace_ref).includes('development-plan-task-graph')
                && g.gate_phase === 'final' && g.verdict === 'accepted');
              return {
                passed: planAccepted.length === 1 && planRepairs.length === 0,
                evidenceRefs: planAccepted.map(g => `gate:${g.decision_key}`),
                details: {
                  planAcceptances: planAccepted.length,
                  planRepairs: planRepairs.length,
                },
              };
            },
          },
          stageOutcomeOracle('verified'),
          noStrandedExecutionOracle(),
        ],
      });

    case 'development/task-graph-production-scale-cycle-unsat':
      return scenario(id, {
        handlers: buildProductionScaleHandlers({ injectCycle: true }),
        driveOptions: SCALE_DRIVE,
        oracles: [
          {
            id: 'development.production-scale.cycle-unsat-typed-witness',
            evaluate({ durableTrace }) {
              const receipts = (durableTrace.checkReceipts ?? []).filter(r =>
                String(r.provider_id).includes('task-graph-contract')
                && r.outcome === 'failed');
              const planRepairs = (durableTrace.gateDecisions ?? []).filter(g =>
                String(g.workplace_ref).includes('development-plan-task-graph')
                && g.verdict === 'repair_required');
              return {
                passed: receipts.length > 0 && planRepairs.length >= 1,
                evidenceRefs: receipts.map(r => `check:${r.check_receipt_ref}`),
                details: {
                  failedPlanGateReceipts: receipts.length,
                  planRepairRounds: planRepairs.length,
                },
              };
            },
          },
          {
            id: 'development.production-scale.repair-converges',
            evaluate({ durableTrace }) {
              const impl = implWorkplacesOf(durableTrace);
              const verify = (durableTrace.workplaces ?? [])
                .filter(w => String(w.workplace_ref).includes('development-verification'));
              return {
                passed: impl.length + verify.length === 59,
                evidenceRefs: impl.map(w => `workplace:${w.workplace_ref}`),
                details: { totalWorkItemCards: impl.length + verify.length },
              };
            },
          },
          stageOutcomeOracle('verified'),
          noStrandedExecutionOracle(),
        ],
      });

    default:
      return null;
  }
}
