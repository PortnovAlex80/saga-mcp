// Cross-cutting helpers extracted from tracker-view.mjs (T10 step 1).
//
// These are leaf utilities with no dependency on the other new modules. The DB
// helpers (withDb / withDbWrite) need two pieces of runtime state that still
// belong to the composition root in tracker-view.mjs: the resolved DB_PATH and
// the better-sqlite3 constructor. They are injected once via initShared(); the
// pure helpers (parseTs, ageClass, esc, ...) work without any initialization.
//
// DB_PATH deliberately stays declared in tracker-view.mjs — it is a test anchor
// there). This module holds only a private mirror used by withDb/withDbWrite.
import {
  existsSync, readdirSync, readFileSync, realpathSync,
} from 'node:fs';
import path from 'node:path';

// --- Injected runtime state -------------------------------------------------
// Populated by initShared(). Kept module-private; consumers call the exported
// withDb/withDbWrite wrappers, never these directly.
let _dbPath = null;
let _Database = null;
let _workerLogRoots = [];

export function initShared({ dbPath, Database, workerLogRoots }) {
  _dbPath = dbPath;
  _Database = Database;
  _workerLogRoots = Array.isArray(workerLogRoots) ? workerLogRoots : [];
}

// --- Constants --------------------------------------------------------------
// Hardcoded development root + project → repo folder map. Used by
// resolveArtifactFile / resolveProjectWorkspace. Copied verbatim from the
// monolith (same values, same names).
export const DEV_ROOT = 'D:/Development';
export const PROJECT_REPO_MAP = {
  granite: ['Stone'],
  Geosophia: ['geosophia'],
  TestLasGPU: ['TestLasGPU'],
  'kickstart-impl': ['Harmess', 'saga-mcp'],
  'deposit-calc-simple': ['Harmess', 'deposit-calc-simple'],
  requirements: ['Harmess'],
  'ODN-MVP': ['GDesign', 'Harmess'],
  harmess: ['Harmess'],
  femdriver: ['femdriver'],
  GazPenetration: ['GazPenetration'],
};

// WORKER_LOG_ROOTS is computed in tracker-view.mjs from runtimeConfig (it is
// also a test-referenced symbol). The monolith keeps the canonical array; this
// module exposes a getter so canonicalAllowedWorkerLogPath can stay self-
// contained without re-deriving it.
export function getWorkerLogRoots() { return _workerLogRoots; }

// --- DB helpers (одна общая БД, read-only, открываем на каждый запрос —
//     overhead минимален, зато всегда свежие данные и нет гонок с saga-MCP) ---
export function withDb(fn) {
  const db = new _Database(_dbPath, { readonly: true, timeout: 2000 });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// Read-write соединение для save-handler. WAL-режим БД saga-mcp позволяет
// конкурентную запись (один писатель + много читателей) — безопасно с saga-MCP.
export function withDbWrite(fn) {
  const db = new _Database(_dbPath, { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// --- Time helpers -----------------------------------------------------------
// Парсинг timestamp из БД saga. SQLite `datetime('now')` возвращает **UTC** в
// формате 'YYYY-MM-DD HH:MM:SS' (без T, без Z). Старый комментарий утверждал,
// что это локальное время — НЕВЕРНО; именно это заблуждение и плодит tz-баги
// (на UTC+3 распарсенный timestamp уезжает на -3ч, возрасты растут на 180 мин).
// Поэтому нормализуем в ISO с Z и парсим как UTC. Уже-ISO значения (с T/Z)
// проходят как есть.
export function parseTs(iso) {
  if (!iso) return null;
  let s = String(iso);
  if (s.indexOf('T') < 0) s = s.replace(' ', 'T');
  if (s.indexOf('Z') < 0 && /[+-]\d\d:?\d\d$/.test(s) === false) s += 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}
// Возраст timestamp'а → класс кружка (green/yellow/red)
export function ageClass(iso) {
  const t = parseTs(iso);
  if (t === null) return 'red';
  const ago = Math.floor((Date.now() - t) / 1000);
  if (ago < 15) return 'green';
  if (ago < 60) return 'yellow';
  return 'red';
}
export function ageText(iso) {
  const t = parseTs(iso);
  if (t === null) return '?';
  const ago = Math.floor((Date.now() - t) / 1000);
  if (ago < 60) return ago + 'с';
  if (ago < 3600) return Math.floor(ago / 60) + 'м';
  return Math.floor(ago / 3600) + 'ч';
}

// --- HTML / markdown helpers ------------------------------------------------
export function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

export function inTableHasHeader(htmlTail) { return /<\/th>/.test(htmlTail.slice(-200)); }

// Извлечь первый <div class="<cls>">…</div> по балансу тегов (надёжнее regex при
// глубокой вложенности — .episodes содержит много вложенных </div>).
// Возвращает подстроку включая открывающий/закрывающий тег, или '' если не найден.
export function extractDiv(html, cls) {
  const open = html.indexOf(`<div class="${cls}">`);
  if (open < 0) return '';
  let depth = 0, i = open;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = open;
  let m;
  while ((m = re.exec(html)) !== null) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index + m[0].length);
  }
  return '';
}

export function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// --- HTTP helpers -----------------------------------------------------------
export function respondJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function readRequestFields(req, callback) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const contentType = req.headers['content-type'] || '';
    try {
      const fields = contentType.includes('application/json')
        ? JSON.parse(raw || '{}')
        : Object.fromEntries(new URLSearchParams(raw));
      callback(null, fields);
    } catch (error) {
      callback(error);
    }
  });
}

