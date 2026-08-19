/**
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
}

/** The canonical, ID-assigned register entry (kernel-assigned camelCase). */
export interface OrderConstraintEntry {
  /** Stable positional identity: ord-c-001, ord-c-002, ... */
  readonly id: string;
  readonly class: OrderConstraintClass;
  readonly text: string;
  readonly evidenceRef: string;
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
    entries.push({
      id: `ord-c-${padIndex(index)}`,
      class: constraintClass as OrderConstraintClass,
      text,
      evidenceRef,
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
  const register = buildOrderConstraintRegister(value.constraints);
  if (!register) {
    throw new Error('ORDER_CONSTRAINT_REGISTER_INVALID: register carries no constraints');
  }
  const storedDigest = value.registerDigest;
  if (typeof storedDigest !== 'string' || storedDigest !== register.registerDigest) {
    throw new Error('ORDER_CONSTRAINT_REGISTER_DIGEST_MISMATCH');
  }
  // IDs are positional content identities; the rebuild must round-trip them.
  const stored = value.constraints as readonly unknown[];
  if (
    !Array.isArray(stored)
    || stored.some((entry, index) =>
      !isRecord(entry) || entry['id'] !== register.constraints[index]?.id)
  ) {
    throw new Error('ORDER_CONSTRAINT_REGISTER_ID_MISMATCH');
  }
  return register;
}
