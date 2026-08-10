import { readFileSync, writeFileSync } from 'node:fs';

function patch(path, transform) {
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`PATCH_NOOP: ${path}`);
  writeFileSync(path, after, 'utf8');
}

function replaceOnce(text, from, to, label) {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`PATCH_ANCHOR_MISSING: ${label}`);
  if (text.indexOf(from, first + from.length) >= 0) {
    throw new Error(`PATCH_ANCHOR_AMBIGUOUS: ${label}`);
  }
  return text.slice(0, first) + to + text.slice(first + from.length);
}

patch('tests/factory-contract/scenario-dispatcher.mjs', source => {
  let next = replaceOnce(
    source,
    "import { readFileSync } from 'node:fs';",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    'scenario-dispatcher fs import',
  );
  next = replaceOnce(
    next,
    `  const invocationLog = [];\n  // Git Desk parity:`,
    `  // Attempt identity must survive physical worker replacement. Each worker\n  // subprocess gets a fresh in-memory array, so preload the durable invocation\n  // history before scenario selection. The current process still records only\n  // its own invocation in invocationLog; the append path below remains intact.\n  let priorInvocations = [];\n  if (invocationLogPath) {\n    try {\n      const parsed = JSON.parse(readFileSync(invocationLogPath, 'utf8').trim() || '[]');\n      if (Array.isArray(parsed)) priorInvocations = parsed;\n    } catch {}\n  }\n  const invocationLog = [];\n  // Git Desk parity:`,
    'scenario-dispatcher invocation history',
  );
  next = replaceOnce(
    next,
    `      scenarios,\n      invocationLog,\n      repoPath,`,
    `      scenarios,\n      invocationLog,\n      priorInvocations,\n      repoPath,`,
    'scenario-dispatcher pass prior history',
  );
  return next;
});

patch('tests/factory-contract/scenario-engine.mjs', source => {
  let next = replaceOnce(
    source,
    `// --- Scenario engine ---\n\n/**\n * Create a scenario worker process.`,
    `// --- Scenario engine ---\n\n/** Cross-process attempt number for one semantic scenario key. */\nexport function scenarioAttemptNumber(priorInvocations, invocationLog, keyStr) {\n  const prior = Array.isArray(priorInvocations) ? priorInvocations : [];\n  const current = Array.isArray(invocationLog) ? invocationLog : [];\n  return prior.filter(i => i?.keyStr === keyStr).length\n    + current.filter(i => i?.keyStr === keyStr).length\n    + 1;\n}\n\n/**\n * Create a scenario worker process.`,
    'scenario-engine attempt helper',
  );
  next = replaceOnce(
    next,
    `  const { mcpConfigPath, prompt, scenarios, invocationLog, repoPath, desk } = opts;`,
    `  const {\n    mcpConfigPath, prompt, scenarios, invocationLog, priorInvocations = [], repoPath, desk,\n  } = opts;`,
    'scenario-engine destructuring',
  );
  next = replaceOnce(
    next,
    `    const attempt = invocationLog.filter(i => i.keyStr === keyStr).length + 1;`,
    `    const attempt = scenarioAttemptNumber(priorInvocations, invocationLog, keyStr);`,
    'scenario-engine attempt calculation',
  );
  return next;
});

