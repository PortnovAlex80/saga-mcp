// Unit tests for AC-2 (#218): readSelfSessionId + extractInputs.
// DoD: unit-test readSelfSessionId on reference metadata.json; unit-test
// extractInputs → fingerprint-array comparison of two runs (idempotency, NFR-2);
// manual SQL-filter cross-check against §2b.4 (asserted here programmatically).
//
// Convention (matches tests/dispatcher-race/*): import from compiled dist/.
// Run via:  npm run test  (builds dist/ then runs node:test)
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import {
  readSelfSessionId,
} from '../../dist/helpers/selfid.js';
import {
  extractInputs,
  fingerprintOf,
  INPUTS_SQL,
  QUERY_SQL_ZCODE,
} from '../../dist/helpers/completeness.js';

const thisDir = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(thisDir, 'fixtures');

// ---------------------------------------------------------------------------
// readSelfSessionId
// ---------------------------------------------------------------------------
describe('readSelfSessionId (SRS §2b.4)', () => {
  it('returns parentSessionId of the status:running record (array form)', () => {
    const id = readSelfSessionId(join(FIXTURES, 'metadata-running.json'));
    assert.equal(id, 'sess-parent-abc-123');
  });

  it('returns null when no status:running record exists', () => {
    const id = readSelfSessionId(join(FIXTURES, 'metadata-no-running.json'));
    assert.equal(id, null);
  });

  it('returns null when the metadata file is missing (caller must fail loudly)', () => {
    const id = readSelfSessionId(join(FIXTURES, 'does-not-exist.json'));
    assert.equal(id, null);
  });

  it('handles a single-object (non-array) metadata file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'selfid-'));
    try {
      const p = join(dir, 'metadata.json');
      writeFileSync(p, JSON.stringify({ status: 'running', parentSessionId: 'single-obj-1' }));
      assert.equal(readSelfSessionId(p), 'single-obj-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a running record whose parentSessionId is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'selfid-'));
    try {
      const p = join(dir, 'metadata.json');
      writeFileSync(p, JSON.stringify([
        { status: 'running', parentSessionId: '' },
        { status: 'running', parentSessionId: 'real-2' },
      ]));
      assert.equal(readSelfSessionId(p), 'real-2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null on corrupt (unparseable) metadata.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'selfid-'));
    try {
      const p = join(dir, 'metadata.json');
      writeFileSync(p, '{ not valid json');
      assert.equal(readSelfSessionId(p), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Helper: build a temp db.sqlite with the REAL zcode message/part schema and
// populate it with user/assistant + synthetic + non-text parts, so the filter
// is exercised against realistic data.
// ---------------------------------------------------------------------------
function makeZcodeDb(sessionId, rows) {
  const dir = mkdtempSync(join(tmpdir(), 'compl-'));
  const dbPath = join(dir, 'db.sqlite');
  const db = new Database(dbPath);
  // Minimal real-shape schema (data column holds JSON, like the live zcode DB).
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE session (id TEXT PRIMARY KEY);
  `);
  const insMsg = db.prepare('INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)');
  const insPart = db.prepare('INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)');
  let mi = 0, pi = 0;
  for (const r of rows) {
    const msgId = `m${++mi}`;
    insMsg.run(msgId, sessionId, r.created, r.created, JSON.stringify({
      role: r.role,
      time: { created: r.created },
      ...(r.synthetic ? { synthetic: true } : {}),
    }));
    for (const part of r.parts) {
      insPart.run(`p${++pi}`, msgId, sessionId, r.created, r.created, JSON.stringify({
        type: part.type,
        text: part.text ?? '',
        time: { start: r.created, end: r.created },
      }));
    }
  }
  db.close();
  return { dbPath, dir };
}

// A parent session with: 2 genuine user text inputs, 1 synthetic user input
// (must be filtered out), 1 assistant text (filtered by role), 1 user tool part
// (filtered by part.type != text).
const PARENT = 'sess-parent-abc-123';
const FIXTURE_ROWS = [
  { role: 'user', created: 1000, parts: [{ type: 'text', text: 'Hello, plan a feature.' }] },
  { role: 'assistant', created: 1100, parts: [{ type: 'text', text: 'Sure, here is a plan.' }] }, // role!=user
  { role: 'user', created: 1200, parts: [{ type: 'text', text: 'Also cover the DB.' }] },
  { role: 'user', created: 1300, synthetic: true, parts: [{ type: 'text', text: 'synthetic noise' }] }, // synthetic
  { role: 'user', created: 1400, parts: [{ type: 'tool', text: 'tool call text' }] }, // part.type!=text
];

// ---------------------------------------------------------------------------
// extractInputs
// ---------------------------------------------------------------------------
describe('extractInputs (SRS §2b.4)', () => {
  it('extracts only role=user & non-synthetic & part.type=text inputs, ordered, with I-NNN ids', async () => {
    const { dbPath, dir } = makeZcodeDb(PARENT, FIXTURE_ROWS);
    try {
      const res = await extractInputs(PARENT, { dbPath });
      assert.equal(res.source, 'db.sqlite');
      assert.equal(res.total_count, 2, 'exactly the 2 genuine user text inputs');
      assert.equal(res.inputs[0].i_id, 'I-001');
      assert.equal(res.inputs[1].i_id, 'I-002');
      assert.equal(res.inputs[0].text, 'Hello, plan a feature.');
      assert.equal(res.inputs[1].text, 'Also cover the DB.');
      // ordered by created_at ascending
      assert.equal(res.inputs[0].timestamp, '1000');
      assert.equal(res.inputs[1].timestamp, '1200');
      assert.equal(res.gate_passed, true);
      // AC-7: authoritative source → high completeness, not degraded.
      assert.equal(res.completeness, 'high');
      assert.equal(res.degraded, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is fingerprint-idempotent across two runs (NFR-2): identical inputs[] + fingerprints', async () => {
    const { dbPath, dir } = makeZcodeDb(PARENT, FIXTURE_ROWS);
    try {
      const r1 = await extractInputs(PARENT, { dbPath });
      const r2 = await extractInputs(PARENT, { dbPath });
      // byte-identical serialization → captures i_id, timestamp, text, fingerprint
      assert.equal(JSON.stringify(r1.inputs), JSON.stringify(r2.inputs));
      // explicit fingerprint-array comparison (DoD)
      assert.deepEqual(
        r1.inputs.map((i) => i.fingerprint),
        r2.inputs.map((i) => i.fingerprint),
      );
      // and each fingerprint is the sha1(text[:100]+timestamp) per the contract
      for (const i of r1.inputs) {
        assert.equal(i.fingerprint, fingerprintOf(i.text, i.timestamp));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fingerprint = sha1(text.slice(0,100)+timestamp) and is stable', () => {
    const text = 'x'.repeat(250); // >100 chars → only first 100 matter
    const a = fingerprintOf(text, '1700000000');
    const b = fingerprintOf(text.slice(0, 100), '1700000000'); // same head
    const c = fingerprintOf(text, '1700000001');               // diff timestamp
    assert.equal(a, b, 'only the first 100 chars feed the fingerprint');
    assert.notEqual(a, c, 'timestamp changes the fingerprint');
    assert.match(a, /^[0-9a-f]{40}$/, '40-hex sha1');
  });

  it('falls back to rollout-jsonl (source, gate_passed=false) when db is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'compl-'));
    try {
      const rolloutPath = join(dir, 'model-io-sess_test.jsonl');
      writeFileSync(rolloutPath, [
        JSON.stringify({ text: 'old line' }),
        JSON.stringify({ text: 'latest user input from rollout' }),
      ].join('\n') + '\n');
      const res = await extractInputs('test', {
        dbPath: join(dir, 'no-such.sqlite'),
        rolloutPath,
      });
      assert.equal(res.source, 'rollout-jsonl');
      assert.equal(res.gate_passed, false);
      assert.equal(res.inputs[0].text, 'latest user input from rollout');
      assert.equal(res.total_count, 1);
      // AC-7: fallback must leave the degraded marker (no silent low pass).
      assert.equal(res.completeness, 'low');
      assert.equal(res.degraded, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty db result (gate false) when neither source yields anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'compl-'));
    try {
      const res = await extractInputs('orphan-sess', {
        dbPath: join(dir, 'no-such.sqlite'),
        rolloutPath: join(dir, 'no-such.jsonl'),
      });
      assert.equal(res.source, 'db.sqlite');
      assert.equal(res.total_count, 0);
      assert.equal(res.gate_passed, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts an injected db (test seam) without opening/closing its own', async () => {
    const { dbPath, dir } = makeZcodeDb(PARENT, FIXTURE_ROWS);
    try {
      const inj = new Database(dbPath, { readonly: true });
      const res = await extractInputs(PARENT, { db: inj });
      assert.equal(res.total_count, 2);
      inj.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SQL-filter cross-check against SRS §2b.4 (DoD: manual filter cross-check,
// asserted here programmatically against the frozen contract string).
// ---------------------------------------------------------------------------
describe('INPUTS_SQL contract (SRS §2b.4)', () => {
  it('frozen INPUTS_SQL contains the exact §2b.4 filter clauses', () => {
    assert.match(INPUTS_SQL, /role\s*=\s*'user'/i);
    assert.match(INPUTS_SQL, /synthetic\s+IS\s+NOT\s+TRUE/i);
    assert.match(INPUTS_SQL, /type\s*=\s*'text'/i);
    assert.match(INPUTS_SQL, /session_id\s*=\s*\?/i);
    assert.match(INPUTS_SQL, /JOIN\s+part\s+p\s+ON\s+p\.message_id\s*=\s*m\.id/i);
  });

  it('QUERY_SQL_ZCODE (real schema) applies the SAME filter semantics via json_extract', () => {
    // role='user'
    assert.match(QUERY_SQL_ZCODE, /json_extract\(m\.data,'\$\.role'\)\s*=\s*'user'/i);
    // synthetic IS NOT TRUE
    assert.match(QUERY_SQL_ZCODE, /json_extract\(m\.data,'\$\.synthetic'\)\s+IS\s+NOT\s+TRUE/i);
    // part.type='text'
    assert.match(QUERY_SQL_ZCODE, /json_extract\(p\.data,'\$\.type'\)\s*=\s*'text'/i);
    // session_id = ? (only bind param)
    assert.match(QUERY_SQL_ZCODE, /m\.session_id\s*=\s*\?/i);
    // exactly one placeholder in the realized query
    assert.equal((QUERY_SQL_ZCODE.match(/\?/g) || []).length, 1);
  });
});

// ---------------------------------------------------------------------------
// AC-7 (#223) — degraded/fallback observability markers.
//
// DoD:
//   #1 extractInputs(dbPath='nonexistent.db') → source='rollout-jsonl',
//      gate_passed=false.
//   #3 (grep-test) every fallback run leaves a marker completeness=low /
//      degraded=true in the (serialized) output — jointly with AC-10/NFR-5.
//
// The fallback BRANCH itself was implemented by AC-2 (#218); AC-7 adds the
// observable marker fields on CompletenessResult (completeness, degraded) so
// the degraded path is grep-assertable and maps onto BriefPayload (SRS §2b.2).
// ---------------------------------------------------------------------------
describe('AC-7 degraded/fallback markers (SRS §2b.2 / §2b.4)', () => {
  it('DoD#1: nonexistent db → source=rollout-jsonl, gate_passed=false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac7-'));
    try {
      const rolloutPath = join(dir, 'model-io-sess_orphan.jsonl');
      writeFileSync(rolloutPath, JSON.stringify({ text: 'degraded user input' }) + '\n');
      const res = await extractInputs('orphan', {
        dbPath: join(dir, 'nonexistent.db'),
        rolloutPath,
      });
      assert.equal(res.source, 'rollout-jsonl');
      assert.equal(res.gate_passed, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DoD#3: a fallback run serializes with the completeness=low / degraded=true markers (grep-anchor)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac7-'));
    try {
      const rolloutPath = join(dir, 'model-io-sess_orphan.jsonl');
      writeFileSync(rolloutPath, JSON.stringify({ text: 'degraded user input' }) + '\n');
      const res = await extractInputs('orphan', {
        dbPath: join(dir, 'nonexistent.db'),
        rolloutPath,
      });
      // The serialized CompletenessResult must carry both markers verbatim so a
      // downstream brief (and the AC-10 grep audit) can find them.
      const serialized = JSON.stringify(res);
      assert.match(serialized, /"completeness":"low"/);
      assert.match(serialized, /"degraded":true/);
      // and the inverted markers are NEVER present on the fallback path
      assert.doesNotMatch(serialized, /"completeness":"high"/);
      assert.doesNotMatch(serialized, /"degraded":false/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no silent low pass: authoritative db source never reports completeness=low/degraded=true', async () => {
    const { dbPath, dir } = makeZcodeDb(PARENT, FIXTURE_ROWS);
    try {
      const res = await extractInputs(PARENT, { dbPath });
      assert.equal(res.source, 'db.sqlite');
      assert.equal(res.completeness, 'high');
      assert.equal(res.degraded, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('empty authoritative db (0 rows, no rollout) stays high/false — not a degraded source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac7-'));
    try {
      // a real but empty DB
      const emptyDbPath = join(dir, 'empty.sqlite');
      const db = new Database(emptyDbPath);
      db.exec(`
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      `);
      db.close();
      const res = await extractInputs(PARENT, {
        dbPath: emptyDbPath,
        rolloutPath: join(dir, 'no-such.jsonl'),
      });
      assert.equal(res.source, 'db.sqlite');
      assert.equal(res.total_count, 0);
      assert.equal(res.gate_passed, false);
      // readable-but-empty is authoritative, not degraded
      assert.equal(res.completeness, 'high');
      assert.equal(res.degraded, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
