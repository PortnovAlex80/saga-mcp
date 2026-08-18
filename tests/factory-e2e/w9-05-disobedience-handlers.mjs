// tests/factory-e2e/w9-05-disobedience-handlers.mjs
//
// W9-05 SCRIPTED DISOBEDIENCE HANDLERS (stage-6 G2).
//
// Each builder extends W9_HAPPY_HANDLERS with ONE worker-protocol override:
// the worker disobeys a prompt rule on its FIRST invocation for a workplace
// and the production machinery (finalizeManagedWorkerProcess /
// reconcileWorkerExecutions / crash repair / requeue) does the classifying.
// The second invocation is the happy handler — the cohort must converge
// through genuine work only.
//
// Design notes:
//   - The disobedient author deliberately does NOT product_submit. A pinned
//     typed-submission cell would close via the ADR-072 final-presentation
//     commitment WITHOUT worker_done — that is designed behavior and a
//     different scenario. Here the "real work" is an artifact through the
//     production artifact_create surface: durable, visible, and provably NOT
//     interpretable as completion.
//   - No authority tables are written by the handlers (ADR-053 alignment).
//   - The fake-file scenario writes worker-done-call.json with a plausible
//     payload shape (per the pinned template resource) — rule 6a exists
//     precisely for this: a file is not a tool call.

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { W9_HAPPY_HANDLERS } from './w9-happy-handlers.mjs';

const FRM = 'solution-formalization@1.0.0';
const TARGET_KEY = `${FRM}/define-product-contract/author/singleton`;

/** Where the fake-done-file scenario writes its forged call payload. The
 * drive script asserts this file EXISTS while the factory ignores it. */
export const FAKE_DONE_FILE = join(tmpdir(), 'w9-05-fake-done-file.json');

// ---------------------------------------------------------------------------
// Scenario 2 (w9-05-exit-without-done): real work, then exit 0, no worker_done.
// ---------------------------------------------------------------------------
const exitWithoutDoneFired = new Set();

function disobedientAuthorExitsAfterWork(ctx) {
  const { handlers, assignment, meta, db, context } = ctx;
  const workplaceRef = meta.workplace_ref ?? meta.workplaceRef;
  if (!workplaceRef || exitWithoutDoneFired.has(workplaceRef)) {
    return W9_HAPPY_HANDLERS[TARGET_KEY](ctx);
  }
  exitWithoutDoneFired.add(workplaceRef);

  // REAL durable work through the production surface — visible, queryable,
  // and deliberately NOT a completion signal. The artifact references a file
  // actually written into the fresh worktree so its canonical content hash
  // resolves (a hash-less artifact would poison later honest updates of the
  // same slot during the repair cycle — that is a different defect class).
  const artifactPath = 'docs/decisions/w9-05-disobedience.md';
  const taskRow = db.prepare(
    `SELECT t.epic_id AS epic_id, e.project_id AS project_id
       FROM tasks t JOIN epics e ON e.id = t.epic_id
      WHERE t.id = ?`,
  ).get(Number(assignment.taskId));
  if (taskRow && context?.workspaceRoot) {
    const abs = join(context.workspaceRoot, artifactPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'W9-05 disobedience scenario: real durable work performed without worker_done.\n');
    handlers.artifact_create({
      project_id: taskRow.project_id,
      epic_id: taskRow.epic_id,
      type: 'decision',
      title: 'W9-05 disobedience: durable work performed without worker_done',
      path: artifactPath,
    });
  }
  // "prints a summary and exits 0" — the scripted executor maps this outcome
  // to exit code 0; the production finalizer must still classify it lost.
  process.stdout.write(`[w9-05] disobedient worker summary for task ${assignment.taskId}: work done, exiting WITHOUT worker_done\n`);
  return {
    kind: 'exit-without-done',
    crashPoint: 'author-exits-after-work-without-done',
  };
}

export function buildExitWithoutDoneHandlers() {
  exitWithoutDoneFired.clear();
  return {
    ...W9_HAPPY_HANDLERS,
    [TARGET_KEY]: disobedientAuthorExitsAfterWork,
  };
}

// ---------------------------------------------------------------------------
// Scenario 3 (w9-05-fake-done-file): forge worker-done-call.json, exit 0.
// ---------------------------------------------------------------------------
const fakeDoneFileFired = new Set();

function disobedientAuthorFakesDoneFile(ctx) {
  const { assignment, meta } = ctx;
  const workplaceRef = meta.workplace_ref ?? meta.workplaceRef;
  if (!workplaceRef || fakeDoneFileFired.has(workplaceRef)) {
    return W9_HAPPY_HANDLERS[TARGET_KEY](ctx);
  }
  fakeDoneFileFired.add(workplaceRef);

  // The forgery: a plausible worker-done-call payload on disk (template
  // shape from the pinned package resource). No MCP tool is invoked.
  writeFileSync(FAKE_DONE_FILE, JSON.stringify({
    tool: 'worker_done',
    task_id: Number(assignment.taskId),
    worker_id: assignment.workerId,
    execution_id: assignment.workerExecutionId,
    result: 'W9-05 forgery: worker-done-call.json faked without the actual tool call',
  }, null, 2));
  process.stdout.write(`[w9-05] disobedient worker for task ${assignment.taskId}: wrote ${FAKE_DONE_FILE}, exiting 0\n`);
  return {
    kind: 'exit-without-done',
    crashPoint: 'author-fakes-worker-done-file',
  };
}

export function buildFakeDoneFileHandlers() {
  fakeDoneFileFired.clear();
  return {
    ...W9_HAPPY_HANDLERS,
    [TARGET_KEY]: disobedientAuthorFakesDoneFile,
  };
}
