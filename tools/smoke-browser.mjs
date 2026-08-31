#!/usr/bin/env node
// Дымовая проверка В НАСТОЯЩЕМ БРАУЗЕРЕ: «страница не просто собрана — она
// работает».
//
// Статическая проверка (smoke-static.mjs) видит битые ссылки и синтаксис, но
// не видит главного класса дефектов параллельной разработки: два воркера
// договорились по-разному. Пойман живьём на Элите — hud.js экспортировал
// конструктор, а index.html ждал объект с методом init: оба файла корректны,
// ссылки целы, а HUD не появился.
//
// Поэтому здесь страница открывается в headless Chrome и проверяется то, что
// можно проверить честно и без знания предметной области:
//   1) нет необработанных ошибок и отказов загрузки;
//   2) на странице что-то НАРИСОВАНО (canvas не пуст) либо есть видимый текст;
//   3) объявленные контейнеры не остались пустыми;
//   4) объявленные глобальные модули существуют.
//
// Зависимостей нет: Chrome берётся установленный, разговор идёт по CDP через
// встроенный в Node WebSocket.
//
//   node smoke-browser.mjs <каталог> [--expect-globals A,B] [--expect-filled id,id]

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const root = path.resolve(process.argv[2] ?? process.cwd());
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? (process.argv[index + 1] ?? '') : '';
};
const expectGlobals = arg('--expect-globals').split(',').map((s) => s.trim()).filter(Boolean);
const expectFilled = arg('--expect-filled').split(',').map((s) => s.trim()).filter(Boolean);
const settleMs = Number(arg('--settle') || 2500);

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  return null;
}

