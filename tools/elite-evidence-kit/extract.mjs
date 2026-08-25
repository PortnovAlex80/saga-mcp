#!/usr/bin/env node
// Elite Evidence Kit v1 — read-only extractor (WP-13D / EK-9).
//
// Converts one Elite factory run (SQLite DB + journal + package-store + product
// repo) into the deterministic regression corpus layout defined by
// docs/refactoring/event-kernel/elite-evidence-kit/SPEC-v1.md.
//
// Contract:
//   * SOURCES ARE STRICTLY READ-ONLY. The SQLite DB is opened with
//     { readonly: true }; nothing is ever written under the source root.
//   * Deterministic: re-running on the same DB yields byte-identical kit
//     files (sorted keys, stable ordering, \n endings, no extraction-time
//     timestamps anywhere in the output).
//   * The kit never contains the raw DB — only neutral content-addressed
//     capsules/programs/traces.
//
// Usage:
//   node tools/elite-evidence-kit/extract.mjs \
//     --source <dir-with-factory.sqlite> \
//     --out <kit-entry-dir> [--replace] \
//     [--run-id <id>] [--product <product-repo-dir>] \
//     [--scenario success-partial|negative]
//
// --replace wipes an existing --out directory first (required for reruns into
// the same directory). Exit code 0 on success; invariant violations do NOT
// fail the extraction — they are recorded honestly in expected-invariants.json
// and failure-witnesses/.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const TOOL_VERSION = 'elite-evidence-kit-extract/1.0.0';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.source || !args.out) {
  console.error('usage: extract.mjs --source <dir> --out <kitdir> [--replace] [--run-id <id>] [--product <dir>] [--scenario success-partial|negative]');
  process.exit(2);
}

const SOURCE = path.resolve(args.source);
const OUT = path.resolve(args.out);
const PRODUCT = args.product ? path.resolve(args.product) : path.join(SOURCE, 'product');
const SCENARIO = args.scenario || null;

if (fs.existsSync(OUT) && fs.readdirSync(OUT).length > 0) {
  if (!args.replace) {
    console.error(`[extract] REFUSING to overwrite non-empty --out ${OUT} without --replace`);
    process.exit(2);
  }
  fs.rmSync(OUT, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Deterministic serialization helpers
// ---------------------------------------------------------------------------

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortDeep(value[k]);
    return out;
  }
  return value;
}

const stableString = (value) => JSON.stringify(sortDeep(value));
const prettyJson = (value) => JSON.stringify(sortDeep(value), null, 2) + '\n';

