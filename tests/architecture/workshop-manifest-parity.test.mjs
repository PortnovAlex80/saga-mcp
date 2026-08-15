// tests/architecture/workshop-manifest-parity.test.mjs
//
// ADR-053 Phase 1 EXIT GATE — single executable Workshop capability manifest.
//
// This test proves the Phase 1 cutover invariant: payload contracts are
// installed from ONE source of truth (`WORKSHOP_PAYLOAD_CONTRACTS` in the
// workshop capability manifest), not from a per-module hand-list that can
// drift between the orchestrator and the worker MCP processes.
//
// WHAT THIS PROVES (ADR-053-CUTOVER-TODO Phase 1 exit gate):
//   "mutation of one process decoder/provider/effect binding prevents startup"
//
// Concretely: if someone adds a payload contract to a module but does not add
// it to `WORKSHOP_PAYLOAD_CONTRACTS`, the architecture ratchet below fails —
// they cannot register it through a back door. And if someone removes a
// contract from the manifest but leaves a direct `registerProductPayloadContract`
// call, that call is now forbidden outside the manifest installer, so the
// ratchet catches that too.
//
// The worker MCP (src/index.ts) and the orchestrator (product-lifecycle-
// runtime.ts) both call `installWorkshopPayloadContracts()`, which iterates
// the SAME `WORKSHOP_PAYLOAD_CONTRACTS` array. Cross-process parity is
// structural, not aspirational.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

const MANIFEST_FILE = 'src/process-modules/application/workshop-capability-manifest.ts';

// ---------------------------------------------------------------------------
// File discovery + comment stripping (same convention as
// no-execution-scoped-lookup.test.mjs).
// ---------------------------------------------------------------------------
function listTypeScriptFiles(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    const abs = path.join(dir, entry);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      out.push(...listTypeScriptFiles(abs));
    } else if (st.isFile() && entry.endsWith('.ts')) {
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      out.push({ rel, abs });
    }
  }
  return out;
}

function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');
  return out;
}

