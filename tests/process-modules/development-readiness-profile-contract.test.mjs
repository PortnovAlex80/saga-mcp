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
  assert.equal(developmentProcessModule.identity.version, '1.4.3');
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
