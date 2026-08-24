/**
 * Documentation workshop — kernel port contracts.
 *
 * Ports only; concrete SQLite/filesystem/pdf adapters live under
 * `infrastructure/` and `application/pdf/`. The composition root owns
 * construction (LEGO: the module declares, the factory composes).
 */

import type {
  DocumentationBundle,
  DocumentationDocument,
} from './documentation-schemas.js';

export const DOCUMENTATION_KERNEL_HANDLER_IDS = {
  assemble: 'documentation-case-assembler',
  render: 'documentation-renderer',
  settle: 'documentation-settlement-policy',
} as const;

/** Reference to a sealed workplace product (schemaId + ref + digest). */
export interface DocumentationProductRef {
  readonly schemaId: string;
  readonly ref: string;
  readonly digest: string;
}

/**
 * Reads the exact payload of a sealed product. Mirrors the delivery product
 * port boundary: kernel handlers never query the managed ledger directly —
 * they hand exact refs to this port (CGAD P18 discipline).
 */
export interface DocumentationProductReader {
  readProductPayload(productRef: DocumentationProductRef): unknown;
}

export interface RenderDocumentInput {
  readonly document: DocumentationDocument;
  /** Absolute file path (including file name) for the rendered PDF. */
  readonly outputPath: string;
}

export interface RenderDocumentResult {
  readonly pdfFileName: string;
  readonly pdfByteHash: string;
  readonly pdfByteSize: number;
}

export type RenderCapability =
  | { available: true }
  | { available: false; reason: string };

/**
 * Deterministic PDF rendering provider. Rendering is a deterministic kernel
 * capability (CONVEYOR §1: compilation-like external work belongs to
 * providers, never to LM authority). Implementations must fail closed with a
 * typed reason when their engine/fonts are unavailable — an honest `blocked`,
 * never a silent fallback.
 */
export interface DocumentationRenderProvider {
  readonly id: string;
  readonly version: string;
  probe(): RenderCapability;
  render(input: RenderDocumentInput): Promise<RenderDocumentResult>;
}

export interface DocumentationOutputRecord {
  readonly processRunId: number;
  readonly projectId: number;
  readonly epicId: number | null;
  readonly artifactRef: string;
  readonly contentHash: string;
  readonly payload: DocumentationBundle;
}

export interface DocumentationOutputRepository {
  /** Idempotent by process run; the persisted row is immutable afterwards. */
  persistBundle(record: {
    processRunId: number;
    projectId: number;
    epicId: number | null;
    payload: DocumentationBundle;
  }): { record: DocumentationOutputRecord; replayed: boolean };
  readByProcessRun(processRunId: number): DocumentationOutputRecord | null;
}

/**
 * Deterministic repository observation used by the assembler kernel. Reads are
 * always pinned to the EXACT integrated commit of the declared project
 * repository — the kernel never inspects a mutable working copy.
 */
export interface DocumentationRepositoryObservationPort {
  listTree(projectRepositoryId: number, commitSha: string): readonly string[];
  readFileAt(
    projectRepositoryId: number,
    commitSha: string,
    path: string,
    maxBytes: number,
  ): { bytes: string; truncated: boolean } | null;
}
