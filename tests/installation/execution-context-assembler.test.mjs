// tests/installation/execution-context-assembler.test.mjs
//
// W3-A5 — ExecutionContextAssembler conformance tests (spec §8, §9.11,
// §0.6.12 exit gate; plan §7.7).
//
// Coverage:
//   - Positive: assembleExecutionContext loads each declared upstream product
//     by EXACT ProductRef and constructs the Wave 1 ExecutionContextEnvelope.
//   - Negative (spec §9.11): a missing predecessor product throws
//     UpstreamProductNotFoundError (UPSTREAM_PRODUCT_NOT_FOUND) — NO epic-
//     scope / latest-in-run fallback. This is the no-fallback-reconstruction
//     proof (spec §11 W3-A8 row 3, exercised here at the unit level).
//   - Negative: missing ProcessRun → ProcessRunNotFoundError.
//   - Driver-neutrality (plan §13.16, C061): the assembled envelope base has
//     NO forbidden driver-neutral keys (taskId/epicId/projectId/etc.); they
//     live only in frozenAuthority as projection data.
//   - Immutability: upstreamProducts is frozen; the envelope carries the
//     caller-declared refs verbatim (not a "latest in run" reconstruction).
//   - frozenAuthority is sourced from the durable ProcessRun (outcome
//     authority + invocation context), never mutated mid-assembly.
//   - packageRef / nodeRef resolution: pinned from packageIdentity +
//     installedDigest / flowIdentity; legacy fallback when null.
//
// ISOLATION NOTE: W3-A4 (ProcessProductRepository v2 port + adapter) runs in
// parallel and is ABSENT in this worktree. The test injects a FAKE matching
// the W3-A4 port shape (`getByProductRef(ref)` → record | null, keyed by
// exact `(schemaId, ref, digest)`). The assembler declares the same port
// shape locally; at Wave 3 cherry-pick the integrator rebinds both to A4's
// real port. The fakes here match the port contract by construction.

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  assembleExecutionContext,
  UpstreamProductNotFoundError,
  ProcessRunNotFoundError,
  ForbiddenDriverNeutralKeyError,
  UPSTREAM_PRODUCT_NOT_FOUND,
  resolvePackageRef,
  resolveNodeRef,
} = await import(
  '../../dist/process-modules/application/execution-context-assembler.js'
);

// ---------------------------------------------------------------------------
// Fakes matching the port shapes the assembler consumes.
// ---------------------------------------------------------------------------

/**
 * Fake ProcessProductRepository (W3-A4 port shape). Keyed by the exact
 * `(schemaId, ref, digest)` triple — getByProductRef returns the record only
 * when ALL THREE match. There is NO epic-scope fallback in this fake; that is
 * the whole point of spec §9.11.
 */
function makeFakeProductRepo(store) {
  return {
    getByProductRef(ref) {
      const hit = store.find(
        (p) =>
          p.productRef.schemaId === ref.schemaId &&
          p.productRef.ref === ref.ref &&
          p.productRef.digest === ref.digest,
      );
      return hit ?? null;
    },
  };
}

/**
 * Fake ProcessRunRepository. Only `read` is consumed by the assembler; the
 * other methods are stubs (the assembler does not call them).
 */
function makeFakeProcessRunRepo(records) {
  return {
    read(id) {
      return records.find((r) => r.id === id) ?? null;
    },
  };
}

/**
 * Fake NodeRunRepository. Only `readLatest(processRunId, nodeId)` is
 * consumed; the assembler pins nodeRunId from the latest matching-attempt
 * row.
 */
function makeFakeNodeRunRepo(rows) {
  return {
    readLatest(processRunId, nodeId) {
      return (
        rows
          .filter((r) => r.processRunId === processRunId && r.nodeId === nodeId)
          .sort((a, b) => b.id - a.id)[0] ?? null
      );
    },
  };
}

