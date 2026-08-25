#!/usr/bin/env node
/**
 * measure-complexity.mjs — EK-1 complexity-budget measurement driver (WP-16 part 1).
 *
 * Measures the complexity vector of the CURRENT tree for every dimension in
 * docs/refactoring/event-kernel/specs/complexity-budget.json:
 *
 *   - predecessor-baseline dimensions are measured NOW from
 *     ./frozen-inputs/authority-census.json (WP-01 census),
 *     ./frozen-inputs/transition-universe.json (EK-1 frozen universe) and
 *     deterministic scans of the live tree;
 *   - new-kernel dimensions (contract-shape schemas that do not exist before
 *     WP-16 part 2 / WP-17) emit TARGET-ONLY entries in the full vector, and
 *     their single-dimension measurement command FAILS LOUDLY (exit 2,
 *     COMPLEXITY_DIMENSION_UNMEASURABLE_BEFORE_KERNEL) until the measured
 *     artifact exists. They never silently pass.
 *
 * Lawful/bypass split (operator review item 3, budget revision rev2): the
 * dimensions that count SQL statements against new-kernel aggregates
 * (authority.decisionReaderStatements, authority.decisionWriterStatements,
 * authority.projectionAuthorityReads) split every count into
 *   lawful — statements inside the owning repository file of the aggregate
 *            whose tables they touch (src/workflow-kernel/persistence/
 *            <aggregate>-repository.ts, the EK-3 sole-writer repositories),
 *   bypass — the same statements anywhere else.
 * The target binds on bypass == 0; lawful is bounded by the repository-count
 * dimensions instead. Before src/workflow-kernel exists the vector already
 * emits the split columns with bypass = frozen-census total, lawful = 0 (no
 * lawful owner exists on the predecessor tree), so --check binds on the
 * bypass column the moment the kernel lands. The aggregate->table-prefix map
 * and projection-table set are declared in complexity-budget.json
 * (lawfulRepositoryConvention) and re-proved against the frozen universe
 * (aggregates) and frozen census (PROJECTION class) on every run.
 *
 * Determinism contract (plan: "Run deterministic measurements twice on the same
 * tree and require the same complexity vector"): no clock, no randomness, no
 * absolute paths in the output, every directory iteration sorted, canonical
 * 2-space JSON with a trailing newline. Two runs on one tree MUST be
 * byte-identical; proving it:
 *
 *   node docs/refactoring/event-kernel/specs/measure-complexity.mjs --out run1.json
 *   node docs/refactoring/event-kernel/specs/measure-complexity.mjs --out run2.json
 *   cmp run1.json run2.json
 *
 * Usage:
 *   measure-complexity.mjs                      full vector JSON to stdout
 *   measure-complexity.mjs --out <file>         full vector JSON to <file>
 *   measure-complexity.mjs --dimension <id>     one dimension (target-only
 *                                               dimensions fail loudly before
 *                                               the kernel exists)
 *   measure-complexity.mjs --check              evaluate measured values against
 *                                               targets (binding only once
 *                                               src/workflow-kernel exists;
 *                                               predecessor exceedances are
 *                                               reported as expected diagnostics)
 *   measure-complexity.mjs --selftest           validate the budget structure,
 *                                               mandated-dimension coverage and
 *                                               frozen-input digests (seed of the
 *                                               WP-16 part 3 mutation tests)
 *
 * Exit codes: 0 ok; 1 validation failure / unknown dimension / --check
 * violation on a kernel tree; 2 COMPLEXITY_DIMENSION_UNMEASURABLE_BEFORE_KERNEL.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SPECS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SPECS_DIR, '..', '..', '..', '..');
const BUDGET_PATH = path.join(SPECS_DIR, 'complexity-budget.json');
const FROZEN_INPUTS_PATH = path.join(SPECS_DIR, 'frozen-inputs', 'FROZEN-INPUTS.json');
const KERNEL_ROOT = path.join(REPO_ROOT, 'src', 'workflow-kernel');
const REL = (p) => p.replaceAll('\\', '/');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    fail(1, `COMPLEXITY_INPUT_UNREADABLE: ${REL(path.relative(REPO_ROOT, p))}: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic tree helpers (every iteration is sorted)              */
/* ------------------------------------------------------------------ */

function listFiles(dir, filter, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(p, filter, acc);
    else if (!filter || filter(entry.name)) acc.push(p);
  }
  return acc;
}

const PROD_SOURCE = (name) => /\.(ts|mjs|js)$/.test(name) && !/\.test\.|\.spec\.|\/node_modules\//.test(name);

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

/* ------------------------------------------------------------------ */
/* Frozen-input integrity                                             */
/* ------------------------------------------------------------------ */

function verifyFrozenInputs() {
  const manifest = readJson(FROZEN_INPUTS_PATH);
  const digests = {};
  for (const input of manifest.inputs) {
    const p = path.join(SPECS_DIR, 'frozen-inputs', input.file);
    const actual = sha256(readFileSync(p, 'utf8'));
    if (actual !== input.sha256) {
      fail(
        1,
        `FROZEN_INPUT_DIGEST_MISMATCH: ${input.file}: expected ${input.sha256}, found ${actual}. ` +
          `Frozen EK-1 artifacts are read-only; a digest change is an ABORT condition (investigate, never edit back).`,
      );
    }
    digests[input.file] = actual;
  }
  return { manifest, digests };
}

/* ------------------------------------------------------------------ */
/* Budget validation (structure + mandated coverage)                   */
/* ------------------------------------------------------------------ */

const MANDATED_DIMENSIONS = [
  // [plan-mandated dimension label, exact required dimension id]
  ['mutable owners/reducers (fan-in)', 'authority.mutableOwnerFanInFiles'],
  ['mutable owners/reducers (aggregate count)', 'authority.mutableOwnerAggregates'],
  ['authoritative relations', 'authority.authoritativeRelationKinds'],
  ['decision readers', 'authority.decisionReaderStatements'],
  ['projection-authority reads (hard target 0)', 'authority.projectionAuthorityReads'],
  ['decision writers', 'authority.decisionWriterStatements'],
  ['command kinds', 'protocol.commandKinds'],
  ['event kinds', 'protocol.eventKinds'],
  ['obligation kinds', 'protocol.obligationKinds'],
  ['wait kinds', 'protocol.waitKinds'],
  ['proof kinds', 'protocol.proofKinds'],
  ['evidence kinds', 'protocol.evidenceKinds'],
  ['orchestration entrypoints (hard target 1)', 'composition.orchestrationEntrypoints'],
  ['obligation-consumer implementations (hard target 1)', 'composition.obligationConsumerImplementations'],
  ['role-binding authorities (hard target 1)', 'roles.bindingAuthorities'],
  ['prompt/context assemblers (hard target 1)', 'prompts.assemblers'],
  ['prompt/context accountants (hard target 1)', 'prompts.cumulativeAccountants'],
  ['static prompt bytes (max asset)', 'prompts.staticPromptAssetMaxBytes'],
  ['static prompt bytes (total)', 'prompts.staticPromptAssetTotalBytes'],
  ['workshop-name branches (hard target 0)', 'workshops.nameBranchLiterals'],
  ['workshop-owned schedulers (hard target 0)', 'workshops.ownedSchedulerImplementations'],
  ['new runtime dependencies (hard target 0 new)', 'deps.runtimeDependencySet'],
  ['temporary legacy/replacement debt (hard target 0 after EK-8)', 'debt.temporaryLegacySurfaces'],
  ['route declarative rule count', 'route.declarativeRuleCount'],
  ['route condition-key universe', 'route.conditionKeyUniverse'],
  ['route branch count', 'route.imperativeBranchSites'],
  ['route serialized bytes', 'route.serializedPolicyBytes'],
  ['contract field count (role contract)', 'contract.roleContractFieldCount'],
  ['contract field count (prompt budget profile)', 'contract.promptBudgetProfileFieldCount'],
  ['contract schema alternatives', 'contract.schemaAlternatives'],
  ['contract reference fan-out', 'contract.maxReferenceFanOut'],
  ['contract maximum depth', 'contract.maxNestingDepth'],
  ['policy-reference kinds', 'contract.policyReferenceKinds'],
  ['arbitrary metadata fields', 'contract.arbitraryMetadataFields'],
  ['execution phase count cap (14)', 'structure.phaseCount'],
  ['top-level package count cap (24)', 'structure.topLevelPackageCount'],
];

