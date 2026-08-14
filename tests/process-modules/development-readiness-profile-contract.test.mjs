import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_DIGEST,
  DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_ID,
  DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_VERSION,
  developmentImplementationPayloadContract,
} from '../../dist/modules/development/application/development-check-providers.js';
import { DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA } from '../../dist/modules/development/domain/development-schemas.js';
import { resolveIntegratedReadinessProfile } from '../../dist/modules/development/infrastructure/sqlite-development-settlement-state.js';
import { developmentProcessModule } from '../../dist/process-modules/modules/development/development-process-module.js';

const SHA = 'a'.repeat(40);
const STATIC = Object.freeze({
  kind: 'static',
  commands: { installCommand: null, testCommand: 'python -m pytest' },
});
const SERVED = Object.freeze({
  kind: 'served',
  commands: { installCommand: 'pip install -r requirements.txt', testCommand: 'python -m pytest' },
  serve: { startCommand: 'python -m app' },
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

test('implementation submission requires a complete explicit readiness profile', () => {
  assert.deepEqual(developmentImplementationPayloadContract.validate(payload()), []);
  assert.deepEqual(developmentImplementationPayloadContract.validate(payload(SERVED)), []);

  const missing = payload();
  delete missing.readiness;
  assert.match(
    developmentImplementationPayloadContract.validate(missing).join('\n'),
    /readiness must be an object/,
  );
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
  assert.equal(developmentProcessModule.identity.version, '1.3.0');
  assert.deepEqual(node.cellDefinition.productContracts[0].payloadContract, {
    contractId: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_ID,
    version: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_VERSION,
    contractDigest: DEVELOPMENT_IMPLEMENTATION_PAYLOAD_CONTRACT_DIGEST,
  });
});

test('candidate freeze is order-invariant and rejects missing or conflicting run contracts', () => {
  const presentation = readiness => ({
    schemaId: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
    readiness,
  });
  assert.deepEqual(
    resolveIntegratedReadinessProfile([presentation(STATIC), presentation(structuredClone(STATIC))], null),
    { ok: true, profile: STATIC },
  );
  assert.equal(
    resolveIntegratedReadinessProfile([presentation(STATIC), presentation(undefined)], null).reasonCode,
    'implementation-readiness-profile-missing',
  );
  assert.equal(
    resolveIntegratedReadinessProfile([presentation(STATIC), presentation(SERVED)], null).reasonCode,
    'implementation-readiness-profile-mismatch',
  );
  assert.deepEqual(
    resolveIntegratedReadinessProfile([{ schemaId: 'factory.source-change-candidate.v1' }], SERVED),
    { ok: true, profile: SERVED },
  );
});
