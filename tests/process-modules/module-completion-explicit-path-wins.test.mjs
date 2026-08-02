// tests/process-modules/module-completion-explicit-path-wins.test.mjs
//
// Wave 4.5 (Uncle Bob bridge) — the CRITICAL proof that the explicit
// ModuleCompletion path is WINNING (not just additive-foundation).
//
// Wave 4 made all 4 module settlement kernels emit `completion: ModuleCompletion`
// in their KernelHandlerResult. Wave 3 persists it to the NodeRun + restores it
// on crash-resume. BUT the explicit path at generic-flow-executor.ts:311-330
// reads `terminal.result.completion` — the TERMINAL node's result. Terminal
// nodes (complete-<code>) are served by the runtime-owned `process-outcome-emitter`,
// which does NOT forward `completion`. So before the Wave 4.5 fix,
// `terminal.result.completion` was undefined → the explicitCertificateRef branch
// did not engage → the certificate resolved via magic bindings → Wave 5 (magic-
// bindings deletion) would break certificate resolution.
//
// The Wave 4.5 fix (Approach A: executor-side completion tracking) makes the
// settlement kernel's completion surface as terminal.result.completion. This
// test PROVES the explicit path now wins.
//
// THE MISMATCH PROOF (the ONLY reliable proof):
//   The test injects a MISMATCH between the magic-bindings certificateHash and
//   the completion's certificateRef digest. If the resolved certificate matches
//   the completion's digest → the explicit path won. If it matches the magic
//   hash → magic is still winning and the fix failed. There is no third option
//   because the two values are deliberately different.
//
// WHAT THIS PROVES (the trace the task demands):
//   completion emitted by settle kernel
//     → pendingCompletion tracked in the walk loop
//     → terminal.result.completion set (merged, since emitter emits none)
//     → explicitCertificateRef branch engages at execute()
//     → certificate resolved from completion.outputEnvelope.certificateRef
//       (NOT from production.bindings magic envelope)

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { SqliteProcessOutcomeCertificateRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-outcome-certificate-repository.js'
);
const { SqliteNodeRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-node-run-repository.js'
);
const { GenericFlowExecutor } = await import(
  '../../dist/process-modules/application/generic-flow-executor.js'
);
const { KernelNodeExecutor } = await import(
  '../../dist/process-modules/application/node-executors/kernel-node-executor.js'
);
const { KernelHandlerRegistry } = await import(
  '../../dist/process-modules/application/kernel-handler-registry.js'
);
const {
  PROCESS_OUTCOME_EMITTER_HANDLER_ID,
  processOutcomeEmitter,
} = await import(
  '../../dist/process-modules/application/handlers/process-outcome-emitter.js'
);
const { sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);

