import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function digestJson(value: unknown): string {
  return sha256(canonicalJson(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      result[key] = sortValue(input[key]);
    }
    return result;
  }
  return value;
}
