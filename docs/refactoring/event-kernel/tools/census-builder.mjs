#!/usr/bin/env node
/**
 * census-builder.mjs — assemble docs/refactoring/event-kernel/authority-census.json
 * (WP-01 / EK-1) from the sql-literal-scanner output plus hand-authored
 * overlays (family records, classification rules, WP-16 site lists,
 * predecessor inputs).
 *
 * Deterministic: same scan input + same overlays => same census JSON
 * (modulo generatedAt, which is fixed by EK1_SOURCE_DATE for reproducibility).
 */

import fs from 'node:fs';
import path from 'node:path';
import { FACT_FAMILY_BY_TABLE } from './sql-literal-scanner.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const OUT = path.join(ROOT, 'docs', 'refactoring', 'event-kernel', 'authority-census.json');
const BASE_SHA = '21ba0816e38ec1492b3acb4d21e7ccea49c6f5df';

// ---------------------------------------------------------------------------
// Closed vocabularies (the census JSON validates against exactly these).
// ---------------------------------------------------------------------------
const ENUMS = {
  disposition: ['retain-and-move', 'rewrite', 'delete'],
  authorityClass: ['AUTHORITATIVE', 'DIAGNOSTIC', 'DELETE'],
  accessKind: ['DDL', 'WRITE', 'READ_DECISION', 'READ_PRESENTATION'],
  tableClass: ['AUTHORITATIVE-AGGREGATE', 'PROJECTION', 'DIAGNOSTIC', 'CATALOG'],
  scope: ['src', 'tracker-view', 'scripts'],
  markerKind: [
    'ORDER_BY_ID_DESC', 'ORDER_BY_TIMESTAMP_DESC', 'MAX_ID', 'MAX_AGG', 'MIN_ID',
    'LIMIT_1', 'STATUS_PREDICATE', 'EXECUTION_TABLE_OR_STATUS', 'LATEST_TOKEN',
    'WINDOW_RANK',
  ],
  family: [
    'project-order-run', 'lifecycle', 'stage', 'process', 'node', 'workitem-task',
    'workplace', 'execution-attempt', 'material', 'gate', 'effect',
    'terminal-acceptance', 'obligation', 'recovery', 'checkpoint',
    'projection-diagnostic',
  ],
};

// Final table -> family map (supersedes scanner provisional map; includes
// corrections discovered during review).
const TABLE_FAMILY = { ...FACT_FAMILY_BY_TABLE };
TABLE_FAMILY.command_receipts = 'execution-attempt';
TABLE_FAMILY.factory_submission_validation_receipts = 'material';
TABLE_FAMILY.factory_submission_validation_rejections = 'material';
TABLE_FAMILY.factory_definition_compatibility_receipts = 'process';
TABLE_FAMILY.factory_workshop_binding_receipts = 'process';
TABLE_FAMILY.human_requests = 'obligation';
TABLE_FAMILY.supervision_locks = 'project-order-run';

// Table class defaults (which kind of durable fact the table holds today).
const PROJECTION_TABLES = new Set([
  'tasks', 'subtasks', 'task_dependencies', 'factory_development_task_projections',
  'comments', 'notes', 'templates', 'activity_log', 'runtime_observations',
]);
const DIAGNOSTIC_TABLES = new Set([
  'factory_artifact_drift_events', 'factory_engine_watchdog_events',
]);
const CATALOG_TABLES = new Set([
  'projects', 'repositories', 'project_repositories', 'repository_checkouts',
  'epics', 'episode_workflows', 'trusted_providers',
]);

function tableClassOf(table) {
  if (PROJECTION_TABLES.has(table)) return 'PROJECTION';
  if (DIAGNOSTIC_TABLES.has(table)) return 'DIAGNOSTIC';
  if (CATALOG_TABLES.has(table)) return 'CATALOG';
  return 'AUTHORITATIVE-AGGREGATE';
}

// Non-table identifiers the statement extractor picks up (CTE aliases, sqlite
// internals, rebuild temporaries). Everything else MUST be classified.
const NON_TABLES = new Set([
  'sqlite_master', 'json_each', 'the', 'message', 'applies', 'part',
  'evidence', 'epic_ids', 'task_stats', 'factory_process_products_new',
  'factory_process_products__new', 'factory_replay_capsule_invalidations_new',
  'IF',
]);

