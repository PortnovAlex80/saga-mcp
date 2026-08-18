// tools/adr-closure-registry.test.mjs
//
// Unit tests for the ADR-076 closure registry validator. All cases run
// against synthetic fixture directories in a temp folder — the real
// repository registry is exercised by
// tests/architecture/adr-closure-registry.test.mjs (K0 commit 4/4).

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CLOSURE_STATES,
  parseDecisionStatus,
  parseDecisionTitle,
  validateRegistry,
} from './adr-closure-registry.mjs';

const validatorPath = fileURLToPath(import.meta.url).replace(/\.test\.mjs$/, '.mjs');

function fixture({ files, registry }) {
  const root = mkdtempSync(join(tmpdir(), 'adr-closure-'));
  const decisionsDir = join(root, 'decisions');
  mkdirSync(decisionsDir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(decisionsDir, name), content);
  }
  const registryPath = join(root, 'adr-closure-registry.json');
  if (registry !== null) {
    writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  }
  return { decisionsDir, registryPath, root };
}

function adrFile(number, slug, { status = 'Accepted', title = `Decision ${number}` } = {}) {
  return `# ADR-${number}: ${title}\n\n- **Status:** ${status}\n- **Date:** 2026-08-17\n\nBody.\n`;
}

function baseRegistry(decisions) {
  return {
    schemaVersion: 1,
    evidenceBaseline: { commit: 'a'.repeat(40), capturedAt: '2026-08-17' },
    decisions,
  };
}

function ownedEntry(adr, overrides = {}) {
  return {
    adr,
    decisionStatus: 'accepted',
    closureState: 'planned',
    owningReleases: ['K20'],
    evidenceOwner: 'K20',
    successor: null,
    ...overrides,
  };
}

function codes(result) {
  return result.violations.map((v) => v.code);
}

test('parseDecisionStatus extracts the leading token and lowercases it', () => {
  assert.equal(parseDecisionStatus('- **Status:** Accepted (operator decision)'), 'accepted');
  assert.equal(parseDecisionStatus('**Status:** Proposed'), 'proposed');
  assert.equal(parseDecisionStatus('Status: accepted'), 'accepted');
  assert.equal(parseDecisionStatus('- **Status:** Superseded by 038'), 'superseded');
  assert.equal(parseDecisionStatus('no status header at all'), null);
});

test('parseDecisionTitle extracts the H1 title', () => {
  assert.equal(parseDecisionTitle('# ADR-076: Hello world\n'), 'Hello world');
  assert.equal(parseDecisionTitle('nothing'), null);
});

test('valid registry produces no violations', () => {
  const f = fixture({
    files: { '024-a.md': adrFile('024', 'a'), '025-b.md': adrFile('025', 'b', { status: 'Proposed' }) },
    registry: baseRegistry([
      ownedEntry('024'),
      ownedEntry('025', { decisionStatus: 'proposed', closureState: 'unassessed', owningReleases: [], evidenceOwner: '' }),
    ]),
  });
  const result = validateRegistry(f);
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
  assert.equal(result.summary.files, 2);
  assert.equal(result.summary.byState.planned, 1);
  rmSync(f.root, { recursive: true, force: true });
});

test('decision file without a registry entry fails with ENTRY_MISSING', () => {
  const f = fixture({
    files: { '024-a.md': adrFile('024', 'a'), '025-b.md': adrFile('025', 'b') },
    registry: baseRegistry([ownedEntry('024')]),
  });
  assert.ok(codes(validateRegistry(f)).includes('ENTRY_MISSING'));
  rmSync(f.root, { recursive: true, force: true });
});

test('registry entry without a decision file fails with ENTRY_ORPHAN', () => {
  const f = fixture({
    files: { '024-a.md': adrFile('024', 'a') },
    registry: baseRegistry([ownedEntry('024'), ownedEntry('099')]),
  });
  assert.ok(codes(validateRegistry(f)).includes('ENTRY_ORPHAN'));
  rmSync(f.root, { recursive: true, force: true });
});

test('duplicate registry entries fail with ENTRY_DUPLICATE', () => {
  const f = fixture({
    files: { '024-a.md': adrFile('024', 'a') },
    registry: baseRegistry([ownedEntry('024'), ownedEntry('024')]),
  });
  assert.ok(codes(validateRegistry(f)).includes('ENTRY_DUPLICATE'));
  rmSync(f.root, { recursive: true, force: true });
});

test('Accepted ADR without owning release and evidence owner fails with OWNERSHIP_MISSING', () => {
  const f = fixture({
    files: { '024-a.md': adrFile('024', 'a') },
    registry: baseRegistry([ownedEntry('024', { owningReleases: [], evidenceOwner: '' })]),
  });
  assert.ok(codes(validateRegistry(f)).includes('OWNERSHIP_MISSING'));
  rmSync(f.root, { recursive: true, force: true });
});

