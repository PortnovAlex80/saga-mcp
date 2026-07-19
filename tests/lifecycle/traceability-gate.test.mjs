// Tests for the assertTraceability gate (formalization→planning transition).
//
// Verifies the canonical lineage edges are required:
//   PRD → brief (derived_from)
//   SRS → PRD (derived_from)
//   UC  → PRD (derived_from) + UC → FR (covers)
//   AC  → UC (derived_from) + AC → FR/NFR (derived_from)
//
// The gate runs AFTER assertTasksReady and BEFORE acceptedBaseline in
// src/tools/lifecycle.ts handleEpisodeTransition (formalization→planning).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-traceability-'));
process.env.DB_PATH = path.join(temp, 'traceability.db');

const { handlers: projects } = await import('../../dist/tools/projects.js');
const { handlers: epics } = await import('../../dist/tools/epics.js');
const { handlers: tasks } = await import('../../dist/tools/tasks.js');
const { handlers: artifacts } = await import('../../dist/tools/artifacts.js');
const { handlers: lifecycle } = await import('../../dist/tools/lifecycle.js');
const { closeDb, getDb } = await import('../../dist/db.js');

let product;

before(() => {
  product = projects.project_create({ name: 'Traceability Gate Tests' });
});

after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

function makeEpic() {
  const epic = epics.epic_create({ project_id: product.id, name: `REQ-${Date.now()}-${Math.random().toString(36).slice(2,6)}` }).id;
  lifecycle.episode_transition({ epic_id: epic, to_stage: 'formalization' });
  return epic;
}

function makeDoneFormalizationTask(epic) {
  // Seed a done formalization.prd so assertTasksReady('formalization') passes.
  // Otherwise the gate fails on task-readiness before reaching assertTraceability.
  return tasks.task_create({
    epic_id: epic, title: 'PRD', status: 'done', priority: 'high',
    task_kind: 'formalization.prd', workflow_stage: 'formalization',
    execution_skill: 'saga-product', review_skill: 'saga-requirements-reviewer',
    execution_mode: 'tracker_only',
  });
}

// Helper: build a complete, well-formed formalization pyramid for one epic.
// Returns the artifact IDs so individual tests can selectively delete edges.
function buildCompletePyramid(epic) {
  // brief artifact requires brief_payload per validators/brief.ts. Use a
  // minimal valid shape so artifact_create doesn't reject it. (We are NOT
  // running kickstart here — just seeding the artifact row for trace tests.)
  const brief = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'brief', code: 'BRIEF-1',
    title: 'Brief', path: `docs/brief-${epic}.md`, status: 'accepted',
    metadata: {
      brief_payload: {
        classification: 'tech-task',
        complexity: { tshirt: 'S', risk_triggers: [] },
        decision: 'go',
        reasoning: 'test fixture',
        affected_projects: [product.id],
        topology_hint: 'sequence',
        scaffold_artifacts: [],
        shared_mutation_risk: false,
        completeness: 'high',
        degraded: false,
      },
    },
  });
  const prd = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'PRD', code: null,
    title: 'PRD', path: `docs/prd-${epic}.md`, status: 'accepted',
    parent_artifact_id: brief.id,
  });
  artifacts.trace_add({ source_id: prd.id, target_type: 'artifact', target_id: brief.id, link_type: 'derived_from' });

  const srs = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'SRS', code: 'SRS-1',
    title: 'SRS', path: `docs/srs-${epic}.md`, status: 'accepted',
    parent_artifact_id: prd.id,
  });
  artifacts.trace_add({ source_id: srs.id, target_type: 'artifact', target_id: prd.id, link_type: 'derived_from' });

  const fr = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'FR', code: 'FR-1',
    title: 'FR', path: `docs/srs-${epic}.md#FR-1`, status: 'accepted',
    parent_artifact_id: prd.id,
  });
  artifacts.trace_add({ source_id: fr.id, target_type: 'artifact', target_id: prd.id, link_type: 'derived_from' });

  const uc = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'UC', code: 'UC-1',
    title: 'UC', path: `docs/uc-${epic}.md#UC-1`, status: 'accepted',
    parent_artifact_id: prd.id,
  });
  artifacts.trace_add({ source_id: uc.id, target_type: 'artifact', target_id: prd.id, link_type: 'derived_from' });
  artifacts.trace_add({ source_id: uc.id, target_type: 'artifact', target_id: fr.id, link_type: 'covers' });

  const ac = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'AC', code: 'AC-1',
    title: 'AC', path: `docs/ac-${epic}.md#AC-1`, status: 'accepted',
  });
  artifacts.trace_add({ source_id: ac.id, target_type: 'artifact', target_id: uc.id, link_type: 'derived_from' });
  artifacts.trace_add({ source_id: ac.id, target_type: 'artifact', target_id: fr.id, link_type: 'derived_from' });

  // Pin content_hash = accepted_hash so acceptedBaseline passes.
  const db = getDb();
  const hash = 'a'.repeat(64);
  for (const id of [ac.id]) {
    db.prepare(`UPDATE artifacts SET content_hash=?, accepted_hash=?, drift_state='clean' WHERE id=?`).run(hash, hash, id);
  }

  return { brief, prd, srs, fr, uc, ac };
}