// Scope classification of a reader file.
const DECISION_RE = /^(src\/(app|application|checkpoints|helpers|infrastructure|lifecycle|modules|observability|planner|process-modules|replay|runtime|shared|types|validators|worker|index|db|schema|worker-executions|orchestrate-cli|checkpoint-cli)\b)/;
const PRESENTATION_RE = /^(src\/tools\/(?!dispatcher))/;
const TRACKER_VIEW = /^tracker-view\//;
const SCRIPTS = /^scripts\//;

// Files inside src/tools that nevertheless take production decisions
// (hand-verified during the census review).
const TOOLS_DECISION_OVERRIDES = new Set([
  'src/tools/tasks.ts',          // dependency readiness block/unblock is production behavior
  'src/tools/dispatcher.ts',     // whole file is the dispatch ingress
]);

function readerKindOf(file) {
  if (file === 'src/tools/dispatcher.ts') return 'READ_DECISION';
  if (TOOLS_DECISION_OVERRIDES.has(file)) return 'READ_DECISION';
  if (PRESENTATION_RE.test(file)) return 'READ_PRESENTATION';
  if (DECISION_RE.test(file)) return 'READ_DECISION';
  if (TRACKER_VIEW.test(file)) return file === 'tracker-view/engine-supervisor.mjs'
    ? 'READ_DECISION' /* watchdog acts on factories */ : 'READ_PRESENTATION';
  if (SCRIPTS.test(file)) return 'READ_PRESENTATION';
  return 'READ_DECISION'; // unknown src file: fail toward decision (conservative)
}

// Owning-repository heuristic for writer disposition on authoritative tables:
// a write inside a file that is a persistence/repository module moves with the
// aggregate; a direct write from app/lifecycle/tools/modules application code
// is a second writer that must be rewritten into an owning command.
const OWNING_REPO_RE = /(sqlite-[a-z0-9-]+\.ts$)|((persistence|infrastructure)\/[a-z0-9/-]+\.ts$)|(repository[a-z-]*\.ts$)/;
const OWNING_REPO_EXCEPTIONS = new Set([
  // infrastructure files that are NOT repositories of the table they touch but
  // deliberately bypass the owning aggregate (verified in review):
  'src/infrastructure/projections/workplace-projector.ts', // projection writer (sanctioned)
  'src/infrastructure/workers/claude-worker-executor-factory.ts', // executor direct task writes
  'src/infrastructure/persistence/sqlite-factory-runtime-repositories.ts', // mixed runtime repos (task writes live here)
  'src/infrastructure/workplace/sqlite-production-cell-integration.ts', // integration writes tasks directly
  'src/infrastructure/workplace/sqlite-production-cell-projection-persistence.ts', // task-shadow writes
]);

function writerDispositionOf(table, file) {
  const cls = tableClassOf(table);
  if (cls === 'PROJECTION') return 'delete';               // the whole scheduling projection goes away (EK-7)
  if (cls === 'DIAGNOSTIC') return 'delete';
  if (file === 'src/schema.ts' || file === 'src/db.ts') return 'delete'; // old bootstrap deleted with legacy schema
  if (SCRIPTS.test(file)) return 'rewrite';                 // restore-from-checkpoint direct SQL -> typed commands
  if (TRACKER_VIEW.test(file)) return 'rewrite';            // admin endpoints deleting executions -> commands
  if (OWNING_REPO_RE.test(file) && !OWNING_REPO_EXCEPTIONS.has(file)) return 'retain-and-move';
  return 'rewrite';                                         // second writer outside the owning aggregate
}

