import { sha256Hex } from '../../shared/canonical-json.js';

export interface ProductPayloadContract {
  readonly schemaId: string;
  readonly contractId: string;
  readonly version: string;
  /** Canonical, data-only description of the executable decoder contract. */
  readonly definition: Readonly<Record<string, unknown>>;
  readonly contractDigest: string;
  validate(payload: unknown): readonly string[];
}

export interface ProductPayloadContractRef {
  readonly contractId: string;
  readonly version: string;
  readonly contractDigest: string;
}

export interface ProductPayloadValidation {
  readonly registered: boolean;
  readonly accepted: boolean;
  readonly errors: readonly string[];
  readonly contractDigest: string | null;
}

/** Executable product contracts contributed by module packages. */
class ProductPayloadContractRegistry {
  private readonly contracts = new Map<string, ProductPayloadContract>();

  register(contract: ProductPayloadContract): void {
    if (!contract.schemaId.trim() || !contract.contractId.trim()
        || !contract.version.trim() || !contract.contractDigest.trim()) {
      throw new Error('PRODUCT_PAYLOAD_CONTRACT_IDENTITY_REQUIRED');
    }
    const expectedDigest = productPayloadContractDigest({
      schemaId: contract.schemaId,
      contractId: contract.contractId,
      version: contract.version,
      definition: contract.definition,
    });
    if (contract.contractDigest !== expectedDigest) {
      throw new Error(`PRODUCT_PAYLOAD_CONTRACT_DIGEST_INVALID: ${contract.schemaId}`);
    }
    const existing = this.contracts.get(contract.schemaId);
    if (existing) {
      if (
        existing.contractId === contract.contractId
        && existing.version === contract.version
        && existing.contractDigest === contract.contractDigest
      ) return;
      throw new Error(`PRODUCT_PAYLOAD_CONTRACT_DUPLICATE: ${contract.schemaId}`);
    }
    this.contracts.set(contract.schemaId, contract);
  }

  validate(schemaId: string, payload: unknown): ProductPayloadValidation {
    const contract = this.contracts.get(schemaId);
    if (!contract) {
      return { registered: false, accepted: true, errors: [], contractDigest: null };
    }
    const errors = [...contract.validate(payload)];
    return {
      registered: true,
      accepted: errors.length === 0,
      errors,
      contractDigest: contract.contractDigest,
    };
  }

  resolve(schemaId: string): ProductPayloadContract | null {
    return this.contracts.get(schemaId) ?? null;
  }
}

const registry = new ProductPayloadContractRegistry();

export function productPayloadContractDigest(input: {
  schemaId: string;
  contractId: string;
  version: string;
  definition: Readonly<Record<string, unknown>>;
}): string {
  return sha256Hex(input);
}

export function registerProductPayloadContract(contract: ProductPayloadContract): void {
  registry.register(contract);
}

export function validateProductPayload(
  schemaId: string,
  payload: unknown,
): ProductPayloadValidation {
  return registry.validate(schemaId, payload);
}

export function resolveProductPayloadContract(
  schemaId: string,
): ProductPayloadContract | null {
  return registry.resolve(schemaId);
}

export function assertProductPayload(schemaId: string, payload: unknown): void {
  const result = validateProductPayload(schemaId, payload);
  if (!result.accepted) {
    throw new Error(
      `PRODUCT_PAYLOAD_CONTRACT_REJECTED: ${schemaId}: ${result.errors.join('; ')}`,
    );
  }
}

/**
 * Validate against the exact contract frozen into the WorkIntent. Unlike the
 * convenience validator above, this boundary is fail-closed: an absent or
 * different process-global registration cannot reinterpret durable work.
 */
export function assertPinnedProductPayload(
  schemaId: string,
  expected: ProductPayloadContractRef,
  payload: unknown,
): void {
  const contract = registry.resolve(schemaId);
  if (!contract) {
    throw new Error(`PRODUCT_PAYLOAD_CONTRACT_REQUIRED: ${schemaId}`);
  }
  if (
    contract.contractId !== expected.contractId
    || contract.version !== expected.version
    || contract.contractDigest !== expected.contractDigest
  ) {
    throw new Error(
      `PRODUCT_PAYLOAD_CONTRACT_DRIFT: ${schemaId}; expected `
      + `${expected.contractId}@${expected.version}#${expected.contractDigest}, got `
      + `${contract.contractId}@${contract.version}#${contract.contractDigest}`,
    );
  }
  const errors = [...contract.validate(payload)];
  if (errors.length > 0) {
    throw new Error(
      `PRODUCT_PAYLOAD_CONTRACT_REJECTED: ${schemaId}: ${errors.join('; ')}`,
    );
  }
}
