// Lifecycle Pipeline Renderer — frontend logic.
//
// Renders a horizontal pipeline/stepper bar from a frozen PipelineView JSON
// contract. Fully data-driven: it loops over `view.stages` and never references
// any stage name, lifecycle name, or count. Whatever the contract says, it
// renders — horizontal, scrollable on overflow.
//
// Clean-architecture boundary: this is a pure static client asset (vanilla ESM
// + CSS). It does NOT import the monolith `tracker-view.mjs` and does NOT know
// the backend URL; the integration layer injects a `fetchView` thunk. Icons are
// Unicode glyphs to match the existing `.pipeline-*` visual language.
//
// Export: renderPipeline(container, view) — one-shot render. Polling belongs to

// ---- status → icon + class mapping (lifecycle-agnostic, keyed by field) ----
// Mirrors the monolith's .pipeline-* colors but under the `.lp-` prefix so the
// two never collide if both are on the same page.
const ICONS = {
  completed: '✓',
  in_progress: '●',
  pending: '○',
  paused: '⏸',
  failed: '✗',
  skipped: '–',
};

// Per-module DOM handle so the live timer can re-render one node without
// rebuilding the whole bar. Held in module scope; cleared on re-render.
let liveTimer = null;
// Map stageId -> { durEl, startedAt } for isLive stages, so the interval
// callback can find the node to update each tick.
let liveStages = new Map();

/**
 * Render a PipelineView into `container`.
 *
 * @param {HTMLElement} container  DOM element to fill (cleared first).
 * @param {object|null} view       A PipelineView object, or null. When null the
 *                                 container is cleared and nothing is drawn
 */
export function renderPipeline(container, view) {
  // Always tear down any prior live timer / handle table before drawing, even
  // in the null case, so re-rendering from a live view to null is leak-free.
  stopLiveTimer();

  if (!container) return;
  // Clear previous render (textContent avoids leaving listener-bound nodes
  // dangling; the bar is rebuilt from scratch each call).
  container.textContent = '';

  if (!view) return;

  const bar = document.createElement('div');
  bar.className = 'lp-bar';

  // Optional header: lifecycle display name + run status. Fully driven by the
  // contract; if lifecycle.displayName is absent we just omit the header.
  const header = buildHeader(view);
  if (header) container.appendChild(header);

  const stages = Array.isArray(view.stages) ? view.stages : [];
  const hasTerminal = view.terminal != null;
  liveStages = new Map();

  // Render each stage left→right, separated by arrows. Looping over the array
  // is what makes this lifecycle-agnostic: no stage names are hard-coded.
  stages.forEach((stage, i) => {
    if (i > 0) {
      bar.appendChild(buildArrow());
    }
    bar.appendChild(buildStage(stage, hasTerminal));
  });

  // If the lifecycle terminated, append a terminal badge after the last stage.
  // Visual "stop" marker so the reader sees progression ended here.
  if (hasTerminal) {
    const arrow = buildArrow();
    arrow.classList.add('lp-arrow-terminal');
    bar.appendChild(arrow);
    bar.appendChild(buildTerminalBadge(view.terminal));
  }

  container.appendChild(bar);

  // Start the live timer if any stage is currently live (in_progress + isLive).
  // Done after the DOM is attached so the per-tick update finds real nodes.
  if (liveStages.size > 0) {
    startLiveTimer();
  }
}

/**
 * Build the header row (lifecycle display name + run status chip).
 * Returns null if there is nothing to show.
 */
function buildHeader(view) {
  const lc = view.lifecycle || {};
  const run = view.run || {};
  const name = lc.displayName || lc.name;
  const status = run.status;
  if (!name && !status) return null;

  const head = document.createElement('div');
  head.className = 'lp-header';

  if (name) {
    const titleEl = document.createElement('span');
    titleEl.className = 'lp-title';
    titleEl.textContent = name;
    head.appendChild(titleEl);
  }
  if (status) {
    const chip = document.createElement('span');
    chip.className = 'lp-run-status ' + cssSafe(status);
    chip.textContent = status;
    head.appendChild(chip);
  }
  // If the run failed with an error, surface a tiny note (lifecycle-agnostic).
  if (run.error) {
    const err = document.createElement('span');
    err.className = 'lp-run-error';
    err.textContent = '⚠ ' + String(run.error).slice(0, 80);
    head.appendChild(err);
  }
  return head;
}

/**
 * Build a single `.lp-stage` element from a stage object. Pure DOM (no
 * innerHTML for label text). Records live stages for the ticking timer.
 */
