#!/usr/bin/env node
// WP-13C — builds the MINIMAL synthetic elite-evidence-kit source fixture.
//
// tools/elite-evidence-kit/extract.mjs (WP-13D) currently proves its
// determinism against operator-machine run roots under D:/Development — CI
// must NOT depend on those. This builder produces the smallest source shape
// the extractor actually reads: every table its 38 queries touch (each with
// the columns it accesses and orders by), a deterministic journal, a product
// repo with a read-only resolvable .git/HEAD, and one sharded package-store
// entry. Deterministic content only — fixed strings, fixed digests, no
// timestamps, no randomness — so rebuilding yields the same extractor input.
//
//   node tests/infrastructure/ek-fixtures/build-elite-smoke-fixture.mjs
//     [--out tests/infrastructure/ek-fixtures/elite-smoke]  (default)
//
// The committed fixture (tests/infrastructure/ek-fixtures/elite-smoke/) is
// the builder's output; regenerate and commit if the extractor's source
// contract changes. The CI determinism smoke lives in
// tests/infrastructure/ek-evidence-kit-determinism.test.mjs.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = path.resolve(outIdx >= 0 ? argv[outIdx + 1]
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'elite-smoke'));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ── the deterministic corpus (fixed content — no clock, no randomness) ──────
const H = (c) => c.repeat(64).slice(0, 64); // fixed pseudo-digests
const PKG_DIGEST = H('a');
const WORKPLACE_REF = 'workplace/run-1/development/production-cell-1/work-item-1';
const STORE_REL = `package-store/${PKG_DIGEST.slice(0, 2)}/${PKG_DIGEST.slice(2, 4)}/${PKG_DIGEST}`;

// ── factory.sqlite: every table extract.mjs queries, with the columns it
//    reads and orders by (SQLite dynamic columns; extra columns are inert) ──
const db = new Database(path.join(OUT, 'factory.sqlite'));
const TABLES = [
  ['factory_lifecycle_runs', 'id INTEGER PRIMARY KEY, terminal_status TEXT'],
  ['factory_stage_runs', 'id INTEGER PRIMARY KEY, lifecycle_run_id INTEGER, ordinal INTEGER, stage_id TEXT, module_ref_key TEXT, status TEXT, local_outcome TEXT, authority TEXT, process_run_id INTEGER'],
  ['factory_process_runs', 'id INTEGER PRIMARY KEY'],
  ['factory_process_transitions', 'id INTEGER PRIMARY KEY'],
  ['factory_run_terminal_event_receipts', 'id INTEGER PRIMARY KEY, lifecycle_run_id INTEGER'],
  ['factory_process_outcome_certificates', 'id INTEGER PRIMARY KEY, process_run_id INTEGER, decision TEXT, reason_codes TEXT, rationale TEXT'],
  ['factory_module_installations', 'id INTEGER PRIMARY KEY, name TEXT, version TEXT, package_digest TEXT, status TEXT, store_location TEXT'],
  ['factory_workplaces', 'workplace_ref TEXT PRIMARY KEY, loop_state TEXT, terminal_reason TEXT'],
  ['factory_gate_decisions', 'decision_key TEXT PRIMARY KEY, decided_at TEXT, gate_phase TEXT, verdict TEXT, workplace_ref TEXT, gate_run_ref TEXT, repair_target_role TEXT'],
  ['factory_gate_runs', 'gate_run_ref TEXT PRIMARY KEY, workplace_ref TEXT, check_plan_ref TEXT'],
  ['factory_check_receipts', 'check_receipt_ref TEXT PRIMARY KEY, created_at TEXT, check_run_ref TEXT, outcome TEXT, provider_id TEXT, provider_version TEXT, evidence_refs TEXT'],
  ['factory_transition_obligations', 'obligation_key TEXT PRIMARY KEY, state TEXT'],
  ['factory_candidate_sets', 'candidate_set_ref TEXT PRIMARY KEY, workplace_ref TEXT, sealed_at TEXT'],
  ['factory_candidate_set_members', 'candidate_set_ref TEXT, ordinal INTEGER, PRIMARY KEY (candidate_set_ref, ordinal)'],
  ['factory_workplace_production_revisions', 'revision_ref TEXT PRIMARY KEY'],
  ['factory_sealed_product_materials', 'schema_id TEXT, content_digest TEXT, payload_snapshot TEXT, payload_hash TEXT, PRIMARY KEY (schema_id, content_digest)'],
  ['factory_effect_attempts', 'attempt_ref TEXT PRIMARY KEY'],
  ['factory_cell_effect_receipts', 'effect_receipt_ref TEXT PRIMARY KEY'],
  ['factory_external_effect_actions', 'id INTEGER PRIMARY KEY'],
  ['factory_external_effect_events', 'id INTEGER PRIMARY KEY, action_id INTEGER, sequence INTEGER'],
  ['tasks', 'id INTEGER PRIMARY KEY, task_kind TEXT, status TEXT'],
  ['worker_executions', 'execution_id TEXT PRIMARY KEY, task_id INTEGER, state TEXT, last_error TEXT'],
  ['command_receipts', 'command_id TEXT PRIMARY KEY, accepted_at TEXT'],
  ['artifacts', 'id INTEGER PRIMARY KEY, type TEXT, code TEXT, title TEXT, status TEXT, storage_kind TEXT, path TEXT, content_hash TEXT, drift_state TEXT'],
  ['artifact_traces', 'id INTEGER PRIMARY KEY, source_id INTEGER, target_type TEXT, target_id TEXT, link_type TEXT'],
  ['factory_node_runs', 'id INTEGER PRIMARY KEY, process_run_id INTEGER'],
  ['factory_work_intents', 'id INTEGER PRIMARY KEY'],
  ['factory_orders', 'order_ref TEXT PRIMARY KEY'],
  ['projects', 'id INTEGER PRIMARY KEY'],
  ['repositories', 'id INTEGER PRIMARY KEY'],
  ['project_repositories', 'id INTEGER PRIMARY KEY'],
  ['trusted_providers', 'id INTEGER PRIMARY KEY, category TEXT, name TEXT, trust_basis TEXT, determinism INTEGER, scope TEXT, version TEXT'],
  ['factory_formalization_solution_contracts', 'id INTEGER PRIMARY KEY, schema_version TEXT, payload TEXT, content_hash TEXT'],
  ['factory_formalization_acceptance_baselines', 'id INTEGER PRIMARY KEY, schema_version TEXT, payload TEXT, baseline_hash TEXT, snapshot_hash TEXT'],
  ['factory_development_verification_ledger', 'id INTEGER PRIMARY KEY, graph_hash TEXT, criterion_key TEXT, verification_item_key TEXT, required INTEGER, criticality TEXT, entry_state TEXT, outcome TEXT, terminal_route TEXT, terminal_reason_codes TEXT'],
  ['factory_submission_validation_rejections', 'rejection_ref TEXT PRIMARY KEY, rejected_at TEXT'],
  ['factory_execution_completion_products', 'execution_id TEXT, schema_id TEXT, PRIMARY KEY (execution_id, schema_id)'],
];
for (const [name, ddl] of TABLES) db.prepare(`CREATE TABLE ${name} (${ddl})`).run();
db.pragma('user_version = 3');

