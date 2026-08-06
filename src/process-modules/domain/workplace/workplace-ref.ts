/**
 * WorkplaceRef — stable identity of one materialized Production Cell instance.
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-05 (Рабочее место —
 * Workplace) + Conveyor Mental Model v4 §«Four entities, one primary» and
 * §«Production Cell versus Flow node».
 *
 * # Why this type exists
 *
 * A Workplace is the PRIMARY entity of the conveyor — durable across every
 * worker, reviewer and repair attempt. Its identity MUST NOT depend on the
 * transient execution that happens to staff it right now. REG-05-AC-01:
 * "worker id, attempt, package drift and recovery number do not enter the
 * WorkplaceRef." A reviewer visiting the same Workplace, or a repair round
 * hiring a new author execution, MUST resolve to the SAME WorkplaceRef so the
 * card, desk and accepted products stay continuous.
 *
 * The four components are:
 *   - `processRunId` — the owning ProcessRun (REG-02). Scopes the workplace to
 *     one initiative; restart continues the same run, so the same workplace.
 *   - `moduleRef` — `${name}@${version}` of the producing ProcessModule
 *     (REG-03). A workplace belongs to one workshop's Flow.
 *   - `productionCellId` — the cell definition id inside that module (REG-04).
 *     One module may declare many cells; each materializes its own workplaces.
 *   - `workKey` — discriminates fan-out instances of ONE cell definition.
 *     Singleton cells use the literal `DEFAULT_WORK_KEY`; fan-out derives a
 *     deterministic workKey from an accepted upstream binding and a stable item
 *     id, NEVER from array order, worker or attempt identity (REG-04-AC-03).
 *
 * # Pure domain
 *
 * This file imports ONLY from sibling pure-domain modules. No SQLite, MCP,
 * db.ts, filesystem, or application/behavioral code — the domain stays pure
 * per the dependency-direction ratchet (`tests/architecture/dependency-direction.test.mjs`)
 * and the new `workplace-domain-purity.test.mjs` ratchet added by this step.
 *
 * # Branded-string rationale
 *
 * `WorkplaceRef` is a plain data object (not a branded string) because it has
 * four orthogonal components — a single branded string would lose structure.
 * The constructor `asWorkplaceRef` performs runtime validation at the boundary
 * (the same pattern as `asCardId` / `asFenceToken` in `lifecycle/domain/ids.ts`)
 * so a malformed ref is rejected at the seam, not deep inside a coordinator.
 */

/** Canonical workKey for a singleton Production Cell (no fan-out). */
export const DEFAULT_WORK_KEY = 'default' as const;

/**
 * Stable identity of one materialized Production Cell instance.
 *
 * Identity is invariant for the whole lifetime of the cell instance
 * (REG-05-AC-01). Replacing the worker, retrying the gate, recovering from a
 * crash — none of these change any field. A different `workKey` is a DIFFERENT
 * workplace (a different fan-out item), not a new attempt of the same one.
 */
export interface WorkplaceRef {
  /** Owning ProcessRun id. */
  readonly processRunId: number;
  /** Producing module `name@version`. */
  readonly moduleRef: string;
  /** Cell definition id inside that module's Flow. */
  readonly productionCellId: string;
  /**
   * Discriminates fan-out instances of one cell definition.
   * `DEFAULT_WORK_KEY` for singletons; a deterministic stable id for fan-out.
   * NEVER derived from array index, worker id, attempt number or package digest
   * (REG-04-AC-03, REG-05-AC-01).
   */
  readonly workKey: string;
}

/**
 * Validate and brand a WorkplaceRef at a boundary.
 *
 * Throws on any malformed component so a bad ref cannot flow into a mutating
 * coordinator call. This mirrors `asCardId`/`asFenceToken` in
 * `lifecycle/domain/ids.ts`: the brand exists so a plain object cannot be
 * passed where a validated WorkplaceRef is required.
 *
 * Rules (REG-05-AC-01 + REG-04-AC-03):
 *   - `processRunId` must be a positive integer (SQLite rowid).
 *   - `moduleRef` must be a non-empty `name@version`-shaped string.
 *   - `productionCellId` must be a non-empty string.
 *   - `workKey` must be a non-empty string. Callers pass `DEFAULT_WORK_KEY`
 *     for singletons; fan-out callers pass a derived stable key. This function
 *     does NOT derive the key (that is the coordinator's job) — it only
 *     rejects obviously-bad values (empty / whitespace) so a coordinator never
 *     receives a ref it cannot persist deterministically.
 *
 * `workKey` is intentionally NOT checked against a derivation rule here: the
 * derivation is policy (REG-04-AC-03) owned by the cell coordinator, not by
 * the identity validator. A unit test of the coordinator proves the
 * derivation; this validator only enforces shape.
 */
export function asWorkplaceRef(input: {
  processRunId: number;
  moduleRef: string;
  productionCellId: string;
  workKey?: string;
}): WorkplaceRef {
  if (input == null || typeof input !== 'object') {
    throw new Error('asWorkplaceRef: expected an object');
  }
  const { processRunId, moduleRef, productionCellId } = input;
  if (!Number.isInteger(processRunId) || processRunId <= 0) {
    throw new Error(
      `asWorkplaceRef: processRunId must be a positive integer, got ${processRunId}`,
    );
  }
  requireNonEmpty(moduleRef, 'moduleRef');
  if (!moduleRef.includes('@')) {
    throw new Error(
      `asWorkplaceRef: moduleRef must be 'name@version', got '${moduleRef}'`,
    );
  }
  requireNonEmpty(productionCellId, 'productionCellId');
  const workKey = input.workKey ?? DEFAULT_WORK_KEY;
  requireNonEmpty(workKey, 'workKey');
  return Object.freeze({
    processRunId,
    moduleRef,
    productionCellId,
    workKey,
  }) as WorkplaceRef;
}

/**
 * Deterministic string form of a WorkplaceRef, suitable for a primary key or
 * log line. Components are joined with `/` in a fixed order. Because every
 * component is itself a stable string/integer, the serialized form is stable
 * for the lifetime of the cell instance (REG-05-AC-01) — two serializations of
 * the same ref are byte-identical.
 *
 * The serialized form is NOT a substitute for the structured object: callers
 * pass a `WorkplaceRef` value, not its string form, across boundaries. This
 * helper exists for storage keys, log lines and idempotency-key derivation.
 */
export function serializeWorkplaceRef(ref: WorkplaceRef): string {
  return [
    'workplace',
    ref.processRunId,
    ref.moduleRef,
    ref.productionCellId,
    ref.workKey,
  ].join('/');
}

export function deserializeWorkplaceRef(value: string): WorkplaceRef {
  const parts = value.split('/');
  if (parts.length < 5 || parts[0] !== 'workplace') {
    throw new Error(`deserializeWorkplaceRef: invalid ref '${value}'`);
  }
  return asWorkplaceRef({
    processRunId: Number(parts[1]),
    moduleRef: parts[2]!,
    productionCellId: parts[3]!,
    workKey: parts.slice(4).join('/'),
  });
}

/**
 * Two WorkplaceRefs are equal iff every component is equal. Structural equality
 * — no prototype, no branding tricks. Used by coordinator tests and by
 * repository CAS comparisons.
 */
export function workplaceRefEquals(
  a: WorkplaceRef,
  b: WorkplaceRef,
): boolean {
  return (
    a.processRunId === b.processRunId
    && a.moduleRef === b.moduleRef
    && a.productionCellId === b.productionCellId
    && a.workKey === b.workKey
  );
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function requireNonEmpty(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`asWorkplaceRef: ${label} must be a non-empty string`);
  }
}