patch('tests/factory-contract/golden-path-scenarios.mjs', source => {
  let next = replaceOnce(
    source,
    `const formalizationArchitecture = async ({ client, task, prompt, repoPath }) => {`,
    `const formalizationArchitecture = async ({ client, task, prompt, repoPath, attempt }) => {`,
    'architecture scenario attempt parameter',
  );
  next = replaceOnce(
    next,
    "  const srsContent = `# SRS\\n\\n## §D2 Acceptance Criteria Decomposition",
    "  const srsContent = `# SRS\\n\\nFixture production attempt: ${attempt}\\n\\n## §D2 Acceptance Criteria Decomposition",
    'architecture distinct repair product',
  );
  next = replaceOnce(
    next,
    `const approvedReview = async ({ client, task, prompt }) => {\n  const wpRef = metaOf(task).workplace_ref;\n  const cand = await actions.readAuthorCandidate(client, wpRef);\n  await actions.submitProduct(client, 'factory.review-verdict.v1', {\n    verdict: 'approved', findings: [],\n    subject_candidate_set_ref: cand.candidate_set_ref,\n  });\n  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,\n    'review: approved');\n};`,
    `const approvedReview = async ({ client, task, prompt }) => {\n  const wpRef = metaOf(task).workplace_ref;\n  const cand = await actions.readAuthorCandidate(client, wpRef);\n  await actions.submitProduct(client, 'factory.review-verdict.v1', {\n    verdict: 'approved', findings: [],\n    subject_candidate_set_ref: cand.candidate_set_ref,\n  });\n  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,\n    'review: approved');\n};\n\n// The canonical cold path MUST traverse the semantic backward arc at least\n// once. Attempt 1 rejects the exact author CandidateSet; attempt 2 approves the\n// repaired CandidateSet. If attempt identity resets per process, if the same\n// Workplace is not requeued to author, or if reviewer->author projection is\n// broken, the full golden path cannot reach terminal success.\nconst repairThenApproveArchitectureReview = async ({ client, task, prompt, attempt }) => {\n  const wpRef = metaOf(task).workplace_ref;\n  const cand = await actions.readAuthorCandidate(client, wpRef);\n  const reject = attempt === 1;\n  await actions.submitProduct(client, 'factory.review-verdict.v1', {\n    verdict: reject ? 'changes_requested' : 'approved',\n    findings: reject ? ['fixture: force one architecture repair round'] : [],\n    subject_candidate_set_ref: cand.candidate_set_ref,\n  });\n  await actions.done(\n    client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,\n    reject ? 'review: changes requested' : 'review: approved after repair',\n  );\n};`,
    'forced architecture reviewer repair handler',
  );
  next = replaceOnce(
    next,
    `  [\`${'${FRM}'}/define-architecture-contract/reviewer/singleton\`]: approvedReview,`,
    `  [\`${'${FRM}'}/define-architecture-contract/reviewer/singleton\`]: repairThenApproveArchitectureReview,`,
    'architecture reviewer mapping',
  );
  return next;
});

patch('tests/factory-contract/golden-path.test.mjs', source => {
  let next = replaceOnce(
    source,
    `    assert.ok(\n      resultDb.prepare(\`SELECT COUNT(*) AS n FROM factory_external_effect_actions WHERE module_ref_key LIKE 'delivery-release@%'\`).get().n >= 1,\n      'Run A Delivery used real external-effect ledger',\n    );\n    resultDb.close();`,
    `    assert.ok(\n      resultDb.prepare(\`SELECT COUNT(*) AS n FROM factory_external_effect_actions WHERE module_ref_key LIKE 'delivery-release@%'\`).get().n >= 1,\n      'Run A Delivery used real external-effect ledger',\n    );\n\n    // Transition theorem inside the full physical-worker golden path: one and\n    // the same architecture Workplace must survive reviewer rejection, return\n    // to author, produce a second author CandidateSet, be reviewed again, and\n    // only then become terminal(accepted).\n    const architectureWorkplaces = resultDb.prepare(\n      \`SELECT workplace_ref,loop_state,terminal_reason\n         FROM factory_workplaces\n        WHERE production_cell_id='formalization-architecture-contract'\`,\n    ).all();\n    assert.equal(architectureWorkplaces.length, 1, 'architecture repair reuses one durable Workplace');\n    const architectureWorkplace = architectureWorkplaces[0];\n    assert.equal(architectureWorkplace.loop_state, 'terminal');\n    assert.equal(architectureWorkplace.terminal_reason, 'accepted');\n    const candidateCounts = resultDb.prepare(\n      \`SELECT role,COUNT(*) AS n FROM factory_candidate_sets\n        WHERE workplace_ref=? GROUP BY role\`,\n    ).all(architectureWorkplace.workplace_ref);\n    const candidateCount = role => candidateCounts.find(row => row.role === role)?.n ?? 0;\n    assert.ok(candidateCount('author') >= 2, 'architecture has original + repaired author CandidateSets');\n    assert.ok(candidateCount('reviewer') >= 2, 'architecture has rejecting + approving reviewer CandidateSets');\n    assert.ok(\n      resultDb.prepare(\n        \`SELECT COUNT(*) AS n FROM factory_gate_decisions\n          WHERE workplace_ref=? AND verdict='repair_required'\`,\n      ).get(architectureWorkplace.workplace_ref).n >= 1,\n      'architecture final gate records reviewer-proven repair_required',\n    );\n    resultDb.close();`,
    'golden path state assertions',
  );
  next = replaceOnce(
    next,
    `    assert.ok(runAInvocations.some(i => i.key?.module === 'solution-development@1.1.0'), 'Run A Development used scripted physical workers');`,
    `    assert.ok(runAInvocations.some(i => i.key?.module === 'solution-development@1.1.0'), 'Run A Development used scripted physical workers');\n    const architectureAuthorKey =\n      'solution-formalization@1.0.0/define-architecture-contract/author/singleton';\n    const architectureReviewerKey =\n      'solution-formalization@1.0.0/define-architecture-contract/reviewer/singleton';\n    assert.deepEqual(\n      runAInvocations.filter(i => i.keyStr === architectureAuthorKey).map(i => i.attempt),\n      [1, 2],\n      'author is physically invoked twice on the same semantic desk',\n    );\n    assert.deepEqual(\n      runAInvocations.filter(i => i.keyStr === architectureReviewerKey).map(i => i.attempt),\n      [1, 2],\n      'reviewer attempt identity survives worker-process replacement',\n    );`,
    'golden path invocation assertions',
  );
  return next;
});