function makeProcessRunRecord(overrides = {}) {
  return {
    id: 42,
    moduleRef: { name: 'product-discovery', version: '3.0.0' },
    moduleRefKey: 'product-discovery@3.0.0',
    projectId: 7,
    epicId: 99,
    idempotencyKey: 'idem-1',
    inputSchema: 'saga3.discovery-case.v1',
    inputSnapshot: JSON.stringify({ problem: 'p', observed: 'o' }),
    inputHash: 'abc',
    status: 'running',
    executorKind: 'generic-flow',
    projectedStage: 'discovery',
    localOutcome: null,
    authority: 'saga3.kernel/issuer',
    outputSchema: null,
    outputRef: null,
    outputHash: null,
    certificateSchema: null,
    certificateRef: null,
    certificateHash: null,
    executorRunRef: null,
    activeIssue: null,
    error: null,
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test('assembleExecutionContext: loads each declared upstream product by exact ProductRef and returns the envelope', async () => {
  const refA = { schemaId: 'saga3.proposal.v1', ref: 'proposal:141', digest: 'dA' };
  const refB = { schemaId: 'saga3.readiness.v1', ref: 'readiness:141', digest: 'dB' };
  const productStore = [
    { productRef: refA, payload: { proposalId: 141 } },
    { productRef: refB, payload: { ready: true } },
  ];
  const deps = {
    productRepo: makeFakeProductRepo(productStore),
    processRunRepo: makeFakeProcessRunRepo([makeProcessRunRecord()]),
    nodeRunRepo: makeFakeNodeRunRepo([
      { id: 301, processRunId: 42, nodeId: 'settle', attempt: 1 },
    ]),
  };

  const { envelope, upstreamProductBodies } = await assembleExecutionContext(
    42,
    'settle',
    1,
    [refA, refB],
    deps,
    {
      packageIdentity: { name: 'product-discovery', version: '3.0.0' },
      flowIdentity: { flowId: 'discovery-flow', flowVersion: '3.0.0' },
      installedDigest: 'sha256:pkg-abc',
    },
  );

  // Envelope base identity.
  assert.equal(envelope.processRunId, 42);
  assert.equal(envelope.nodeRunId, 301);
  assert.equal(envelope.attempt, 1);
  assert.match(envelope.executionId, /^ecx-42-settle-1-[a-z0-9]+-[0-9a-z]+$/);

  // packageRef / nodeRef pinned from packageIdentity + installedDigest /
  // flowIdentity.
  assert.deepEqual(envelope.packageRef, {
    name: 'product-discovery',
    version: '3.0.0',
    digest: 'sha256:pkg-abc',
  });
  assert.deepEqual(envelope.nodeRef, {
    nodeId: 'settle',
    flowId: 'discovery-flow',
    flowVersion: '3.0.0',
  });

  // upstreamProducts carries the caller-declared refs verbatim (NOT a
  // "latest in run" reconstruction), and is frozen.
  assert.deepEqual([...envelope.upstreamProducts], [refA, refB]);
  assert.ok(Object.isFrozen(envelope.upstreamProducts), 'upstreamProducts must be frozen');

  // immutableRunInput parsed from the durable ProcessRun snapshot.
  assert.deepEqual(envelope.immutableRunInput, { problem: 'p', observed: 'o' });

  // Loaded bodies returned in declared order, each productRef == queried ref.
  assert.equal(upstreamProductBodies.length, 2);
  assert.deepEqual(upstreamProductBodies[0].productRef, refA);
  assert.deepEqual(upstreamProductBodies[1].productRef, refB);
});

test('assembleExecutionContext (spec §9.11): missing predecessor product throws UpstreamProductNotFoundError — NO epic-scope fallback', async () => {
  const refA = { schemaId: 'saga3.proposal.v1', ref: 'proposal:141', digest: 'dA' };
  const missingRef = {
    schemaId: 'saga3.readiness.v1',
    ref: 'readiness:141',
    digest: 'dB',
  };
  // The store has refA but NOT missingRef. A fallback implementation would
  // return the "latest readiness in epic"; this assembler MUST NOT.
  const productStore = [{ productRef: refA, payload: { proposalId: 141 } }];
  const deps = {
    productRepo: makeFakeProductRepo(productStore),
    processRunRepo: makeFakeProcessRunRepo([makeProcessRunRecord()]),
    nodeRunRepo: makeFakeNodeRunRepo([]),
  };

  await assert.rejects(
    () => assembleExecutionContext(42, 'settle', 1, [refA, missingRef], deps),
    (err) => {
      assert.ok(err instanceof UpstreamProductNotFoundError, 'must be UpstreamProductNotFoundError');
      assert.equal(err.code ?? err.name, undefined === err.code ? 'UpstreamProductNotFoundError' : err.code);
      assert.equal(err.processRunId, 42);
      assert.equal(err.nodeId, 'settle');
      assert.deepEqual(err.missingRef, missingRef);
      // The message must explicitly mention no epic-scope fallback (§9.11).
      assert.match(err.message, /no epic-scope fallback/);
      return true;
    },
  );
});

test('UPSTREAM_PRODUCT_NOT_FOUND error code constant is exported for callers that switch on error.code', () => {
  assert.equal(UPSTREAM_PRODUCT_NOT_FOUND, 'UPSTREAM_PRODUCT_NOT_FOUND');
  // UpstreamProductNotFoundError exposes the missing ref for the caller.
  const err = new UpstreamProductNotFoundError(1, 'n', {
    schemaId: 's',
    ref: 'r',
    digest: 'd',
  });
  assert.equal(err.name, 'UpstreamProductNotFoundError');
  assert.deepEqual(err.missingRef, { schemaId: 's', ref: 'r', digest: 'd' });
});

test('assembleExecutionContext: exact-match is strict — a different digest does NOT fall back to same-schema/ref', async () => {
  // Store has the right (schemaId, ref) but a DIFFERENT digest. The exact
  // query must miss; the assembler must throw rather than return the
  // same-schema neighbor (which is what the epic-scope fallback used to do).
  const queried = {
    schemaId: 'saga3.proposal.v1',
    ref: 'proposal:141',
    digest: 'd-exact',
  };
  const neighbor = {
    schemaId: 'saga3.proposal.v1',
    ref: 'proposal:141',
    digest: 'd-different',
  };
  const deps = {
    productRepo: makeFakeProductRepo([{ productRef: neighbor, payload: {} }]),
    processRunRepo: makeFakeProcessRunRepo([makeProcessRunRecord()]),
    nodeRunRepo: makeFakeNodeRunRepo([]),
  };

  await assert.rejects(
    () => assembleExecutionContext(42, 'settle', 1, [queried], deps),
    (err) => {
      assert.ok(err instanceof UpstreamProductNotFoundError);
      assert.deepEqual(err.missingRef, queried);
      return true;
    },
  );
});

test('assembleExecutionContext: missing ProcessRun throws ProcessRunNotFoundError', async () => {
  const deps = {
    productRepo: makeFakeProductRepo([]),
    processRunRepo: makeFakeProcessRunRepo([]), // no run
    nodeRunRepo: makeFakeNodeRunRepo([]),
  };
  await assert.rejects(
    () => assembleExecutionContext(999, 'n', 1, [], deps),
    (err) => {
      assert.ok(err instanceof ProcessRunNotFoundError);
      assert.equal(err.processRunId, 999);
      return true;
    },
  );
});

test('assembleExecutionContext: empty upstream list yields an empty (frozen) upstreamProducts — no predecessor lookup needed', async () => {
  const deps = {
    productRepo: makeFakeProductRepo([]),
    processRunRepo: makeFakeProcessRunRepo([makeProcessRunRecord()]),
    nodeRunRepo: makeFakeNodeRunRepo([]),
  };
  const { envelope } = await assembleExecutionContext(42, 'entry', 1, [], deps);
  assert.equal(envelope.upstreamProducts.length, 0);
  assert.ok(Object.isFrozen(envelope.upstreamProducts));
});

test('assembleExecutionContext (plan §13.16, C061): envelope BASE has no forbidden driver-neutral keys', async () => {
  const ref = { schemaId: 's', ref: 'r', digest: 'd' };
  const deps = {
    productRepo: makeFakeProductRepo([{ productRef: ref, payload: {} }]),
    processRunRepo: makeFakeProcessRunRepo([makeProcessRunRecord()]),
    nodeRunRepo: makeFakeNodeRunRepo([]),
  };
  const { envelope } = await assembleExecutionContext(42, 'n', 1, [ref], deps);

  // Base-level forbidden keys must be absent (taskId/epicId/projectId/
  // workIntentId/boardId are NOT contract base fields).
  for (const k of ['taskId', 'epicId', 'projectId', 'workIntentId', 'boardId']) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(envelope, k),
      `envelope base must not carry forbidden key '${k}'`,
    );
  }
  // projectId/epicId are durable invocation context — they live in
  // frozenAuthority as projection data, NOT on the base.
  assert.equal(envelope.frozenAuthority.projectId, 7);
  assert.equal(envelope.frozenAuthority.epicId, 99);
  assert.equal(envelope.frozenAuthority.outcomeAuthority, 'saga3.kernel/issuer');
});

