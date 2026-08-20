// tests/factory-proof/k0-baseline.test.mjs
//
// K0 acceptance: the baseline exists, is non-vacuous, and is machine-checked.
//
//   K0-A: every composition surface on disk is inventoried (and the
//         inventory names real files — a new surface is a deliberate act);
//   K0-B: normalizeTrace is semantic — equal traces digest equal across
//         timestamps/paths; ANY semantic mutation changes the digest
//         (observer non-vacuity, one mutation per evidence class);
//   K0-C: the recorded floors match the live registry counts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPOSITION_SURFACES,
  normalizeTrace,
  traceDigest,
  K0_FLOORS,
} from './k0-baseline.mjs';
import { ACCEPTANCE_OBLIGATION_CONTRACTS } from './obligation-contracts.mjs';
import { STRUCTURAL_OPERATORS, RELATIONAL_OPERATORS } from './mutation-algebra.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// K0-A — composition inventory.
// ---------------------------------------------------------------------------

test('K0-A: every Factory test-composition surface is inventoried and real', () => {
  for (const surface of COMPOSITION_SURFACES) {
    assert.ok(existsSync(path.join(REPO_ROOT, surface.path)),
      `${surface.id}: file missing — ${surface.path}`);
    assert.ok(surface.overrideSurface.length > 0, `${surface.id}: declare the override surface`);
  }
  // The canonical surface is exactly one entry pointing at factory-proof.
  const canonical = COMPOSITION_SURFACES.filter(s => s.status.startsWith('canonical'));
  assert.equal(canonical.length, 1, 'exactly ONE canonical composition surface');
  // The three legacy surfaces named by the migration map are all present.
  const legacy = COMPOSITION_SURFACES.filter(s => s.status.startsWith('migration debt'));
  assert.equal(legacy.length, 3, 'the three legacy surfaces stay inventoried until retired');
});

// ---------------------------------------------------------------------------
// K0-B — normalized trace: semantic equality + non-vacuity.
// ---------------------------------------------------------------------------

const SAMPLE_TRACE = {
  observedAt: '2026-08-21T00:00:00.000Z',
  lifecycleRuns: [{ id: 1, status: 'completed', current_stage_id: null, terminal_status: 'runnable-local', updated_at: '2026-08-21T01:00:00Z' }],
  workplaces: [
    { workplace_ref: 'workplace/1/product-discovery@3.0.2/discovery-proposal/singleton', kanban_phase: 'done', loop_state: 'terminal', revision: 4, updated_at: 'x' },
  ],
  gateDecisions: [
    { decision_key: 'decision:gate-run:abc', workplace_ref: 'workplace/1/product-discovery@3.0.2/discovery-proposal/singleton', gate_phase: 'final', verdict: 'accepted', decided_at: 'y' },
  ],
  transitionObligations: [
    { obligation_key: 'close-presentation:wp1', source_kind: 's', source_ref: 'factory_workplaces/workplace/1/product-discovery@3.0.2/discovery-proposal/singleton', handoff_kind: 'close-presentation', state: 'completed', last_error: null },
  ],
  effectReceipts: [{ effect_key: 'git-integration:wp1', effect_kind: 'git', state: 'completed' }],
};

test('K0-B: semantically equal traces digest equal (timestamps and local paths ignored)', () => {
  const a = structuredClone(SAMPLE_TRACE);
  const b = structuredClone(SAMPLE_TRACE);
  b.observedAt = '2027-12-31T23:59:59.000Z';
  b.lifecycleRuns[0].updated_at = 'totally-different-time';
  b.workplaces[0].updated_at = 'later';
  assert.equal(traceDigest(a), traceDigest(b));
});

test('K0-B non-vacuity: every evidence class mutation changes the digest', () => {
  const base = traceDigest(SAMPLE_TRACE);
  const mutations = {
    'lifecycle terminal status': t => { t.lifecycleRuns[0].terminal_status = 'failed'; },
    'workplace loop state': t => { t.workplaces[0].loop_state = 'repair_wait'; },
    'gate verdict': t => { t.gateDecisions[0].verdict = 'repair_required'; },
    'obligation state': t => { t.transitionObligations[0].state = 'pending'; },
    'effect receipt state': t => { t.effectReceipts[0].state = 'effect_pending'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const t = structuredClone(SAMPLE_TRACE);
    mutate(t);
    assert.notEqual(traceDigest(t), base, `mutating '${name}' MUST change the normalized digest`);
  }
});

// ---------------------------------------------------------------------------
// K0-C — floors match the live registries.
// ---------------------------------------------------------------------------

test('K0-C: the recorded floors match the live kernel registries', () => {
  assert.equal(ACCEPTANCE_OBLIGATION_CONTRACTS.length, K0_FLOORS.obligationContracts,
    'the obligation floor moved — update K0_FLOORS in the same commit');
  assert.equal(STRUCTURAL_OPERATORS.length, K0_FLOORS.mutationOperators.structural);
  assert.equal(RELATIONAL_OPERATORS.length, K0_FLOORS.mutationOperators.relational);
  // The blocking file set floor: the group's factory-proof files on disk.
  const proofTests = readdirSync(HERE).filter(f => f.endsWith('.test.mjs')).length;
  assert.ok(proofTests >= K0_FLOORS.blockingFactoryProofFiles,
    `factory-proof test files shrank below the floor (${proofTests} < ${K0_FLOORS.blockingFactoryProofFiles})`);
});
