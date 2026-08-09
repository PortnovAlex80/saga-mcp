/**
 * Pure §D2 YAML parser — shared between the SRS submission validator and the
 * SRS structural CheckProvider.
 *
 * This module has NO I/O and NO dependencies on the database or filesystem.
 * It operates on the SRS markdown document as a string and extracts structured
 * §D2 stanza data (the AC → implementation map).
 *
 * Extracted from srs-contract-validator.ts so that both the worker_done
 * preflight validator AND the Production Cell CheckProvider use the SAME
 * parser — no divergence between "what the validator checks" and "what the
 * gate checks".
 */

import { SRS_CONTRACT } from '../domain/srs-contract.js';

/**
 * One parsed §D2 stanza: the AC code + a map of field name → scalar value.
 * Nested list/block values (e.g. conflict_keys entries) are not captured —
 * only top-level scalar fields, which is sufficient for structural validation
 * (field presence + enum membership).
 */
export interface D2Stanza {
  readonly ac: string;
  readonly fields: ReadonlyMap<string, string>;
}

/**
 * Extract §D2 stanzas from the SRS markdown content. Returns one D2Stanza per
 * `- ac:` list item found inside the §D2 fenced code block.
 *
 * Parsing strategy:
 *   1. Locate the §D2 section header (## or ### containing "D2").
 *   2. Find the fenced code block (```yaml ... ```) within that section.
 *   3. Split the YAML on top-level `- ac:` markers.
 *   4. Parse `key: value` lines within each stanza (scalar values only).
 */
