import { createHash } from 'node:crypto';

export interface AtomicAcceptanceCriterion {
  readonly code: string;
  readonly title: string;
  readonly contentHash: string;
}

const HEADING = /^###\s+(AC-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*):\s+(.+?)\s*$/gm;

/**
 * Converts an accepted AC document into the atomic criteria that downstream
 * contracts reason about. The artifact remains the provenance container; its
 * level-three AC headings are the contract members.
 */
export function parseAtomicAcceptanceCriteria(content: string): readonly AtomicAcceptanceCriterion[] {
  const matches = [...content.matchAll(HEADING)];
  if (matches.length === 0) return [];
  const seen = new Set<string>();
  return matches.map((match, index) => {
    const code = match[1]!.trim();
    if (seen.has(code)) throw new Error(`duplicate atomic acceptance criterion '${code}'`);
    seen.add(code);
    const start = match.index!;
    const end = matches[index + 1]?.index ?? content.length;
    const section = content.slice(start, end).trim();
    return {
      code,
      title: match[2]!.trim(),
      contentHash: createHash('sha256').update(section, 'utf8').digest('hex'),
    };
  });
}
