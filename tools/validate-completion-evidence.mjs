#!/usr/bin/env node
// P0-02 — completion-evidence manifest validator.
// Pure node, no deps. Checks docs/factory/COMPLETION-LEDGER.md:
//   R1. every done/dfx task row has non-empty Evidence
//   R2. no task row is done/dfx while any dependency is not done/dfx
//   R3. DFX slots consumed <= 3 (hard max)
// Exit 0 = OK, 1 = violation. See docs/factory/COMPLETION-EVIDENCE-CONTRACT.md.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ledger = resolve(here, '..', 'docs', 'factory', 'COMPLETION-LEDGER.md');

const TASK_RE = /^(P0|C5|C7|LR|CI|W9|W10|W11|W12)-\d+$/;
const DFX_RE = /^DFX-\d$/;
const EMPTY = new Set(['', '—', '-', '–']);

function normStatus(s) {
  const l = (s || '').toLowerCase();
  if (l.startsWith('done')) return 'done';
  if (l.startsWith('dfx')) return 'dfx';
  if (l.startsWith('in_progress')) return 'in_progress';
  if (l.startsWith('blocked')) return 'blocked';
  if (l.startsWith('no-go') || l.startsWith('nogo')) return 'no-go';
  if (l.startsWith('pending')) return 'pending';
  return l || 'unknown';
}

const text = readFileSync(ledger, 'utf8');
const tasks = new Map(); // id -> { depends, status, evidence }
let dfxConsumed = 0;

for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line.startsWith('|') || !line.endsWith('|')) continue;
  if (/^\|[\s:|-]+\|$/.test(line)) continue; // separator row
  const cells = line.slice(1, -1).split('|').map(c => c.trim());
  const id = cells[0];
  if (!id) continue;

  if (TASK_RE.test(id)) {
    // ID | Outcome | Lane | Depends | Status | Commit | Evidence
    const dependsCell = cells[3] || '';
    const depends = EMPTY.has(dependsCell)
      ? []
      : dependsCell.split(/[,/]/).map(s => s.trim()).filter(Boolean);
    tasks.set(id, {
      depends,
      status: normStatus(cells[4] || ''),
      evidence: cells[6] || '',
    });
  } else if (DFX_RE.test(id)) {
    // Slot | Consumed by | Regression test | Fix | Status
    const st = normStatus(cells[4] || '');
    if (st !== 'available' && !EMPTY.has(cells[4] || '')) dfxConsumed += 1;
  }
}

const violations = [];

for (const [id, t] of tasks) {
  if (t.status === 'done' || t.status === 'dfx') {
    if (EMPTY.has(t.evidence)) {
      violations.push(`[R1] ${id}: marked ${t.status} but Evidence is empty`);
    }
    for (const dep of t.depends) {
      const dt = tasks.get(dep);
      if (!dt) {
        violations.push(`[R2] ${id}: references unknown dependency '${dep}'`);
      } else if (dt.status !== 'done' && dt.status !== 'dfx') {
        violations.push(`[R2] ${id}: ${t.status} but dependency ${dep} is '${dt.status}'`);
      }
    }
  }
}

if (dfxConsumed > 3) {
  violations.push(`[R3] DFX slots consumed = ${dfxConsumed} > 3 (hard maximum)`);
}

if (violations.length === 0) {
  console.log(`completion-evidence: OK (${tasks.size} tasks, dfx ${dfxConsumed}/3)`);
  process.exit(0);
}
console.error(`completion-evidence: FAIL (${violations.length} violation(s))`);
for (const v of violations) console.error('  ' + v);
process.exit(1);
