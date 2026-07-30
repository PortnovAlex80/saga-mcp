// Controller for the Saga 3 lifecycle pipeline bar. Owns polling orchestration;
// pipeline.js owns DOM rendering and the single live-duration timer.
//
// saga4 cutover (Phase 7): the legacy episode-pipeline coexistence / fallback
// was removed. mount.js is now the SOLE pipeline renderer — there is no legacy
// refresh to yield to. An epic with no LifecycleRun renders an explicit empty
// state (handled in pipeline.js), never a legacy bar.

import { renderPipeline } from './pipeline.js';

let owned = false;
let pollTimer = null;
let currentEpicId = null;
let generation = 0;

export function mountLifecyclePipeline(epicId, intervalMs = 5000) {
  stop();
  currentEpicId = epicId;
  if (!epicId) return;
  const token = generation;
  void poll(token, epicId, intervalMs);
}

export function ownsPipelineContainer() {
  return owned;
}

export function stop() {
  generation += 1;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  currentEpicId = null;
  if (owned) {
    const container = document.getElementById('pipeline-stages');
    if (container) renderPipeline(container, null);
    owned = false;
  }
}

async function poll(token, epicId, intervalMs) {
  if (token !== generation || currentEpicId !== epicId) return;

  try {
    const httpResponse = await fetch(
      '/api/lifecycle/pipeline?epic_id=' + encodeURIComponent(epicId),
    );
    const response = await httpResponse.json();
    if (token !== generation || currentEpicId !== epicId) return;

    // The lifecycle projection is authoritative. Render it whenever present
    // (including a null/empty view for epics with no LifecycleRun). There is no
    // legacy fallback anymore.
    owned = true;
    const container = document.getElementById('pipeline-stages');
    if (container) renderPipeline(container, response?.view ?? null);
  } catch {
    // Keep the last authoritative lifecycle render on transient failures.
  }

  if (token === generation && currentEpicId === epicId) {
    pollTimer = setTimeout(
      () => void poll(token, epicId, intervalMs),
      intervalMs,
    );
  }
}
