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

/** Validate trace/cardinality obligations over one exact owned material set. */
export function findContractGap(
  snapshot: ContractSnapshot,
  required: {
    product?: boolean;
    useCases?: boolean;
    acceptance?: boolean;
    architecture?: boolean;
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
      throw new Error(`artifact ${artifact.id} has no canonical SHA-256 content hash`);
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
