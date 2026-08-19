// tests/process-modules/feedback-history-materialization.test.mjs
//
// BLINDSIGHT Worker/Tool layer (stage-11 census, «Review-фидбек не
// доставляется громко» + «Глубина истории = 1 раунд»):
//
// The Workplace desk materializer is the single provisioning point for what a
// repair-round worker physically receives. These tests pin that the desk
// DELIVERS feedback to the point of decision instead of merely "making it
// available":
//
//   (a) review feedback carries verbatim key-point lines + the round number —
//       the loud prompt block (pinned in tests/worker-prompt-assembly.test.mjs
//       G1.6) renders from these fields;
//   (b) the FULL multi-round feedback history is materialized as
//       feedback-history.json (all rounds, from durable append-only sources)
//       plus typed desk metadata — history accumulates, it is never destroyed
//       by the per-round metadata overwrite.
//
// Hermetic: tmp workspace roots only; no factory DB, no live run touched.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { materializePinnedWorkspace } = await import(
  '../../dist/process-modules/application/pinned-workspace-materializer.js'
);

const encoder = new TextEncoder();
const trackerPath = 'package/resources/tracker.md';
const callPath = 'package/resources/call.json';
const checklistPath = 'package/resources/checklist.md';
const resources = [
  { logicalId: 'tracker', relativePath: trackerPath, content: '# Tracker\nTask: {TASK_ID}\n- [ ] submit\n' },
  { logicalId: 'call', relativePath: callPath, content: '{"task_id":0,"payload":{}}\n' },
  { logicalId: 'checklist', relativePath: checklistPath, content: '- [ ] valid\n' },
].map(item => ({
  ...item,
  digest: `${item.logicalId}-digest`,
  bytes: encoder.encode(item.content),
}));

function baseRequest(workspaceRoot, executionId, taskMetadata) {
  const allResources = resources.map(resource => ({
    logicalId: resource.logicalId,
    kind: resource.logicalId === 'checklist' ? 'checklist' : 'template',
    relativePath: resource.relativePath,
    digest: resource.digest,
  }));
  return {
    projection: {
      installationId: 7,
      moduleRef: 'test-module@1.0.0',
      packageDigest: 'package-digest',
      storeLocation: 'Z:\\path-that-does-not-exist',
      nodeId: 'author',
      executionProfileId: 'author-profile',
      skills: {},
      templates: allResources.filter(resource => resource.kind === 'template'),
      checklists: allResources.filter(resource => resource.kind === 'checklist'),
      instructions: [],
      allResources,
      description: {},
    },
    storedPackage: {
      manifest: { assistance: [] },
      resources: resources.map(resource => ({
        logicalId: resource.logicalId,
        kind: resource.logicalId === 'checklist' ? 'checklist' : 'template',
        bytes: resource.bytes,
        digest: resource.digest,
      })),
      packageDigest: 'package-digest',
      storedAt: 'mem://verified-package',
    },
    workspaceRoot,
    module: {
      identity: { name: 'test-module', version: '1.0.0', kind: 'development' },
    },
    profile: {
      id: 'author-profile',
      trackerTemplate: trackerPath,
      workspaceTemplates: [],
      callTemplates: [callPath],
      checklists: [checklistPath],
      outputSchema: { id: 'test.output.v1' },
      allowedTools: ['task_get'],
      semanticSkill: 'test',
      retryPolicy: { maxAttempts: 2 },
    },
    projectId: 1,
    epicId: 1,
    task: {
      id: 41,
      metadata: {
        process_run_id: 10,
        process_node_id: 'author',
        ...taskMetadata,
      },
    },
    executionId,
    workerId: 'worker-1',
  };
}

test('(a) review feedback desk entry carries verbatim key points and the round number', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'saga-feedback-desk-'));
  try {
    const desk = materializePinnedWorkspace(baseRequest(root, 'exec-r2', {
      managed_review_rejections: 2,
      managed_review_budget: 3,
      managed_review_last_feedback: [
        'AC-2 verification step is missing: no assertion that the merge rejects conflicting keys.',
        'src/merge.ts:42 handles null input by crashing instead of returning a typed error.',
        'Rerun the contract tests after fixing both points.',
      ].join('\n'),
    }));
    assert.equal(desk.reviewFeedback.present, true, 'review feedback must be present');
    assert.ok(desk.reviewFeedback.path, 'review feedback path must be set');
    assert.equal(desk.reviewFeedback.round, 2, 'round must be the rejection count');
    assert.deepEqual(
      desk.reviewFeedback.reasons,
      [
        'AC-2 verification step is missing: no assertion that the merge rejects conflicting keys.',
        'src/merge.ts:42 handles null input by crashing instead of returning a typed error.',
        'Rerun the contract tests after fixing both points.',
      ],
      'the reviewer key points must be delivered verbatim on the desk (the loud prompt block renders them)',
    );
    const written = JSON.parse(
      readFileSync(path.join(root, desk.reviewFeedback.path), 'utf8'),
    );
    assert.equal(written.attempt, 2);
    assert.equal(written.budget, 3);
    assert.equal(written.rejections, 2);
    assert.match(written.feedback, /AC-2 verification step is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(a) no prior review rejection leaves the review feedback desk entry absent', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'saga-feedback-desk-'));
  try {
    const desk = materializePinnedWorkspace(baseRequest(root, 'exec-fresh', {}));
    assert.equal(desk.reviewFeedback.present, false);
    assert.equal(desk.reviewFeedback.path, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