// Remove all traces of given link_type from a given source artifact.
function removeTraces(srcId, linkType) {
  getDb().prepare(`DELETE FROM artifact_traces WHERE source_id=? AND link_type=?`).run(srcId, linkType);
}

// ---------------------------------------------------------------------------
// Test 1: gate passes when all canonical lineage edges exist.
// ---------------------------------------------------------------------------

test('traceability gate: passes with complete pyramid', () => {
  const epic = makeEpic();
  makeDoneFormalizationTask(epic);
  buildCompletePyramid(epic);
  assert.doesNotThrow(
    () => lifecycle.episode_transition({ epic_id: epic, to_stage: 'planning' }),
    'gate must pass when PRD/SRS/UC/AC all have correct lineage edges',
  );
});

// ---------------------------------------------------------------------------
// Test 2: gate fails when PRD missing derived_from → brief.
// ---------------------------------------------------------------------------

test('traceability gate: fails when PRD has no derived_from → brief', () => {
  const epic = makeEpic();
  makeDoneFormalizationTask(epic);
  const { prd } = buildCompletePyramid(epic);
  removeTraces(prd.id, 'derived_from'); // breaks PRD → brief

  assert.throws(
    () => lifecycle.episode_transition({ epic_id: epic, to_stage: 'planning' }),
    /PRD .* has no outgoing 'derived_from' trace to a brief/i,
    'gate must reject PRD without derived_from → brief',
  );
});

// ---------------------------------------------------------------------------
// Test 3: gate fails when SRS missing derived_from → PRD.
// ---------------------------------------------------------------------------

test('traceability gate: fails when SRS has no derived_from → PRD', () => {
  const epic = makeEpic();
  makeDoneFormalizationTask(epic);
  const { srs } = buildCompletePyramid(epic);
  removeTraces(srs.id, 'derived_from'); // breaks SRS → PRD

  assert.throws(
    () => lifecycle.episode_transition({ epic_id: epic, to_stage: 'planning' }),
    /SRS .* has no outgoing 'derived_from' trace to PRD/i,
    'gate must reject SRS without derived_from → PRD',
  );
});

// ---------------------------------------------------------------------------
// Test 4: gate fails when UC missing derived_from → PRD.
// ---------------------------------------------------------------------------

test('traceability gate: fails when UC has no derived_from → PRD', () => {
  const epic = makeEpic();
  makeDoneFormalizationTask(epic);
  const { uc } = buildCompletePyramid(epic);
  // Remove only UC → PRD derived_from, keep UC → FR covers.
  getDb().prepare(
    `DELETE FROM artifact_traces WHERE source_id=? AND link_type='derived_from' AND target_id IN (
       SELECT id FROM artifacts WHERE type='PRD'
     )`,
  ).run(uc.id);

  assert.throws(
    () => lifecycle.episode_transition({ epic_id: epic, to_stage: 'planning' }),
    /UC .* has no 'derived_from' trace to PRD/i,
    'gate must reject UC without derived_from → PRD',
  );
});

// ---------------------------------------------------------------------------
// Test 5: gate fails when UC has derived_from → PRD but no covers → FR.
// ---------------------------------------------------------------------------

test('traceability gate: fails when UC has no covers → FR', () => {
  const epic = makeEpic();
  makeDoneFormalizationTask(epic);
  const { uc } = buildCompletePyramid(epic);
  removeTraces(uc.id, 'covers'); // breaks UC → FR

  assert.throws(
    () => lifecycle.episode_transition({ epic_id: epic, to_stage: 'planning' }),
    /UC .* has no 'covers' trace to any FR/i,
    'gate must reject UC without covers → FR',
  );
});

// ---------------------------------------------------------------------------
// Test 6: gate fails when AC traces to FR but not to UC.
// (FR-derived ACs MUST have a UC trace — the behavioural scenario.)
// ---------------------------------------------------------------------------

test('traceability gate: fails when AC has FR but no UC trace', () => {
  const epic = makeEpic();
  makeDoneFormalizationTask(epic);
  const { ac } = buildCompletePyramid(epic);
  // Remove only AC → UC derived_from, keep AC → FR.
  getDb().prepare(
    `DELETE FROM artifact_traces WHERE source_id=? AND link_type='derived_from' AND target_id IN (
       SELECT id FROM artifacts WHERE type='UC'
     )`,
  ).run(ac.id);

  assert.throws(
    () => lifecycle.episode_transition({ epic_id: epic, to_stage: 'planning' }),
    /AC .* traces to FR but has no 'derived_from' trace to any UC/i,
    'gate must reject FR-derived AC without UC trace',
  );
});

// ---------------------------------------------------------------------------
// Test 6b: gate ACCEPTS NFR-only AC without UC trace.
// (Cross-cutting ACs like performance/security/code-quality do not map to UC.)
// ---------------------------------------------------------------------------

