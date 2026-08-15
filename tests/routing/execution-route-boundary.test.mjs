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

// CONVEYOR v4.3 PART 1,3,12: there is no simulator route. Replay is an internal
// production source resolved from execution_context.replay.capsule_ref — NOT an
// executor kind selectable by routing configuration.
test('simulator executor kind is rejected by the routing policy', () => {
  assert.throws(
    () => createExecutionRouteResolver({
      policy: {
        routes: [{
          match: { module: 'solution-formalization' },
          route: { executor: { kind: 'claude-cli-simulator' } },
        }],
      },
    }),
    /unsupported.*only 'claude-cli' is supported/i,
  );
});

test('real executor inherits front-selected inference unless policy overrides it', () => {
  const inheritedResolver = createExecutionRouteResolver({
    policy: {
      default: { executor: { kind: 'claude-cli' } },
      routes: [],
    },
  });
  const inheritedRoute = inheritedResolver.resolve(key);
  assert.deepEqual(routeToModelRoute(inheritedRoute, {
    provider: 'zai', model: 'glm-4.7', effort: 'medium',
  }), {
    provider: 'zai', model: 'glm-4.7', effort: 'medium',
  });

  const overrideResolver = createExecutionRouteResolver({
    policy: {
      routes: [{
        match: { executionProfile: 'formalization-architect' },
        route: {
          executor: { kind: 'claude-cli' },
          provider: 'zai',
          model: 'glm-5.2',
          effort: 'high',
        },
      }],
    },
  });
  const overrideRoute = overrideResolver.resolve(key);
  assert.deepEqual(routeToModelRoute(overrideRoute, {
    provider: 'zai', model: 'glm-4.7', effort: 'medium',
  }), {
    provider: 'zai', model: 'glm-5.2', effort: 'high',
  });
});

test('routing policy rejects duplicate matches', () => {
  assert.throws(
    () => createExecutionRouteResolver({
      policy: {
        routes: [
          {
            match: { module: 'product-discovery' },
            route: { executor: { kind: 'claude-cli' } },
          },
          {
            match: { module: 'product-discovery' },
            route: { executor: { kind: 'claude-cli' } },
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

  // CONVEYOR v4.3 PART 1: only claude-cli is accepted. A simulator kind is
  // rejected because it is no longer a runtime route.
  const simulatorSnapshot = {
    policy_version: 'factory.execution.v2',
    executor_kind: 'claude-cli-simulator',
    model_route: { provider: null, model: null, effort: null },
  };
  assert.throws(
    () => executor.start({
      projectId: 1,
      concurrency: 1,
      assignment: { ...base, executionContext: simulatorSnapshot },
    }),
    /FROZEN_EXECUTOR_KIND_REQUIRED/,
  );
  assert.equal(starts, 0);

  // Normal claude-cli route is accepted and spawns the runner.
  const realSnapshot = {
    policy_version: 'factory.execution.v2',
    executor_kind: 'claude-cli',
    model_route: { provider: 'zai', model: 'glm-5.2', effort: 'high' },
  };
  executor.start({
    projectId: 1,
    concurrency: 1,
    assignment: { ...base, executionContext: realSnapshot },
  });
  assert.equal(starts, 1);
});