// --- Fixtures ---------------------------------------------------------------

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-w45-explicit-'));
  process.env.DB_PATH = path.join(temp, 'explicit.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (70,1,'Mismatch')`).run();
  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

/**
 * Synthetic module mirroring the discovery shape: a settlement kernel that emits
 * BOTH a `completion` (explicit path) AND magic certificate bindings (legacy
 * path), followed by a terminal process-outcome-emitter. This is exactly the
 * shape all 4 modules have post-Wave-4.
 */
function mismatchModule() {
  return {
    identity: {
      name: 'mismatch-test',
      version: '1.0.0',
      kind: 'synthetic',
      displayName: 'Mismatch Proof Module',
      description: 'Wave 4.5 proof — explicit path must win over magic bindings.',
    },
    inputContract: { id: 'mismatch.input.v1' },
    outputContract: { id: 'mismatch.output.v1' },
    outcomes: [
      { code: 'accepted', description: 'happy path', terminal: true },
    ],
    flow: {
      id: 'mismatch.flow',
      version: '1.0.0',
      entryNodeId: 'settle',
      nodes: [
        {
          id: 'settle',
          label: 'Settle',
          kind: 'kernel',
          description: 'Settlement kernel that emits completion + magic bindings',
          handler: 'mismatch-settler',
          outputSchema: { id: 'mismatch.settlement.v1' },
        },
        {
          id: 'complete-accepted',
          label: 'Complete: accepted',
          kind: 'kernel',
          description: 'Emit accepted outcome',
          handler: PROCESS_OUTCOME_EMITTER_HANDLER_ID,
          emitsOutcome: 'accepted',
        },
      ],
      transitions: [
        { from: 'settle', to: 'complete-accepted', on: 'domain.accept' },
      ],
      terminalNodeIds: ['complete-accepted'],
    },
    artifacts: [],
    policies: [],
    invariants: [],
    executionProfiles: [],
  };
}

/**
 * The CRITICAL mismatch: the magic-bindings certificateHash and the completion's
 * certificateRef digest are DIFFERENT values. Whichever the executor resolves
 * tells us which path won.
 *
 *   EXPLICIT_DIGEST  = 'sha256:explicit-wins-AAAA...`  (completion path)
 *   MAGIC_HASH       = sha256Hex(magicPayload)         (magic-bindings path)
 *
 * MAGIC_HASH must equal the real sha256 of the magic certificate payload so the
 * magic path's own validator (`assertGenericCertificateEnvelope`) passes — that
 * is the only way the magic path could reach issue(). EXPLICIT_DIGEST is an
 * arbitrary distinct value (the explicit path surfaces the ref/digest directly
 * and does NOT re-hash any payload). The two deliberately differ, so whichever
 * the executor resolves is unambiguous proof.
 */
const magicPayloadForHash = {
  schemaVersion: 'mismatch.certificate.v1',
  decision: 'accepted',
  reasonCodes: [],
  rationale: 'magic payload (should NOT win)',
  inputHash: 'test-input-hash',
};
const MAGIC_HASH = sha256Hex(magicPayloadForHash);
const EXPLICIT_DIGEST = 'sha256:explicit-wins-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EXPLICIT_CERT_REF = 'mismatch-certificate:explicit-111';
const EXPLICIT_CERT_SCHEMA = 'mismatch.certificate.v1';

function buildExecutor(module, db) {
  const processRunRepo = new SqliteProcessRunRepository(db);
  const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);
  const nodeRunRepo = new SqliteNodeRunRepository(db);

  const handlerRegistry = new KernelHandlerRegistry();
  handlerRegistry.register(PROCESS_OUTCOME_EMITTER_HANDLER_ID, processOutcomeEmitter);

  // The settlement kernel emits BOTH paths — exactly as the 4 real modules do
  // post-Wave-4 (additive). The completion carries EXPLICIT_DIGEST; the magic
  // bindings carry MAGIC_HASH. They deliberately mismatch.
  handlerRegistry.register('mismatch-settler', () => {
    const outcome = 'accepted';
    const magicPayload = {
      schemaVersion: EXPLICIT_CERT_SCHEMA,
      decision: outcome,
      reasonCodes: [],
      rationale: 'magic payload (should NOT win)',
      inputHash: 'test-input-hash',
    };
    return {
      event: 'accept',
      production: {
        schema: 'mismatch.settlement.v1',
        artifactRef: 'settlement:mismatch',
        contentHash: EXPLICIT_DIGEST,
        bindings: {
          decision: 'accept',
          // MAGIC certificate envelope — the legacy path. Uses a DIFFERENT hash.
          certificatePayload: magicPayload,
          certificateHash: MAGIC_HASH,
          certificateSchema: EXPLICIT_CERT_SCHEMA,
          authority: 'mismatch-settlement-policy',
        },
      },
      // EXPLICIT terminal envelope — the Wave 4 path. Its digest differs from
      // MAGIC_HASH, so whichever the executor resolves is unambiguous proof.
      completion: {
        outcome,
        terminal: true,
        outputEnvelope: {
          outcome,
          productions: [],
          certificateRef: {
            schemaId: EXPLICIT_CERT_SCHEMA,
            ref: EXPLICIT_CERT_REF,
            digest: EXPLICIT_DIGEST,
          },
          completion: null,
        },
      },
    };
  });

  const kernelExecutor = new KernelNodeExecutor(handlerRegistry);
  const nodeExecutors = new Map([['kernel', kernelExecutor]]);

  return new GenericFlowExecutor({
    moduleRef: module.identity,
    processRunRepo,
    nodeRunRepo,
    certificateRepo,
    nodeExecutors,
  });
}

