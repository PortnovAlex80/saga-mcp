import assert from 'node:assert/strict';
import test from 'node:test';

const {
  createDeliveryKernelHandlers,
  DELIVERY_NODE_IDS,
} = await import(
  '../../dist/modules/delivery/application/delivery-installation.js'
);
const {
  DELIVERY_KERNEL_HANDLER_IDS,
} = await import(
  '../../dist/modules/delivery/domain/delivery-kernel-ports.js'
);
const {
  deliveryProcessModule,
} = await import(
  '../../dist/process-modules/modules/delivery/delivery-process-module.js'
);
const deliverySchemas = await import(
  '../../dist/modules/delivery/domain/delivery-schemas.js'
);
const deliveryPolicy = await import(
  '../../dist/modules/delivery/domain/delivery-settlement-policy.js'
);

function reference(schema, ref, hash) {
  return { schema, ref, hash };
}

function deferredCase() {
  const profileBody = {
    schemaVersion: deliverySchemas.DELIVERY_DEFERRED_PROFILE_SCHEMA,
    reason: 'authorization-required',
    source: 'start-from-idea',
  };
  return {
    schemaVersion: deliverySchemas.DELIVERY_RELEASE_CASE_SCHEMA,
    projectId: 1,
    epicId: 10,
    developmentCertificate: {
      ...reference(
        'saga3.development-certificate.v1',
        'development-certificate:1',
        'development-certificate-hash',
      ),
      decision: 'verified',
    },
    verifiedIntegrationBundle: reference(
      'saga3.verified-integration-bundle.v1',
      'verified-bundle:1',
      'verified-bundle-hash',
    ),
    integratedCandidate: reference(
      'saga3.integrated-release-candidate.v1',
      'candidate:1',
      'candidate-hash',
    ),
    deliveryMode: 'deferred',
    policy: null,
    operatorAuthorization: null,
    deferredProfile: {
      ...profileBody,
      profileHash: deliveryPolicy.hashDeliveryDeferredProfile({
        ...profileBody,
        profileHash: '',
      }),
    },
    initiatedBy: 'test',
  };
}

function kernelNode(id) {
  const node = deliveryProcessModule.flow.nodes.find(item => item.id === id);
  assert.ok(node && node.kind === 'kernel', `kernel node '${id}' missing`);
  return node;
}

function context(node, runInput, productions = {}) {
  return {
    projectId: 1,
    epicId: 10,
    processRunId: 77,
    node,
    input: runInput,
    frame: {
      runInput,
      productions,
      receipts: {},
    },
    heartbeat() {},
    initiatedBy: 'test',
  };
}

test('deferred Delivery settles approval-required before preflight or external effects', async () => {
  let preflightCalls = 0;
  let settlementStateCalls = 0;
  let outputWrites = 0;
  const forbidden = label => () => {
    throw new Error(`${label} must not be called for deferred Delivery`);
  };
  const deps = {
    preflightState: {
      buildPreflightSnapshot() {
        preflightCalls += 1;
        throw new Error('preflight must not run');
      },
    },
    approval: { decide: forbidden('approval provider') },
    publication: { publishAndDeploy: forbidden('publication provider') },
    observation: { observe: forbidden('observation provider') },
    settlementState: {
      buildSettlementInput() {
        settlementStateCalls += 1;
        throw new Error('settlement state must not be loaded');
      },
    },
    outputRepository: {
      persist() {
        outputWrites += 1;
        throw new Error('release record must not be persisted');
      },
      readByProcessRun: forbidden('release record reader'),
    },
    preflightPolicy: {
      evaluate: forbidden('preflight policy'),
    },
    settlementPolicy: new deliveryPolicy.ReferenceDeliverySettlementPolicy(),
  };
  // Wave 4: the settlement kernel now issues its ProcessOutcomeCertificate
  // itself (instead of relying on the executor's magic-bindings path). The
  // deferred approval-required settlement is terminal, so issue() is called
  // exactly once. The fake captures the issued command so the test can
  // assert on the certificate payload (the sole source of truth after Wave 5
  // removed the magic certificate bindings from production.bindings).
  let issuedCertificate = null;
  deps.certificateRepo = {
    issue(command) {
      issuedCertificate = {
        id: 9001,
        certificateHash: command.certificateHash,
        processRunId: command.processRunId,
        moduleRef: command.moduleRef,
        moduleRefKey: `${command.moduleRef.name}@${command.moduleRef.version}`,
        projectId: command.projectId,
        epicId: command.epicId,
        schemaVersion: command.payload.schemaVersion,
        decision: command.payload.decision,
        reasonCodes: command.payload.reasonCodes,
        rationale: command.payload.rationale,
        inputHash: command.payload.inputHash,
        certificatePayload: command.payload,
        authority: command.authority,
        issuedAt: '1970-01-01T00:00:00.000Z',
      };
      return { record: issuedCertificate, replayed: false };
    },
  };

  const handlers = createDeliveryKernelHandlers(deps);
  const runInput = deferredCase();
  const preflight = await handlers[DELIVERY_KERNEL_HANDLER_IDS.preflight](
    context(kernelNode(DELIVERY_NODE_IDS.preflight), runInput),
  );
  assert.equal(preflight.event, 'blocked');
  assert.equal(preflight.production.bindings.authorizationRequired, true);
  assert.equal(preflightCalls, 0);

  const settlement = await handlers[DELIVERY_KERNEL_HANDLER_IDS.settle](
    context(
      kernelNode(DELIVERY_NODE_IDS.settlement),
      runInput,
      { [DELIVERY_NODE_IDS.preflight]: preflight.production },
    ),
  );
  assert.equal(settlement.event, 'approval-required');
  // WAVE 5 CUTOVER: the certificate envelope is no longer carried in
  // `production.bindings`. The kernel issues its own certificate and emits an
  // explicit ModuleCompletion whose certificateRef points at the issued row.
  // The certificate payload (reasonCodes, releasePolicyHash,
  // deferredProfileHash) is read from the ISSUED certificate record — the
  // sole source of truth.
  assert.ok(settlement.completion, 'settlement must emit an explicit ModuleCompletion');
  assert.ok(issuedCertificate, 'settlement must issue a ProcessOutcomeCertificate');
  const issuedCert = issuedCertificate;
  assert.equal(
    settlement.completion.outputEnvelope.certificateRef.digest,
    issuedCert.certificateHash,
    'completion certificateRef digest must match the issued certificate hash',
  );
  assert.deepEqual(
    issuedCert.certificatePayload.reasonCodes,
    ['operator-authorization-missing'],
  );
  assert.equal(
    issuedCert.certificatePayload.payload.releasePolicyHash,
    null,
  );
  assert.equal(
    issuedCert.certificatePayload.payload.deferredProfileHash,
    runInput.deferredProfile.profileHash,
  );
  assert.equal(preflightCalls, 0);
  assert.equal(settlementStateCalls, 0);
  assert.equal(outputWrites, 0);
});

test('delivery flow routes deferred preflight directly to settlement', () => {
  const transition = deliveryProcessModule.flow.transitions.find(item =>
    item.from === DELIVERY_NODE_IDS.preflight
    && item.to === DELIVERY_NODE_IDS.settlement
    && item.on === 'domain.blocked');
  assert.ok(transition, 'domain.blocked must route directly to settlement');
});
