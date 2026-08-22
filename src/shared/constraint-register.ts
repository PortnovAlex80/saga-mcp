/**
 * [E9 RESERVE — DO NOT REMOVE] This module is also the prerequisite of the
 * deferred recycle-run design (docs/architecture/RECYCLE-RUN-DESIGN.md,
 * architect-deferred 2026-08-19): the change-request hook, the capsule
 * MISS/HIT semantics and the product version row all consume this register
 * as the baseline of the first honest re-run. See docs/architecture/E9-RESERVE.md.
 *
 * Order Constraint Register — the single typed source for the three AC-drift
 * obligation networks (docs/architecture/AC-DRIFT-REMEDY-DESIGN.md).
 *
 * The order's requirements (docker compose up, TypeScript backend, a human
 * Chrome check…) die at ONE point when nothing counts them. This register is
 * the counted form: extracted at discovery time while the constraints are
 * still visible, assigned stable positional IDs (`ord-c-NNN`), and
 * content-addressed by digest.
 *
 * One register, three projections:
 *   - network 1 (reaction): the brief must dispose every ID
 *     (accepted | waived+reason) — enforced by the product-contract gate.
 *   - network 2 (structure): AC metadata + SRS §D2 must cover every
 *     non-waived ID — enforced by findContractGap + the SRS validators.
 *   - network 3 (execution): the certifier quotes the register as a
 *     verification warrant (warrantRef — types only in this branch).
 *
 * Provenance: the discovery worker serializes the constraints it observed
 * into `DiscoveryProposalPayload.order_constraints` (an LM step OUTSIDE every
 * gate — its quality is the discovery assessor's boundary, by design). The
 * kernel-side builder below is deterministic and fail-closed: it never
 * guesses, classifies, or re-reads prose. It only assigns stable identities
 * to already-typed rows and pins their content with a digest.
 *
 * Retro-compatibility (monotonicity): a proposal that carries no
 * `order_constraints` builds NO register — every downstream diff is empty and
 * every existing gate stays green. Old artifacts never break.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json.js';
import { parseRepositoryFilePath } from './repository-scope.js';

/** Schema version of the serialized register. */
export const ORDER_CONSTRAINT_REGISTER_SCHEMA = 'factory.order-constraint-register.v1';

/**
 * The closed class vocabulary. WHAT the order demands, not how to test it:
 *   - execution: a runnable check the order text commands (docker compose up).
 *   - material:  a static material property (TypeScript sources, files probe).
 *   - human:     a check only a human can perform (Chrome "feels" right) —
 *                never a silent pass; it surfaces as an outstanding check.
 */
export const ORDER_CONSTRAINT_CLASSES = ['execution', 'material', 'human'] as const;
export type OrderConstraintClass = (typeof ORDER_CONSTRAINT_CLASSES)[number];

/**
 * The worker-facing draft shape (snake_case — matches the proposal payload
 * convention the discovery worker already writes).
 */
export interface OrderConstraintDraft {
  readonly class: OrderConstraintClass;
  readonly text: string;
  readonly evidence_ref: string;
  /**
   * ADR-088 (CC-GAP-6): repository-relative files an EXECUTION-class
   * constraint declares as its product entrypoints (install -> start ->
   * accessible running product). Optional; execution-class only. The
   * Development planning gate requires every declared file to lie inside the
   * frozen change scopes of an item whose kernel-derived
   * `coveredConstraintIds` include this entry — a wide decoy item that merely
   * contains the file does not satisfy it. Absent on legacy registers (no
   * entrypoint obligation).
   */
  readonly entrypoint_files?: readonly string[];
}

/** The canonical, ID-assigned register entry (kernel-assigned camelCase). */
export interface OrderConstraintEntry {
  /** Stable positional identity: ord-c-001, ord-c-002, ... */
  readonly id: string;
  readonly class: OrderConstraintClass;
  readonly text: string;
  readonly evidenceRef: string;
  /** @see OrderConstraintDraft.entrypoint_files — execution-class only. */
  readonly entrypointFiles?: readonly string[];
}

