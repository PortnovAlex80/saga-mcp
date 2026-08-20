import { sha256Hex } from '../../../shared/canonical-json.js';
import type {
  FormalizationArtifactSnapshot,
  FormalizationCanonicalGraphPort,
  FormalizationTraceSnapshot,
} from '../domain/formalization-kernel-ports.js';

export interface ContractSnapshot {
  readonly artifacts: readonly FormalizationArtifactSnapshot[];
  readonly traces: readonly FormalizationTraceSnapshot[];
  readonly targetArtifacts: readonly FormalizationArtifactSnapshot[];
  readonly artifactHashes: Readonly<Record<string, string>>;
  readonly traceDigest: string;
}

interface ProductCategories {
  prd: FormalizationArtifactSnapshot[];
  frs: FormalizationArtifactSnapshot[];
  nfrs: FormalizationArtifactSnapshot[];
  rules: FormalizationArtifactSnapshot[];
  ucs: FormalizationArtifactSnapshot[];
  acs: FormalizationArtifactSnapshot[];
  srs: FormalizationArtifactSnapshot[];
}

/** Build the exact, content-addressed trace view used by node validators. */
export function buildContractSnapshot(
  graph: FormalizationCanonicalGraphPort,
  artifacts: readonly FormalizationArtifactSnapshot[],
): ContractSnapshot {
  const exact = uniqueArtifacts(artifacts);
  const outgoing = graph.readOutgoingArtifactTraces(idsOf(exact));
  const targetIds = outgoing
    .filter(trace => trace.targetType === 'artifact')
    .map(trace => trace.targetId);
  const targetArtifacts = graph.readArtifactsByIds(targetIds);
  const typeById = new Map([
    ...exact.map(artifact => [artifact.id, artifact.type] as const),
    ...targetArtifacts.map(artifact => [artifact.id, artifact.type] as const),
  ]);
  const sourceTypeById = new Map(exact.map(artifact => [artifact.id, artifact.type]));
  const traces = outgoing.filter(trace => {
    if (trace.targetType !== 'artifact') return false;
    const sourceType = sourceTypeById.get(trace.sourceArtifactId);
    const targetType = typeById.get(trace.targetId);
    return (
      sourceType === 'PRD' && trace.linkType === 'derived_from' && targetType === 'brief'
    ) || (
      sourceType === 'UC'
      && ((trace.linkType === 'derived_from' && targetType === 'PRD')
        || (trace.linkType === 'covers' && targetType === 'FR'))
    ) || (
      sourceType === 'AC'
      && trace.linkType === 'derived_from'
      && (targetType === 'FR' || targetType === 'NFR' || targetType === 'UC')
    ) || (
      sourceType === 'SRS' && trace.linkType === 'derived_from' && targetType === 'PRD'
    );
  }).sort((a, b) => a.id - b.id);
  return {
    artifacts: exact,
    traces,
    targetArtifacts,
    artifactHashes: artifactHashMap(exact),
    traceDigest: sha256Hex(traces),
  };
}

/**
 * The AC-drift coverage ratchet input: the register IDs that must be covered
 * and the IDs validly waived in the brief dispositions. An empty
 * `constraintIds` list is the retro-compatible no-op (empty diff -> green).
 */
export interface ConstraintCoverageRequirement {
  readonly constraintIds: readonly string[];
  readonly waivedIds: readonly string[];
}

/**
 * Normalize an artifact metadata column value: better-sqlite3 returns the
 * JSON column as a string; in-memory fixtures may hand the parsed object.
 * Normalize once at this ingress — consumers only ever see the object form.
 */
function metadataObject(metadata: unknown): Record<string, unknown> | null {
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return metadata as Record<string, unknown>;
}

/** Collect covered_constraint_ids from AC artifact metadata (typed IDs only). */
export function coveredConstraintIdsOfArtifacts(
  artifacts: readonly FormalizationArtifactSnapshot[],
): Set<string> {
  const covered = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.type !== 'AC' || artifact.status === 'superseded') continue;
    const metadata = metadataObject(artifact.metadata);
    if (!metadata) continue;
    const ids = metadata['covered_constraint_ids'];
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === 'string' && id.length > 0) covered.add(id);
    }
  }
  return covered;
}

/**
 * The reverse diff core: register IDs minus covered minus waived, as the raw
 * typed-ID list. Shared by findContractGap (string form) and the worker_done
 * validators (structured per-ID SubmissionGap form) so the gate and the
 * resolver can never disagree.
 */