patch('src/process-modules/application/node-executors/production-cell-node-executor.ts', source => {
  return replaceOnce(
    source,
    `  private attemptCount(ref: WorkplaceRef, role: 'author' | 'reviewer'): number {\n    // Count sealed CandidateSets for this role as the primary attempt counter.\n    // Each CandidateSet represents one completed gate-evaluated attempt.\n    const sealedAttempts = this.opts.candidateSetRepo.listForWorkplace(ref)\n      .filter(set => set.role === role).length;\n    // CGAD P18 / crash recovery: a crashed execution that never sealed a\n    // CandidateSet still counts as an attempt. The Workplace's revision\n    // reflects the number of transitions, which includes crash → repair_wait\n    // cycles. When there are NO sealed CandidateSets but the workplace has\n    // been through repair_wait, use the durable execution history to count\n    // failed attempts. This prevents infinite crash loops where the worker\n    // crashes before sealing, attemptCount stays 0, and maxAttempts is never\n    // reached.\n    // We use the higher of sealed attempts and the execution count from the\n    // workplace's lifecycle events (stored in worker_executions).\n    const state = this.opts.coordinator.readState(ref);\n    if (state && sealedAttempts === 0 && state.loopState === 'repair_wait') {\n      // Count terminal (failed/lost) executions for this workplace's task.\n      // The task's workplace_ref identifies all executions that attempted work.\n      const taskRow = this.opts.persistence.readTaskForWorkplace?.(ref);\n      if (taskRow) {\n        const failedExecs = this.opts.persistence.countTerminalExecutionsForTask?.(taskRow.taskId) ?? 0;\n        return Math.max(sealedAttempts, failedExecs);\n      }\n    }\n    return sealedAttempts;\n  }`,
    `  private attemptCount(ref: WorkplaceRef, role: 'author' | 'reviewer'): number {\n    // A role attempt ends either by sealing a CandidateSet or by terminating\n    // before a seal (lost/terminated/spawn_failed). Both consume the SAME\n    // bounded recovery budget. Counting crashes only while sealedAttempts===0\n    // makes the budget reset implicitly after the first successful candidate:\n    // a later repair worker could then crash forever without reaching\n    // onExhausted. Resolve the durable task for THIS role and add its failed\n    // physical executions to the sealed semantic attempts.\n    const sealedAttempts = this.opts.candidateSetRepo.listForWorkplace(ref)\n      .filter(set => set.role === role).length;\n    const roleTask = this.opts.persistence.readProjectedRoleTask?.(ref, role)\n      ?? (sealedAttempts === 0 ? this.opts.persistence.readTaskForWorkplace?.(ref) ?? null : null);\n    const failedExecutions = roleTask\n      ? this.opts.persistence.countTerminalExecutionsForTask?.(roleTask.taskId) ?? 0\n      : 0;\n    return sealedAttempts + failedExecutions;\n  }`,
    'production-cell bounded attempt counter',
  );
});

writeFileSync('tests/factory-contract/scenario-attempt-history.test.mjs', `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\nimport { scenarioAttemptNumber } from './scenario-engine.mjs';\n\ntest('scenario attempt identity survives physical worker replacement', () => {\n  const keyStr = 'solution-formalization@1.0.0/node/reviewer/singleton';\n  const prior = [\n    { keyStr, attempt: 1 },\n    { keyStr: 'other', attempt: 1 },\n  ];\n  assert.equal(scenarioAttemptNumber(prior, [], keyStr), 2);\n  assert.equal(scenarioAttemptNumber(prior, [{ keyStr, attempt: 2 }], keyStr), 3);\n});\n`, 'utf8');

