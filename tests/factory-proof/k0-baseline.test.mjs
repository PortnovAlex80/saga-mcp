// tests/factory-proof/k0-baseline.test.mjs
//
// K0 acceptance: the baseline exists, is non-vacuous, and is machine-checked.
//
//   K0-A: every composition surface on disk is inventoried (and the
//         inventory names real files — a new surface is a deliberate act);
//   K0-B: normalizeTrace is semantic — equal traces digest equal across
//         timestamps/paths; ANY semantic mutation changes the digest
//         (observer non-vacuity, one mutation per evidence class);
//   K0-C: the recorded floors match the live registry counts.
//   K0-E: committed-evidence digest identity — the CC-00 ledger and
//         CC-00-BASELINE.md digest pins equal SHA-256 over the RAW committed
//         git blob bytes (git cat-file) at the recorded base SHA; checkout
//         bytes (Windows CRLF materialization) are a different digest domain
//         and must never satisfy the pins (K0 baseline-identity repair).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPOSITION_SURFACES,
  normalizeTrace,
  traceDigest,
  K0_FLOORS,
} from './k0-baseline.mjs';
import { ACCEPTANCE_OBLIGATION_CONTRACTS } from './obligation-contracts.mjs';
import { STRUCTURAL_OPERATORS, RELATIONAL_OPERATORS } from './mutation-algebra.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// K0-A — composition inventory.
// ---------------------------------------------------------------------------

test('K0-A: every Factory test-composition surface is inventoried and real', () => {
  for (const surface of COMPOSITION_SURFACES) {
    assert.ok(existsSync(path.join(REPO_ROOT, surface.path)),
      `${surface.id}: file missing — ${surface.path}`);
    assert.ok(surface.overrideSurface.length > 0, `${surface.id}: declare the override surface`);
  }
  // The canonical surface is exactly one entry pointing at factory-proof.
  const canonical = COMPOSITION_SURFACES.filter(s => s.status.startsWith('canonical'));
  assert.equal(canonical.length, 1, 'exactly ONE canonical composition surface');
  // The three legacy surfaces named by the migration map are all present.
  const legacy = COMPOSITION_SURFACES.filter(s => s.status.startsWith('migration debt'));
  assert.equal(legacy.length, 3, 'the three legacy surfaces stay inventoried until retired');
});

// ---------------------------------------------------------------------------
// K0-B — normalized trace: semantic equality + non-vacuity.
// ---------------------------------------------------------------------------

const SAMPLE_TRACE = {
  observedAt: '2026-08-21T00:00:00.000Z',
  lifecycleRuns: [{ id: 1, status: 'completed', current_stage_id: null, terminal_status: 'runnable-local', updated_at: '2026-08-21T01:00:00Z' }],
  workplaces: [
    { workplace_ref: 'workplace/1/product-discovery@3.0.2/discovery-proposal/singleton', kanban_phase: 'done', loop_state: 'terminal', revision: 4, updated_at: 'x' },
  ],
  gateDecisions: [
    { decision_key: 'decision:gate-run:abc', workplace_ref: 'workplace/1/product-discovery@3.0.2/discovery-proposal/singleton', gate_phase: 'final', verdict: 'accepted', decided_at: 'y' },
  ],
  transitionObligations: [
    { obligation_key: 'close-presentation:wp1', source_kind: 's', source_ref: 'factory_workplaces/workplace/1/product-discovery@3.0.2/discovery-proposal/singleton', handoff_kind: 'close-presentation', state: 'completed', last_error: null },
  ],
  effectReceipts: [{ effect_key: 'git-integration:wp1', effect_kind: 'git', state: 'completed' }],
};

test('K0-B: semantically equal traces digest equal (timestamps and local paths ignored)', () => {
  const a = structuredClone(SAMPLE_TRACE);
  const b = structuredClone(SAMPLE_TRACE);
  b.observedAt = '2027-12-31T23:59:59.000Z';
  b.lifecycleRuns[0].updated_at = 'totally-different-time';
  b.workplaces[0].updated_at = 'later';
  assert.equal(traceDigest(a), traceDigest(b));
});

