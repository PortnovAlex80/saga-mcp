// log-tail.mjs — файловая телеметрия воркеров (mtime, tok/s, хвост JSONL).
//
// Паттерны скопированы (read-only) из tracker-view/lifecycle-endpoints.mjs
// (/api/workers/active + /api/worker/tail): хвост файла читается ограниченным
// буфером (до 2 МБ), usage берётся из последнего assistant/result события
// (кумулятивные счётчики API, НЕ сумма thinking_tokens).
//
// Контейnement: читаем только логи под разрешёнными корнями
// (env CORE_VIEW_LOG_ROOT + платформенный ~/.zcode/cli/board-runs и его
// родитель ~/.zcode/cli) — защита от traversal по путям из БД.

import { existsSync, openSync, readSync, closeSync, statSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ALLOWED_LOG_ROOTS = [...new Set(
  [
    process.env.CORE_VIEW_LOG_ROOT || null,
    path.join(os.homedir(), '.zcode', 'cli', 'board-runs'),
    path.join(os.homedir(), '.zcode', 'cli'),
  ].filter(Boolean).map(root => path.resolve(root)),
)];

/** Проверка процесса без его остановки (копия isProcessAlive из
 *  dist/worker-executions.js: signal 0; EPERM на Windows = процесс жив). */
export function isProcessAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Канонический абсолютный путь, если он лежит под разрешённым корнем логов,
 *  иначе null (файл не существует / вне корней / traversal). */
export function canonicalAllowedLogPath(requestedPath) {
  if (!requestedPath || typeof requestedPath !== 'string') return null;
  let resolved;
  try {
    resolved = path.resolve(requestedPath);
    if (!existsSync(resolved)) return null;
  } catch { return null; }
  let canonical;
  try { canonical = realpathSync(resolved); } catch { return null; }
  for (const root of ALLOWED_LOG_ROOTS) {
    if (!existsSync(root)) continue;
    let canonicalRoot;
    try { canonicalRoot = realpathSync(root); } catch { continue; }
    const rel = path.relative(canonicalRoot, canonical);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
      return canonical;
    }
  }
  return null;
}

/** { size, mtimeMs } либо null, если файл недоступен. */
export function statLog(logPath) {
  const canonical = canonicalAllowedLogPath(logPath);
  if (!canonical) return null;
  try {
    const st = statSync(canonical);
    return { size: st.size, mtimeMs: st.mtimeMs, path: canonical };
  } catch { return null; }
}

/** Хвост файла как массив сырых строк (без пустых), максимум maxBytes от конца. */
export function readTailLines(logPath, maxBytes = 2 * 1024 * 1024) {
  const canonical = canonicalAllowedLogPath(logPath);
  if (!canonical) return null;
  try {
    const st = statSync(canonical);
    const readBytes = Math.min(st.size, maxBytes);
    const fd = openSync(canonical, 'r');
    const buf = Buffer.alloc(readBytes);
    readSync(fd, buf, 0, readBytes, Math.max(0, st.size - readBytes));
    closeSync(fd);
    return buf.toString('utf8').split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

/** tok/s по JSONL-логу: кумулятивный usage последнего assistant/result
 *  события, делённый на время с startedAtMs. null — если лога нет или
 *  счётчиков не найдено. Паттерн /api/workers/active. */
export function computeTokPerSec({ logPath, startedAtMs }) {
  const lines = readTailLines(logPath, 2 * 1024 * 1024);
  if (!lines) return null;
  let resultOutput = null;
  let lastAssistantOutput = null;
  let thinkingSum = 0;
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (evt.type === 'result' && evt.usage) {
        resultOutput = evt.usage.output_tokens ?? resultOutput;
      }
      if (evt.type === 'assistant' && evt.message?.usage) {
        const u = evt.message.usage;
        if (u.output_tokens != null && u.output_tokens > 0) {
          lastAssistantOutput = u.output_tokens;
        }
      }
      if (evt.type === 'system' && evt.subtype === 'thinking_tokens') {
        thinkingSum += evt.estimated_tokens || 0;
      }
    } catch { /* не-JSON строка — пропускаем */ }
  }
  const outputTokens = resultOutput ?? lastAssistantOutput ?? (thinkingSum > 0 ? thinkingSum : null);
  if (outputTokens == null || outputTokens <= 0) return null;
  if (!startedAtMs || !Number.isFinite(startedAtMs)) return null;
  const elapsedSec = Math.max(1, (Date.now() - startedAtMs) / 1000);
  return Math.round(outputTokens / elapsedSec * 10) / 10;
}

function truncate(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Одна строка JSONL → массив записей { ts, level, text }. У assistant-сообщения
 *  может быть несколько блоков (мысль + tool_use + текст) — отдаём каждый,
 *  чтобы терминал показывал внутренний монолог модели. JSON.parse с fallback
 *  на сырую строку (SPEC: cell.logTail.lines). */
function jsonlLineToEntries(raw) {
  let evt = null;
  try { evt = JSON.parse(raw); } catch { /* raw line */ }
  if (!evt || typeof evt !== 'object') {
    return [{ ts: null, level: 'raw', text: truncate(raw, 160) }];
  }
  const ts = evt.timestamp ?? evt.ts ?? null;
  if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
    const out = [];
    for (const block of evt.message.content) {
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        out.push({ ts, level: 'thinking', text: truncate(block.thinking, 200) });
      } else if (block.type === 'tool_use') {
        out.push({ ts, level: 'tool', text: truncate(`tool ${block.name} ${JSON.stringify(block.input || {})}`, 160) });
      } else if (block.type === 'text' && typeof block.text === 'string') {
        out.push({ ts, level: 'info', text: truncate(block.text, 160) });
      }
    }
    if (out.length === 0) return [{ ts, level: 'info', text: 'assistant (empty content)' }];
    return out;
  }
  if (evt.type === 'user' && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_result') {
        const c = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
        return [{ ts, level: 'info', text: truncate(`result ${c}`, 160) }];
      }
    }
    return [{ ts, level: 'info', text: 'user message' }];
  }
  if (evt.type === 'system') {
    return [{ ts, level: 'system', text: truncate(`system/${evt.subtype || '?'}`, 160) }];
  }
  if (evt.type === 'result') {
    return [{
      ts, level: 'result',
      text: truncate(`result ${evt.subtype || ''} turns=${evt.num_turns ?? '?'} cost=${evt.total_cost_usd ?? '?'}`, 160),
    }];
  }
  return [{ ts, level: 'info', text: truncate(evt.type || 'unknown', 160) }];
}

/** Последние maxLines записей JSONL-лога как { lines: [...] } | null. */
export function tailJsonl(logPath, maxLines = 40) {
  const lines = readTailLines(logPath, 256 * 1024);
  if (!lines) return null;
  const tail = lines.slice(-maxLines * 3).flatMap(jsonlLineToEntries).slice(-maxLines);
  return { lines: tail };
}
