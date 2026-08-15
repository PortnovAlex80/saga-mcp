/**
 * Strict §D2 YAML-stanza parser shared by submission validation and the
 * Production Cell structural check. The representation is intentionally
 * narrow: one explicit §D2 AC Map/Decomposition section containing exactly
 * one fenced YAML block. Markdown tables and headings such as `D.2 AC-2` are
 * not the canonical contract and must not be guessed into acceptance.
 */

import { SRS_CONTRACT } from '../domain/srs-contract.js';

export interface D2Stanza {
  readonly ac: string;
  readonly fields: ReadonlyMap<string, string>;
}

export interface D2StructuralGap {
  readonly ac: string;
  readonly field: string;
  readonly kind:
    | 'missing-required-field'
    | 'empty-required-field'
    | 'invalid-enum-value'
    | 'invalid-representation'
    | 'duplicate-field'
    | 'duplicate-ac'
    | 'malformed-yaml-line';
  readonly allowedValues?: readonly string[];
  readonly message?: string;
}

interface D2ParseResult {
  readonly stanzas: D2Stanza[];
  readonly gaps: D2StructuralGap[];
}

const CANONICAL_HEADING = /^(#{2,4})\s*§D\.?2\b[^\n]*(?:AC\s*(?:Map|Mapping)|Decomposition)[^\n]*$/gim;
const YAML_BLOCK = /```(?:yaml|yml)\s*\r?\n([\s\S]*?)```/gi;

function cleanScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed.replace(/\s+#.*$/, '').trim();
}

function parseD2(content: string): D2ParseResult {
  const headings = [...content.matchAll(CANONICAL_HEADING)];
  if (headings.length !== 1) {
    return {
      stanzas: [],
      gaps: [{
        ac: '<section>',
        field: '§D2',
        kind: 'invalid-representation',
        message: headings.length === 0
          ? 'Exactly one explicit `§D2 AC Map/Decomposition` heading is required; `D.2 AC-2` is not that section.'
          : `Exactly one §D2 section is required; found ${headings.length}.`,
      }],
    };
  }

  const heading = headings[0]!;
  const headingLevel = heading[1]!.length;
  const bodyStart = heading.index! + heading[0].length;
  const afterHeading = content.slice(bodyStart);
  const nextHeading = afterHeading.match(new RegExp(`\\n#{1,${headingLevel}}\\s`));
  const section = nextHeading
    ? afterHeading.slice(0, nextHeading.index ?? afterHeading.length)
    : afterHeading;
  const yamlBlocks = [...section.matchAll(YAML_BLOCK)];
  if (yamlBlocks.length !== 1) {
    return {
      stanzas: [],
      gaps: [{
        ac: '<section>',
        field: '§D2',
        kind: 'invalid-representation',
        message: `§D2 requires exactly one fenced YAML block; found ${yamlBlocks.length}. Markdown tables are not accepted.`,
      }],
    };
  }

  const outsideYaml = section.replace(YAML_BLOCK, '');
  if (/^\s*-?\s*ac\s*:/mi.test(outsideYaml) || /^\s*\|\s*ac\s*\|/mi.test(outsideYaml)) {
    return {
      stanzas: [],
      gaps: [{
        ac: '<section>',
        field: '§D2',
        kind: 'invalid-representation',
        message: '§D2 mixes YAML with another decomposition representation; keep only the canonical fenced YAML stanzas.',
      }],
    };
  }

  const gaps: D2StructuralGap[] = [];
  const stanzas: D2Stanza[] = [];
  const seenAcs = new Set<string>();
  let currentAc: string | null = null;
  let currentFields = new Map<string, string>();

  const finish = (): void => {
    if (currentAc === null) return;
    if (seenAcs.has(currentAc)) {
      gaps.push({
        ac: currentAc,
        field: 'ac',
        kind: 'duplicate-ac',
        message: `Duplicate §D2 stanza for ${currentAc}. Every frozen AC must appear exactly once.`,
      });
    } else {
      seenAcs.add(currentAc);
    }
    stanzas.push({ ac: currentAc, fields: currentFields });
  };

  const yaml = yamlBlocks[0]![1] ?? '';
  for (const rawLine of yaml.split(/\r?\n/)) {
    if (rawLine.trim() === '' || /^\s*#/.test(rawLine)) continue;
    const stanzaStart = rawLine.match(/^\s*-\s+ac\s*:\s*(.*?)\s*$/i);
    if (stanzaStart) {
      finish();
      currentAc = cleanScalar(stanzaStart[1] ?? '');
      currentFields = new Map([['ac', currentAc]]);
      if (currentAc === '') {
        gaps.push({
          ac: '<empty>',
          field: 'ac',
          kind: 'empty-required-field',
          message: 'A §D2 stanza has an empty `ac` value.',
        });
      }
      continue;
    }
    const field = rawLine.match(/^\s{2,}([a-z][a-z0-9_]*)\s*:\s*(.*?)\s*$/i);
    if (!currentAc || !field) {
      gaps.push({
        ac: currentAc ?? '<section>',
        field: '<syntax>',
        kind: 'malformed-yaml-line',
        message: `Malformed §D2 YAML line: ${rawLine.trim()}`,
      });
      continue;
    }
    const key = field[1]!.toLowerCase();
    if (currentFields.has(key)) {
      gaps.push({
        ac: currentAc,
        field: key,
        kind: 'duplicate-field',
        message: `Duplicate §D2 field \`${key}\` in ${currentAc}.`,
      });
      continue;
    }
    currentFields.set(key, cleanScalar(field[2] ?? ''));
  }
  finish();

  return { stanzas, gaps };
}

export function extractD2Stanzas(content: string): D2Stanza[] {
  const parsed = parseD2(content);
  return parsed.gaps.some(gap => gap.kind === 'invalid-representation')
    ? []
    : parsed.stanzas;
}

export function parseD2CriticalityByAc(
  content: string,
): Map<string, 'blocker' | 'degradable' | 'nice_to_have'> {
  const valid = new Set<string>(SRS_CONTRACT.d2EnumFields.criticality);
  const result = new Map<string, 'blocker' | 'degradable' | 'nice_to_have'>();
  for (const stanza of extractD2Stanzas(content)) {
    const raw = stanza.fields.get('criticality');
    result.set(
      stanza.ac,
      raw && valid.has(raw)
        ? raw as 'blocker' | 'degradable' | 'nice_to_have'
        : 'blocker',
    );
  }
  return result;
}

export function validateD2Structure(content: string): D2StructuralGap[] {
  const parsed = parseD2(content);
  const gaps = [...parsed.gaps];
  const validAcKind = new Set<string>(SRS_CONTRACT.d2EnumFields.ac_kind);
  const validPattern = new Set<string>(SRS_CONTRACT.d2EnumFields.pattern);
  const validCriticality = new Set<string>(SRS_CONTRACT.d2EnumFields.criticality);

  for (const stanza of parsed.stanzas) {
    for (const field of SRS_CONTRACT.d2RequiredFields) {
      if (!stanza.fields.has(field)) {
        gaps.push({ ac: stanza.ac, field, kind: 'missing-required-field' });
      } else if ((stanza.fields.get(field) ?? '').trim() === '') {
        gaps.push({ ac: stanza.ac, field, kind: 'empty-required-field' });
      }
    }
    const enums = [
      ['ac_kind', validAcKind, SRS_CONTRACT.d2EnumFields.ac_kind],
      ['pattern', validPattern, SRS_CONTRACT.d2EnumFields.pattern],
      ['criticality', validCriticality, SRS_CONTRACT.d2EnumFields.criticality],
    ] as const;
    for (const [field, values, allowedValues] of enums) {
      const value = stanza.fields.get(field);
      if (value && !values.has(value)) {
        gaps.push({
          ac: stanza.ac,
          field,
          kind: 'invalid-enum-value',
          allowedValues,
        });
      }
    }
  }
  if (parsed.stanzas.length === 0 && gaps.length === 0) {
    gaps.push({
      ac: '<section>',
      field: 'ac',
      kind: 'invalid-representation',
      message: '§D2 contains no YAML stanzas.',
    });
  }
  return gaps;
}

export function checkDecisionLogSection(content: string): string | null {
  const headingMatch = content.match(/(#{1,4})\s*§?\s*12[^\n]*Decision Log/i)
    ?? content.match(/(#{1,4})\s*.*Decision Log[^\n]*/i);
  if (!headingMatch) return '§12 Decision Log section is missing';
  const headingLevel = headingMatch[1]!.length;
  const afterHeading = content.slice(headingMatch.index! + headingMatch[0].length);
  const nextHeadingMatch = afterHeading.match(new RegExp(`\\n#{1,${headingLevel}}\\s`));
  const sectionBody = nextHeadingMatch
    ? afterHeading.slice(0, nextHeadingMatch.index ?? afterHeading.length)
    : afterHeading;
  const tableHeaderMatch = sectionBody.match(/\|([^\n]*\|)+/);
  if (!tableHeaderMatch) {
    return /#{3,4}\s*Decision\s*\d/i.test(sectionBody)
      ? null
      : '§12 Decision Log has no markdown table or decision entries';
  }
  const headerCells = (tableHeaderMatch[0] ?? '')
    .split('|')
    .map(cell => cell.trim())
    .filter(cell => cell.length > 0 && !/^[-:]+$/.test(cell));
  return headerCells.length < SRS_CONTRACT.decisionLogColumns.length
    ? `§12 Decision Log table has ${headerCells.length} columns, need ≥${SRS_CONTRACT.decisionLogColumns.length}`
    : null;
}
