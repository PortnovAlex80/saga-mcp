// tests/factory-e2e/w9-06-scope-widening-handlers.mjs
//
// W9-06 — SCOPE INSUFFICIENCY AS A LAWFUL TRANSITION (stage-13 brief TASK 1).
//
// Domain-free RED reproduction of the stage-12 deadlock: a card whose honest
// work requires writing a path its frozen changeScopes do not contain. The
// fixture invents its own artefact world — the criterion's companion
// artefact lives at `atlas/registry-map.json` — and names NO path from the
// stage-12 run: a fix shaped around that run's paths would not pass here.
//
// The overrides replace MODEL COGNITION ONLY. The honest worker keeps
// writing the required artefact on every attempt (removing it would be
// dishonest work); the scope fence keeps rejecting it; the factory must find
// the lawful way out. Today (RED) it cannot: the trajectory parks the card
// REPLAN_MANDATED and the lifecycle stalls. After stage-13 the same history
// routes to a scope-widening request decided on CONTENTION ONLY.
//
// Variants:
//   buildGrantHandlers()   — trajectory-declared insufficiency, uncontended:
//                            grant → widened revision → attempt passes →
//                            lifecycle completes runnable-local.
//   buildDeclaredHandlers() — the worker concludes its attempt with the
//                            typed outcome scope-insufficient naming the
//                            needed scope; grant → retry passes.

import { execFileSync } from 'node:child_process';
import { W9_HAPPY_HANDLERS } from './w9-happy-handlers.mjs';

const DEV = 'solution-development@1.4.4';

/** The domain-free honest need: a criterion companion artefact the carve forgot. */
const ATLAS_DIR = 'atlas';
const ATLAS_FILE = 'atlas/registry-map.json';
const ATLAS_CONTENT = JSON.stringify(
  { schema: 'w9-atlas-registry-map/v1', regions: ['north', 'south'], generated: 'scripted' },
  null, 2,
) + '\n';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  }).trim();
}

function done(handlers, assignment, result) {
  handlers.worker_done({
    task_id: Number(assignment.taskId),
    worker_id: assignment.workerId,
    execution_id: assignment.workerExecutionId,
    result,
  });
}

/** How many repair_required gate decisions this workplace already burned. */
function repairRounds(db, workplaceRef) {
  if (!db || !workplaceRef) return 0;
  try {
    return db.prepare(
      `SELECT COUNT(*) AS n FROM factory_gate_decisions
        WHERE workplace_ref=? AND verdict='repair_required'`,
    ).get(workplaceRef).n;
  } catch {
    return 0;
  }
}

/** True once a widening grant for this workplace exists (post-fix ledger). */
function wideningGranted(db, workplaceRef) {
  if (!db || !workplaceRef) return false;
  try {
    return db.prepare(
      `SELECT COUNT(*) AS n FROM factory_scope_widening_events
        WHERE workplace_ref=? AND event_kind='grant'`,
    ).get(workplaceRef).n > 0;
  } catch {
    return false;
  }
}

/**
 * The honest implement worker: identical to the happy handler, plus the
 * criterion's companion artefact under atlas/ — but ONLY for the FIRST
 * implementation item (the dependency-chain root). Later items behave happy:
 * one honest need, one widening request, no self-inflicted contention.
 */
function honestImplementWithAtlas(args) {
  const { meta } = args;
  const item = meta.cell_input_item || findImplementation(meta);
  if (!item?.key) throw new Error('implementation work item not found');
  const isChainRoot = !Array.isArray(item.dependsOnKeys) || item.dependsOnKeys.length === 0;
  if (!isChainRoot) return happyImplement(args);
  return implementWithAtlas(item, args);
}

/** The happy-path implement handler re-exported for the non-offending items. */
const happyImplement = W9_HAPPY_HANDLERS[`${DEV}/implement-work-items/author/*`];