async function runOnce(module) {
  const ctx = fixture();
  try {
    const db = ctx.db;
    const processRunRepo = new SqliteProcessRunRepository(db);

    const executor = buildExecutor(module, db);

    const inputPayload = { epicId: 70, projectId: 1 };
    const inputHash = createHash('sha256').update(JSON.stringify(inputPayload)).digest('hex');
    const { record: run } = processRunRepo.start({
      moduleRef: module.identity,
      input: { schema: module.inputContract.id, payload: inputPayload, contentHash: inputHash },
      executorKind: 'generic-flow',
      projectedStage: 'mismatch',
      invocationContext: {
        projectId: 1,
        epicId: 70,
        initiatedBy: 'test',
        idempotencyKey: 'mismatch-epic-70',
      },
    });

    const result = await executor.execute(module, {
      projectId: 1,
      epicId: 70,
      processRunId: run.id,
      inputPayload,
      inputHash,
      initiatedBy: 'test',
    });

    const finalRun = processRunRepo.read(run.id);
    return { result, finalRun };
  } finally {
    cleanup(ctx.temp);
  }
}

// ===========================================================================
// THE PROOF: explicit path wins over magic bindings (mismatch test).
// ===========================================================================

test('Wave 4.5: explicit ModuleCompletion path WINS — resolved certificate matches the completion digest, NOT the magic hash', async () => {
  // MISMATCH GUARD: the two digest values MUST differ, otherwise the test cannot
  // prove which path won. EXPLICIT_DIGEST is a fixed sentinel; MAGIC_HASH is the
  // real sha256 of the magic payload. They are independent by construction.
  assert.notEqual(
    EXPLICIT_DIGEST,
    MAGIC_HASH,
    'mismatch guard: explicit digest and magic hash must differ for the proof to be meaningful',
  );

  const module = mismatchModule();
  const { result, finalRun } = await runOnce(module);

  // 1. The run completed with the expected outcome.
  assert.equal(result.outcome, 'accepted');
  assert.equal(finalRun.status, 'completed');
  assert.equal(finalRun.localOutcome, 'accepted');

  // 2. A certificate was resolved.
  assert.ok(result.certificate, 'certificate must be resolved');

  // 3. THE CRITICAL ASSERTION: the resolved certificate hash matches the
  //    completion's EXPLICIT_DIGEST, NOT the magic-bindings MAGIC_HASH. This is
  //    the mismatch proof — if magic won, certificateHash would equal MAGIC_HASH.
  assert.equal(
    result.certificate.certificateHash,
    EXPLICIT_DIGEST,
    'EXPLICIT PATH WON: certificate hash must be the completion digest '
      + `(expected ${EXPLICIT_DIGEST}). If this equals ${MAGIC_HASH}, the magic `
      + 'path is still winning and the Wave 4.5 fix failed.',
  );
  assert.notEqual(
    result.certificate.certificateHash,
    MAGIC_HASH,
    'MAGIC PATH MUST NOT WIN: certificate hash must NOT be the magic-bindings hash.',
  );

  // 4. The resolved certificate REF + SCHEMA come from the completion envelope.
  assert.equal(
    result.certificate.certificateRef,
    EXPLICIT_CERT_REF,
    'certificate ref must come from completion.outputEnvelope.certificateRef.ref',
  );
  assert.equal(
    result.certificate.schema,
    EXPLICIT_CERT_SCHEMA,
    'certificate schema must come from completion.outputEnvelope.certificateRef.schemaId',
  );
});