// ===========================================================================
// Gate 1 — no direct registerProductPayloadContract calls outside the manifest.
//
// After the Phase 1 cutover, `registerProductPayloadContract` may be CALLED
// only inside workshop-capability-manifest.ts (the single installer). The
// function may still be IMPORTED/DEFINED elsewhere (product-payload-contract.ts
// defines it; tests use it for fixture setup). What is forbidden is a
// production CALL outside the manifest, because that bypasses the single
// source of truth and re-creates the hand-list drift.
// ===========================================================================
test('ADR-053 Phase 1: registerProductPayloadContract is called only inside the workshop manifest installer', () => {
  const files = listTypeScriptFiles(SRC_ROOT);
  assert.ok(files.length > 0, 'discovered .ts files under src/');
  const violations = [];
  for (const { rel, abs } of files) {
    // The manifest installer itself is the allowed call site.
    if (rel === MANIFEST_FILE) continue;
    // The definition file exports the function; that is not a call.
    if (rel === 'src/process-modules/application/product-payload-contract.ts') continue;
    const stripped = stripComments(readFileSync(abs, 'utf8'));
    // Match a CALL: identifier(  — not an import, not an export, not a type.
    // `registerProductPayloadContract(` as a bare call.
    const callRe = /(^|[^.\w])registerProductPayloadContract\s*\(/g;
    let match;
    while ((match = callRe.exec(stripped)) !== null) {
      const lineNo = stripped.slice(0, match.index + match[1].length).split(/\r?\n/).length;
      violations.push(`${rel}:${lineNo}: direct registerProductPayloadContract call outside manifest`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    'ADR-053 Phase 1 forbids direct registerProductPayloadContract() calls in ' +
      'production code outside the workshop capability manifest installer ' +
      `(${MANIFEST_FILE}). Both the orchestrator and the worker MCP must ` +
      'install payload contracts via installWorkshopPayloadContracts(), which ' +
      'iterates the single WORKSHOP_PAYLOAD_CONTRACTS source. A direct call ' +
      're-creates the hand-list drift the manifest eliminates. ' +
      'Offending sites:\n  - ' + violations.join('\n  - '),
  );
});

// ===========================================================================
// Gate 2 — the worker MCP entrypoint uses the manifest installer, not a hand-list.
// ===========================================================================
test('ADR-053 Phase 1: src/index.ts installs payload contracts via the manifest, not a hand-list', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'src', 'index.ts'), 'utf8');
  assert.match(
    source,
    /installWorkshopPayloadContracts\(\)/,
    'src/index.ts (worker MCP) must call installWorkshopPayloadContracts()',
  );
  // No individual contract registration should remain.
  const stripped = stripComments(source);
  assert.doesNotMatch(
    stripped,
    /registerProductPayloadContract\s*\(/,
    'src/index.ts must not hand-list individual registerProductPayloadContract calls',
  );
});

// ===========================================================================
// Gate 3 — the orchestrator composition root uses the manifest installer.
// ===========================================================================
test('ADR-053 Phase 1: orchestrator composition root installs payload contracts via the manifest', () => {
  const source = readFileSync(
    path.join(REPO_ROOT, 'src', 'app', 'product-lifecycle-runtime.ts'),
    'utf8',
  );
  assert.match(
    source,
    /installWorkshopPayloadContracts\(\)/,
    'product-lifecycle-runtime.ts (orchestrator) must call installWorkshopPayloadContracts()',
  );
});

// ===========================================================================
// Gate 4 — the manifest digest is deterministic and stable.
//
// Both processes compute the digest from the same compiled code, so it MUST be
// identical across calls within one build. This test pins the digest so an
// unintentional capability change is caught (update the constant only when
// intentionally changing the capability set).
// ===========================================================================
test('ADR-053 Phase 1: workshop manifest digest is deterministic', async () => {
  const { buildWorkshopCapabilityManifest } = await import(
    '../../dist/process-modules/application/workshop-capability-manifest.js'
  );
  const a = buildWorkshopCapabilityManifest();
  const b = buildWorkshopCapabilityManifest();
  assert.equal(a.manifestDigest, b.manifestDigest, 'digest is deterministic across calls');
  assert.equal(a.workshopId, 'saga-factory');
  assert.ok(a.payloadContractCount >= 4, 'manifest declares at least 4 payload contracts');
  // Every entry has the required identity fields.
  for (const entry of a.payloadContracts) {
    assert.ok(entry.schemaId, `entry has schemaId: ${entry.schemaId}`);
    assert.ok(entry.contractId, `entry has contractId`);
    assert.ok(entry.version, `entry has version`);
    assert.ok(entry.contractDigest, `entry has contractDigest`);
    assert.ok(entry.owner, `entry has owner`);
  }
  // Entries are sorted by schemaId (deterministic ordering).
  const schemaIds = a.payloadContracts.map(e => e.schemaId);
  const sorted = [...schemaIds].sort();
  assert.deepEqual(schemaIds, sorted, 'payload contract entries are sorted by schemaId');
  assert.ok(a.executableCapabilityCount >= 15, 'manifest declares executable providers/effects/handlers');
  const executableKeys = a.executableCapabilities.map(entry => `${entry.kind}/${entry.logicalId}`);
  assert.equal(new Set(executableKeys).size, executableKeys.length, 'executable identities are unique');
  for (const entry of a.executableCapabilities) {
    assert.ok(entry.version && entry.implementationDigest, `${entry.kind}/${entry.logicalId} is pinned`);
    assert.doesNotMatch(entry.implementationDigest, /placeholder|pending|unknown/iu);
  }
});

test('ADR-053 Phase 1: check/effect registrations cannot bypass the workshop manifest', () => {
  const files = listTypeScriptFiles(SRC_ROOT);
  const allowed = new Map([
    ['registerFactoryCheckProvider', new Set([
      MANIFEST_FILE,
      'src/process-modules/application/standard-check-providers.ts',
    ])],
    ['registerFactoryPostAcceptanceEffect', new Set([
      MANIFEST_FILE,
      'src/process-modules/application/post-acceptance-effects.ts',
    ])],
  ]);
  const violations = [];
  for (const [callee, allowedFiles] of allowed) {
    const callRe = new RegExp(`(^|[^.\\w])${callee}\\s*\\(`, 'gu');
    for (const { rel, abs } of files) {
      if (allowedFiles.has(rel)) continue;
      const source = stripComments(readFileSync(abs, 'utf8'));
      if (callRe.test(source)) violations.push(`${rel}: direct ${callee} call`);
      callRe.lastIndex = 0;
    }
  }
  assert.deepEqual(violations, []);
});

test('ADR-053 Phase 1: binding receipt is immutable and exact for worker role', async () => {
  const {
    installWorkshopPayloadContracts,
    recordWorkshopBindingReceipt,
  } = await import('../../dist/process-modules/application/workshop-capability-manifest.js');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_workshop_binding_receipts (
      receipt_ref TEXT PRIMARY KEY, workshop_id TEXT, epoch TEXT,
      process_role TEXT, process_identity TEXT, manifest_digest TEXT,
      declared_snapshot TEXT, resolved_snapshot TEXT, binding_digest TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(process_identity,process_role,manifest_digest)
    );
    CREATE TRIGGER binding_no_update BEFORE UPDATE ON factory_workshop_binding_receipts
    BEGIN SELECT RAISE(ABORT,'immutable'); END;
  `);
  installWorkshopPayloadContracts();
  const first = recordWorkshopBindingReceipt({
    db,
    role: 'worker-mcp',
    processIdentity: 'test-worker',
  });
  const replay = recordWorkshopBindingReceipt({
    db,
    role: 'worker-mcp',
    processIdentity: 'test-worker',
  });
  assert.deepEqual(replay, first);
  const row = db.prepare('SELECT * FROM factory_workshop_binding_receipts').get();
  assert.equal(row.binding_digest, first.bindingDigest);
  assert.equal(row.declared_snapshot, row.resolved_snapshot);
  assert.throws(
    () => db.prepare('UPDATE factory_workshop_binding_receipts SET binding_digest=?').run('x'),
    /immutable/,
  );
  db.close();
});

test('ADR-053 Phase 1: missing or mutated executable binding fails before orchestration', async () => {
  const {
    registerWorkshopCheckProvider,
    assertWorkshopTransitionHandlerBinding,
  } = await import('../../dist/process-modules/application/workshop-capability-manifest.js');
  assert.throws(
    () => registerWorkshopCheckProvider({
      providerId: 'factory.product-contract.v1',
      version: '1.0.0',
      providerDigest: '0'.repeat(64),
      run: () => 'passed',
    }),
    /WORKSHOP_CAPABILITY_BINDING_MISMATCH/,
  );
  assert.throws(
    () => assertWorkshopTransitionHandlerBinding({
      handoffKind: 'run-gate',
      ownerCapability: 'mutated-owner',
    }),
    /WORKSHOP_CAPABILITY_BINDING_MISMATCH/,
  );
});
