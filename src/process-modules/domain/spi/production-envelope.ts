/**
 * W1-A6 — Production envelope: the durable, content-addressed products that
 * cross the Process Module boundary.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md §1 row 9.
 * Plan: §7.6 (NodeProductionEnvelope), §13.20 (ProcessModuleOutputEnvelope).
 *
 * This file is PURE: only data types and one pure validator. No behavior, no
 * executors, no factories. It is the canonical surface future waves (2/3)
 * content-address and persist; Wave 1 only DEFINES it.
 *
 * ── Why NodeProduction is mirrored inline, not imported ───────────────────
 *
 * The existing `NodeProduction` interface lives in
 * `src/process-modules/application/node-executor.ts`. The Wave 1 dependency-
 * direction ratchet (plan §3.16 / Rule 5) forbids the domain layer
 * (`domain/**`, including this `domain/spi/` subdir) from importing anything
 * from `application/`. The W0-A1 dependency-graph scanner
 * (`tools/dep-graph-scanner.mjs`) does NOT distinguish `import type` from
 * `import` — both register as an edge — so even a type-only import from
 * `application/node-executor.js` would create a new Rule 5 violation and fail
 * the `tests/architecture/dependency-direction.test.mjs` ratchet.
 *
 * The established precedent is `RecoverySourceProduction` in
 * `domain/recovery.ts` (lines 82-91), which deliberately "mirrors
 * application/NodeProduction without importing the application layer into the
 * domain." This file follows the SAME pattern: `NodeProductionEnvelope` carries
 * the four `NodeProduction` fields inline (`schema`, `artifactRef`,
 * `contentHash`, `bindings`) under the same names, then adds the new envelope
 * fields. The shapes are structurally identical; a later wave that lifts
 * `NodeProduction` itself into `domain/` can swap the mirror for a real import
 * without touching call sites.
 *
 * ── Acyclic model (Wave 8 BLOCKER 2) ─────────────────────────────────────
 *
 * `ProcessModuleOutputEnvelope` is a LEAF. It does NOT reference
 * `ModuleCompletion`; the relationship is one-directional
 * (`ModuleCompletion.outputEnvelope` → this envelope). The previous
 * `completion: ModuleCompletion` field created a type cycle that Delivery and
 * Formalization closed at runtime with a real back-reference, breaking
 * JSON persistence. The field was removed; the model is now a serializable
 * tree.
 */

import { sha256Hex } from '../../../shared/canonical-json.js';

// NOTE: `ModuleCompletion` (./module-completion.ts) references
// `ProcessModuleOutputEnvelope` via `import type`. That is a one-directional
// edge: completion → envelope. This file does NOT import ModuleCompletion —
// the envelope is a serializable leaf with no back-reference (Wave 8 BLOCKER 2
// removed the cyclic `completion` field; see the doc comment on
// ProcessModuleOutputEnvelope below).

// ---------------------------------------------------------------------------
// assertCanonicalSerializable — W1-A1 integration path with an inline
// isolation fallback. See file header of any sibling W1-A6 validator for the
// rationale. The real assertion lives in W1-A1's canonical-serialization.ts;
// this resolver picks it up at module load when present (integration worktree)
// and otherwise uses the inline fallback so this lane builds & tests green in
// isolation. The fallback implements the FULL forbidden-kind set named in the
// W1-A6 negative-test contract (function / Map / Set / undefined-in-array /
// class instance / Symbol / non-finite number).
// ---------------------------------------------------------------------------

type AssertCanonical = (value: unknown) => void;

function fallbackAssertCanonicalSerializable(value: unknown): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    const t = typeof v;
    if (t === 'function') {
      throw new Error('not canonical serializable: function value');
    }
    if (t === 'symbol') {
      throw new Error('not canonical serializable: symbol value');
    }
    if (t === 'number' && !Number.isFinite(v as number)) {
      throw new Error('not canonical serializable: non-finite number');
    }
    if (v === null || t !== 'object') continue;
    if (v instanceof Map) {
      throw new Error('not canonical serializable: Map');
    }
    if (v instanceof Set) {
      throw new Error('not canonical serializable: Set');
    }
    // Plain objects and arrays only. Class instances (whose prototype is not
    // Object.prototype or Array.prototype) are rejected — canonicalJson would
    // drop their non-enumerable / getter-backed state and produce a misleading
    // hash.
    if (!Array.isArray(v)) {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error('not canonical serializable: non-plain object');
      }
    }
    const iter = Array.isArray(v)
      ? (v as unknown[])
      : Object.values(v as Record<string, unknown>);
    for (let i = 0; i < iter.length; i++) {
      const child = iter[i];
      if (child === undefined && Array.isArray(v)) {
        // undefined inside an array is NOT dropped by JSON.stringify (it becomes
        // null), which would silently mutate the value — reject it.
        throw new Error('not canonical serializable: undefined in array');
      }
      stack.push(child);
    }
  }
}

