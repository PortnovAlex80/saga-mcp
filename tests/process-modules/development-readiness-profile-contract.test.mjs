import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_DIGEST,
  DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_ID,
  DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_VERSION,
  developmentImplementationPayloadContract,
  DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_DIGEST,
  DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_ID,
  DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_VERSION,
  developmentReadinessManifestPayloadContract,
} from '../../dist/modules/development/application/development-check-providers.js';
import { developmentProcessModule } from '../../dist/process-modules/modules/development/development-process-module.js';
import { developmentPackageManifest } from '../../dist/process-modules/modules/development/package/manifest.js';
import { SqliteDevelopmentModuleStore } from '../../dist/modules/development/infrastructure/sqlite-development-settlement-state.js';
import {
  hashIntegratedSourceCandidate,
  hashIntegratedCandidate,
} from '../../dist/modules/development/domain/development-settlement-policy.js';

const SHA = 'a'.repeat(40);
const STATIC = Object.freeze({
  kind: 'static',
  commands: { installCommand: null, testCommand: 'python -m pytest' },
});
const SERVED = Object.freeze({
  kind: 'served',
  commands: { installCommand: 'pip install -r requirements.txt', testCommand: 'python -m pytest' },
  serve: { startCommand: 'python -m app --port=${PORT}' },
  environment: { image: 'python:3.13-slim' },
});

function payload(readiness = STATIC) {
  return {
    workItemKey: 'implementation',
    repository: { baseCommit: SHA },
    snapshot: { commitSha: SHA, changedFiles: ['src/app.py'] },
    readiness,
  };
}

test('implementation readiness is optional item evidence but malformed evidence is rejected', () => {
  assert.deepEqual(developmentImplementationPayloadContract.validate(payload()), []);
  assert.deepEqual(developmentImplementationPayloadContract.validate(payload(SERVED)), []);

  const missing = payload();
  delete missing.readiness;
  assert.deepEqual(developmentImplementationPayloadContract.validate(missing), []);
  assert.match(
    developmentImplementationPayloadContract.validate(payload({
      kind: 'served',
      commands: { installCommand: '', testCommand: '' },
      serve: {},
      environment: { image: '' },
    })).join('\n'),
    /installCommand.*testCommand.*startCommand.*environment\.image/s,
  );
});

test('standard implementation cell pins the readiness-enforcing payload contract', () => {
  const node = developmentProcessModule.flow.nodes.find(candidate =>
    candidate.id === 'implement-work-items');
  assert.equal(developmentProcessModule.identity.version, '1.4.4');
  assert.deepEqual(node.cellDefinition.productContracts[0].payloadContract, {
    contractId: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_ID,
    version: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_VERSION,
    contractDigest: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_DIGEST,
  });
});

test('every Development Production Cell has package-owned agent assistance', () => {
  const assistedNodeIds = new Set(
    developmentPackageManifest.assistance.map(definition => definition.nodeId),
  );
  const productionCellNodeIds = developmentProcessModule.flow.nodes
    .filter(node => node.kind === 'production-cell')
    .map(node => node.id);
  assert.deepEqual(
    productionCellNodeIds.filter(nodeId => !assistedNodeIds.has(nodeId)),
    [],
    'a Production Cell without assistance fails later at worker pre-spawn',
  );
});

test('readiness certification cell pins one exact source-bound manifest', () => {
  const node = developmentProcessModule.flow.nodes.find(candidate =>
    candidate.id === 'certify-product-readiness');
  assert.deepEqual(node.cellDefinition.productContracts[0].payloadContract, {
    contractId: DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_ID,
    version: DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_VERSION,
    contractDigest: DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_DIGEST,
  });
  const manifest = {
    schemaVersion: 'factory.development-readiness-manifest.v1',
    sourceCandidate: {
      schema: 'factory.integrated-source-candidate.v1',
      ref: 'development-integrated-source:1:exact',
      hash: 'a'.repeat(64),
    },
    targets: [{ key: 'primary', readiness: SERVED }],
  };
  assert.deepEqual(developmentReadinessManifestPayloadContract.validate(manifest), []);
  for (const startCommand of [
    'flask run --host=0.0.0.0 --port=5000',
    'FLASK_APP=reading_queue.app:create_app flask run --host=0.0.0.0 --port=5000',
    "python -c \"app.run(host='0.0.0.0', port=5000)\"",
  ]) {
    const invalid = structuredClone(manifest);
    invalid.targets[0].readiness.serve.startCommand = startCommand;
    assert.match(
      developmentReadinessManifestPayloadContract.validate(invalid).join('\n'),
      /must not hardcode a numeric port.*PORT/s,
    );
  }
  assert.match(
    developmentReadinessManifestPayloadContract.validate({ ...manifest, targets: [] }).join('\n'),
    /exactly one primary target/,
  );
});