test('K0-B non-vacuity: every evidence class mutation changes the digest', () => {
  const base = traceDigest(SAMPLE_TRACE);
  const mutations = {
    'lifecycle terminal status': t => { t.lifecycleRuns[0].terminal_status = 'failed'; },
    'workplace loop state': t => { t.workplaces[0].loop_state = 'repair_wait'; },
    'gate verdict': t => { t.gateDecisions[0].verdict = 'repair_required'; },
    'obligation state': t => { t.transitionObligations[0].state = 'pending'; },
    'effect receipt state': t => { t.effectReceipts[0].state = 'effect_pending'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const t = structuredClone(SAMPLE_TRACE);
    mutate(t);
    assert.notEqual(traceDigest(t), base, `mutating '${name}' MUST change the normalized digest`);
  }
});

// ---------------------------------------------------------------------------
// K0-C — floors match the live registries.
// ---------------------------------------------------------------------------

test('K0-C: the recorded floors match the live kernel registries', () => {
  assert.equal(ACCEPTANCE_OBLIGATION_CONTRACTS.length, K0_FLOORS.obligationContracts,
    'the obligation floor moved — update K0_FLOORS in the same commit');
  assert.equal(STRUCTURAL_OPERATORS.length, K0_FLOORS.mutationOperators.structural);
  assert.equal(RELATIONAL_OPERATORS.length, K0_FLOORS.mutationOperators.relational);
  // The blocking file set floor: the group's factory-proof files on disk.
  const proofTests = readdirSync(HERE).filter(f => f.endsWith('.test.mjs')).length;
  assert.ok(proofTests >= K0_FLOORS.blockingFactoryProofFiles,
    `factory-proof test files shrank below the floor (${proofTests} < ${K0_FLOORS.blockingFactoryProofFiles})`);
});

// ---------------------------------------------------------------------------
// K0-E — committed-evidence digest identity (CC-00 baseline-identity repair).
//
// The authority for the CC-00 baseline digest pins is the RAW committed git
// blob byte sequence — read through `git cat-file blob` with binary-safe
// stdout capture (encoding 'buffer'), never through working-tree/checkout
// bytes and never through a shell pipeline (PowerShell pipelines re-encode
// LF to CRLF; core.autocrlf checkouts materialize CRLF — both produce a
// different, non-authoritative digest domain).
//
// The pins are verified unconditionally at HEAD (its tree is present even in
// a depth-1 CI clone), and additionally at the ledger's recorded baseSha
// whenever that commit object is present (every full clone and the CC-82
// clean-checkout gates) — the recorded gitBlobOids pin the base==HEAD blob
// identity the ledger claims.
// ---------------------------------------------------------------------------

const LEDGER_PATH = 'docs/factory-run/conformance-closure/CC-00-baseline-ledger.json';
const BASELINE_MD_PATH = 'docs/factory-run/conformance-closure/CC-00-BASELINE.md';
const EVIDENCE_FILES = [
  'tests/factory-evidence/conformance-report.json',
  'tests/factory-evidence/harvest-manifest.json',
];
const HEX64 = /^[0-9a-f]{64}$/;

function gitOk(args, { binary = false } = {}) {
  const res = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.ok(res.error === undefined, `git "${args.join(' ')}" could not run: ${res.error}`);
  assert.equal(res.status, 0,
    `git "${args.join(' ')}" failed: ${res.stderr ? res.stderr.toString().trim() : 'no stderr'}`);
  return res.stdout;
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function mdDigestPins(md) {
  const pins = {};
  for (const file of EVIDENCE_FILES) {
    const re = new RegExp('`' + file.replace(/\//g, '\\/') + '` sha256[^\\n]*\\n[^\\n]*`([0-9a-f]{64})`');
    const m = md.match(re);
    assert.ok(m, `CC-00-BASELINE.md digest pin missing for ${file} — every pinned evidence file needs a \`<path>\` sha256 line with a 64-hex value`);
    pins[file] = m[1];
  }
  return pins;
}

test('K0-E: ledger and baseline-doc digest pins equal SHA-256 of the raw committed git blob', () => {
  const ledger = JSON.parse(readFileSync(path.join(REPO_ROOT, LEDGER_PATH), 'utf8'));
  const md = readFileSync(path.join(REPO_ROOT, BASELINE_MD_PATH), 'utf8');
  const mdPins = mdDigestPins(md);

  // Ledger shape: pins present and well-formed (fail on missing/invalid 64-hex).
  const reportPin = ledger?.baselineRuns?.conformanceV1?.committedReportSha256;
  assert.match(reportPin ?? '', HEX64,
    'ledger baselineRuns.conformanceV1.committedReportSha256 must be a 64-hex sha256');
  const digestBlock = ledger?.committedEvidenceDigests;
  assert.ok(digestBlock, 'ledger committedEvidenceDigests block missing (digest domain/method statement)');
  for (const file of EVIDENCE_FILES) {
    const entry = digestBlock?.files?.[file];
    assert.match(entry?.sha256 ?? '', HEX64, `ledger committedEvidenceDigests.files['${file}'].sha256 must be 64-hex`);
    assert.match(entry?.gitBlobOid ?? '', /^[0-9a-f]{40}$/, `ledger committedEvidenceDigests.files['${file}'].gitBlobOid must be a 40-hex git oid`);
  }
  const baseSha = ledger?.baseSha;
  assert.match(baseSha ?? '', /^[0-9a-f]{7,40}$/, 'ledger baseSha must be a hex git commit id');

  // Cross-source equality: the ledger, its digest block, and the baseline doc
  // must carry ONE identical pin per file.
  assert.equal(reportPin, digestBlock.files[EVIDENCE_FILES[0]].sha256,
    'ledger conformanceV1 pin and committedEvidenceDigests report pin disagree');
  for (const file of EVIDENCE_FILES) {
    assert.equal(digestBlock.files[file].sha256, mdPins[file],
      `ledger pin and CC-00-BASELINE.md pin disagree for ${file}`);
  }

  // Authority check: raw committed git-blob bytes (never checkout bytes).
  for (const file of EVIDENCE_FILES) {
    const { sha256: pin, gitBlobOid } = digestBlock.files[file];

    const headOid = gitOk(['rev-parse', `HEAD:${file}`]).toString().trim();
    assert.equal(headOid, gitBlobOid,
      `${file}: HEAD blob oid ${headOid} != pinned ${gitBlobOid} — frozen evidence bytes drifted`);
    const headDigest = sha256(gitOk(['cat-file', 'blob', `HEAD:${file}`], { binary: true }));
    assert.equal(headDigest, pin,
      `${file}: sha256(raw git blob at HEAD) ${headDigest} != pin ${pin} — the pin must be the raw committed-blob digest, not a checkout/EOL-normalized digest`);

    // Where full history is present, verify the ledger's own domain claim
    // (digests AT THE RECORDED BASE SHA). A depth-1 CI clone lacks the base
    // commit; the HEAD check above still fully enforces the pinned bytes.
    const have = spawnSync('git', ['cat-file', '-e', `${baseSha}^{commit}`], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (have.status === 0) {
      const baseOid = gitOk(['rev-parse', `${baseSha}:${file}`]).toString().trim();
      assert.equal(baseOid, gitBlobOid,
        `${file}: base-SHA blob oid ${baseOid} != pinned ${gitBlobOid} — the pinned bytes are not the base-SHA blob`);
      const baseDigest = sha256(gitOk(['cat-file', 'blob', `${baseSha}:${file}`], { binary: true }));
      assert.equal(baseDigest, pin,
        `${file}: sha256(raw git blob at ${baseSha}) ${baseDigest} != pin ${pin}`);
    } else {
      console.log(`[k0-E] note: base commit ${baseSha} not in this clone (shallow?) — pins verified at HEAD blob only`);
    }
  }
});