function findIndex(dir, depth = 0) {
  if (depth > 3) return undefined;
  const direct = path.join(dir, 'index.html');
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue;
    const found = findIndex(path.join(dir, entry.name), depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Статический сервер: file:// ограничивает модули и fetch, поэтому страница
 *  проверяется так же, как её увидит пользователь — по http. */
function serve(dir) {
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const file = path.join(dir, rel === '/' ? 'index.html' : rel);
      if (!path.resolve(file).startsWith(path.resolve(dir)) || !existsSync(file)) {
        res.writeHead(404); res.end('not found'); return;
      }
      const { readFileSync } = await import('node:fs');
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function cdpTargets(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chrome не отдал отладочный порт');
}

const problems = [];
const notes = [];

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('Chrome не найден: задайте CHROME_BIN');
    process.exit(2);
  }
  const index = findIndex(root);
  if (!index) {
    console.error('index.html не найден — открывать нечего');
    process.exit(1);
  }
  const base = path.dirname(index);
  const { server, port } = await serve(base);
  const profile = mkdtempSync(path.join(tmpdir(), 'saga5-chrome-'));
  const debugPort = 9223 + Math.floor(Math.random() * 500);
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,800', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let socket;
  try {
    const target = await cdpTargets(debugPort);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });

    let id = 0;
    const pending = new Map();
    const consoleErrors = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const d = message.params?.exceptionDetails ?? {};
        consoleErrors.push(String(d.exception?.description ?? d.text ?? 'исключение'));
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        consoleErrors.push((message.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (message.method === 'Network.loadingFailed') {
        consoleErrors.push(`не загрузилось: ${message.params?.errorText ?? ''}`);
      }
    };
    const send = (method, params = {}) => new Promise((res) => {
      const messageId = ++id;
      pending.set(messageId, res);
      socket.send(JSON.stringify({ id: messageId, method, params }));
    });

    await send('Runtime.enable');
    await send('Network.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await new Promise((r) => setTimeout(r, settleMs));

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return result.result?.result?.value;
    };

    const report = await evaluate(`(() => {
      const canvases = [...document.querySelectorAll('canvas')].map((c) => {
        let painted = null;
        try {
          const ctx = c.getContext('2d');
          if (ctx) {
            const data = ctx.getImageData(0, 0, c.width, c.height).data;
            let lit = 0;
            for (let i = 0; i < data.length; i += 4 * 97) {
              if (data[i] || data[i+1] || data[i+2]) lit++;
            }
            painted = lit;
          }
        } catch { painted = null; }
        return { id: c.id, w: c.width, h: c.height, painted };
      });
      const text = (document.body.innerText || '').trim();
      return JSON.stringify({
        title: document.title,
        canvases,
        textLength: text.length,
        scripts: [...document.querySelectorAll('script[src]')].map((s) => s.src),
        empties: [...document.querySelectorAll('[id]')]
          .filter((el) => el.children.length === 0 && !el.textContent.trim() && el.tagName !== 'CANVAS'
            && !['SCRIPT','LINK','META','BR','INPUT','IMG'].includes(el.tagName))
          .map((el) => el.id),
      });
    })()`);
    const page = JSON.parse(report ?? '{}');

    if (consoleErrors.length > 0) {
      problems.push(`ошибок в консоли: ${consoleErrors.length}`);
      for (const error of consoleErrors.slice(0, 5)) problems.push(`  ${error.slice(0, 300)}`);
    }

    const painted = page.canvases.filter((c) => (c.painted ?? 0) > 0);
    if (page.canvases.length > 0 && painted.length === 0) {
      problems.push('на canvas ничего не нарисовано — страница открылась пустой');
    }
    if (page.canvases.length === 0 && page.textLength < 20) {
      problems.push('страница пуста: ни canvas, ни текста');
    }

    // Общее правило вместо настройки под продукт: если КОД обращается к
    // контейнеру, а контейнер после загрузки пуст — модуль не подключился.
    // Именно так выглядит расхождение контрактов между двумя воркерами:
    // оба файла корректны, ссылки целы, а на экране ничего нет.
    if (page.empties.length > 0 && page.scripts.length > 0) {
      const sources = await evaluate(`(async () => {
        const out = [];
        for (const src of ${JSON.stringify(page.scripts)}) {
          try { out.push(await (await fetch(src)).text()); } catch { /* пропускаем */ }
        }
        return out.join('\\n');
      })()`);
      for (const id of page.empties) {
        if (typeof sources === 'string' && sources.includes(`'${id}'`) || (typeof sources === 'string' && sources.includes(`"${id}"`))) {
          problems.push(`код обращается к #${id}, но после загрузки контейнер пуст — модуль не подключился`);
        }
      }
    }

    for (const global of expectGlobals) {
      const exists = await evaluate(`typeof window[${JSON.stringify(global)}] !== 'undefined'`);
      if (!exists) problems.push(`обещанный модуль window.${global} не появился`);
    }
    for (const id of expectFilled) {
      const filled = await evaluate(
        `(() => { const el = document.getElementById(${JSON.stringify(id)});
          return !!el && (el.children.length > 0 || !!el.textContent.trim()); })()`
      );
      if (!filled) problems.push(`контейнер #${id} остался пустым — модуль не подключился`);
    }

    notes.push(`заголовок: ${page.title || '(нет)'}`);
    notes.push(`canvas: ${page.canvases.length}, из них с рисунком: ${painted.length}`);
    notes.push(`текста на странице: ${page.textLength} симв.`);
    if (page.empties.length > 0) notes.push(`пустые контейнеры: ${page.empties.join(', ')}`);
  } finally {
    try { socket?.close(); } catch { /* уже закрыт */ }
    child.kill();
    server.close();
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* временный */ }
  }

  if (problems.length > 0) {
    console.error('Страница открылась, но работает неправильно:');
    for (const problem of problems) console.error(`- ${problem}`);
    for (const note of notes) console.error(`  ${note}`);
    process.exit(1);
  }
  console.log('OK: страница открывается в Chrome и работает.');
  for (const note of notes) console.log(`- ${note}`);
}

main().catch((error) => {
  console.error(`Проверка в браузере не выполнена: ${error.message}`);
  process.exit(2);
});
