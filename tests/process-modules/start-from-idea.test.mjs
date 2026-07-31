import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const {
  assembleProductLifecycleInput,
  startProductLifecycleFromIdea,
  buildLocalDryRunDeliveryPolicy,
  LOCAL_DRY_RUN_DELIVERY_POLICY_ID,
} = await import('../../dist/app/start-product-lifecycle-from-idea.js');
const { LifecycleOrchestrator } = await import(
  '../../dist/process-modules/application/lifecycle-orchestrator.js'
);
const { ProcessModuleInstallationRegistry } = await import(
  '../../dist/process-modules/application/process-module-installation-registry.js'
);
const { ProcessModuleRegistry } = await import(
  '../../dist/process-modules/application/process-module-registry.js'
);
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
const {
  assertProductDeliveryLifecycleInput,
  productDeliveryLifecycle,
} = await import(
  '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js'
);
const { SqliteLifecycleRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js'
);
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);

const DISCOVERY_CERTIFICATE_SCHEMA = 'saga3.discovery-outcome-certificate.v1';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Create a real local git repo with one commit and return its absolute path +
 * the real HEAD commit sha. The assembler must resolve this exact sha — never a
 * zero hash — when building the lifecycle input.
 */
function createRealGitRepo() {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'saga-start-idea-repo-'));
  git(repoDir, 'init', '-q', '-b', 'main');
  git(repoDir, 'config', 'user.email', 'test@saga.local');
  git(repoDir, 'config', 'user.name', 'Saga Test');
  writeFileSync(path.join(repoDir, 'README.md'), '# idea repo\n');
  git(repoDir, 'add', 'README.md');
  git(repoDir, 'commit', '-q', '-m', 'initial');
  const head = git(repoDir, 'rev-parse', 'HEAD');
  return { repoDir, head };
}

function createFixture(repoDir) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-start-idea-'));
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(temp, 'start-idea.db');
  const db = getDb();
  db.prepare(
    "INSERT INTO projects (id,name,status) VALUES (1,'Idea Product','active')",
  ).run();
  db.prepare(
    "INSERT INTO epics (id,project_id,name) VALUES (10,1,'Idea Initiative')",
  ).run();
  // Register a real repository + active project binding pointing at the temp
  // git repo. The assembler must resolve THIS binding and its real HEAD.
  const repoInfo = db.prepare(
    "INSERT INTO repositories (name, default_branch) VALUES ('idea-repo', 'main')",
  ).run();
  const repoId = Number(repoInfo.lastInsertRowid);
  db.prepare(
    `INSERT INTO project_repositories
       (project_id, repository_id, role, local_path, integration_branch, status)
     VALUES (1, ?, 'control', ?, 'main', 'active')`,
  ).run(repoId, repoDir);
  return {
    temp,
    previousDbPath,
    db,
    repoId,
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

test('assembler builds a validated input from a bare idea with no lifecycleInputPath', () => {
  const repo = createRealGitRepo();
  const fixture = createFixture(repo.repoDir);
  try {
    // The assembler takes ONLY { idea, projectId, epicId } — no lifecycle input
    // path, no JSON file. It must assemble a contract-valid input.
    const input = assembleProductLifecycleInput({
      projectId: 1,
      epicId: 10,
      idea: 'A school program that draws a circle with sine and cosine.',
      db: fixture.db,
    });
    assert.doesNotThrow(() => assertProductDeliveryLifecycleInput(input));
    assert.equal(input.initiative.subject, 'A school program that draws a circle with sine and cosine.');
  } finally {
    cleanupFixture(fixture);
    rmSync(repo.repoDir, { recursive: true, force: true });
  }
});

test('repository ref resolves to the current local binding with the REAL git HEAD (never a zero hash)', () => {
  const repo = createRealGitRepo();
  const fixture = createFixture(repo.repoDir);
  try {
    const input = assembleProductLifecycleInput({
      projectId: 1,
      epicId: 10,
      idea: 'Resolve the real repo binding.',
      db: fixture.db,
    });
    assert.equal(input.development.repositories.length, 1);
    const [binding] = input.development.repositories;
    // Portable ref shape (not a legacy projectRepositoryId-only binding).
    assert.ok(binding.repositoryRef, 'repositoryRef must be present');
    assert.equal(binding.repositoryRef.repositoryName, 'idea-repo');
    assert.equal(binding.repositoryRef.role, 'control');
    assert.equal(binding.integrationBranch, 'main');
    // The pinned HEAD is the REAL commit sha from git, not a zero hash and not
    // a placeholder. It must equal what `git rev-parse HEAD` returned.
    assert.equal(binding.expectedBaseCommit, repo.head);
    assert.ok(
      !/^0+$/.test(binding.expectedBaseCommit),
      'HEAD must not be a zero hash',
    );
    assert.ok(
      /[0-9a-f]{7,40}/i.test(binding.expectedBaseCommit),
      'HEAD must be a real sha',
    );
  } finally {
    cleanupFixture(fixture);
    rmSync(repo.repoDir, { recursive: true, force: true });
  }
});

test('assembler fails closed when no repository is bound (PROJECT_REPOSITORY_NOT_BOUND)', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-start-idea-norepo-'));
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(temp, 'no-repo.db');
  try {
    const db = getDb();
    db.prepare("INSERT INTO projects (id,name,status) VALUES (2,'No Repo','active')").run();
    db.prepare("INSERT INTO epics (id,project_id,name) VALUES (20,2,'No Repo Epic')").run();
    assert.throws(
      () => assembleProductLifecycleInput({
        projectId: 2,
        epicId: 20,
        idea: 'An idea with no repo.',
        db,
      }),
      /PROJECT_REPOSITORY_NOT_BOUND/,
    );
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    if (previousDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = previousDbPath;
    }
  }
});