test('assembleExecutionContext: nodeRunId is 0 when no NodeRun row matches the attempt (pre-start assembly)', async () => {
  const ref = { schemaId: 's', ref: 'r', digest: 'd' };
  const deps = {
    productRepo: makeFakeProductRepo([{ productRef: ref, payload: {} }]),
    processRunRepo: makeFakeProcessRunRepo([makeProcessRunRecord()]),
    // latest row is attempt 1, but we ask for attempt 2 → no match → 0.
    nodeRunRepo: makeFakeNodeRunRepo([
      { id: 500, processRunId: 42, nodeId: 'n', attempt: 1 },
    ]),
  };
  const { envelope } = await assembleExecutionContext(42, 'n', 2, [ref], deps);
  assert.equal(envelope.nodeRunId, 0);
});

test('assembleExecutionContext: nodeRunId pins the latest matching-attempt row on resume', async () => {
  const ref = { schemaId: 's', ref: 'r', digest: 'd' };
  const deps = {
    productRepo: makeFakeProductRepo([{ productRef: ref, payload: {} }]),
    processRunRepo: makeFakeProcessRunRepo([makeProcessRunRecord()]),
    nodeRunRepo: makeFakeNodeRunRepo([
      { id: 10, processRunId: 42, nodeId: 'n', attempt: 1 },
      { id: 11, processRunId: 42, nodeId: 'n', attempt: 2 }, // latest for node
    ]),
  };
  const { envelope } = await assembleExecutionContext(42, 'n', 2, [ref], deps);
  assert.equal(envelope.nodeRunId, 11);
});

