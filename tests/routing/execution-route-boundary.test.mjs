import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createExecutionRouteResolver,
} from '../../dist/application/routing/execution-route-resolver.js';
import {
  routeToModelRoute,
} from '../../dist/application/routing/worker-execution-route.js';
import {
  ClaudeBoardWorkerExecutor,
} from '../../dist/infrastructure/workers/claude-board-worker-executor.js';

const key = {
  module: 'solution-formalization',
  cell: 'define-architecture-contract',
  role: 'author',
  executionProfile: 'formalization-architect',
};

test('simulator is an executor, not a provider/model', () => {
  const resolver = createExecutionRouteResolver({
    policy: {
      version: '1',
      routes: [{
        match: { module: 'solution-formalization' },
        route: { executor: { kind: 'claude-cli-simulator' } },
      }],
    },
  });
  const route = resolver.resolve(key);
  assert.equal(route.executor.kind, 'claude-cli-simulator');
  assert.equal(route.provider, null);
  assert.equal(route.model, null);
  assert.equal(route.inference.effort, null);
  assert.deepEqual(routeToModelRoute(route), {
    provider: null,
    model: null,
    effort: null,
  });
  assert.match(route.policyDigest, /^[0-9a-f]{64}$/);
});

test('real claude route keeps provider/model orthogonal to executor', () => {
  const resolver = createExecutionRouteResolver({
    policy: {
      routes: [{
        match: { executionProfile: 'formalization-architect' },
        route: {
          executor: { kind: 'claude-cli' },
          provider: 'zai',
          model: 'glm-5.2',
          effort: 'medium',
        },
      }],
    },
  });
  const route = resolver.resolve(key);
  assert.equal(route.executor.kind, 'claude-cli');
  assert.equal(route.provider?.id, 'zai');
  assert.equal(route.model?.id, 'glm-5.2');
  assert.equal(route.inference.effort, 'medium');
});

test('routing policy rejects executor/model conflation and duplicate matches', () => {
  assert.throws(
    () => createExecutionRouteResolver({
      policy: {
        routes: [{
          match: { module: 'product-discovery' },
          route: {
            executor: { kind: 'claude-cli-simulator' },
            provider: 'zai',
          },
        }],
      },
    }),
    /simulator route must not declare provider\/model\/effort/,
  );

  assert.throws(
    () => createExecutionRouteResolver({
      policy: {
        routes: [
          {
            match: { module: 'product-discovery' },
            route: { executor: { kind: 'claude-cli-simulator' } },
          },
          {
            match: { module: 'product-discovery' },
            route: { executor: { kind: 'claude-cli-simulator' } },
          },
        ],
      },
    }),
    /EXECUTION_ROUTES_AMBIGUOUS/,
  );
});

test('production worker executor refuses an unfrozen or legacy route', () => {
  let starts = 0;
  const runner = {
    start() { starts += 1; return {}; },
    stop() { return null; },
    status() { return null; },
    setConcurrency() {},
    dispose() {},
  };
  const executor = new ClaudeBoardWorkerExecutor(runner);
  const base = {
    taskId: 1,
    epicId: 1,
    projectId: 1,
    status: 'in_progress',
    skill: 'saga-worker',
    workerExecutionId: 'exec-1',
    fenceToken: 'exec-1',
    runId: 'run-1',
    workerId: 'worker-1',
    machineId: 'machine-1',
    repository: null,
  };

  assert.throws(
    () => executor.start({
      projectId: 1,
      concurrency: 1,
      assignment: { ...base, executionContext: null },
    }),
    /FROZEN_EXECUTION_CONTEXT_REQUIRED/,
  );
  assert.equal(starts, 0);

  const snapshot = {
    policy_version: 'factory.execution.v2',
    executor_kind: 'claude-cli-simulator',
    model_route: { provider: null, model: null, effort: null },
  };
  executor.start({
    projectId: 1,
    concurrency: 1,
    assignment: { ...base, executionContext: snapshot },
  });
  assert.equal(starts, 1);
});
