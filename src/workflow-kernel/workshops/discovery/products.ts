/**
 * workflow-kernel/workshops/discovery/products.ts - the versioned,
 * content-addressed input/output product schemas of the Discovery workshop
 * (WP-11D, plan phase EK-8 workshop conversion).
 *
 * Laws implemented here:
 *   - Every product is a versioned value: the schemaVersion is part of the
 *     canonical content; a product of an unknown version is refused typed
 *     (stale/schema-bypass products never enter the chain).
 *   - Content addressing uses the kernel's ONE canonical digest rule
 *     (domain/digest.ts sha256OfCanonical, imported - never reimplemented).
 *     A declared digest is never trusted: verifyProductAddress recomputes it.
 *   - The field set of each contract is CLOSED data (name/type/required/
 *     minLength/enum/pattern); validation is deterministic and total. A
 *     malformed product is a typed refusal naming the exact field - never a
 *     silent pass, never an inferred default.
 *   - Product contracts are DATA: the workshop identity that binds them is
 *     carried by the installed workshop manifest (installed-manifest.ts),
 *     never by a kernel conditional.
 *
 * PURITY: imports only ../domain/digest.js. No I/O, no clock, no SQL.
 */

import { sha256OfCanonical } from '../../domain/digest.js';

/* ------------------------------------------------------------------ */
/* Product contracts (closed data)                                     */
/* ------------------------------------------------------------------ */

/** One field declaration of a product contract. */
export interface ProductFieldDecl {
  readonly name: string;
  readonly type: 'string' | 'string[]';
  readonly required: boolean;
  /** Minimum length for strings / minimum item count for arrays. */
  readonly minLength: number;
  /** Closed value set (strings only). */
  readonly enumValues?: readonly string[];
  /** Anchored regex source the value must match (strings only). */
  readonly pattern?: string;
}

/** One versioned, content-addressed product contract. */
export interface ProductContract {
  readonly contractId: string;
  readonly schemaVersion: string;
  readonly role: 'input' | 'output';
  readonly fields: readonly ProductFieldDecl[];
}

/** The idea-intake INPUT product: the operator's idea enters here. */
export const IDEA_INTAKE_CONTRACT: ProductContract = {
  contractId: 'idea-intake',
  schemaVersion: 'ek.workshop-product.idea-intake.v1',
  role: 'input',
  fields: [
    { name: 'ideaId', type: 'string', required: true, minLength: 1 },
    { name: 'statement', type: 'string', required: true, minLength: 12 },
    { name: 'context', type: 'string', required: true, minLength: 1 },
    { name: 'constraints', type: 'string[]', required: true, minLength: 1 },
    { name: 'outcomeWish', type: 'string', required: true, minLength: 1 },
    { name: 'unknowns', type: 'string[]', required: true, minLength: 0 },
  ],
};

/** The brief OUTPUT product: what the Discovery author produces. */
export const BRIEF_CONTRACT: ProductContract = {
  contractId: 'brief',
  schemaVersion: 'ek.workshop-product.brief.v1',
  role: 'output',
  fields: [
    { name: 'briefId', type: 'string', required: true, minLength: 1 },
    { name: 'problem', type: 'string', required: true, minLength: 12 },
    { name: 'outcome', type: 'string', required: true, minLength: 1 },
    { name: 'constraints', type: 'string[]', required: true, minLength: 1 },
    { name: 'openQuestions', type: 'string[]', required: true, minLength: 0 },
    { name: 'ideaRef', type: 'string', required: true, minLength: 1, pattern: '^sha256:[0-9a-f]{64}$' },
  ],
};

/** The intent/decision OUTPUT product: the Discovery decision the reviewer owns. */
export const INTENT_CONTRACT: ProductContract = {
  contractId: 'intent',
  schemaVersion: 'ek.workshop-product.intent.v1',
  role: 'output',
  fields: [
    { name: 'intentId', type: 'string', required: true, minLength: 1 },
    { name: 'decision', type: 'string', required: true, minLength: 1, enumValues: ['go', 'no-go', 'needs-human'] },
    { name: 'rationale', type: 'string', required: true, minLength: 12 },
    { name: 'briefRef', type: 'string', required: true, minLength: 1, pattern: '^sha256:[0-9a-f]{64}$' },
    { name: 'targetStageRoute', type: 'string', required: true, minLength: 1, enumValues: ['solution-formalization'] },
  ],
};

/** The closed contract corpus of this workshop (data, order-stable). */
export const DISCOVERY_PRODUCT_CONTRACTS: readonly ProductContract[] = [
  IDEA_INTAKE_CONTRACT,
  BRIEF_CONTRACT,
  INTENT_CONTRACT,
];

/* ------------------------------------------------------------------ */
/* Sealed products (content-addressed values)                          */
/* ------------------------------------------------------------------ */

/** A sealed product: the value plus its recomputed content address. */
export interface SealedProduct {
  readonly schemaVersion: string;
  readonly ref: string;
  readonly digest: string;
  readonly value: Record<string, unknown>;
}

