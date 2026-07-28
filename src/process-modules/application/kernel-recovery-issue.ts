import {
  RECOVERY_ISSUE_SCHEMA,
  type RecoveryDisposition,
  type RecoveryIssue,
  type RecoverySubjectRef,
} from '../domain/recovery.js';
import type {
  KernelHandler,
  KernelHandlerContext,
  KernelHandlerResult,
} from './kernel-handler-registry.js';

export interface KernelRecoveryIssueSpec {
  readonly policyId: string;
  readonly subject: string;
  readonly triggerEvents: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly allowedChanges: readonly string[];
  readonly recoveryEvent?: string;
  readonly reasonBindings?: readonly string[];
  readonly subjectIdBindings?: readonly string[];
  readonly artifactHashesBinding?: string;
  readonly actualBindings?: readonly string[];
  readonly disposition?:
    | RecoveryDisposition
    | ((context: KernelRecoveryDecisionContext) => RecoveryDisposition);
  readonly skip?: (context: KernelRecoveryDecisionContext) => boolean;
  readonly context?: (
    context: KernelRecoveryDecisionContext,
  ) => Readonly<Record<string, unknown>>;
}

export interface KernelRecoveryDecisionContext {
  readonly handlerContext: KernelHandlerContext;
  readonly result: KernelHandlerResult;
  readonly bindings: Readonly<Record<string, unknown>>;
}

/**
 * Standard adapter from a module verifier result to the runtime RecoveryIssue
 * contract. Modules supply vocabulary and policy; the common adapter supplies
 * durable evidence shape, exact subject references and routing metadata.
 */
export function withKernelRecoveryIssue(
  handler: KernelHandler,
  spec: KernelRecoveryIssueSpec,
): KernelHandler {
  return context => {
    const returned = handler(context);
    if (returned instanceof Promise) {
      return returned.then(result =>
        applyKernelRecoveryIssue(context, result, spec));
    }
    return applyKernelRecoveryIssue(context, returned, spec);
  };
}

export function applyKernelRecoveryIssue(
  handlerContext: KernelHandlerContext,
  result: KernelHandlerResult,
  spec: KernelRecoveryIssueSpec,
): KernelHandlerResult {
  if (
    result.recoveryIssue
    || !spec.triggerEvents.includes(result.event)
  ) {
    return result;
  }

  const bindings = result.production.bindings;
  const decisionContext: KernelRecoveryDecisionContext = {
    handlerContext,
    result,
    bindings,
  };
  if (spec.skip?.(decisionContext)) return result;

  const reason = firstMeaningfulBinding(
    bindings,
    spec.reasonBindings
      ?? ['reason', 'gap', 'error', 'errors', 'reasonCodes', 'resolutionStatus'],
    `${spec.subject} emitted ${result.event}`,
  );
  const subjectIds = firstIntegerArray(
    bindings,
    spec.subjectIdBindings
      ?? ['dirtyArtifactIds', 'unacceptedArtifactIds', 'artifactIds'],
  );
  const artifactHashes = recordBinding(
    bindings[spec.artifactHashesBinding ?? 'artifactHashes'],
  );
  const subjectRefs: RecoverySubjectRef[] = subjectIds.length > 0
    ? subjectIds.map(id => ({
        kind: 'artifact',
        ref: `artifact:${id}`,
        contentHash: stringOrNull(artifactHashes[String(id)]),
      }))
    : [{
        kind: 'node-production',
        ref: result.production.artifactRef,
        schema: result.production.schema,
        contentHash: result.production.contentHash,
      }];
  const disposition = typeof spec.disposition === 'function'
    ? spec.disposition(decisionContext)
    : spec.disposition ?? 'repair';
  const actualKeys = spec.actualBindings
    ?? ['gap', 'reason', 'error', 'errors', 'reasonCodes',
      'unacceptedArtifactIds', 'baselineDriftArtifactIds'];
  const actual = pickBindings(bindings, actualKeys);
  const reasonCode = `${spec.policyId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${
    result.event.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  }`;
  const recoveryIssue: RecoveryIssue = {
    schemaVersion: RECOVERY_ISSUE_SCHEMA,
    policyId: spec.policyId,
    disposition,
    reasonCode,
    summary: `Repair ${spec.subject}: ${reason}`,
    findings: [{
      code: result.event,
      severity: 'error',
      message: reason,
      subjectRef: subjectRefs[0]?.ref ?? result.production.artifactRef,
      expected: spec.acceptanceCriteria,
      actual,
      evidenceRefs: [result.production.artifactRef],
    }],
    subjectRefs,
    acceptanceCriteria: spec.acceptanceCriteria,
    allowedChanges: spec.allowedChanges,
    context: {
      processRunId: handlerContext.processRunId,
      originalEvent: result.event,
      verifierNodeId: handlerContext.node.id,
      productionRef: result.production.artifactRef,
      productionHash: result.production.contentHash,
      ...(spec.context?.(decisionContext) ?? {}),
    },
  };

  return {
    ...result,
    event: spec.recoveryEvent ?? 'repair-required',
    recoveryIssue,
  };
}

function firstMeaningfulBinding(
  bindings: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  fallback: string,
): string {
  for (const key of keys) {
    const rendered = renderReason(bindings[key]);
    if (rendered !== null) return rendered;
  }
  return fallback;
}

function renderReason(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (Array.isArray(value) && value.length > 0) {
    const rendered = value
      .map(item => renderReason(item))
      .filter((item): item is string => item !== null);
    return rendered.length > 0 ? rendered.join('; ') : null;
  }
  if (
    value !== null
    && typeof value === 'object'
    && Object.keys(value as Record<string, unknown>).length > 0
  ) {
    return JSON.stringify(value);
  }
  return null;
}

function firstIntegerArray(
  bindings: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): number[] {
  for (const key of keys) {
    const values = integerArray(bindings[key]);
    if (values.length > 0) return values;
  }
  return [];
}

function integerArray(value: unknown): number[] {
  return Array.isArray(value)
    ? [...new Set(value.filter(item => Number.isInteger(item)) as number[])]
        .sort((left, right) => left - right)
    : [];
}

function recordBinding(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function pickBindings(
  bindings: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    keys
      .filter(key => bindings[key] !== undefined)
      .map(key => [key, bindings[key]]),
  );
}
