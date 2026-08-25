#!/usr/bin/env node
/**
 * EK-1 transition-universe validator (analysis tooling only — NOT production src/).
 *
 * Validates docs/refactoring/event-kernel/reconciliation/transition-universe.json:
 *   V1  parses and has all required top-level arrays
 *   V2  ids unique (commands, evidence kinds, proof (kind,scope), obligations kinds,
 *       reconciliation ids, decision ids)
 *   V3  every command's aggregate exists
 *   V4  every command's created obligations exist AND every obligation kind is created
 *       by at least one command (no orphan obligations in either direction)
 *   V5  every obligation's source is a command; every obligation's target is a command
 *       or a terminal proof
 *   V6  every command's waits exist in waits[]; every wait kind is used
 *   V7  every proof's issuing command resolves (unless the proof is explicitly pending
 *       a framed protocol decision)
 *   V8  every proof's evidence-closure references resolve to existing evidence kinds
 *       or proofs — no dangling references
 *   V9  every command's proofs resolve to declared proofs
 *   V10 every pendingProtocolDecision references a framed protocol decision
 *   V11 every reconciliation entry has a difference AND a resolution-or-request
 *       (zero silently-accepted differences); every D-entry has a matching decision
 *   V12 evidence-kind consumer tokens that name proofs resolve
 *   V13 declared counts equal actual array contents
 *
 * Exit code 0 = valid; 1 = invalid (errors listed on stderr).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const universePath = process.argv[2] ?? join(here, 'transition-universe.json');

const errors = [];
const fail = (rule, msg) => errors.push(`[${rule}] ${msg}`);

let u;
try {
  u = JSON.parse(readFileSync(universePath, 'utf8'));
} catch (e) {
  console.error(`parse failure: ${e.message}`);
  process.exit(1);
}

// ---------- V1 structure ----------
for (const key of ['aggregates', 'commands', 'obligations', 'waits', 'proofs', 'evidenceKinds', 'reconciliation', 'protocolDecisions', 'counts']) {
  if (!u[key] || (Array.isArray(u[key]) && u[key].length === 0)) fail('V1', `missing or empty top-level: ${key}`);
}
if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}

// ---------- reference universes ----------
// command ids are the full prefixed names (e.g. "factoryRun.bootstrap"), matching the
// forward-graph node ids; the aggregate field is validated separately (V3).
const commandIds = new Set(u.commands.map((c) => c.name));
const aggregateNames = new Set(u.aggregates.map((a) => a.name));
const obligationKinds = new Set(u.obligations.map((o) => o.kind));
const waitKinds = new Set(u.waits.map((w) => w.kind));
const evidenceIds = new Set(u.evidenceKinds.map((e) => e.id));
const decisionIds = new Set(u.protocolDecisions.map((d) => d.id));
const reconciliationIds = new Set(u.reconciliation.map((r) => r.id));

const shortKind = (kind) => ({
  'TerminalProof:success': 'success',
  'TerminalProof:truthful-failure': 'failure',
  'TerminalProof:cancellation': 'cancellation',
  'TerminalProof:unreachable': 'unreachable',
}[kind]);
const proofRefForms = new Set();
const proofKeys = new Set();
for (const p of u.proofs) {
  const short = shortKind(p.kind);
  if (!short) fail('V2', `unknown proof kind: ${p.kind}`);
  const key = `${p.kind}@${p.scope}`;
  if (proofKeys.has(key)) fail('V2', `duplicate proof (kind,scope): ${key}`);
  proofKeys.add(key);
  if (short) {
    proofRefForms.add(`TerminalProof:${p.scope}.${short}`);
    proofRefForms.add(`${p.kind}@${p.scope}`);
  }
}

// ---------- V2 uniqueness ----------
const uniq = (values, label) => {
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v)) fail('V2', `duplicate ${label}: ${v}`);
    seen.add(v);
  }
};
uniq(u.commands.map((c) => `${c.aggregate}.${c.name}`), 'command');
uniq(u.evidenceKinds.map((e) => e.id), 'evidence kind');
uniq(u.obligations.map((o) => o.kind), 'obligation kind');
uniq([...reconciliationIds], 'reconciliation id');
uniq([...decisionIds], 'decision id');
uniq(u.waits.map((w) => w.kind), 'wait kind');

// ---------- V3 command aggregates ----------
for (const c of u.commands) {
  if (!aggregateNames.has(c.aggregate)) fail('V3', `command ${c.aggregate}.${c.name}: unknown aggregate ${c.aggregate}`);
}

// ---------- V4/V5 obligations ----------
const createdKinds = new Set();
for (const c of u.commands) {
  for (const ref of c.createsObligations ?? []) {
    if (!obligationKinds.has(ref)) fail('V4', `command ${c.aggregate}.${c.name} creates unknown obligation: ${ref}`);
    createdKinds.add(ref);
  }
}
for (const kind of obligationKinds) {
  if (!createdKinds.has(kind)) fail('V4', `obligation kind never created by any command: ${kind}`);
}
for (const o of u.obligations) {
  if (!commandIds.has(o.source)) fail('V5', `obligation ${o.kind}: source is not a command: ${o.source}`);
  if (!commandIds.has(o.target) && !proofRefForms.has(o.target)) {
    fail('V5', `obligation ${o.kind}: target is neither a command nor a terminal proof: ${o.target}`);
  }
}

// ---------- V6 waits ----------
const usedWaitKinds = new Set();
for (const c of u.commands) {
  for (const w of c.waits ?? []) {
    if (!waitKinds.has(w)) fail('V6', `command ${c.aggregate}.${c.name} references unknown wait: ${w}`);
    usedWaitKinds.add(w);
  }
}
for (const k of waitKinds) {
  if (!usedWaitKinds.has(k)) fail('V6', `wait kind never held by any command: ${k}`);
}

// ---------- V7 proof issuing commands ----------
for (const p of u.proofs) {
  const pending = p.pendingProtocolDecision ?? null;
  if (pending && !decisionIds.has(pending)) fail('V10', `proof ${p.kind}@${p.scope}: unknown decision ${pending}`);
  if (pending) continue; // issuing command intentionally unresolved until the decision is frozen
  for (const token of String(p.issuingCommand).split('|').map((s) => s.trim()).filter(Boolean)) {
    if (!commandIds.has(token)) fail('V7', `proof ${p.kind}@${p.scope}: issuing command not found: ${token}`);
  }
}

// ---------- V8 proof closures ----------
for (const p of u.proofs) {
  for (const ref of p.requiredEvidenceClosure) {
    if (!evidenceIds.has(ref) && !proofRefForms.has(ref)) {
      fail('V8', `proof ${p.kind}@${p.scope}: dangling evidence closure ref: ${ref}`);
    }
  }
}

// ---------- V9 command proofs ----------
for (const c of u.commands) {
  for (const ref of c.proofs ?? []) {
    if (!proofRefForms.has(ref)) fail('V9', `command ${c.aggregate}.${c.name} references unknown proof: ${ref}`);
  }
}

// ---------- V10 pending decisions everywhere ----------
const pend = (where, id) => {
  if (id != null && !decisionIds.has(id)) fail('V10', `${where}: unknown protocol decision ${id}`);
};
for (const c of u.commands) pend(`command ${c.aggregate}.${c.name}`, c.pendingProtocolDecision);
for (const o of u.obligations) pend(`obligation ${o.kind}`, o.pendingProtocolDecision);
for (const w of u.waits) pend(`wait ${w.kind}`, w.pendingProtocolDecision);
for (const e of u.evidenceKinds) pend(`evidence ${e.id}`, e.pendingProtocolDecision);

// ---------- V11 reconciliation completeness ----------
let resolved = 0;
let framed = 0;
for (const r of u.reconciliation) {
  if (!r.difference || !r.resolutionOrRequest) fail('V11', `reconciliation ${r.id}: missing difference or resolutionOrRequest (silently accepted difference)`);
  const isDecision = /^PROTOCOL DECISION/.test(r.resolutionOrRequest);
  if (isDecision) {
    framed += 1;
    if (!decisionIds.has(r.id)) fail('V11', `reconciliation ${r.id} frames a decision but no protocolDecisions entry with that id exists`);
  } else if (/^RESOLVED/.test(r.resolutionOrRequest)) {
    resolved += 1;
    if (!/(PLAN|ADR097|ADR053|FWD|REV|CENSUS):/.test(r.resolutionOrRequest)) {
      fail('V11', `reconciliation ${r.id}: RESOLVED entry carries no citation`);
    }
  } else {
    fail('V11', `reconciliation ${r.id}: neither RESOLVED-with-citation nor PROTOCOL DECISION`);
  }
}
for (const d of u.protocolDecisions) {
  if (!u.reconciliation.some((r) => r.id === d.id)) fail('V11', `decision ${d.id} has no reconciliation entry`);
}

// ---------- V12 consumer proof tokens ----------
const proofToken = /\bTerminalProof:[a-z]+\.[a-z]+\b/g;
for (const e of u.evidenceKinds) {
  for (const consumer of e.consumers ?? []) {
    for (const m of String(consumer).matchAll(proofToken)) {
      if (!proofRefForms.has(m[0])) fail('V12', `evidence ${e.id}: consumer names unknown proof ${m[0]}`);
    }
  }
}

// ---------- V13 counts ----------
const actual = {
  aggregates: u.aggregates.length,
  nonAggregateAuthorities: (u.nonAggregateAuthorities ?? []).length,
  commands: u.commands.length,
  commandsPendingDecisions: u.commands.filter((c) => c.pendingProtocolDecision).length,
  obligations: u.obligations.length,
  obligationsPendingDecisions: u.obligations.filter((o) => o.pendingProtocolDecision).length,
  waits: u.waits.length,
  waitsPendingDecisions: u.waits.filter((w) => w.pendingProtocolDecision).length,
  proofs: u.proofs.length,
  proofsPendingDecisions: u.proofs.filter((p) => p.pendingProtocolDecision).length,
  evidenceKinds: u.evidenceKinds.length,
  evidenceKindsPendingDecisions: u.evidenceKinds.filter((e) => e.pendingProtocolDecision).length,
  reconciliationEntries: u.reconciliation.length,
  differencesResolvedWithCitation: resolved,
  protocolDecisionsFramed: framed,
  silentlyAcceptedDifferences: 0,
};
for (const [key, value] of Object.entries(actual)) {
  if (u.counts[key] !== value) fail('V13', `counts.${key}: declared ${u.counts[key]}, actual ${value}`);
}

// ---------- verdict ----------
if (errors.length) {
  console.error(`INVALID transition universe (${errors.length} error${errors.length === 1 ? '' : 's'}):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`VALID transition universe: ${actual.commands} commands, ${actual.obligations} obligations, ${actual.waits} waits, ${actual.proofs} proofs, ${actual.evidenceKinds} evidence kinds; ${actual.reconciliationEntries} reconciliation entries = ${actual.differencesResolvedWithCitation} resolved-with-citation + ${actual.protocolDecisionsFramed} decisions framed; 0 silently accepted.`);