test('superseded without successor, unknown successor, and cycles are rejected', () => {
  const missing = fixture({
    files: { '024-a.md': adrFile('024', 'a') },
    registry: baseRegistry([ownedEntry('024', { closureState: 'superseded', successor: null })]),
  });
  assert.ok(codes(validateRegistry(missing)).includes('SUCCESSOR_MISSING'));

  const unknown = fixture({
    files: { '024-a.md': adrFile('024', 'a') },
    registry: baseRegistry([ownedEntry('024', { closureState: 'superseded', successor: '099' })]),
  });
  assert.ok(codes(validateRegistry(unknown)).includes('SUCCESSOR_UNKNOWN'));

  const cycle = fixture({
    files: {
      '024-a.md': adrFile('024', 'a', { status: 'Superseded' }),
      '025-b.md': adrFile('025', 'b', { status: 'Superseded' }),
    },
    registry: baseRegistry([
      ownedEntry('024', { decisionStatus: 'superseded', closureState: 'superseded', successor: '025' }),
      ownedEntry('025', { decisionStatus: 'superseded', closureState: 'superseded', successor: '024' }),
    ]),
  });
  assert.ok(codes(validateRegistry(cycle)).includes('SUCCESSOR_CYCLE'));
  for (const f of [missing, unknown, cycle]) rmSync(f.root, { recursive: true, force: true });
});

test('rejected entry without rationale fails; with rationale passes ownership rules', () => {
  const f = fixture({
    files: { '024-a.md': adrFile('024', 'a') },
    registry: baseRegistry([ownedEntry('024', { closureState: 'rejected' })]),
  });
  assert.ok(codes(validateRegistry(f)).includes('REJECTED_RATIONALE_MISSING'));

  const g = fixture({
    files: { '024-a.md': adrFile('024', 'a') },
    registry: baseRegistry([ownedEntry('024', { closureState: 'rejected', rationale: 'not implemented; superseded by different approach' })]),
  });
  assert.ok(!codes(validateRegistry(g)).includes('REJECTED_RATIONALE_MISSING'));
  assert.ok(!codes(validateRegistry(g)).includes('OWNERSHIP_MISSING'));
  for (const x of [f, g]) rmSync(x.root, { recursive: true, force: true });
});

test('registry decisionStatus diverging from the file header fails with STATUS_MISMATCH', () => {
  const f = fixture({
    files: { '024-a.md': adrFile('024', 'a', { status: 'Proposed' }) },
    registry: baseRegistry([ownedEntry('024', { decisionStatus: 'accepted' })]),
  });
  assert.ok(codes(validateRegistry(f)).includes('STATUS_MISMATCH'));
  rmSync(f.root, { recursive: true, force: true });
});

test('missing registry file fails with REGISTRY_MISSING', () => {
  const f = fixture({ files: { '024-a.md': adrFile('024', 'a') }, registry: null });
  const result = validateRegistry(f);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].code, 'REGISTRY_MISSING');
  rmSync(f.root, { recursive: true, force: true });
});

test('missing evidence baseline commit fails with EVIDENCE_BASELINE_MISSING', () => {
  const f = fixture({
    files: { '024-a.md': adrFile('024', 'a') },
    registry: { schemaVersion: 1, decisions: [ownedEntry('024')] },
  });
  assert.ok(codes(validateRegistry(f)).includes('EVIDENCE_BASELINE_MISSING'));
  rmSync(f.root, { recursive: true, force: true });
});

test('unknown closureState fails with STATE_INVALID', () => {
  const f = fixture({
    files: { '024-a.md': adrFile('024', 'a') },
    registry: baseRegistry([ownedEntry('024', { closureState: 'done-ish' })]),
  });
  assert.ok(codes(validateRegistry(f)).includes('STATE_INVALID'));
  rmSync(f.root, { recursive: true, force: true });
});

test('CLOSURE_STATES exposes the seven ADR-076 states', () => {
  assert.deepEqual(CLOSURE_STATES, [
    'unassessed', 'planned', 'in-progress', 'implemented', 'closed', 'superseded', 'rejected',
  ]);
});

test('CLI exits 0 on a valid fixture and 1 on an invalid one', () => {
  const good = fixture({
    files: { '024-a.md': adrFile('024', 'a') },
    registry: baseRegistry([ownedEntry('024')]),
  });
  const bad = fixture({
    files: { '024-a.md': adrFile('024', 'a'), '025-b.md': adrFile('025', 'b') },
    registry: baseRegistry([ownedEntry('024')]),
  });
  const ok = spawnSync(process.execPath, [validatorPath, '--decisions', good.decisionsDir, '--registry', good.registryPath], { encoding: 'utf8' });
  assert.equal(ok.status, 0, `stdout=${ok.stdout}\nstderr=${ok.stderr}`);
  const fail = spawnSync(process.execPath, [validatorPath, '--decisions', bad.decisionsDir, '--registry', bad.registryPath], { encoding: 'utf8' });
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /ENTRY_MISSING/);
  for (const f of [good, bad]) rmSync(f.root, { recursive: true, force: true });
});
