/**
 * Canonical SRS file-identity manifest (BM-5 / MM-4 repair, 2026-08-24;
 * Red-Team correction follow-up same day).
 *
 * The Elite-8 counterexample (docs/factory-map/BRIDGE_MATRIX.md §4) proved
 * that per-consumer path parsing is not an identity: the same physical file
 * was §2.2 `index.html` (bare filename), §D2 `frontend/index.html` (full
 * path), a `frontend/` requiredChangeScope and an AC `files:` binding — four
 * identities, no jointly satisfying plan, SRS frozen. This module is the ONE
 * canonical normalized file-identity surface every consumer derives from:
 *
 *   - `extractSrsFileSurface` — the §D2 AC Map `files:` values + §D1
 *     Canonical File/Module Surface backticked paths (the authority: scopes
 *     are derived from it and §D2 is the machine-checked AC contract);
 *   - `buildSrsFileIdentityManifest` — §2.2 Module Manifest tokens resolved
 *     against that surface by SEGMENT-ALIGNED SUFFIX match:
 *       exact             token is verbatim on the surface;
 *       module-relative   exactly one surface path ends with the token's
 *                         full segment sequence — the surface path extends
 *                         the token's directory structure (a bare filename
 *                         is the degenerate repo-root-relative case; a
 *                         multi-segment token such as `data/categories.js`
 *                         matches only a surface path ending in
 *                         `…/data/categories.js` — workshop P08 "Owned
 *                         Surfaces"). Suffix segments must align on
 *                         path-segment boundaries, so a typo'd prefix
 *                         (`s/engine.js`) never matches `js/engine.js`;
 *       ambiguous         ≥2 surface files are segment-aligned matches —
 *                         NO single file identity exists; the conjunction
 *                         of §2.2 coverage with the §D2/§D1 surface is
 *                         UNSATISFIABLE and the decision carries the
 *                         candidate paths as witnesses;
 *       not-on-surface    the token declares an additional file; coverage
 *                         evaluates the token as declared (legacy
 *                         semantics). A multi-segment token whose basename
 *                         coincides with a surface file but whose directory
 *                         structure does NOT extend it (§2.2
 *                         `admin/index.html` vs surface
 *                         `frontend/index.html`) lands here too — the
 *                         Red-Team masking correction: a bare-basename match
 *                         must never silently re-identify a token that
 *                         declares a different directory.
 *
 * DIRECTORY-SHAPED TOKENS (`js/`): the §D2/§D1 FILE surface is a
 * file-identity surface only. A trailing-slash token is SCOPE vocabulary,
 * not a file identity — `parseRepositoryFilePath` rejects it, so it is
 * deterministically EXCLUDED from the surface, mirroring the §2.2 parser's
 * FILE_LIKE filter (files carry extensions; `srs-module-manifest.ts` never
 * emits a directory token as a manifest file). This is a deliberate
 * non-broadening: a `js/` declaration can never satisfy, conflict with, or
 * mask a §2.2 file identity, and it never widens into file authority.
 *
 * Everything is PURE: the manifest is a deterministic function of the frozen
 * SRS content hash, so "frozen upstream" needs no new persisted state — the
 * SRS IS the frozen artifact and this module is its one canonical
 * interpretation. `srs-derived-change-scopes.ts` and the task-graph gate
 * both derive from HERE; no consumer re-parses §D2/§D1/§2.2 on its own.
 */

import { parseSrsModuleManifest } from './srs-module-manifest.js';
import { parseRepositoryFilePath } from '../../../shared/repository-scope.js';

const FENCED_BLOCK = /```[a-z]*[ \t]*\r?\n([\s\S]*?)```/gi;
const BACKTICKED_TOKEN = /`([^`\n]+)`/g;
const FILE_EXTENSION
  = /\.(?:html?|css|scss|less|js|mjs|cjs|ts|tsx|jsx|json|jsonc|md|markdown|ya?ml|toml|ini|cfg|conf|env|xml|svg|png|jpe?g|gif|webp|ico|txt|csv|tsv|py|rb|go|rs|java|kt|kts|c|h|hpp|cpp|cc|cs|php|sh|bash|zsh|ps1|bat|cmd|sql|graphql|proto|wasm)$/i;
const PATH_CHARACTERS = /^[A-Za-z0-9._\-/]+$/;
const D2_HEADING = /(?:§\s*D[.-]?2\b)|(?:\bAC\s*(?:Map|Mapping|Decomposition))/i;
const D1_HEADING = /(?:§\s*D[.-]?1\b)|(?:canonical\s+file)/i;

export interface Section {
  readonly heading: string;
  readonly level: number;
  readonly body: string;
}

interface SectionBuffer {
  readonly heading: string;
  readonly level: number;
  readonly lines: string[];
}

/**
 * Split markdown into (heading, body) sections. Every heading starts a new
 * section whose body runs until the next heading of the same or a shallower
 * level (a `### 3.1` body therefore ends at the next `##`).
 */