export function constraintCoverageGapIdList(
  snapshot: ContractSnapshot,
  coverage: ConstraintCoverageRequirement,
): string[] {
  if (coverage.constraintIds.length === 0) return [];
  const covered = coveredConstraintIdsOfArtifacts(snapshot.artifacts);
  const waived = new Set(coverage.waivedIds);
  return coverage.constraintIds
    .filter(id => !covered.has(id) && !waived.has(id));
}

/** The string form of the reverse diff (one line per uncovered ID). */
export function constraintCoverageGapIds(
  snapshot: ContractSnapshot,
  coverage: ConstraintCoverageRequirement,
): string[] {
  return constraintCoverageGapIdList(snapshot, coverage)
    .map(id => `Constraint ${id} is not covered by any AC covered_constraint_ids and not waived in the brief`);
}

/** Validate trace/cardinality obligations over one exact owned material set. */
export function findContractGap(
  snapshot: ContractSnapshot,
  required: {
    product?: boolean;
    useCases?: boolean;
    acceptance?: boolean;
    reconciliation?: boolean;
    architecture?: boolean;
    coverage?: ConstraintCoverageRequirement;
  },
): string | null {
  const categories = categorize(snapshot.artifacts);
  const targetById = new Map([
    ...snapshot.artifacts.map(artifact => [artifact.id, artifact] as const),
    ...snapshot.targetArtifacts.map(artifact => [artifact.id, artifact] as const),
  ]);
  const hasEdge = (
    sourceId: number,
    linkType: string,
    targetType: string,
    allowedTargetIds?: ReadonlySet<number>,
  ): boolean => snapshot.traces.some(trace =>
    trace.sourceArtifactId === sourceId
    && trace.targetType === 'artifact'
    && trace.linkType === linkType
    && targetById.get(trace.targetId)?.type === targetType
    && (!allowedTargetIds || allowedTargetIds.has(trace.targetId)));

  if (required.product) {
    if (categories.prd.length !== 1) return 'contract must contain exactly one PRD';
    if (categories.frs.length === 0) return 'contract must contain at least one FR';
    const productTypes = new Set(['PRD', 'FR', 'NFR', 'RULE', 'UC', 'AC', 'SRS']);
    const prdId = categories.prd[0]!.id;
    const hasRootEdge = snapshot.traces.some(trace =>
      trace.sourceArtifactId === prdId
      && trace.targetType === 'artifact'
      && trace.linkType === 'derived_from'
      && targetById.has(trace.targetId)
      && !productTypes.has(targetById.get(trace.targetId)!.type));
    if (!hasRootEdge) {
      return `PRD ${prdId} has no derived_from → root artifact (brief/decision/discovery-doc) trace`;
    }
  }
  const gaps: string[] = [];
  if (required.useCases) {
    if (categories.ucs.length === 0) return 'contract must contain at least one UC';
    const prdIds = new Set(idsOf(categories.prd));
    const frIds = new Set(idsOf(categories.frs));
    for (const uc of categories.ucs) {
      if (!hasEdge(uc.id, 'derived_from', 'PRD', prdIds)) gaps.push(`UC ${uc.id} has no derived_from → exact PRD trace`);
      if (!hasEdge(uc.id, 'covers', 'FR', frIds)) gaps.push(`UC ${uc.id} has no covers → exact FR trace`);
    }
  }
  if (required.acceptance) {
    if (categories.acs.length === 0) return 'contract must contain at least one AC';
    const frIds = new Set(idsOf(categories.frs));
    const nfrIds = new Set(idsOf(categories.nfrs));
    const ucIds = new Set(idsOf(categories.ucs));
    for (const ac of categories.acs) {
      const hasFr = hasEdge(ac.id, 'derived_from', 'FR', frIds);
      const hasNfr = hasEdge(ac.id, 'derived_from', 'NFR', nfrIds);
      if (!hasFr && !hasNfr) gaps.push(`AC ${ac.id} has no derived_from → exact FR/NFR trace`);
      if (hasFr && !hasEdge(ac.id, 'derived_from', 'UC', ucIds)) {
        gaps.push(`FR-derived AC ${ac.id} has no derived_from → exact UC trace`);
      }
    }
  }
  if (required.reconciliation) {
    // KI-5 reverse coverage: every FR/NFR must have at least one incoming
    // covers or derived_from edge from a UC/AC. Without this, a requirement
    // that no use case covers and no acceptance criterion validates slips
    // through every one-directional gate (live proof: units FR-3 accepted
    // with zero consumers).
    //
    // Checked ONLY in the reconciliation phase (the final catch-all), not in
    // the individual phase gates: during the acceptance phase, the UC set
    // may not yet be complete for all FRs (workers author sequentially).
    // By reconciliation, all artifacts exist and the reverse check is valid.
    const acIds = new Set(idsOf(categories.acs));
    for (const fr of [...categories.frs, ...categories.nfrs]) {
      const coveredByUc = snapshot.traces.some(trace =>
        trace.targetId === fr.id
        && trace.targetType === 'artifact'
        && trace.linkType === 'covers'
        && targetById.get(trace.sourceArtifactId)?.type === 'UC');
      const coveredByAc = snapshot.traces.some(trace =>
        trace.targetId === fr.id
        && trace.targetType === 'artifact'
        && trace.linkType === 'derived_from'
        && targetById.get(trace.sourceArtifactId)?.type === 'AC'
        && acIds.has(trace.sourceArtifactId));
      if (!coveredByUc && !coveredByAc) {
        gaps.push(`FR/NFR ${fr.id} (${fr.code ?? fr.type}) has no incoming covers/derived_from from any UC/AC — orphan requirement`);
      }
    }
  }
  if (required.coverage) {
    // AC-drift reverse coverage: every constraint-register ID must be carried
    // by some AC's covered_constraint_ids metadata or validly waived in the
    // brief. Checked in addition to the downward edges — a graph with perfect
    // AC→FR/NFR traces can still drop the order's constraints entirely.
    for (const gap of constraintCoverageGapIds(snapshot, required.coverage)) {
      gaps.push(gap);
    }
  }
  if (required.architecture) {
    if (categories.srs.length !== 1) return 'contract must contain exactly one SRS';
    const prdIds = new Set(idsOf(categories.prd));
    if (!hasEdge(categories.srs[0]!.id, 'derived_from', 'PRD', prdIds)) {
      return `SRS ${categories.srs[0]!.id} has no derived_from → exact PRD trace`;
    }
  }
  return gaps.length > 0 ? gaps.join('; ') : null;
}