const insert = (table, row) => {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k]));
};

insert('factory_lifecycle_runs', { id: 1, terminal_status: 'failed' });
insert('factory_stage_runs', { id: 1, lifecycle_run_id: 1, ordinal: 1, stage_id: 'solution-development', module_ref_key: 'development', status: 'terminal', local_outcome: 'failed', authority: 'stage-certificate', process_run_id: 1 });
insert('factory_process_runs', { id: 1 });
insert('factory_process_transitions', { id: 1 });
insert('factory_run_terminal_event_receipts', { id: 1, lifecycle_run_id: 1 });
insert('factory_process_outcome_certificates', { id: 1, process_run_id: 1, decision: 'refused', reason_codes: '["task-graph-contract-violation"]', rationale: 'synthetic smoke fixture' });
insert('factory_module_installations', { id: 1, name: 'development-workshop', version: '1.0.0', package_digest: PKG_DIGEST, status: 'active', store_location: STORE_REL });
insert('factory_workplaces', { workplace_ref: WORKPLACE_REF, loop_state: 'terminal', terminal_reason: 'failed' });
insert('factory_gate_decisions', { decision_key: 'decision-1', decided_at: '2026-01-01T00:00:00.000Z', gate_phase: 'final', verdict: 'repair_required', workplace_ref: WORKPLACE_REF, gate_run_ref: 'gate-run-1', repair_target_role: 'author' });
insert('factory_gate_runs', { gate_run_ref: 'gate-run-1', workplace_ref: WORKPLACE_REF, check_plan_ref: 'check-plan:task-graph-contract' });
insert('factory_check_receipts', { check_receipt_ref: 'check-1', created_at: '2026-01-01T00:00:01.000Z', check_run_ref: 'gate-run-1', outcome: 'failed', provider_id: 'task-graph-contract', provider_version: 'v1', evidence_refs: '[]' });
insert('factory_transition_obligations', { obligation_key: 'obligation:submitContribution:work-item-1', state: 'completed' });
insert('factory_candidate_sets', { candidate_set_ref: 'candidate-1', workplace_ref: WORKPLACE_REF, sealed_at: '2026-01-01T00:00:02.000Z' });
insert('factory_candidate_set_members', { candidate_set_ref: 'candidate-1', ordinal: 1 });
insert('factory_workplace_production_revisions', { revision_ref: 'revision-1' });
insert('factory_sealed_product_materials', { schema_id: 'factory.development-task-graph-proposal.v1', content_digest: H('b'), payload_snapshot: '{"kind":"task-graph-proposal","workItems":1}', payload_hash: H('c') });
insert('factory_effect_attempts', { attempt_ref: 'effect-1' });
insert('factory_cell_effect_receipts', { effect_receipt_ref: 'receipt-1' });
insert('factory_external_effect_actions', { id: 1 });
insert('factory_external_effect_events', { id: 1, action_id: 1, sequence: 1 });
insert('tasks', { id: 1, task_kind: 'implementation', status: 'done' });
insert('worker_executions', { execution_id: 'exec-0001', task_id: 1, state: 'exited', last_error: null });
insert('command_receipts', { command_id: 'cmd-1', accepted_at: '2026-01-01T00:00:03.000Z' });
insert('artifacts', { id: 1, type: 'document', code: 'SRS-001', title: 'Software Requirements Specification', status: 'accepted', storage_kind: 'file_backed', path: 'docs/srs.md', content_hash: H('d'), drift_state: 'none' });
insert('artifact_traces', { id: 1, source_id: 1, target_type: 'task', target_id: '1', link_type: 'covers' });
insert('factory_node_runs', { id: 1, process_run_id: 1 });
insert('factory_work_intents', { id: 1 });
insert('factory_orders', { order_ref: 'order-1' });
insert('projects', { id: 1 });
insert('repositories', { id: 1 });
insert('project_repositories', { id: 1 });
insert('trusted_providers', { id: 1, category: 'builtin', name: 'task-graph-contract', trust_basis: 'versioned-builtin', determinism: 1, scope: 'development', version: 'v1' });
insert('factory_formalization_solution_contracts', { id: 1, schema_version: '1', payload: '{"kind":"solution-contract"}', content_hash: H('e') });
insert('factory_formalization_acceptance_baselines', { id: 1, schema_version: '1', payload: '{"kind":"acceptance-baseline"}', baseline_hash: H('f'), snapshot_hash: H('g') });
insert('factory_development_verification_ledger', { id: 1, graph_hash: H('h'), criterion_key: 'AC-1', verification_item_key: 'vitest-run', required: 1, criticality: 'blocking', entry_state: 'settled', outcome: 'failed', terminal_route: 'final-gate', terminal_reason_codes: '["harness-broken"]' });
insert('factory_submission_validation_rejections', { rejection_ref: 'rejection-1', rejected_at: '2026-01-01T00:00:04.000Z' });
insert('factory_execution_completion_products', { execution_id: 'exec-0001', schema_id: 'product/v1' });
db.close();

