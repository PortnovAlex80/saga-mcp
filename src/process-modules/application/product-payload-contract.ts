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

  private key(input: {
    schemaId: string;
    contractId: string;
    version: string;
    contractDigest: string;
  }): string {
    return [input.schemaId, input.contractId, input.version, input.contractDigest].join('\u0000');
  }

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
    const key = this.key(contract);
    const existing = this.contracts.get(key);
    if (existing) {
      if (
        existing === contract
        || existing.validate === contract.validate
      ) return;
      throw new Error(
        `PRODUCT_PAYLOAD_CONTRACT_IMPLEMENTATION_DRIFT: ${contract.schemaId} `
        + `${contract.contractId}@${contract.version}#${contract.contractDigest}`,
      );
    }
    this.contracts.set(key, contract);
  }

  validate(schemaId: string, payload: unknown): ProductPayloadValidation {
    const matches = [...this.contracts.values()]
      .filter(contract => contract.schemaId === schemaId);
    if (matches.length !== 1) {
      return { registered: false, accepted: true, errors: [], contractDigest: null };
    }
    const contract = matches[0]!;
    const errors = [...contract.validate(payload)];
    return {
      registered: true,
      accepted: errors.length === 0,
      errors,
      contractDigest: contract.contractDigest,
    };
  }

  resolveExact(
    schemaId: string,
    expected: ProductPayloadContractRef,
  ): ProductPayloadContract | null {
    return this.contracts.get(this.key({ schemaId, ...expected })) ?? null;
  }

  resolveUnique(schemaId: string): ProductPayloadContract | null {
    const matches = [...this.contracts.values()]
      .filter(contract => contract.schemaId === schemaId);
    return matches.length === 1 ? matches[0]! : null;
  }

  snapshot(): readonly (ProductPayloadContractRef & { readonly schemaId: string })[] {
    return [...this.contracts.values()]
      .map(contract => ({
        contractId: contract.contractId,
        version: contract.version,
        contractDigest: contract.contractDigest,
        schemaId: contract.schemaId,
      }))
      .sort((a, b) => a.schemaId.localeCompare(b.schemaId));
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

export function snapshotProductPayloadContracts(): readonly (ProductPayloadContractRef & {
  readonly schemaId: string;
})[] {
  return registry.snapshot();
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
  return registry.resolveUnique(schemaId);
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
  const contract = registry.resolveExact(schemaId, expected);
  if (!contract) {
    throw new Error(
      `PRODUCT_PAYLOAD_CONTRACT_DRIFT: ${schemaId}; exact registration required; expected `
      + `${expected.contractId}@${expected.version}#${expected.contractDigest}`,
    );
  }
  const errors = [...contract.validate(payload)];
  if (errors.length > 0) {
    throw new Error(
      `PRODUCT_PAYLOAD_CONTRACT_REJECTED: ${schemaId}: ${errors.join('; ')}`,
    );
  }
}
