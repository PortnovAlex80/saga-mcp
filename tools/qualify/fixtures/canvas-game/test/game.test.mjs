/**
 * canvas-game/test/game.test.mjs - unit verification (node:test): the
 * deterministic game core - input handling, bounds, collection, respawn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyInput, tick, KEYS } from '../src/game.mjs';

test('keyboard inputs move the player within bounds', () => {
  const state = initialState();
  const moved = applyInput(applyInput(applyInput(state, KEYS.left), KEYS.left), KEYS.left);
  assert.equal(moved.x, 20);
  const floored = applyInput({ ...state, x: 0 }, KEYS.left);
  assert.equal(floored.x, 0);
  const walled = applyInput({ ...state, x: 100 }, KEYS.right);
  assert.equal(walled.x, 100);
});

test('reaching the target collects it and respawns deterministically', () => {
  let state = initialState();
  for (const key of [KEYS.left, KEYS.left, KEYS.left, KEYS.left, KEYS.up, KEYS.up, KEYS.up, KEYS.up]) state = applyInput(state, key);
  assert.deepEqual({ x: state.x, y: state.y }, { x: 10, y: 10 });
  const ticked = tick(state, 1);
  assert.equal(ticked.score, 10);
  assert.equal(ticked.collected, 1);
  assert.deepEqual(ticked.target, { x: 50, y: 50 }, 'tick 1 respawns at ((1*37+13)%100 floor rule)');
});

test('the core is deterministic: identical input chains produce identical states', () => {
  const drive = () => {
    let state = initialState();
    for (let index = 0; index < 50; index += 1) {
      state = applyInput(state, [KEYS.left, KEYS.right, KEYS.up, KEYS.down][index % 4]);
      state = tick(state, index);
    }
    return state;
  };
  assert.deepEqual(drive(), drive());
});
