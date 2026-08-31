#!/usr/bin/env node
// Дымовая проверка статического веб-приложения: «программа запускается».
//
// Завод не имеет права считать продукт готовым по обещанию модели. Здесь
// проверяется то, что можно проверить без браузера и без сети:
//   1) index.html существует и содержит корень документа;
//   2) все локальные ссылки (script src / link href / img src) ведут на
//      существующие файлы;
//   3) каждый локальный .js синтаксически корректен (node --check);
//   4) каждый локальный .css непуст.
//
// Вывод пишется в stdout/stderr и при отказе целиком уезжает в причину гейта,
// то есть возвращается воркеру в следующую попытку.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? process.cwd();
const problems = [];
const checked = [];

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

const indexPath = findIndex(root);
if (!indexPath) {
  console.error('index.html не найден — запускать нечего');
  process.exit(1);
}

const html = readFileSync(indexPath, 'utf8');
const base = path.dirname(indexPath);
checked.push(path.relative(root, indexPath).replace(/\\/g, '/'));

if (!/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) {
  problems.push(`${path.basename(indexPath)}: нет корня документа (<html> / <body>)`);
}

const refs = new Set();
for (const re of [/<script[^>]+src=["']([^"']+)["']/gi, /<link[^>]+href=["']([^"']+)["']/gi, /<img[^>]+src=["']([^"']+)["']/gi]) {
  for (const match of html.matchAll(re)) refs.add(match[1]);
}

for (const ref of refs) {
  if (/^(https?:|data:|#|\/\/|mailto:)/i.test(ref)) continue;
  const target = path.join(base, ref.split(/[?#]/)[0]);
  if (!existsSync(target)) {
    problems.push(`${ref}: файл не найден, но подключён в index.html`);
    continue;
  }
  const relative = path.relative(root, target).replace(/\\/g, '/');
  checked.push(relative);
  if (target.endsWith('.js')) {
    try {
      execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    } catch (error) {
      const detail = String(error.stderr ?? error.message).split('\n').slice(0, 6).join('\n');
      problems.push(`${relative}: синтаксическая ошибка JavaScript\n${detail}`);
    }
  } else if (target.endsWith('.css') && statSync(target).size === 0) {
    problems.push(`${relative}: пустой CSS`);
  }
}

if (problems.length > 0) {
  console.error(`Приложение не запускается, ${problems.length} проблем(ы):`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(`OK: приложение собрано и запускается. Проверено файлов: ${checked.length}`);
for (const file of checked) console.log(`- ${file}`);