test('assembler fails closed when the local checkout has no resolvable HEAD', () => {
  // A directory that is NOT a git repo: git rev-parse HEAD fails.
  const notARepo = mkdtempSync(path.join(os.tmpdir(), 'saga-start-idea-notgit-'));
  mkdirSync(path.join(notARepo, 'sub'), { recursive: true });
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-start-idea-nohead-db-'));
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(temp, 'no-head.db');
  try {
    const db = getDb();
    db.prepare("INSERT INTO projects (id,name,status) VALUES (3,'No Head','active')").run();
    db.prepare("INSERT INTO epics (id,project_id,name) VALUES (30,3,'No Head Epic')").run();
    const repoInfo = db.prepare(
      "INSERT INTO repositories (name, default_branch) VALUES ('no-head-repo', 'main')",
    ).run();
    db.prepare(
      `INSERT INTO project_repositories
         (project_id, repository_id, role, local_path, integration_branch, status)
       VALUES (3, ?, 'control', ?, 'main', 'active')`,
    ).run(Number(repoInfo.lastInsertRowid), notARepo);
    assert.throws(
      () => assembleProductLifecycleInput({
        projectId: 3,
        epicId: 30,
        idea: 'An idea whose repo has no HEAD.',
        db,
      }),
      /REPOSITORY_HEAD_UNRESOLVABLE/,
    );
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    rmSync(notARepo, { recursive: true, force: true });
    if (previousDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = previousDbPath;
    }
  }
});

/**
 * Build a full product-delivery orchestrator with deterministic stub products
 * for Discovery, Formalization and Development (all succeeding), and a Delivery
 * executor that FAILS CLOSED — modelling the local-dry-run publication profile
 * which throws `delivery-provider-not-configured` and never publishes.
 *
 * Mirrors the proven stub pattern in product-delivery-lifecycle-e2e.test.mjs so
 * the full `productDeliveryLifecycle` runs end-to-end. This lets a single run
 * prove BOTH:
 *   - Discovery / Formalization / Development start and complete even though the
 *     Delivery publication provider is missing/dry-run (the failure is isolated
 *     to the Delivery boundary);
 *   - the dry-run publication can NEVER emit `released`.
 */
