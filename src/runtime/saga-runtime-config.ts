export interface SagaRuntimeConfig {
  dbPath: string;
  claudePath?: string;
  lmStudioUrl: string;
  zaiBaseUrl: string;
  trackerAutostart: boolean;
  trackerPort: number;
  trackerReloadSec: number;
  trackerSpawned: boolean;
  trackerNoBrowser: boolean;
  orchestrationMode: string;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reads the stable Saga 2 runtime contract once at the composition boundary.
 * Infrastructure adapters receive this object instead of reading process.env.
 */
export function loadSagaRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): SagaRuntimeConfig {
  const dbPath = env.DB_PATH?.trim();
  if (!dbPath) {
    throw new Error('DB_PATH env var is required (path to the saga SQLite database).');
  }

  return {
    dbPath,
    claudePath: env.SAGA_CLAUDE_PATH?.trim() || undefined,
    lmStudioUrl: env.SAGA_LMSTUDIO_URL?.trim() || 'http://localhost:1234/v1',
    zaiBaseUrl: env.SAGA_ZAI_BASE_URL?.trim() || 'https://api.z.ai/api/anthropic',
    trackerAutostart: env.TRACKER_AUTOSTART !== '0',
    trackerPort: positiveInteger(env.PORT, 4321),
    trackerReloadSec: positiveInteger(env.RELOAD_SEC, 5),
    trackerSpawned: env.TRACKER_SPAWNED === '1',
    trackerNoBrowser: env.TRACKER_NO_BROWSER === '1',
    orchestrationMode: env.SAGA_ORCHESTRATION_MODE?.trim().toLowerCase() || 'v2',
  };
}