// ── journal (kinds the normalizer maps; fixed ordinals) ─────────────────────
const journal = [
  { kind: 'execution.reserved', execution_id: 'exec-0001', workplace_ref: WORKPLACE_REF, data: { phase: 'contribute', executor_kind: 'opencode' } },
  { kind: 'worker.done', execution_id: 'exec-0001', workplace_ref: WORKPLACE_REF, data: { verdict: 'done' } },
  { kind: 'gate.created', workplace_ref: WORKPLACE_REF, data: { gate_run_ref: 'gate-run-1', gate_phase: 'final', check_plan_ref: 'check-plan:task-graph-contract' } },
  { kind: 'gate.decision', workplace_ref: WORKPLACE_REF, data: { decision_key: 'decision-1', gate_run_ref: 'gate-run-1', gate_phase: 'final', verdict: 'repair_required' } },
  { kind: 'obligation.created', workplace_ref: WORKPLACE_REF, data: { obligation_key: 'obligation:submitContribution:work-item-1' } },
  { kind: 'obligation.settled', workplace_ref: WORKPLACE_REF, data: { obligation_key: 'obligation:submitContribution:work-item-1' } },
  { kind: 'engine.exit', data: { code: 1, reason: 'stage-failed', terminal_status: 'failed' } },
  { kind: 'run.terminal', data: { outcome: 'failed', status: 'failed', terminal_status: 'failed' } },
];
writeFileSync(path.join(OUT, 'factory-run-journal.jsonl'), journal.map((l) => JSON.stringify(l)).join('\n') + '\n');

// ── product repo: one requirements file + a read-only resolvable HEAD ────────
mkdirSync(path.join(OUT, 'product', 'docs'), { recursive: true });
writeFileSync(path.join(OUT, 'product', 'docs', 'srs.md'), '# SRS (synthetic elite-smoke fixture)\n\nAC-1: the extractor determinism smoke stays green.\n');
mkdirSync(path.join(OUT, 'product', '.git'), { recursive: true });
// git refuses to TRACK a path under a `.git/` directory, so the committed
// fixture carries the HEAD content as a MIRROR file; the determinism suite
// materializes the real `product/.git/HEAD` from it in its temp source copy.
writeFileSync(path.join(OUT, 'product', '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
writeFileSync(path.join(OUT, 'product', 'git-head-fixture.txt'), '0123456789abcdef0123456789abcdef01234567\n');

// ── package-store: one sharded content-addressed entry with its manifests ──
const storeDir = path.join(OUT, ...STORE_REL.split('/'));
mkdirSync(storeDir, { recursive: true });
writeFileSync(path.join(storeDir, 'manifest.json'), JSON.stringify({ name: 'development-workshop', version: '1.0.0', digest: PKG_DIGEST }, null, 2) + '\n');
writeFileSync(path.join(storeDir, 'package.meta.json'), JSON.stringify({ builtBy: 'elite-smoke-fixture' }, null, 2) + '\n');

console.log(`[elite-smoke-fixture] written to ${OUT}`);
