// Controller for coexistence between the generic Saga 3 lifecycle bar and the
// legacy episode pipeline. It owns orchestration only; pipeline.js owns DOM
// rendering and the single live-duration timer.

import { renderPipeline } from './pipeline.js';

let owned = false;
let pollTimer = null;
let currentEpicId = null;
let generation = 0;
let legacyRefresh = () => {};

export function configureLegacyPipeline(fn) {
  legacyRefresh = typeof fn === 'function' ? fn : () => {};
}

/**
 * Start one non-overlapping polling chain for an epic. A generation token
 * prevents a slow response for a previously selected epic from reaching DOM.
 */
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

  let response = null;
  try {
    const httpResponse = await fetch(
      '/api/lifecycle/pipeline?epic_id=' + encodeURIComponent(epicId),
    );
    response = await httpResponse.json();
  } catch {
    // Keep the last authoritative lifecycle render on transient failures.
    // Before lifecycle ownership, let the legacy path try to render.
    if (token === generation && currentEpicId === epicId && !owned) {
      legacyRefresh();
    }
  }

  if (token !== generation || currentEpicId !== epicId) return;

  if (response) {
    if (response.ok && response.source === 'lifecycle' && response.view) {
      owned = true;
      const container = document.getElementById('pipeline-stages');
      if (container) renderPipeline(container, response.view);
    } else {
      releaseOwnership();
      legacyRefresh();
    }
  }

  if (token === generation && currentEpicId === epicId) {
    pollTimer = setTimeout(
      () => void poll(token, epicId, intervalMs),
      intervalMs,
    );
  }
}

function releaseOwnership() {
  if (owned) {
    const container = document.getElementById('pipeline-stages');
    if (container) renderPipeline(container, null);
  }
  owned = false;
}
