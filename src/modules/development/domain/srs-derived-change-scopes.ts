/**
 * SRS-derived `requiredChangeScopes` for the ReferenceDevelopmentPolicy.
 *
 * Why this module exists (workshop project 7 / todo): the development policy
 * hardcoded `['package.json', 'tests/']` for EVERY project. The todo SRS
 * mandates a single `index.html` with embedded CSS and vanilla JavaScript and
 * no Node scaffolding, yet the plan gate forced every repository to assign a
 * `package.json` scope. Under two rejections the planner abandoned the SRS
 * delivery shape and delivered headless modules plus `package.json`/`tests`
 * — the UI (`renderer`/`events`/`index.html`) was lost. The policy must be
 * derived from the accepted SRS file surface instead of being hardcoded.
 *
 * BM-5 repair (2026-08-24): the §D2/§D1 file surface is owned by
 * `srs-file-identity.ts` — the ONE canonical parser. This module only maps
 * that surface to top-level repository scopes. There is NO invented
 * fallback: when nothing is derivable the function returns `null` and the
 * caller (`buildReferenceDevelopmentPolicy`) must keep the scopes EMPTY —
 * an invented default is invented authority (the historical
 * `DEFAULT_REQUIRED_CHANGE_SCOPES` was removed for exactly this reason).
 *
 * The derivation is PURE (no I/O, no clocks, no randomness) so the resulting
 * policy is deterministic and its content hash reproducible.
 *
 * Derivation rule (exact):
 *
 * 1. Collect declared file paths from the canonical §D2/§D1 file surface
 *    (`collectSrsSurfacePaths`). §2.2 Module Manifest is deliberately NOT a
 *    source: its "Owned Surfaces" can be module-relative
 *    (`data/categories.js` for a module whose file is `js/data/categories.js`
 *    — real workshop evidence, project 8/units), and requiring scopes for
 *    paths that never exist would over-constrain the plan gate. §2.2 tokens
 *    are identity-resolved against this surface by the task-graph gate
 *    instead (`srs-file-identity.ts`).
 * 2. `package.json` is required ONLY when the SRS actually declares it on its
 *    file surface (§D2/§D1) or names the literal `package.json` file in
 *    a Technology Stack (§2.5/§9) / Test Strategy (§3) section without a
 *    negation on the same line. Bare `npm`/`node` command mentions do NOT
 *    trigger it: the real single-HTML todo SRS lists `npm test` tooling while
 *    its delivery shape has no package.json.
 * 3. Every collected path is normalized to a top-level repository scope
 *    (`js/app.js` → `js/`, `index.html` → `index.html`) and validated by
 *    `parseRepositoryScope`.
 * 4. `tests/` is ALWAYS required when any path is derivable (verification
 *    items write tests; this also preserves the passing behavior of
 *    Node-style projects whose SRS lists package.json + tests).
 * 5. The result is the sorted union of the normalized scopes, `tests/` and
 *    (when triggered) `package.json`.
 *
 * Fail-safe: when the SRS content is null/blank or carries no file
 * declarations at all, the function returns `null` — the caller keeps EMPTY
 * scopes. It never throws, never rejects a plan and NEVER invents defaults.
 */

import { parseRepositoryScope } from '../../../shared/repository-scope.js';
import {
  collectSrsSurfacePaths,
  sectionSubtrees,
  splitSections,
} from './srs-file-identity.js';

const TECH_STACK_HEADING = /(?:technology\s+stack)|(?:§\s*2\.5\b)/i;
const TEST_STRATEGY_HEADING
  = /(?:§\s*3\b[^\n]*(?:test|verif))|(?:\btest[\s\S]{0,40}(?:strategy|verification))/i;
const NEGATED_PACKAGE_JSON
  = /\b(?:no|without|zero|never|not|lacks?|excludes?|absent)\b[^.\n]{0,50}package\.json/i;

function mentionsPackageJson(sectionBody: string): boolean {
  return sectionBody
    .split(/\r?\n/)
    .some(line =>
      line.includes('package.json') && !NEGATED_PACKAGE_JSON.test(line));
}

/**
 * Normalize one declared file path to a top-level repository scope:
 * `js/app.js` → `js/` (directory prefix), `index.html` → `index.html`
 * (exact file). Returns null for paths that are not valid repository scopes.
 */
function normalizeTopLevelScope(filePath: string): string | null {
  const normalized = filePath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.length === 0) return null;
  const segments = normalized.split('/');
  const top = segments[0] ?? '';
  const scope = segments.length === 1 ? top : `${top}/`;
  try {
    parseRepositoryScope(scope);
  } catch {
    return null;
  }
  return scope;
}

/**
 * Derive the development policy `requiredChangeScopes` from an accepted SRS
 * document. Returns `null` when nothing is derivable (no readable content or
 * no file declarations) — callers must then keep the scopes EMPTY; there is
 * no invented fallback.
 */
export function deriveRequiredChangeScopesFromSrs(
  srsContent: string | null | undefined,
): readonly string[] | null {
  if (typeof srsContent !== 'string' || srsContent.trim().length === 0) {
    return null;
  }
  const sections = splitSections(srsContent);
  const declaredPaths = collectSrsSurfacePaths(sections, srsContent);

  // package.json is required only when the SRS names it as an actual file.
  const packageJsonRequired
    = declaredPaths.some(path => path.trim() === 'package.json')
      || [
        ...sectionSubtrees(sections, TECH_STACK_HEADING),
        ...sectionSubtrees(sections, TEST_STRATEGY_HEADING),
      ].some(section => mentionsPackageJson(section.body));

  const scopes = new Set<string>();
  for (const declared of declaredPaths) {
    const scope = normalizeTopLevelScope(declared);
    if (scope !== null) {
      scopes.add(scope);
    }
  }
  if (scopes.size === 0) {
    return null;
  }
  // Verification items always write tests; keep the scope mandatory for every
  // delivery shape (this is what Node-style SRSs already declare).
  scopes.add('tests/');
  if (packageJsonRequired) {
    scopes.add('package.json');
  }
  return [...scopes].sort();
}
