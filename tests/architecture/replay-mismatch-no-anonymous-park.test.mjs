// tests/architecture/replay-mismatch-no-anonymous-park.test.mjs
//
// K9 commit 6 — ban mismatch-to-anonymous-park (ADR-080 §5).
//
// A replay mismatch must resolve to a TYPED outcome: repair_required /
// regenerate / refuse / the lifecycle's own terminal outcome — never a
// parked card whose mismatch information lives only in an anonymous
// escalation string.
//
// Theorems:
//
//   1. HANDLER MAP (set equality): every src file whose CODE references a
//      replay-mismatch error code appears in the map below with its typed
//      handler, and every map entry names a currently-referencing file.
//      Adding a new handler site requires consciously classifying it here.
//   2. NO PARK WRITES in any mapped handler: none of the mismatch-handling
//      code contains task-status parks (UPDATE tasks SET status='blocked'),
//      park-reason assignments, or the anonymous escalate vocabulary.
//   3. The claim binder mutates ONLY the execution claim metadata and the
//      evidence tables — no tasks/lifecycle status writes at all.
//
// (dispatch-loop's per-card typed `card_error` valve — which converts an
// annotated binder failure into a poisoned card for the drain while the
// engine continues — is proven behaviorally by
// tests/infrastructure/dispatch-typed-outcomes.test.mjs and is the
// ROUTING destination of the adapter's annotated rethrow.)

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

const MISMATCH_CODES = [
  'REPLAY_KEY_PAYLOAD_CONFLICT',
  'REPLAY_CAPSULE_AUTHORITY_AMBIGUOUS',
  'CAPSULE_INVALIDATION_EVIDENCE_MISMATCH',
  'CAPSULE_INVALIDATION_PERSIST_FAILED',
  'CAPSULE_INVALIDATION_SUCCESSOR_BIND_FAILED',
  'PRODUCTION_RESUME_RESTART_REQUIRED',
];

// file → the typed handler its code performs for the mismatch.
//
// NOTE (payload-conflict): replay-capsule-selection.ts no longer appears here.
// It stopped expressing the conflict as an error code at all — it returns a
// typed `conflict` outcome and performs no I/O — so there is no alarm string in
// it left to classify. The binder still raises the typed alarm and therefore
// stays classified below.
const HANDLER_MAP = Object.freeze({
  'src/infrastructure/replay/replay-claim-binder.ts':
    'persists append-only evidence, then RAISES the typed alarm (CONVEYOR §15 '
    + 'fail-closed: no paid model inside the same execution); no status writes',
  'src/infrastructure/replay/sqlite-replay-capsule-repository.ts':
    'evidence persistence + derived invalidity → typed miss on claim paths',
  'src/process-modules/installation/production-install.ts':
    'records package-changed evidence, then the typed PRODUCTION_RESUME_RESTART_REQUIRED refusal',
});

function listTypeScriptFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...listTypeScriptFiles(abs));
    else if (entry.endsWith('.ts')) {
      out.push({
        rel: path.relative(REPO_ROOT, abs).split(path.sep).join('/'),
        abs,
      });
    }
  }
  return out;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');
}

function referencingFiles() {
  const files = listTypeScriptFiles(SRC_ROOT);
  return files.filter(({ abs }) => {
    const code = stripComments(readFileSync(abs, 'utf8'));
    return MISMATCH_CODES.some(code.includes.bind(code));
  }).map(({ rel }) => rel);
}

test('K9/no-park: every replay-mismatch handler site is classified (set equality)', () => {
  const referencing = [...referencingFiles()].sort();
  const classified = Object.keys(HANDLER_MAP).sort();
  assert.deepEqual(
    referencing,
    classified,
    'every src file whose CODE references a replay-mismatch error code must ' +
    'appear in the HANDLER_MAP with its typed handler (and no stale entries). ' +
    'A new handler site must be classified here in the same commit — an ' +
    'unclassified handler is exactly where an anonymous park could hide.',
  );
});

test('K9/no-park: no mismatch-handling code parks a task or uses anonymous escalation', () => {
  const violations = [];
  for (const rel of Object.keys(HANDLER_MAP)) {
    const code = stripComments(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
    if (/UPDATE\s+tasks\s+SET\s+status\s*=\s*'(blocked|review)'/iu.test(code)) {
      violations.push(`${rel}: task-status park write in a mismatch handler`);
    }
    if (/\bparkReason\b|\bpark_reason\b/u.test(code)) {
      violations.push(`${rel}: park-reason assignment in a mismatch handler`);
    }
    if (/\bescalate\b/iu.test(code)) {
      violations.push(`${rel}: anonymous escalate vocabulary in a mismatch handler`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    'ADR-080 §5: a replay mismatch resolves only via typed outcomes ' +
    '(repair_required / regenerate / refuse / lifecycle terminal). Parking ' +
    'with an anonymous reason hides the mismatch in a log string.',
  );
});

test('K9/no-park: the claim binder writes only claim metadata and evidence tables', () => {
  const code = stripComments(readFileSync(
    path.join(REPO_ROOT, 'src', 'infrastructure', 'replay', 'replay-claim-binder.ts'),
    'utf8',
  ));
  const writes = [...code.matchAll(/\b(UPDATE|INSERT\s+OR\s+(?:IGNORE|REPLACE)|INSERT\s+INTO|DELETE\s+FROM)\s+([a-z_]+)/giu)]
    .map(m => `${m[1].toUpperCase().split(/\s+/)[0]} ${m[2]}`);
  const allowed = new Set([
    'UPDATE worker_executions', // the frozen claim metadata
    'INSERT factory_replay_capsules', // certify/capture sweep (via repo)
    'INSERT factory_replay_capsule_invalidations', // append-only evidence
  ]);
  const illegal = writes.filter(w => !allowed.has(w));
  assert.deepEqual(
    illegal,
    [],
    'the binder may not mutate task/lifecycle/workplace state — mismatch ' +
    'routing belongs to dispatch and recovery, never to the claim binder',
  );
});
