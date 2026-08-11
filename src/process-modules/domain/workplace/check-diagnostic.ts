import { canonicalJson, sha256Hex } from '../../../shared/canonical-json.js';

const PREFIX = 'factory-check-diagnostic/v1';

export interface CheckDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly subjectRef?: string;
}

export function encodeCheckDiagnostic(diagnostic: CheckDiagnostic): string {
  const snapshot = canonicalJson({
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.subjectRef ? { subjectRef: diagnostic.subjectRef } : {}),
  });
  return `${PREFIX}/${sha256Hex(snapshot)}/${Buffer.from(snapshot, 'utf8').toString('base64url')}`;
}

export function decodeCheckDiagnostic(ref: string): CheckDiagnostic | null {
  const parts = ref.split('/');
  if (parts.length !== 4 || `${parts[0]}/${parts[1]}` !== PREFIX) return null;
  try {
    const snapshot = Buffer.from(parts[3], 'base64url').toString('utf8');
    if (sha256Hex(snapshot) !== parts[2]) return null;
    const value = JSON.parse(snapshot) as Partial<CheckDiagnostic>;
    if (typeof value.code !== 'string' || value.code.trim().length === 0
        || typeof value.message !== 'string' || value.message.trim().length === 0
        || (value.subjectRef !== undefined && typeof value.subjectRef !== 'string')) return null;
    return {
      code: value.code,
      message: value.message,
      ...(value.subjectRef ? { subjectRef: value.subjectRef } : {}),
    };
  } catch {
    return null;
  }
}
