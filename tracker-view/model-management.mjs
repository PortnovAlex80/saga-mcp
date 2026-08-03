// Model management API extracted from tracker-view.mjs (T10 step 3).
//
// This module owns everything related to the selectable model catalog and the
// /api/models + /api/lmstudio/models + /api/model/set HTTP endpoints, plus the
// ~/.claude/settings.json two-state template switching (cloud ↔ LM Studio) that
// makes new workers pick up the chosen provider/model.
//
// It depends only on ./shared.mjs helpers (withDb / withDbWrite / respondJson /
// readJsonRequest) and runtimeConfig (lmStudioUrl, zaiBaseUrl) + the process-
// wide workerModel fallback resolved by tracker-view.mjs. No HTTP server, no
// rendering — the route strings stay in tracker-view.mjs as test anchors.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function createModelManagementApi({
  runtimeConfig,
  withDb,
  withDbWrite,
  respondJson,
  readJsonRequest,
  workerModel,
}) {
  // --- Constants --------------------------------------------------------------
  // Z.ai cloud models (subscription). Source: Z.ai GLM Coding Plan FAQ
  // (docs.z.ai/devpack/faq): all plans support GLM-5.2, GLM-5-Turbo, GLM-4.7.
  // Other GLM variants are NOT exposed on the Coding Plan endpoint — selecting
  // them produces api_retry "unknown" errors from z.ai. Limit values reflect
  // z.ai's documented rate multipliers: GLM-5.2 counts x3 in peak hours,
  // x2 off-peak; the others are x1. The limit is the per-epic concurrency
  // ceiling saga uses; NOT the prompt quota (tracked by z.ai, 80/400/1600 per 5h).
  const ZAI_MODELS = [
    { id: 'glm-5.2',         limit: 3,  tier: 'flagship', provider: 'zai', effort: 'high', note: 'Opus-level, x3 peak rate' },
    { id: 'glm-5-turbo',     limit: 5,  tier: 'flagship', provider: 'zai', effort: 'high', note: 'Opus-level, x1 rate' },
    { id: 'glm-4.7',         limit: 10, tier: 'sonnet',   provider: 'zai', effort: 'high', note: 'Sonnet-level, x1 rate — recommended default' },
  ];

  // LM Studio local models (no subscription, runs on this machine). Populated
  // lazily from GET <LMSTUDIO_URL>/models (Anthropic+OpenAI-compatible server
  // built into LM Studio on port 1234). Empty until first probe — the UI shows
  // "LM Studio (офлайн)" while LMSTUDIO_ONLINE is false.
  // NOTE: this URL keeps the /v1 suffix for the /models PROBE (LM Studio's
  // OpenAI-compatible list endpoint). The settings.json ANTHROPIC_BASE_URL we
  // write for claude v2 is derived by stripping /v1 (see handleModelSet) —
  // claude v2 appends /v1 itself, so keeping it here would yield /v1/v1.
  const LMSTUDIO_URL = runtimeConfig.lmStudioUrl.replace(/\/+$/, '');
  // Snapshot of the user's original cloud settings.json — captured BEFORE the
  // first LM Studio activation, restored when switching back to zai. Path next
  // to settings.json so it travels with the user profile.
  const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
  // Two-state switching (no in-place patching of settings.json, no one-shot
  // backups): keep TWO permanent canonical templates alongside settings.json
  // and switch = copy a template onto settings.json atomically. The templates
  // are write-once: cloud is captured the first time we see a real cloud
  // settings.json, lmstudio is a generated constant. Neither is ever rewritten
  // by saga afterwards, so the cloud AUTH_TOKEN (the secret) cannot be lost to
  // a botched toggle. This replaces the old in-place patch + lazy-backup model
  // which silently corrupted tokens when settings.json was already on localhost
  // at snapshot time.
  const CLAUDE_SETTINGS_CLOUD_TPL    = path.join(os.homedir(), '.claude', 'settings.cloud.json');
  const CLAUDE_SETTINGS_LMSTUDIO_TPL = path.join(os.homedir(), '.claude', 'settings.lmstudio.json');
  // Z.ai cloud endpoint (subscription). Used as a fallback when no cloud
  // template exists yet (saga started on LM Studio config or the user never
  // had a cloud session). The endpoint is a Z.ai-wide constant; only the
  // AUTH_TOKEN is user-specific.
  const ZAI_DEFAULT_BASE_URL = runtimeConfig.zaiBaseUrl;
  // Local models have no cloud rate limit, so allow a generous concurrency.
  const LMSTUDIO_DEFAULT_LIMIT = 4;
  let LMSTUDIO_MODELS = [];     // [{ id, limit, tier:'local', provider:'lmstudio' }] — NO `effort` field: LM Studio owns its reasoning default (qwen rejects effort='xhigh'/'high'), so the runner omits --effort entirely for these.
  let LMSTUDIO_ONLINE = false;

  /**
   * Probe LM Studio's /v1/models endpoint. Updates LMSTUDIO_MODELS + LMSTUDIO_ONLINE.
   * Returns the fresh state. Idempotent; safe to call on every GET /api/lmstudio/models.
   * 3s timeout — LM Studio is local; longer means it's not running.
   */
  async function probeLmstudioModels() {
    const url = LMSTUDIO_URL + '/models';
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) { LMSTUDIO_ONLINE = false; LMSTUDIO_MODELS = []; return { online: false, error: `HTTP ${r.status}` }; }
      const body = await r.json();
      // OpenAI shape: { data: [{ id }] }. Tolerate { models: [{ id }] } too.
      const list = Array.isArray(body?.data) ? body.data : (Array.isArray(body?.models) ? body.models : []);
      const ids = list.map(m => m?.id).filter(id => typeof id === 'string' && id.length);
      LMSTUDIO_MODELS = ids.map(id => ({ id, limit: LMSTUDIO_DEFAULT_LIMIT, tier: 'local', provider: 'lmstudio' }));
      LMSTUDIO_ONLINE = true;
      return { online: true, models: LMSTUDIO_MODELS };
    } catch (e) {
      LMSTUDIO_ONLINE = false;
      LMSTUDIO_MODELS = [];
      return { online: false, error: e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)) };
    }
  }

  // All selectable models (cloud + local). Used by handleModelsList, handleModelSet, UI.
  function allModels() { return [...ZAI_MODELS, ...LMSTUDIO_MODELS]; }

  // --- GET /api/lmstudio/models ---
  // Probe LM Studio and return its live model list. The UI calls this on page
  // load (to populate the LM Studio optgroup) and on "↻ обновить" click.
  async function handleLmstudioModelsList(req, res) {
    const result = await probeLmstudioModels();
    respondJson(res, 200, { ok: true, lmstudio_url: LMSTUDIO_URL, ...result });
  }

  // --- GET /api/models ---
  function handleModelsList(req, res) {
    // current: the most recently chosen model across all episodes, read live from
    // saga.db. Falls back to the process-wide WORKER_MODEL (resolved from
    // ~/.claude/settings.json at startup) when no episode has a chosen model.
    // Without this live read the selector would show a stale start-of-process
    // value after the user switches models, since WORKER_MODEL is a const.
    let current = workerModel;
    try {
      const row = withDb(db => db.prepare(
        `SELECT model_name AS m
         FROM lifecycle_execution_controls
         WHERE model_name IS NOT NULL AND model_name <> ''
         ORDER BY updated_at DESC LIMIT 1`,
      ).get());
      if (typeof row?.m === 'string' && row.m.length > 0) current = row.m;
    } catch { /* DB busy / no row → keep fallback */ }
    respondJson(res, 200, {
      ok: true,
      current,
      models: allModels(),
      lmstudio_online: LMSTUDIO_ONLINE,
      lmstudio_url: LMSTUDIO_URL,
    });
  }

  /**
   * Atomically write ~/.claude/settings.json and WAIT until the bytes are
   * durably on disk and re-readable. Returns true on success, throws on failure.
   *
   * Why this exists: the spawned claude CLI reads settings.json immediately on
   * startup, and on Windows the default fs.writeFile can return before the OS
   * has flushed the file — the next process then reads a half-written or stale
   * version and fails with 401 / unknown-model errors. The sequence below is
   * the canonical "write → fsync → readback verify" pattern:
   *
   *   1. open(path, 'w')            — truncate, get fd
   *   2. fd.write(json)             — stage bytes
   *   3. fd.sync (fsync)            — force kernel → disk
   *   4. fd.close
   *   5. read back, JSON.parse, assert the auth-relevant key matches what we
   *      wrote. If not → throw (caller surfaces 500).
   *
   * The verify step is the contract: by the time this returns, ANY process that
   * opens settings.json will see exactly what we wrote.
   */
  function atomicSettingsWrite(payload) {
    const json = JSON.stringify(payload, null, 2);
    // Step 1-4: write + fsync + close. Synchronous file ops are fine here — the
    // file is small (~2 KB) and the worker pump only fires one model/set at a
    // time. The whole point is to block until durable.
    const fd = fs.openSync(CLAUDE_SETTINGS_PATH, 'w');
    try {
      fs.writeFileSync(fd, json, 'utf8');
      fs.fsyncSync(fd);  // kernel → disk
    } finally {
      fs.closeSync(fd);
    }
    // Step 5: readback verify — the auth-relevant env values must round-trip
    // exactly. This catches torn writes and partial flushes.
    const readBack = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    const rb = readBack?.env || {};
    const pv = payload?.env || {};
    const keys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
                  'CLAUDE_CODE_ATTRIBUTION_HEADER', 'ANTHROPIC_DEFAULT_OPUS_MODEL'];
    for (const k of keys) {
      const a = rb[k], b = pv[k];
      // Treat present-but-undefined and absent as equal (both → undefined).
      if ((a ?? undefined) !== (b ?? undefined)) {
        throw new Error(`settings.json verify failed for ${k}: wrote ${JSON.stringify(b)}, read ${JSON.stringify(a)}`);
      }
    }
    return true;
  }

  /**
   * Get the canonical cloud template (settings.cloud.json). Creates it on first
   * call from the LIVE settings.json — but ONLY if that live settings.json is
   * actually a cloud config (BASE_URL not pointing at localhost). This is the
   * single moment in saga's lifetime when the user's real cloud AUTH_TOKEN is
   * captured into a permanent template; thereafter the template is never
   * overwritten, so the token cannot be lost to a later bad toggle.
   *
   * If the live settings.json is already on localhost and no cloud template
   * exists, returns null — caller decides what to do (typically: refuse to
   * switch to cloud until the user provides a token, or fall back to
   * ZAI_DEFAULT_BASE_URL with no token).
   */
  function getOrCreateCloudTemplate() {
    if (fs.existsSync(CLAUDE_SETTINGS_CLOUD_TPL)) {
      try { return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_CLOUD_TPL, 'utf8')); }
      catch { /* corrupt template — fall through and try to recreate */ }
    }
    // Capture from live settings.json — but only if it's a cloud config.
    const live = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    const base = (live?.env?.ANTHROPIC_BASE_URL || '').toLowerCase();
    const isLocal = base.startsWith('http://127.') || base.startsWith('http://localhost') || base.startsWith('http://[');
    if (isLocal) return null;  // can't capture a cloud template from a localhost config
    // Persist the template ONCE. Future calls short-circuit at the top.
    fs.writeFileSync(CLAUDE_SETTINGS_CLOUD_TPL, JSON.stringify(live, null, 2), 'utf8');
    return live;
  }

  /**
   * Get the canonical LM Studio template (settings.lmstudio.json). Persistent
   * file — written ONCE from the frontend selector, then never overwritten by
   * saga. No model defaults: model env vars are added by handleModelSet from
   * the frontend-supplied modelId. If settings.lmstudio.json does not exist,
   * returns a minimal skeleton with ONLY the LM Studio endpoint + auth token
   * and NO model slots (a caller that needs a model MUST set it explicitly).
   *
   * We deliberately DO NOT inherit the live settings.json env here — that was
   * the old bug: stale models from a previous run leaked into the LM Studio
   * template and overrode the frontend selector (gemma-4-26b survived even
   * after the user picked qwen3.6).
   */
  function getOrCreateLmstudioTemplate() {
    let tpl = null;
    try { tpl = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_LMSTUDIO_TPL, 'utf8')); } catch { /* not yet */ }
    if (tpl) {
      // Always refresh the endpoint (SAGA_LMSTUDIO_URL may have changed), but
      // leave model slots alone — they are owned by the frontend selector.
      tpl.env = tpl.env || {};
      tpl.env.ANTHROPIC_BASE_URL = LMSTUDIO_URL.replace(/\/v\d+\/?$/, '').replace(/\/+$/, '');
      tpl.env.ANTHROPIC_AUTH_TOKEN = 'lm-studio';
      tpl.env.ANTHROPIC_API_KEY = 'lm-studio';
      tpl.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
      return tpl;
    }
    // First-time skeleton: endpoint + auth only. NO ANTHROPIC_DEFAULT_*_MODEL —
    // those are set strictly from the frontend selector in handleModelSet.
    return {
      env: {
        ANTHROPIC_BASE_URL: LMSTUDIO_URL.replace(/\/v\d+\/?$/, '').replace(/\/+$/, ''),
        ANTHROPIC_AUTH_TOKEN: 'lm-studio',
        ANTHROPIC_API_KEY: 'lm-studio',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        API_TIMEOUT_MS: '3000000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      permissions: { allow: ['*'] },
    };
  }

  // --- POST /api/model/set ---
  // Patch ~/.claude/settings.json so NEW workers (spawned after this call) read
  // the new model. Active workers keep the old model — they've already started
  // `claude -p` and won't re-read settings.json. NO engine kill, NO spawn, NO
  // restart. We only persist the model info into lifecycle_execution_controls; the
  // engine's pump loop reads `model_concurrency_limit` and uses min(concurrency, limit)
  // as the effective ceiling, so concurrency naturally converges to the new
  // model's limit as old workers finish and new ones spawn.
  function handleModelSet(req, res) {
    readJsonRequest(req, fields => {
      const modelId = (fields.model || '').toString().trim();
      const epicId = Number(fields.epic_id);
      if (!modelId) return respondJson(res, 400, { ok:false, error:'model required' });
      const model = allModels().find(m => m.id === modelId);
      if (!model) return respondJson(res, 400, { ok:false, error:'unknown model: ' + modelId });
      const provider = model.provider || 'zai';

      // 1. Switch ~/.claude/settings.json between the two canonical templates so
      //    NEW workers (spawned after this call) read the new model/provider.
      //    Active workers keep the old config.
      //
      //    Two-state model: settings.cloud.json and settings.lmstudio.json are
      //    PERMANENT templates, written once and never overwritten by saga. A
      //    switch = atomicSettingsWrite(template → settings.json) with fsync +
      //    readback verify. This replaces the old in-place-patch + lazy-backup
      //    design, which silently corrupted the cloud AUTH_TOKEN when
      //    settings.json was already on localhost at snapshot time. The cloud
      //    template captures the user's real token the first time we see a real
      //    cloud settings.json and then freezes it forever.
      //
      //    NOTE on claude CLI v2.x (regression, anthropics/claude-code#8500):
      //    spawn-env ANTHROPIC_BASE_URL no longer overrides settings.json, and
      //    claude v2 appends '/v1' itself — so the LM Studio base URL must be
      //    WITHOUT /v1. This makes the main interactive ZCode agent follow the
      //    same provider as the episode while it runs — known side effect, no
      //    isolation possible in v2.
      try {
        let payload;
        if (provider === 'lmstudio') {
          // Before we destroy the live cloud config, freeze it into the cloud
          // template (no-op if already frozen). This is the ONLY capture point.
          getOrCreateCloudTemplate();
          payload = getOrCreateLmstudioTemplate();
        } else {
          // zai: switch back to the canonical cloud template. If it exists,
          // apply the chosen cloud model alias on top. If it doesn't (saga
          // started on a localhost settings.json and no cloud session ever ran),
          // fall back to ZAI_DEFAULT_BASE_URL with no token — workers will 401
          // and the user has to populate the cloud template manually.
          const cloudTpl = getOrCreateCloudTemplate();
          if (cloudTpl) {
            payload = cloudTpl;
            delete payload.env.ANTHROPIC_API_KEY;
            delete payload.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
          } else {
            // No cloud template and live settings.json is on localhost — desync.
            // Build a minimal cloud config so the user isn't stranded; the AUTH
            // token will be missing and must be set in settings.cloud.json.
            payload = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
            payload.env = payload.env || {};
            payload.env.ANTHROPIC_BASE_URL = ZAI_DEFAULT_BASE_URL;
            if (payload.env.ANTHROPIC_AUTH_TOKEN === 'lm-studio') delete payload.env.ANTHROPIC_AUTH_TOKEN;
            delete payload.env.ANTHROPIC_API_KEY;
            delete payload.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
          }
        }
        // HARD RULE: the model from the selector is authoritative. No defaults,
        // no inheritance, no "leave whatever was there". All four claude model
        // slots get EXACTLY modelId. If modelId is somehow empty we already 400'd
        // above, so here it is guaranteed non-empty. This closes the bug where
        // lmstudio template kept stale gemma-4-26b after the user picked qwen3.6.
        payload.env = payload.env || {};
        payload.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = modelId;
        payload.env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
        payload.env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
        payload.env.CLAUDE_CODE_SUBAGENT_MODEL = modelId;
        // Persist the LM Studio template so the chosen model survives a tracker-
        // view restart. cloud template is already frozen separately and must not
        // be touched here.
        if (provider === 'lmstudio') {
          try {
            fs.writeFileSync(CLAUDE_SETTINGS_LMSTUDIO_TPL, JSON.stringify(payload, null, 2), 'utf8');
          } catch (e) {
            console.error('[model/set] lmstudio template persist failed:', e.message);
          }
        }
        // Block until durable + verified. Throws on torn write → 500 to caller.
        atomicSettingsWrite(payload);
      } catch (e) {
        return respondJson(res, 500, { ok:false, error:'settings.json switch failed: ' + e.message });
      }

      // 2. Upsert model info into lifecycle_execution_controls. The engine's pump
      //    loop reads model_concurrency_limit on every cycle and uses
      //    min(opts.concurrency, model_concurrency_limit) as the effective ceiling —
      //    active workers keep running on the old model, but no NEW workers spawn
      //    until the active count drops below the new limit.
      //    model_provider tells claude-runner whether to add LM Studio env to
      //    the spawn ('lmstudio') or keep the z.ai legacy path ('zai').
      //    model_effort is the model-config reasoning effort (e.g. 'high'
      //    for z.ai cloud). LM Studio models have no effort field → null is
      //    written, which the runner reads as "omit --effort entirely" so the
      //    local chat template picks its own reasoning default.
      //    updated_at (the durable engine-control timestamp) doubles as the
      //    model-changed marker that /api/model/current keys off.
      if (epicId) {
        try {
          withDbWrite(db => db.prepare(
            `INSERT INTO lifecycle_execution_controls
               (epic_id, model_name, model_concurrency_limit, model_provider, model_effort)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(epic_id) DO UPDATE SET
               model_name=excluded.model_name,
               model_concurrency_limit=excluded.model_concurrency_limit,
               model_provider=excluded.model_provider,
               model_effort=excluded.model_effort,
               updated_at=datetime('now')`
          ).run(epicId, modelId, model.limit, provider, model.effort ?? null));
        } catch (e) {
          return respondJson(res, 500, { ok:false, error:'control write failed: ' + e.message });
        }
      }

      const note = provider === 'lmstudio'
        ? `LM Studio (${LMSTUDIO_URL}). settings.json switched to the LM Studio template (atomic + fsync). Cloud config frozen in settings.cloud.json. The whole machine routes to LM Studio until you switch back to a cloud model.`
        : 'settings.json switched to the cloud template (atomic + fsync). New workers will use this model. Active workers keep the old one.';
      respondJson(res, 200, { ok: true, model: modelId, provider, limit: model.limit, note });
    });
  }

  // LMSTUDIO_MODELS / LMSTUDIO_ONLINE are mutable `let`s that probeLmstudioModels()
  // reassigns. Exposing them as plain properties would snapshot the initial
  // values (false / []) at construction time and the UI / startup log would
  // never see updates. Use getters so modelApi.LMSTUDIO_MODELS always reflects
  // the live current state. ZAI_MODELS / lmstudioUrl are constants, so a plain
  // property is fine for them.
  return {
    handleModelsList,
    handleLmstudioModelsList,
    handleModelSet,
    probeLmstudioModels,
    ZAI_MODELS,
    lmstudioUrl: LMSTUDIO_URL,
    get LMSTUDIO_MODELS() { return LMSTUDIO_MODELS; },
    get LMSTUDIO_ONLINE() { return LMSTUDIO_ONLINE; },
  };
}
