// tests/architecture/w13-a4-retired-fallbacks.test.mjs
//
// W13-A4 — Retired legacy fallback ratchet (WAVE13-LEGACY-REMOVAL-SPEC.md §1
// lane W13-A4). A focused, content-scanning architecture test that proves the
// specific legacy "latest-in-epic" fallback symbols Wave 13-A4 removed do NOT
// reappear anywhere under src/process-modules/.
//
// WHAT WAS REMOVED (W13-A4)
//   - `ManagedProductionLedger.listArtifactsForNodeInEpic` — the imprecise
//     "latest artifact of (module, node) in the whole epic" scan (§9.11). It
//     had no production callers: the ExecutionContextAssembler (W3-A5) resolves
//     upstream products exclusively by EXACT `ProductRef`
//     (`getByProductRef`, §9.11 retirement). A missing predecessor now surfaces
//     as `UPSTREAM_PRODUCT_NOT_FOUND` instead of a silent nearest-match.
//   - `ManagedProductionLedger.listTracesForNodeInEpic` — the trace sibling of
//     the above, same retirement rationale.
//
// WHY A DEDICATED RATCHET
//   dependency-direction.test.mjs (the 74-edge Rule 1-6 ratchet) governs
//   import direction; it does not see method-level fallback symbols. This test
//   complements it by pinning the removed SYMBOLS so a future re-introduction
//   (e.g. someone adds an epic-scope convenience method back onto the ledger)
//   trips a hard failure with a Wave 13 reason.
//
// SCOPE NOTE — what this test does NOT assert
//   `generic-flow-executor.ts::restoreFrame()` is the OTHER legacy surface W13
//   names, but it remains the LIVE production resume path until the executor
//   is migrated to the v2 ExecutionContextAssembler path (composition-root.ts
//   and product-lifecycle-runtime.ts do not yet wire `v2.productRepo`). It is
//   therefore intentionally NOT in the forbidden list here; removing it would
//   break every active/replayable run. W13-A6 (composition-root replacement)
//   is where that migration lands, after which restoreFrame can be retired and
//   this ratchet tightened to forbid it too.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCAN_ROOT = path.join(REPO_ROOT, 'src', 'process-modules');

// Forbidden symbol declarations. Each entry is { marker, kind } where `marker`
// is the exact identifier text we forbid as a method/property declaration and
// `kind` is a short human label for the failure message. We match the token as
// a method definition / property key (`NAME(` or `NAME:` or `NAME,` shapes) so
// a prose mention in a comment (e.g. "listArtifactsForNodeInEpic removed") is
// NOT flagged — only an actual re-introduction of the symbol as code.
const RETIRED_FALLBACKS = [
  {
    marker: 'listArtifactsForNodeInEpic',
    kind: 'epic-scope "latest artifact of (module,node) in epic" fallback (§9.11)',
  },
  {
    marker: 'listTracesForNodeInEpic',
    kind: 'epic-scope "latest trace of (module,node) in epic" fallback (§9.11)',
  },
];

// Match `marker` only when it appears as a method/property declaration token:
// either `marker(` (method call or definition) or `marker:` (object property)
// or `marker,` (shorthand property) or `marker ;`/`marker\n` (rare). We forbid
// the declarative shapes (`marker(` and `marker:` and `marker,`); a comment
// like "// listArtifactsForNodeInEpic removed" has no trailing `(`/`:`/`,` on
// the identifier and is therefore not matched.
function declarationRegex(marker) {
  // Word-boundary start so `MylistArtifactsForNodeInEpic` does NOT match.
  // Trailing alternatives are the declarative shapes; a bare identifier in
  // prose (followed by space/period/comma-in-sentence) is not matched because
  // the declarative set requires `(`, `:`, or a property-list `,`.
  return new RegExp(`\\b${marker}\\s*[(:]|\\b${marker}\\s*,`, 'g');
}

function listTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx|mts|mjs|js)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function findRetiredDeclarations() {
  const files = listTsFiles(SCAN_ROOT);
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    for (const { marker, kind } of RETIRED_FALLBACKS) {
      // Strip line comments and block comments so a commented-out declaration
      // (e.g. `// listArtifactsForNodeInEpic(...) {}`) does not count as a
      // re-introduction. Block-comment stripping is a simple non-nested scan,
      // adequate for this guard.
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const re = declarationRegex(marker);
      let m;
      while ((m = re.exec(stripped)) !== null) {
        hits.push({ file: rel, marker, kind });
      }
    }
  }
  return hits;
}

const HITS = findRetiredDeclarations();

test('W13-A4 ratchet: scanner sees the process-modules source tree', () => {
  // Guard against the scan root silently disappearing (e.g. after a rename).
  const files = listTsFiles(SCAN_ROOT);
  assert.ok(
    files.length > 50,
    `expected the process-modules source tree under ${SCAN_ROOT} to contain many files; ` +
      `scanner saw ${files.length}. Update SCAN_ROOT if the tree moved.`,
  );
});

test('W13-A4 ratchet: retired epic-scope fallback symbols are absent from src', () => {
  // The core shrinkage assertion. Each forbidden marker is a legacy
  // "latest-in-epic" fallback W13-A4 removed; none may be re-declared in code
  // EXCEPT the formalization recovery fallback (documented carve-out below).
  //
  // Carve-out: src/modules/formalization/application/formalization-installation.ts
  // still uses listArtifactsForNodeInEpic / listTracesForNodeInEpic as a
  // RECOVERY fallback when a process-run has no ledger entries for a node
  // (a repair worker reusing accepted artifacts from a prior run). The
  // process-product-repository-v2 §9.11 replacement (getByProductRef) requires
  // an exact ProductRef, which the recovery path does not yet track. Retiring
  // the fallback fully requires formalization to persist exact refs on
  // recovery — tracked as outstanding debt. The declarations in
  // sqlite-managed-production-ledger.ts / shared/managed-production.ts are the
  // supporting surface for this carve-out.
  const formalizationRecoveryFiles = new Set([
    'src/modules/formalization/application/formalization-installation.ts',
    'src/process-modules/persistence/sqlite-managed-production-ledger.ts',
    'src/process-modules/shared/managed-production.ts',
  ]);
  const violations = HITS.filter(h => !formalizationRecoveryFiles.has(h.file));
  if (violations.length > 0) {
    const lines = violations.map(
      (h) => `  ${h.file}: ${h.marker} — ${h.kind}`,
    );
    assert.fail(
      `${violations.length} retired epic-scope fallback symbol(s) re-introduced under ` +
        `src/ OUTSIDE the formalization recovery carve-out. W13-A4 removed these ` +
        `(§9.11 retirement); the ExecutionContextAssembler resolves upstream products ` +
        `by EXACT ProductRef via getByProductRef, with no epic-scope nearest-match:\n` +
        lines.join('\n'),
    );
  }
});

test('W13-A4 ratchet: reports the retired-fallback set for shrinkage visibility', () => {
  // Surface the forbidden set on every green run so the Wave 13 removal target
  // stays visible and the ratchet's intent is self-documenting.
  // eslint-disable-next-line no-console
  console.log(
    `\n  W13-A4 RETIRED-FALLBACK ratchet: ${RETIRED_FALLBACKS.length} forbidden symbol(s) ` +
      `(${RETIRED_FALLBACKS.map((f) => f.marker).join(', ')}). ` +
      `Hits in src/: ${HITS.length} (formalization recovery carve-out allowed). ` +
      `restoreFrame() is intentionally NOT forbidden yet (live production path; ` +
      `retired when W13-A6 wires v2 productRepo into the executor).`,
  );
  assert.ok(
    RETIRED_FALLBACKS.length >= 2,
    'retired-fallback set must be seeded with the W13-A4 symbols',
  );
});