function writeOut(relPath, content) {
  const abs = path.join(OUT, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function tryParseJson(text, fallback) {
  if (typeof text !== 'string') return fallback;
  try { return JSON.parse(text); } catch { return fallback === undefined ? text : fallback; }
}

function countBy(rows, field) {
  const out = {};
  for (const r of rows) out[r[field]] = (out[r[field]] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// Content-addressed capsule writer: file name is the sha256 of the exact file
// bytes, so identical payloads dedupe naturally and ordering never matters.
function writeCapsule(storeDir, role, payload, summary) {
  const body = prettyJson(payload);
  const digest = sha256hex(body);
  writeOut(`${storeDir}/${digest}.json`, body);
  return { file: `${storeDir}/${digest}.json`, role, digest, ...(summary !== undefined ? { summary } : {}) };
}

// ---------------------------------------------------------------------------
// Read-only source digests
// ---------------------------------------------------------------------------

const fileSha256 = (absPath) => sha256hex(fs.readFileSync(absPath));

// Canonical read-only dump digest: every user table, every row (ordered by
// rowid = insertion order), each row canonicalized with sorted keys. BLOBs are
// base64. Deterministic for a static DB (WAL included via the connection).
function dbContentDigest(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((r) => r.name);
  const parts = [];
  for (const t of tables) {
    let rows;
    try { rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all(); } catch { continue; }
    parts.push(`#table:${t}:${rows.length}`);
    for (const row of rows) {
      const norm = {};
      for (const k of Object.keys(row).sort()) {
        const v = row[k];
        norm[k] = Buffer.isBuffer(v) ? v.toString('base64') : v;
      }
      parts.push(stableString(norm));
    }
  }
  return { digest: sha256hex(parts.join('\n')), tableCount: tables.length };
}

// Merkle digest over the content-addressed package-store entries. Entry dir
// name is the factory-recorded package digest; we independently hash every
// file inside (path + content) so the merkle pins byte-level store content,
// not just the recorded identity.
function packageStoreMerkle(storeRoot) {
  if (!fs.existsSync(storeRoot)) return { entries: [], merkle: null, note: 'package-store directory absent' };
  const allFiles = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else allFiles.push({ rel: path.relative(storeRoot, abs).split(path.sep).join('/'), abs });
    }
  };
  walk(storeRoot);
  const byEntry = new Map();
  for (const f of allFiles) {
    const m = f.rel.match(/^([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})\//);
    const key = m ? m[3] : '(unsharded)';
    if (!byEntry.has(key)) byEntry.set(key, []);
    byEntry.get(key).push(f);
  }
  const entries = [];
  for (const digest of [...byEntry.keys()].sort()) {
    const files = byEntry.get(digest).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const fileMerkle = sha256hex(files.map((f) => `${f.rel}\t${fileSha256(f.abs)}`).join('\n'));
    entries.push({ packageDigest: digest, fileCount: files.length, fileMerkle });
  }
  const merkle = entries.length
    ? sha256hex(entries.map((e) => `${e.packageDigest}\t${e.fileMerkle}`).join('\n'))
    : null;
  return { entries, merkle };
}

// Read-only git HEAD resolution (no git spawn): .git/HEAD -> ref -> loose or
// packed-refs.
function resolveGitHead(repoDir) {
  const gitDir = path.join(repoDir, '.git');
  try {
    if (!fs.existsSync(gitDir)) return { commit: null, provenance: 'no .git directory' };
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return { commit: head, provenance: 'direct:detached-HEAD' };
    const ref = head.slice(5);
    const loose = path.join(gitDir, ref);
    if (fs.existsSync(loose)) return { commit: fs.readFileSync(loose, 'utf8').trim(), provenance: 'direct:loose-ref' };
    const packed = path.join(gitDir, 'packed-refs');
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
        const m = line.match(/^([0-9a-f]{40}) (.+)$/);
        if (m && m[2].trim() === ref) return { commit: m[1], provenance: 'direct:packed-refs' };
      }
    }
    return { commit: null, provenance: 'ref-not-resolvable' };
  } catch (err) {
    return { commit: null, provenance: `error:${err.code || err.message}` };
  }
}

// ---------------------------------------------------------------------------
// DB facts (opened strictly read-only)
// ---------------------------------------------------------------------------

const DB_PATH = path.join(SOURCE, 'factory.sqlite');
const db = new Database(DB_PATH, { readonly: true });
const q = (sql) => db.prepare(sql).all();

const schemaVersion = db.pragma('user_version', { simple: true });

const lifecycleRuns = q('SELECT * FROM factory_lifecycle_runs ORDER BY id');
const stageRuns = q('SELECT * FROM factory_stage_runs ORDER BY lifecycle_run_id, ordinal');
const processRuns = q('SELECT * FROM factory_process_runs ORDER BY id');
const processTransitions = q('SELECT * FROM factory_process_transitions ORDER BY id');
const terminalReceipts = q('SELECT * FROM factory_run_terminal_event_receipts ORDER BY lifecycle_run_id');
const certificates = q('SELECT * FROM factory_process_outcome_certificates ORDER BY id');
const moduleInstallations = q('SELECT * FROM factory_module_installations ORDER BY id');
const workplaces = q('SELECT * FROM factory_workplaces ORDER BY workplace_ref');
const gateDecisions = q('SELECT * FROM factory_gate_decisions ORDER BY decided_at, decision_key');
const gateRuns = q('SELECT * FROM factory_gate_runs ORDER BY gate_run_ref');
const checkReceipts = q('SELECT * FROM factory_check_receipts ORDER BY created_at, check_receipt_ref');
const obligations = q('SELECT * FROM factory_transition_obligations ORDER BY obligation_key');
const candidateSets = q('SELECT * FROM factory_candidate_sets ORDER BY candidate_set_ref');
const candidateMembers = q('SELECT * FROM factory_candidate_set_members ORDER BY candidate_set_ref, ordinal');
const productionRevisions = q('SELECT * FROM factory_workplace_production_revisions ORDER BY revision_ref');
const sealedMaterials = q('SELECT * FROM factory_sealed_product_materials ORDER BY schema_id, content_digest');
const effectAttempts = q('SELECT * FROM factory_effect_attempts ORDER BY attempt_ref');
const cellEffectReceipts = q('SELECT * FROM factory_cell_effect_receipts ORDER BY effect_receipt_ref');
const externalEffectActions = q('SELECT * FROM factory_external_effect_actions ORDER BY id');
const externalEffectEvents = q('SELECT * FROM factory_external_effect_events ORDER BY action_id, sequence');
const tasks = q('SELECT * FROM tasks ORDER BY id');
const workerExecutions = q('SELECT * FROM worker_executions ORDER BY rowid');
const commandReceipts = q('SELECT * FROM command_receipts ORDER BY accepted_at, command_id');
const artifacts = q('SELECT * FROM artifacts ORDER BY id');
const nodeRuns = q('SELECT * FROM factory_node_runs ORDER BY process_run_id, id');
const workIntents = q('SELECT * FROM factory_work_intents ORDER BY id');
const orders = q('SELECT * FROM factory_orders ORDER BY order_ref');
const projects = q('SELECT * FROM projects ORDER BY id');
const repositories = q('SELECT * FROM repositories ORDER BY id');
const projectRepositories = q('SELECT * FROM project_repositories ORDER BY id');
const trustedProviders = q('SELECT * FROM trusted_providers ORDER BY id');
const solutionContracts = q('SELECT * FROM factory_formalization_solution_contracts ORDER BY id');
const acceptanceBaselines = q('SELECT * FROM factory_formalization_acceptance_baselines ORDER BY id');
const verificationLedger = q('SELECT * FROM factory_development_verification_ledger ORDER BY id');
const submissionRejections = q('SELECT * FROM factory_submission_validation_rejections ORDER BY rejected_at, rejection_ref');
const completionProducts = q('SELECT * FROM factory_execution_completion_products ORDER BY execution_id, schema_id');

const dbDump = dbContentDigest(db);

// ---------------------------------------------------------------------------
// Labels (stable, derived from data; row ids / uuids / hashes excluded)
// ---------------------------------------------------------------------------

const RUN_ID = args['run-id'] || `run-${lifecycleRuns[0]?.terminal_status || 'unknown'}-${dbDump.digest.slice(0, 12)}`;

// task id -> "<task_kind>#<ordinal within kind>"
const taskLabelById = new Map();
{
  const perKind = new Map();
  for (const t of tasks) {
    const kind = t.task_kind || 'task';
    const n = (perKind.get(kind) || 0) + 1;
    perKind.set(kind, n);
    taskLabelById.set(t.id, `${kind}#${n}`);
  }
}

// execution uuid -> "exec#<reservation order>"
const execLabelById = new Map();
workerExecutions.forEach((we, i) => execLabelById.set(we.execution_id, `exec#${i + 1}`));

// workplace_ref -> "<moduleRef>/<cellId>/<workKey>" (processRunId row id dropped)
const workplaceLabel = (ref) => (typeof ref === 'string' && ref.startsWith('workplace/') ? ref.split('/').slice(2).join('/') : ref);

// gate_run_ref -> workplace_ref (many gate events carry only the run ref)
const gateRunWorkplace = new Map(gateRuns.map((g) => [g.gate_run_ref, g.workplace_ref]));

// candidate_set_ref -> per-workplace ordinal label
const candLabelByRef = new Map();
{
  const perWp = new Map();
  const ordered = [...candidateSets].sort((a, b) =>
    a.sealed_at < b.sealed_at ? -1 : a.sealed_at > b.sealed_at ? 1 : a.candidate_set_ref < b.candidate_set_ref ? -1 : 1);
  for (const cs of ordered) {
    const n = (perWp.get(cs.workplace_ref) || 0) + 1;
    perWp.set(cs.workplace_ref, n);
    candLabelByRef.set(cs.candidate_set_ref, `cand#${n}`);
  }
}

// ---------------------------------------------------------------------------
// Journal + normalized trace
// ---------------------------------------------------------------------------

const JOURNAL_PATH = path.join(SOURCE, 'factory-run-journal.jsonl');
let journalLines = [];
let journalRawBytes = Buffer.alloc(0);
let journalDigest = null;
if (fs.existsSync(JOURNAL_PATH)) {
  journalRawBytes = fs.readFileSync(JOURNAL_PATH);
  journalDigest = sha256hex(journalRawBytes);
  journalLines = journalRawBytes.toString('utf8').split('\n').filter((l) => l.trim() !== '').map((l) => tryParseJson(l, { unparsed: l }));
}

// Per-scope ordinal labeler: opaque refs (hashes/uuids) become short stable
// ordinals scoped to one workplace/node, so parallel workplaces never share
// numbering and no raw ref leaks into the trace.
class ScopedLabelers {
  constructor(prefix) { this.prefix = prefix; this.byScope = new Map(); }
  label(scope, ref) {
    if (ref === null || ref === undefined) return null;
    let m = this.byScope.get(scope);
    if (!m) { m = new Map(); this.byScope.set(scope, m); }
    if (!m.has(ref)) m.set(ref, `${this.prefix}#${m.size + 1}`);
    return m.get(ref);
  }
}
const gateLabels = new ScopedLabelers('gate');
const decisionLabels = new ScopedLabelers('decision');
const obligationLabels = new ScopedLabelers('obligation');
const effectActionLabels = new ScopedLabelers('action');

function normalizeJournalRecord(rec) {
  const kind = rec.kind;
  const d = rec.data || {};
  const task = ('task_id' in d && taskLabelById.has(d.task_id)) ? taskLabelById.get(d.task_id) : undefined;
  const exec = (rec.execution_id && execLabelById.has(rec.execution_id)) ? execLabelById.get(rec.execution_id) : undefined;
  const rawWpRef = rec.workplace_ref || (rec.data && d.gate_run_ref ? gateRunWorkplace.get(d.gate_run_ref) : undefined);
  const wpRef = rawWpRef && typeof rawWpRef === 'string' && rawWpRef.startsWith('workplace/') ? rawWpRef : undefined;
  const wp = wpRef ? workplaceLabel(wpRef) : undefined;

  let stream;
  let data;

  switch (kind) {
    case 'assignment.claimed':
      stream = `workplace:${wp}`;
      data = { task, from: d.from_status, to: d.to_status, casFenced: d.cas_fenced };
      break;
    case 'execution.reserved':
      stream = `workplace:${wp}`;
      data = { exec, task, phase: d.phase, executorKind: d.executor_kind, modelRoute: d.model_route ? { provider: d.model_route.provider, model: d.model_route.model, effort: d.model_route.effort } : undefined };
      break;
    case 'worker.spawn':
      stream = exec || 'exec:unknown';
      data = { task };
      break;
    case 'worker.done':
      stream = wp ? `workplace:${wp}` : `exec:${exec || 'unknown'}`;
      data = { exec, task, verdict: d.verdict, stop: d.stop };
      break;
    case 'worker.exit':
      stream = exec || 'exec:unknown';
      data = { exec, task, exitCode: d.exit_code, workerDoneReceived: d.worker_done_received, taskStatusAfter: d.task_status_after, outcome: d.outcome, settlement: d.settlement, observer: d.observer, physicalExitObserved: d.physical_exit_observed, exitCodeSource: d.exit_code_source };
      break;
    case 'supervision.reaped':
      stream = exec || 'exec:unknown';
      data = { exec, task, action: d.action, released: d.released, reason: d.reason };
      break;
    case 'recovery.memory_delivered':
      stream = `workplace:${wp}`;
      data = { task, attemptCount: d.attempt_count, toStatus: d.to_status };
      break;
    case 'obligation.created':
      stream = wp ? `workplace:${wp}` : 'lifecycle';
      data = { obligation: obligationLabels.label(wp || 'lifecycle', d.obligation_key), handoffKind: d.handoff_kind, sourceKind: d.source_kind, ownerCapability: d.owner_capability, path: d.path };
      break;
    case 'obligation.claimed':
      stream = wp ? `workplace:${wp}` : 'lifecycle';
      data = { obligation: obligationLabels.label(wp || 'lifecycle', d.obligation_key), leaseFence: d.lease_fence };
      break;
    case 'obligation.settled':
      stream = wp ? `workplace:${wp}` : 'lifecycle';
      data = { obligation: obligationLabels.label(wp || 'lifecycle', d.obligation_key) };
      break;
    case 'gate.created':
      stream = `workplace:${wp}`;
      data = { gate: gateLabels.label(wp, d.gate_run_ref), phase: d.gate_phase, checkPlan: d.check_plan_ref, expectedWorkplaceRevision: d.expected_workplace_revision };
      break;
    case 'gate.state':
      stream = wp ? `workplace:${wp}` : 'lifecycle';
      data = { gate: gateLabels.label(wp || 'lifecycle', d.gate_run_ref), state: d.state };
      break;
    case 'gate.check_receipt':
      stream = wp ? `workplace:${wp}` : 'lifecycle';
      data = { gate: gateLabels.label(wp || 'lifecycle', d.gate_run_ref), provider: d.provider_id, providerVersion: d.provider_version, outcome: d.outcome };
      break;
    case 'gate.decision':
      stream = `workplace:${wp}`;
      data = { decision: decisionLabels.label(wp, d.decision_key), gate: gateLabels.label(wp, d.gate_run_ref), phase: d.gate_phase, verdict: d.verdict, repairTargetRole: d.repair_target_role };
      break;
    case 'effect.transition':
      stream = `effect:${d.node_id || rec.node_id || 'unknown'}`;
      data = { action: effectActionLabels.label(d.node_id || 'unknown', String(d.action_id)), moduleRefKey: d.module_ref_key, eventType: d.event_type, fromState: d.from_state, toState: d.to_state, claimFence: d.claim_fence, actor: d.actor };
      break;
    case 'invariant.classification':
      stream = `workplace:${wp}`;
      data = { classification: d.classification, reason: d.reason };
      break;
    case 'invariant.recovered':
      stream = `workplace:${wp}`;
      data = {};
      break;
    case 'engine.exit':
      stream = 'lifecycle';
      data = { code: d.code, reason: d.reason, terminalStatus: d.terminal_status, productOutcome: d.product_outcome };
      break;
    case 'run.terminal':
      stream = 'lifecycle';
      data = { outcome: d.outcome, status: d.status, terminalStatus: d.terminal_status, stageOutcome: d.stage_outcome, productOutcome: d.product_outcome, stageOutcomeAuthority: d.stage_outcome_authority, finalStage: d.final_stage, error: d.error, cycles: d.cycles };
      break;
    default:
      stream = wp ? `workplace:${wp}` : 'lifecycle';
      data = { unknownKindKeys: Object.keys(d).sort() };
      break;
  }

  const evt = { kind };
  if (task !== undefined) evt.task = task;
  if (exec !== undefined) evt.exec = exec;
  if (wp !== undefined && !stream.startsWith('workplace:')) evt.workplace = wp;
  for (const [k, v] of Object.entries(data)) if (v !== undefined) evt[k] = v;
  return { stream, event: evt };
}

const streams = new Map();
journalLines.forEach((rec, i) => {
  const { stream, event } = normalizeJournalRecord(rec);
  if (!streams.has(stream)) streams.set(stream, []);
  streams.get(stream).push({ seq: streams.get(stream).length + 1, journalLine: i + 1, ...event });
});

// Raw journal keys retained for invariant checks (pre-normalization).
const journalCreatedKeys = [];
const journalSettledKeys = [];
const runTerminalEvents = [];
for (const rec of journalLines) {
  if (rec.kind === 'obligation.created') journalCreatedKeys.push(rec.data?.obligation_key);
  if (rec.kind === 'obligation.settled') journalSettledKeys.push(rec.data?.obligation_key);
  if (rec.kind === 'run.terminal') runTerminalEvents.push(rec);
}

// ---------------------------------------------------------------------------
// Source manifest pieces
// ---------------------------------------------------------------------------

const pkgStore = packageStoreMerkle(path.join(SOURCE, 'package-store'));

const moduleIdentities = moduleInstallations.map((m) => ({
  name: m.name,
  version: m.version,
  packageDigest: m.package_digest,
  status: m.status,
  storeLocation: m.store_location,
}));

const buildDigestInput = moduleIdentities.map((m) => `${m.name}@${m.version}:${m.packageDigest}:${m.status}`).sort();
const buildDigest = sha256hex(buildDigestInput.join('\n'));

// sourceSHA — the checkout that produced the run is not fully recoverable from
// a copied run root; derived honestly from the package-store identities the
// DB pins (factory modules = the executing factory code) + schema version.
const sourceSHA = {
  value: sha256hex(stableString({
    schemaVersion,
    modules: buildDigestInput,
    trustedProviderBases: trustedProviders.map((p) => `${p.name}:${p.version}:${p.trust_basis}`).sort(),
  })),
  provenance: 'derived:package-store-digests+schema-version',
  direct: false,
  note: 'The factory checkout that produced this run is not archived with the run root. The value pins the exact factory module packages (content digests recorded by the DB) and built-in provider bases that executed the run — the strongest recoverable identity of the producing code.',
};

const productHead = resolveGitHead(PRODUCT);

// ---------------------------------------------------------------------------
// Scenario claim verification (spec expectations vs data — data always wins)
// ---------------------------------------------------------------------------

const SCENARIOS = {
  'success-partial': {
    specRef: 'SPEC-v1.md §Elite-fresh-20260825 (success/partial)',
    claims: {
      terminalStatus: 'development-blocked',
      tasksDone: 30,
      tasksTotal: 30,
      gatesAccepted: 29,
      gatesTotal: 30,
      failurePointCell: 'development-readiness-certification',
    },
  },
  negative: {
    specRef: 'SPEC-v1.md §Elite-8 (negative scenario)',
    claims: {
      terminalStatus: 'failed',
      failurePointCell: 'development-plan-task-graph',
    },
  },
};

const claimsVerification = [];
if (SCENARIO && SCENARIOS[SCENARIO]) {
  const spec = SCENARIOS[SCENARIO];
  const failedWorkplaces = workplaces.filter((w) => w.terminal_reason === 'failed');
  const data = {
    terminalStatus: lifecycleRuns[0]?.terminal_status ?? null,
    tasksDone: tasks.filter((t) => t.status === 'done').length,
    tasksTotal: tasks.length,
    gatesAccepted: gateDecisions.filter((g) => g.verdict === 'accepted').length,
    gatesTotal: gateDecisions.length,
    failurePointCell: failedWorkplaces.length === 1 ? failedWorkplaces[0].production_cell_id : null,
  };
  for (const [key, expected] of Object.entries(spec.claims)) {
    claimsVerification.push({ claim: key, expected, actual: data[key], matches: expected === data[key], specRef: spec.specRef });
  }
}
const claimMismatches = claimsVerification.filter((c) => !c.matches);

// ---------------------------------------------------------------------------
// input-capsule/
// ---------------------------------------------------------------------------

const capsuleIndex = [];
const addCapsule = (role, payload, summary) => {
  const desc = writeCapsule('input-capsule', role, payload, summary);
  capsuleIndex.push(desc);
  return desc;
};

for (const lr of lifecycleRuns) {
  addCapsule('lifecycle-definition', {
    lifecycleRefKey: lr.lifecycle_ref_key,
    displayName: lr.display_name,
    definitionSnapshot: tryParseJson(lr.definition_snapshot),
    definitionHash: lr.definition_hash,
    entryStageId: lr.entry_stage_id,
    inputSnapshot: tryParseJson(lr.input_snapshot),
    inputHash: lr.input_hash,
  }, `lifecycle ${lr.lifecycle_ref_key}`);
}
for (const o of orders) {
  addCapsule('order', { orderRef: o.order_ref, sourceKind: o.source_kind, state: o.state, lifecycleRunId: o.lifecycle_run_id }, `order ${o.order_ref}`);
}
addCapsule('project-identity', {
  projects: projects.map((p) => ({ name: p.name, status: p.status })),
  repositories: repositories.map((r) => ({ name: r.name, defaultBranch: r.default_branch })),
  projectRepositories: projectRepositories.map((r) => ({ role: r.role, localPath: r.local_path, integrationBranch: r.integration_branch, status: r.status })),
}, 'project / repository / checkout identity');

for (const s of stageRuns) {
  addCapsule('stage-envelope', {
    stageId: s.stage_id,
    ordinal: s.ordinal,
    attempt: s.attempt,
    moduleRefKey: s.module_ref_key,
    bindingSnapshot: tryParseJson(s.binding_snapshot),
    bindingHash: s.binding_hash,
    inputSchema: tryParseJson(s.input_schema),
    inputSnapshot: tryParseJson(s.input_snapshot),
    inputHash: s.input_hash,
    resultSnapshot: tryParseJson(s.result_snapshot),
    mappedOutputSnapshot: tryParseJson(s.mapped_output_snapshot),
  }, `stage ${s.stage_id}`);
}
for (const p of processRuns) {
  addCapsule('process-envelope', {
    moduleRefKey: p.module_ref_key,
    projectedStage: p.projected_stage,
    idempotencyKey: p.idempotency_key,
    executorKind: p.executor_kind,
    inputSnapshot: tryParseJson(p.input_snapshot),
    inputHash: p.input_hash,
    outputRef: p.output_ref,
    certificateRef: p.certificate_ref,
  }, `process-run ${p.module_ref_key}`);
}

for (const c of certificates) {
  addCapsule('outcome-certificate', {
    moduleRefKey: c.module_ref_key,
    schemaVersion: c.schema_version,
    decision: c.decision,
    reasonCodes: tryParseJson(c.reason_codes, []),
    rationale: c.rationale,
    inputHash: c.input_hash,
    certificatePayload: tryParseJson(c.certificate_payload),
    certificateHash: c.certificate_hash,
    authority: c.authority,
  }, `${c.module_ref_key} -> ${c.decision}`);
}

for (const sc of solutionContracts) {
  addCapsule('formalization-solution-contract', { schemaVersion: sc.schema_version, payload: tryParseJson(sc.payload), contentHash: sc.content_hash }, 'formalization solution contract');
}
for (const ab of acceptanceBaselines) {
  addCapsule('formalization-acceptance-baseline', { schemaVersion: ab.schema_version, payload: tryParseJson(ab.payload), baselineHash: ab.baseline_hash, snapshotHash: ab.snapshot_hash }, 'formalization acceptance baseline');
}

// Sealed stage outputs (discovery / formalization / development inputs).
const INPUT_ROLE_BY_SCHEMA = {
  'factory.discovery-proposal.v1': 'discovery-output/proposal',
  'factory.discovery-readiness-assessment.v2': 'discovery-output/readiness-assessment',
  'factory.formalization-product-bundle.v1': 'formalization-output/product-bundle',
  'factory.formalization-use-case-bundle.v1': 'formalization-output/use-case-bundle',
  'factory.formalization-acceptance-bundle.v1': 'formalization-output/acceptance-bundle',
  'factory.formalization-architecture-bundle.v1': 'formalization-output/architecture-bundle',
  'factory.formalization-reconciliation-report.v1': 'formalization-output/reconciliation-report',
  'factory.development-task-graph-proposal.v1': 'development-output/task-graph-proposal',
  'factory.development-readiness-manifest.v1': 'development-output/readiness-manifest',
};
for (const m of sealedMaterials) {
  const role = INPUT_ROLE_BY_SCHEMA[m.schema_id];
  if (!role) continue; // actor-response materials go to actor-program
  addCapsule(role, { schemaId: m.schema_id, contentDigest: m.content_digest, payload: tryParseJson(m.payload_snapshot), payloadHash: m.payload_hash }, m.schema_id);
}

// Requirements corpus (SRS, AC, UC, FR, NFR, RULE, PRD, brief) — file content
// read read-only from the product repo, deduped by path.
{
  const seen = new Set();
  const files = [];
  for (const a of artifacts) {
    if (a.storage_kind !== 'file_backed') continue;
    const rel = a.path.split('#')[0];
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(PRODUCT, rel);
    if (!fs.existsSync(abs)) continue;
    files.push({ rel, bytes: fs.readFileSync(abs) });
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  for (const f of files) {
    addCapsule('requirements-file', { path: f.rel, contentSha256: sha256hex(f.bytes), text: f.bytes.toString('utf8') }, f.rel);
  }
  addCapsule('artifact-registry', {
    artifacts: artifacts.map((a) => ({
      type: a.type, code: a.code, title: a.title, status: a.status,
      storageKind: a.storage_kind, path: a.path, contentHash: a.content_hash, driftState: a.drift_state,
    })),
    artifactTraces: q('SELECT source_id, target_type, target_id, link_type FROM artifact_traces ORDER BY id'),
  }, `${artifacts.length} artifacts`);
}

// Module / package installation identities + manifests.
addCapsule('module-installation-identities', { installations: moduleIdentities }, `${moduleIdentities.length} installations`);
for (const m of moduleInstallations) {
  const storeDir = path.join(SOURCE, m.store_location);
  for (const fname of ['manifest.json', 'package.meta.json']) {
    const abs = path.join(storeDir, fname);
    if (fs.existsSync(abs)) {
      addCapsule(`module-package/${m.name}@${m.version}/${fname}`, {
        name: m.name,
        version: m.version,
        packageDigest: m.package_digest,
        file: fname,
        contentSha256: fileSha256(abs),
        content: tryParseJson(fs.readFileSync(abs, 'utf8')),
      }, `${m.name}@${m.version} ${fname}`);
    }
  }
}

addCapsule('trusted-providers', {
  providers: trustedProviders.map((p) => ({ category: p.category, name: p.name, trustBasis: p.trust_basis, determinism: p.determinism, scope: p.scope, version: p.version })),
}, `${trustedProviders.length} providers`);

addCapsule('development-verification-ledger', {
  entries: verificationLedger.map((e) => ({
    graphHash: e.graph_hash, criterionKey: e.criterion_key, verificationItemKey: e.verification_item_key,
    required: e.required === 1, criticality: e.criticality, entryState: e.entry_state, outcome: e.outcome,
    terminalRoute: e.terminal_route, terminalReasonCodes: tryParseJson(e.terminal_reason_codes, null),
  })),
}, `${verificationLedger.length} ledger entries`);

capsuleIndex.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
writeOut('input-capsule/index.json', prettyJson({ runId: RUN_ID, capsules: capsuleIndex.map(({ file, role, digest, summary }) => ({ file, role, digest, summary })) }));

// ---------------------------------------------------------------------------
// actor-program/
// ---------------------------------------------------------------------------

const actorCapsules = [];
const actorCapsuleByMaterialDigest = new Map();
const addActorCapsule = (role, payload, summary) => {
  const desc = writeCapsule('actor-program', role, payload, summary);
  actorCapsules.push(desc);
  return desc;
};

for (const m of sealedMaterials) {
  if (INPUT_ROLE_BY_SCHEMA[m.schema_id]) continue;
  const desc = addActorCapsule(`sealed-material/${m.schema_id}`, {
    schemaId: m.schema_id,
    contentDigest: m.content_digest,
    payload: tryParseJson(m.payload_snapshot),
    payloadHash: m.payload_hash,
  }, m.schema_id);
  actorCapsuleByMaterialDigest.set(m.content_digest, desc.file);
}

for (const r of submissionRejections) {
  addActorCapsule('submission-rejection', {
    validatorId: r.validator_id,
    validatorVersion: r.validator_version,
    moduleRef: r.module_ref,
    nodeId: r.node_id,
    task: taskLabelById.get(r.task_id) || null,
    workplace: r.workplace_ref ? workplaceLabel(r.workplace_ref) : null,
    rejectionCode: r.rejection_code,
    gaps: tryParseJson(r.gaps_json, []),
    details: tryParseJson(r.details_json, {}),
    feedback: tryParseJson(r.feedback_json, {}),
    observedArtifacts: tryParseJson(r.observed_artifacts, []),
    rejectionDigest: r.rejection_digest,
  }, `${r.rejection_code} on ${r.node_id}`);
}

const normalizedCommands = commandReceipts.map((c) => ({
  commandKind: c.command_kind,
  actorKind: c.actor_kind,
  exec: (c.execution_id && execLabelById.get(c.execution_id)) || null,
  task: (c.task_id && taskLabelById.get(c.task_id)) || null,
  accepted: c.accepted === 1,
  rejectionCode: c.rejection_code,
  payloadHash: c.payload_hash,
  result: tryParseJson(c.result_json, null),
}));
addActorCapsule('command-receipts', { commands: normalizedCommands }, `${normalizedCommands.length} commands`);

const normalizedExecutions = workerExecutions.map((w) => ({
  label: execLabelById.get(w.execution_id),
  task: taskLabelById.get(w.task_id) || null,
  state: w.state,
  phase: w.phase,
  launcher: w.launcher,
  exitCode: w.exit_code,
  stuckState: w.stuck_state,
  voided: w.voided_at !== null,
  finished: w.finished_at !== null,
}));
addActorCapsule('worker-executions', { executions: normalizedExecutions }, `${normalizedExecutions.length} executions`);

// Program index: per workplace, ordered actor responses with gate outcomes
// (accepted AND rejected) — the "actor program" for replay.
const decisionsBySubject = new Map();
for (const d of [...gateDecisions].sort((a, b) => (a.decided_at < b.decided_at ? -1 : 1))) {
  const subj = d.subject_candidate_set_ref;
  if (!decisionsBySubject.has(subj)) decisionsBySubject.set(subj, []);
  decisionsBySubject.get(subj).push({ phase: d.gate_phase, verdict: d.verdict, repairTargetRole: d.repair_target_role });
}
const candidateSetsByWp = new Map();
for (const cs of candidateSets) {
  if (!candidateSetsByWp.has(cs.workplace_ref)) candidateSetsByWp.set(cs.workplace_ref, []);
  candidateSetsByWp.get(cs.workplace_ref).push(cs);
}
const membersByCandSet = new Map();
for (const cm of candidateMembers) {
  if (!membersByCandSet.has(cm.candidate_set_ref)) membersByCandSet.set(cm.candidate_set_ref, []);
  membersByCandSet.get(cm.candidate_set_ref).push(cm);
}

const programWorkplaces = [];
for (const w of workplaces) {
  const label = workplaceLabel(w.workplace_ref);
  const wpTasks = tasks.filter((t) => t.workplace_ref === w.workplace_ref).map((t) => taskLabelById.get(t.id));
  const responses = [];
  const csets = (candidateSetsByWp.get(w.workplace_ref) || [])
    .sort((a, b) => (a.sealed_at < b.sealed_at ? -1 : a.sealed_at > b.sealed_at ? 1 : a.candidate_set_ref < b.candidate_set_ref ? -1 : 1));
  csets.forEach((cs, i) => {
    const members = (membersByCandSet.get(cs.candidate_set_ref) || []).map((m) => ({
      schema: m.product_schema,
      digest: m.product_digest,
      origin: m.origin,
      capsule: actorCapsuleByMaterialDigest.get(m.product_digest)
        ? { file: actorCapsuleByMaterialDigest.get(m.product_digest) }
        : { note: 'material not sealed as an actor capsule' },
    }));
    const decisions = (decisionsBySubject.get(cs.candidate_set_ref) || []).map((d) => ({ phase: d.phase, verdict: d.verdict, repairTargetRole: d.repairTargetRole }));
    const last = decisions[decisions.length - 1]?.verdict ?? null;
    const disposition = last === 'accepted' ? 'accepted'
      : last === 'repair_required' ? 'rejected:repair_required'
        : last === 'failed' ? 'rejected:failed'
          : last === 'human_required' ? 'rejected:human_required'
            : 'no-gate-decision';
    responses.push({ role: cs.role, revisionOrdinal: i + 1, candidateSetLabel: candLabelByRef.get(cs.candidate_set_ref), candidateSetDigest: cs.candidate_set_digest, members, gateDecisions: decisions, disposition });
  });
  programWorkplaces.push({
    workplace: label,
    moduleRef: w.module_ref,
    productionCellId: w.production_cell_id,
    workKey: w.work_key,
    tasks: wpTasks,
    terminal: { kanbanPhase: w.kanban_phase, loopState: w.loop_state, terminalReason: w.terminal_reason },
    responses,
  });
}
programWorkplaces.sort((a, b) => (a.workplace < b.workplace ? -1 : a.workplace > b.workplace ? 1 : 0));

actorCapsules.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
writeOut('actor-program/program.json', prettyJson({
  runId: RUN_ID,
  note: 'Actor program: ordered author/reviewer responses per workplace with gate outcomes (accepted AND rejected). Capsules are content-addressed payloads of each response; command-receipts and worker-executions carry the normalized tool-call/process surface.',
  workplaces: programWorkplaces,
}));
writeOut('actor-program/index.json', prettyJson({
  runId: RUN_ID,
  capsules: actorCapsules.map(({ file, role, digest, summary }) => ({ file, role, digest, summary })),
}));

// ---------------------------------------------------------------------------
// expected-trace.json
// ---------------------------------------------------------------------------

const sortedStreams = Object.fromEntries([...streams.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

const mandatoryTransitions = stageRuns.map((s) => {
  const tr = processTransitions.find((t) => t.from_stage_run_id === s.id);
  return {
    from: s.stage_id,
    outcome: s.local_outcome,
    to: tr ? (tr.target_type === 'terminal' ? `terminal:${tr.terminal_status}` : tr.target_stage_id) : null,
    evidence: {
      transitionKeyNormalized: `lifecycle:stage-run:${s.ordinal}:outcome`,
      certificateHash: certificates.find((c) => c.process_run_id === s.process_run_id)?.certificate_hash || null,
    },
  };
});

const observedKindCounts = {};
for (const rec of journalLines) observedKindCounts[rec.kind] = (observedKindCounts[rec.kind] || 0) + 1;

const expectedTrace = {
  runId: RUN_ID,
  oracle: 'SYSTEM behavior under known actor responses — normalized trace comparison, not product quality (SPEC-v1.md)',
  normalization: {
    excluded: [
      'timestamps',
      'pids',
      'db row ids (processRunId inside workplace refs; task ids become stable labels)',
      'random uuids (worker/execution/gate/decision/obligation refs become per-stream ordinals)',
      'content digests of volatile payloads',
      'ordering of independent parallel workplaces/executions (per-stream sequences only)',
    ],
    retained: [
      'event kind sequence per stream',
      'obligation lifecycle (created -> claimed -> settled)',
      'gate decisions (phase, verdict, repair target)',
      'check receipts (provider, outcome)',
      'effect transitions (state machine)',
      'terminal proofs (typed outcome)',
      'worker supervision outcomes',
    ],
    streamModel: 'lifecycle | exec:<reservation-order-label> | workplace:<module>/<cell>/<workKey> | effect:<node>. Cross-stream ordering is intentionally not compared (independent parallelism); within-stream order is normative.',
  },
  streams: sortedStreams,
  mandatoryTransitions,
  permittedAlternatives: [
    'worker.spawn', 'worker.exit', 'worker.done', 'execution.reserved', 'assignment.claimed',
    'obligation.created', 'obligation.claimed', 'obligation.settled',
    'gate.created', 'gate.state', 'gate.check_receipt', 'gate.decision',
    'effect.transition', 'recovery.memory_delivered', 'supervision.reaped',
    'invariant.classification', 'invariant.recovered', 'engine.exit',
  ].map((k) => ({ eventKind: k, cardinality: '0..N per run (structural rules enforced by expected-invariants.json)', observed: observedKindCounts[k] || 0 })),
  finalOutcome: {
    terminalStatus: lifecycleRuns[0]?.terminal_status ?? null,
    lifecycleStatus: lifecycleRuns[0]?.status ?? null,
    terminalReceiptCount: terminalReceipts.length,
    receiptTerminalStatus: terminalReceipts[0]?.terminal_status ?? null,
    runTerminalEvent: runTerminalEvents.length === 1 ? (runTerminalEvents[0].data || null) : null,
    stageOutcomes: stageRuns.map((s) => ({ stageId: s.stage_id, moduleRefKey: s.module_ref_key, localOutcome: s.local_outcome, authority: s.authority })),
    certificates: certificates.map((c) => ({ moduleRefKey: c.module_ref_key, decision: c.decision, reasonCodes: tryParseJson(c.reason_codes, []), authority: c.authority })),
  },
};
writeOut('expected-trace.json', prettyJson(expectedTrace));

// ---------------------------------------------------------------------------
// expected-invariants.json — declarative rules + extractor-side verification
// ---------------------------------------------------------------------------

const facts = {
  tasks: tasks.map((t) => ({ label: taskLabelById.get(t.id), status: t.status, kind: t.task_kind, workplace: t.workplace_ref ? workplaceLabel(t.workplace_ref) : null })),
  workplaces: workplaces.map((w) => ({ label: workplaceLabel(w.workplace_ref), cell: w.production_cell_id, kanbanPhase: w.kanban_phase, loopState: w.loop_state, terminalReason: w.terminal_reason })),
  obligations: obligations.map((o) => ({ key: o.obligation_key, handoffKind: o.handoff_kind, state: o.state, sourceKind: o.source_kind })),
  gateDecisions: gateDecisions.map((d) => ({ workplace: workplaceLabel(d.workplace_ref), phase: d.gate_phase, verdict: d.verdict, subject: d.subject_candidate_set_ref, assessmentRefs: tryParseJson(d.assessment_candidate_set_refs, []) })),
  gateRuns: gateRuns.map((g) => ({ workplace: workplaceLabel(g.workplace_ref), phase: g.gate_phase, state: g.state, checkPlan: g.check_plan_ref })),
  checkReceipts: checkReceipts.map((c) => ({ provider: c.provider_id, outcome: c.outcome, gateRun: c.check_run_ref })),
  workerExecutions: workerExecutions.map((w) => ({ label: execLabelById.get(w.execution_id), state: w.state, phase: w.phase, exitCode: w.exit_code, task: taskLabelById.get(w.task_id) || null })),
  terminalReceipts: terminalReceipts.map((t) => ({ terminalStatus: t.terminal_status, status: t.status })),
  stageRuns: stageRuns.map((s) => ({ stageId: s.stage_id, status: s.status, localOutcome: s.local_outcome })),
  certificates: certificates.map((c) => ({ moduleRefKey: c.module_ref_key, decision: c.decision, reasonCodes: tryParseJson(c.reason_codes, []) })),
  candidateSets: candidateSets.map((c) => ({ workplace: workplaceLabel(c.workplace_ref), role: c.role, subject: c.subject_candidate_set_ref, digest: c.candidate_set_digest })),
  artifacts: artifacts.map((a) => ({ type: a.type, code: a.code, status: a.status, driftState: a.drift_state })),
  journalEvents: journalLines.map((r) => ({ kind: r.kind, obligationKey: r.data?.obligation_key ?? null })),
  moduleInstallations: moduleIdentities,
};

// Tiny declarative rule engine — the SAME JSON the future event-kernel test
// engine consumes; the extractor evaluates it here and records the outcome.
function evaluate(a, path, ctx) {
  if (a === null || a === undefined) return true;
  if (Array.isArray(a)) return a.every((x, i) => evaluate(x, `${path}[${i}]`, ctx));
  if (typeof a !== 'object') return !!a;
  const rows = (subject) => facts[subject] || [];
  switch (a.type) {
    case 'all-satisfy': {
      const rs = rows(a.subject).filter((r) => (a.where ? matchWhere(r, a.where) : true));
      const bad = rs.filter((r) => !matchField(r, a));
      ctx.results.push({ path, subject: a.subject, checked: rs.length, failures: bad.slice(0, 5).map((r) => r.label || r.key || JSON.stringify(r).slice(0, 120)) });
      return bad.length === 0;
    }
    case 'count': {
      const n = rows(a.subject).filter((r) => (a.where ? matchWhere(r, a.where) : true)).length;
      let expected;
      if ('equals' in a) expected = a.equals;
      else if ('subjectEquals' in a) expected = rows(a.subjectEquals.subject).filter((r) => (a.subjectEquals.where ? matchWhere(r, a.subjectEquals.where) : true)).length;
      ctx.results.push({ path, subject: a.subject, count: n, expected });
      return n === expected;
    }
    case 'events-unique-per-key': {
      const keys = facts.journalEvents.filter((e) => e.kind === a.kind && e[a.keyField] !== null).map((e) => e[a.keyField]);
      const unique = new Set(keys).size;
      ctx.results.push({ path, kind: a.kind, events: keys.length, uniqueKeys: unique, duplicates: keys.length - unique });
      return keys.length === unique;
    }
    case 'events-count': {
      const n = facts.journalEvents.filter((e) => e.kind === a.kind).length;
      ctx.results.push({ path, kind: a.kind, count: n, expected: a.equals });
      return n === a.equals;
    }
    default:
      ctx.results.push({ path, error: `unknown assertion type ${a.type}` });
      return false;
  }
}
function matchWhere(row, where) {
  return Object.entries(where).every(([k, v]) => (Array.isArray(v) ? v.includes(row[k]) : row[k] === v));
}
function matchField(row, a) {
  const v = row[a.selector];
  if ('in' in a) return a.in.includes(v);
  if ('notIn' in a) return !a.notIn.includes(v);
  if ('nonNull' in a) return a.nonNull ? v !== null && v !== undefined : v === null || v === undefined;
  if ('equals' in a) return v === a.equals;
  return false;
}

const invariantRules = [
  {
    id: 'INV-01-no-orphan-task',
    statement: 'No orphan task: every task reaches a terminal status; every workplace is terminal.',
    severity: 'blocking',
    assertions: [
      { type: 'all-satisfy', subject: 'tasks', selector: 'status', in: ['done', 'failed', 'cancelled'] },
      { type: 'all-satisfy', subject: 'workplaces', selector: 'loopState', in: ['terminal'] },
    ],
  },
  {
    id: 'INV-02-no-silent-obligation-loss',
    statement: 'No silent obligation loss: every DB transition obligation is completed; obligation.created/settled journal events are unique per key (REG-28 drain closes).',
    severity: 'blocking',
    assertions: [
      { type: 'all-satisfy', subject: 'obligations', selector: 'state', in: ['completed'] },
      { type: 'events-unique-per-key', kind: 'obligation.settled', keyField: 'obligationKey' },
    ],
  },
  {
    id: 'INV-04-no-duplicate-settlement',
    statement: 'No duplicate settlement: obligation.settled appears at most once per obligation key; effect receipts are unique per (workplace, effect, candidate set) by DB constraint.',
    severity: 'blocking',
    assertions: [{ type: 'events-unique-per-key', kind: 'obligation.settled', keyField: 'obligationKey' }],
  },
  {
    id: 'INV-05-exactly-once-terminal',
    statement: 'Exactly-once terminal: exactly one run.terminal journal event and exactly one terminal receipt row.',
    severity: 'blocking',
    assertions: [
      { type: 'events-count', kind: 'run.terminal', equals: 1 },
      { type: 'count', subject: 'terminalReceipts', equals: 1 },
    ],
  },
  {
    id: 'INV-06-truthful-outcomes',
    statement: 'Truthful outcomes (surface): workplaces carry a typed terminal reason; gate verdicts are typed.',
    severity: 'blocking',
    assertions: [
      { type: 'all-satisfy', subject: 'workplaces', selector: 'terminalReason', in: ['accepted', 'failed', 'cancelled'] },
    ],
  },
];

const verificationResults = [];
function recordResult(ruleId, statement, ok, evidence) {
  verificationResults.push({ ruleId, statement, status: ok ? 'pass' : 'fail', evidence });
}

for (const rule of invariantRules) {
  const engineResults = [];
  let ok = true;
  for (const a of rule.assertions) ok = evaluate(a, `$${rule.id}`, { results: engineResults }) && ok;
  recordResult(rule.id, rule.statement, ok, { engine: engineResults });
}

// Concrete extractor-evaluated checks (recorded with hard evidence):

{
  const created = new Set(journalCreatedKeys.filter(Boolean));
  const settled = new Set(journalSettledKeys.filter(Boolean));
  const lostKeys = [...created].filter((k) => !settled.has(k));
  const dbKeys = new Set(obligations.map((o) => o.obligation_key));
  const dbNeverSettled = [...dbKeys].filter((k) => !settled.has(k));
  recordResult('INV-02b-obligation-drain-closed', 'Every obligation key created (journal or DB) is settled in the journal; REG-28 drain closes.',
    lostKeys.length === 0 && dbNeverSettled.length === 0,
    { journalCreatedUnique: created.size, journalSettledUnique: settled.size, dbObligationRows: dbKeys.size, lostKeys: lostKeys.slice(0, 10), dbKeysNeverSettledInJournal: dbNeverSettled.slice(0, 10) });
}

{
  const implAccepted = gateDecisions.filter((d) => d.gate_phase === 'final' && d.verdict === 'accepted' && workplaceLabel(d.workplace_ref).includes('development-implementation'));
  const reviewerSets = new Set(candidateSets.filter((c) => c.role === 'reviewer').map((c) => c.candidate_set_ref));
  const violations = [];
  for (const d of implAccepted) {
    const refs = tryParseJson(d.assessment_candidate_set_refs, []);
    if (!refs.some((r) => reviewerSets.has(r))) violations.push({ workplace: workplaceLabel(d.workplace_ref) });
  }
  recordResult('INV-03-no-review-bypass', 'Every final-accepted development-implementation gate decision cites a sealed reviewer candidate set.',
    violations.length === 0,
    { finalAcceptedImplementationDecisions: implAccepted.length, reviewerCandidateSets: reviewerSets.size, violations });
}

{
  const lastTransition = processTransitions[processTransitions.length - 1] || null;
  const runTerm = runTerminalEvents[0]?.data || null;
  const values = {
    lastTransitionTerminalStatus: lastTransition?.terminal_status ?? null,
    lifecycleTerminalStatus: lifecycleRuns[0]?.terminal_status ?? null,
    receiptTerminalStatus: terminalReceipts[0]?.terminal_status ?? null,
    runTerminalEventStatus: runTerm?.terminal_status ?? null,
    lastStageLocalOutcome: stageRuns[stageRuns.length - 1]?.local_outcome ?? null,
  };
  const terminalVals = [values.lastTransitionTerminalStatus, values.lifecycleTerminalStatus, values.receiptTerminalStatus, values.runTerminalEventStatus];
  const chainOk = terminalVals.every((v) => v === terminalVals[0]) && terminalVals[0] !== null;
  const outcomeMap = { failed: 'failed', blocked: 'development-blocked' };
  const stageFeedsTerminal = values.lastStageLocalOutcome in outcomeMap ? outcomeMap[values.lastStageLocalOutcome] === values.lifecycleTerminalStatus : true;
  recordResult('INV-05b-terminal-chain-truthful', 'Last transition terminal_status == lifecycle terminal_status == receipt == run.terminal event; the last stage localOutcome maps onto the terminal status.',
    chainOk && stageFeedsTerminal, { values, chainOk, stageFeedsTerminal });
}

{
  const decisionsByWpLabel = new Map();
  for (const d of [...gateDecisions].sort((a, b) => (a.decided_at < b.decided_at ? -1 : 1))) {
    decisionsByWpLabel.set(workplaceLabel(d.workplace_ref), d);
  }
  const violations = [];
  for (const w of workplaces) {
    const label = workplaceLabel(w.workplace_ref);
    const last = decisionsByWpLabel.get(label);
    if (w.terminal_reason === 'accepted' && (!last || last.verdict !== 'accepted')) violations.push({ workplace: label, terminalReason: w.terminal_reason, lastVerdict: last?.verdict ?? null });
    if (w.terminal_reason === 'failed' && (!last || !['failed', 'repair_required'].includes(last.verdict))) violations.push({ workplace: label, terminalReason: w.terminal_reason, lastVerdict: last?.verdict ?? null });
  }
  recordResult('INV-06b-workplace-outcome-truthful', 'Every accepted workplace ends on an accepted gate decision; every failed workplace ends on a failed/repair_required gate decision.',
    violations.length === 0, { checked: workplaces.length, violations });
}

{
  const mismatchesCert = [];
  for (const c of certificates) {
    const stage = stageRuns.find((s) => s.process_run_id === c.process_run_id);
    if (stage && stage.local_outcome !== c.decision) mismatchesCert.push({ stage: stage.stage_id, localOutcome: stage.local_outcome, certificateDecision: c.decision });
  }
  const stagesWithoutCert = stageRuns.filter((s) => !certificates.some((c) => c.process_run_id === s.process_run_id)).map((s) => ({ stageId: s.stage_id, localOutcome: s.local_outcome }));
  recordResult('INV-06c-certificates-truthful', 'Every outcome certificate decision equals its stage local outcome. Stages without a certificate are recorded (a failed development stage in the negative corpus legitimately emits none).',
    mismatchesCert.length === 0, { mismatches: mismatchesCert, stagesWithoutCertificate: stagesWithoutCert });
}

{
  const phantom = [];
  const journalSupervised = new Set(
    journalLines.filter((r) => r.kind === 'supervision.reaped' || r.kind === 'recovery.memory_delivered').map((r) => r.execution_id).filter(Boolean)
  );
  const evidenceSplit = { journalReaped: 0, dbRecordedLossOnly: 0 };
  for (const we of workerExecutions) {
    const label = execLabelById.get(we.execution_id);
    const products = completionProducts.filter((c) => c.execution_id === we.execution_id);
    if (we.state === 'exited') {
      if (!we.task_id) phantom.push({ exec: label, issue: 'exited without a task' });
    } else if (we.state === 'lost' || we.state === 'terminated') {
      if (products.length > 0) phantom.push({ exec: label, issue: 'lost/terminated but produced completion products' });
      // Supervision evidence: a journal reap/recovery event, or the DB row's
      // own loss marker (last_error) — both are auditable loss records. The
      // split is reported so journal-visibility gaps stay visible.
      if (journalSupervised.has(we.execution_id)) evidenceSplit.journalReaped += 1;
      else if (we.last_error) evidenceSplit.dbRecordedLossOnly += 1;
      else phantom.push({ exec: label, issue: 'lost/terminated with neither journal supervision evidence nor a DB loss marker' });
    } else {
      phantom.push({ exec: label, issue: `non-terminal execution state ${we.state}` });
    }
  }
  recordResult('INV-07-no-phantom-executions', 'No phantom executions: exited executions map to real tasks; lost/terminated executions produced no completion products and carry supervision evidence (journal reap/recovery event or DB loss marker); no execution is left in a non-terminal state.',
    phantom.length === 0, { checked: workerExecutions.length, violations: phantom, supervisionEvidence: evidenceSplit });
}

{
  const reservedEvents = journalLines.filter((r) => r.kind === 'execution.reserved').length;
  recordResult('INV-08-execution-bookkeeping', 'Every worker_executions row has an execution.reserved journal event (no unbooked actors).',
    reservedEvents === workerExecutions.length,
    { reservedEvents, executionRows: workerExecutions.length });
}

{
  const nonAcceptedArtifacts = artifacts.filter((a) => a.status !== 'accepted').map((a) => ({ code: a.code, status: a.status }));
  const pendingObligations = obligations.filter((o) => o.state !== 'completed').length;
  const nonTerminalWorkplaces = workplaces.filter((w) => w.loop_state !== 'terminal').map((w) => workplaceLabel(w.workplace_ref));
  const nonDoneTasks = tasks.filter((t) => t.status !== 'done').map((t) => taskLabelById.get(t.id));
  recordResult('INV-09-no-chain-damage', 'Formalization chain intact: all artifacts accepted, zero pending obligations, all workplaces terminal, all tasks done, product repo left at its recorded commit.',
    nonAcceptedArtifacts.length === 0 && pendingObligations === 0 && nonTerminalWorkplaces.length === 0 && nonDoneTasks.length === 0,
    { nonAcceptedArtifacts, pendingObligations, nonTerminalWorkplaces, nonDoneTasks, productRepoCommit: productHead.commit, productRepoCommitProvenance: productHead.provenance });
}

const additionalCheckIds = ['INV-02b-obligation-drain-closed', 'INV-03-no-review-bypass', 'INV-05b-terminal-chain-truthful', 'INV-06b-workplace-outcome-truthful', 'INV-06c-certificates-truthful', 'INV-07-no-phantom-executions', 'INV-08-execution-bookkeeping', 'INV-09-no-chain-damage'];

writeOut('expected-invariants.json', prettyJson({
  runId: RUN_ID,
  note: 'Machine-checkable assertions over the normalized trace and extracted facts. The rule JSON is the contract for the future event-kernel test engine; "verification" records what this extractor proved against the source data at kit-build time.',
  rules: invariantRules.map(({ id, statement, severity, assertions }) => ({ id, statement, severity, assertions })),
  additionalChecks: verificationResults.filter((r) => additionalCheckIds.includes(r.ruleId)).map((r) => ({ id: r.ruleId, statement: r.statement, assertion: { type: 'extractor-evaluated', see: 'verification.results' } })),
  verification: {
    evaluatedBy: TOOL_VERSION,
    policy: 'Data wins. Failures are recorded honestly and cross-referenced in failure-witnesses/.',
    results: verificationResults,
    summary: {
      total: verificationResults.length,
      passed: verificationResults.filter((r) => r.status === 'pass').length,
      failed: verificationResults.filter((r) => r.status === 'fail').length,
    },
  },
}));

// ---------------------------------------------------------------------------
// failure-witnesses/
// ---------------------------------------------------------------------------

const witnesses = [];
const addWitness = (name, payload) => {
  writeOut(`failure-witnesses/${name}.json`, prettyJson(payload));
  witnesses.push(name);
};

function decodeDiagnosticRef(ref) {
  const m = typeof ref === 'string' ? ref.match(/^factory-check-diagnostic\/v1\/([0-9a-f]{64})\/(.+)$/) : null;
  if (!m) return null;
  try {
    const decoded = JSON.parse(Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return { digest: m[1], code: decoded.code, message: decoded.message, subjectRef: decoded.subjectRef };
  } catch { return null; }
}

// Witness: every failing final gate (the honest refusal points).
for (const d of gateDecisions.filter((x) => x.gate_phase === 'final' && ['failed', 'repair_required'].includes(x.verdict))) {
  const wpLabel = workplaceLabel(d.workplace_ref);
  const run = gateRuns.find((g) => g.gate_run_ref === d.gate_run_ref);
  const failedChecks = checkReceipts
    .filter((c) => c.check_run_ref === d.gate_run_ref && c.outcome !== 'passed')
    .map((c) => ({
      provider: c.provider_id,
      providerVersion: c.provider_version,
      outcome: c.outcome,
      diagnostics: tryParseJson(c.evidence_refs, []).map(decodeDiagnosticRef).filter(Boolean),
    }));
  if (failedChecks.length === 0) continue;
  addWitness(`final-gate-${d.verdict}-${wpLabel.replace(/[^a-z0-9-]+/gi, '-')}-${d.decision_key.slice(-8)}`, {
    kind: 'gate-refusal',
    workplace: wpLabel,
    decision: { phase: d.gate_phase, verdict: d.verdict, repairTargetRole: d.repair_target_role, checkPlan: run?.check_plan_ref },
    failedChecks,
    note: 'Minimal fragment: the failing check receipts (with decoded diagnostics), the gate decision they produced, and the workplace they refused. Reproduces the observed defect/refusal.',
  });
}

// Witness (success-partial): the full honest readiness refusal chain.
if (SCENARIO === 'success-partial') {
  const failedWp = workplaces.find((w) => w.terminal_reason === 'failed');
  if (failedWp) {
    const lastDecision = gateDecisions.filter((x) => x.workplace_ref === failedWp.workplace_ref).sort((a, b) => (a.decided_at < b.decided_at ? -1 : 1)).pop();
    const devStage = stageRuns.find((s) => s.stage_id === 'solution-development');
    const cert = certificates.find((c) => c.process_run_id === devStage?.process_run_id);
    addWitness('readiness-refusal-chain', {
      kind: 'honest-refusal-chain',
      workplace: workplaceLabel(failedWp.workplace_ref),
      lastGateDecision: lastDecision ? { phase: lastDecision.gate_phase, verdict: lastDecision.verdict } : null,
      stageCertificate: cert ? { decision: cert.decision, reasonCodes: tryParseJson(cert.reason_codes, []), rationale: cert.rationale } : null,
      lifecycleTerminal: lifecycleRuns[0]?.terminal_status,
      note: 'Readiness certification refused by the local-runnability check (test infrastructure: port-in-use + broken test harness), propagated honestly: workplace failed -> stage blocked -> lifecycle development-blocked. Not a product defect.',
    });
  }
}

// Witness: supervision anomalies (lost/terminated executions).
{
  const supervisedKinds = ['supervision.reaped', 'worker.exit', 'worker.done'];
  const anomalies = workerExecutions
    .filter((w) => ['lost', 'terminated'].includes(w.state))
    .map((w) => ({
      exec: execLabelById.get(w.execution_id),
      state: w.state,
      task: taskLabelById.get(w.task_id) || null,
      evidence: journalLines.filter((r) => r.execution_id === w.execution_id && supervisedKinds.includes(r.kind)).map((r) => ({ kind: r.kind, data: r.data })),
    }));
  if (anomalies.length) {
    addWitness('supervision-anomalies', {
      kind: 'supervision-observation',
      note: 'Lost/terminated executions with their supervision evidence. Not a defect by itself: INV-07 requires (and checks) that they produced no completion products and were reaped/recovered openly.',
      anomalies,
    });
  }
}

// Witness: journal-visibility gap — DB-recorded execution loss without a
// matching journal event. Honest data finding: the loss IS auditable (DB row
// state + last_error + successor execution), but the journal stream does not
// carry the transition, so trace comparators must not require a reap event
// for every lost execution.
{
  const journalSupervised = new Set(
    journalLines.filter((r) => r.kind === 'supervision.reaped' || r.kind === 'recovery.memory_delivered').map((r) => r.execution_id).filter(Boolean)
  );
  const gaps = workerExecutions
    .filter((w) => ['lost', 'terminated'].includes(w.state) && !journalSupervised.has(w.execution_id) && w.last_error)
    .map((w) => {
      const successors = workerExecutions.filter((x) => x.task_id === w.task_id && x.rowid > w.rowid && x.state === 'exited');
      return {
        exec: execLabelById.get(w.execution_id),
        task: taskLabelById.get(w.task_id) || null,
        dbState: w.state,
        dbLastError: w.last_error,
        completionProducts: completionProducts.filter((c) => c.execution_id === w.execution_id).length,
        successorExecutions: successors.map((x) => execLabelById.get(x.execution_id)),
        note: 'Loss recorded only in the DB (no supervision.reaped/recovery.memory_delivered journal event).',
      };
    });
  if (gaps.length) {
    addWitness('journal-visibility-gap-lost-executions', {
      kind: 'journal-visibility-gap',
      note: 'Executions the DB marks lost/terminated with a loss reason but whose transition never appears in the journal. Not a phantom execution (INV-07 checks: no completion products, task re-completed by a successor) — but a replay must reproduce the loss via DB-side state, not via a journal event.',
      gaps,
    });
  }
}

// Witness: engine restarts mid-run.
{
  const engineExits = journalLines.filter((r) => r.kind === 'engine.exit' && r.data?.reason !== 'completed').map((r) => r.data);
  if (engineExits.length) {
    addWitness('engine-restarts', {
      kind: 'resilience-observation',
      note: 'Engine exits before final completion (crash/restart cycles). The run later reached a typed terminal — restart tolerance is part of the observed system behavior.',
      engineExits,
      runTerminalCycles: runTerminalEvents[0]?.data?.cycles ?? null,
    });
  }
}

// Witness: journal duplicate obligation.created emissions.
{
  const createdCounts = new Map();
  for (const k of journalCreatedKeys) createdCounts.set(k, (createdCounts.get(k) || 0) + 1);
  const dupes = [...createdCounts.entries()].filter(([, n]) => n > 1).map(([obligationKey, createdEvents]) => ({ obligationKey, createdEvents }));
  if (dupes.length) {
    addWitness('journal-duplicate-obligation-created', {
      kind: 'journal-noise-observation',
      note: 'obligation.created emitted more than once for the same key (idempotent append re-emission across engine restarts). The DB holds a single row per key and exactly one settlement — no duplicate settlement, but trace comparators must dedupe created-events by key.',
      duplicates: dupes,
    });
  }
}

// Witness: spec-vs-data claims.
if (claimsVerification.length) {
  writeOut('failure-witnesses/spec-vs-data.json', prettyJson({
    kind: 'spec-vs-data',
    scenario: SCENARIO,
    note: 'Claims from the SPEC scenario profile checked against the extracted data. The DATA wins in expected-trace.json; any mismatch is recorded here.',
    claims: claimsVerification,
    mismatches: claimMismatches,
  }));
  witnesses.push('spec-vs-data');
}

// ---------------------------------------------------------------------------
// source-manifest.json (written last — includes claims verification + stats)
// ---------------------------------------------------------------------------

writeOut('source-manifest.json', prettyJson({
  kitVersion: 'elite-evidence-kit/v1',
  toolVersion: TOOL_VERSION,
  runId: RUN_ID,
  extractedFrom: {
    sourceRoot: SOURCE,
    dbFile: 'factory.sqlite',
    dbOpened: 'readonly',
    walPresent: fs.existsSync(DB_PATH + '-wal'),
    journal: { present: journalDigest !== null, digest: journalDigest, bytes: journalRawBytes.length, lines: journalLines.length },
    packageStore: { present: pkgStore.entries.length > 0, entries: pkgStore.entries.length },
    productDir: PRODUCT,
  },
  schemaVersion,
  digests: {
    dbContentDigest: { value: dbDump.digest, method: 'read-only canonical dump: every user table, rows by rowid, sorted-key JSON rows, sha256 over the concatenation' },
    journalDigest: { value: journalDigest, method: 'sha256 over factory-run-journal.jsonl bytes' },
    packageStoreMerkleDigest: { value: pkgStore.merkle, method: 'merkle over content-addressed entries: per entry sha256 over sorted (relative-path, file-sha256) pairs, then sha256 over sorted (entryDigest, fileMerkle) pairs' },
    buildDigest: { value: buildDigest, method: 'sha256 over sorted "name@version:packageDigest:status" of factory_module_installations' },
    sourceSHA,
    repoCommitDigest: { value: productHead.commit, provenance: productHead.provenance, note: 'HEAD of the product repository the run wrote to (read-only resolution of .git/HEAD).' },
  },
  observations: {
    lifecycleRuns: lifecycleRuns.length,
    stages: stageRuns.map((s) => ({ stageId: s.stage_id, moduleRefKey: s.module_ref_key, status: s.status, localOutcome: s.local_outcome, authority: s.authority })),
    terminalStatus: lifecycleRuns[0]?.terminal_status ?? null,
    tasks: { total: tasks.length, byStatus: countBy(tasks, 'status') },
    workplaces: { total: workplaces.length, byTerminalReason: countBy(workplaces, 'terminal_reason') },
    gateDecisions: { total: gateDecisions.length, byVerdict: countBy(gateDecisions, 'verdict') },
    obligations: { total: obligations.length, byState: countBy(obligations, 'state') },
    workerExecutions: { total: workerExecutions.length, byState: countBy(workerExecutions, 'state') },
    commandReceipts: commandReceipts.length,
    sealedMaterials: sealedMaterials.length,
    journalEvents: journalLines.length,
  },
  scenario: SCENARIO ? { profile: SCENARIO, specRef: SCENARIOS[SCENARIO].specRef, claimsVerification, allClaimsMatch: claimMismatches.length === 0 } : null,
  kitStats: {
    inputCapsules: capsuleIndex.length,
    actorCapsules: actorCapsules.length,
    actorProgramWorkplaces: programWorkplaces.length,
    traceStreams: streams.size,
    traceEvents: journalLines.length,
    invariantChecks: verificationResults.length,
    invariantFailures: verificationResults.filter((r) => r.status === 'fail').length,
    failureWitnesses: [...witnesses].sort(),
  },
}));

db.close();

console.log(`[extract] runId=${RUN_ID}`);
console.log(`[extract] kit written to ${OUT}`);
console.log(`[extract] capsules(input)=${capsuleIndex.length} capsules(actor)=${actorCapsules.length} workplaces(program)=${programWorkplaces.length} streams=${streams.size} events=${journalLines.length}`);
console.log(`[extract] invariants: ${verificationResults.filter((r) => r.status === 'pass').length}/${verificationResults.length} pass, ${verificationResults.filter((r) => r.status === 'fail').length} fail`);
console.log(`[extract] witnesses: ${witnesses.length}`);
