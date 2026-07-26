import type {
  LifecycleMappingExpression,
  StageBinding,
} from '../domain/lifecycle.js';

export interface LifecycleMappingRuntime {
  projectId: number;
  epicId: number | null;
  lifecycleRunId: number;
  stageId: string;
  initiatedBy: string;
}

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export function mapLifecycleValues(
  mapping: StageBinding['inputMapping'] | NonNullable<StageBinding['outputMapping']>,
  source: Record<string, unknown>,
  runtime: LifecycleMappingRuntime,
): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const [targetPath, expression] of Object.entries(mapping)) {
    setTargetPath(target, targetPath, resolveExpression(expression, source, runtime));
  }
  return target;
}

export function resolveLifecyclePath(
  source: Record<string, unknown>,
  path: string,
): unknown {
  if (path === '$') return source;
  if (!path.startsWith('$.')) {
    throw new Error(
      `LIFECYCLE_MAPPING_INVALID_PATH: '${path}' must be '$' or start with '$.'`,
    );
  }
  const segments = path.slice(2).split('.');
  let cursor: unknown = source;
  for (const segment of segments) {
    if (
      !segment
      || UNSAFE_PATH_SEGMENTS.has(segment)
      || !isRecord(cursor)
      || !Object.hasOwn(cursor, segment)
    ) {
      throw new Error(`LIFECYCLE_MAPPING_SOURCE_MISSING: '${path}'`);
    }
    cursor = cursor[segment];
  }
  return cloneJson(cursor);
}

function resolveExpression(
  expression: LifecycleMappingExpression,
  source: Record<string, unknown>,
  runtime: LifecycleMappingRuntime,
): unknown {
  if (typeof expression === 'string') {
    return resolveLifecyclePath(source, expression);
  }
  if ('literal' in expression) return cloneJson(expression.literal);
  return runtime[expression.runtime];
}

function setTargetPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = path.split('.');
  if (segments.some(segment => !segment || UNSAFE_PATH_SEGMENTS.has(segment))) {
    throw new Error(`LIFECYCLE_MAPPING_INVALID_TARGET: '${path}'`);
  }
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!segment) throw new Error(`LIFECYCLE_MAPPING_INVALID_TARGET: '${path}'`);
    if (!Object.hasOwn(cursor, segment)) {
      const nested: Record<string, unknown> = {};
      cursor[segment] = nested;
      cursor = nested;
      continue;
    }
    const existing = cursor[segment];
    if (!isRecord(existing)) {
      throw new Error(`LIFECYCLE_MAPPING_TARGET_COLLISION: '${path}'`);
    }
    cursor = existing;
  }
  const finalSegment = segments[segments.length - 1];
  if (!finalSegment) throw new Error(`LIFECYCLE_MAPPING_INVALID_TARGET: '${path}'`);
  if (Object.hasOwn(cursor, finalSegment)) {
    throw new Error(`LIFECYCLE_MAPPING_TARGET_DUPLICATE: '${path}'`);
  }
  cursor[finalSegment] = cloneJson(value);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) {
    throw new Error('LIFECYCLE_MAPPING_VALUE_UNDEFINED');
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
