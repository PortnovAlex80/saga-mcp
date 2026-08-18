// tests/architecture/one-accepted-head-writer.test.mjs
//
// THE K13 RATCHET (card commit 6, M3): direct writes to the accepted head
// outside the one Gate-proven path are banned MECHANICALLY. The exit gate
// of the whole release — "every accepted write is attributable to one
// Gate-proven AuthorityCommit" — must survive future commits, not just this
// one.
//
// WHAT IT ASSERTS (three fences, strongest first):
//   1. COMPILED-SURFACE BAN: across the ENTIRE compiled tree (dist/ — what
//      actually ships), no INSERT/UPDATE/DELETE against
//      factory_accepted_authority_head exists outside the repository module
//      that owns the table. The permitted writer is not a string guess — it
//      is the module THIS TEST IMPORTS; if the import path ever drifts, the
//      exemption and the import fail together.
//   2. MUTATING-SURFACE PIN: the repository's prototype exposes exactly the
//      frozen method set below (one mutator: record; the rest are reads and
//      the idempotent schema ensure). Adding a method — especially a second
//      mutator — must change this pin in the same commit, by name.
//   3. CALLER FENCE: `authorityHeadRepo.record(` appears in exactly ONE
//      compiled file: the coordinator, inside applyVerifiedAcceptance — the
//      mutation reachable solely through CommitAcceptedCandidate's verified
//      proof (pinned by the K12 exit-gate suite; this ratchet adds the
//      compiled-tree half).
//
// THE FAILURE THIS PREVENTS. The G3 dossier's defect class: a capability or
// a shortcut that lets a second writer touch authority tables directly,
// laundered by a persisted column. Stage-7/8 closed the worker-side grant
// and the state short-circuit; K13 closes the head's write surface. This
// ratchet is what keeps all three closed after the release ends.
//
// EXTENDING THE FORBIDDEN SET is a deliberate architectural act: the set is
// the table itself plus the prototype pin plus the caller fence. Widening
// any of them (a new writer file, a new repository mutator, a second caller)
// requires the decision, its ADR reference, and this file, in one commit.
//
// NEGATIVE VALIDATION (recorded in the commit that landed this ratchet):
// a direct INSERT temporarily added to src/app/product-lifecycle-runtime.ts
// and compiled — the ratchet went RED naming that file; the violation
// removed — GREEN. The prototype pin was validated the same way (a temporary
// second mutator went RED by name).

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqliteAcceptedAuthorityHeadRepository } from '../../dist/infrastructure/workplace/sqlite-accepted-authority-head-repository.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_ROOT = path.join(REPO_ROOT, 'dist');

/** The ONE module permitted to write the accepted head — by import, not by name. */
const HEAD_REPOSITORY_MODULE = 'infrastructure/workplace/sqlite-accepted-authority-head-repository.js';

/**
 * The frozen surface of the head repository. `record` is the ONLY mutator;
 * `requireFullIdentity` / `assertSameRevisionIdentity` are its private
 * helpers (content-addressing and the same-revision conflict check);
 * `ensureK13IdentityColumns` performs idempotent additive ALTERs inside the
 * constructor (schema bring-up, not data authority); the rest are reads.
 * Adding a name here is the same deliberate act as adding a writer.
 */
const FROZEN_REPOSITORY_SURFACE = Object.freeze([
  'constructor',
  'ensureK13IdentityColumns',
  'record',
  'requireFullIdentity',
  'assertSameRevisionIdentity',
  'readAuthorCandidateSetRef',
  'readAuthorTaskId',
  'read',
]);

/** The ONE compiled file permitted to call the repository's record(). */
const PERMITTED_RECORD_CALLER = 'process-modules/application/production-cell-coordinator.js';

function walk(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else if (entry.endsWith('.js')) out.push({ rel, abs });
  }
  return out;
}

const WRITE_PATTERN = /INSERT (OR REPLACE )?INTO factory_accepted_authority_head|UPDATE factory_accepted_authority_head|DELETE FROM factory_accepted_authority_head/iu;
const RECORD_CALL_PATTERN = /authorityHeadRepo\s*\.\s*record\s*\(/u;

test('K13/ratchet: the accepted head is written by ONE module across the entire compiled tree', () => {
  const files = walk(DIST_ROOT);
  assert.ok(files.length >= 200,
    `anti-vacuity: the compiled tree scan covers dist (${files.length} files); `
    + 'if this drops, the walk is broken — fix it before trusting green');
  const writers = [];
  for (const { rel, abs } of files) {
    if (rel === HEAD_REPOSITORY_MODULE) continue;
    if (WRITE_PATTERN.test(readFileSync(abs, 'utf8'))) writers.push(rel);
  }
  assert.deepEqual(writers, [],
    'the accepted head is written ONLY by its repository module (imported by '
    + 'this test). Every other direct write — any file, any branch — is the '
    + 'G3 defect class and must fail here by name.');
  console.log(`[one-accepted-head-writer] ${files.length} compiled files scanned; writer = ${HEAD_REPOSITORY_MODULE}`);
});

test('K13/ratchet: the repository exposes exactly the frozen surface (one mutator: record)', () => {
  const actual = Object.getOwnPropertyNames(SqliteAcceptedAuthorityHeadRepository.prototype).sort();
  assert.deepEqual(actual, [...FROZEN_REPOSITORY_SURFACE].sort(),
    'the head repository\'s method surface is frozen. Adding a method — above '
    + 'all a second mutator — is a deliberate architectural act: name it, '
    + 'justify it, and move this pin in the SAME commit.');
});

test('K13/ratchet: record() is called from exactly ONE compiled file — the verified acceptance coordinator', () => {
  const files = walk(DIST_ROOT);
  const callers = [];
  for (const { rel, abs } of files) {
    if (rel === PERMITTED_RECORD_CALLER) continue;
    if (RECORD_CALL_PATTERN.test(readFileSync(abs, 'utf8'))) callers.push(rel);
  }
  assert.deepEqual(callers, [],
    `authorityHeadRepo.record() is called only from ${PERMITTED_RECORD_CALLER} `
    + '(inside applyVerifiedAcceptance, reachable solely through '
    + 'CommitAcceptedCandidate — the K12 exit-gate suite pins the src side; '
    + 'this pins the compiled tree).');
});