test('traceability gate: accepts NFR-only AC without UC trace', () => {
  const epic = makeEpic();
  makeDoneFormalizationTask(epic);
  const { prd, uc } = buildCompletePyramid(epic);
  // Add an NFR + an AC that traces to NFR only (no UC, no FR).
  const nfr = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'NFR', code: 'NFR-1',
    title: 'NFR', path: `docs/srs-${epic}.md#NFR-1`, status: 'accepted',
    parent_artifact_id: prd.id,
  });
  artifacts.trace_add({ source_id: nfr.id, target_type: 'artifact', target_id: prd.id, link_type: 'derived_from' });
  const acNfrOnly = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'AC', code: 'AC-NFR-ONLY',
    title: 'AC for NFR only', path: `docs/ac-${epic}.md#AC-NFR-ONLY`, status: 'accepted',
  });
  // Trace ONLY to NFR — no UC trace, no FR trace.
  artifacts.trace_add({ source_id: acNfrOnly.id, target_type: 'artifact', target_id: nfr.id, link_type: 'derived_from' });
  // Pin hash so acceptedBaseline passes.
  const db = getDb();
  const hash = 'c'.repeat(64);
  db.prepare(`UPDATE artifacts SET content_hash=?, accepted_hash=?, drift_state='clean' WHERE id=?`).run(hash, hash, acNfrOnly.id);
  // Suppress unused warning.
  void uc;

  assert.doesNotThrow(
    () => lifecycle.episode_transition({ epic_id: epic, to_stage: 'planning' }),
    'gate must accept NFR-only AC without UC trace (cross-cutting ACs are exempt)',
  );
});

// ---------------------------------------------------------------------------
// Test 7: gate fails when AC has derived_from → UC but no FR/NFR.
// ---------------------------------------------------------------------------

test('traceability gate: fails when AC has no derived_from → FR/NFR', () => {
  const epic = makeEpic();
  makeDoneFormalizationTask(epic);
  const { ac } = buildCompletePyramid(epic);
  // Remove only AC → FR derived_from, keep AC → UC.
  getDb().prepare(
    `DELETE FROM artifact_traces WHERE source_id=? AND link_type='derived_from' AND target_id IN (
       SELECT id FROM artifacts WHERE type IN ('FR','NFR')
     )`,
  ).run(ac.id);

  assert.throws(
    () => lifecycle.episode_transition({ epic_id: epic, to_stage: 'planning' }),
    /AC .* has no 'derived_from' trace to any FR or NFR/i,
    'gate must reject AC without derived_from → FR/NFR',
  );
});

// ---------------------------------------------------------------------------
// Test 8: gate allows NFR-only ACs (alternative to FR).
// ---------------------------------------------------------------------------

test('traceability gate: accepts AC derived_from NFR (no FR needed)', () => {
  const epic = makeEpic();
  makeDoneFormalizationTask(epic);
  const { brief, prd, srs, uc } = buildCompletePyramid(epic);

  // Add an NFR.
  const nfr = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'NFR', code: 'NFR-1',
    title: 'NFR', path: `docs/srs-${epic}.md#NFR-1`, status: 'accepted',
    parent_artifact_id: prd.id,
  });
  artifacts.trace_add({ source_id: nfr.id, target_type: 'artifact', target_id: prd.id, link_type: 'derived_from' });

  // Add an AC that traces to UC + NFR (but not FR).
  const acNfr = artifacts.artifact_create({
    project_id: product.id, epic_id: epic, type: 'AC', code: 'AC-NFR',
    title: 'AC for NFR', path: `docs/ac-${epic}.md#AC-NFR`, status: 'accepted',
  });
  artifacts.trace_add({ source_id: acNfr.id, target_type: 'artifact', target_id: uc.id, link_type: 'derived_from' });
  artifacts.trace_add({ source_id: acNfr.id, target_type: 'artifact', target_id: nfr.id, link_type: 'derived_from' });

  // Pin hash.
  const db = getDb();
  const hash = 'b'.repeat(64);
  db.prepare(`UPDATE artifacts SET content_hash=?, accepted_hash=?, drift_state='clean' WHERE id=?`).run(hash, hash, acNfr.id);

  assert.doesNotThrow(
    () => lifecycle.episode_transition({ epic_id: epic, to_stage: 'planning' }),
    'gate must accept AC with derived_from → UC + NFR (no FR required)',
  );
});

// ---------------------------------------------------------------------------
// Test 9: gate reports the FIRST gap only (clear error vs wall of text).
// ---------------------------------------------------------------------------

test('traceability gate: reports first gap only', () => {
  const epic = makeEpic();
  makeDoneFormalizationTask(epic);
  // Build pyramid, then break BOTH PRD→brief and SRS→PRD. Error must
  // mention PRD (first checked), not both.
  const { prd, srs } = buildCompletePyramid(epic);
  removeTraces(prd.id, 'derived_from');
  removeTraces(srs.id, 'derived_from');

  assert.throws(
    () => lifecycle.episode_transition({ epic_id: epic, to_stage: 'planning' }),
    /PRD .* has no outgoing 'derived_from' trace to a brief/i,
    'gate must report PRD gap first (PRD is checked before SRS)',
  );
});