function buildStage(stage) {
  const el = document.createElement('div');
  el.className = 'lp-stage ' + cssSafe(stage.status || 'pending');
  el.setAttribute('data-stage-id', String(stage.stageId ?? ''));

  // Icon — Unicode glyph by status field.
  const icon = document.createElement('span');
  icon.className = 'lp-icon';
  icon.textContent = ICONS[stage.status] || '?';
  el.appendChild(icon);

  // Name (the label) — the prominent line.
  const name = document.createElement('span');
  name.className = 'lp-name';
  name.textContent = stage.displayName || stage.stageId || '';
  el.appendChild(name);

  // Module subtext — module.name + version. Small, muted. Omit if absent.
  const mod = stage.module;
  if (mod && (mod.name || mod.version)) {
    const sub = document.createElement('span');
    sub.className = 'lp-module';
    const parts = [];
    if (mod.name) parts.push(mod.name);
    if (mod.version) parts.push('v' + mod.version);
    sub.textContent = parts.join(' ');
    el.appendChild(sub);
  }

  // Duration line. For completed/paused/etc. with a precomputed durationS we
  // show it formatted once. For isLive stages we show a ticking timer that
  // recomputes from now − startedAt every second.
  const durEl = document.createElement('span');
  durEl.className = 'lp-dur';
  el.appendChild(durEl);

  if (stage.isLive && stage.startedAt && stage.status === 'in_progress') {
    // Live: render the initial elapsed now and register for ticking.
    durEl.textContent = formatDur(elapsedSeconds(stage.startedAt));
    liveStages.set(String(stage.stageId), {
      durEl,
      startedAt: stage.startedAt,
    });
  } else if (stage.durationS != null) {
    // Static precomputed duration for completed/terminal stages.
    durEl.textContent = formatDur(stage.durationS);
  }

  // Rework counter: attempt > 1 → "↻N" next to the icon/name area.
  if (stage.attempt && stage.attempt > 1) {
    const att = document.createElement('span');
    att.className = 'lp-attempt';
    att.title = 'rework attempt #' + stage.attempt;
    att.textContent = '↻' + stage.attempt;
    el.appendChild(att);
  }

  // Module local outcome as a small badge, when non-null. The contract calls
  // this "go"/"formalized"/"infeasible"/... — shown verbatim (lifecycle-agnostic).
  if (stage.localOutcome != null && stage.localOutcome !== '') {
    const badge = document.createElement('span');
    badge.className = 'lp-outcome ' + cssSafe(String(stage.localOutcome));
    badge.textContent = String(stage.localOutcome);
    el.appendChild(badge);
  }

  return el;
}

/** Build an arrow `→` between stages. */
function buildArrow() {
  const a = document.createElement('span');
  a.className = 'lp-arrow';
  a.setAttribute('aria-hidden', 'true');
  a.textContent = '→';
  return a;
}

/** Build the terminal badge appended after the last stage when view.terminal. */
function buildTerminalBadge(terminal) {
  const el = document.createElement('div');
  const status = terminal.status || 'terminal';
  el.className = 'lp-terminal ' + cssSafe(status);
  const txt = ['terminal', status].filter(Boolean).join(' · ');
  el.textContent = '■ ' + txt;
  el.title = 'Lifecycle ended: ' + (terminal.atStageId || '?');
  return el;
}

// ---- live ticking timer ----

/** Start a single setInterval that ticks every second for all live stages. */
function startLiveTimer() {
  if (liveTimer) return; // guard against double-start
  const tick = () => {
    for (const { durEl, startedAt } of liveStages.values()) {
      // Node may have been removed from the DOM by an external re-render; skip
      // detached elements rather than throwing.
      if (durEl && durEl.isConnected) {
        durEl.textContent = formatDur(elapsedSeconds(startedAt));
      }
    }
  };
  tick(); // immediate first update for accuracy
  liveTimer = setInterval(tick, 1000);
}

/** Tear down the live timer and clear the live-stage table. */
function stopLiveTimer() {
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
  liveStages = new Map();
}

// ---- shared helpers ----

/**
 * Format a duration in seconds, mirroring the monolith's formatDur rule
 * (tracker-view.mjs ~1338): <60s → "Ns"; <3600s → "Nm Ss"; ≥3600s → "HhMm".
 * null/undefined → '' (caller decides whether to render the node at all).
 *
 * Exported for unit testing without a DOM.
 */
export function formatDur(sec) {
  if (sec == null || isNaN(sec) || sec < 0) return '';
  sec = Math.floor(sec);
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return m + 'm' + (s ? ' ' + s + 's' : '');
  const h = Math.floor(m / 60);
  return h + 'h' + (m % 60) + 'm';
}

/** Elapsed whole seconds from an ISO timestamp to now (0 if unparseable). */
function elapsedSeconds(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

/**
 * Make a status/outcome string safe to use as a CSS class suffix. Lowercases,
 * keeps alnum. Empty → 'unknown' so we never emit a dangling `.lp-stage ` with
 * a trailing space and no token.
 */
function cssSafe(value) {
  const s = String(value == null ? '' : value).toLowerCase();
  const kept = s.replace(/[^a-z0-9_-]/g, '');
  return kept || 'unknown';
}
