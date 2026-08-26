/* canvas-game/public/game.js - the browser game wiring: keyboard input
   drives the deterministic core (src/game.mjs compiled copy embedded below
   as GAME) and renders state onto the canvas each animation frame. */
const GAME = {
  KEYS: { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' },
  initialState() { return { x: 50, y: 50, score: 0, collected: 0, target: { x: 10, y: 10 } }; },
  applyInput(state, key) {
    switch (key) {
      case 'ArrowLeft': return { ...state, x: Math.max(0, state.x - 10) };
      case 'ArrowRight': return { ...state, x: Math.min(100, state.x + 10) };
      case 'ArrowUp': return { ...state, y: Math.max(0, state.y - 10) };
      case 'ArrowDown': return { ...state, y: Math.min(100, state.y + 10) };
      default: return state;
    }
  },
  tick(state, tickIndex) {
    const reached = state.x === state.target.x && state.y === state.target.y;
    if (!reached) return state;
    const next = ((tickIndex * 37) + 13) % 100;
    return { ...state, score: state.score + 10, collected: state.collected + 1, target: { x: next - (next % 10), y: (100 - next) - ((100 - next) % 10) } };
  },
};

let state = GAME.initialState();
let tickIndex = 0;

document.addEventListener('keydown', (event) => {
  if (Object.values(GAME.KEYS).includes(event.key)) {
    event.preventDefault();
    state = GAME.applyInput(state, event.key);
  }
});

const canvas = document.getElementById('board');
const context = canvas.getContext('2d');
const scoreElement = document.getElementById('score');

function render() {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#336';
  context.fillRect(state.target.x * 2, state.target.y * 2, 12, 12);
  context.fillStyle = '#c33';
  context.fillRect(state.x * 2, state.y * 2, 12, 12);
  scoreElement.textContent = `score: ${state.score}`;
}

function frame() {
  state = GAME.tick(state, tickIndex);
  tickIndex += 1;
  render();
  requestAnimationFrame(frame);
}

render();
requestAnimationFrame(frame);
