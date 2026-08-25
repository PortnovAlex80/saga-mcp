/**
 * support.mjs - shared WP-09 test support: fresh kernel databases, conveyor
 * options and world helpers. Mirrors the WP-07 driver discipline: every
 * helper reads only kernel public surfaces.
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { openKernelDatabase } = await import('../../../dist/workflow-kernel/persistence/database.js');
const { KernelPersistenceSession } = await import('../../../dist/workflow-kernel/persistence/session.js');
const { FaultScheduler } = await import('../../../dist/workflow-kernel/application/faults.js');
const conveyor = await import('../../../dist/workflow-kernel/planning/conveyor.js');

export function freshDatabase(prefix = 'ek-wp09-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, 'kernel.sqlite');
  return { path, dir, open: () => new KernelPersistenceSession(openKernelDatabase(path)) };
}

export const observingOptions = () => ({ ...conveyor.conveyorDefaults(), faults: FaultScheduler.observing() });

export const worldOf = (session, externalEvidence) =>
  session.hydrateWorld(externalEvidence === undefined ? undefined : { externalEvidence }).world;

export const proofIdsOf = (session, externalEvidence) => worldOf(session, externalEvidence).proofs.map((proof) => proof.id);

export const headOf = (session, instanceId) => worldOf(session).heads.get(instanceId);

/** Drive a full SUCCESS topology scenario (used by readiness/observed suites). */
export function driveSuccessTopology(session, topology, options) {
  const ids = conveyor.bootstrapVertical(session, conveyor.factsForTopology(topology), options);
  const cells = [];
  const authored = conveyor.cellsForTopology(topology);
  for (let i = 0; i < authored.length; i += 1) {
    const cell = conveyor.enterCell(session, authored[i], options);
    const admission = conveyor.admitCellIntent(session, cell, conveyor.dependencyRowsOf(session), options);
    cells.push({ ...cell, readiness: admission.readiness });
    conveyor.runDesk(session, cell, 'success', options);
    conveyor.settleCellNode(session, ids, cell, options);
  }
  conveyor.settleSuccessLadder(session, ids, options);
  return { ids, cells };
}