/** The immutable, digest-pinned register. */
export interface OrderConstraintRegister {
  readonly schemaVersion: typeof ORDER_CONSTRAINT_REGISTER_SCHEMA;
  readonly constraints: readonly OrderConstraintEntry[];
  /** SHA-256 over the canonical JSON of the constraint entries. */
  readonly registerDigest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deterministic SHA-256 over the canonical constraint entries. Deliberately
 * excludes the schemaVersion: two schema revisions over identical constraint
 * content are the same register (the ref is content-addressed, and the
 * content IS the constraints).
 */
function digestEntries(entries: readonly OrderConstraintEntry[]): string {
  return createHash('sha256').update(canonicalJson(entries)).digest('hex');
}

function padIndex(index: number): string {
  return String(index + 1).padStart(3, '0');
}

/**
 * Validate one execution-class entrypoint declaration. Fail-closed: an
 * entrypoint is a repository-relative FILE path inside the product tree —
 * absolute paths, traversal and empty segments are typed errors, never
 * silently trimmed (ADR-088: the ownership conjunction must be mechanical).
 */
function parseEntrypointFiles(
  raw: unknown,
  index: number,
): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(
      `ORDER_CONSTRAINT_ENTRYPOINT_FILES_INVALID: order_constraints[${index}].entrypoint_files must be an array of file paths`,
    );
  }
  if (raw.length === 0) return undefined;
  const files = raw.map(file => {
    if (typeof file !== 'string') {
      throw new Error(
        `ORDER_CONSTRAINT_ENTRYPOINT_FILE_INVALID: order_constraints[${index}].entrypoint_files entries must be non-empty repository-relative file paths`,
      );
    }
    try {
      return parseRepositoryFilePath(file);
    } catch {
      throw new Error(
        `ORDER_CONSTRAINT_ENTRYPOINT_FILE_INVALID: order_constraints[${index}].entrypoint_files entry '${file}' is not a repository-relative file path`,
      );
    }
  });
  if (new Set(files).size !== files.length) {
    throw new Error(
      `ORDER_CONSTRAINT_ENTRYPOINT_FILE_INVALID: order_constraints[${index}].entrypoint_files declares duplicate paths`,
    );
  }
  return files;
}

/**
 * Build the register from typed drafts. Fail-closed on malformed input (a
 * malformed draft reaching this builder means the proposal validation
 * boundary was bypassed — never guess).
 *
 * Returns null when there are no drafts: "no register" is the honest
 * retro-compatible state, distinct from "empty register" which would pin a
 * digest over nothing.
 */
export function buildOrderConstraintRegister(drafts: unknown): OrderConstraintRegister | null {
  if (drafts === undefined || drafts === null) return null;
  if (!Array.isArray(drafts)) {
    throw new Error('ORDER_CONSTRAINT_DRAFTS_INVALID: order_constraints must be an array');
  }
  if (drafts.length === 0) return null;
  const entries: OrderConstraintEntry[] = [];
  for (const [index, draft] of drafts.entries()) {
    if (!isRecord(draft)) {
      throw new Error(`ORDER_CONSTRAINT_DRAFT_INVALID: order_constraints[${index}] must be an object`);
    }
    const constraintClass = draft['class'];
    if (
      typeof constraintClass !== 'string'
      || !(ORDER_CONSTRAINT_CLASSES as readonly string[]).includes(constraintClass)
    ) {
      throw new Error(
        `ORDER_CONSTRAINT_CLASS_INVALID: order_constraints[${index}].class must be one of `
        + `${ORDER_CONSTRAINT_CLASSES.join('|')}`,
      );
    }
    const text = draft['text'];
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error(
        `ORDER_CONSTRAINT_TEXT_REQUIRED: order_constraints[${index}].text must be a non-empty string`,
      );
    }
    const evidenceRef = draft['evidence_ref'];
    if (typeof evidenceRef !== 'string' || evidenceRef.trim().length === 0) {
      throw new Error(
        `ORDER_CONSTRAINT_EVIDENCE_REF_REQUIRED: order_constraints[${index}].evidence_ref must be a non-empty string`,
      );
    }
    // ADR-088 (CC-GAP-6): entrypoint declarations are EXECUTION-class only.
    // A material/human constraint naming product files is a typed draft
    // defect at the submission boundary — never silently ignored.
    const entrypointFiles = parseEntrypointFiles(draft['entrypoint_files'], index);
    if (entrypointFiles && constraintClass !== 'execution') {
      throw new Error(
        `ORDER_CONSTRAINT_ENTRYPOINT_CLASS_INVALID: order_constraints[${index}].entrypoint_files may only be declared by execution-class constraints (got '${constraintClass}')`,
      );
    }
    entries.push({
      id: `ord-c-${padIndex(index)}`,
      class: constraintClass as OrderConstraintClass,
      text,
      evidenceRef,
      ...(entrypointFiles ? { entrypointFiles } : {}),
    });
  }
  return {
    schemaVersion: ORDER_CONSTRAINT_REGISTER_SCHEMA,
    constraints: entries,
    registerDigest: digestEntries(entries),
  };
}