const AC_IMPLEMENTATION_SIGNAL =
  /\b(tests?|testing|build|built|compile|compiled|wrapper|gradle|maven|executable)\b|\b(?:pass|passes|runs?|running|served?)\s+via\b/i;

export function acContentRequiresImplementation(
  artifact: { code?: string | null; title?: string | null },
): boolean {
  return AC_IMPLEMENTATION_SIGNAL.test(`${artifact.code ?? ''} ${artifact.title ?? ''}`);
}

function categorize(artifacts: readonly FormalizationArtifactSnapshot[]): ProductCategories {
  const type = (wanted: string) => artifacts
    .filter(artifact => artifact.type === wanted && artifact.status !== 'superseded')
    .sort((a, b) => a.id - b.id);
  return {
    prd: type('PRD'), frs: type('FR'), nfrs: type('NFR'), rules: type('RULE'),
    ucs: type('UC'), acs: type('AC'), srs: type('SRS'),
  };
}

function artifactHashMap(
  artifacts: readonly FormalizationArtifactSnapshot[],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const artifact of [...artifacts].sort((a, b) => a.id - b.id)) {
    if (!isSha256(artifact.contentHash)) {
      throw new Error(
        `artifact ${artifact.id} has no canonical SHA-256 content hash — the artifact's `
        + 'file did not resolve at update time, so no server-side hash was stamped. '
        + 'Repair: re-run artifact_update with the correct repo-relative path (the file '
        + 'must exist under the project repository) and WITHOUT content_hash — the '
        + 'factory computes the canonical digest from the file on disk; a '
        + 'worker-supplied digest is never trusted.',
      );
    }
    result[String(artifact.id)] = artifact.contentHash;
  }
  return result;
}

function uniqueArtifacts(
  artifacts: readonly FormalizationArtifactSnapshot[],
): readonly FormalizationArtifactSnapshot[] {
  const byId = new Map<number, FormalizationArtifactSnapshot>();
  for (const artifact of artifacts) byId.set(artifact.id, artifact);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function idsOf(items: readonly { id: number }[]): number[] {
  return items.map(item => item.id).sort((a, b) => a - b);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
