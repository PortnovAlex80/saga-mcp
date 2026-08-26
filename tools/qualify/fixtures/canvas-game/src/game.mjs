/**
 * canvas-game/src/game.mjs - the small canvas game's deterministic core
 * (plan EK-11 P19): pure state transitions - the tick function and the
 * keyboard input handler the browser page wires to the canvas. The game
 * itself renders in the browser; THIS module is the testable game logic.
 */

export const KEYS = Object.freeze({ left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' });

/** The initial game state. */
export function initialState() {
  return { kind: 'canvas-game.state.v1', x: 50, y: 50, score: 0, collected: 0, target: { x: 10, y: 10 } };
}

/** Apply one keyboard input to a state (pure). */
export function applyInput(state, key) {
  switch (key) {
    case KEYS.left: return { ...state, x: Math.max(0, state.x - 10) };
    case KEYS.right: return { ...state, x: Math.min(100, state.x + 10) };
    case KEYS.up: return { ...state, y: Math.max(0, state.y - 10) };
    case KEYS.down: return { ...state, y: Math.min(100, state.y + 10) };
    default: return state;
  }
}

/** One game tick: collect the target when reached, respawn it deterministically. */
export function tick(state, tickIndex) {
  const reached = state.x === state.target.x && state.y === state.target.y;
  if (!reached) return state;
  /* deterministic respawn from the tick index (never the wall clock). */
  const next = ((tickIndex * 37) + 13) % 100;
  const target = { x: next - (next % 10), y: (100 - next) - ((100 - next) % 10) };
  return { ...state, score: state.score + 10, collected: state.collected + 1, target };
}
