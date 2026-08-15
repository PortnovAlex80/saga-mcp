import { createHash } from 'node:crypto';

export interface AtomicAcceptanceCriterion {
  readonly code: string;
  readonly title: string;
  readonly contentHash: string;
}

// Acceptance criterion codes are hierarchical identifiers, not numeric-only
// ordinals. Each segment may contain hyphens (for example AC-NFR-1.1), and the
// same grammar must be accepted anywhere the conveyor reads AC headings.
const HEADING = /^(#{2,3})\s+(AC-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*):\s+(.+?)\s*$/gm;

/**
 * Converts an accepted AC document into the atomic criteria that downstream
 * contracts reason about. The artifact remains the provenance container; its
 * level-three AC headings are the contract members.
 */
export function parseAtomicAcceptanceCriteria(content: string): readonly AtomicAcceptanceCriterion[] {
  const allMatches = [...content.matchAll(HEADING)];
  if (allMatches.length === 0) return [];
  // A document may use `## AC-1` as the atomic criterion, or as a group for
  // `### AC-1.1` members. Keep only leaves so both forms have one unambiguous
  // downstream cardinality.
  const matches = allMatches.filter(candidate => {
    const code = candidate[2]!;
    return !allMatches.some(other => other !== candidate && other[2]!.startsWith(`${code}.`));
  });
  const seen = new Set<string>();
  return matches.map((match, index) => {
    const code = match[2]!.trim();
    if (seen.has(code)) throw new Error(`duplicate atomic acceptance criterion '${code}'`);
    seen.add(code);
    const start = match.index!;
    const end = matches[index + 1]?.index ?? content.length;
    const section = content.slice(start, end).trim();
    return {
      code,
      title: match[3]!.trim(),
      contentHash: createHash('sha256').update(section, 'utf8').digest('hex'),
    };
  });
}

/**
 * Resolves the members represented by one accepted artifact. A container
 * artifact such as `AC` owns every leaf in its document. An atomic artifact
 * such as `AC-3` may point at an anchor in a shared document and owns only the
 * matching leaf; parsing the whole shared file once per artifact would
 * multiply the same contract members.
 */
export function acceptanceCriteriaForArtifact(
  content: string,
  artifactCode: string | null,
): readonly AtomicAcceptanceCriterion[] {
  const parsed = parseAtomicAcceptanceCriteria(content);
  if (parsed.length === 0 || !artifactCode || !/^AC-/i.test(artifactCode)) return parsed;
  const exact = parsed.filter(item => item.code === artifactCode);
  if (exact.length !== 1) {
    throw new Error(`atomic acceptance artifact '${artifactCode}' has no matching document heading`);
  }
  return exact;
}
