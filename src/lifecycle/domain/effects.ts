/**
 * Effect intents — closed discriminated union.
 *
 * Source: blueprint §8 (docs/architecture/passive-worker-kernel-blueprint.md:405-419).
 *
 * Effects are declarative. The reducer emits them; the shell (outbox relay)
 * executes them — spawn a worker process, run a Git merge, send a human
 * notification, generate downstream workflow tasks. Effects carry NO
 * callbacks and NO arbitrary code (blueprint §8:417). External and retryable
 * effects go to the outbox (blueprint §8:418).
 *
 * Kinds are FROZEN. Renaming requires a vocabulary update + ADR.
 *
 * Pure TS. No imports from SQLite, Node, tools, or tracker-view.
 */

import type {
  ExecutionId,
  HumanRequestId,
  IntegrationId,
} from './ids.js';

export type EffectIntent =
  | { readonly kind: 'worker.spawn'; readonly executionId: ExecutionId }
  | { readonly kind: 'worker.terminate'; readonly executionId: ExecutionId }
  | { readonly kind: 'integration.execute'; readonly integrationId: IntegrationId }
  | { readonly kind: 'human.notify'; readonly requestId: HumanRequestId }
  | { readonly kind: 'workflow.generate'; readonly sourceTaskId: number }
  | { readonly kind: 'dependencies.reconcile'; readonly taskId: number };
