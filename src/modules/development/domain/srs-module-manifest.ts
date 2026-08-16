/**
 * SRS §2.2 Module Manifest parsing and plan-coverage evaluation (workshop
 * fix, killed todo project).
 *
 * Nothing anywhere compared the accepted task graph back to the SRS §2.2
 * Module Manifest, so a planner under rejection pressure could drop entire
 * SRS modules (the todo plan lost renderer/events/index.html this way) while
 * still passing every id-arithmetic coverage gate.
 *
 * This module is PURE: string in, structured manifest out. The parser is
 * deliberately NARROW and TOLERANT:
 *
 *   - Section location: a heading `### 2.2 Module Manifest` / `### §2.2
 *     Module Manifest (REQUIRED)` (heading levels 2-6, optional §, any
 *     suffix). The section ends at the next heading of the same or higher
 *     level.
 *   - Module rows: any Markdown table whose header has a file-bearing column
 *     (`Files`, `Owned Surfaces`, `Paths`, ...). The first column names the
 *     module.
 *   - Files: file-like tokens (path with a letter-led extension of 2+ chars,
 *     e.g. `src/app.js`, `index.html`) from the file-bearing column cells.
 *   - Section-level declarations: some SRS state the physical files only in
 *     the intro prose ("... within a single HTML file (`index.html`)"). For
 *     prose ONLY backticked spans are considered, keeping the false-positive
 *     surface minimal.
 *
 * Absence is not an error: a missing or file-less section yields a skip
 * status and the caller emits an informational note instead of rejecting
 * (legacy SRS tolerance). When files ARE declared, every declared file must
 * be covered by at least one implementation item's changeScopes — that
 * enforcement lives in the caller (the task-graph gate provider), which has
 * the graph and the case.
 */

import {
  parseRepositoryScope,
  repositoryScopeContainsPath,
  type RepositoryScope,
} from '../../../shared/repository-scope.js';

export type SrsModuleManifestStatus =
  /** No §2.2 Module Manifest heading found in the SRS. */
  | 'absent'
  /** Heading found, but it declares no machine-readable files. */
  | 'no-files'
  /** Heading found and at least one declared file was extracted. */
  | 'present';

export interface SrsModuleManifestModule {
  /** Module name from the first table column (backticks stripped). */
  readonly module: string;
  /** File-like tokens extracted from the module's file-bearing column. */
  readonly files: readonly string[];
}

export interface SrsModuleManifest {
  readonly status: SrsModuleManifestStatus;
  /** Module-row-derived declarations (rows without files are omitted). */
  readonly modules: readonly SrsModuleManifestModule[];
  /** Files declared in section prose but not attributable to a module row. */
  readonly sectionFiles: readonly string[];
}