// ===========================================================================
// SANITY: when no completion is emitted (pre-Wave-4 handler), the magic path
// still resolves the certificate — proving the fix is additive (magic remains
// a working fallback until Wave 5 deletes it).
// ===========================================================================

test('Wave 4.5: magic-bindings fallback still resolves when no completion is emitted (additive — Wave 5 deletes this)', async () => {
  const ctx = fixture();
  try {
    const db = ctx.db;
    const processRunRepo = new SqliteProcessRunRepository(db);
    const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);
    const nodeRunRepo = new SqliteNodeRunRepository(db);

    const handlerRegistry = new KernelHandlerRegistry();
    handlerRegistry.register(PROCESS_OUTCOME_EMITTER_HANDLER_ID, processOutcomeEmitter);
    // Pre-Wave-4 handler: NO completion emitted. Magic bindings only.
    handlerRegistry.register('mismatch-settler', () => {
      const outcome = 'accepted';
      const magicPayload = {
        schemaVersion: EXPLICIT_CERT_SCHEMA,
        decision: outcome,
        reasonCodes: [],
        rationale: 'magic only',
        inputHash: 'test-input-hash',
      };
      // The magic path's validator asserts sha256Hex(payload) === certificateHash,
      // so the hash MUST be derived from THIS payload (not the shared MAGIC_HASH
      // constant, which hashes a different payload object).
      const magicHash = sha256Hex(magicPayload);
      return {
        event: 'accept',
        production: {
          schema: 'mismatch.settlement.v1',
          artifactRef: 'settlement:magic-only',
          contentHash: magicHash,
          bindings: {
            decision: 'accept',
            certificatePayload: magicPayload,
            certificateHash: magicHash,
            certificateSchema: EXPLICIT_CERT_SCHEMA,
            authority: 'mismatch-settlement-policy',
          },
        },
        // No completion — pre-Wave-4 shape.
      };
    });

    const kernelExecutor = new KernelNodeExecutor(handlerRegistry);
    const executor = new GenericFlowExecutor({
      moduleRef: mismatchModule().identity,
      processRunRepo,
      nodeRunRepo,
      certificateRepo,
      nodeExecutors: new Map([['kernel', kernelExecutor]]),
    });

    const module = mismatchModule();
    const inputPayload = { epicId: 70, projectId: 1 };
    const inputHash = createHash('sha256').update(JSON.stringify(inputPayload)).digest('hex');
    const { record: run } = processRunRepo.start({
      moduleRef: module.identity,
      input: { schema: module.inputContract.id, payload: inputPayload, contentHash: inputHash },
      executorKind: 'generic-flow',
      projectedStage: 'mismatch',
      invocationContext: {
        projectId: 1,
        epicId: 70,
        initiatedBy: 'test',
        idempotencyKey: 'mismatch-magic-only-70',
      },
    });

    const result = await executor.execute(module, {
      projectId: 1,
      epicId: 70,
      processRunId: run.id,
      inputPayload,
      inputHash,
      initiatedBy: 'test',
    });

    // Magic path resolved the certificate (hash recomputed by issue()).
    assert.ok(result.certificate, 'magic path must still resolve a certificate');
    // The certificate was issued with the magic payload, whose sha256 must match.
    // (Computed from the SAME payload shape the handler used.)
    const expectedMagicHash = sha256Hex({
      schemaVersion: EXPLICIT_CERT_SCHEMA,
      decision: 'accepted',
      reasonCodes: [],
      rationale: 'magic only',
      inputHash: 'test-input-hash',
    });
    assert.equal(
      result.certificate.certificateHash,
      expectedMagicHash,
      'magic path: certificate hash must be the sha256 of the magic payload',
    );
  } finally {
    cleanup(ctx.temp);
  }
});