test('bind runnable candidate consumes exact accepted manifest and receipt', () => {
  const sourceBody = {
    schemaVersion: 'factory.integrated-source-candidate.v1',
    taskGraphHash: '1'.repeat(64),
    implementationWorksetHash: '2'.repeat(64),
    repositories: [{
      projectRepositoryId: 1, branch: 'dev', commitSha: 'a'.repeat(40), treeHash: 'b'.repeat(40),
    }],
    buildProducts: [{ kind: 'source-tree', ref: 'tree:1', digest: 'b'.repeat(40) }],
    integrationIntentRefs: ['effect:1'],
    frozen: true,
  };
  const source = {
    ...sourceBody,
    sourceHash: hashIntegratedSourceCandidate({ ...sourceBody, sourceHash: '' }),
  };
  const sourceRef = {
    schema: source.schemaVersion, ref: `development-integrated-source:3:${source.sourceHash}`, hash: source.sourceHash,
  };
  const manifest = {
    schemaVersion: 'factory.development-readiness-manifest.v1',
    sourceCandidate: sourceRef,
    targets: [{ key: 'primary', readiness: SERVED }],
  };
  const records = new Map([['development.integrated-source-candidate', {
    payload: source, reference: sourceRef,
  }]]);
  const store = Object.create(SqliteDevelopmentModuleStore.prototype);
  store.products = {
    read(_run, kind) { return records.get(kind) ?? null; },
    persist(input) {
      const reference = { schema: input.schema, ref: `${input.artifactRefPrefix}:3:${input.productHash}`, hash: input.productHash };
      const record = { payload: input.payload, reference };
      records.set(input.productKind, record);
      return { record, replayed: false };
    },
  };
  store.readAcceptedCellProducts = () => [{
    candidateSetRef: 'candidate:readiness',
    reference: { schema: manifest.schemaVersion, ref: 'managed-node-submission:9', hash: '9'.repeat(64) },
    payload: manifest,
  }];
  store.readExactReadinessReceipt = () => ({
    schema: 'factory.check-receipt.v1', ref: 'receipt:readiness', hash: '8'.repeat(64),
  });
  const result = store.bindRunnableCandidate({ processRunId: 3, developmentCase: {} });
  assert.equal(result.status, 'bound');
  assert.deepEqual(result.candidate.readiness, SERVED);
  assert.deepEqual(result.candidate.sourceCandidate, sourceRef);
  assert.equal(hashIntegratedCandidate(result.candidate), result.candidate.candidateHash);
});

// ---- ADR-090 (CC-IC-1 focused repair): the m7 consumer boundary at bind -------

/**
 * The readiness-manifest warrant consumer boundary: a PRESENT manifest
 * warrantRef is verified against the DevelopmentCase's authoritative expected
 * cross-bind identities (frozen solution-contract payload). A forged or
 * partial discoveryCertificateHash/formalizationCaseDigest cross-bind is a
 * typed failed state — never a silently bound re-targeted warrant.
 */