let _assertCanonical: AssertCanonical | null = null;

async function resolveAssertCanonical(): Promise<AssertCanonical> {
  if (_assertCanonical) return _assertCanonical;
  try {
    // W1-A1 integration path. Resolves once canonical-serialization.ts lands.
    // Variable specifier so tsc does not resolve-check a sibling-lane file
    // that is absent in this isolated worktree.
    const spec = './canonical-serialization.js';
    const mod = (await import(spec)) as {
      assertCanonicalSerializable?: AssertCanonical;
    };
    if (typeof mod.assertCanonicalSerializable === 'function') {
      _assertCanonical = mod.assertCanonicalSerializable;
      return _assertCanonical;
    }
  } catch {
    // fall through to inline fallback
  }
  _assertCanonical = fallbackAssertCanonicalSerializable;
  return _assertCanonical;
}

// Synchronous mirror for validators: in the integration worktree W1-A1's
// module is present synchronously via the compiled dist graph; in isolation
// the async resolver has not yet run. To keep validators synchronous (callers
// expect a ValidationResult, not a Promise), we eagerly kick off the resolver
// at module load and also expose the fallback synchronously.
let _assertCanonicalSync: AssertCanonical = fallbackAssertCanonicalSerializable;
void resolveAssertCanonical().then((fn) => {
  _assertCanonicalSync = fn;
});

// ---------------------------------------------------------------------------
// Validation result shape (shared with all W1-A6 validators).
// ---------------------------------------------------------------------------

export interface ValidationError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

function okResult(): ValidationResult {
  return { ok: true, errors: [] };
}

function err(code: string, path: string, message: string): ValidationError {
  return { code, path, message };
}