function buildFullDryRunOrchestrator(fixture) {
  const moduleRegistry = new ProcessModuleRegistry();
  moduleRegistry.register(discoveryProcessModule);
  moduleRegistry.register(formalizationProcessModule);
  moduleRegistry.register(developmentProcessModule);
  moduleRegistry.register(deliveryProcessModule);
  const installationRegistry = new ProcessModuleInstallationRegistry();

  const executionLog = [];

  const solutionContractPayload = {
    schemaVersion: 'saga3.solution-contract-certificate.v1',
    bundle: {
      acceptanceBaselineHash: sha256Hex({ acceptedCriteria: ['AC-IDEA-1'], revision: 1 }),
    },
    srs: {
      schema: 'saga3.srs.v1',
      ref: 'artifact:srs:idea:1',
      hash: sha256Hex({ ref: 'artifact:srs:idea:1' }),
    },
    acceptanceCriteria: [{
      artifactId: 701,
      code: 'AC-IDEA-1',
      acceptedHash: sha256Hex({ statement: 'ac-idea-1' }),
      implementationRequired: true,
    }],
  };
  const integratedCandidatePayload = {
    schemaVersion: 'saga3.integrated-release-candidate.v1',
    repositoryId: fixture.repoId,
    commitHash: '5b1f9c0b2d3e4f5a6c7d8e9f0a1b2c3d4e5f6a7b',
    treeHash: sha256Hex({ files: ['src/idea.ts'] }),
    buildDigest: 'sha256:idea-build-v1',
  };
  const integratedCandidate = {
    schema: 'saga3.integrated-release-candidate.v1',
    artifactRef: 'integrated-candidate:idea:1',
    contentHash: sha256Hex(integratedCandidatePayload),
  };
  const verifiedBundlePayload = {
    schemaVersion: 'saga3.verified-integration-bundle.v1',
    integratedCandidate,
    acceptanceBaselineHash: solutionContractPayload.bundle.acceptanceBaselineHash,
    verifiedCriteria: [{
      code: 'AC-IDEA-1',
      result: 'passed',
      evidenceHash: sha256Hex({ test: 'idea', result: 'passed' }),
    }],
  };

  const products = {
    'product-discovery': {
      outcome: 'go',
      output: null,
      certificate: {
        schema: DISCOVERY_CERTIFICATE_SCHEMA,
        certificateRef: 'discovery-certificate:idea:1',
        certificateHash: sha256Hex({ decision: 'go', subject: 'idea' }),
      },
      authority: 'discovery-settlement@1.0.0',
    },
    'solution-formalization': {
      outcome: 'formalized',
      output: {
        schema: 'saga3.solution-contract-certificate.v1',
        artifactRef: 'formalization-solution-contract:idea:1',
        contentHash: sha256Hex(solutionContractPayload),
      },
      certificate: {
        schema: 'saga3.solution-contract-certificate.v1',
        certificateRef: 'formalization-certificate:idea:1',
        certificateHash: sha256Hex({ decision: 'formalized' }),
      },
      authority: 'formalization-settlement@1.0.0',
      outputPayload: solutionContractPayload,
    },
    'solution-development': {
      outcome: 'verified',
      output: {
        schema: 'saga3.verified-integration-bundle.v1',
        artifactRef: 'development-verified-bundle:idea:1',
        contentHash: sha256Hex(verifiedBundlePayload),
      },
      certificate: {
        schema: 'saga3.development-certificate.v1',
        certificateRef: 'development-certificate:idea:1',
        certificateHash: sha256Hex({ decision: 'verified', candidate: integratedCandidate }),
      },
      authority: 'development-settlement@1.0.0',
      outputPayload: verifiedBundlePayload,
    },
  };

  const outputPayloads = new Map();
  for (const product of Object.values(products)) {
    if (product.output) {
      outputPayloads.set(product.output.artifactRef, product.outputPayload);
    }
  }

  for (const module of moduleRegistry.list()) {
    installationRegistry.register({
      definition: module,
      executor: {
        moduleRef: { name: module.identity.name, version: module.identity.version },
        kind: 'external',
        execute: async (_definition, context) => {
          fixture.processRepo.update(context.processRunId, { status: 'running' });
          executionLog.push(module.identity.name);
          if (module.identity.name === 'delivery-release') {
            // The dry-run publication provider FAILS CLOSED here. It must NEVER
            // emit a released outcome or fabricate a publication/externalRef.
            const err = new Error(
              'delivery-provider-not-configured: the local-dry-run profile does not publish.',
            );
            err.code = 'delivery-provider-not-configured';
            throw err;
          }
          const product = products[module.identity.name];
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

  const resolveOutputPayload = context => {
    const payload = outputPayloads.get(context.output.artifactRef);
    if (!payload) {
      throw new Error(`no payload for ${context.output.artifactRef}`);
    }
    return payload;
  };

  const orchestrator = new LifecycleOrchestrator({
    lifecycleRunRepo: fixture.lifecycleRepo,
    processRunRepo: fixture.processRepo,
    moduleRegistry,
    installationRegistry,
    resolveOutputPayload,
  });
  return { orchestrator, executionLog, installationRegistry };
}

test('a missing/dry-run Delivery provider does NOT block Discovery startup, and delivery never emits released', async () => {
  const repo = createRealGitRepo();
  const fixture = createFixture(repo.repoDir);
  try {
    const input = assembleProductLifecycleInput({
      projectId: 1,
      epicId: 10,
      idea: 'Discovery must start; delivery must fail closed, never release.',
      db: fixture.db,
    });
    const { orchestrator, executionLog } = buildFullDryRunOrchestrator(fixture);

    const result = await orchestrator.run(productDeliveryLifecycle, {
      projectId: 1,
      epicId: 10,
      inputSchema: 'saga3.product-delivery-lifecycle-input.v1',
      inputPayload: input,
      initiatedBy: 'start-from-idea-test',
      idempotencyKey: 'start-from-idea-dry-run-full',
    });

    // Discovery / Formalization / Development all started and completed even
    // though the Delivery publication provider fails closed. The execution log
    // proves the upstream stages ran; the missing/dry-run Delivery provider
    // cannot block them — it only blocks the Delivery boundary.
    assert.deepEqual(
      executionLog,
      ['product-discovery', 'solution-formalization', 'solution-development', 'delivery-release'],
      'Discovery/Formalization/Development must all run before Delivery fails',
    );
    const byStage = new Map(result.stageRuns.map(s => [s.stageId, s]));
    assert.equal(byStage.get('initial-discovery').status, 'completed');
    assert.equal(byStage.get('initial-discovery').localOutcome, 'go');
    assert.equal(byStage.get('solution-formalization').status, 'completed');
    assert.equal(byStage.get('solution-development').status, 'completed');

    // The Delivery boundary failed because the dry-run publication threw
    // (fail-closed). The whole lifecycle run is therefore terminal-failed — but
    // it must NEVER be 'released'. The failure is isolated to the Delivery
    // stage: the three upstream stages all completed first.
    assert.equal(result.status, 'failed');
    assert.notEqual(result.terminalStatus, 'released');
    assert.equal(
      result.stageRuns.find(s => s.stageId === 'delivery-release')?.status,
      'failed',
      'the delivery stage must fail, never release',
    );
    assert.match(
      result.lifecycleRun.error,
      /delivery-provider-not-configured/,
      'the delivery failure must carry the typed fail-closed reason code',
    );

    // Fail-closed guarantee: no release record may be persisted. The delivery
    // outputs table is created lazily; if it does not exist yet there are
    // trivially zero release records.
    let releaseRecordCount = 0;
    try {
      releaseRecordCount = fixture.db.prepare(
        'SELECT COUNT(*) AS n FROM saga3_delivery_outputs',
      ).get().n;
    } catch {
      releaseRecordCount = 0;
    }
    assert.equal(releaseRecordCount, 0, 'no release record may be persisted');
  } finally {
    cleanupFixture(fixture);
    rmSync(repo.repoDir, { recursive: true, force: true });
  }
});

test('bare idea persists no synthetic operator authorization', () => {
  const repo = createRealGitRepo();
  const fixture = createFixture(repo.repoDir);
  try {
    const input = assembleProductLifecycleInput({
      projectId: 1,
      epicId: 10,
      idea: 'The authorization must be dry-run / unauthorized.',
      db: fixture.db,
    });
    assert.equal(input.delivery.operatorAuthorization, null);
    // This migration slice retains an inert local profile, but it carries no
    // grant and cannot be mistaken for an operator decision.
    assert.equal(input.delivery.policy.id, LOCAL_DRY_RUN_DELIVERY_POLICY_ID);
    assert.equal(input.delivery.policy.channel, 'local-dry-run');
    assert.equal(input.delivery.policy.humanApprovalRequired, true);
    assert.doesNotThrow(() => assertProductDeliveryLifecycleInput(input));
  } finally {
    cleanupFixture(fixture);
    rmSync(repo.repoDir, { recursive: true, force: true });
  }
});

test('startProductLifecycleFromIdea starts a LifecycleRun through the injected port', async () => {
  const repo = createRealGitRepo();
  const fixture = createFixture(repo.repoDir);
  try {
    let captured = null;
    const fakeStarter = {
      async start(params) {
        captured = params;
        return { lifecycleRunId: 4242 };
      },
    };
    const result = await startProductLifecycleFromIdea({
      projectId: 1,
      epicId: 10,
      idea: 'Drive the use case through the injected port.',
      initiatedBy: 'test',
      concurrency: 2,
      db: fixture.db,
      starter: fakeStarter,
    });
    assert.equal(result.lifecycleRunId, 4242);
    assert.ok(captured, 'the starter must have been called');
    // The validated input handed to the port passes the assert.
    assert.doesNotThrow(() =>
      assertProductDeliveryLifecycleInput(captured.lifecycleInput));
    assert.equal(
      captured.lifecycleInputSchema,
      'saga3.product-delivery-lifecycle-input.v1',
    );
    assert.equal(captured.projectId, 1);
    assert.equal(captured.epicId, 10);
    assert.equal(captured.concurrency, 2);
  } finally {
    cleanupFixture(fixture);
    rmSync(repo.repoDir, { recursive: true, force: true });
  }
});

test('buildLocalDryRunDeliveryPolicy produces a deterministic, content-hashed policy', () => {
  const policy = buildLocalDryRunDeliveryPolicy();
  // Two calls produce identical bytes → identical hash (deterministic, not
  // invented per call).
  const again = buildLocalDryRunDeliveryPolicy();
  assert.deepEqual(policy, again);
  assert.equal(policy.id, LOCAL_DRY_RUN_DELIVERY_POLICY_ID);
  assert.equal(policy.channel, 'local-dry-run');
  assert.equal(policy.releaseVersion, '0.0.0-dry-run');
  assert.equal(policy.actions.length, 1);
  assert.equal(policy.actions[0].required, true);
  assert.ok(policy.contentHash.length > 0);
});
