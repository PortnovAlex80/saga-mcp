#!/usr/bin/env node
// tools/legacy-freeze.mjs
//
// K2 — Legacy Expansion Freeze (Saga Core Renewal).
//
//   node tools/legacy-freeze.mjs --report     print current legacy counts vs the allowlist
//   node tools/legacy-freeze.mjs --check      exit 1 on any NEW legacy reference or schema drift
//   node tools/legacy-freeze.mjs --snapshot   rewrite docs/architecture/legacy-allowlist.json
//                                             from the CURRENT tree (capture or deliberate lower)
//
// The allowlist is count/file-decreasing: --snapshot refusing to grow is not
// enforced mechanically here (a human/agent lowering it does so in the same
// commit as a real removal) — but --check fails the suite the moment the tree
// contains legacy surface OUTSIDE the recorded baseline, and the schema digest
// fails on ANY unrecorded schema change. Broadening the allowlist requires a
// new ADR (LEGACY-INVENTORY.md).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowlistPath = join(repoRoot, 'docs/architecture/legacy-allowlist.json');

const RECENCY_DIRS = [
  'src/infrastructure/workplace/',
  'src/infrastructure/replay/',
  'src/process-modules/persistence/',
  'src/modules/formalization/infrastructure/',
  'src/modules/development/infrastructure/',
];

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (entry.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

export function scanTree() {
  const files = walk(join(repoRoot, 'src')).map(p => relative(repoRoot, p).replace(/\\/g, '/'));
  const content = new Map(files.map(f => [f, stripComments(readFileSync(join(repoRoot, f), 'utf8'))]));
  const matches = (re) => files.filter(f => re.test(content.get(f)));

  const escalate = matches(/\bescalate\b/i);
  const recency = matches(/ORDER BY[^;]*DESC[^;]*LIMIT 1/i)
    .filter(f => RECENCY_DIRS.some(d => f.startsWith(d)));
  const execLookup = matches(/listArtifactsForExecution|listTracesForExecution/);
  const latestCandidateRefs = files.reduce(
    (n, f) => n + (content.get(f).match(/latestCandidate/g) || []).length, 0);

  const schemaSrc = readFileSync(join(repoRoot, 'src/schema.ts'), 'utf8');
  const sql = schemaSrc.match(/export const SCHEMA_SQL = `([\s\S]*?)`;/)?.[1] ?? '';
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\)/g)]
    .map(t => {
      const cols = t[2].split(',').map(s => s.trim())
        .filter(s => /^[a-z_]/i.test(s)).map(s => s.split(/\s+/)[0]).sort();
      return `${t[1]}(${cols.join(',')})`;
    })
    .sort();
  const digest = createHash('sha256').update(tables.join('|')).digest('hex');

  return {
    categories: {
      'escalate-vocabulary': escalate,
      'recency-selector-authority-persistence': recency,
      'execution-scoped-lookup': execLookup,
    },
    latestCandidateRefs,
    schema: { tableCount: tables.length, digest },
  };
}

function loadAllowlist() {
  if (!existsSync(allowlistPath)) return null;
  return JSON.parse(readFileSync(allowlistPath, 'utf8'));
}

function check() {
  const allowlist = loadAllowlist();
  if (!allowlist) {
    process.stderr.write('legacy allowlist missing — run with --snapshot to capture the baseline\n');
    process.exitCode = 1;
    return null;
  }
  const scan = scanTree();
  const violations = [];

  for (const [name, currentFiles] of Object.entries(scan.categories)) {
    const allowed = new Set(allowlist.categories[name]?.files ?? []);
    const added = currentFiles.filter(f => !allowed.has(f));
    if (added.length > 0) {
      violations.push(`[${name}] NEW legacy references outside the freeze baseline: ${added.join(', ')}`);
    }
  }
  const latestMax = allowlist.categories['latest-candidate-code-refs']?.maxCount ?? 0;
  if (scan.latestCandidateRefs > latestMax) {
    violations.push(`[latest-candidate-code-refs] ${scan.latestCandidateRefs} > allowed ${latestMax}`);
  }
  if (scan.schema.tableCount !== allowlist.schemaSnapshot?.tableCount
      || scan.schema.digest !== allowlist.schemaSnapshot?.digest) {
    violations.push(
      `[schema-snapshot] clean schema drifted from the recorded baseline `
      + `(tables ${scan.schema.tableCount} vs ${allowlist.schemaSnapshot?.tableCount}; `
      + `digest ${scan.schema.digest.slice(0, 12)} vs ${String(allowlist.schemaSnapshot?.digest ?? '').slice(0, 12)}). `
      + 'Schema changes must update the snapshot in the SAME commit, deliberately.',
    );
  }
  return { scan, allowlist, violations };
}

function report() {
  const result = check();
  if (!result) return;
  const { scan, allowlist, violations } = result;
  for (const [name, files] of Object.entries(scan.categories)) {
    const allowed = allowlist.categories[name]?.files ?? [];
    process.stdout.write(`${name}: ${files.length} files (allowlist ${allowed.length}, owner ${allowlist.categories[name]?.owningRelease ?? '?'})\n`);
  }
  process.stdout.write(`latest-candidate-code-refs: ${scan.latestCandidateRefs} (max ${allowlist.categories['latest-candidate-code-refs']?.maxCount ?? 0})\n`);
  process.stdout.write(`schema-snapshot: ${scan.schema.tableCount} tables, digest ${scan.schema.digest.slice(0, 12)}\n`);
  if (violations.length > 0) {
    process.stderr.write(`LEGACY FREEZE VIOLATIONS (${violations.length}):\n${violations.map(v => `  - ${v}`).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('legacy freeze: OK (surface within baseline)\n');
  }
}

function snapshot() {
  const scan = scanTree();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim().slice(0, 12);
  const allowlist = {
    schemaVersion: 1,
    capturedAtSha: sha,
    note: 'Legacy freeze baseline (K2). Counts/files may only decrease; broadening requires a new ADR. See docs/architecture/LEGACY-INVENTORY.md.',
    categories: {
      'escalate-vocabulary': { owningRelease: 'K15', files: scan.categories['escalate-vocabulary'] },
      'recency-selector-authority-persistence': { owningRelease: 'K7-K8', files: scan.categories['recency-selector-authority-persistence'] },
      'execution-scoped-lookup': { owningRelease: 'K6-K7,K10', files: scan.categories['execution-scoped-lookup'] },
      'latest-candidate-code-refs': { owningRelease: 'K7', maxCount: scan.latestCandidateRefs },
    },
    schemaSnapshot: scan.schema,
  };
  writeFileSync(allowlistPath, JSON.stringify(allowlist, null, 2) + '\n');
  process.stdout.write(`snapshot written: ${Object.entries(scan.categories).map(([k, v]) => `${k}=${v.length}`).join(' ')} latestCandidate=${scan.latestCandidateRefs} tables=${scan.schema.tableCount}\n`);
}

// CLI guard: run only when executed directly, not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === '--report' || mode === '--check') report();
  else if (mode === '--snapshot') snapshot();
  else {
    process.stderr.write('usage: node tools/legacy-freeze.mjs --report | --check | --snapshot\n');
    process.exitCode = 2;
  }
}
