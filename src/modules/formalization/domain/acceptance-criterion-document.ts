import { createHash } from 'node:crypto';

export interface AtomicAcceptanceCriterion {
  readonly code: string;
  readonly title: string;
  readonly contentHash: string;
}

const HEADING = /^(#{2,3})\s+(AC-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*):\s+(.+?)\s*$/gm;

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
