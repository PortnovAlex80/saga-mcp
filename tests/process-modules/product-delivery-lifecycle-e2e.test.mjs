import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { LifecycleOrchestrator } = await import(
  '../../dist/process-modules/application/lifecycle-orchestrator.js'
);
const { ProcessModuleInstallationRegistry } = await import(
  '../../dist/process-modules/application/process-module-installation-registry.js'
);
const { ProcessModuleRegistry } = await import(
  '../../dist/process-modules/application/process-module-registry.js'
);
// Wave 13 removed modules/catalog.ts (W13-A1) and the ProcessOutputPayloadRegistry
// (W13-A3); the registry is built inline from per-module definitions, and the
// payload dispatch the registry encapsulated is now an injected
// resolveOutputPayload callback (see further below).
const { discoveryProcessModule } = await import(
  '../../dist/process-modules/modules/discovery/discovery-process-module.js'
);
const { formalizationProcessModule } = await import(
  '../../dist/process-modules/modules/formalization/formalization-process-module.js'
);
const { developmentProcessModule } = await import(
  '../../dist/process-modules/modules/development/development-process-module.js'
);
const { deliveryProcessModule } = await import(
  '../../dist/process-modules/modules/delivery/delivery-process-module.js'
);
function createBuiltInProcessModuleRegistry() {
  const registry = new ProcessModuleRegistry();
  registry.register(discoveryProcessModule);
  registry.register(formalizationProcessModule);
  registry.register(developmentProcessModule);
  registry.register(deliveryProcessModule);
  return registry;
}
const {
  assertProductDeliveryLifecycleInput,
  productDeliveryLifecycle,
} = await import(
  '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js'
);
const { lifecycleInputPolicyValidation } = await import(
  '../../dist/infrastructure/process-modules/lifecycle-input-policy-validation.js'
);
const {
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_CERTIFICATE_SCHEMA,
  INTEGRATED_CANDIDATE_SCHEMA,
  VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
} = await import(
  '../../dist/modules/development/domain/development-schemas.js'
);
const { hashDevelopmentPolicy } = await import(
  '../../dist/modules/development/domain/development-settlement-policy.js'
);
const {
  DELIVERY_CERTIFICATE_SCHEMA,
  DELIVERY_RELEASE_CASE_SCHEMA,
  RELEASE_RECORD_SCHEMA,
} = await import(
  '../../dist/modules/delivery/domain/delivery-schemas.js'
);
const { hashDeliveryReleasePolicy } = await import(
  '../../dist/modules/delivery/domain/delivery-settlement-policy.js'
);
const {
  FORMALIZATION_CASE_SCHEMA,
  SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
} = await import(
  '../../dist/modules/formalization/domain/formalization-schemas.js'
);
const { SqliteLifecycleRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js'
);
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { canonicalJson, sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);

const DISCOVERY_CERTIFICATE_SCHEMA = 'factory.discovery-outcome-certificate.v1';

function createFixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-product-lifecycle-e2e-'));
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(temp, 'lifecycle.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'Circle Product','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'Circle Initiative')`).run();

  return {
    temp,
    previousDbPath,
    db,
    lifecycleRepo: new SqliteLifecycleRunRepository(db),
    processRepo: new SqliteProcessRunRepository(db),
  };
}

function cleanupFixture(fixture) {
  closeDb();
  rmSync(fixture.temp, { recursive: true, force: true });
  if (fixture.previousDbPath === undefined) {
    delete process.env.DB_PATH;
  } else {
    process.env.DB_PATH = fixture.previousDbPath;
  }
}

function reference(schema, ref, payload) {
  return {
    schema,
    artifactRef: ref,
    contentHash: sha256Hex(payload),
  };
}

function certificate(schema, ref, payload) {
  return {
    schema,
    certificateRef: ref,
    certificateHash: sha256Hex(payload),
  };
}

function parseSnapshot(snapshot) {
  return JSON.parse(snapshot);
}

test('durable product lifecycle freezes exact handoffs and terminal replay creates no duplicate work', async () => {
  const fixture = createFixture();
  try {
    const moduleRegistry = createBuiltInProcessModuleRegistry();
    const installationRegistry = new ProcessModuleInstallationRegistry();
    const executionCalls = [];
    const resolverCalls = [];
    const outputPayloads = new Map();

    const solutionContractPayload = {
      schemaVersion: SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
      bundle: {
        acceptanceBaselineHash: sha256Hex({
          acceptedCriteria: ['AC-CIRCLE-001'],
          revision: 4,
        }),
      },
      srs: {
        schema: 'factory.srs.v1',
        ref: 'artifact:srs:circle:4',
        hash: sha256Hex({ ref: 'artifact:srs:circle:4', revision: 4 }),
      },
      acceptanceCriteria: [{
        artifactId: 501,
        code: 'AC-CIRCLE-001',
        acceptedHash: sha256Hex({
          statement: 'The rendered points follow x=cos(t), y=sin(t).',
        }),
        implementationRequired: true,
      }],
    };
    const integratedCandidatePayload = {
      schemaVersion: 'factory.integrated-release-candidate.v1',
      repositoryId: 91,
      commitHash: '6b4721e22f780312c3f273ebc732f33d32097f43',
      treeHash: sha256Hex({ files: ['src/circle.ts', 'tests/circle.test.ts'] }),
      buildDigest: 'sha256:circle-build-v7',
    };
    const integratedCandidate = reference(
      INTEGRATED_CANDIDATE_SCHEMA,
      'integrated-candidate:circle:7',
      integratedCandidatePayload,
    );
    const verifiedBundlePayload = {
      schemaVersion: VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
      integratedCandidate,
      acceptanceBaselineHash:
        solutionContractPayload.bundle.acceptanceBaselineHash,
      verifiedCriteria: [{
        code: 'AC-CIRCLE-001',
        result: 'passed',
        evidenceHash: sha256Hex({ test: 'circle-parametric-equation', result: 'passed' }),
      }],
    };
    const releaseRecordPayload = {
      schemaVersion: RELEASE_RECORD_SCHEMA,
      integratedCandidate,
      destinations: [{
        kind: 'deployment',
        target: 'school-math-production',
        observedDigest: integratedCandidate.hash,
      }],
    };

    const products = {
      'product-discovery': {
        outcome: 'go',
        output: null,
        certificate: certificate(
          DISCOVERY_CERTIFICATE_SCHEMA,
          'discovery-certificate:circle:1',
          { decision: 'go', proposalHash: sha256Hex({ subject: 'circle' }) },
        ),
        authority: 'discovery-settlement@1.0.0',
      },
      'solution-formalization': {
        outcome: 'formalized',
        output: reference(
          SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
          'formalization-solution-contract:circle:4',
          solutionContractPayload,
        ),
        certificate: certificate(
          SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
          'formalization-certificate:circle:4',
          {
            decision: 'formalized',
            solutionContractHash: sha256Hex(solutionContractPayload),
          },
        ),
        authority: 'formalization-settlement@1.0.0',
        outputPayload: solutionContractPayload,
      },
      'solution-development': {
        outcome: 'verified',
        output: reference(
          VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
          'development-verified-bundle:circle:7',
          verifiedBundlePayload,
        ),
        certificate: certificate(
          DEVELOPMENT_CERTIFICATE_SCHEMA,
          'development-certificate:circle:7',
          {
            decision: 'verified',
            candidate: integratedCandidate,
          },
        ),
        authority: 'development-settlement@1.0.0',
        outputPayload: verifiedBundlePayload,
      },
      'delivery-release': {
        outcome: 'released',
        output: reference(
          RELEASE_RECORD_SCHEMA,
          'delivery-release-record:circle:2',
          releaseRecordPayload,
        ),
        certificate: certificate(
          DELIVERY_CERTIFICATE_SCHEMA,
          'delivery-certificate:circle:2',
          {
            decision: 'released',
            candidate: integratedCandidate,
          },
        ),
        authority: 'delivery-settlement@1.0.0',
        outputPayload: releaseRecordPayload,
      },
    };

    for (const module of moduleRegistry.list()) {
      const product = products[module.identity.name];
      assert.ok(product, `missing deterministic product for ${module.identity.name}`);
      if (product.output) {
        outputPayloads.set(product.output.artifactRef, product.outputPayload);
      }
      installationRegistry.register({
        definition: module,
        executor: {
          moduleRef: {
            name: module.identity.name,
            version: module.identity.version,
          },
          kind: 'external',
          execute: async (definition, context) => {
            assert.equal(definition.identity.name, module.identity.name);
            assert.equal(context.inputHash, sha256Hex(context.inputPayload));
            executionCalls.push({
              module: module.identity.name,
              processRunId: context.processRunId,
              inputPayload: context.inputPayload,
            });
            fixture.processRepo.update(context.processRunId, { status: 'running' });
            fixture.processRepo.update(context.processRunId, {
              status: 'completed',
              localOutcome: product.outcome,
              authority: product.authority,
              output: product.output,
              certificate: product.certificate,
            });
            return product;
          },
        },
      });
    }

    // W13-A3: the deleted ProcessOutputPayloadRegistry is replaced by a single
    // injected resolveOutputPayload callback. The schema-keyed dispatch the
    // registry encapsulated is now an inline closure; the orchestrator still
    // re-checks the returned payload hash itself.
    const resolversBySchema = new Map();
    for (const schema of [
      SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
      VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
    ]) {
      resolversBySchema.set(schema, context => {
        resolverCalls.push({
          schema,
          processRunId: context.processRunId,
          artifactRef: context.output.artifactRef,
        });
        assert.equal(context.output.schema, schema);
        assert.equal(context.projectId, 1);
        assert.equal(context.epicId, 10);
        const payload = outputPayloads.get(context.output.artifactRef);
        assert.ok(payload, `missing output payload ${context.output.artifactRef}`);
        return payload;
      });
    }
    const resolveOutputPayload = context => {
      const resolver = resolversBySchema.get(context.output.schema);
      if (!resolver) {
        throw new Error(
          `process output resolver for schema '${context.output.schema}' is not registered`,
        );
      }
      return resolver(context);
    };

    const orchestrator = new LifecycleOrchestrator({
      lifecycleRunRepo: fixture.lifecycleRepo,
      processRunRepo: fixture.processRepo,
      moduleRegistry,
      installationRegistry,
      resolveOutputPayload,
    });
    const developmentPolicyBody = {
      id: 'circle-development-policy',
      version: '1.0.0',
      contentHash: '',
    };
    const developmentPolicy = {
      ...developmentPolicyBody,
      contentHash: hashDevelopmentPolicy(developmentPolicyBody),
    };
    const releaseAction = {
      actionId: 'deploy-circle',
      kind: 'deployment',
      target: 'school-math-production',
      desiredStateHash: sha256Hex({ release: 'circle-v1' }),
      payloadHash: sha256Hex({ package: 'circle-v1' }),
      required: true,
    };
    const releasePolicyBody = {
      id: 'circle-release-policy',
      version: '1.0.0',
      contentHash: '',
      channel: 'production',
      releaseVersion: '1.0.0',
      releaseTag: 'v1.0.0',
      humanApprovalRequired: true,
      requiredPreflightCheckIds: ['candidate-integrity'],
      actions: [releaseAction],
    };
    const releasePolicy = {
      ...releasePolicyBody,
      contentHash: hashDeliveryReleasePolicy(releasePolicyBody),
    };
    const operatorGrantBody = {
      requestedBy: 'release-manager',
      releasePolicyHash: releasePolicy.contentHash,
      candidateScope: { mode: 'lifecycle-output' },
    };
    const rootInput = {
      initiative: {
        subject:
          'Create a school program that draws a circle through sine and cosine.',
        context: {
          audience: 'secondary-school students',
          learningGoal: 'connect trigonometry to planar coordinates',
        },
        evidence: [{
          kind: 'curriculum',
          ref: 'math-grade-8:parametric-circle',
        }],
        constraints: [
          'Show x=cos(t) and y=sin(t)',
          'Do not require a network connection',
        ],
      },
      development: {
        repositories: [{
          projectRepositoryId: 91,
          integrationBranch: 'main',
          expectedBaseCommit: integratedCandidatePayload.commitHash,
        }],
        policy: developmentPolicy,
      },
      delivery: {
        mode: 'authorized',
        policy: releasePolicy,
        operatorAuthorization: {
          schema: 'factory.operator-release-grant.v1',
          ref: 'operator-release-grant:circle-v1',
          hash: sha256Hex(operatorGrantBody),
          ...operatorGrantBody,
        },
        deferredProfile: null,
      },
    };
    assert.doesNotThrow(() =>
      assertProductDeliveryLifecycleInput(rootInput, lifecycleInputPolicyValidation));
    const impossibleRootAuthorization = structuredClone(rootInput);
    impossibleRootAuthorization.delivery.operatorAuthorization.candidateScope = {
      mode: 'exact',
      candidateHash: integratedCandidate.hash,
    };
    assert.throws(
      () => assertProductDeliveryLifecycleInput(impossibleRootAuthorization, lifecycleInputPolicyValidation),
      /PRODUCT_LIFECYCLE_DELIVERY_CONFIGURATION_INVALID/,
    );
    const command = {
      projectId: 1,
      epicId: 10,
      inputSchema: 'factory.product-initiative.v1',
      inputPayload: rootInput,
      initiatedBy: 'product-owner',
      idempotencyKey: 'circle-product-lifecycle-v1',
    };

    const first = await orchestrator.run(productDeliveryLifecycle, command);

    assert.equal(first.status, 'completed');
    assert.equal(first.terminalStatus, 'released');
    assert.deepEqual(
      first.stageRuns.map(stage => ({
        ordinal: stage.ordinal,
        stageId: stage.stageId,
        status: stage.status,
        outcome: stage.localOutcome,
      })),
      [
        { ordinal: 1, stageId: 'initial-discovery', status: 'completed', outcome: 'go' },
        {
          ordinal: 2,
          stageId: 'solution-formalization',
          status: 'completed',
          outcome: 'formalized',
        },
        {
          ordinal: 3,
          stageId: 'solution-development',
          status: 'completed',
          outcome: 'verified',
        },
        {
          ordinal: 4,
          stageId: 'delivery-release',
          status: 'completed',
          outcome: 'released',
        },
      ],
    );
    assert.equal(new Set(first.stageRuns.map(stage => stage.processRunId)).size, 4);
    assert.deepEqual(
      executionCalls.map(call => call.module),
      [
        'product-discovery',
        'solution-formalization',
        'solution-development',
        'delivery-release',
      ],
    );
    assert.deepEqual(
      resolverCalls.map(call => call.artifactRef),
      [
        products['solution-formalization'].output.artifactRef,
        products['solution-development'].output.artifactRef,
      ],
    );

    const discoveryInput = {
      projectId: 1,
      epicId: 10,
      objective: rootInput.initiative.subject,
      subject: rootInput.initiative.subject,
      context: rootInput.initiative.context,
      evidence: rootInput.initiative.evidence,
      constraints: rootInput.initiative.constraints,
      initiatedBy: 'product-owner',
    };
    const formalizationInput = {
      schemaVersion: FORMALIZATION_CASE_SCHEMA,
      discoveryEpicId: 10,
      formalizationEpicId: 10,
      discoveryCertificateRef:
        products['product-discovery'].certificate.certificateRef,
      discoveryCertificateHash:
        products['product-discovery'].certificate.certificateHash,
      discoveryOutcome: 'go',
      initiatedBy: 'product-owner',
    };
    const developmentInput = {
      schemaVersion: DEVELOPMENT_CASE_SCHEMA,
      projectId: 1,
      epicId: 10,
      formalizationCertificate: {
        schema: products['solution-formalization'].certificate.schema,
        ref: products['solution-formalization'].certificate.certificateRef,
        hash: products['solution-formalization'].certificate.certificateHash,
        decision: 'formalized',
      },
      solutionContract: {
        schema: products['solution-formalization'].output.schema,
        ref: products['solution-formalization'].output.artifactRef,
        hash: products['solution-formalization'].output.contentHash,
      },
      acceptanceBaselineHash:
        solutionContractPayload.bundle.acceptanceBaselineHash,
      srs: solutionContractPayload.srs,
      acceptanceCriteria: solutionContractPayload.acceptanceCriteria,
      repositories: rootInput.development.repositories,
      policy: rootInput.development.policy,
      initiatedBy: 'product-owner',
    };
    const deliveryInput = {
      schemaVersion: DELIVERY_RELEASE_CASE_SCHEMA,
      projectId: 1,
      epicId: 10,
      developmentCertificate: {
        schema: products['solution-development'].certificate.schema,
        ref: products['solution-development'].certificate.certificateRef,
        hash: products['solution-development'].certificate.certificateHash,
        decision: 'verified',
      },
      verifiedIntegrationBundle: {
        schema: products['solution-development'].output.schema,
        ref: products['solution-development'].output.artifactRef,
        hash: products['solution-development'].output.contentHash,
      },
      integratedCandidate,
      deliveryMode: 'authorized',
      policy: rootInput.delivery.policy,
      operatorAuthorization: rootInput.delivery.operatorAuthorization,
      deferredProfile: null,
      initiatedBy: 'product-owner',
    };
    const expectedInputs = [
      discoveryInput,
      formalizationInput,
      developmentInput,
      deliveryInput,
    ];

    first.stageRuns.forEach((stageRun, index) => {
      assert.deepEqual(parseSnapshot(stageRun.inputSnapshot), expectedInputs[index]);
      assert.equal(stageRun.inputHash, sha256Hex(expectedInputs[index]));
      assert.equal(
        stageRun.bindingSnapshot,
        canonicalJson(productDeliveryLifecycle.stages[index]),
      );
      assert.equal(stageRun.bindingHash, sha256Hex(productDeliveryLifecycle.stages[index]));

      const processRun = fixture.processRepo.read(stageRun.processRunId);
      assert.ok(processRun);
      assert.equal(processRun.inputSchema, stageRun.inputSchema);
      assert.equal(processRun.inputSnapshot, stageRun.inputSnapshot);
      assert.equal(processRun.inputHash, stageRun.inputHash);
      assert.equal(
        processRun.idempotencyKey,
        `lifecycle:${first.lifecycleRun.id}:stage-run:${stageRun.id}`,
      );
    });

    const transitionsBeforeReplay = fixture.db.prepare(
      `SELECT from_stage_run_id,to_stage_run_id,outcome,target_type,
              target_stage_id,terminal_status,handoff_snapshot,handoff_hash
         FROM factory_process_transitions
        WHERE lifecycle_run_id=?
        ORDER BY id`,
    ).all(first.lifecycleRun.id);
    assert.equal(transitionsBeforeReplay.length, 4);
    assert.deepEqual(
      transitionsBeforeReplay.map(row => ({
        outcome: row.outcome,
        targetType: row.target_type,
        targetStageId: row.target_stage_id,
        terminalStatus: row.terminal_status,
      })),
      [
        {
          outcome: 'go',
          targetType: 'stage',
          targetStageId: 'solution-formalization',
          terminalStatus: null,
        },
        {
          outcome: 'formalized',
          targetType: 'stage',
          targetStageId: 'solution-development',
          terminalStatus: null,
        },
        {
          outcome: 'verified',
          targetType: 'stage',
          targetStageId: 'delivery-release',
          terminalStatus: null,
        },
        {
          outcome: 'released',
          targetType: 'terminal',
          targetStageId: null,
          terminalStatus: 'released',
        },
      ],
    );
    transitionsBeforeReplay.forEach((transition, index) => {
      assert.equal(
        transition.from_stage_run_id,
        first.stageRuns[index].id,
      );
      assert.equal(
        transition.to_stage_run_id,
        index === first.stageRuns.length - 1
          ? null
          : first.stageRuns[index + 1].id,
      );
      assert.equal(
        transition.handoff_hash,
        sha256Hex(parseSnapshot(transition.handoff_snapshot)),
      );
    });
    const formalizationHandoff = parseSnapshot(
      transitionsBeforeReplay[1].handoff_snapshot,
    );
    assert.deepEqual(
      formalizationHandoff.stages['solution-formalization'].solutionContractPayload,
      solutionContractPayload,
    );
    const developmentHandoff = parseSnapshot(
      transitionsBeforeReplay[2].handoff_snapshot,
    );
    assert.deepEqual(
      developmentHandoff.stages['solution-development'].verifiedBundlePayload,
      verifiedBundlePayload,
    );

    const identifiersBeforeReplay = {
      lifecycleRunId: first.lifecycleRun.id,
      stageRunIds: first.stageRuns.map(stage => stage.id),
      processRunIds: first.stageRuns.map(stage => stage.processRunId),
      lifecycleCount: fixture.db.prepare(
        'SELECT COUNT(*) AS count FROM factory_lifecycle_runs',
      ).get().count,
      stageCount: fixture.db.prepare(
        'SELECT COUNT(*) AS count FROM factory_stage_runs',
      ).get().count,
      processCount: fixture.db.prepare(
        'SELECT COUNT(*) AS count FROM factory_process_runs',
      ).get().count,
      transitionCount: fixture.db.prepare(
        'SELECT COUNT(*) AS count FROM factory_process_transitions',
      ).get().count,
      executionCallCount: executionCalls.length,
      resolverCallCount: resolverCalls.length,
    };

    const replay = await orchestrator.run(productDeliveryLifecycle, command);

    assert.equal(replay.status, 'completed');
    assert.equal(replay.terminalStatus, 'released');
    assert.equal(replay.lifecycleRun.id, identifiersBeforeReplay.lifecycleRunId);
    assert.deepEqual(
      replay.stageRuns.map(stage => stage.id),
      identifiersBeforeReplay.stageRunIds,
    );
    assert.deepEqual(
      replay.stageRuns.map(stage => stage.processRunId),
      identifiersBeforeReplay.processRunIds,
    );
    assert.equal(executionCalls.length, identifiersBeforeReplay.executionCallCount);
    assert.equal(resolverCalls.length, identifiersBeforeReplay.resolverCallCount);
    assert.deepEqual(
      {
        lifecycleCount: fixture.db.prepare(
          'SELECT COUNT(*) AS count FROM factory_lifecycle_runs',
        ).get().count,
        stageCount: fixture.db.prepare(
          'SELECT COUNT(*) AS count FROM factory_stage_runs',
        ).get().count,
        processCount: fixture.db.prepare(
          'SELECT COUNT(*) AS count FROM factory_process_runs',
        ).get().count,
        transitionCount: fixture.db.prepare(
          'SELECT COUNT(*) AS count FROM factory_process_transitions',
        ).get().count,
      },
      {
        lifecycleCount: identifiersBeforeReplay.lifecycleCount,
        stageCount: identifiersBeforeReplay.stageCount,
        processCount: identifiersBeforeReplay.processCount,
        transitionCount: identifiersBeforeReplay.transitionCount,
      },
    );
  } finally {
    cleanupFixture(fixture);
  }
});

// Discovery is an idea-STRENGTH gate, not a build gate. An operator who starts
// the lifecycle has already decided to see the product built. Every Discovery
// outcome (including non-go) forwards to Formalization; the strength of the
// idea is recorded in the discovery certificate and carried forward, NOT used
// to block the conveyor (commit 2af9709). Formalization is the real go/no-go
// gate: its non-formalized outcomes terminate there.
test('product lifecycle forwards every Discovery outcome to Formalization (permissive gate)', () => {
  const discovery = productDeliveryLifecycle.stages.find(
    stage => stage.id === 'initial-discovery',
  );
  assert.ok(discovery, 'initial-discovery stage must exist');
  // Every outcome carries the idea forward to Formalization.
  for (const outcome of ['go', 'clarify', 'reject', 'defer', 'inconclusive', 'failed']) {
    const route = discovery.outcomeRoutes[outcome];
    assert.ok(route, `Discovery must declare a route for outcome '${outcome}'`);
    assert.equal(
      route.type,
      'stage',
      `outcome '${outcome}' must route to a stage (permissive), got ${route.type}`,
    );
    assert.equal(
      route.stageId,
      'solution-formalization',
      `outcome '${outcome}' must route to solution-formalization`,
    );
    assert.equal(
      route.status,
      undefined,
      `outcome '${outcome}' must not be terminal (no status), got ${route.status}`,
    );
  }
});