/* ------------------------------------------------------------------ */
/* Lawful-repository convention (budget revision rev2)                  */
/* ------------------------------------------------------------------ */

const kebabCase = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

function ownerRepositoryFile(aggregate) {
  return `src/workflow-kernel/persistence/${kebabCase(aggregate)}-repository.ts`;
}

function tableBelongsTo(table, prefix) {
  return table === prefix || table === `${prefix}s` || table.startsWith(`${prefix}_`);
}

function validateLawfulRepositoryConvention(budget, { universeAggregates, censusProjectionTables }) {
  const problems = [];
  const conv = budget.lawfulRepositoryConvention;
  if (!conv || typeof conv !== 'object') {
    return ['lawfulRepositoryConvention block is missing from complexity-budget.json (budget revision rev2 requires it)'];
  }
  for (const key of ['repositoryFilePattern', 'aggregateTablePrefixes', 'tableBelongsRule', 'projectionTables', 'kernelScope', 'scannedScopes']) {
    if (conv[key] === undefined) problems.push(`lawfulRepositoryConvention: missing required key "${key}"`);
  }
  if (problems.length) return problems;
  if (String(conv.repositoryFilePattern) !== 'src/workflow-kernel/persistence/<aggregate>-repository.ts') {
    problems.push('lawfulRepositoryConvention.repositoryFilePattern must be exactly src/workflow-kernel/persistence/<aggregate>-repository.ts');
  }
  const prefixEntries = Object.entries(conv.aggregateTablePrefixes);
  if (prefixEntries.length === 0) problems.push('lawfulRepositoryConvention.aggregateTablePrefixes must not be empty');
  for (const [aggregate, prefix] of prefixEntries) {
    if (!/^[a-z][a-z0-9_]*$/.test(String(prefix))) {
      problems.push(`lawfulRepositoryConvention.aggregateTablePrefixes.${aggregate}: prefix "${prefix}" must be a lowercase snake_case identifier`);
    }
  }
  // The declared aggregate set must be EXACTLY the frozen universe's aggregates.
  const declared = [...prefixEntries.map(([a]) => a)].sort();
  const frozen = [...universeAggregates].sort();
  if (declared.length !== frozen.length || declared.some((a, i) => a !== frozen[i])) {
    problems.push(
      `lawfulRepositoryConvention.aggregateTablePrefixes keys [${declared.join(', ')}] must exactly equal the frozen universe aggregates [${frozen.join(', ')}] (transition-universe.json aggregates[].name)`,
    );
  }
  // Prefixes must be unique and pairwise non-colliding under the boundary rule.
  const prefixes = prefixEntries.map(([, p]) => String(p)).sort();
  if (new Set(prefixes).size !== prefixes.length) problems.push('lawfulRepositoryConvention.aggregateTablePrefixes: duplicate prefixes are forbidden');
  for (const p1 of prefixes) {
    for (const p2 of prefixes) {
      if (p1 !== p2 && tableBelongsTo(p1, p2)) {
        problems.push(`lawfulRepositoryConvention.aggregateTablePrefixes: prefix "${p1}" collides with prefix "${p2}" under the boundary rule`);
      }
    }
  }
  // The declared projection-table set must be EXACTLY the census PROJECTION class ...
  const declaredProj = [...conv.projectionTables].sort();
  const frozenProj = [...censusProjectionTables].sort();
  if (declaredProj.length !== frozenProj.length || declaredProj.some((t, i) => t !== frozenProj[i])) {
    problems.push(
      `lawfulRepositoryConvention.projectionTables [${declaredProj.join(', ')}] must exactly equal the frozen census PROJECTION class [${frozenProj.join(', ')}] (authority-census.json tables[t].tableClass === 'PROJECTION')`,
    );
  }
  // ... and no projection table may belong to an aggregate (no dual classification).
  for (const table of conv.projectionTables) {
    const owner = prefixEntries.find(([, p]) => tableBelongsTo(String(table), String(p)));
    if (owner) problems.push(`lawfulRepositoryConvention: projection table "${table}" also belongs to aggregate ${owner[0]} — dual classification is forbidden`);
  }
  return problems;
}

