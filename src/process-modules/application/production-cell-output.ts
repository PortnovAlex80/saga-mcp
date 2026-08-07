import type { NodeExecutionReceipt } from './node-executor.js';

export const PRODUCTION_CELL_OUTPUT_MANIFEST_SCHEMA =
  'factory.production-cell-output-manifest.v1';

export interface AcceptedProductionCellItem {
  readonly id: string;
  readonly workKey: string;
  readonly workplaceRef: string;
  readonly candidateSetRef: string;
  readonly producerExecutionRef: string;
  readonly execution: {
    readonly intentId: number;
    readonly taskId: number;
    readonly executionRef: string;
  };
  readonly products: readonly {
    readonly schemaId: string;
    readonly ref: string;
    readonly digest: string;
  }[];
}

/**
 * Read the exact accepted items emitted by a Production Cell node.
 *
 * This is the only adapter needed by downstream module kernels that still need
 * the physical producer identity to dereference module-owned durable products.
 * They consume the accepted Cell manifest; they never consume a standalone LM
 * receipt or infer the producer from a task projection.
 */
export function requireAcceptedProductionCellItems(
  value: unknown,
  consumerId: string,
): readonly AcceptedProductionCellItem[] {
  if (!isRecord(value) || value.schema !== PRODUCTION_CELL_OUTPUT_MANIFEST_SCHEMA) {
    throw new Error(
      `${consumerId}: expected ${PRODUCTION_CELL_OUTPUT_MANIFEST_SCHEMA}`,
    );
  }
  const bindings = value.bindings;
  if (!isRecord(bindings) || bindings.final !== true || !Array.isArray(bindings.items)) {
    throw new Error(`${consumerId}: production-cell manifest is not final`);
  }
  const items = bindings.items.map((raw, index) => decodeAcceptedItem(raw, consumerId, index));
  if (items.length === 0) {
    throw new Error(`${consumerId}: production-cell manifest contains no accepted items`);
  }
  return items;
}

/** Singleton convenience for the common authoring cell. */
export function requireAcceptedSingletonCellItem(
  value: unknown,
  consumerId: string,
): AcceptedProductionCellItem {
  const items = requireAcceptedProductionCellItems(value, consumerId);
  if (items.length !== 1) {
    throw new Error(
      `${consumerId}: expected one accepted Production Cell item, got ${items.length}`,
    );
  }
  return items[0]!;
}

/**
 * Transitional module-internal shape adapter. The physical runtime no longer
 * has an LM node kind; some domain persistence APIs still accept a
 * NodeExecutionReceipt-shaped fence. Build that fence from the accepted Cell
 * manifest rather than exposing a second execution mechanism.
 */
export function acceptedSingletonExecutionReceipt(
  value: unknown,
  consumerId: string,
): NodeExecutionReceipt {
  const item = requireAcceptedSingletonCellItem(value, consumerId);
  return {
    kind: 'task-execution',
    executorKind: 'production-cell',
    intentId: item.execution.intentId,
    taskId: item.execution.taskId,
    executionId: item.execution.executionRef,
    runtimeStatus: 'completed',
    replayed: false,
  };
}

function decodeAcceptedItem(
  value: unknown,
  consumerId: string,
  index: number,
): AcceptedProductionCellItem {
  if (!isRecord(value) || value.accepted !== true) {
    throw new Error(`${consumerId}: cell item ${index} is not accepted`);
  }
  const execution = value.execution;
  const products = value.products;
  if (
    typeof value.id !== 'string'
    || typeof value.workKey !== 'string'
    || typeof value.workplaceRef !== 'string'
    || typeof value.candidateSetRef !== 'string'
    || typeof value.producerExecutionRef !== 'string'
    || !isRecord(execution)
    || !Number.isInteger(execution.intentId)
    || !Number.isInteger(execution.taskId)
    || typeof execution.executionRef !== 'string'
    || execution.executionRef !== value.producerExecutionRef
    || !Array.isArray(products)
  ) {
    throw new Error(`${consumerId}: malformed accepted cell item ${index}`);
  }
  const decodedProducts = products.map((product, productIndex) => {
    if (
      !isRecord(product)
      || typeof product.schemaId !== 'string'
      || typeof product.ref !== 'string'
      || typeof product.digest !== 'string'
    ) {
      throw new Error(
        `${consumerId}: malformed product ${productIndex} in cell item ${index}`,
      );
    }
    return {
      schemaId: product.schemaId,
      ref: product.ref,
      digest: product.digest,
    };
  });
  return {
    id: value.id,
    workKey: value.workKey,
    workplaceRef: value.workplaceRef,
    candidateSetRef: value.candidateSetRef,
    producerExecutionRef: value.producerExecutionRef,
    execution: {
      intentId: execution.intentId as number,
      taskId: execution.taskId as number,
      executionRef: execution.executionRef,
    },
    products: decodedProducts,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