function fail(errors: ValidationError[]): ValidationResult {
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// ProductRef — content-addressed reference to one product.
// ---------------------------------------------------------------------------

/**
 * Pure, serializable reference to a single product produced by a node.
 *
 * `schemaId` is the schema identity (e.g. `'factory.discovery-proposal.v1'`).
 * `ref` is an opaque, module-owned artifact reference (e.g. `'proposal:141'`).
 * `digest` is the SHA-256 over the canonical product body — lowercase hex,
 * immutable, content-addressing the exact bytes.
 */
export interface ProductRef {
  readonly schemaId: string;
  readonly ref: string;
  readonly digest: string;
}

// ---------------------------------------------------------------------------
// LineageRef — durable pointer to an ancestor product, node-run, or receipt.
// ---------------------------------------------------------------------------

export type LineageRefKind = 'node-run' | 'production' | 'receipt';

/**
 * Durable pointer into the immutable run history. `kind` discriminates the
 * lineage target; `ref` is an opaque, module-owned identifier resolved against
 * the canonical run store. Pure data — the runtime persists and forwards it
 * without interpreting the ref string.
 */
export interface LineageRef {
  readonly kind: LineageRefKind;
  readonly ref: string;
}

const LINEAGE_REF_KINDS: ReadonlySet<LineageRefKind> = new Set([
  'node-run',
  'production',
  'receipt',
]);

// ---------------------------------------------------------------------------
// NodeProductionEnvelope — extends the NodeProduction shape with envelope fields.
// ---------------------------------------------------------------------------

/**
 * Durable, content-addressed production emitted by one node, wrapped with the
 * lineage the settlement kernel needs to reconstruct provenance after a crash.
 *
 * The first four fields (`schema`, `artifactRef`, `contentHash`, `bindings`)
 * are a STRUCTURAL MIRROR of `NodeProduction` from
 * `application/node-executor.ts` — see the file header for why this is mirrored
 * inline rather than imported. `schemaId` / `productRef` / `lineage` are the
 * new envelope fields added by Wave 1 (plan §7.6).
 */
export interface NodeProductionEnvelope {
  /** Mirrored from NodeProduction. Schema id of the production. */
  readonly schema: string;
  /** Mirrored from NodeProduction. Opaque artifact reference. */
  readonly artifactRef: string;
  /** Mirrored from NodeProduction. SHA-256 over the canonical production body. */
  readonly contentHash: string;
  /**
   * Mirrored from NodeProduction. Machine-filled parameters for downstream
   * nodes. Primitive or nested-plain-object values only — the module contract
   * restricts what it puts here, and assertCanonicalSerializable enforces
   * serializability at validate time.
   */
  readonly bindings: Readonly<Record<string, unknown>>;
  // ── New envelope fields (plan §7.6) ─────────────────────────────────────
  /** Schema id of THIS envelope (the wrapper), not of the wrapped production. */
  readonly schemaId: string;
  /**
   * Logical instance key within this product kind (e.g. `artifact:42` for the
   * artifact-ref bridge). When omitted, the persistence layer falls back to
   * keep working under the `UNIQUE(process_run_id, product_kind, product_key)`
   * constraint. Multiple products of the same kind in one run MUST each supply
   * a distinct `productKey`.
   */
  readonly productKey?: string;
  /** Content-addressed reference to the production this envelope wraps. */
  readonly productRef: ProductRef;
  /** Durable lineage back to ancestor node-runs / productions / receipts. */
  readonly lineage: readonly LineageRef[];
}

// ---------------------------------------------------------------------------
// ProcessModuleOutputEnvelope — the complete immutable module output.
// ---------------------------------------------------------------------------

/**
 * The complete immutable output that crosses the Process Module boundary
 * (plan §13.20). It carries the module's declared `outcome`, every production
 * the module emitted (each wrapped in a NodeProductionEnvelope), and an
 * optional certificate reference.
 *
 * ── Acyclic model (Wave 8 BLOCKER 2) ─────────────────────────────────────
 *
 * This envelope is a LEAF: it does NOT reference back to `ModuleCompletion`.
 * The relationship is ONE-DIRECTIONAL: `ModuleCompletion.outputEnvelope`
 * points at this envelope (completion → envelope), but the envelope does not
 * point back. The previous `completion: ModuleCompletion` field created a type
 * cycle that Delivery and Formalization closed at RUNTIME via a real
 * back-reference (`envelope.completion = completion`), which made
 * `JSON.stringify(completion)` throw "Converting circular structure to JSON"
 * in the durable persist path. Removing the field makes the model a tree,
 * which is safe to serialize. Settlement reads only
 * `outputEnvelope.certificateRef` and `outputEnvelope.outcome` — never
 * `outputEnvelope.completion` — so the field was dead weight.
 */
export interface ProcessModuleOutputEnvelope {
  /** The module's declared outcome code (one of its OutcomeDefinition codes). */
  readonly outcome: string;
  /** Every production the module emitted, each wrapped in its envelope. */
  readonly productions: readonly NodeProductionEnvelope[];
  /** Optional certificate reference the module authored. */
  readonly certificateRef?: ProductRef;
}

// ---------------------------------------------------------------------------
// Validators.
// ---------------------------------------------------------------------------

/**
 * Validate a `ProductRef`: assert canonical serializability, then check that
 * `schemaId`, `ref`, `digest` are non-empty strings.
 */
export async function validateProductRef(
  value: unknown,
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  try {
    _assertCanonicalSync(value);
  } catch (e) {
    errors.push(
      err('NOT_CANONICAL', '$', (e as Error).message),
    );
    return fail(errors);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail([err('NOT_OBJECT', '$', 'ProductRef must be a plain object')]);
  }
  const v = value as Record<string, unknown>;
  if (typeof v.schemaId !== 'string' || v.schemaId.length === 0) {
    errors.push(err('BAD_SCHEMA_ID', 'schemaId', 'schemaId must be a non-empty string'));
  }
  if (typeof v.ref !== 'string' || v.ref.length === 0) {
    errors.push(err('BAD_REF', 'ref', 'ref must be a non-empty string'));
  }
  if (typeof v.digest !== 'string' || v.digest.length === 0) {
    errors.push(err('BAD_DIGEST', 'digest', 'digest must be a non-empty string'));
  }
  return errors.length === 0 ? okResult() : fail(errors);
}

/**
 * Validate a `LineageRef`: assert canonical serializability, then check `kind`
 * is one of the allowed discriminants and `ref` is a non-empty string.
 */
export async function validateLineageRef(
  value: unknown,
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  try {
    _assertCanonicalSync(value);
  } catch (e) {
    errors.push(err('NOT_CANONICAL', '$', (e as Error).message));
    return fail(errors);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail([err('NOT_OBJECT', '$', 'LineageRef must be a plain object')]);
  }
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== 'string' || !LINEAGE_REF_KINDS.has(v.kind as LineageRefKind)) {
    errors.push(
      err(
        'BAD_KIND',
        'kind',
        `kind must be one of ${[...LINEAGE_REF_KINDS].join('|')}`,
      ),
    );
  }
  if (typeof v.ref !== 'string' || v.ref.length === 0) {
    errors.push(err('BAD_REF', 'ref', 'ref must be a non-empty string'));
  }
  return errors.length === 0 ? okResult() : fail(errors);
}