function validateBudget(budget, frozenAnchors) {
  const problems = [];
  if (!Array.isArray(budget.dimensions) || budget.dimensions.length === 0) {
    problems.push('dimensions array is missing or empty');
  }
  const ids = new Set();
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  for (const dim of budget.dimensions || []) {
    for (const key of ['id', 'group', 'title', 'planMandate', 'baseline', 'target', 'measurementCommand', 'rationale', 'accountableWorkPackage']) {
      if (dim[key] === undefined) problems.push(`dimension ${dim.id ?? '<no id>'}: missing required key "${key}"`);
    }
    if (ids.has(dim.id)) problems.push(`duplicate dimension id: ${dim.id}`);
    ids.add(dim.id);
    if (!(dim.id in MEASURES)) problems.push(`dimension ${dim.id}: no measurement implementation registered in measure-complexity.mjs`);
    const t = dim.target || {};
    if (!['max', 'exact', 'closed-set', 'subset-of-frozen', 'zero-after-phase'].includes(t.kind)) {
      problems.push(`dimension ${dim.id}: target.kind must be max|exact|closed-set|subset-of-frozen|zero-after-phase`);
    }
    if (t.kind === 'closed-set') {
      if (!Array.isArray(t.value) || t.value.length === 0 || !t.value.every((v) => typeof v === 'string')) {
        problems.push(`dimension ${dim.id}: closed-set target needs a non-empty string array`);
      }
    } else if (t.kind === 'subset-of-frozen') {
      if (!Array.isArray(t.value) || t.value.length === 0) {
        problems.push(`dimension ${dim.id}: subset-of-frozen target needs the frozen allowed set`);
      }
    } else if (!finite(t.value)) {
      problems.push(`dimension ${dim.id}: target.value must be a finite number (waivers and unbounded targets are forbidden)`);
    }
    if (typeof dim.measurementCommand !== 'string' || !dim.measurementCommand.includes('measure-complexity.mjs')) {
      problems.push(`dimension ${dim.id}: measurementCommand must invoke measure-complexity.mjs`);
    }
    const baselineOk = dim.baseline?.value === null
      || typeof dim.baseline?.value === 'number'
      || (dim.target?.kind === 'closed-set' && Array.isArray(dim.baseline?.value) && dim.baseline.value.every((v) => typeof v === 'string'));
    if (!baselineOk) {
      problems.push(`dimension ${dim.id}: baseline.value must be a number, a string array (closed-set dimensions) or null (explicitly null when unmeasurable before the kernel)`);
    }
    if (!dim.rationale || String(dim.rationale).length < 20) {
      problems.push(`dimension ${dim.id}: rationale must be substantive`);
    }
    if (!/^WP-/.test(String(dim.accountableWorkPackage))) {
      problems.push(`dimension ${dim.id}: accountableWorkPackage must name a WP-xx package`);
    }
  }
  for (const [mandate, requiredId] of MANDATED_DIMENSIONS) {
    if (!ids.has(requiredId)) problems.push(`mandated dimension missing from budget: "${mandate}" requires dimension id "${requiredId}" (plan "Bounded successor complexity" + hard targets)`);
  }
  for (const measureId of Object.keys(MEASURES)) {
    if (!ids.has(measureId)) problems.push(`orphan measurement implementation: ${measureId} exists in measure-complexity.mjs but no budget dimension declares it`);
  }
  if (budget.waivers && (budget.waivers.active ?? 0) !== 0) {
    problems.push('active complexity waivers are forbidden (plan EK-1/EK-13)');
  }
  problems.push(...validateLawfulRepositoryConvention(budget, frozenAnchors));
  return problems;
}

/* ------------------------------------------------------------------ */
/* Measurement registry                                                */
/* ------------------------------------------------------------------ */

const census = () => readJson(path.join(SPECS_DIR, 'frozen-inputs', 'authority-census.json'));
const universe = () => readJson(path.join(SPECS_DIR, 'frozen-inputs', 'transition-universe.json'));

function censusReaderStats(c) {
  let decision = 0;
  let decisionDelete = 0;
  let total = 0;
  for (const rec of Object.values(c.tables)) {
    for (const r of rec.readers || []) {
      total += 1;
      if (r.kind === 'READ_DECISION') {
        decision += 1;
        if (r.authorityClass === 'DELETE') decisionDelete += 1;
      }
    }
  }
  return { total, decision, decisionDelete };
}

function censusWriterStats(c) {
  let total = 0;
  let deleteDisposition = 0;
  const byScope = {};
  let maxFanIn = 0;
  let maxFanInTable = null;
  for (const [table, rec] of Object.entries(c.tables)) {
    const files = new Set((rec.writers || []).map((w) => w.file));
    if (files.size > maxFanIn) { maxFanIn = files.size; maxFanInTable = table; }
    for (const w of rec.writers || []) {
      total += 1;
      byScope[w.scope] = (byScope[w.scope] || 0) + 1;
      if (w.disposition === 'delete') deleteDisposition += 1;
    }
  }
  return { total, deleteDisposition, byScope, maxFanIn, maxFanInTable };
}

function countVerdicts(sites) {
  const tally = { DELETE: 0, REWRITE: 0, 'RETAIN-AND-MOVE': 0 };
  for (const s of sites) {
    const v = String(s.censusVerdict || '');
    if (v.includes('RETAIN-AND-MOVE')) tally['RETAIN-AND-MOVE'] += 1;
    else if (v.includes('REWRITE')) tally.REWRITE += 1;
    else if (v.includes('DELETE')) tally.DELETE += 1;
  }
  return tally;
}

/* ------------------------------------------------------------------ */
/* Direct-SQL ownership scan (lawful/bypass split, budget rev2)         */
/*                                                                     */
/* Reduced, self-contained form of the WP-01 census lexer: extracts    */
/* complete string/template literals (escape-aware, `${...}`           */
/* substitutions replaced by " ? "), keeps those that start a SQL      */
/* data statement (select/insert/update/delete/with/replace), splits   */
/* complete statements on top-level semicolons (quote/comment-aware),  */
/* and records verb + tables read + tables written per statement.      */
/* Deterministic: sorted file iteration only, no clock, no paths in    */
/* output. DDL (CREATE/ALTER/DROP) is out of scope: the EK-3           */
/* declarative schema bootstrap is a separate sanctioned surface.      */
/* ------------------------------------------------------------------ */

const SQL_DATA_START_RE = /^\s*(select|insert|update|delete|with|replace)\b/i;

function lexStringLiterals(src) {
  const literals = [];
  let i = 0;
  const n = src.length;
  let line = 1;
  const push = (value, startLine) => { if (value.trim()) literals.push({ value, line: startLine }); };
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line += 1; i += 1; }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const startLine = line;
      const quote = c;
      let value = '';
      i += 1;
      while (i < n) {
        const d = src[i];
        if (d === '\\') {
          const nx = src[i + 1] ?? '';
          if (nx === 'n') value += '\n';
          else if (nx === 't') value += '\t';
          else value += nx;
          if (nx === '\n') line += 1;
          i += 2;
          continue;
        }
        if (d === quote) { i += 1; break; }
        if (d === '\n') line += 1;
        value += d;
        i += 1;
      }
      push(value, startLine);
      continue;
    }
    if (c === '`') {
      const startLine = line;
      let value = '';
      i += 1;
      while (i < n) {
        const d = src[i];
        if (d === '\\') {
          const nx = src[i + 1] ?? '';
          value += nx;
          if (nx === '\n') line += 1;
          i += 2;
          continue;
        }
        if (d === '`') { i += 1; break; }
        if (d === '$' && src[i + 1] === '{') {
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            const e = src[i];
            if (e === '{') depth += 1;
            else if (e === '}') { depth -= 1; if (depth === 0) break; }
            if (e === '\n') line += 1;
            i += 1;
          }
          i += 1;
          value += ' ? ';
          continue;
        }
        if (d === '\n') line += 1;
        value += d;
        i += 1;
      }
      push(value, startLine);
      continue;
    }
    i += 1;
  }
  return literals;
}