export function splitSections(content: string): Section[] {
  const lines = content.split(/\r?\n/);
  const sections: Section[] = [];
  const stack: SectionBuffer[] = [];
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
        const closed = stack.pop()!;
        sections.push({
          heading: closed.heading,
          level: closed.level,
          body: closed.lines.join('\n'),
        });
      }
      stack.push({ heading: heading[2] ?? '', level, lines: [line] });
      continue;
    }
    if (stack.length === 0) {
      // Preamble before the first heading — keep it addressable so heading
      // variants that live at level 1 are not the only extraction source.
      stack.push({ heading: '', level: 1, lines: [line] });
      continue;
    }
    stack[stack.length - 1]!.lines.push(line);
  }
  while (stack.length > 0) {
    const closed = stack.pop()!;
    sections.push({
      heading: closed.heading,
      level: closed.level,
      body: closed.lines.join('\n'),
    });
  }
  return sections;
}

/**
 * Return the matched sections together with their full subsection trees: a
 * matched `## 3. Test Strategy` also yields `### 3.1`, `### 3.2`, ... until
 * the next same-or-shallower heading.
 */
export function sectionSubtrees(
  sections: readonly Section[],
  headingTest: RegExp,
): Section[] {
  const collected: Section[] = [];
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]!;
    if (!headingTest.test(section.heading)) continue;
    collected.push(section);
    let cursor = index + 1;
    while (
      cursor < sections.length
      && sections[cursor]!.level > section.level
    ) {
      collected.push(sections[cursor]!);
      cursor += 1;
    }
  }
  return collected;
}

function isPathLike(token: string): boolean {
  const value = token.trim();
  if (value.length === 0 || !PATH_CHARACTERS.test(value)) return false;
  return value.includes('/') || FILE_EXTENSION.test(value);
}

/** Strip quotes and trailing YAML comments from a scalar. */
function cleanScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1)
    || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function splitFlowList(raw: string): string[] {
  let value = cleanScalar(raw);
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  if (value.length === 0) return [];
  return value
    .split(',')
    .map(item => cleanScalar(item))
    .filter(item => item.length > 0);
}

/**
 * Collect `files:` values from YAML AC-map stanzas. Handles flow lists
 * (`files: [a, b]`), bare scalars (`files: index.html`) and block lists
 * (`files:` followed by `  - path` lines).
 */
function collectD2Files(yamlText: string): string[] {
  const lines = yamlText.split(/\r?\n/);
  const files: string[] = [];
  let inFilesBlockList = false;
  for (const line of lines) {
    const filesField = line.match(/^\s{0,8}files\s*:\s*(.*)$/i);
    if (filesField) {
      const value = (filesField[1] ?? '').trim();
      if (value.length === 0) {
        inFilesBlockList = true;
        continue;
      }
      inFilesBlockList = false;
      files.push(...splitFlowList(value));
      continue;
    }
    if (inFilesBlockList) {
      const listItem = line.match(/^\s+-\s+(.+)$/);
      if (listItem) {
        files.push(...splitFlowList(listItem[1] ?? ''));
        continue;
      }
      if (line.trim().length > 0) {
        inFilesBlockList = false;
      }
    }
  }
  return files;
}

function collectBacktickedPaths(sectionBody: string): string[] {
  const paths: string[] = [];
  for (const match of sectionBody.matchAll(BACKTICKED_TOKEN)) {
    const token = match[1] ?? '';
    if (isPathLike(token)) {
      paths.push(token.trim());
    }
  }
  return paths;
}

/** Normalize one declared path token to its canonical repository form. */
function normalizeDeclaredPath(token: string): string | null {
  const normalized = token.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.length === 0) return null;
  try {
    return parseRepositoryFilePath(normalized);
  } catch {
    return null;
  }
}

/**
 * Collect the declared §D2/§D1 file paths (normalized, validated, de-duped,
 * in first-seen order). §2.2 is deliberately NOT a source of the surface —
 * its "Owned Surfaces" may be module-relative; the surface is the authority
 * §2.2 tokens are RESOLVED against. `wholeContent` is the fallback scan
 * source when no §D2 heading is found (same behavior as the historical
 * derivation: AC-map stanzas anywhere in the document then count).
 */
export function collectSrsSurfacePaths(
  sections: readonly Section[],
  wholeContent: string,
): string[] {
  const declared: string[] = [];

  // §D2 AC Map — the canonical machine-checked contract.
  const d2Sections = sectionSubtrees(sections, D2_HEADING);
  const yamlSources = d2Sections.length > 0
    ? d2Sections.map(section => section.body)
    : [wholeContent];
  for (const source of yamlSources) {
    for (const block of source.matchAll(FENCED_BLOCK)) {
      const yaml = block[1] ?? '';
      // Only fenced blocks that actually carry AC-map stanzas contribute.
      if (/^\s*-\s+ac\s*:/im.test(yaml)) {
        declared.push(...collectD2Files(yaml));
      }
    }
  }

  // §D1 Canonical File/Module Surface table.
  for (const surfaceSection of sectionSubtrees(sections, D1_HEADING)) {
    declared.push(...collectBacktickedPaths(surfaceSection.body));
  }

  const seen = new Set<string>();
  const surface: string[] = [];
  for (const token of declared) {
    const normalized = normalizeDeclaredPath(token);
    // `null` covers BOTH malformed paths and DIRECTORY-shaped tokens
    // (`js/`, trailing slash): parseRepositoryFilePath rejects them, so a
    // scope-vocabulary token never becomes a file identity (documented
    // non-broadening — see the module header). It is dropped from the
    // surface entirely: it cannot satisfy, conflict with, or mask any §2.2
    // file identity downstream.
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    surface.push(normalized);
  }
  return surface.sort();
}