const SECTION_HEADING = /^#{2,6}\s+(?:§\s*)?2\.2\b[^\n]*Module\s+Manifest/i;
const HEADING = /^(#{2,6})\s+/;
const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/;
const FILE_BEARING_COLUMN = /file|surface|owned|path/i;
const FILE_LIKE = /^(?:[A-Za-z0-9][A-Za-z0-9_.\-]*\/)*[A-Za-z0-9][A-Za-z0-9_.\-]*\.[A-Za-z][A-Za-z0-9]{1,9}$/;
const BACKTICK_SPAN = /`([^`\n]+)`/g;

/**
 * Parse the §2.2 Module Manifest out of an SRS document. Never throws: any
 * structural surprise degrades to 'absent'/'no-files', which the caller
 * treats as fail-open (informational note), never as rejection evidence.
 */
export function parseSrsModuleManifest(content: string): SrsModuleManifest {
  const lines = content.split(/\r?\n/);
  let sectionStart = -1;
  let sectionLevel = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADING.exec(lines[index]!);
    if (!match) continue;
    if (SECTION_HEADING.test(lines[index]!)) {
      sectionStart = index + 1;
      sectionLevel = match[1]!.length;
      break;
    }
  }
  if (sectionStart < 0) {
    return { status: 'absent', modules: [], sectionFiles: [] };
  }
  const sectionLines: string[] = [];
  for (let index = sectionStart; index < lines.length; index += 1) {
    const line = lines[index]!;
    const heading = HEADING.exec(line);
    if (heading && heading[1]!.length <= sectionLevel) break;
    sectionLines.push(line);
  }

  const modules: SrsModuleManifestModule[] = [];
  const tableLines = new Set<number>();
  let index = 0;
  while (index < sectionLines.length) {
    if (!sectionLines[index]!.trimStart().startsWith('|')) {
      index += 1;
      continue;
    }
    const tableStart = index;
    while (index < sectionLines.length
      && sectionLines[index]!.trimStart().startsWith('|')) {
      tableLines.add(index);
      index += 1;
    }
    collectTableModules(
      sectionLines.slice(tableStart, index),
      modules,
    );
  }

  const sectionFiles: string[] = [];
  const seen = new Set<string>(modules.flatMap(entry => entry.files));
  for (let lineIndex = 0; lineIndex < sectionLines.length; lineIndex += 1) {
    if (tableLines.has(lineIndex)) continue;
    for (const match of sectionLines[lineIndex]!.matchAll(BACKTICK_SPAN)) {
      const token = (match[1] ?? '').trim();
      if (FILE_LIKE.test(token) && !seen.has(token)) {
        seen.add(token);
        sectionFiles.push(token);
      }
    }
  }

  const anyFiles = modules.some(entry => entry.files.length > 0)
    || sectionFiles.length > 0;
  return {
    status: anyFiles ? 'present' : 'no-files',
    modules,
    sectionFiles,
  };
}

function collectTableModules(
  tableLines: readonly string[],
  modules: SrsModuleManifestModule[],
): void {
  const rows = tableLines
    .map(line => line.trim().replace(/^\|/, '').replace(/\|$/, '')
      .split('|').map(cell => cell.trim()))
    .filter(cells => cells.length > 0
      && !cells.every(cell => TABLE_SEPARATOR_CELL.test(cell)));
  if (rows.length < 2) return;
  const header = rows[0]!;
  let fileColumn = -1;
  for (let column = 1; column < header.length; column += 1) {
    if (FILE_BEARING_COLUMN.test(header[column]!)) {
      fileColumn = column;
      break;
    }
  }
  if (fileColumn < 0) return;
  for (let row = 1; row < rows.length; row += 1) {
    const cells = rows[row]!;
    const module = stripBackticks(cells[0] ?? '');
    const files = extractFileTokens(cells[fileColumn] ?? '');
    if (module === '' || files.length === 0) continue;
    modules.push({ module, files });
  }
}

function stripBackticks(value: string): string {
  // Tolerate markdown emphasis (`**module**`, `_module_`) in module names;
  // the name is display-only in findings.
  return value.replace(/[`*_]/g, '').trim();
}

function extractFileTokens(cell: string): string[] {
  const files: string[] = [];
  for (const raw of cell.split(/[\s,;]+/)) {
    const token = raw.replace(/^[`'"([{<]+/, '').replace(/[`'")\]}>.]+$/, '');
    if (FILE_LIKE.test(token) && !files.includes(token)) {
      files.push(token);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Coverage evaluation.
// ---------------------------------------------------------------------------

export interface SrsModuleCoverageGap {
  /** Module row name, or the section-level label for prose declarations. */
  readonly module: string;
  /** Declared files no implementation item's changeScopes cover. */
  readonly files: readonly string[];
}

export interface SrsModuleCoverageItems {
  /** Implementation item changeScopes (already validated by the policy). */
  readonly changeScopes: readonly string[];
}

export interface SrsModuleCoverageResult {
  readonly outcome: 'covered' | 'uncovered';
  readonly gaps: readonly SrsModuleCoverageGap[];
}

/**
 * Every declared module file must be covered by >=1 implementation item's
 * changeScopes (path containment via the shared repository-scope helper).
 * Unparseable scopes are skipped defensively: this evaluation is advisory
 * on top of the policy's own strict scope validation, never a crash surface.
 */
export function evaluateSrsModuleManifestCoverage(
  manifest: SrsModuleManifest,
  implementationItems: readonly SrsModuleCoverageItems[],
): SrsModuleCoverageResult {
  const parsedScopes: RepositoryScope[] = [];
  for (const scope of implementationItems.flatMap(item => item.changeScopes)) {
    try {
      parsedScopes.push(parseRepositoryScope(scope));
    } catch {
      // The task-graph policy already rejects malformed scopes; skip here.
    }
  }
  const covers = (file: string): boolean => parsedScopes.some(scope => {
    try {
      return repositoryScopeContainsPath(scope, file);
    } catch {
      return false;
    }
  });

  const gaps: SrsModuleCoverageGap[] = [];
  for (const entry of manifest.modules) {
    const uncovered = entry.files.filter(file => !covers(file));
    if (uncovered.length > 0) {
      gaps.push({ module: entry.module, files: uncovered });
    }
  }
  if (manifest.sectionFiles.length > 0) {
    const uncovered = manifest.sectionFiles.filter(file => !covers(file));
    if (uncovered.length > 0) {
      gaps.push({ module: '(section-level declaration)', files: uncovered });
    }
  }
  return { outcome: gaps.length === 0 ? 'covered' : 'uncovered', gaps };
}