writeFileSync('tests/factory-contract/workplace-two-role-theorem.test.mjs', `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\nimport { reduceWorkplaceEvent } from '../../dist/process-modules/domain/workplace/production-cell-reducer.js';\n\nfunction apply(state, event, expected) {\n  const next = reduceWorkplaceEvent(state, event);\n  assert.deepEqual(\n    { phase: next.kanbanPhase, loop: next.loopState, role: next.nextRole, terminal: next.terminalReason },\n    expected,\n  );\n  return next;\n}\n\ntest('one Workplace survives author -> reviewer defect -> author repair -> reviewer acceptance', () => {\n  let s = {\n    kanbanPhase: 'todo', loopState: 'idle', nextRole: 'author',\n    revision: 0, terminalReason: null,\n  };\n  s = apply(s, { kind: 'work-admitted' }, { phase: 'in_progress', loop: 'queued', role: 'author', terminal: null });\n  s = apply(s, { kind: 'worker-leased', reservationRef: 'author-1' }, { phase: 'in_progress', loop: 'leased', role: 'author', terminal: null });\n  s = apply(s, { kind: 'worker-started' }, { phase: 'in_progress', loop: 'running', role: 'author', terminal: null });\n  s = apply(s, { kind: 'candidate-sealed' }, { phase: 'in_progress', loop: 'verifying', role: 'author', terminal: null });\n  s = apply(s, { kind: 'gate-author-accepted-with-review' }, { phase: 'review', loop: 'queued', role: 'reviewer', terminal: null });\n  s = apply(s, { kind: 'worker-leased', reservationRef: 'review-1' }, { phase: 'review_in_progress', loop: 'leased', role: 'reviewer', terminal: null });\n  s = apply(s, { kind: 'worker-started' }, { phase: 'review_in_progress', loop: 'running', role: 'reviewer', terminal: null });\n  s = apply(s, { kind: 'candidate-sealed' }, { phase: 'review_in_progress', loop: 'verifying', role: 'reviewer', terminal: null });\n  s = apply(s, { kind: 'reviewer-verdict', verdict: 'defect-proven' }, { phase: 'in_progress', loop: 'repair_wait', role: 'author', terminal: null });\n  s = apply(s, { kind: 'repair-requeued', role: 'author' }, { phase: 'in_progress', loop: 'queued', role: 'author', terminal: null });\n  s = apply(s, { kind: 'worker-leased', reservationRef: 'author-2' }, { phase: 'in_progress', loop: 'leased', role: 'author', terminal: null });\n  s = apply(s, { kind: 'worker-started' }, { phase: 'in_progress', loop: 'running', role: 'author', terminal: null });\n  s = apply(s, { kind: 'candidate-sealed' }, { phase: 'in_progress', loop: 'verifying', role: 'author', terminal: null });\n  s = apply(s, { kind: 'gate-author-accepted-with-review' }, { phase: 'review', loop: 'queued', role: 'reviewer', terminal: null });\n  s = apply(s, { kind: 'worker-leased', reservationRef: 'review-2' }, { phase: 'review_in_progress', loop: 'leased', role: 'reviewer', terminal: null });\n  s = apply(s, { kind: 'worker-started' }, { phase: 'review_in_progress', loop: 'running', role: 'reviewer', terminal: null });\n  s = apply(s, { kind: 'candidate-sealed' }, { phase: 'review_in_progress', loop: 'verifying', role: 'reviewer', terminal: null });\n  s = apply(s, { kind: 'reviewer-verdict', verdict: 'accepted' }, { phase: 'done', loop: 'terminal', role: 'reviewer', terminal: 'accepted' });\n  assert.equal(s.revision, 17, 'the same aggregate revision advances across the full loop');\n});\n\ntest('technical crash stays in the same human phase and repair requeues the same role', () => {\n  let s = {\n    kanbanPhase: 'in_progress', loopState: 'running', nextRole: 'author',\n    revision: 10, terminalReason: null,\n  };\n  s = apply(s, { kind: 'worker-lost' }, { phase: 'in_progress', loop: 'repair_wait', role: 'author', terminal: null });\n  s = apply(s, { kind: 'repair-requeued', role: 'author' }, { phase: 'in_progress', loop: 'queued', role: 'author', terminal: null });\n  assert.equal(s.revision, 12);\n});\n\ntest('human-required is not an automatic retry state', () => {\n  const start = {\n    kanbanPhase: 'in_progress', loopState: 'repair_wait', nextRole: 'author',\n    revision: 4, terminalReason: null,\n  };\n  const paused = reduceWorkplaceEvent(start, { kind: 'human-required' });\n  assert.equal(paused.kanbanPhase, 'blocked');\n  assert.equal(paused.loopState, 'paused');\n});\n`, 'utf8');

writeFileSync('tests/factory-contract/attempt-budget-ratchet.test.mjs', `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\n\ntest('attempt budget counts role-specific crashes even after a sealed CandidateSet exists', () => {\n  const source = readFileSync(\n    new URL('../../src/process-modules/application/node-executors/production-cell-node-executor.ts', import.meta.url),\n    'utf8',\n  );\n  assert.match(source, /readProjectedRoleTask\\?\\.\\(ref, role\\)/);\n  assert.match(source, /sealedAttempts \\+ failedExecutions/);\n  assert.doesNotMatch(source, /sealedAttempts === 0 && state\\.loopState === 'repair_wait'/);\n});\n`, 'utf8');

console.log('factory transition audit patch applied');