// Marker classification (see classificationSemantics in the JSON).
function classifyMarkerUse(stmt) {
  const tables = [...new Set([...stmt.reads, ...stmt.writes])].filter((t) => !NON_TABLES.has(t));
  const file = stmt.file;
  const isDecisionScope = readerKindOf(file) === 'READ_DECISION';
  const touchesProjection = tables.some((t) => PROJECTION_TABLES.has(t));
  const sql = stmt.sql;

  // 1. Presentation/telemetry chronology (operator lists, logs, dashboards).
  if (!isDecisionScope) return 'DIAGNOSTIC';
  if (tables.every((t) => DIAGNOSTIC_TABLES.has(t) || t === 'activity_log')) return 'DIAGNOSTIC';

  // 2. Projection-data authority (tasks.status / task_dependencies as decision input).
  if (touchesProjection) return 'DELETE';

  // 3. Authority-by-max-id run adoption (factory-start resume/adoption).
  if (stmt.markers.includes('MAX_ID') && /factory-start\.ts$/.test(file)) return 'DELETE';

  // 4. Owner-internal monotonic sequence allocators (COALESCE(MAX(n),0)+1 inside
  //    the owning repository transaction) — counter allocation, not authority
  //    selection; moves into the aggregate command.
  if (/coalesce\s*\(\s*max\s*\([^)]*\)\s*,\s*-?\d+\s*\)\s*\+\s*1/i.test(sql) && /ORDER BY/.test(sql) === false) {
    return 'AUTHORITATIVE';
  }

  // 4b. Owner-internal counter reads/writes (next ordinal/attempt/sequence/
  //     revision/fence) without a newest-row selection: MAX over a counter
  //     column inside the owning repository is counter allocation or a CAS
  //     fence bump, not authority selection.
  const COUNTER_COL = /(ordinal|attempt_no|attempt\b|sequence_no|sequence\b|granted_revision|lease_fence)/i;
  if (COUNTER_COL.test(sql) && OWNING_REPO_RE.test(file) && !OWNING_REPO_EXCEPTIONS.has(file)) {
    const hasSelection = /order\s+by[^;]*desc/i.test(sql) || /limit\s+1\b/i.test(sql);
    if (!hasSelection) return 'AUTHORITATIVE';
  }

  // 5. Execution-status fence checks (exact live execution identity).
  if (stmt.markers.includes('EXECUTION_TABLE_OR_STATUS')
    && !stmt.markers.some((m) => ['ORDER_BY_ID_DESC', 'ORDER_BY_TIMESTAMP_DESC', 'MAX_ID', 'MAX_AGG', 'WINDOW_RANK', 'LATEST_TOKEN'].includes(m))
    && tables.every((t) => tableClassOf(t) === 'AUTHORITATIVE-AGGREGATE')) {
    return 'AUTHORITATIVE';
  }

  // 6. STATUS_PREDICATE over authoritative aggregate state machines
  //    (workplace loop/lifecycle/process status transitions): the owner's own
  //    state read is lawful; it moves to expected-revision commands.
  if (stmt.markers.every((m) => m === 'STATUS_PREDICATE' || m === 'LIMIT_1' || m === 'EXECUTION_TABLE_OR_STATUS')) {
    return 'AUTHORITATIVE';
  }

  // 7. Remaining chronology/latest-row-wins authority selection in the
  //    production path — the recency-selection class EK deletes.
  if (stmt.markers.some((m) => ['ORDER_BY_ID_DESC', 'ORDER_BY_TIMESTAMP_DESC', 'MAX_ID', 'MAX_AGG', 'MIN_ID', 'WINDOW_RANK', 'LATEST_TOKEN'].includes(m))) {
    return 'DELETE';
  }

  // 8. Plain status predicates already covered; default conservative.
  return 'AUTHORITATIVE';
}

function classifyReaderUse(stmt) {
  const tables = [...new Set([...stmt.reads])].filter((t) => !NON_TABLES.has(t));
  const kind = readerKindOf(stmt.file);
  const touchesProjection = tables.some((t) => PROJECTION_TABLES.has(t));
  if (kind === 'READ_PRESENTATION') return 'DIAGNOSTIC';
  if (touchesProjection) return 'DELETE';
  if (tables.every((t) => DIAGNOSTIC_TABLES.has(t))) return 'DIAGNOSTIC';
  return 'AUTHORITATIVE';
}

// ---------------------------------------------------------------------------
// Load scan and assemble.
// ---------------------------------------------------------------------------
// The builder is self-contained: it runs the tokenizer scan itself (fresh,
// deterministic) instead of requiring a pre-baked scan file. If
// .ek-tmp/sql-scan.json exists it is ignored; delete it freely.
import { scanFile } from './sql-literal-scanner.mjs';

