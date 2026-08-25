#!/usr/bin/env node
/**
 * validate-census.mjs — WP-01 deliverable contract gate.
 *
 * Proves:
 *  1. authority-census.json parses and every enum-valued field draws from the
 *     fixed closed vocabulary (deliverable contract: "the JSON validates as
 *     closed vocabulary");
 *  2. zero unclassified readers/writers: a FRESH scan of the tree yields no
 *     SQL statement touching a table absent from the census, and every writer
 *     and reader entry carries a classification;
 *  3. every WP fact family is present with the full required field set;
 *  4. the predecessor inputs (ADR-097 violations, nine seams, 34/40, recency
 *     allowlist, sanctioned writers) are carried;
 *  5. role-resolution and prompt-assembly site lists are non-empty (WP-16).
 *
 * Exit code 0 = green; anything else prints the exact violations.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const CENSUS = path.join(ROOT, 'docs', 'refactoring', 'event-kernel', 'authority-census.json');
const SCAN_TOOL = path.join(HERE, 'sql-literal-scanner.mjs');

const errors = [];
const ok = (cond, msg) => { if (!cond) errors.push(msg); };

const census = JSON.parse(fs.readFileSync(CENSUS, 'utf8'));
const E = census.enums;

// --- 1. closed vocabulary ---------------------------------------------------
const inEnum = (v, list) => list.includes(v);
for (const [t, e] of Object.entries(census.tables)) {
  ok(inEnum(e.family, E.family), `table ${t}: family '${e.family}' not in enum`);
  ok(inEnum(e.tableClass, E.tableClass), `table ${t}: tableClass '${e.tableClass}' not in enum`);
  for (const d of e.ddlOwners) ok(inEnum(d.disposition, E.disposition), `table ${t} ddl ${d.file}:${d.line}: disposition not in enum`);
  for (const w of e.writers) {
    ok(inEnum(w.disposition, E.disposition), `table ${t} writer ${w.file}:${w.line}: disposition '${w.disposition}' not in enum`);
    ok(inEnum(w.scope, E.scope), `table ${t} writer ${w.file}:${w.line}: scope not in enum`);
    ok(['INSERT', 'UPDATE', 'DELETE'].includes(w.verb), `table ${t} writer ${w.file}:${w.line}: bad verb`);
  }
  for (const r of e.readers) {
    ok(inEnum(r.kind, E.accessKind), `table ${t} reader ${r.file}:${r.line}: kind '${r.kind}' not in enum`);
    ok(inEnum(r.authorityClass, E.authorityClass), `table ${t} reader ${r.file}:${r.line}: class '${r.authorityClass}' not in enum`);
    ok(inEnum(r.scope, E.scope), `table ${t} reader ${r.file}:${r.line}: scope not in enum`);
  }
}
for (const m of census.markerUses) {
  ok(inEnum(m.authorityClass, E.authorityClass), `marker ${m.file}:${m.line}: class not in enum`);
  ok(inEnum(m.disposition, E.disposition), `marker ${m.file}:${m.line}: disposition not in enum`);
  ok(m.markers.every((k) => inEnum(k, E.markerKind)), `marker ${m.file}:${m.line}: unknown marker kind`);
}
for (const f of census.factFamilies) {
  ok(inEnum(f.disposition, E.disposition), `family ${f.id}: disposition not in enum`);
}

// --- 2. zero unclassified (fresh re-scan equality) ---------------------------
const freshRaw = execFileSync(process.execPath, [SCAN_TOOL, '--root', ROOT], { maxBuffer: 1 << 26 }).toString();
const fresh = JSON.parse(freshRaw);
const NON_TABLES = new Set(['sqlite_master', 'json_each', 'the', 'message', 'applies', 'part',
  'evidence', 'epic_ids', 'task_stats', 'factory_process_products_new',
  'factory_process_products__new', 'factory_replay_capsule_invalidations_new', 'IF']);
const censusTables = new Set(Object.keys(census.tables));
let stmtChecked = 0;
for (const s of fresh.statements) {
  if (['COMMIT', 'BEGIN', 'ROLLBACK', 'ATTACH', 'DETACH'].includes(s.verb)) continue;
  const touched = [...new Set([...s.reads, ...s.writes])]
    .filter((t) => !NON_TABLES.has(t) && /^[a-z][a-z0-9_]*$/.test(t));
  for (const t of touched) {
    stmtChecked += 1;
    if (!censusTables.has(t)) {
      errors.push(`UNCLASSIFIED table '${t}' touched at ${s.file}:${s.line} (verb ${s.verb}) — absent from census`);
      continue;
    }
    const e = census.tables[t];
    if (['INSERT', 'UPDATE', 'DELETE'].includes(s.verb)) {
      const hit = e.writers.some((w) => w.file === s.file && w.line === s.line && w.verb === s.verb);
      ok(hit, `writer statement ${s.file}:${s.line} (${s.verb} ${t}) not enumerated in census`);
    } else if (['SELECT', 'WITH_SELECT', 'WITH_INSERT', 'WITH_UPDATE', 'WITH_DELETE'].includes(s.verb)) {
      const hit = e.readers.some((r) => r.file === s.file && r.line === s.line);
      ok(hit, `reader statement ${s.file}:${s.line} (${s.verb} ${t}) not enumerated in census`);
    }
  }
}

// --- 3. family completeness --------------------------------------------------
const REQUIRED_FAMILY_FIELDS = [
  'id', 'tables', 'currentOwnerClaimedByDocs', 'linearizationPoint', 'decisionReaders',
  'targetOwner', 'targetCommand', 'targetEvent', 'targetObligation', 'targetWait',
  'targetProof', 'disposition', 'positiveProof', 'mutationSuggestion',
];
const requiredFamilies = [
  'project-order-run', 'lifecycle', 'stage', 'process', 'node', 'workitem-task',
  'workplace', 'execution-attempt', 'material', 'gate', 'effect',
  'terminal-acceptance', 'obligation', 'recovery', 'checkpoint',
];
const familyIds = census.factFamilies.map((f) => f.id);
for (const rf of requiredFamilies) ok(familyIds.includes(rf), `missing required fact family: ${rf}`);
for (const f of census.factFamilies) {
  for (const field of REQUIRED_FAMILY_FIELDS) {
    ok(f[field] !== undefined, `family ${f.id}: missing required field '${field}'`);
  }
  for (const dr of f.decisionReaders ?? []) {
    ok(dr.file && dr.decision, `family ${f.id}: decision reader entry missing file/decision`);
  }
}
// every table's family must be an existing family id
for (const [t, e] of Object.entries(census.tables)) {
  ok(familyIds.includes(e.family), `table ${t}: family '${e.family}' has no family record`);
}

// --- 4. predecessor inputs ----------------------------------------------------
const P = census.predecessorInputs;
ok(P.adr097Violations?.length === 6, `expected 6 ADR-097 violation anchors, got ${P.adr097Violations?.length}`);
ok(P.adr053NineSeams?.length === 9, `expected 9 ADR-053 seams, got ${P.adr053NineSeams?.length}`);
ok(!!P.developmentUniverse34of40?.reference, 'missing 34/40 development universe input');
ok(P.frozenRecencyAllowlist?.files?.length === 12, `expected 12 recency-allowlist files, got ${P.frozenRecencyAllowlist?.files?.length}`);
ok(P.sanctionedTaskWriters?.files?.length >= 15, 'missing sanctioned task-writer set');

// --- 5. WP-16 inputs -----------------------------------------------------------
ok(census.roleResolutionSites?.length >= 10, `role-resolution site census too small: ${census.roleResolutionSites?.length}`);
ok(census.promptAssemblySites?.length >= 8, `prompt-assembly site census too small: ${census.promptAssemblySites?.length}`);
for (const r of census.roleResolutionSites ?? []) ok(r.target && r.censusVerdict, `role site ${r.id}: missing verdict/target`);
for (const p of census.promptAssemblySites ?? []) ok(p.target && p.censusVerdict, `prompt site ${p.id}: missing verdict/target`);

// --- verdict -------------------------------------------------------------------
const c = census.counts;
console.log(`tables: ${Object.keys(census.tables).length}, writers: ${c.writerStatements}, readers: ${c.readerStatements} (decision ${c.decisionReaderStatements} / presentation ${c.presentationReaderStatements}), marker uses: ${c.markerUses} (DEL ${c.markerUsesDelete} / AUTH ${c.markerUsesAuthoritative} / DIAG ${c.markerUsesDiagnostic})`);
console.log(`fresh-scan table-touch checks: ${stmtChecked}`);
if (errors.length) {
  console.error(`FAIL: ${errors.length} violation(s)`);
  for (const e of errors.slice(0, 50)) console.error('  - ' + e);
  process.exit(1);
}
console.log('PASS: closed vocabulary + zero unclassified readers/writers + family/predecessor/WP-16 completeness');
