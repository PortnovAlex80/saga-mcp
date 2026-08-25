#!/usr/bin/env node
/**
 * sql-literal-scanner.mjs — WP-01 authority census extractor (EK-1).
 *
 * A real tokenizer (character-level lexer), NOT line-oriented grep:
 *  - lexes every source file char-by-char,
 *  - extracts COMPLETE string and template literals (escape-aware,
 *    template-nesting aware: `${...}` substitutions are captured as
 *    placeholders, with the inner expression re-lexed recursively so SQL
 *    built through concatenation is still attributed),
 *  - classifies each literal that carries SQL, splits COMPLETE statements on
 *    top-level semicolons (quote/comment aware),
 *  - records verb, tables read, tables written, and authority-selection
 *    markers (descending chronology, MAX(id), LIMIT 1, task-status
 *    predicates, projection reads).
 *
 * Output: JSON on stdout (or --out file) with one record per SQL statement.
 * Scope: src/** (production TypeScript) plus the production operator
 * surfaces tracker-view/*.mjs and scripts/factory*.mjs (engine supervisor /
 * spawn surfaces that hold durable writes), each record tagged with scope.
 *
 * Usage:
 *   node docs/refactoring/event-kernel/tools/sql-literal-scanner.mjs \
 *     --root <repo> [--out report.json]
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Lexer: extract string/template literals with positions.
// ---------------------------------------------------------------------------

/**
 * @param {string} src
 * @returns {{literals: Array<{kind:'string'|'template',quote:string,value:string,placeholders:string[],line:number,endLine:number,parts:Array<{type:'text'|'substitution',value:string}>}>}}
 */
export function lexLiterals(src) {
  const literals = [];
  let i = 0;
  const n = src.length;
  let line = 1;
  const bump = (ch) => { if (ch === '\n') line += 1; };

  const readString = (quote) => {
    // i points at opening quote
    const startLine = line;
    let value = '';
    i += 1;
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        const next = src[i + 1];
        bump(c); bump(next);
        // keep common escapes decoded; anything else kept raw
        if (next === 'n') value += '\n';
        else if (next === 't') value += '\t';
        else if (next === 'r') value += '\r';
        else if (next === '0') value += '\0';
        else if (next === '\n') value += '\n';
        else value += next ?? '';
        i += 2;
        continue;
      }
      if (c === quote) { i += 1; return { kind: 'string', quote, value, placeholders: [], line: startLine, endLine: line, parts: [{ type: 'text', value }] }; }
      if (c === '\n' && quote !== '`') {
        // unterminated single/double-quoted string across newline is illegal in TS
        return { kind: 'string', quote, value, placeholders: [], line: startLine, endLine: line, parts: [{ type: 'text', value }], unterminated: true };
      }
      bump(c);
      value += c;
      i += 1;
    }
    return { kind: 'string', quote, value, placeholders: [], line: startLine, endLine: line, parts: [{ type: 'text', value }], unterminated: true };
  };

  const readTemplate = () => {
    // i points at opening backtick
    const startLine = line;
    let text = '';
    const placeholders = [];
    const parts = [];
    i += 1;
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        const next = src[i + 1];
        bump(c); bump(next);
        if (next === 'n') text += '\n';
        else if (next === 't') text += '\t';
        else if (next === 'r') text += '\r';
        else if (next === '`') text += '`';
        else if (next === '$') text += '$';
        else text += next ?? '';
        i += 2;
        continue;
      }
      if (c === '`') {
        i += 1;
        if (text.length) parts.push({ type: 'text', value: text });
        return { kind: 'template', quote: '`', value: text, placeholders, line: startLine, endLine: line, parts, };
      }
      if (c === '$' && src[i + 1] === '{') {
        // substitution: capture inner source, recursively lex it, keep name
        if (text.length) { parts.push({ type: 'text', value: text }); text = '';; }
        i += 2;
        let depth = 1;
        let inner = '';
        while (i < n && depth > 0) {
          const d = src[i];
          if (d === '{') depth += 1;
          else if (d === '}') { depth -= 1; if (depth === 0) break; }
          bump(d);
          inner += d;
          i += 1;
        }
        i += 1; // consume }
        const name = inner.trim().replace(/\s+/g, ' ');
        placeholders.push(name);
        parts.push({ type: 'substitution', value: name });
        continue;
      }
      bump(c);
      text += c;
      i += 1;
    }
    return { kind: 'template', quote: '`', value: text, placeholders, line: startLine, endLine: line, parts, unterminated: true };
  };

  while (i < n) {
    const c = src[i];
    if (c === "'" || c === '"') { const lit = readString(c); literals.push(lit); continue; }
    if (c === '`') { const lit = readTemplate(); literals.push(lit); continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { bump(src[i]); i += 1; }
      i += 2;
      continue;
    }
    bump(c);
    i += 1;
  }
  return { literals };
}

