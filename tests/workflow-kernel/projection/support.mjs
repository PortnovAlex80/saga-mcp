/**
 * support.mjs - shared WP-10 test support: fresh kernel databases, the
 * conveyor scenario options, the projection store/projector wiring and the
 * role-contract runtime for the UI adapter tests. Mirrors the WP-09 driver
 * discipline: every helper reads and writes only kernel public surfaces.
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { openKernelDatabase } = await import('../../../dist/workflow-kernel/persistence/database.js');
const { KernelPersistenceSession } = await import('../../../dist/workflow-kernel/persistence/session.js');
const { FaultScheduler } = await import('../../../dist/workflow-kernel/application/faults.js');
const conveyor = await import('../../../dist/workflow-kernel/planning/conveyor.js');
const { KanbanCardStore } = await import('../../../dist/workflow-kernel/projection/store.js');
const projection = await import('../../../dist/workflow-kernel/projection/index.js');

export function freshDatabase(prefix = 'ek-wp10-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, 'kernel.sqlite');
  return { path, dir, open: () => new KernelPersistenceSession(openKernelDatabase(path)) };
}

/** Fresh session + its Kanban projection store over one disposable database. */
export function freshProjection(prefix) {
  const db = freshDatabase(prefix);
  const open = () => {
    const session = db.open();
    return { session, store: new KanbanCardStore(session.db) };
  };
  return { ...db, open };
}

export const observingOptions = () => ({ ...conveyor.conveyorDefaults(), faults: FaultScheduler.observing() });

/** The authoritative normalized trace of a session (events in sequence order). */
export function normalizedTrace(session) {
  const world = session.hydrateWorld().world;
  return world.events.map((event) => ({
    sequence: event.sequence,
    kind: event.kind,
    sourceOwner: event.sourceOwner,
    sourceInstanceId: event.sourceInstanceId,
    transition: event.transition,
    evidenceRefs: [...event.evidenceRefs],
  }));
}

/** The authoritative terminal proofs of a session (id, scope, owner, closure). */
export function terminalProofs(session) {
  return session.hydrateWorld().world.proofs.map((proof) => ({
    id: proof.id,
    scope: proof.scope,
    ownerAggregate: proof.ownerAggregate,
    ownerInstanceId: proof.ownerInstanceId,
    evidenceClosure: [...proof.evidenceClosure].sort(),
  }));
}

/**
 * Drive the full independent topology to the run terminal proof (the WP-09
 * conveyor composition - the public command path, no board reads).
 */
export function driveIndependentTopology(session, options) {
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology('independent'), options);
  const cells = [];
  const authored = conveyor.cellsForTopology('independent');
  for (const descriptor of authored) {
    const cell = conveyor.enterCell(session, descriptor, options);
    conveyor.admitCellIntent(session, cell, conveyor.dependencyRowsOf(session), options);
    conveyor.runDesk(session, cell, 'success', options);
    conveyor.settleCellNode(session, ids, cell, options);
    cells.push(cell);
  }
  conveyor.settleSuccessLadder(session, ids, options);
  return { ids, cells };
}

export { conveyor, projection };