export function readJsonRequest(req, callback) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let fields;
    try { fields = JSON.parse(raw); } catch { fields = {}; }
    callback(fields);
  });
}

// --- Worker log path validation --------------------------------------------
// Returns the canonical absolute path if it lives under one of the configured
// WORKER_LOG_ROOTS, else null. Defends against path traversal in /api/worker/tail.
export function canonicalAllowedWorkerLogPath(requestedPath) {
  if (!requestedPath) return null;
  const resolved = path.resolve(requestedPath);
  if (!existsSync(resolved)) return null;
  const canonical = realpathSync(resolved);
  for (const configuredRoot of _workerLogRoots) {
    if (!existsSync(configuredRoot)) continue;
    const canonicalRoot = realpathSync(configuredRoot);
    const relative = path.relative(canonicalRoot, canonical);
    if (relative === '' || (
      relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    )) return canonical;
  }
  return null;
}

// --- Project workspace / artifact file resolution --------------------------
// Конвенция folder:тега ненадёжна (проекты с артефактами его не имеют),
// поэтому map строим по факту где docs/requirements/<epic> реально существует.
// PROJECT_REPO_MAP — hardcoded приоритеты; resolveArtifactFile обходит кандидатов.
export function projectFolderTag(project) {
  try {
    const tags = JSON.parse(project.tags || '[]');
    const tag = tags.find(value => typeof value === 'string' && value.startsWith('folder:'));
    return tag ? tag.slice('folder:'.length) : null;
  } catch {
    return null;
  }
}

export function resolveProjectWorkspace(project) {
  const candidates = [];
  const folderTag = projectFolderTag(project);
  if (folderTag) candidates.push(path.join(DEV_ROOT, folderTag));
  for (const folder of PROJECT_REPO_MAP[project.name] || []) {
    candidates.push(path.join(DEV_ROOT, folder));
  }
  candidates.push(path.join(DEV_ROOT, project.name));

  return candidates.find(candidate => existsSync(candidate)) || null;
}

// Найти физический путь к .md файлу артефакта.
// path в БД может быть 'docs/.../01-SRS.md#FR-1' — якорь отбрасываем.
// Возвращает { abs, projectRoot } или null если файл не существует.
export function resolveArtifactFile(artifactPath, projectName, repositoryPath = null) {
  const cleanPath = artifactPath.split('#')[0];
  // Workers sometimes write absolute paths (D:\Development\moscito\docs\...md)
  // despite the skill template saying 'docs/...'. On Windows, path.join with
  // an absolute second arg produces garbage like:
  //   D:\Development\moscito\D:Developmentmoscitodocs...md
  // Detect absolute paths and use them directly instead of joining with root.
  // This is a defensive fix — the proper fix is in artifact_create handler
  // (src/tools/artifacts.ts) which normalises absolute → relative at write time.
  const looksAbsolute = /^([A-Za-z]:[\\/]|[\\/]|\\\\[^?])/.test(cleanPath);
  if (looksAbsolute) {
    return existsSync(cleanPath)
      ? { abs: cleanPath, projectRoot: path.dirname(cleanPath) }
      : null;
  }
  const candidates = [];
  if (repositoryPath) candidates.push(repositoryPath);
  const map = PROJECT_REPO_MAP[projectName] || [];
  for (const sub of map) candidates.push(path.join(DEV_ROOT, sub));
  // Fallback: если проекта нет в map, ищем по имени в DEV_ROOT
  if (!map.length) candidates.push(path.join(DEV_ROOT, projectName));
  for (const root of candidates) {
    const abs = path.join(root, cleanPath);
    if (existsSync(abs)) return { abs, projectRoot: root };
  }
  return null;
}