test('resolvePackageRef: pinned digest from installedDigest; legacy sentinel when null', () => {
  const run = makeProcessRunRecord();
  // Pinned run.
  assert.deepEqual(
    resolvePackageRef(
      run,
      { name: 'product-discovery', version: '3.0.0' },
      'sha256:pkg',
    ),
    { name: 'product-discovery', version: '3.0.0', digest: 'sha256:pkg' },
  );
  // Legacy run (no installation pin yet — W3-A3 not landed).
  assert.deepEqual(
    resolvePackageRef(run, null, null),
    {
      name: 'product-discovery',
      version: '3.0.0',
      digest: 'legacy:unpinned',
    },
  );
});

test('resolveNodeRef: flowIdentity when provided; module fallback when null', () => {
  const run = makeProcessRunRecord();
  assert.deepEqual(
    resolveNodeRef('settle', { flowId: 'discovery-flow', flowVersion: '3.0.0' }, run),
    { nodeId: 'settle', flowId: 'discovery-flow', flowVersion: '3.0.0' },
  );
  assert.deepEqual(resolveNodeRef('settle', null, run), {
    nodeId: 'settle',
    flowId: 'product-discovery',
    flowVersion: '3.0.0',
  });
});

test('assembleExecutionContext: recoveryFeedback / scenarioId / stageId are attached when provided', async () => {
  const ref = { schemaId: 's', ref: 'r', digest: 'd' };
  const deps = {
    productRepo: makeFakeProductRepo([{ productRef: ref, payload: {} }]),
    processRunRepo: makeFakeProcessRunRepo([makeProcessRunRecord()]),
    nodeRunRepo: makeFakeNodeRunRepo([]),
  };
  const feedback = { kind: 'retry', note: 'transient' };
  const { envelope } = await assembleExecutionContext(42, 'n', 1, [ref], deps, {
    recoveryFeedback: feedback,
    scenarioId: 'product-delivery',
    stageId: 'discovery',
  });
  assert.deepEqual(envelope.recoveryFeedback, feedback);
  assert.equal(envelope.scenarioId, 'product-delivery');
  assert.equal(envelope.stageId, 'discovery');
});

test('assembleExecutionContext: two assemblies in the same tick produce distinct executionIds (per-attempt fencing)', async () => {
  const ref = { schemaId: 's', ref: 'r', digest: 'd' };
  const deps = {
    productRepo: makeFakeProductRepo([{ productRef: ref, payload: {} }]),
    processRunRepo: makeFakeProcessRunRepo([makeProcessRunRecord()]),
    nodeRunRepo: makeFakeNodeRunRepo([]),
  };
  const a = await assembleExecutionContext(42, 'n', 1, [ref], deps);
  const b = await assembleExecutionContext(42, 'n', 1, [ref], deps);
  assert.notEqual(a.envelope.executionId, b.envelope.executionId);
});