function implementWithAtlas(item, { handlers, assignment, meta, context, db }) {
  const workItemKey = String(item.key);
  const safe = workItemKey.replace(/[^a-zA-Z0-9._-]/g, '-');

  const binding = db
    ? db.prepare(
        `SELECT pr.local_path, pr.integration_branch
           FROM tasks t
           JOIN project_repositories pr ON pr.id=t.project_repository_id
          WHERE t.id = ?`,
      ).get(Number(assignment.taskId))
    : null;
  const repoPath = binding?.local_path ?? context.workspaceRoot;
  const integrationBranch = binding?.integration_branch || 'dev';

  const branch = `task/${safe}-${assignment.taskId}`;
  git(repoPath, 'checkout', '-B', branch, integrationBranch);
  const filePath = `src/w9/${safe}.ts`;
  const atlasPath = ATLAS_FILE;
  writeRepoFile(repoPath, filePath,
    `// deterministic implementation for ${workItemKey}\nexport const ${safe.replace(/[^a-zA-Z0-9_]/g, '_')} = true;\n`);
  writeRepoFile(repoPath, atlasPath, ATLAS_CONTENT);
  git(repoPath, 'add', filePath, atlasPath);
  git(repoPath, 'commit', '-m', `w9: implement ${workItemKey} (with atlas registry map)`);
  const commitSha = git(repoPath, 'rev-parse', 'HEAD');
  const treeSha = git(repoPath, 'rev-parse', `${commitSha}^{tree}`);
  const baseCommit = git(repoPath, 'merge-base', integrationBranch, branch) ||
    git(repoPath, 'rev-parse', integrationBranch);
  git(repoPath, 'checkout', integrationBranch);

  const projectRepositoryId = Number(item.projectRepositoryId || meta.project_repository_id || 1);
  handlers.product_submit({
    schema: 'factory.development-implementation-result.v1',
    content: {
      workItemKey,
      terminalStatus: 'complete',
      source: { branch, commitSha, workItemKey },
      snapshot: { commitSha, treeSha, files: [filePath, atlasPath], changedFiles: [filePath, atlasPath] },
      repository: {
        projectRepositoryId,
        integrationBranch,
        baseCommit,
        name: 'fresh-harness-repo',
      },
      buildProducts: [],
      reasonCodes: [],
      readiness: RUNNABLE_STATIC_READINESS,
    },
  });
  done(handlers, assignment, `implemented ${workItemKey} incl. ${atlasPath}`);
  return { kind: 'worker-done-accepted' };
}

/**
 * The DECLARING implement worker: same honest work, but after the first
 * scope rejection it concludes the attempt with the typed scope-insufficient
 * outcome naming the needed scope instead of resubmitting blindly.
 */
function declaringImplement(args) {
  const { handlers, assignment, meta } = args;
  const item = meta.cell_input_item || findImplementation(meta);
  if (!item?.key) throw new Error('implementation work item not found');
  const isChainRoot = !Array.isArray(item.dependsOnKeys) || item.dependsOnKeys.length === 0;
  if (!isChainRoot) return happyImplement(args);
  const workplaceRef = meta.workplace_ref ?? meta.workplaceRef ?? null;
  const rounds = repairRounds(args.db, workplaceRef);
  const granted = wideningGranted(args.db, workplaceRef);
  if (rounds >= 1 && !granted) {
    handlers.worker_done({
      task_id: Number(assignment.taskId),
      worker_id: assignment.workerId,
      execution_id: assignment.workerExecutionId,
      outcome: 'scope-insufficient',
      requested_scopes: [ATLAS_DIR + '/'],
      result:
        `the criterion's companion artefact ${ATLAS_FILE} is required by the work `
        + 'but sits outside the frozen changeScopes; declaring scope insufficiency '
        + `for [${ATLAS_DIR}/]`,
    });
    return { kind: 'worker-done-declared' };
  }
  return honestImplementWithAtlas(args);
}

function findImplementation(meta) {
  const stack = [meta];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (value.kind === 'implementation' && typeof value.key === 'string') return value;
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return null;
}

// The happy handlers export these as module-internal helpers; replicate the
// two tiny primitives here to keep this module self-contained.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
function writeRepoFile(repoPath, relPath, content) {
  const target = path.join(repoPath, relPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}
const RUNNABLE_STATIC_READINESS = Object.freeze({
  kind: 'static',
  commands: { installCommand: null, testCommand: 'node test.js' },
});

export function buildGrantHandlers() {
  return {
    ...W9_HAPPY_HANDLERS,
    [`${DEV}/implement-work-items/author/*`]: honestImplementWithAtlas,
  };
}

export function buildDeclaredHandlers() {
  return {
    ...W9_HAPPY_HANDLERS,
    [`${DEV}/implement-work-items/author/*`]: declaringImplement,
  };
}
