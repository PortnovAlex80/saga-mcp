// Controller for the Saga 3 lifecycle pipeline bar. Owns polling orchestration;
// pipeline.js owns DOM rendering and the single live-duration timer.
//
// refresh to yield to. An epic with no LifecycleRun renders an explicit empty

import { renderPipeline } from './pipeline.js';

let owned = false;
let pollTimer = null;
let currentEpicId = null;
let generation = 0;
let lastView = null;
let activeWorkerCount = 0;

window.addEventListener('saga:active-workers-changed', event => {
  activeWorkerCount = Number(event?.detail?.count) || 0;
  renderCurrentView();
});

export function mountLifecyclePipeline(epicId, intervalMs = 5000) {
  stop();
  currentEpicId = epicId;
  activeWorkerCount = window.__activeWorkers?.size || 0;
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
  lastView = null;
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
    owned = true;
    const container = document.getElementById('pipeline-stages');
    lastView = response?.view ?? null;
    // The board's worker poller predates the activity event. Re-read its
    // shared map as a compatibility path so a browser refresh picks up this
    // fix even when tracker-view itself has not been restarted.
    if (window.__activeWorkers instanceof Map) {
      activeWorkerCount = window.__activeWorkers.size;
    }
    if (container) renderPipeline(container, lastView, { activeWorkerCount });
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

function renderCurrentView() {
  if (!owned) return;
  const container = document.getElementById('pipeline-stages');
  if (container) renderPipeline(container, lastView, { activeWorkerCount });
}
