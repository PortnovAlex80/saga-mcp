import type { LegacySaga2Runner } from '../../application/ports/legacy-saga2-runtime.js';
import type { Saga2RuntimePersistence } from '../../application/ports/saga2-runtime-persistence.js';
import type { WorkerExecutorFactory } from '../../application/ports/worker-executor.js';
import { orchestrate } from '../../orchestrate.js';

export interface LegacySaga2RuntimeDependencies {
  dbPath: string;
  lmStudioUrl: string;
  workerExecutorFactory: WorkerExecutorFactory;
  persistence: Saga2RuntimePersistence;
}

/** Concrete infrastructure bridge to the stable Saga 2 orchestration pump. */
export function createLegacySaga2Runner(
  dependencies: LegacySaga2RuntimeDependencies,
): LegacySaga2Runner {
  return invocation => orchestrate({
    ...invocation,
    dbPath: dependencies.dbPath,
    lmStudioUrl: dependencies.lmStudioUrl,
    workerExecutorFactory: dependencies.workerExecutorFactory,
    persistence: dependencies.persistence,
  });
}