/** The §D2/§D1 file surface of a whole SRS document. */
export function extractSrsFileSurface(content: string): readonly string[] {
  return collectSrsSurfacePaths(splitSections(content), content);
}

export type SrsFileTokenResolutionKind =
  | 'exact'
  | 'module-relative'
  | 'ambiguous'
  | 'not-on-surface';

export interface SrsFileTokenResolution {
  /** The verbatim §2.2 manifest token (normalized separators only). */
  readonly token: string;
  readonly resolution: SrsFileTokenResolutionKind;
  /** The canonical identity for exact/module-relative; null otherwise. */
  readonly identityPath: string | null;
  /** Witness surface paths for an ambiguous resolution. */
  readonly candidates: readonly string[];
}

/**
 * Segment-aligned suffix match: does `path` end with the token's FULL
 * segment sequence? A bare filename (one segment) matches any surface file
 * with that basename; a multi-segment module-relative token
 * (`data/categories.js`) matches only a surface path whose directory
 * structure it extends (`js/data/categories.js`). Alignment is per path
 * segment, so `s/engine.js` never matches `js/engine.js`.
 */
function isSegmentAlignedSuffix(path: string, tokenSegments: readonly string[]): boolean {
  const pathSegments = path.split('/');
  if (pathSegments.length < tokenSegments.length) return false;
  const offset = pathSegments.length - tokenSegments.length;
  return tokenSegments.every(
    (segment, index) => pathSegments[offset + index] === segment,
  );
}

export interface SrsFileIdentityManifest {
  /** Canonical §D2/§D1 declared files (normalized, de-duped). */
  readonly fileSurface: readonly string[];
  /** One resolution per unique §2.2 manifest file token. */
  readonly resolutions: readonly SrsFileTokenResolution[];
  /** The ambiguous subset — each one is a typed, plan-independent conflict. */
  readonly ambiguous: readonly SrsFileTokenResolution[];
}

/**
 * Build the canonical file-identity manifest of an SRS document. Pure; never
 * throws — a §2.2 section that yields no file tokens contributes nothing.
 */
export function buildSrsFileIdentityManifest(
  content: string,
): SrsFileIdentityManifest {
  const fileSurface = extractSrsFileSurface(content);
  const surfaceSet = new Set(fileSurface);

  const manifest = parseSrsModuleManifest(content);
  const tokens = [
    ...manifest.modules.flatMap(entry => entry.files),
    ...manifest.sectionFiles,
  ];

  const seen = new Set<string>();
  const resolutions: SrsFileTokenResolution[] = [];
  for (const rawToken of tokens) {
    const token = normalizeDeclaredPath(rawToken) ?? rawToken.trim();
    if (token.length === 0 || seen.has(token)) continue;
    seen.add(token);
    if (surfaceSet.has(token)) {
      resolutions.push({
        token, resolution: 'exact', identityPath: token, candidates: [],
      });
      continue;
    }
    // Segment-aligned suffix resolution (module-relative "Owned Surfaces",
    // workshop P08). The directory structure the token DECLARES must be one
    // the surface path actually extends — a bare-basename coincidence must
    // not re-identify a token that names a different directory (Red-Team
    // masking correction).
    const tokenSegments = token.split('/');
    const candidates = fileSurface
      .filter(path => isSegmentAlignedSuffix(path, tokenSegments))
      .slice().sort();
    if (candidates.length === 1) {
      resolutions.push({
        token,
        resolution: 'module-relative',
        identityPath: candidates[0]!,
        candidates,
      });
    } else if (candidates.length > 1) {
      resolutions.push({
        token, resolution: 'ambiguous', identityPath: null, candidates,
      });
    } else {
      resolutions.push({
        token, resolution: 'not-on-surface', identityPath: null, candidates: [],
      });
    }
  }
  return {
    fileSurface,
    resolutions,
    ambiguous: resolutions.filter(entry => entry.resolution === 'ambiguous'),
  };
}

/**
 * The canonical coverage path of a §2.2 token under a manifest: the resolved
 * identity when one exists, the token itself otherwise (the caller must have
 * failed the ambiguous conflict already — an ambiguous token has no lawful
 * single identity to evaluate).
 */
export function canonicalTokenPath(
  manifest: SrsFileIdentityManifest,
  token: string,
): string {
  const normalized = normalizeDeclaredPath(token) ?? token.trim();
  const resolution = manifest.resolutions.find(
    entry => entry.token === normalized,
  );
  return resolution?.identityPath ?? normalized;
}
