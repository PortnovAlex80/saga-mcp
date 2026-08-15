/**
 * WorkplaceConformanceHarness — executable proof of the v4 E2E scenarios
 * (Conveyor v4 step 5.1).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY E2E-01..E2E-14 +
 * Conveyor Mental Model v4 §«Universal real-model conformance harness».
 *
 * # What this is
 *
 * A deterministic, in-memory harness that drives a Workplace through its full
 * lifecycle using the pure-domain reducer (step 2.2) and the SQLite stores
 * (step 1.2). It asserts durable protocol facts — NOT the wording of model
 * output. Every E2E-* scenario in the registry maps to one test here.
 *
 * # Why a harness, not just unit tests
 *
 * The unit tests (workplace-domain.test.mjs, production-cell-reducer.test.mjs)
 * prove individual transitions. The harness proves the SEQUENCE — that a full
 * author → gate → review → repair cycle converges, that crash/recovery
 * preserves continuity, and that Kanban never rolls back to `todo` on
 * technical failure.
 *
 * # Determinism
 *
 * The harness uses an in-memory SQLite DB with the full SCHEMA_SQL applied.
 * No real LM, no real process, no real clock. Fault injection is deterministic
 * (the harness passes specific events at specific points). A real-model run
 * (E2E-14) replaces the event injector with a real driver but keeps the same
 * assertions.
 */

import type Database from 'better-sqlite3';
import {
  reduceWorkplaceEvent,
  type ProductionCellEvent,
  type WorkplaceRef,
  type WorkplaceState,
} from '../../process-modules/domain/workplace/index.js';
import { SqliteWorkplaceRepository } from '../../infrastructure/workplace/sqlite-workplace-repository.js';
import { projectWorkItem } from '../../infrastructure/projections/work-item-projector.js';

/**
 * One conformance scenario run. The harness records the full state sequence
 * so the test can assert on intermediate states, not just the final one.
 */
export interface ConformanceRun {
  readonly ref: WorkplaceRef;
  /** Every state the workplace passed through, in order. */
  readonly states: readonly WorkplaceState[];
  /** The final state. */
  readonly finalState: WorkplaceState;
  /** The WorkItem projection at the end of the run. */
  readonly finalProjection: ReturnType<typeof projectWorkItem> extends infer T ? Exclude<T, null> : never;
}

/**
 * Drive a Workplace through a scripted event sequence. Each event is applied
 * to the reducer, and the resulting state is persisted via the repository
 * (CAS on revision). The full state history is returned for assertions.
 *
 * Throws on any NO_TRANSITION or CAS miss — a conformance scenario that hits
 * one is a protocol violation, not a passing test.
 */
export function runConformanceScenario(
  db: Database.Database,
  ref: WorkplaceRef,
  events: readonly ProductionCellEvent[],
): ConformanceRun {
  const repo = new SqliteWorkplaceRepository(db);
  // Materialize the workplace if it does not exist yet.
  repo.materialize(ref);

  const states: WorkplaceState[] = [repo.read(ref)!];
  for (const event of events) {
    const current = repo.read(ref);
    if (!current) throw new Error(`CONF: workplace disappeared mid-run at event ${event.kind}`);
    // Apply the pure-domain reducer.
    const next = reduceWorkplaceEvent(current, event);
    // Persist via CAS.
    const result = repo.applyTransition({
      workplaceRef: ref,
      expectedRevision: current.revision,
      kanbanPhase: next.kanbanPhase,
      loopState: next.loopState,
      nextRole: next.nextRole,
      terminalReason: next.terminalReason,
    });
    if (!result.applied) {
      throw new Error(
        `CONF: CAS miss at event ${event.kind} — expected rev ${current.revision}, got ${result.revision}`,
      );
    }
    states.push(result.state);
  }

  const finalState = repo.read(ref)!;
  const projection = projectWorkItem(db, ref);
  if (!projection) throw new Error('CONF: workplace has no projection after run');
  return {
    ref,
    states,
    finalState,
    finalProjection: projection,
  };
}
