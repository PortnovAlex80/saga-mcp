import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('tracker is a read-only observer and controller owns boot recovery', () => {
  const tracker = readFileSync('tracker-view/tracker-view.mjs', 'utf8');
  const controller = readFileSync('src/orchestrate-cli.ts', 'utf8');

  assert.doesNotMatch(tracker, /runFactoryBootRevision|engine-start-adoption|lifecycle-burial/);
  assert.match(controller, /runFactoryBootRevision\(getDb\(\)\)/);
  assert.match(controller, /assertFactoryControllerFence[\s\S]*runFactoryBootRevision/);
});