function collectFiles() {
  const files = [];
  const SKIP = new Set(['node_modules', '.git', 'dist', '.factory-testbed', '.factory']);
  const visit = (abs, rel) => {
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      if (SKIP.has(path.basename(abs))) return;
      for (const n of fs.readdirSync(abs).sort()) visit(path.join(abs, n), path.join(rel, n));
      return;
    }
    if (/\.(ts|mts|cts|mjs|cjs|js)$/.test(abs) && !/\.d\.ts$/.test(abs)) files.push(rel.replace(/\\/g, '/'));
  };
  visit(path.join(ROOT, 'src'), 'src');
  visit(path.join(ROOT, 'tracker-view'), 'tracker-view');
  visit(path.join(ROOT, 'scripts'), 'scripts');
  return files;
}

const scannedFiles = collectFiles();
const allStatements = [];
for (const rel of scannedFiles) {
  try { allStatements.push(...scanFile(path.join(ROOT, rel), rel)); } catch (e) {
    console.error(`scan error ${rel}: ${e.message}`);
  }
}
const scan = { summary: { filesScanned: scannedFiles.length }, statements: allStatements };

const statements = scan.statements.filter(
  (s) => !['COMMIT', 'BEGIN', 'ROLLBACK', 'ATTACH', 'DETACH'].includes(s.verb),
);

const tables = {};
let unclosed = [];

for (const s of statements) {
  const touched = [...new Set([...s.reads, ...s.writes])].filter((t) => !NON_TABLES.has(t) && /^[a-z][a-z0-9_]*$/.test(t));
  for (const t of touched) {
    if (!(t in TABLE_FAMILY)) {
      unclosed.push({ table: t, file: s.file, line: s.line });
      continue;
    }
    const e = tables[t] ??= {
      family: TABLE_FAMILY[t],
      tableClass: tableClassOf(t),
      ddlOwners: [],
      writers: [],
      readers: [],
      markerUses: [],
    };
    if (['CREATE', 'ALTER', 'DROP'].includes(s.verb)) {
      e.ddlOwners.push({ file: s.file, line: s.line, verb: s.verb, disposition: 'delete' });
    } else if (['INSERT', 'UPDATE', 'DELETE'].includes(s.verb)) {
      e.writers.push({
        file: s.file, line: s.line, verb: s.verb, scope: s.scope,
        disposition: writerDispositionOf(t, s.file),
      });
    } else {
      const kind = readerKindOf(s.file);
      e.readers.push({
        file: s.file, line: s.line, scope: s.scope, kind,
        authorityClass: classifyReaderUse(s),
      });
    }
  }
  // marker uses are recorded against each touched table (dedup at emit)
}

if (unclosed.length) {
  console.error('UNCLASSIFIED TABLES (closed-vocabulary violation):');
  for (const u of unclosed) console.error(`  ${u.table} @ ${u.file}:${u.line}`);
  process.exit(1);
}

// Seed tables that own DDL but carry zero runtime data statements (inert
// tables — e.g. integration_intents) so the census covers the complete schema
// surface, not only the accessed surface.
for (const [t, family] of Object.entries(TABLE_FAMILY)) {
  if (tables[t]) continue;
  tables[t] = {
    family,
    tableClass: tableClassOf(t),
    ddlOwners: [],
    writers: [],
    readers: [],
    markerUses: [],
    inert: true,
    note: 'table declared in family map with zero SQL statements found in scanned scopes (inert or foreign-harness table); classified by family default',
  };
}

// marker statements (statement-level, once)
const markerUses = [];
for (const s of statements) {
  if (!s.markers.length) continue;
  const touched = [...new Set([...s.reads, ...s.writes])].filter((t) => !NON_TABLES.has(t) && /^[a-z][a-z0-9_]*$/.test(t));
  if (!touched.every((t) => t in TABLE_FAMILY)) continue;
  markerUses.push({
    file: s.file, line: s.line, verb: s.verb, markers: s.markers,
    tables: touched,
    authorityClass: classifyMarkerUse(s),
    disposition: classifyMarkerUse(s) === 'DELETE'
      ? (/PROJECTION/.test('') ? 'delete' : 'delete')
      : classifyMarkerUse(s) === 'DIAGNOSTIC' ? 'delete' : 'retain-and-move',
    sql: s.sql.slice(0, 600),
  });
}