test('bind runnable candidate rejects a forged manifest warrant cross-bind (m7 consumer boundary)', () => {
  const sourceBody = {
    schemaVersion: 'factory.integrated-source-candidate.v1',
    taskGraphHash: '1'.repeat(64),
    implementationWorksetHash: '2'.repeat(64),
    repositories: [{
      projectRepositoryId: 1, branch: 'dev', commitSha: 'a'.repeat(40), treeHash: 'b'.repeat(40),
    }],
    buildProducts: [{ kind: 'source-tree', ref: 'tree:1', digest: 'b'.repeat(40) }],
    integrationIntentRefs: ['effect:1'],
    frozen: true,
  };
  const source = {
    ...sourceBody,
    sourceHash: hashIntegratedSourceCandidate({ ...sourceBody, sourceHash: '' }),
  };
  const sourceRef = {
    schema: source.schemaVersion, ref: `development-integrated-source:4:${source.sourceHash}`, hash: source.sourceHash,
  };
  const warrantRef = {
    constraintRegisterRef: `constraint-register:${'c'.repeat(64)}`,
    constraintRegisterDigest: 'c'.repeat(64),
    dispositionsDigest: 'd'.repeat(64),
    dispositions: {},
    discoveryCertificateHash: 'a'.repeat(64),
    formalizationCaseDigest: 'e'.repeat(64),
  };
  const developmentCase = {
    schemaVersion: 'factory.development-case.v1',
    solutionContractPayload: {
      discoveryCertificateHash: 'a'.repeat(64),
      formalizationCaseDigest: 'e'.repeat(64),
    },
  };
  const bindWithManifest = (manifestPayload) => {
    const records = new Map([['development.integrated-source-candidate', {
      payload: source, reference: sourceRef,
    }]]);
    const store = Object.create(SqliteDevelopmentModuleStore.prototype);
    store.products = {
      read(_run, kind) { return records.get(kind) ?? null; },
      persist(input) {
        const reference = { schema: input.schema, ref: `${input.artifactRefPrefix}:4:${input.productHash}`, hash: input.productHash };
        const record = { payload: input.payload, reference };
        records.set(input.productKind, record);
        return { record, replayed: false };
      },
    };
    store.readAcceptedCellProducts = () => [{
      candidateSetRef: 'candidate:readiness',
      reference: {
        schema: manifestPayload.schemaVersion,
        ref: 'managed-node-submission:10',
        hash: '9'.repeat(64),
      },
      payload: manifestPayload,
    }];
    store.readExactReadinessReceipt = () => ({
      schema: 'factory.check-receipt.v1', ref: 'receipt:readiness', hash: '8'.repeat(64),
    });
    return store.bindRunnableCandidate({ processRunId: 4, developmentCase });
  };
  const manifestOf = (warrant) => ({
    schemaVersion: 'factory.development-readiness-manifest.v1',
    sourceCandidate: sourceRef,
    targets: [{ key: 'primary', readiness: STATIC }],
    ...(warrant === undefined ? {} : { warrantRef: warrant }),
  });

  // The honest cross-bind binds.
  assert.equal(bindWithManifest(manifestOf(warrantRef)).status, 'bound');
  // An absent warrantRef stays legal (retro-compat).
  assert.equal(bindWithManifest(manifestOf(undefined)).status, 'bound');

  // The MUTATION (forged certificate identity): typed failed state.
  const forgedCertificate = bindWithManifest(manifestOf({
    ...warrantRef,
    discoveryCertificateHash: 'b'.repeat(64),
  }));
  assert.equal(forgedCertificate.status, 'failed');
  assert.deepEqual(forgedCertificate.reasonCodes, [
    'readiness-manifest-warrant-cross-bind-invalid',
    'WARRANT_CROSS_BIND_MISMATCH: the readiness-manifest warrantRef cross-bind does not '
      + 'match the authoritative certificate/case identities of this DevelopmentCase '
      + `(warrant certificate ${'b'.repeat(64)} / case ${'e'.repeat(64)})`,
  ]);

  // The MUTATION (partial cross-bind): the case identity stripped.
  const partial = bindWithManifest(manifestOf({ ...warrantRef, formalizationCaseDigest: undefined }));
  assert.equal(partial.status, 'failed');
  assert.ok(partial.reasonCodes.some(code => code === 'readiness-manifest-warrant-cross-bind-invalid'));
  assert.ok(partial.reasonCodes.some(code => code.includes('WARRANT_CROSS_BIND_INCOMPLETE')));

  // A case with NO authoritative expectation cannot verify a present warrant.
  const unverifiable = (() => {
    const records = new Map([['development.integrated-source-candidate', {
      payload: source, reference: sourceRef,
    }]]);
    const store = Object.create(SqliteDevelopmentModuleStore.prototype);
    store.products = {
      read(_run, kind) { return records.get(kind) ?? null; },
      persist(input) {
        const reference = { schema: input.schema, ref: `${input.artifactRefPrefix}:4:${input.productHash}`, hash: input.productHash };
        const record = { payload: input.payload, reference };
        records.set(input.productKind, record);
        return { record, replayed: false };
      },
    };
    store.readAcceptedCellProducts = () => [{
      candidateSetRef: 'candidate:readiness',
      reference: { schema: 'factory.development-readiness-manifest.v1', ref: 'managed-node-submission:10', hash: '9'.repeat(64) },
      payload: manifestOf(warrantRef),
    }];
    store.readExactReadinessReceipt = () => ({
      schema: 'factory.check-receipt.v1', ref: 'receipt:readiness', hash: '8'.repeat(64),
    });
    return store.bindRunnableCandidate({
      processRunId: 4,
      developmentCase: { schemaVersion: 'factory.development-case.v1' },
    });
  })();
  assert.equal(unverifiable.status, 'failed');
  assert.ok(unverifiable.reasonCodes.some(code => code.includes('WARRANT_CROSS_BIND_EXPECTATION_MISSING')));
});
