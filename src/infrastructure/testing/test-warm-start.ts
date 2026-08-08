/**
 * RETIRED compatibility surface.
 *
 * Saga4 has exactly one production/reuse mechanism: normal Factory execution
 * with replay-first certified capsules. The former test-warm-start sidecar
 * restored mutable draft files before a worker ran and captured them after it
 * exited. Even though it did not directly advance Gates, it created a second
 * test-only production path whose semantics were outside ReplayKey,
 * CandidateSet certification and cross-run provenance.
 *
 * The worker factory still imports these symbols during the cutover, so this
 * module intentionally remains as a no-op compatibility shim until those
 * imports are removed in a later mechanical cleanup. Enabling the old
 * SAGA_TEST_WARM_START environment variables has no effect.
 *
 * Do NOT add behavior here. Deterministic conformance uses pre-certified
 * ReplayCapsules as input data and the normal Factory Start.
 */

import type { WorkplaceDesk } from '../../process-modules/application/pinned-workspace-materializer.js';

export type TestWarmStartCaptureOutcome =
  | 'completed'
  | 'changes_requested'
  | 'failed';

export interface ApplyTestWarmStartRequest {
  readonly env: NodeJS.ProcessEnv;
  readonly workspaceRoot: string;
  readonly epicId: number;
  readonly moduleRef: string;
  readonly nodeId: string;
  readonly packageDigest?: string | null;
  readonly inputHash?: string | null;
  readonly processWorkspace: WorkplaceDesk;
}

/**
 * Compatibility no-op. Certified replay is the only legal reuse mechanism.
 */
export function applyTestWarmStart(
  request: ApplyTestWarmStartRequest,
): WorkplaceDesk {
  return request.processWorkspace;
}

/**
 * Compatibility no-op. Worker drafts are never learned into a parallel cache.
 */
export function captureTestWarmStart(
  _workspaceRoot: string,
  _processWorkspace: WorkplaceDesk | null,
  _outcome: TestWarmStartCaptureOutcome,
): void {
  // Intentionally empty. See module-level invariant above.
}
