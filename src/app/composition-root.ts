import type { BoardProjectionReader } from '../application/ports/board-projection.js';
import type { LegacySaga2Runner } from '../application/ports/legacy-saga2-runtime.js';
import { createSagaApplication, type SagaApplication } from '../application/saga-application.js';
import { closeDb } from '../db.js';
import { Saga2Engine } from '../engines/saga2-engine.js';
import { SqliteBoardProjectionReader } from '../infrastructure/projections/sqlite-board-projection-reader.js';
import { runLegacySaga2 } from '../infrastructure/runtime/legacy-saga2-runner.js';
import {
  loadSagaRuntimeConfig,
  type SagaRuntimeConfig,
} from '../runtime/saga-runtime-config.js';

export interface Saga2CompositionOverrides {
  config?: SagaRuntimeConfig;
  runLegacy?: LegacySaga2Runner;
  board?: BoardProjectionReader;
  close?: () => void;
}

/**
 * The only place that selects concrete Saga 2 runtime implementations.
 *
 * CLI and future HTTP hosts consume SagaApplication and do not import the
 * pump, SQLite projection SQL, worker process code, or database shutdown.
 */
export function createSaga2Application(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Saga2CompositionOverrides = {},
): SagaApplication {
  const config = overrides.config ?? loadSagaRuntimeConfig(env);
  const engine = new Saga2Engine({
    config,
    runLegacy: overrides.runLegacy ?? runLegacySaga2,
  });
  const board = overrides.board ?? new SqliteBoardProjectionReader(config.dbPath);

  return createSagaApplication({
    engine,
    board,
    close: overrides.close ?? closeDb,
  });
}
