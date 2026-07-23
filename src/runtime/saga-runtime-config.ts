export interface SagaRuntimeConfig {
  dbPath: string;
  claudePath?: string;
  lmStudioUrl: string;
  trackerAutostart: boolean;
  trackerPort: number;
  trackerReloadSec: number;
  orchestrationMode?: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reads the current Saga 2 configuration contract without changing precedence
 * or defaults. Legacy components may still read process.env internally during
 * the first extraction slices; the composition root now has one validated view
 * that future adapters can consume.
 */
export function loadSagaRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): SagaRuntimeConfig {
  const dbPath = env.DB_PATH?.trim();
  if (!dbPath) {
    throw new Error('DB_PATH env var is required (path to the saga SQLite database).');
  }

  const claudePath = env.SAGA_CLAUDE_PATH?.trim() || undefined;

  return {
    dbPath,
    claudePath,
    lmStudioUrl: env.SAGA_LMSTUDIO_URL?.trim() || 'http://localhost:1234/v1',
    trackerAutostart: env.TRACKER_AUTOSTART !== '0',
    trackerPort: positiveInteger(env.PORT, 4321),
    trackerReloadSec: positiveInteger(env.RELOAD_SEC, 5),
    orchestrationMode: env.SAGA_ORCHESTRATION_MODE?.trim() || undefined,
  };
}