/**
 * Validate a `NodeProductionEnvelope`: assert canonical serializability, then
 * check the mirrored NodeProduction fields and the new envelope fields
 * (schemaId, productRef, lineage).
 */
export async function validateNodeProductionEnvelope(
  value: unknown,
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  try {
    _assertCanonicalSync(value);
  } catch (e) {
    errors.push(err('NOT_CANONICAL', '$', (e as Error).message));
    return fail(errors);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail([
      err('NOT_OBJECT', '$', 'NodeProductionEnvelope must be a plain object'),
    ]);
  }
  const v = value as Record<string, unknown>;
  if (typeof v.schema !== 'string' || v.schema.length === 0) {
    errors.push(err('BAD_SCHEMA', 'schema', 'schema must be a non-empty string'));
  }
  if (typeof v.artifactRef !== 'string' || v.artifactRef.length === 0) {
    errors.push(err('BAD_ARTIFACT_REF', 'artifactRef', 'artifactRef must be a non-empty string'));
  }
  if (typeof v.contentHash !== 'string' || v.contentHash.length === 0) {
    errors.push(err('BAD_CONTENT_HASH', 'contentHash', 'contentHash must be a non-empty string'));
  }
  if (typeof v.bindings !== 'object' || v.bindings === null || Array.isArray(v.bindings)) {
    errors.push(err('BAD_BINDINGS', 'bindings', 'bindings must be a plain object'));
  }
  if (typeof v.schemaId !== 'string' || v.schemaId.length === 0) {
    errors.push(err('BAD_SCHEMA_ID', 'schemaId', 'schemaId must be a non-empty string'));
  }
  const productRefRes = await validateProductRef(v.productRef);
  if (!productRefRes.ok) {
    for (const e of productRefRes.errors) {
      errors.push(err(e.code, `productRef.${e.path}`, e.message));
    }
  }
  if (!Array.isArray(v.lineage)) {
    errors.push(err('BAD_LINEAGE', 'lineage', 'lineage must be an array'));
  } else {
    for (let i = 0; i < v.lineage.length; i++) {
      const lr = await validateLineageRef(v.lineage[i]);
      if (!lr.ok) {
        for (const e of lr.errors) {
          errors.push(err(e.code, `lineage[${i}].${e.path}`, e.message));
        }
      }
    }
  }
  return errors.length === 0 ? okResult() : fail(errors);
}

/**
 * Validate a `ProcessModuleOutputEnvelope`: assert canonical serializability,
 * then check `outcome`, `productions` (each validated), and optional
 * `certificateRef`. The envelope is a LEAF (Wave 8 BLOCKER 2 removed the
 * cyclic `completion` field), so there is no completion shell to validate and
 * no recursion concern.
 */
export async function validateProcessModuleOutputEnvelope(
  value: unknown,
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  try {
    _assertCanonicalSync(value);
  } catch (e) {
    errors.push(err('NOT_CANONICAL', '$', (e as Error).message));
    return fail(errors);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail([
      err('NOT_OBJECT', '$', 'ProcessModuleOutputEnvelope must be a plain object'),
    ]);
  }
  const v = value as Record<string, unknown>;
  if (typeof v.outcome !== 'string' || v.outcome.length === 0) {
    errors.push(err('BAD_OUTCOME', 'outcome', 'outcome must be a non-empty string'));
  }
  if (!Array.isArray(v.productions)) {
    errors.push(err('BAD_PRODUCTIONS', 'productions', 'productions must be an array'));
  } else {
    for (let i = 0; i < v.productions.length; i++) {
      const pr = await validateNodeProductionEnvelope(v.productions[i]);
      if (!pr.ok) {
        for (const e of pr.errors) {
          errors.push(err(e.code, `productions[${i}].${e.path}`, e.message));
        }
      }
    }
  }
  if (v.certificateRef !== undefined) {
    const cr = await validateProductRef(v.certificateRef);
    if (!cr.ok) {
      for (const e of cr.errors) {
        errors.push(err(e.code, `certificateRef.${e.path}`, e.message));
      }
    }
  }
  return errors.length === 0 ? okResult() : fail(errors);
}

/**
 * Convenience: SHA-256 over the canonical JSON of an envelope. Delegates to the
 * platform primitive so production-envelope digests are byte-compatible with
 * every other content-addressed artifact.
 */
export function productionEnvelopeDigest(value: unknown): string {
  return sha256Hex(value);
}
