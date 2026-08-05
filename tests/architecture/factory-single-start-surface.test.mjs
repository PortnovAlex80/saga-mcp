import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('factory exposes one HTTP start route and runtime host accepts launch capability only', () => {
  const routes = readFileSync('tracker-view/tracker-view.mjs', 'utf8');
  const activePostRoutes = [...routes.matchAll(
    /req\.method === 'POST' && url\.pathname === '([^']+)'/g,
  )].map(match => match[1]);
  assert.ok(activePostRoutes.includes('/api/factory/start'));
  assert.ok(!activePostRoutes.includes('/api/engine/start'));
  assert.ok(!activePostRoutes.includes('/api/engine/restart'));
  assert.ok(!activePostRoutes.includes('/api/project/create-from-idea'));

  const host = readFileSync('src/orchestrate-cli.ts', 'utf8');
  const parseBody = /function parseArgs[\s\S]*?\r?\n}/.exec(host)?.[0] ?? '';
  assert.match(parseBody, /--launch-ref/);
  assert.doesNotMatch(parseBody, /--resume|--lifecycle-input|idempotency-key/);
});

test('factory start skill requires an explicit four-way mode choice', () => {
  const skill = readFileSync('skills/saga-start/SKILL.md', 'utf8');
  for (const marker of [
    '1. Resume существующего заказа',
    '2. Новый production-заказ',
    '3. Тест без LLM — checkpoint replay',
    '4. Тест с реальной LLM — warm start',
  ]) assert.ok(skill.includes(marker), marker);
  assert.match(skill, /До записи в БД[\s\S]*покажи пользователю этот список/);
  assert.match(skill, /not_run[\s\S]*productionEligible=false/);
});