/**
 * Content-addressed reference for the register. The digest IS the identity:
 * the same constraints always produce the same ref, a changed constraint is a
 * different register (an honest miss on replay, per the design).
 */
export function orderConstraintRegisterRef(register: OrderConstraintRegister): string {
  return `constraint-register:${register.registerDigest}`;
}

/**
 * Validate an already-built register read back from persistence. Returns the
 * register when the shape and digest hold, null when the value carries no
 * register (retro-compat), and throws on a digest mismatch (tampering —
 * fail closed, never re-derive silently).
 *
 * CC-GAP-6 (ADR-088): the canonical entry shape (camelCase
 * `OrderConstraintEntry`, optionally carrying execution-class
 * `entrypointFiles`) is validated DIRECTLY here. The previous implementation
 * round-tripped the entries through the snake_case draft builder, which
 * would have rejected any canonical register (`evidence_ref` vs
 * `evidenceRef`) — latent because the function had no callers; it becomes
 * load-bearing the moment Development consumes persisted registers.
 */
export function verifyOrderConstraintRegister(value: unknown): OrderConstraintRegister | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new Error('ORDER_CONSTRAINT_REGISTER_INVALID: register must be an object');
  }
  if (value.schemaVersion !== ORDER_CONSTRAINT_REGISTER_SCHEMA) {
    throw new Error(
      `ORDER_CONSTRAINT_REGISTER_INVALID: schemaVersion '${String(value.schemaVersion)}' is not ${ORDER_CONSTRAINT_REGISTER_SCHEMA}`,
    );
  }
  const stored = value.constraints;
  if (!Array.isArray(stored) || stored.length === 0) {
    throw new Error('ORDER_CONSTRAINT_REGISTER_INVALID: register carries no constraints');
  }
  const entries: OrderConstraintEntry[] = [];
  stored.forEach((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error('ORDER_CONSTRAINT_REGISTER_INVALID: register entries must be objects');
    }
    const constraintClass = raw['class'];
    if (
      typeof constraintClass !== 'string'
      || !(ORDER_CONSTRAINT_CLASSES as readonly string[]).includes(constraintClass)
    ) {
      throw new Error(
        'ORDER_CONSTRAINT_REGISTER_INVALID: register entry class must be one of '
        + `${ORDER_CONSTRAINT_CLASSES.join('|')}`,
      );
    }
    if (typeof raw['text'] !== 'string' || raw['text'].trim().length === 0) {
      throw new Error('ORDER_CONSTRAINT_REGISTER_INVALID: register entry text must be a non-empty string');
    }
    if (typeof raw['evidenceRef'] !== 'string' || raw['evidenceRef'].trim().length === 0) {
      throw new Error('ORDER_CONSTRAINT_REGISTER_INVALID: register entry evidenceRef must be a non-empty string');
    }
    const entrypointFiles = parseEntrypointFiles(raw['entrypointFiles'], index);
    if (entrypointFiles && constraintClass !== 'execution') {
      throw new Error(
        'ORDER_CONSTRAINT_ENTRYPOINT_CLASS_INVALID: register entry entrypointFiles may only be declared by execution-class constraints',
      );
    }
    entries.push({
      id: `ord-c-${padIndex(index)}`,
      class: constraintClass as OrderConstraintClass,
      text: raw['text'],
      evidenceRef: raw['evidenceRef'],
      ...(entrypointFiles ? { entrypointFiles } : {}),
    });
  });
  // IDs are positional content identities; the stored rows must round-trip them.
  if (stored.some((raw, index) =>
    !isRecord(raw) || raw['id'] !== entries[index]!.id)) {
    throw new Error('ORDER_CONSTRAINT_REGISTER_ID_MISMATCH');
  }
  const register: OrderConstraintRegister = {
    schemaVersion: ORDER_CONSTRAINT_REGISTER_SCHEMA,
    constraints: entries,
    registerDigest: digestEntries(entries),
  };
  const storedDigest = value.registerDigest;
  if (typeof storedDigest !== 'string' || storedDigest !== register.registerDigest) {
    throw new Error('ORDER_CONSTRAINT_REGISTER_DIGEST_MISMATCH');
  }
  return register;
}
