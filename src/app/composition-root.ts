import { createSagaApplication, type SagaApplication } from '../application/saga-application.js';
import { closeDb } from '../db.js';
import { Saga2Engine, type LegacySaga2Runner } from '../engines/saga2-engine.js';
import {
  loadSagaRuntimeConfig,
  type SagaRuntimeConfig,
} from '../runtime/saga-runtime-config.js';

export interface Saga2CompositionOverrides {
  config?: SagaRuntimeConfig;
  runLegacy?: LegacySaga2Runner;
  close?: () => void;
}

/**
 * The only place that selects the concrete engine for the CLI host.
 *
 * Replacing Saga2Engine with a future Saga3Engine must not require changes to
 * orchestrate-cli, the tracker, worker protocols, SQLite schema, or artifacts.
 */
export function createSaga2Application(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Saga2CompositionOverrides = {},
): SagaApplication {
  const config = overrides.config ?? loadSagaRuntimeConfig(env);
  const engine = new Saga2Engine({
    config,
    runLegacy: overrides.runLegacy,
  });

  return createSagaApplication({
    engine,
    close: overrides.close ?? closeDb,
  });
}