function splitSqlStatements(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      cur += c;
      i += 1;
      while (i < n) {
        cur += sql[i];
        if (sql[i] === "'" && sql[i + 1] === "'") { cur += "'"; i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') { cur += sql[i]; i += 1; } continue; }
    if (c === '/' && sql[i + 1] === '*') {
      cur += '/*';
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) { cur += sql[i]; i += 1; }
      cur += '*/';
      i += 2;
      continue;
    }
    if (c === ';') { out.push(cur); cur = ''; i += 1; continue; }
    cur += c;
    i += 1;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const SQL_IDENT = '[A-Za-z_][A-Za-z0-9_]*';

function sqlVerbOf(stmt) {
  const m = stmt.match(SQL_DATA_START_RE);
  if (!m) return null;
  const v = m[1].toUpperCase();
  if (v === 'WITH') {
    const tail = stmt.replace(/^\s*with\b/i, '');
    const m2 = tail.match(/\)\s*(select|insert|update|delete)\b/i);
    return `WITH_${m2 ? m2[1].toUpperCase() : 'SELECT'}`;
  }
  return v;
}

function sqlTablesOf(stmt) {
  const reads = new Set();
  const writes = new Set();
  const rx = (re) => { for (const m of stmt.matchAll(re)) reads.add(m[1]); };
  const wx = (re) => { for (const m of stmt.matchAll(re)) writes.add(m[1]); };
  wx(new RegExp(`\\binsert\\s+(?:or\\s+\\w+\\s+)?into\\s+(?:${SQL_IDENT}\\.)?(${SQL_IDENT})`, 'ig'));
  wx(new RegExp(`\\bupdate\\s+(?:or\\s+\\w+\\s+)?(?:${SQL_IDENT}\\.)?(${SQL_IDENT})\\s+set`, 'ig'));
  wx(new RegExp(`\\bdelete\\s+from\\s+(?:${SQL_IDENT}\\.)?(${SQL_IDENT})`, 'ig'));
  wx(new RegExp(`\\breplace\\s+into\\s+(?:${SQL_IDENT}\\.)?(${SQL_IDENT})`, 'ig'));
  rx(new RegExp(`\\bfrom\\s+(?:${SQL_IDENT}\\.)?(${SQL_IDENT})`, 'ig'));
  rx(new RegExp(`\\bjoin\\s+(?:${SQL_IDENT}\\.)?(${SQL_IDENT})`, 'ig'));
  const clean = (t) => t.replace(/[`"[]]/g, '').trim();
  const filter = (set) => [...set].map(clean).filter((t) => /^[a-z][a-z0-9_]*$/.test(t) && !/^(select|values|with|dual)$/i.test(t));
  return { reads: filter(reads), writes: filter(writes) };
}

function scanDirectSql() {
  const statements = [];
  for (const scope of ['src', 'scripts', 'tracker-view']) {
    for (const p of listFiles(path.join(REPO_ROOT, scope), PROD_SOURCE)) {
      const rel = REL(path.relative(REPO_ROOT, p));
      if (/(^|\/)node_modules\//.test(rel)) continue;
      const src = readFileSync(p, 'utf8');
      for (const lit of lexStringLiterals(src)) {
        if (!SQL_DATA_START_RE.test(lit.value)) continue;
        if (!(lit.value.length >= 8 && /\b(from|into|set|values|table)\b/i.test(lit.value))) continue;
        for (const stmt of splitSqlStatements(lit.value)) {
          if (!stmt.trim()) continue;
          const verb = sqlVerbOf(stmt);
          if (!verb) continue;
          const { reads, writes } = sqlTablesOf(stmt);
          statements.push({ file: rel, line: lit.line, verb, reads, writes });
        }
      }
    }
  }
  return statements;
}

const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'WITH_INSERT', 'WITH_UPDATE', 'WITH_DELETE']);

function owningAggregatesOf(tables, prefixEntries) {
  const owners = new Set();
  for (const table of tables) {
    for (const [aggregate, prefix] of prefixEntries) {
      if (tableBelongsTo(table, String(prefix))) owners.add(aggregate);
    }
  }
  return [...owners].sort();
}

/**
 * Split direct-SQL statements touching aggregate-owned tables into
 * lawful (inside the owning repository file of every involved aggregate)
 * vs bypass (anywhere else). `aspect` selects which table set and verb
 * family counts: 'read' (read tables, any non-DDL statement that reads
 * aggregate tables — catches embedded SELECTs inside write statements
 * too) or 'write' (write targets of write-family statements).
 */
function ownershipSplit(statements, aspect, prefixEntries) {
  const result = { lawful: 0, bypass: 0, total: 0, byAggregate: {}, bypassSites: [] };
  for (const st of statements) {
    const tables = aspect === 'read' ? st.reads : st.writes;
    if (aspect === 'write' && !WRITE_VERBS.has(st.verb)) continue;
    if (tables.length === 0) continue;
    const involved = owningAggregatesOf(tables, prefixEntries);
    if (involved.length === 0) continue;
    const lawful = involved.every((aggregate) => st.file === ownerRepositoryFile(aggregate));
    result.total += 1;
    result.lawful += lawful ? 1 : 0;
    result.bypass += lawful ? 0 : 1;
    for (const aggregate of involved) {
      const rec = result.byAggregate[aggregate] ??= { lawful: 0, bypass: 0 };
      rec[lawful ? 'lawful' : 'bypass'] += 1;
    }
    if (!lawful) result.bypassSites.push(`${st.file}:${st.line}`);
  }
  const sorted = {
    lawful: result.lawful,
    bypass: result.bypass,
    total: result.total,
    byAggregate: Object.fromEntries(Object.keys(result.byAggregate).sort().map((k) => [k, result.byAggregate[k]])),
    bypassSites: [...new Set(result.bypassSites)].sort().slice(0, 50),
    bypassSitesTruncated: result.bypassSites.length > 50,
  };
  return sorted;
}

/** Kernel-scope direct-SQL reads of declared projection tables (hard-target class). */
function projectionReadSplit(statements, projectionTables, kernelScopePrefix) {
  const projection = new Set(projectionTables);
  const sites = [];
  for (const st of statements) {
    if (!st.file.startsWith(kernelScopePrefix)) continue;
    if (!st.reads.some((t) => projection.has(t))) continue;
    sites.push(`${st.file}:${st.line}`);
  }
  const unique = [...new Set(sites)].sort();
  return { lawful: 0, bypass: unique.length, total: unique.length, bypassSites: unique.slice(0, 50), bypassSitesTruncated: unique.length > 50 };
}


function scanWorkshopNameLiterals() {
  // Kernel scope = production sources under src/ EXCLUDING the workshop-owned
  // semantic packages (src/modules/**). Workshop names quoted as literals
  // there are workshop-name branches the kernel must not contain.
  const re = /['"`](discovery|formalization|development|delivery|documentation)['"`]/g;
  let hits = 0;
  const files = [];
  for (const p of listFiles(path.join(REPO_ROOT, 'src'), PROD_SOURCE)) {
    const rel = REL(path.relative(REPO_ROOT, p));
    if (rel.startsWith('src/modules/')) continue;
    const matches = readFileSync(p, 'utf8').match(re);
    if (matches) { hits += matches.length; files.push(rel); }
  }
  return { literals: hits, files: files.length, fileNames: files.sort() };
}

function scanStaticPromptAssets() {
  // Static prompt asset surface: skills/*/SKILL.md (the pinned protocol and
  // semantic skills inlined into worker prompts come from this universe).
  const dir = path.join(REPO_ROOT, 'skills');
  const sizes = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const f = path.join(dir, entry.name, 'SKILL.md');
    if (existsSync(f)) sizes.push(statSync(f).size);
  }
  return {
    fileCount: sizes.length,
    maxFileBytes: sizes.length ? Math.max(...sizes) : 0,
    totalBytes: sum(sizes),
  };
}

function measureRoutePolicy() {
  const policyPath = path.join(REPO_ROOT, 'factory-execution-routes.json');
  const raw = readFileSync(policyPath, 'utf8');
  const policy = JSON.parse(raw);
  // Condition-key universe actually implemented by the resolver interface.
  const resolverPath = path.join(REPO_ROOT, 'src', 'application', 'routing', 'execution-route-resolver.ts');
  const resolverSrc = readFileSync(resolverPath, 'utf8');
  const matchBlock = /match:\s*\{([\s\S]*?)\};/.exec(resolverSrc);
  const conditionKeys = matchBlock
    ? [...matchBlock[1].matchAll(/^\s{4}(\w+)\??:/gm)].map((m) => m[1]).sort()
    : [];
  const ifs = (resolverSrc.match(/\bif\s*\(/g) || []).length;
  const ternaries = (resolverSrc.match(/\?[^?:]*:/g) || []).length;
  return {
    rules: (policy.routes || []).length,
    hasDefault: policy.default !== undefined,
    serializedBytes: Buffer.byteLength(raw, 'utf8'),
    conditionKeys,
    imperativeBranchSites: ifs + ternaries,
  };
}

function measurePlanStructure() {
  const planPath = path.join(REPO_ROOT, 'docs', 'plans', 'EVENT-PROJECTED-KERNEL-GREENFIELD-REFACTORING-PLAN.md');
  const plan = readFileSync(planPath, 'utf8');
  const phases = [...plan.matchAll(/^## Phase (EK-\d+)/gm)].map((m) => m[1]);
  const packages = [...plan.matchAll(/^\| (WP-[\w]+) \|/gm)].map((m) => m[1]);
  return { phases: phases.length, phaseIds: phases, topLevelPackages: packages.length };
}

function measureRuntimeDependencies() {
  const pkg = readJson(path.join(REPO_ROOT, 'package.json'));
  return Object.keys(pkg.dependencies || {}).sort();
}

function universeEventKinds(u) {
  const events = new Set();
  for (const cmd of u.commands) for (const e of cmd.emitsEvents || []) events.add(e);
  return events.size;
}

function universeModuleFlowEdges(u) {
  // R17 (frozen reconciliation): "Forward carries N module-flow edges ...".
  const r17 = (u.reconciliation || []).find((r) => r.id === 'R17');
  const m = r17 && /(\d+) module-flow edges/.exec(String(r17.difference || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Every entry: { measure(ctx) -> {value, detail?} , requires?: 'kernel' | 'admission-schemas' }
 * `requires` marks dimensions whose measured artifact does not exist before
 * EK-2/WP-16 part 2; their --dimension invocation fails loudly until it does.
 */
const MEASURES = {
  /* --- authority ------------------------------------------------- */
  'authority.mutableOwnerFanInFiles': {
    measure: (ctx) => {
      const s = censusWriterStats(ctx.census);
      return { value: s.maxFanIn, detail: { worstTable: s.maxFanInTable } };
    },
  },
  'authority.mutableOwnerAggregates': {
    measure: (ctx) => ({ value: ctx.census.factFamilies.length, detail: { successorKinds: ctx.universe.counts.aggregates + ctx.universe.counts.nonAggregateAuthorities } }),
  },
  'authority.authoritativeRelationKinds': {
    measure: (ctx) => {
      const obligationTables = Object.values(ctx.census.tables).filter((t) => t.family === 'obligation').length;
      return { value: 1, detail: { note: 'one generic obligation row kind', obligationFamilyTables: obligationTables } };
    },
  },
  'authority.decisionReaderStatements': {
    measure: (ctx) => {
      if (!ctx.kernelPresent) {
        const s = censusReaderStats(ctx.census);
        return {
          value: s.decision,
          detail: {
            mode: 'predecessor-census-diagnostic',
            split: { lawful: 0, bypass: s.decision, total: s.decision },
            splitNote: 'pre-kernel: no owning repository exists, so every census decision read is bypass (lawful = 0); the split columns are emitted now so --check binds on bypass the moment src/workflow-kernel lands',
            totalReaders: s.total,
            deleteClassDecisionReads: s.decisionDelete,
          },
        };
      }
      const split = ownershipSplit(ctx.sqlScan, 'read', ctx.convention.prefixEntries);
      return {
        value: split.bypass,
        detail: {
          mode: 'successor-tree-live-scan',
          split,
          splitNote: 'binding value is the bypass column; lawful (SQL inside the owning repository files) is bounded by authority.mutableOwnerFanInFiles / authority.mutableOwnerAggregates, not by this dimension',
        },
      };
    },
  },
  'authority.projectionAuthorityReads': {
    measure: (ctx) => {
      if (!ctx.kernelPresent) {
        const s = censusReaderStats(ctx.census);
        return {
          value: s.decisionDelete,
          detail: {
            mode: 'predecessor-census-diagnostic',
            split: { lawful: 0, bypass: s.decisionDelete, total: s.decisionDelete },
            splitNote: 'pre-kernel: all DELETE-class decision reads are bypass; lawful is structurally 0 for this dimension (a projection has no owning repository and no lawful kernel read)',
          },
        };
      }
      const split = projectionReadSplit(ctx.sqlScan, ctx.convention.projectionTables, 'src/workflow-kernel/');
      return {
        value: split.bypass,
        detail: {
          mode: 'successor-tree-live-scan',
          split,
          splitNote: 'binding value is the bypass column: kernel-scope direct-SQL reads of declared projection tables; presentation-scope reads outside src/workflow-kernel are legal (disposable read models)',
        },
      };
    },
  },
  'authority.decisionWriterStatements': {
    measure: (ctx) => {
      if (!ctx.kernelPresent) {
        const s = censusWriterStats(ctx.census);
        return {
          value: s.total,
          detail: {
            mode: 'predecessor-census-diagnostic',
            split: { lawful: 0, bypass: s.total, total: s.total },
            splitNote: 'pre-kernel: no owning repository exists, so every census direct write is bypass (lawful = 0)',
            byScope: s.byScope,
          },
        };
      }
      const split = ownershipSplit(ctx.sqlScan, 'write', ctx.convention.prefixEntries);
      return {
        value: split.bypass,
        detail: {
          mode: 'successor-tree-live-scan',
          split,
          splitNote: 'binding value is the bypass column; lawful (SQL inside the owning repository files) is bounded by authority.mutableOwnerFanInFiles / authority.mutableOwnerAggregates, not by this dimension',
        },
      };
    },
  },
  /* --- protocol vocabularies (typed kinds absent on the predecessor tree) --- */
  'protocol.commandKinds': {
    measure: (ctx) => ({ value: countKernelVocab('command'), detail: { targetFromUniverse: ctx.universe.counts.commands } }),
  },
  'protocol.eventKinds': {
    measure: (ctx) => ({ value: countKernelVocab('event'), detail: { targetFromUniverse: universeEventKinds(ctx.universe) } }),
  },
  'protocol.obligationKinds': {
    measure: (ctx) => ({ value: countKernelVocab('obligation'), detail: { targetFromUniverse: ctx.universe.counts.obligations } }),
  },
  'protocol.waitKinds': {
    measure: (ctx) => ({ value: countKernelVocab('wait'), detail: { targetFromUniverse: ctx.universe.counts.waits } }),
  },
  'protocol.proofKinds': {
    measure: (ctx) => ({ value: countKernelVocab('proof'), detail: { targetFromUniverse: ctx.universe.counts.proofs } }),
  },
  'protocol.evidenceKinds': {
    measure: (ctx) => ({ value: countKernelVocab('evidence'), detail: { targetFromUniverse: ctx.universe.counts.evidenceKinds, predecessorNamedChain: 5 } }),
  },
  /* --- composition ------------------------------------------------ */
  'composition.orchestrationEntrypoints': {
    measure: () => {
      const files = listFiles(path.join(REPO_ROOT, 'src', 'app'), (n) => n.endsWith('.ts'));
      return { value: files.length, detail: { scope: 'src/app/*.ts production orchestration modules' } };
    },
  },
  'composition.obligationConsumerImplementations': {
    measure: (ctx) => {
      const obl = ctx.census.tables.factory_transition_obligations;
      const readerFiles = [...new Set((obl.readers || []).map((r) => r.file))];
      const outsideLedger = readerFiles.filter((f) => !f.includes('transition-obligation-ledger'));
      // + operator-soft-stop (writer outside the ledger) + scripts/restore-from-checkpoint.mjs (writer)
      const sites = [...outsideLedger, 'src/app/operator-soft-stop.ts', 'scripts/restore-from-checkpoint.mjs'];
      return { value: sites.length, detail: { nonLedgerSites: sites.sort() } };
    },
  },
  /* --- roles ------------------------------------------------------ */
  'roles.bindingAuthorities': {
    measure: (ctx) => ({
      value: ctx.census.roleResolutionSites.length,
      detail: countVerdicts(ctx.census.roleResolutionSites),
    }),
  },
  /* --- prompts ---------------------------------------------------- */
  'prompts.assemblers': {
    measure: (ctx) => ({ value: ctx.census.promptAssemblySites.length }),
  },
  'prompts.cumulativeAccountants': {
    measure: (ctx) => {
      // A predecessor cumulative accountant would have to be an EXISTING
      // accounting surface the census marks retain-and-move. Descriptive text
      // ("becomes ... consumed by the cumulative accountant") is future tense
      // and must not count. The census records the absence explicitly (PA-2).
      const cumulative = ctx.census.promptAssemblySites.filter((s) =>
        /cumulative|accountant/i.test(`${s.site} ${s.censusVerdict || ''}`) && /RETAIN-AND-MOVE/i.test(String(s.censusVerdict || '')));
      return {
        value: cumulative.length,
        detail: {
          note: 'SAGA_PROMPT_MAX_BYTES (PA-2) is an opt-in per-prompt byte cap; unset/0 means unlimited — the census records this as the baseline insufficiency, i.e. zero cumulative accountants',
          sites: cumulative.map((s) => s.id),
        },
      };
    },
  },
  'prompts.staticPromptAssetMaxBytes': {
    measure: () => {
      const s = scanStaticPromptAssets();
      return { value: s.maxFileBytes, detail: { fileCount: s.fileCount } };
    },
  },
  'prompts.staticPromptAssetTotalBytes': {
    measure: () => ({ value: scanStaticPromptAssets().totalBytes, detail: { scope: 'skills/*/SKILL.md' } }),
  },
  /* --- workshops -------------------------------------------------- */
  'workshops.nameBranchLiterals': {
    measure: () => {
      const s = scanWorkshopNameLiterals();
      return { value: s.literals, detail: { files: s.files } };
    },
  },
  'workshops.ownedSchedulerImplementations': {
    measure: (ctx) => {
      const edges = universeModuleFlowEdges(ctx.universe);
      return {
        value: edges,
        detail: { note: 'module-flow edges executed through workshop-owned flow logic (generic-flow-executor + installed manifests); R17 re-types them as kernel obligation:advanceProcessFlow' },
      };
    },
  },
  /* --- dependencies ----------------------------------------------- */
  'deps.runtimeDependencySet': {
    measure: () => ({ value: measureRuntimeDependencies().length, detail: { sortedDependencies: measureRuntimeDependencies() } }),
  },
  /* --- debt ------------------------------------------------------- */
  'debt.temporaryLegacySurfaces': {
    measure: (ctx) => {
      const s = censusWriterStats(ctx.census);
      const recency = ctx.census.predecessorInputs.frozenRecencyAllowlist.files.length;
      const sanctioned = ctx.census.predecessorInputs.sanctionedTaskWriters.files.length;
      return {
        value: s.deleteDisposition,
        detail: { deleteDispositionWriters: s.deleteDisposition, recencyAllowlistFiles: recency, sanctionedTaskWriterFiles: sanctioned },
      };
    },
  },
  /* --- route policy ----------------------------------------------- */
  'route.declarativeRuleCount': {
    measure: () => ({ value: measureRoutePolicy().rules, detail: { hasDefault: measureRoutePolicy().hasDefault } }),
  },
  'route.conditionKeyUniverse': {
    measure: () => {
      const r = measureRoutePolicy();
      return { value: r.conditionKeys, detail: { forbiddenInferenceSourcesObserved: ['tasks.status', 'tasks.tags', 'tasks.execution_skill', 'tasks.review_skill'] } };
    },
  },
  'route.imperativeBranchSites': {
    measure: () => ({ value: measureRoutePolicy().imperativeBranchSites, detail: { scope: 'src/application/routing/execution-route-resolver.ts (if + ternary sites)' } }),
  },
  'route.serializedPolicyBytes': {
    measure: () => ({ value: measureRoutePolicy().serializedBytes, detail: { file: 'factory-execution-routes.json' } }),
  },
  /* --- structure caps --------------------------------------------- */
  'structure.phaseCount': {
    measure: () => ({ value: measurePlanStructure().phases, detail: { phaseIds: measurePlanStructure().phaseIds } }),
  },
  'structure.topLevelPackageCount': {
    measure: () => ({ value: measurePlanStructure().topLevelPackages }),
  },
  /* --- contract shape (admission schemas; fail loudly until they exist) --- */
  'contract.roleContractFieldCount': { requires: 'admission-schemas', measure: () => measureSchemaFieldCount('canonical-role-contract.schema.json') },
  'contract.promptBudgetProfileFieldCount': { requires: 'admission-schemas', measure: () => measureSchemaFieldCount('prompt-budget-profile.schema.json') },
  'contract.schemaAlternatives': { requires: 'admission-schemas', measure: () => measureSchemaAlternatives() },
  'contract.maxReferenceFanOut': { requires: 'admission-schemas', measure: () => measureSchemaFanOut() },
  'contract.maxNestingDepth': { requires: 'admission-schemas', measure: () => measureSchemaDepth() },
  'contract.policyReferenceKinds': { requires: 'admission-schemas', measure: () => measurePolicyReferenceKinds() },
  'contract.arbitraryMetadataFields': { requires: 'admission-schemas', measure: () => measureArbitraryMetadataFields() },
};

/* --- kernel vocabulary enumeration (0 until the kernel exists) ------- */

function kernelVocabFiles() {
  return listFiles(path.join(KERNEL_ROOT, 'domain'), PROD_SOURCE).sort();
}

function countKernelVocab(kind) {
  // Predecessor tree: no typed vocabulary exists -> 0. Kernel tree: enumerate
  // declared kinds from src/workflow-kernel/domain/** registry modules. Until
  // WP-05 lands its registry, absence is the honest measured value.
  const files = kernelVocabFiles();
  if (files.length === 0) return 0;
  const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const patterns = {
    command: /(?:kind|type|name):\s*['"][a-zA-Z]+\.(?:bootstrap|start|stop|resume|settle|cancel|claim|complete|submit|accept|reject|record|observe|verify|import|plan|send|release|route)[a-zA-Z.]*['"]/g,
    event: /WorkflowEvent:[a-zA-Z][a-zA-Z.]+/g,
    obligation: /obligation:[a-zA-Z][a-zA-Z.]+/g,
    wait: /(?:TypedWait|wait):[a-zA-Z][a-zA-Z.]+/g,
    proof: /TerminalProof:[a-zA-Z][a-zA-Z.]+/g,
    evidence: /(?:Evidence|[a-zA-Z]+Evidence):[a-zA-Z][a-zA-Z.]+/g,
  };
  const found = new Set(all.match(patterns[kind] || /$^/g) || []);
  return found.size;
}

/* --- admission-schema measurements (placeholders until WP-16 part 2) -- */

function admissionSchemaPaths() {
  return ['canonical-role-contract.schema.json', 'prompt-budget-profile.schema.json']
    .map((f) => path.join(SPECS_DIR, f))
    .filter((p) => existsSync(p));
}

function requireAdmissionSchemas() {
  const present = admissionSchemaPaths();
  if (present.length < 2) {
    process.stderr.write(
      'COMPLEXITY_DIMENSION_UNMEASURABLE_BEFORE_KERNEL: the admission schemas ' +
        '(docs/refactoring/event-kernel/specs/canonical-role-contract.schema.json and ' +
        'prompt-budget-profile.schema.json) do not exist on this tree. They are authored by ' +
        'WP-16 part 2 and implemented by WP-17/WP-18. This dimension deliberately FAILS ' +
        'LOUDLY instead of silently passing; the EK-1 target is frozen in complexity-budget.json.\n',
    );
    process.exit(2);
  }
  return present.map((p) => readJson(p));
}

function schemaTopLevelFields(schema) {
  return Object.keys(schema.properties || {});
}

function measureSchemaFieldCount(file) {
  const schemas = requireAdmissionSchemas();
  const schema = schemas.find((s) => (s.$id || '').includes(file.replace('.schema.json', ''))) || schemas[0];
  const props = schemaTopLevelFields(schema);
  // Named fields per the plan's frozen contract blocks: a physical property is
  // a *companion* (not its own named field) when it is an X-Digest/X-Version
  // whose sibling X-Ref exists ("protocolSkillRef + digest" is ONE entry).
  const companions = props.filter((p) => {
    if (!/(Digest|Version)$/.test(p)) return false;
    const stem = p.replace(/(Digest|Version)$/, '');
    return props.includes(`${stem}Ref`) || props.includes(`${stem.slice(0, -1)}Ref`);
  }).length;
  return { value: props.length - companions, detail: { physicalFields: props.length, schema: file } };
}

function measureSchemaAlternatives() {
  const schemas = requireAdmissionSchemas();
  let alternatives = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.oneOf || node.anyOf) alternatives += (node.oneOf || []).length + (node.anyOf || []).length;
    for (const v of Object.values(node)) walk(v);
  };
  for (const s of schemas) walk(s);
  return { value: alternatives };
}

function measureSchemaFanOut() {
  const schemas = requireAdmissionSchemas();
  let maxArray = 0;
  let maxRefFields = 0;
  for (const s of schemas) {
    const props = schemaTopLevelFields(s);
    maxRefFields = Math.max(maxRefFields, props.filter((p) => /[Rr]ef$|[Cc]ontracts$|[Oo]bligations$|[Rr]efs$|[Tt]ools$|[Cc]apabilit/.test(p)).length);
    for (const [name, def] of Object.entries(s.properties || {})) {
      if (def.type === 'array' && typeof def.maxItems === 'number') maxArray = Math.max(maxArray, def.maxItems);
      else if (def.type === 'array') maxArray = Math.max(maxArray, Number.POSITIVE_INFINITY);
      void name;
    }
  }
  return { value: Number.isFinite(maxArray) ? Math.max(maxArray, maxRefFields) : -1, detail: { maxRefFields } };
}

function measureSchemaDepth() {
  const schemas = requireAdmissionSchemas();
  const depth = (node, d) => {
    if (!node || typeof node !== 'object') return d;
    let best = d;
    for (const v of Object.values(node)) best = Math.max(best, depth(v, v && typeof v === 'object' && (v.type || v.properties || v.items) ? d + 1 : d));
    return best;
  };
  return { value: Math.max(...schemas.map((s) => depth(s, 0))) };
}

function measurePolicyReferenceKinds() {
  const schemas = requireAdmissionSchemas();
  const kinds = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (/Ref$/.test(k) && typeof v === 'object') kinds.add(k);
      walk(v);
    }
  };
  for (const s of schemas) walk(s);
  return { value: [...kinds].sort() };
}

function measureArbitraryMetadataFields() {
  const schemas = requireAdmissionSchemas();
  const banned = /metadata|extension|extra|additionalProperties|x-|custom/i;
  let hits = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (banned.test(k)) hits += 1;
      if (k === 'additionalProperties' && (v === true || (v && v.type === 'object' && !v.properties))) hits += 1;
      walk(v);
    }
  };
  for (const s of schemas) walk(s);
  return { value: hits };
}

/* ------------------------------------------------------------------ */
/* Vector assembly                                                     */
/* ------------------------------------------------------------------ */

function compareAgainstTarget(measured, target) {
  if (measured === null || measured === undefined) return null;
  if (target.kind === 'max') return measured <= target.value;
  if (target.kind === 'exact' || target.kind === 'zero-after-phase') return measured === target.value;
  if (target.kind === 'closed-set') return Array.isArray(measured) && measured.length === target.value.length && measured.every((v) => target.value.includes(v));
  if (target.kind === 'subset-of-frozen') return Array.isArray(measured) ? measured.every((v) => target.value.includes(v)) : target.value.includes(measured);
  return null;
}

function canonicalize(value) {
  if (Array.isArray(value)) return [...value].sort();
  return value;
}

function frozenAnchorsOf() {
  const censusData = census();
  const universeData = universe();
  return {
    universeAggregates: universeData.aggregates.map((a) => a.name),
    censusProjectionTables: Object.entries(censusData.tables)
      .filter(([, rec]) => rec.tableClass === 'PROJECTION')
      .map(([table]) => table)
      .sort(),
    censusData,
    universeData,
  };
}

function buildContext(budget, kernelPresent) {
  const conv = budget.lawfulRepositoryConvention;
  let scanCache = null;
  return {
    census: census(),
    universe: universe(),
    kernelPresent,
    convention: {
      prefixEntries: Object.entries(conv.aggregateTablePrefixes),
      projectionTables: [...conv.projectionTables].sort(),
    },
    get sqlScan() {
      if (!scanCache) scanCache = scanDirectSql();
      return scanCache;
    },
  };
}

function buildVector(budget, { manifest, digests }, { kernelPresent }) {
  const ctx = buildContext(budget, kernelPresent);
  const predecessorContext = {
    adr097Violations: ctx.census.predecessorInputs.adr097Violations.length,
    adr053NineSeams: ctx.census.predecessorInputs.adr053NineSeams.length,
    developmentUniverse: ctx.census.predecessorInputs.developmentUniverse34of40,
  };
  const entries = [];
  for (const dim of budget.dimensions) {
    const impl = MEASURES[dim.id];
    if (!impl) fail(1, `COMPLEXITY_MEASURE_MISSING: budget dimension ${dim.id} has no measurement implementation in measure-complexity.mjs`);
    let status;
    let measured = null;
    let detail;
    if (impl.requires === 'admission-schemas' && admissionSchemaPaths().length < 2) {
      status = 'TARGET-ONLY-UNTIL-ADMISSION-SCHEMAS';
    } else {
      const result = impl.measure(ctx);
      measured = canonicalize(result.value);
      detail = result.detail;
      status = 'MEASURED';
    }
    const binding = kernelPresent;
    entries.push({
      id: dim.id,
      group: dim.group,
      status,
      measured,
      unit: dim.baseline?.unit ?? null,
      targetKind: dim.target.kind,
      targetValue: dim.target.value,
      binding,
      conjunctivePass: binding ? compareAgainstTarget(measured, dim.target) : null,
      detail: detail ?? null,
    });
  }
  const bindingEntries = entries.filter((e) => e.binding);
  return {
    schemaVersion: 'ek1.complexity-vector.v2',
    generatedBy: 'docs/refactoring/event-kernel/specs/measure-complexity.mjs',
    tree: {
      kernelPresent,
      mode: kernelPresent ? 'successor-kernel-tree' : 'predecessor-baseline-tree',
      bindingNote: kernelPresent
        ? 'targets are binding: every conjunctivePass must be true'
        : 'predecessor baseline is diagnostic evidence, not an entitlement (plan "Bounded successor complexity"); targets bind the successor tree',
    },
    inputs: {
      budget: { path: 'docs/refactoring/event-kernel/specs/complexity-budget.json', sha256: sha256(readFileSync(BUDGET_PATH, 'utf8')) },
      frozenInputs: Object.fromEntries(manifest.inputs.map((i) => [i.file, { sourceBranch: i.sourceBranch, sourceCommit: i.sourceCommit, sha256: digests[i.file] }])),
    },
    predecessorContext,
    dimensions: entries,
    summary: {
      dimensionCount: entries.length,
      measured: entries.filter((e) => e.status === 'MEASURED').length,
      targetOnly: entries.filter((e) => e.status !== 'MEASURED').length,
      bindingPassCount: bindingEntries.filter((e) => e.conjunctivePass === true).length,
      bindingViolations: bindingEntries.filter((e) => e.conjunctivePass === false).map((e) => e.id),
      determinism: 'canonical-json; no clock, no randomness, sorted iteration; two runs on one tree must be byte-identical',
    },
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const { manifest, digests } = verifyFrozenInputs();
  const budget = readJson(BUDGET_PATH);
  const anchors = frozenAnchorsOf();
  const problems = validateBudget(budget, anchors);
  if (problems.length > 0) {
    fail(1, `COMPLEXITY_BUDGET_INVALID (${problems.length} problems):\n  - ${problems.join('\n  - ')}`);
  }
  const kernelPresent = existsSync(KERNEL_ROOT);

  if (flag('--selftest')) {
    process.stdout.write(
      `COMPLEXITY_BUDGET_SELFTEST_OK: ${budget.dimensions.length} dimensions, ` +
        `${MANDATED_DIMENSIONS.length}/${MANDATED_DIMENSIONS.length} mandated groups covered, ` +
        `${manifest.inputs.length}/${manifest.inputs.length} frozen-input digests verified, ` +
        `waivers: 0, kernelPresent: ${kernelPresent}, ` +
        `lawful-owner convention: ${anchors.universeAggregates.length} aggregates / ${anchors.censusProjectionTables.length} projection tables verified against frozen inputs\n`,
    );
    return;
  }

  const dimensionId = opt('--dimension');
  if (dimensionId) {
    const dim = budget.dimensions.find((d) => d.id === dimensionId);
    if (!dim) {
      fail(1, `COMPLEXITY_DIMENSION_UNKNOWN: ${dimensionId}. Known ids:\n  ${budget.dimensions.map((d) => d.id).join('\n  ')}`);
    }
    const impl = MEASURES[dimensionId];
    if (!impl) fail(1, `COMPLEXITY_MEASURE_MISSING: ${dimensionId}`);
    if (impl.requires === 'admission-schemas' && admissionSchemaPaths().length < 2) {
      requireAdmissionSchemas(); // prints the loud failure and exits 2
    }
    const ctx = buildContext(budget, kernelPresent);
    const result = impl.measure(ctx);
    const measured = canonicalize(result.value);
    process.stdout.write(`${JSON.stringify({ id: dimensionId, status: 'MEASURED', measured, target: dim.target, conjunctivePass: compareAgainstTarget(measured, dim.target), detail: result.detail ?? null }, null, 2)}\n`);
    return;
  }

  const vector = buildVector(budget, { manifest, digests }, { kernelPresent });
  const out = canonicalJson(vector);

  if (flag('--check')) {
    const violations = vector.dimensions.filter((d) => d.binding && d.conjunctivePass === false);
    const unmeasured = vector.dimensions.filter((d) => d.status !== 'MEASURED');
    if (vector.tree.kernelPresent) {
      if (violations.length > 0 || unmeasured.length > 0) {
        fail(1, `COMPLEXITY_CHECK_RED: ${violations.length} binding violations [${violations.map((v) => v.id).join(', ')}], ${unmeasured.length} unmeasured dimensions [${unmeasured.map((u) => u.id).join(', ')}]`);
      }
      process.stdout.write('COMPLEXITY_CHECK_GREEN: every dimension measured and inside the conjunctive envelope\n');
      return;
    }
    process.stdout.write(
      `COMPLEXITY_CHECK_BASELINE (predecessor tree, targets not binding): ` +
        `${vector.summary.measured} measured, ${vector.summary.targetOnly} target-only; ` +
        `expected predecessor exceedances are diagnostic evidence for the refactor, not failures.\n`,
    );
    return;
  }

  const outPath = opt('--out');
  if (outPath) {
    writeFileSync(outPath, out);
  } else {
    process.stdout.write(out);
  }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

main();