// ---------------------------------------------------------------------------
// Hand-authored overlays (families, predecessor inputs, WP-16 sites).
// ---------------------------------------------------------------------------
import { FAMILY_RECORDS } from './census-overlays.mjs';

const counts = {
  sqlStatementsParsed: statements.length,
  distinctTables: Object.keys(tables).length,
  writerStatements: Object.values(tables).reduce((a, e) => a + e.writers.length, 0),
  readerStatements: Object.values(tables).reduce((a, e) => a + e.readers.length, 0),
  decisionReaderStatements: Object.values(tables).reduce((a, e) => a + e.readers.filter((r) => r.kind === 'READ_DECISION').length, 0),
  presentationReaderStatements: Object.values(tables).reduce((a, e) => a + e.readers.filter((r) => r.kind === 'READ_PRESENTATION').length, 0),
  markerUses: markerUses.length,
  markerUsesDelete: markerUses.filter((m) => m.authorityClass === 'DELETE').length,
  markerUsesAuthoritative: markerUses.filter((m) => m.authorityClass === 'AUTHORITATIVE').length,
  markerUsesDiagnostic: markerUses.filter((m) => m.authorityClass === 'DIAGNOSTIC').length,
};

const census = {
  $schema: 'ek1/authority-census/1',
  metadata: {
    workPackage: 'WP-01 (EK-1) — authority reader/writer census',
    baseSha: BASE_SHA,
    generatedBy: 'docs/refactoring/event-kernel/tools/sql-literal-scanner.mjs + census-builder.mjs + census-overlays.mjs',
    method: 'character-level lexer extracting complete string and template literals (escape- and substitution-aware), complete-statement splitting on top-level semicolons, verb/table/marker classification; repository-call attribution via file-level repository ownership; zero line-oriented grep classification',
    scopes: ['src/**/*.{ts,mts}', 'tracker-view/*.mjs', 'scripts/*.mjs'],
    filesScanned: scan.summary.filesScanned,
    predecessorReference: 'Phase-3.3 cross-boundary authority scan (1344 SQL literals) of docs/verification/ADR-053-CLOSURE-MATRIX-2026-08-25.md; this census re-scans the EK-0 base tree and goes broader (every table, every verb, writer/reader enumeration + WP-16 site census)',
  },
  enums: ENUMS,
  classificationSemantics: {
    authorityClass: {
      AUTHORITATIVE: 'the use is a lawful current-authority access of its owning fact (exact key, exact execution fence, owner-internal monotonic counter allocation, or the owner reading its own state machine); it moves into the target owner command',
      DIAGNOSTIC: 'the use is presentation/telemetry only (operator lists, dashboards, logs); it may survive as a projection/diagnostic read and may never authorize a transition',
      DELETE: 'the use selects or mutates authority through a channel the EK target model removes (task-status scheduling, projection-derived dependency state, recency/newest-row-wins selection, MAX(id) adoption, direct writes outside the owning aggregate); EK rewrites or deletes it',
    },
    disposition: {
      'retain-and-move': 'fact and its owning repository survive; they move to the new kernel package and protocol',
      'rewrite': 'the fact or access is re-expressed (recency selection -> exact revision; direct SQL writer -> typed owning command; journal -> event+obligation)',
      'delete': 'the fact, table, access path or writer is removed with its legacy composition at EK-8',
    },
    accessKind: {
      DDL: 'schema creation/mutation statement',
      WRITE: 'INSERT/UPDATE/DELETE data statement',
      READ_DECISION: 'read on a production decision path (dispatch, admission, settlement, recovery, gates, effects)',
      READ_PRESENTATION: 'read serving operator/UI/MCP query surfaces only',
    },
  },
  counts,
  factFamilies: FAMILY_RECORDS.factFamilies,
  predecessorInputs: FAMILY_RECORDS.predecessorInputs,
  roleResolutionSites: FAMILY_RECORDS.roleResolutionSites,
  promptAssemblySites: FAMILY_RECORDS.promptAssemblySites,
  tables,
  markerUses,
  residualRisks: FAMILY_RECORDS.residualRisks,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(census, null, 1));
console.error(`census written: ${OUT}`);
console.error(`counts: ${JSON.stringify(counts)}`);
