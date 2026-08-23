import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  ensureLocalRunnabilityProviderTrust,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
} from '../../dist/infrastructure/verification/local-runnability-check-provider.js';
import {
  CURRENT_PROVIDER_ENTRY,
  HISTORICAL_DIGEST_BY_VERSION,
  HISTORICAL_PROVIDER_HISTORY,
  HISTORY_PROVIDER_ID,
  PROVIDER_HISTORY,
} from './local-runnability-provider-history.mjs';

// ---------------------------------------------------------------------------
// K19 digest repair (2026-08-23) — the durable, NON-circular oracle for the
// trusted-providers migration history.
//
// The expected history lives in ./local-runnability-provider-history.mjs: a
// checked, provenance-annotated vector reconstructed independently from the
// git commits that introduced each provider version. It is NEVER generated
// from production values — production (TRUSTED_PROVIDER_BASELINES +
// ensureLocalRunnabilityProviderTrust) is the system UNDER test here, and
// the vector is the authority it must conform to.
//
// Before this repair, production baselines for 1.3.1–1.11.0 were corrupted
// (one hex character duplicated near the tail → 65 chars) and the tests
// copied the same constants, so the battery was circular and a real database
// holding an authentic historical trust_basis was falsely rejected as
// LOCAL_RUNNABILITY_TRUST_POLICY_DRIFT.
// ---------------------------------------------------------------------------

const LOWERCASE_HEX_64 = /^[0-9a-f]{64}$/u;

/** The versions whose production baselines were corrupted before the repair. */
const AFFECTED_VERSIONS = [
  '1.3.1', '1.4.0', '1.5.0', '1.6.0', '1.7.0',
  '1.8.0', '1.9.0', '1.10.0', '1.11.0',
];

/** Corrupt a digest by DUPLICATING one character (the observed defect class: 65 chars). */
function duplicatedChar(digest, index) {
  return digest.slice(0, index) + digest[index] + digest.slice(index);
}

/** Corrupt a digest by SUBSTITUTING one character (length stays 64 — catches format-only fences). */
function substitutedChar(digest, index) {
  const replacement = digest[index] === '0' ? '1' : '0';
  return digest.slice(0, index) + replacement + digest.slice(index + 1);
}

/** Seed one exact-metadata trusted_providers row with the given (version, basis) pair. */
function seedTrustRow(db, version, trustBasis) {
  db.prepare(
    `INSERT INTO trusted_providers
       (project_id,name,version,category,trust_basis,determinism,scope,status)
     VALUES(NULL,?,?, 'deterministic_evidence', ?,'full','local-runnability','active')`,
  ).run(HISTORY_PROVIDER_ID, version, trustBasis);
}

function openDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trusted_providers(
      id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, version TEXT,
      category TEXT, trust_basis TEXT, determinism TEXT, scope TEXT, status TEXT
    );
  `);
  return db;
}

/** Seed + migrate one baseline row; returns the post-migration row. */
function migrateFromBaseline(version, trustBasis) {
  const db = openDb();
  try {
    seedTrustRow(db, version, trustBasis);
    ensureLocalRunnabilityProviderTrust(db);
    const row = db.prepare(
      'SELECT version, trust_basis, status FROM trusted_providers WHERE name=?',
    ).get(HISTORY_PROVIDER_ID);
    // Idempotence: re-running the migration over its own result is a no-op.
    ensureLocalRunnabilityProviderTrust(db);
    return row;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 1. The oracle itself must be structurally sound.
// ---------------------------------------------------------------------------
test('history oracle: every shipped digest is exact 64-lowercase-hex with unique ascending versions and provenance', () => {
  assert.ok(PROVIDER_HISTORY.length >= 16, 'the vector covers the full shipped lineage 1.0.0–1.14.0');
  const seen = new Set();
  for (const entry of PROVIDER_HISTORY) {
    assert.match(entry.digest, LOWERCASE_HEX_64,
      `${entry.version}: "${entry.digest}" is not exact 64-lowercase-hex — a sha256 is never 65+ chars (this is the exact corruption class the 2026-08-23 repair removed)`);
    assert.ok(!seen.has(entry.version), `${entry.version} appears twice in the history vector`);
    seen.add(entry.version);
    assert.match(entry.introducedBy, /^[0-9a-f]{40}$/u,
      `${entry.version}: introducedBy must be a full git commit sha (provenance)`);
  }
  const toVersionTuple = (version) => version.split('.').map(part => Number(part));
  const tupleLess = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const av = a[i] ?? 0;
      const bv = b[i] ?? 0;
      if (av !== bv) return av < bv;
    }
    return false;
  };
  for (let i = 1; i < PROVIDER_HISTORY.length; i += 1) {
    const prev = PROVIDER_HISTORY[i - 1].version;
    const next = PROVIDER_HISTORY[i].version;
    assert.ok(tupleLess(toVersionTuple(prev), toVersionTuple(next)),
      `history must be ordered oldest-first: ${prev} before ${next}`);
  }
  // The vector's CURRENT entry must be exactly what production ships now —
  // this pins the runtime constants to the independently reconstructed value
  // and forces every future bump to APPEND to this vector.
  assert.equal(CURRENT_PROVIDER_ENTRY.version, LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
    'the vector current entry must track the production provider version');
  assert.equal(CURRENT_PROVIDER_ENTRY.digest, LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
    'the production digest must equal the independently reconstructed current-entry digest');
});

// ---------------------------------------------------------------------------
// 2. Positive conformance battery: the production migration accepts the
//    AUTHENTIC basis of EVERY shipped historical version (including every
//    version whose baseline was corrupted before the repair) and migrates it
//    to the current trust exactly once.
// ---------------------------------------------------------------------------
test('trust history conformance: every authentic historical basis (1.0.0–1.13.0, incl. the corrupted-then-repaired 1.3.1–1.11.0) migrates to the current trust', () => {
  assert.equal(HISTORICAL_PROVIDER_HISTORY.length, PROVIDER_HISTORY.length - 1,
    'exactly one current entry; everything else is migration-eligible history');
  for (const entry of HISTORICAL_PROVIDER_HISTORY) {
    const row = migrateFromBaseline(entry.version, `built-in:${entry.digest}`);
    assert.deepEqual(row, {
      version: LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
      trust_basis: `built-in:${LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST}`,
      status: 'active',
    }, `the authentic ${entry.version} row (digest ${entry.digest}) must migrate in place to the current exact trust`);
  }
});

// ---------------------------------------------------------------------------
// 3. Negative conformance battery: ONE character of corruption anywhere in
//    the basis fails closed — both the length-changing duplication class that
//    produced the false drift, and a same-length substitution. The fence is
//    exact-value, never format-only.
// ---------------------------------------------------------------------------
test('trust history conformance: a ONE-character corrupted basis on any version fails closed (never migrated, never re-trusted)', () => {
  // The affected range plus two controls from the never-corrupted range.
  const versions = [...AFFECTED_VERSIONS, '1.0.0', '1.12.0'];
  for (const version of versions) {
    const authentic = HISTORICAL_DIGEST_BY_VERSION[version];
    assert.ok(authentic, `oracle must cover ${version}`);

    // (a) duplication near the tail — the exact observed corruption class
    // (one hex character duplicated at tail position 61 → 65 chars).
    const duplicated = duplicatedChar(authentic, 61);
    assert.equal(duplicated.length, 65);
    assert.notEqual(duplicated, authentic);
    assert.throws(
      () => migrateFromBaseline(version, `built-in:${duplicated}`),
      /LOCAL_RUNNABILITY_TRUST_POLICY_DRIFT/u,
      `${version} with one duplicated tail character must fail closed as drift`,
    );

    // (b) single-character substitution — same 64-char length, one flipped
    // hex digit. Passing this would mean the fence only checks shape.
    const substituted = substitutedChar(authentic, 63);
    assert.equal(substituted.length, 64);
    assert.notEqual(substituted, authentic);
    assert.throws(
      () => migrateFromBaseline(version, `built-in:${substituted}`),
      /LOCAL_RUNNABILITY_TRUST_POLICY_DRIFT/u,
      `${version} with one substituted character must fail closed as drift`,
    );
  }
});

test('trust history conformance: an authentic digest pinned to the WRONG version is drift (the version→digest PAIR is the authority)', () => {
  // 1.13.0's authentic digest on a 1.12.0 row: both values individually
  // authentic, the pair foreign — must never migrate.
  assert.throws(
    () => migrateFromBaseline('1.12.0', `built-in:${HISTORICAL_DIGEST_BY_VERSION['1.13.0']}`),
    /LOCAL_RUNNABILITY_TRUST_POLICY_DRIFT/u,
    'an authentic digest on the wrong version is drift — the pair, not the version, is exact',
  );
});
