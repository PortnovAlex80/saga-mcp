import { sha256Hex } from '../../shared/canonical-json.js';
import type { ProcessModuleRunResult } from './process-module-executor.js';

export function processRunResultSnapshot(
  result: ProcessModuleRunResult,
): Record<string, unknown> {
  return {
    code: result.outcome,
    outcome: result.outcome,
    authority: result.authority,
    output: result.output,
    certificate: result.certificate,
    outputRef: result.output?.artifactRef ?? result.certificate?.certificateRef ?? null,
    outputHash: result.output?.contentHash ?? result.certificate?.certificateHash ?? null,
    outputSchema: result.output?.schema ?? result.certificate?.schema ?? null,
    certificateRef: result.certificate?.certificateRef ?? null,
    certificateHash: result.certificate?.certificateHash ?? null,
    certificateSchema: result.certificate?.schema ?? null,
  };
}

export function processSettlementDigest(result: ProcessModuleRunResult): string {
  return sha256Hex(processRunResultSnapshot(result));
}
