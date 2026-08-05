/**
 * Shared conveyor fakes for Saga 3 discovery tests.
 *
 * Slice 1 Zones 5-7 (node-breaker): the four discovery services + engine now
 * assign their projected card through WorkAssignmentPort BEFORE launching the
 * worker (assignOneCard). These fakes inject the minimum a test needs:
 *   - fakeWorkAssignment: returns a fixed AssignedWork for whatever taskId the
 *     service asks about (echoes the requested card), records release calls.
 *   - fakeIdGenerator: deterministic sequential ids.
 *   - TEST_MACHINE_ID: stable host identity.
 *
 * Tests that exercise the 'done'/'blocked'/'active' preparation paths do NOT
 * spawn a worker, so they do not need these fakes — only the 'ready' path
 * (which calls assignOneCard) requires them. Every FactoryDiscoveryEngine /
 * FactoryDiscoveryNormalizationService / FactoryDiscoveryReadinessService /
 * FactoryDiscoveryDiagnosisService construction site must now pass:
 *   workAssignment, idGenerator, machineId
 * because the deps interface made them required.
 */

/** Stable test host identity. */
export const TEST_MACHINE_ID = 'test-host';

/**
 * Deterministic id generator for tests — sequential counter per prefix.
 * Mirrors `sequentialIdGenerator` from conveyor-adapters.ts but inlined here
 * so tests have no dist dependency for the generator.
 */
export function fakeIdGenerator() {
  let n = 0;
  return {
    newId: () => `id-${++n}`,
    newTypedId: (prefix) => `${prefix}-${++n}`,
  };
}

/**
 * In-memory fake of WorkAssignmentPort. Returns a valid AssignedWork for any
 * taskId requested (the discovery services project an exact card; the fake
 * echoes it). Records assignTask / releaseAssignment calls so tests can assert
 * on the release-on-failure discipline.
 *
 * Pass `nextAssigned` to override the returned assignment (e.g. to test the
 * null-assignment lost-race path), or omit to get a default valid shape.
 */
export function fakeWorkAssignment({ nextAssigned, claimable = true } = {}) {
  const calls = { assign: [], release: [] };
  return {
    calls,
    assignTask(input) {
      calls.assign.push(input);
      if (!claimable) return null;
      if (nextAssigned) return nextAssigned;
      const taskId = input.taskIds?.[0] ?? 0;
      const exec = input.workerExecutionId;
      return {
        taskId,
        epicId: input.epicId ?? null,
        projectId: input.projectId,
        status: 'in_progress',
        skill: 'discovery-fake-skill',
        workerExecutionId: exec,
        fenceToken: exec,
        runId: input.runId,
        workerId: input.workerId,
        machineId: input.machineId,
        repository: null,
        executionContext: null,
      };
    },
    releaseAssignment(input) {
      calls.release.push(input);
    },
    countClaimable() {
      return claimable ? 1 : 0;
    },
  };
}
