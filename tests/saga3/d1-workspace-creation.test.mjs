/**
 * D1 — Saga 3 Discovery workspace creation regression test.
 *
 * Guards ensureDiscoveryWorkspace (src/saga3/application/ensure-discovery-workspace.ts).
 *
 * Regression context: ensureDiscoveryWorkspace existed as engine code in
 * commit 1efb086, was DELETED in 12952be (templates became static), and the
 * deletion went uncaught because NO test covered workspace creation. Epic 33
 * later exposed the consequence: the docs/discovery/tools/ folder drifted out
 * of sync (missing stage-tracker.md), and the per-epic stage tracker had to
 * be seeded by hand. This test prevents that regression from recurring.
 *
 * The function under test is pure: it reads tool-templates/discovery/* from
 * the given workspaceRoot and writes docs/discovery/projects/<epicId>/* into it. No DB, no LM.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { ensureDiscoveryWorkspace } = await import(
  '../../dist/saga3/application/ensure-discovery-workspace.js'
);

/**
 * Build a minimal but realistic tool-templates/discovery/ in a temp dir so the
 * test mirrors what a real repo has committed. Mirrors the actual file set in
 * tool-templates/discovery/.
 */
function seedToolTemplates(root) {
  const tmplDir = path.join(root, 'tool-templates', 'discovery');
  mkdirSync(tmplDir, { recursive: true });

  writeFileSync(
    path.join(tmplDir, 'stage-tracker.md'),
    [
      '# Discovery Stage Tracker — Project {PROJECT_ID}',
      '',
      '## Collected Values',
      '- task_id: {TASK_ID}',
      '- epic_id: {EPIC_ID}',
      '- intent_id: {FILL_FROM_TASK_GET_METADATA_WORK_INTENT_ID}',
      '',
      '## Steps',
      '- [ ] 1. task_get({ id: {TASK_ID} })',
      '',
      '## Current Step: 1',
      '',
    ].join('\n'),
  );

  writeFileSync(
    path.join(tmplDir, 'proposal-call-template.json'),
    JSON.stringify(
      {
        intent_id: 'FILL_INTEGER_FROM_TASK_GET_METADATA_WORK_INTENT_ID',
        task_id: 'FILL_INTEGER_YOUR_TASK_ID',
        execution_id: 'FILL_STRING_YOUR_EXECUTION_ID',
        kind: 'discovery',
        schema_version: 'saga3.discovery-proposal.v1',
        payload: { problem_statement: 'FILL_FROM_DISCOVERY_DOC' },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    path.join(tmplDir, 'proposal-checklist.md'),
    '# Proposal Submit Checklist\n- [ ] intent_id is integer\n',
  );

  writeFileSync(
    path.join(tmplDir, 'readiness-call-template.json'),
    JSON.stringify({
      control_intent_id: 'FILL_INTEGER_FROM_READINESS_GET',
      schema_version: 'saga3.discovery-readiness-assessment.v1',
      payload: {},
    }),
  );

  writeFileSync(
    path.join(tmplDir, 'diagnosis-call-template.json'),
    JSON.stringify({
      control_intent_id: 'FILL_INTEGER_FROM_DIAGNOSIS_GET',
      schema_version: 'saga3.discovery-diagnosis.v1',
      payload: { target: {} },
    }),
  );

  writeFileSync(
    path.join(tmplDir, 'normalization-call-template.json'),
    JSON.stringify({
      control_intent_id: 'FILL_INTEGER_FROM_TASK_GET',
      source_submission_id: 'FILL_INTEGER_FROM_TASK_GET',
      schema_version: 'saga3.discovery-normalization-proposal.v1',
      payload: {},
    }),
  );

  return tmplDir;
}

test('D1 workspace: copies ALL templates into docs/discovery/tools/', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga3-ws-'));
  try {
    seedToolTemplates(root);
    const result = ensureDiscoveryWorkspace({
      workspaceRoot: root, epicId: 42, projectId: 7, taskId: 999, intentId: 1234,
    });

    // Every template except stage-tracker.md is copied verbatim into tools/.
    const toolsDir = path.join(root, 'docs', 'discovery', 'tools');
    assert.ok(existsSync(path.join(toolsDir, 'proposal-call-template.json')));
    assert.ok(existsSync(path.join(toolsDir, 'proposal-checklist.md')));
    assert.ok(existsSync(path.join(toolsDir, 'readiness-call-template.json')));
    assert.ok(existsSync(path.join(toolsDir, 'diagnosis-call-template.json')));
    assert.ok(existsSync(path.join(toolsDir, 'normalization-call-template.json')));
    // stage-tracker.md is intentionally NOT copied into tools/ (consumed below).
    assert.ok(!existsSync(path.join(toolsDir, 'stage-tracker.md')),
      'stage-tracker.md must NOT be in tools/ — it is consumed as the source for the per-epic tracker');

    assert.deepEqual(result.toolsCopied.sort(), [
      'diagnosis-call-template.json',
      'normalization-call-template.json',
      'proposal-call-template.json',
      'proposal-checklist.md',
      'readiness-call-template.json',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D1 workspace: creates per-epic stage tracker with PROJECT_ID/EPIC_ID/TASK_ID/intent_id substituted', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga3-ws-'));
  try {
    seedToolTemplates(root);
    ensureDiscoveryWorkspace({
      workspaceRoot: root, epicId: 42, projectId: 7, taskId: 999, intentId: 1234,
    });

    const trackerPath = path.join(root, 'docs', 'discovery', 'projects', '42', 'project-42-discovery-stage.md');
    assert.ok(existsSync(trackerPath), 'per-epic tracker must be created');
    const content = readFileSync(trackerPath, 'utf8');
    assert.match(content, /Project 7/, 'PROJECT_ID substituted');
    assert.match(content, /task_id: 999/, 'TASK_ID substituted');
    assert.match(content, /epic_id: 42/, 'EPIC_ID substituted');
    assert.match(content, /intent_id: 1234/, 'intent_id substituted (hint from engine)');
    // No placeholders remain for the bound values.
    assert.doesNotMatch(content, /\{PROJECT_ID\}|\{EPIC_ID\}|\{TASK_ID\}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D1 workspace: creates per-epic proposal-call JSON with intent_id/task_id pre-bound', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga3-ws-'));
  try {
    seedToolTemplates(root);
    ensureDiscoveryWorkspace({
      workspaceRoot: root, epicId: 42, projectId: 7, taskId: 999, intentId: 1234,
    });

    const proposalPath = path.join(root, 'docs', 'discovery', 'projects', '42', 'proposal-call-42.json');
    assert.ok(existsSync(proposalPath), 'per-epic proposal-call JSON must be created');
    const parsed = JSON.parse(readFileSync(proposalPath, 'utf8'));
    assert.equal(parsed.intent_id, 1234, 'intent_id pre-bound as bare integer');
    assert.equal(parsed.task_id, 999, 'task_id pre-bound as bare integer');
    assert.equal(parsed.schema_version, 'saga3.discovery-proposal.v1');
    // execution_id is NOT engine-known at workspace-seed time (it is assigned
    // when the worker is spawned); it must remain a FILL_ placeholder.
    assert.match(parsed.execution_id, /FILL_/, 'execution_id stays as FILL_ (assigned at spawn)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D1 workspace: idempotent — second call does NOT overwrite existing files', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga3-ws-'));
  try {
    seedToolTemplates(root);
    const first = ensureDiscoveryWorkspace({
      workspaceRoot: root, epicId: 42, projectId: 7, taskId: 999, intentId: 1234,
    });
    assert.equal(first.trackerCreated, true);
    assert.equal(first.proposalCallCreated, true);
    assert.equal(first.toolsCopied.length, 5);

    // Mutate the created files to prove the second call does not overwrite.
    const trackerPath = path.join(root, 'docs', 'discovery', 'projects', '42', 'project-42-discovery-stage.md');
    writeFileSync(trackerPath, 'WORKER_EDITED_THIS');

    const second = ensureDiscoveryWorkspace({
      workspaceRoot: root, epicId: 42, projectId: 7, taskId: 999, intentId: 1234,
    });
    assert.equal(second.trackerCreated, false, 'tracker NOT recreated');
    assert.equal(second.proposalCallCreated, false, 'proposal-call NOT recreated');
    assert.equal(second.toolsCopied.length, 0, 'tools NOT recopied');
    assert.equal(second.toolsSkipped.length, 5, 'tools recognized as existing');

    // The worker's edit survived.
    assert.equal(readFileSync(trackerPath, 'utf8'), 'WORKER_EDITED_THIS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D1 workspace: gracefully handles missing tool-templates dir', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga3-ws-'));
  try {
    // No tool-templates/ seeded.
    const result = ensureDiscoveryWorkspace({
      workspaceRoot: root, epicId: 1, projectId: 1, taskId: 1, intentId: 1,
    });
    assert.equal(result.templatesDirMissing, true);
    assert.equal(result.toolsCopied.length, 0);
    assert.equal(result.trackerCreated, false);
    assert.equal(result.proposalCallCreated, false);
    // No docs/discovery created either (function returned early).
    assert.ok(!existsSync(path.join(root, 'docs', 'discovery')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D1 workspace: different epics get independent trackers and proposal-call files', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga3-ws-'));
  try {
    seedToolTemplates(root);
    ensureDiscoveryWorkspace({
      workspaceRoot: root, epicId: 10, projectId: 1, taskId: 100, intentId: 1000,
    });
    ensureDiscoveryWorkspace({
      workspaceRoot: root, epicId: 11, projectId: 1, taskId: 101, intentId: 1001,
    });

    const t10 = path.join(root, 'docs', 'discovery', 'projects', '10', 'project-10-discovery-stage.md');
    const t11 = path.join(root, 'docs', 'discovery', 'projects', '11', 'project-11-discovery-stage.md');
    const p10 = path.join(root, 'docs', 'discovery', 'projects', '10', 'proposal-call-10.json');
    const p11 = path.join(root, 'docs', 'discovery', 'projects', '11', 'proposal-call-11.json');

    assert.ok(existsSync(t10) && existsSync(t11));
    assert.ok(existsSync(p10) && existsSync(p11));

    assert.match(readFileSync(t10, 'utf8'), /epic_id: 10/);
    assert.match(readFileSync(t11, 'utf8'), /epic_id: 11/);
    assert.equal(JSON.parse(readFileSync(p10, 'utf8')).task_id, 100);
    assert.equal(JSON.parse(readFileSync(p11, 'utf8')).task_id, 101);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
