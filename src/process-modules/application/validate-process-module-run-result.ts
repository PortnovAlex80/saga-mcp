/**
 * Validation of ProcessModuleRunResult against a ProcessModuleDefinition.
 *
 * P2 enforces the universal RunResult contract (correction v2 #6: output and
 * certificate are separated, mandatory shape). Every executor — legacy-adapter,
 * generic-flow, external, human — returns the same shape, and this validator
 * is the Runtime's gate before the result is written to the ProcessRun row.
 *
 * Rules (no module-specific knowledge — pure contract check):
 *
 *   1. outcome MUST be present and a non-empty string.
 *   2. outcome MUST be one of the module's declared outcome codes.
 *   3. outcome MUST correspond to a terminal outcome declared in the module
 *      (the Runtime only accepts terminal results — a non-terminal outcome is
 *      a contract violation because execute() must drive to a terminal state).
 *   4. output (when present) MUST be a complete ProcessModuleOutput:
 *      { schema, artifactRef, contentHash } — none of the three may be empty.
 *   5. certificate (when present) MUST be a complete ProcessModuleCertificateRef:
 *      { schema, certificateRef, certificateHash }.
 *   6. If the module declares outputContract, the executor SHOULD return an
 *      output whose schema matches it — but this is advisory (the executor may
 *      legitimately return null output, e.g. when the outcome is 'failed').
 *   7. authority: required when a certificate is present (a certificate without
 *      an issuing authority is meaningless). Optional otherwise.
 *   8. A RunResult that is BOTH null output AND null certificate is only valid
 *      for outcomes whose declared description matches a failure/no-output
 *      signal; we flag it as a WARNING, not an error — some modules (pure
 *      human gate) emit neither.
 */

import type {
  ProcessModuleCertificateRef,
  ProcessModuleOutput,
} from '../persistence/process-run.js';
import type { ProcessModuleDefinition } from '../domain/process-module.js';
import type { ProcessModuleRunResult } from './process-module-executor.js';

export interface ProcessModuleRunResultValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const NON_EMPTY = /^\S.*\S$|^\S$/;

function isProcessModuleOutput(value: unknown): value is ProcessModuleOutput {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o.schema === 'string' && NON_EMPTY.test(o.schema)
    && typeof o.artifactRef === 'string' && NON_EMPTY.test(o.artifactRef)
    && typeof o.contentHash === 'string' && NON_EMPTY.test(o.contentHash);
}

function isProcessModuleCertificateRef(value: unknown): value is ProcessModuleCertificateRef {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o.schema === 'string' && NON_EMPTY.test(o.schema)
    && typeof o.certificateRef === 'string' && NON_EMPTY.test(o.certificateRef)
    && typeof o.certificateHash === 'string' && NON_EMPTY.test(o.certificateHash);
}

export function validateProcessModuleRunResult(
  module: ProcessModuleDefinition,
  result: ProcessModuleRunResult,
): ProcessModuleRunResultValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // (1) outcome present
  if (typeof result.outcome !== 'string' || result.outcome.trim() === '') {
    errors.push('ProcessModuleRunResult.outcome must be a non-empty string');
    return { valid: false, errors, warnings };
  }

  // (2)+(3) outcome declared AND terminal
  const declared = module.outcomes.find(o => o.code === result.outcome);
  if (!declared) {
    errors.push(
      `outcome '${result.outcome}' is not declared by module ${module.identity.name}@${module.identity.version}`,
    );
  } else if (!declared.terminal) {
    errors.push(
      `outcome '${result.outcome}' is declared but NOT terminal — execute() must return a terminal outcome`,
    );
  }

  // (4) output shape
  if (result.output !== null && result.output !== undefined) {
    if (!isProcessModuleOutput(result.output)) {
      errors.push(
        'ProcessModuleRunResult.output must be { schema, artifactRef, contentHash } (all non-empty) when present',
      );
    }
  }

  // (5) certificate shape
  if (result.certificate !== null && result.certificate !== undefined) {
    if (!isProcessModuleCertificateRef(result.certificate)) {
      errors.push(
        'ProcessModuleRunResult.certificate must be { schema, certificateRef, certificateHash } (all non-empty) when present',
      );
    }
  }

  // (6) output schema vs module.outputContract (advisory)
  if (result.output && result.output.schema !== module.outputContract.id) {
    warnings.push(
      `output.schema '${result.output.schema}' differs from module.outputContract '${module.outputContract.id}'`,
    );
  }

  // (7) certificate requires authority
  if (result.certificate && (result.authority === null || result.authority === undefined || result.authority.trim() === '')) {
    errors.push(
      'ProcessModuleRunResult.certificate is present but authority is missing — a certificate must name its issuer',
    );
  }

  // (8) both null — warn, do not error
  if ((result.output === null || result.output === undefined)
    && (result.certificate === null || result.certificate === undefined)) {
    warnings.push(
      'ProcessModuleRunResult has neither output nor certificate — confirm this outcome emits no artifact',
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}