// ---------------------------------------------------------------------------
// SQL statement splitting and classification.
// ---------------------------------------------------------------------------

const SQL_START_RE = /^\s*(select|insert|update|delete|with|replace|create|drop|alter|pragma|explain|vacuum|analyze|begin|commit|rollback|attach|detach)\b/i;

function looksLikeSql(text) {
  return SQL_START_RE.test(text);
}

/** Split a SQL literal into complete statements, respecting quotes/comments. */
export function splitStatements(sql) {
  const statements = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  let line = 1;
  while (i < n) {
    const c = sql[i];
    if (c === "'") { // SQL string
      cur += c; i += 1;
      while (i < n) {
        cur += sql[i];
        if (sql[i] === "'" && sql[i + 1] === "'") { cur += "'"; i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') { cur += sql[i]; i += 1; } continue; }
    if (c === '/' && sql[i + 1] === '*') { cur += '/*'; i += 2; while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) { if (sql[i] === '\n') line += 1; cur += sql[i]; i += 1; } cur += '*/'; i += 2; continue; }
    if (c === ';') {
      statements.push({ text: cur, lineOffset: line });
      cur = '';
      i += 1;
      continue;
    }
    if (c === '\n') line += 1;
    cur += c;
    i += 1;
  }
  if (cur.trim()) statements.push({ text: cur, lineOffset: line });
  return statements;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';

function verbOf(stmt) {
  const m = stmt.match(SQL_START_RE);
  if (!m) return 'OTHER';
  const v = m[1].toUpperCase();
  if (v === 'WITH') {
    // could be WITH ... SELECT or WITH ... INSERT/UPDATE/DELETE
    const tail = stmt.replace(/^\s*with\b/i, '');
    const m2 = tail.match(/\)\s*(select|insert|update|delete)\b/i);
    return m2 ? `WITH_${m2[1].toUpperCase()}` : 'WITH_SELECT';
  }
  return v;
}

function unquoteTable(t) {
  return t.replace(/[`"[]|]/g, '').trim();
}

/** Extract tables referenced, split into read set and write target. */
function tablesOf(stmt, verb) {
  const reads = new Set();
  const writes = new Set();
  const upper = verb.toUpperCase();
  const body = stmt;

  // INSERT INTO t / INSERT OR REPLACE INTO t
  for (const m of body.matchAll(new RegExp(`\\binsert\\s+(?:or\\s+\\w+\\s+)?into\\s+((?:${IDENT})\\.)?(${IDENT})`, 'ig'))) writes.add(unquoteTable(m[2]));
  // UPDATE t SET
  for (const m of body.matchAll(new RegExp(`\\bupdate\\s+(?:or\\s+\\w+\\s+)?((?:${IDENT})\\.)?(${IDENT})\\s+set`, 'ig'))) writes.add(unquoteTable(m[2]));
  // DELETE FROM t
  for (const m of body.matchAll(new RegExp(`\\bdelete\\s+from\\s+((?:${IDENT})\\.)?(${IDENT})`, 'ig'))) writes.add(unquoteTable(m[2]));
  // CREATE TABLE [IF NOT EXISTS] t / CREATE INDEX / TRIGGER / VIEW
  for (const m of body.matchAll(new RegExp(`\\bcreate\\s+(?:temp(?:orary)?\\s+)?(?:unique\\s+)?(?:table|view|trigger|index)\\s+(?:if\\s+not\\s+exists\\s+)?((?:${IDENT})\\.)?(${IDENT})`, 'ig'))) {
    const name = unquoteTable(m[2]);
    if (/^trg_|^idx_|_idx$|^sqlite_/i.test(name)) continue;
    writes.add(name); // schema-creating: recorded as write-scope marker
  }
  if (/^WITH/i.test(body) === false) {
    // FROM t / JOIN t (also catches DELETE FROM double counting, fine)
    for (const m of body.matchAll(new RegExp(`\\bfrom\\s+((?:${IDENT})\\.)?(${IDENT})`, 'ig'))) {
      const name = unquoteTable(m[2]);
      if (name.toUpperCase() === 'DUAL') continue;
      if (/^(select|values)$/i.test(name)) continue;
      reads.add(name);
    }
  } else {
    for (const m of body.matchAll(new RegExp(`\\b(?:from|join)\\s+((?:${IDENT})\\.)?(${IDENT})`, 'ig'))) {
      const name = unquoteTable(m[2]);
      if (/^(select|values|with)$/i.test(name)) continue;
      reads.add(name);
    }
  }
  for (const m of body.matchAll(new RegExp(`\\bjoin\\s+((?:${IDENT})\\.)?(${IDENT})`, 'ig'))) reads.add(unquoteTable(m[2]));
  // writes.remove from reads when it's the mutation target only
  return { reads: [...reads], writes: [...writes] };
}

/** Authority-selection markers. */
function markersOf(stmt) {
  const markers = [];
  const s = stmt.replace(/\s+/g, ' ');
  if (/order\s+by\s+[^\n]*?\bid\b[^\n]*?desc/i.test(s) || /order\s+by\s+[^\n]*?_id\b[^\n]*?desc/i.test(s)) markers.push('ORDER_BY_ID_DESC');
  if (/order\s+by\s+\w*(created|updated|sealed|accepted|started|at|time|ts)\w*\s+desc/i.test(s)) markers.push('ORDER_BY_TIMESTAMP_DESC');
  if (/\bmax\s*\(/i.test(s) && /\bid\b|max\(\s*\w+_id/i.test(s)) markers.push('MAX_ID');
  if (/\bmax\s*\(/i.test(s)) markers.push('MAX_AGG');
  if (/limit\s+1\b/i.test(s)) markers.push('LIMIT_1');
  if (/\bt\.?status\b|\btasks\.status\b|\btask_status\b|\bstatus\s*(=|in|!=|<>)\s*\(?['"(]/i.test(s)) markers.push('STATUS_PREDICATE');
  if (/\bworker_executions\b|\bexecution_status\b|\bexecutions\.status\b|\bestatus\b/i.test(s)) markers.push('EXECUTION_TABLE_OR_STATUS');
  if (/\blatest\b|\bnewest\b|\bmost\s+recent\b/i.test(s)) markers.push('LATEST_TOKEN');
  if (/\brow_number\s*\(\s*\)\s+over\b|\brank\s*\(\s*\)\s+over\b/i.test(s)) markers.push('WINDOW_RANK');
  if (/\bmin\s*\(\s*\w+_?id\s*\)/i.test(s)) markers.push('MIN_ID');
  return markers;
}

// ---------------------------------------------------------------------------
// File walking + scope tagging.
// ---------------------------------------------------------------------------

function walk(root, rel, out) {
  const abs = path.join(root, rel);
  let st;
  try { st = fs.statSync(abs); } catch { return; }
  if (st.isDirectory()) {
    const SKIP = new Set(['node_modules', '.git', 'dist', '.factory-testbed', '.factory']);
    if (SKIP.has(path.basename(abs))) return;
    for (const name of fs.readdirSync(abs).sort()) walk(root, path.join(rel, name), out);
    return;
  }
  if (/\.(ts|mts|cts|mjs|cjs|js)$/.test(abs) && !/\.d\.ts$/.test(abs)) out.push(rel.replace(/\\/g, '/'));
}

function scopeOf(rel) {
  if (rel.startsWith('src/')) return 'src';
  if (rel.startsWith('tracker-view/')) return 'tracker-view';
  if (rel.startsWith('scripts/')) return 'scripts';
  if (rel.startsWith('tools/')) return 'tools';
  return 'other';
}

// Fact-family table map (kept in one place so the census JSON and scanner agree).
export const FACT_FAMILY_BY_TABLE = {
  // project / order / run identity
  projects: 'project-order-run', repositories: 'project-order-run', project_repositories: 'project-order-run',
  repository_checkouts: 'project-order-run', epics: 'project-order-run', episode_workflows: 'project-order-run',
  factory_orders: 'project-order-run', factory_order_runs: 'project-order-run',
  factory_launch_requests: 'project-order-run', factory_launch_controller_terms: 'project-order-run',
  factory_launch_controller_leases: 'project-order-run', factory_runtime_mode: 'project-order-run',
  factory_database_identity: 'project-order-run',
  // lifecycle / stage
  factory_lifecycle_runs: 'lifecycle', lifecycle_events: 'lifecycle', lifecycle_execution_controls: 'lifecycle',
  factory_stage_runs: 'stage', factory_continuation_authorizations: 'stage',
  factory_continuation_prefix_stages: 'stage', factory_protocol_runs: 'lifecycle', factory_protocol_step_runs: 'lifecycle',
  // process
  factory_process_runs: 'process', factory_process_transitions: 'process', factory_process_products: 'process',
  factory_process_outcome_certificates: 'process', factory_process_module_installations: 'process',
  factory_module_installations: 'process', factory_scenario_installations: 'process', factory_scenario_module_locks: 'process',
  // node
  factory_node_runs: 'node', factory_call_instances: 'node', factory_work_intents: 'node',
  // work item / task
  tasks: 'workitem-task', subtasks: 'workitem-task', task_dependencies: 'workitem-task',
  task_conflict_keys: 'workitem-task', factory_workplace_graphs: 'workitem-task',
  factory_workplace_graph_items: 'workitem-task', factory_workplace_dependencies: 'workitem-task',
  // workplace
  factory_workplaces: 'workplace', factory_workplace_park_reasons: 'workplace', factory_worker_stops: 'workplace',
  factory_operator_holds: 'workplace', factory_workplace_recovery_epochs: 'workplace',
  factory_scope_widening_events: 'workplace', factory_workplace_contributions: 'workplace',
  factory_workplace_gate_decision_heads: 'workplace', factory_workplace_production_revisions: 'material',
  // execution / attempt
  worker_executions: 'execution-attempt', factory_execution_reservations: 'execution-attempt',
  factory_execution_completion_products: 'execution-attempt',
  factory_worker_loss_resume_authorizations: 'recovery', factory_worker_loss_resume_consumptions: 'recovery',
  // material (products/revisions/candidates)
  artifacts: 'material', artifact_traces: 'material', factory_sealed_product_materials: 'material',
  factory_sealed_product_aliases: 'material', factory_candidate_sets: 'material',
  factory_candidate_set_members: 'material', factory_accepted_authority_head: 'material',
  factory_effective_desk_base_receipts: 'material', verification_evidence: 'material',
  trusted_providers: 'material', factory_managed_artifact_productions: 'material',
  factory_managed_trace_productions: 'material', factory_managed_node_submissions: 'material',
  factory_final_presentation_commitments: 'material', factory_production_adoption_decisions: 'material',
  factory_development_verification_adoptions: 'material',
  factory_authorized_verification_observations: 'material',
  factory_author_candidate_carry_forward_authorizations: 'material',
  factory_author_candidate_carry_forward_consumptions: 'material',
  factory_author_candidate_carry_forward_reauthorizations: 'material',
  // gates / checks
  factory_gate_runs: 'gate', factory_gate_presentation_attempts: 'gate', factory_check_receipts: 'gate',
  factory_gate_decisions: 'gate', factory_gate_finding_set_chain: 'gate',
  // effects
  factory_effect_attempts: 'effect', factory_cell_effect_receipts: 'effect',
  factory_cell_effect_repair_issues: 'effect', factory_external_effect_actions: 'effect',
  factory_external_effect_events: 'effect',
  // acceptance / terminal
  factory_cell_final_acceptances: 'terminal-acceptance', factory_run_terminal_event_receipts: 'terminal-acceptance',
  // obligation
  factory_transition_obligations: 'obligation',
  // recovery / checkpoint
  factory_adoptions: 'recovery', factory_resume_directives: 'recovery',
  factory_operator_recovery_authorizations: 'recovery', factory_operator_recovery_consumptions: 'recovery',
  factory_orphaned_launch_recovery_receipts: 'recovery', factory_automatic_spawn_recovery_receipts: 'recovery',
  factory_failed_gate_recovery_authorizations: 'recovery', factory_failed_gate_recovery_consumptions: 'recovery',
  factory_recovery_attempts: 'recovery', factory_recovery_cases: 'recovery',
  factory_checkpoints: 'checkpoint',
  // projections / diagnostics / catalog
  comments: 'projection-diagnostic', templates: 'projection-diagnostic', notes: 'projection-diagnostic',
  activity_log: 'projection-diagnostic', runtime_observations: 'projection-diagnostic',
  factory_artifact_drift_events: 'projection-diagnostic', human_requests: 'projection-diagnostic',
  integration_intents: 'projection-diagnostic', command_receipts: 'projection-diagnostic',
  factory_definition_compatibility_receipts: 'projection-diagnostic',
  factory_submission_validation_receipts: 'projection-diagnostic',
  factory_submission_validation_rejections: 'projection-diagnostic',
  factory_workshop_binding_receipts: 'projection-diagnostic',
  factory_engine_watchdog_events: 'projection-diagnostic',
  // workshop-owned settlement/output tables (created by modules/*)
  factory_replay_capsules: 'material', factory_replay_capsule_invalidations: 'material',
  factory_formalization_acceptance_baselines: 'material',
  factory_formalization_solution_contracts: 'material',
  factory_delivery_outputs: 'material', factory_development_outputs: 'material',
  factory_documentation_bundles: 'material',
  factory_development_task_projections: 'workitem-task',
  factory_delivery_approval_requests: 'obligation',
  factory_delivery_approval_decisions: 'obligation',
  factory_reconciliation_records: 'workplace', factory_replan_mandates: 'workplace',
  supervision_locks: 'workplace',
};

export function factFamilyOfTable(table) {
  return FACT_FAMILY_BY_TABLE[table] ?? null;
}

// ---------------------------------------------------------------------------
// Main scan.
// ---------------------------------------------------------------------------

export function scanFile(absPath, rel) {
  const src = fs.readFileSync(absPath, 'utf8');
  const { literals } = lexLiterals(src);
  const records = [];
  for (const lit of literals) {
    // Reassemble template text with a ?placeholder so statements stay parseable
    const text = lit.parts.map((p) => (p.type === 'text' ? p.value : ' ? ')).join('');
    if (!looksLikeSql(text)) continue;
    // Reject TS-looking strings that merely start with a SQL keyword (e.g. 'delete me')
    const sqlish = text.length >= 8 && /\b(from|into|set|table|values|index|trigger|select)\b/i.test(text);
    if (!sqlish) continue;
    for (const stmtInfo of splitStatements(text)) {
      const stmt = stmtInfo.text;
      if (!stmt.trim()) continue;
      const verb = verbOf(stmt);
      if (verb === 'OTHER') continue;
      const { reads, writes } = tablesOf(stmt, verb);
      const markers = markersOf(stmt);
      // count newlines before statement start for accurate start line
      const head = text.slice(0, text.indexOf(stmt));
      const extraLines = head ? (head.match(/\n/g) || []).length : 0;
      records.push({
        file: rel,
        scope: scopeOf(rel),
        line: lit.line + extraLines,
        literalLine: lit.line,
        kind: lit.kind,
        verb,
        reads,
        writes,
        markers,
        isDDL: /^CREATE|^DROP|^ALTER|^PRAGMA/i.test(verb) || verb.startsWith('CREATE'),
        sql: stmt.trim().slice(0, 2000),
      });
    }
  }
  return records;
}

export function main() {
  const args = process.argv.slice(2);
  let root = process.cwd();
  let out = null;
  for (let k = 0; k < args.length; k++) {
    if (args[k] === '--root') root = path.resolve(args[++k]);
    else if (args[k] === '--out') out = args[++k];
  }
  const files = [];
  walk(root, 'src', files);
  walk(root, 'tracker-view', files);
  walk(root, 'scripts', files);
  const all = [];
  for (const rel of files) {
    try { all.push(...scanFile(path.join(root, rel), rel)); } catch (e) {
      console.error(`scan error ${rel}: ${e.message}`);
    }
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    root: path.resolve(root).replace(/\\/g, '/'),
    filesScanned: files.length,
    statements: all.length,
    byScope: {},
    byVerb: {},
  };
  for (const r of all) {
    summary.byScope[r.scope] = (summary.byScope[r.scope] ?? 0) + 1;
    summary.byVerb[r.verb] = (summary.byVerb[r.verb] ?? 0) + 1;
  }
  const payload = { summary, statements: all };
  const json = JSON.stringify(payload, null, 1);
  if (out) fs.writeFileSync(out, json);
  else process.stdout.write(json);
  console.error(`scanned ${files.length} files -> ${all.length} SQL statements`);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file:///${path.resolve(process.argv[1]).replace(/\\/g, '/')}`).href;
if (isMain) {
  main();
}
