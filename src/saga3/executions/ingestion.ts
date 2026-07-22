/**
 * Saga 3 — Worker output ingestion.
 *
 * When a worker completes, it returns a WorkerOutput. The controller
 * ingests this output: writes artifacts to disk + DB, runs observations
 * through oracles, and attaches provenance to evidence.
 *
 * Key principle: the controller attaches provenance — NOT the worker.
 * The worker returns raw artifacts and observations. The controller
 * adds generation, source fingerprint, environment, oracle identity.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  WorkerOutput,
  ArtifactOutput,
  ObservationOutput,
  EvidenceRecord,
  TrustClass,
} from '../domain/types.js';

/**
 * Ingest a worker's artifact output: write to disk + return artifact record.
 */
export function ingestArtifact(
  output: ArtifactOutput,
  repositoryRoot: string,
): { path: string; digest: string; written: boolean } {
  const relativePath = output.path.split('#')[0]; // strip anchor
  const absolute = path.resolve(repositoryRoot, relativePath);

  // Write the file if it doesn't exist (don't clobber sibling anchors).
  let written = false;
  if (!existsSync(absolute) && output.content) {
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, output.content, 'utf8');
    written = true;
  }

  return {
    path: relativePath,
    digest: output.digest || sha256(output.content),
    written,
  };
}

/**
 * Ingest a worker's observation: attach controller provenance and
 * produce an EvidenceRecord.
 *
 * The worker returns a raw observation (command, verdict, raw output).
 * The controller attaches: generation, source fingerprint, environment.
 * This is the bridge between Level 3 (worker) and Level 2 (evidence).
 */
export function ingestObservation(input: {
  readonly observation: ObservationOutput;
  readonly episodeSpecId: string;
  readonly conditionType: string;
  readonly obligationId: string;
  readonly generation: number;
  readonly sourceFingerprint: string;
  readonly environmentFingerprint: string;
  readonly trustClass: TrustClass;
}): EvidenceRecord {
  return {
    id: '', // caller assigns
    episodeSpecId: input.episodeSpecId,
    conditionType: input.conditionType,
    obligationId: input.obligationId,
    generation: input.generation,
    sourceFingerprint: input.sourceFingerprint,
    environmentFingerprint: input.environmentFingerprint,
    oracleId: input.observation.oracleId,
    oracleVersion: input.observation.oracleVersion,
    trustClass: input.trustClass,
    verdict: input.observation.verdict,
    rawDigest: input.observation.rawDigest || sha256(input.observation.stdout),
    observedAt: Date.now(),
    freshnessMaxAgeMs: 24 * 60 * 60 * 1000, // 24h default
  };
}

/**
 * Process a full WorkerOutput: ingest all artifacts + observations.
 */
export function ingestWorkerOutput(input: {
  readonly output: WorkerOutput;
  readonly episodeSpecId: string;
  readonly obligationId: string;
  readonly conditionType: string;
  readonly generation: number;
  readonly sourceFingerprint: string;
  readonly environmentFingerprint: string;
  readonly trustClass: TrustClass;
  readonly repositoryRoot: string;
}): {
  readonly artifacts: ReadonlyArray<{ path: string; digest: string; written: boolean }>;
  readonly evidence: readonly EvidenceRecord[];
} {
  const artifacts = input.output.artifacts.map((a) =>
    ingestArtifact(a, input.repositoryRoot),
  );

  const evidence = input.output.observations.map((obs) =>
    ingestObservation({
      observation: obs,
      episodeSpecId: input.episodeSpecId,
      conditionType: input.conditionType,
      obligationId: input.obligationId,
      generation: input.generation,
      sourceFingerprint: input.sourceFingerprint,
      environmentFingerprint: input.environmentFingerprint,
      trustClass: input.trustClass,
    }),
  );

  return { artifacts, evidence };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