/** Seal a product value: digest recomputed over the canonical content. */
export function sealProduct(value: Record<string, unknown>): SealedProduct {
  const digest = sha256OfCanonical(value);
  return { schemaVersion: String(value.schemaVersion ?? ''), ref: `sha256:${digest}`, digest, value };
}

/** True iff the wrapper's declared address equals the recomputed one. */
export function verifyProductAddress(product: SealedProduct): boolean {
  return sha256OfCanonical(product.value) === product.digest && product.ref === `sha256:${product.digest}`;
}

/* ------------------------------------------------------------------ */
/* Typed validation (closed refusal set, deterministic, total)         */
/* ------------------------------------------------------------------ */

export type ProductRefusalReason =
  | 'WRONG_VERSION'
  | 'MISSING_FIELD'
  | 'EMPTY_VALUE'
  | 'WRONG_TYPE'
  | 'ENUM_VIOLATION'
  | 'PATTERN_VIOLATION'
  | 'ADDRESS_MISMATCH';

export interface ProductRefusal {
  readonly refused: true;
  readonly reason: ProductRefusalReason;
  /** The exact field (or '<product>') the refusal names - never vague. */
  readonly field: string;
  readonly detail: string;
}

export type ProductValidation =
  | { readonly ok: true; readonly contract: ProductContract }
  | ProductRefusal;

/** The contract of one schema version, or undefined (unknown version). */
export function productContractOf(schemaVersion: string): ProductContract | undefined {
  return DISCOVERY_PRODUCT_CONTRACTS.find((contract) => contract.schemaVersion === schemaVersion);
}

/**
 * Validate one product value against the closed contract corpus. The
 * schemaVersion selects the contract (an unknown version is refused
 * WRONG_VERSION - the schema-bypass fence); every declared field is then
 * checked deterministically in declaration order.
 */
export function validateProduct(value: unknown): ProductValidation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { refused: true, reason: 'WRONG_TYPE', field: '<product>', detail: `a product must be an object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}` };
  }
  const record = value as Record<string, unknown>;
  const version = record.schemaVersion;
  if (typeof version !== 'string' || version.length === 0) {
    return { refused: true, reason: 'MISSING_FIELD', field: 'schemaVersion', detail: 'a product carries its schemaVersion (the version selects the contract)' };
  }
  const contract = productContractOf(version);
  if (contract === undefined) {
    return { refused: true, reason: 'WRONG_VERSION', field: 'schemaVersion', detail: `product version ${version} is outside the installed contract corpus (stale or foreign product)` };
  }
  for (const field of contract.fields) {
    const present = Object.prototype.hasOwnProperty.call(record, field.name);
    const raw = record[field.name];
    if (!present || raw === undefined) {
      if (field.required) {
        return { refused: true, reason: 'MISSING_FIELD', field: field.name, detail: `${contract.contractId} requires ${field.name}` };
      }
      continue;
    }
    if (field.type === 'string') {
      if (typeof raw !== 'string') {
        return { refused: true, reason: 'WRONG_TYPE', field: field.name, detail: `${field.name} must be a string, got ${typeof raw}` };
      }
      if (raw.length < field.minLength) {
        return { refused: true, reason: 'EMPTY_VALUE', field: field.name, detail: `${field.name} must hold at least ${field.minLength} characters (${raw.length})` };
      }
      if (field.enumValues !== undefined && !field.enumValues.includes(raw)) {
        return { refused: true, reason: 'ENUM_VIOLATION', field: field.name, detail: `${field.name} must be one of ${field.enumValues.join('|')}, got ${raw}` };
      }
      if (field.pattern !== undefined && !new RegExp(field.pattern).test(raw)) {
        return { refused: true, reason: 'PATTERN_VIOLATION', field: field.name, detail: `${field.name} must match ${field.pattern}, got ${raw}` };
      }
    } else {
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
        return { refused: true, reason: 'WRONG_TYPE', field: field.name, detail: `${field.name} must be a string array` };
      }
      if ((raw as unknown[]).length < field.minLength) {
        return { refused: true, reason: 'EMPTY_VALUE', field: field.name, detail: `${field.name} must hold at least ${field.minLength} entries (${(raw as unknown[]).length})` };
      }
    }
  }
  return { ok: true, contract };
}

/**
 * Validate a SEALED product: shape first, then the recomputed content
 * address. The declared digest is never trusted (BYTES-style corruption is
 * a typed ADDRESS_MISMATCH, never a pass).
 */
export function validateSealedProduct(product: SealedProduct): ProductValidation {
  const shape = validateProduct(product.value);
  if ('refused' in shape) {
    return shape;
  }
  if (!verifyProductAddress(product)) {
    return { refused: true, reason: 'ADDRESS_MISMATCH', field: '<product>', detail: `the declared address ${product.ref} does not verify against the recomputed canonical digest` };
  }
  return shape;
}

/** The content address a product contract itself hashes to (manifest pin). */
export function productContractRef(contract: ProductContract): string {
  return `sha256:${sha256OfCanonical(contract)}`;
}
