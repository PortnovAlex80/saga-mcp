import type Database from 'better-sqlite3';
import {
  asModuleInstallationId,
  type ModuleInstallationId,
  type PinnedInstallation,
} from '../domain/process-run-pinning.js';

interface PinnedColumnsRow {
  installation_id: number | null;
  package_digest: string | null;
}

/** Persists and reads the immutable module installation bound to a ProcessRun. */
export class ProcessRunInstallationAdapter {
  constructor(private readonly db: Database.Database) {}

  setPinnedInstallation(
    processRunId: number,
    installationId: ModuleInstallationId,
    packageDigest: string,
  ): number {
    const info = this.db.prepare(
      'UPDATE factory_process_runs SET installation_id=?, package_digest=? WHERE id=?',
    ).run(installationId, packageDigest, processRunId);
    return Number(info.changes);
  }

  persistPinnedInstallation(pin: PinnedInstallation): number {
    return this.setPinnedInstallation(pin.processRunId, pin.installationId, pin.packageDigest);
  }

  getPinnedInstallation(processRunId: number): PinnedInstallation | null {
    const row = this.db.prepare(
      'SELECT installation_id, package_digest FROM factory_process_runs WHERE id=?',
    ).get(processRunId) as PinnedColumnsRow | undefined;
    if (!row) return null;
    if (row.installation_id === null || row.package_digest === null) {
      throw new Error(`PROCESS_RUN_PIN_REQUIRED: run ${processRunId} has no complete immutable installation pin`);
    }
    return {
      processRunId,
      installationId: asModuleInstallationId(row.installation_id),
      packageDigest: row.package_digest,
      pinnedAt: this.readUpdatedAt(processRunId),
    };
  }

  private readUpdatedAt(processRunId: number): string {
    const row = this.db.prepare('SELECT updated_at FROM factory_process_runs WHERE id=?')
      .get(processRunId) as { updated_at: string } | undefined;
    return row?.updated_at ?? '';
  }
}