export function extractD2Stanzas(content: string): D2Stanza[] {
  // Accept both "D2" and "D.2" heading variants — LLMs frequently write §D.2
  // (matching the natural decimal notation) which is semantically identical.
  const sectionStart = content.search(/#{2,4}\s*§?\s*D\.?2\b/);
  if (sectionStart === -1) return [];
  const afterStart = content.slice(sectionStart);
  const nextHeaderMatch = afterStart.slice(afterStart.indexOf('\n')).match(/\n#{2,4}\s/);
  const sectionText = nextHeaderMatch
    ? afterStart.slice(0, afterStart.indexOf('\n') + (nextHeaderMatch.index ?? 0))
    : afterStart;
  const codeBlockMatch = sectionText.match(/```[a-z]*\n([\s\S]*?)```/i);
  if (!codeBlockMatch) return [];
  const yaml = codeBlockMatch[1] ?? '';
  const lines = yaml.split('\n');
  const stanzas: D2Stanza[] = [];
  let currentAc: string | null = null;
  let currentFields: Map<string, string> = new Map();
  for (const line of lines) {
    const stanzaStart = line.match(/^-\s+ac:\s*(\S+)/);
    if (stanzaStart) {
      if (currentAc) {
        stanzas.push({ ac: currentAc, fields: currentFields });
      }
      currentAc = stanzaStart[1]!.replace(/["']/g, '');
      currentFields = new Map();
      currentFields.set('ac', currentAc);
      continue;
    }
    if (currentAc) {
      const fieldMatch = line.match(/^\s+(\w[\w_]*)\s*:\s*(.*)$/);
      if (fieldMatch) {
        const [, key, rawValue] = fieldMatch;
        const value = (rawValue ?? '').trim().replace(/["']/g, '').replace(/#.*$/, '').trim();
        if (!currentFields.has(key!)) {
          currentFields.set(key!, value);
        }
      }
    }
  }
  if (currentAc) {
    stanzas.push({ ac: currentAc, fields: currentFields });
  }
  return stanzas;
}

/**
 * Build a Map of AC code → criticality value from the §D2 stanzas in an SRS
 * document. Values not in the canonical criticality enum default to 'blocker'
 * (conservative: treat unclassifiable as mandatory).
 *
 * This is the authoritative source of criticality for the Production Cell
 * decision policy — NOT mutable AC tags (T2.1A forbids tag mutation after
 * baseline freeze). The architect records criticality in §D2 (its own product);
 * the gate reads it here.
 *
 * @param content - the full SRS markdown document text
 * @returns Map<string, 'blocker' | 'degradable' | 'nice_to_have'>
 */
export function parseD2CriticalityByAc(
  content: string,
): Map<string, 'blocker' | 'degradable' | 'nice_to_have'> {
  const validCriticality = new Set<string>(SRS_CONTRACT.d2EnumFields.criticality);
  const result = new Map<string, 'blocker' | 'degradable' | 'nice_to_have'>();
  const stanzas = extractD2Stanzas(content);
  for (const stanza of stanzas) {
    const raw = stanza.fields.get('criticality');
    if (raw && validCriticality.has(raw)) {
      result.set(stanza.ac, raw as 'blocker' | 'degradable' | 'nice_to_have');
    } else {
      result.set(stanza.ac, 'blocker');
    }
  }
  return result;
}

/**
 * Validate the structural completeness of §D2 stanzas against the canonical
 * contract. Returns a list of structural gaps (empty = valid).
 *
 * Each gap describes one missing required field or one invalid enum value.
 * This is the same logic the SRS submission validator uses — extracted here
 * so the CheckProvider can reuse it without duplicating the rules.
 */
export interface D2StructuralGap {
  readonly ac: string;
  readonly field: string;
  readonly kind: 'missing-required-field' | 'invalid-enum-value';
  readonly allowedValues?: readonly string[];
}

export function validateD2Structure(content: string): D2StructuralGap[] {
  const gaps: D2StructuralGap[] = [];
  const stanzas = extractD2Stanzas(content);
  const validAcKind = new Set<string>(SRS_CONTRACT.d2EnumFields.ac_kind);
  const validPattern = new Set<string>(SRS_CONTRACT.d2EnumFields.pattern);
  const validCriticality = new Set<string>(SRS_CONTRACT.d2EnumFields.criticality);

  for (const stanza of stanzas) {
    for (const field of SRS_CONTRACT.d2RequiredFields) {
      if (!stanza.fields.has(field)) {
        gaps.push({ ac: stanza.ac, field, kind: 'missing-required-field' });
      }
    }
    const acKind = stanza.fields.get('ac_kind');
    if (acKind && !validAcKind.has(acKind)) {
      gaps.push({
        ac: stanza.ac,
        field: 'ac_kind',
        kind: 'invalid-enum-value',
        allowedValues: SRS_CONTRACT.d2EnumFields.ac_kind,
      });
    }
    const pattern = stanza.fields.get('pattern');
    if (pattern && !validPattern.has(pattern)) {
      gaps.push({
        ac: stanza.ac,
        field: 'pattern',
        kind: 'invalid-enum-value',
        allowedValues: SRS_CONTRACT.d2EnumFields.pattern,
      });
    }
    const criticality = stanza.fields.get('criticality');
    if (criticality && !validCriticality.has(criticality)) {
      gaps.push({
        ac: stanza.ac,
        field: 'criticality',
        kind: 'invalid-enum-value',
        allowedValues: SRS_CONTRACT.d2EnumFields.criticality,
      });
    }
  }
  return gaps;
}

/**
 * Check whether the §12 Decision Log section exists in the SRS document and
 * has a table with at least the canonical number of columns.
 *
 * Returns null if valid, or a string describing the gap.
 */
export function checkDecisionLogSection(content: string): string | null {
  // The §12 heading may appear at different markdown levels (##, ###). Capture
  // the section body up to the next heading at the SAME or HIGHER level.
  // The previous regex's look-ahead `(?=\n##\s)` matched `### Decision 1:`
  // subsections (which start with `##`), producing an empty body even when the
  // section had valid content. Fix: only look ahead to same-or-higher level.
  const headingMatch = content.match(/(#{1,4})\s*§?\s*12[^\n]*Decision Log/i)
    ?? content.match(/(#{1,4})\s*.*Decision Log[^\n]*/i);
  if (!headingMatch) {
    return '§12 Decision Log section is missing';
  }
  const headingLevel = headingMatch[1]!.length;
  const headingStart = headingMatch.index!;
  const afterHeading = content.slice(headingStart + headingMatch[0].length);
  // Section body extends until the next heading at the same or shallower level.
  const nextHeadingRegex = new RegExp(`\\n#{1,${headingLevel}}\\s`);
  const nextHeadingMatch = afterHeading.match(nextHeadingRegex);
  const sectionBody = nextHeadingMatch
    ? afterHeading.slice(0, nextHeadingMatch.index ?? afterHeading.length)
    : afterHeading;
  // Accept either a markdown table (preferred) or subsection-style content
  // (### Decision N: ...). LLMs frequently write subsection format which is
  // semantically valid but has no pipe-delimited table header.
  const tableHeaderMatch = sectionBody.match(/\|([^\n]*\|)+/);
  if (!tableHeaderMatch) {
    // Fallback: check for decision subsections (### Decision N:)
    const subsectionMatch = sectionBody.match(/#{3,4}\s*Decision\s*\d/i);
    if (!subsectionMatch) {
      return '§12 Decision Log has no markdown table or decision entries';
    }
    return null; // subsection format accepted
  }
  const headerCells = (tableHeaderMatch[0] ?? '')
    .split('|')
    .map(cell => cell.trim())
    .filter(cell => cell.length > 0 && !/^[-:]+$/.test(cell));
  if (headerCells.length < SRS_CONTRACT.decisionLogColumns.length) {
    return `§12 Decision Log table has ${headerCells.length} columns, need ≥${SRS_CONTRACT.decisionLogColumns.length}`;
  }
  return null;
}
