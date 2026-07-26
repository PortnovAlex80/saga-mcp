/**
 * ProcessOutcomeCertificateRepository — persistence port for generic process
 * outcome certificates.
 *
 * Mirrors the saga3 settlement port boundary (a narrow, deterministic port
 * isolated from the SQLite impl). Production wires the SQLite impl from
 * sqlite-process-outcome-certificate-repository.ts; tests inject a fake.
 */

import type { ProcessModuleReference } from '../domain/process-module.js';
import type {
  IssueProcessOutcomeCertificateCommand,
  ProcessOutcomeCertificate,
} from './process-outcome-certificate.js';

export interface ProcessOutcomeCertificateRepository {
  /**
   * Issue one certificate for a ProcessRun. Idempotent on certificate_hash:
   * re-issuing the SAME hash returns the existing row (replayed=true). Issuing
   * a DIFFERENT hash for a process_run_id that already has a certificate
   * throws PROCESS_RUN_ALREADY_CERTIFIED — a ProcessRun gets exactly one
   * authoritative result.
   */
  issue(
    command: IssueProcessOutcomeCertificateCommand,
  ): { record: ProcessOutcomeCertificate; replayed: boolean };

  /** Read one certificate by id. Returns null if absent. */
  read(id: number): ProcessOutcomeCertificate | null;

  /** Read the certificate for one ProcessRun. Returns null if not yet issued. */
  readByProcessRun(processRunId: number): ProcessOutcomeCertificate | null;

  /** Read by certificate hash (integrity lookup). Returns null if absent. */
  readByHash(certificateHash: string): ProcessOutcomeCertificate | null;

  /** List certificates for one project, optionally narrowed by epic. */
  list(
    projectId: number,
    epicId: number | null,
  ): readonly ProcessOutcomeCertificate[];

  /** Resolve the certificate bound to a module ref + run. Used by adapters. */
  readByModuleRun(
    projectId: number,
    moduleRef: ProcessModuleReference,
    processRunId: number,
  ): ProcessOutcomeCertificate | null;
}
