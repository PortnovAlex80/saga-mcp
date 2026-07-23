import type { LegacySaga2Runner } from '../../application/ports/legacy-saga2-runtime.js';
import { orchestrate } from '../../orchestrate.js';

/** Concrete infrastructure bridge to the stable Saga 2 orchestration pump. */
export const runLegacySaga2: LegacySaga2Runner = invocation =>
  orchestrate(invocation);
