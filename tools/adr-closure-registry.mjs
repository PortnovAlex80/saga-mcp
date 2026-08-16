#!/usr/bin/env node
// tools/adr-closure-registry.mjs
//
// ADR-076 §6 — validator for docs/architecture/adr-closure-registry.json
// against docs/architecture/decisions/.
//
// Exit code 0 = registry is complete and every Accepted ADR is owned.
// Exit code 1 = at least one violation (printed to stderr).
//
// Pure Node built-ins: no runtime dependencies, safe to run in any checkout.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CLOSURE_STATES = [
  'unassessed',
  'planned',
  'in-progress',
  'implemented',
  'closed',
  'superseded',
  'rejected',
];

const DECISION_FILE_RE = /^\d{3}-[a-z0-9][a-z0-9-]*\.md$/;

/** Parse the leading token of the `**Status:**` header (case-normalized). */
export function parseDecisionStatus(content) {
  const m = content.match(/\*\*\s*Status\s*:\s*\*\*\s*\**\s*([A-Za-z]+)/);
  return m ? m[1].toLowerCase() : null;
}

/** Parse the title from the `# ADR-NNN: Title` heading. */
export function parseDecisionTitle(content) {
  const m = content.match(/^#\s+ADR-\d+:\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

/** Parse the ADR number from a `NNN-slug.md` filename. */
export function adrNumberFromFileName(fileName) {
  const m = fileName.match(/^(\d{3})-/);
  return m ? m[1] : null;
}

function listDecisionFiles(decisionsDir) {
  return readdirSync(decisionsDir)
    .filter((name) => DECISION_FILE_RE.test(name))
    .sort();
}

/**
 * Validate the registry against the decisions directory.
 *
 * @returns {{ok: boolean, violations: Array<{code: string, adr: string|null, detail: string}>, summary: object}}
 */
export function validateRegistry({ decisionsDir, registryPath }) {
  const violations = [];

  if (!existsSync(registryPath)) {
    return {
      ok: false,
      violations: [{
        code: 'REGISTRY_MISSING',
        adr: null,
        detail: `registry file not found: ${registryPath}`,
      }],
      summary: { files: 0, entries: 0, byState: {} },
    };
  }

  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      violations: [{
        code: 'REGISTRY_INVALID_JSON',
        adr: null,
        detail: String(error.message),
      }],
      summary: { files: 0, entries: 0, byState: {} },
    };
  }

  if (!registry?.evidenceBaseline?.commit) {
    violations.push({
      code: 'EVIDENCE_BASELINE_MISSING',
      adr: null,
      detail: 'registry.evidenceBaseline.commit is required (exact SHA the reconciliation started from)',
    });
  }

  const entries = Array.isArray(registry.decisions) ? registry.decisions : [];
  if (!Array.isArray(registry.decisions)) {
    violations.push({
      code: 'REGISTRY_SHAPE_INVALID',
      adr: null,
      detail: 'registry.decisions must be an array',
    });
  }

  // Index entries by ADR number, detecting duplicates.
  const byAdr = new Map();
  for (const entry of entries) {
    const adr = typeof entry?.adr === 'string' ? entry.adr : null;
    if (!adr) {
      violations.push({
        code: 'ENTRY_MALFORMED',
        adr: null,
        detail: `entry without an "adr" string field: ${JSON.stringify(entry).slice(0, 120)}`,
      });
      continue;
    }
    if (byAdr.has(adr)) {
      violations.push({
        code: 'ENTRY_DUPLICATE',
        adr,
        detail: `more than one registry entry for ADR-${adr}`,
      });
      continue;
    }
    byAdr.set(adr, entry);
  }

  // Every numbered decision file must have exactly one entry, and the
  // registry's recorded decision status must match the file header.
  const files = listDecisionFiles(decisionsDir);
  const fileAdrs = new Set();
  for (const fileName of files) {
    const adr = adrNumberFromFileName(fileName);
    fileAdrs.add(adr);
    const content = readFileSync(join(decisionsDir, fileName), 'utf8');
    const fileStatus = parseDecisionStatus(content);
    const entry = byAdr.get(adr);
    if (!entry) {
      violations.push({
        code: 'ENTRY_MISSING',
        adr,
        detail: `decision file ${fileName} has no registry entry`,
      });
      continue;
    }
    if (fileStatus === null) {
      violations.push({
        code: 'FILE_STATUS_UNPARSEABLE',
        adr,
        detail: `${fileName} has no parseable **Status:** header`,
      });
    }
    const registryStatus = typeof entry.decisionStatus === 'string'
      ? entry.decisionStatus.toLowerCase()
      : null;
    if (fileStatus !== null && registryStatus !== fileStatus) {
      violations.push({
        code: 'STATUS_MISMATCH',
        adr,
        detail: `file status "${fileStatus}" != registry decisionStatus "${entry.decisionStatus}"`,
      });
    }
    if (!CLOSURE_STATES.includes(entry.closureState)) {
      violations.push({
        code: 'STATE_INVALID',
        adr,
        detail: `closureState "${entry.closureState}" not in ${CLOSURE_STATES.join('|')}`,
      });
    }
  }

  // Every entry must point to an existing file (no orphans).
  for (const [adr] of byAdr) {
    if (!fileAdrs.has(adr)) {
      violations.push({
        code: 'ENTRY_ORPHAN',
        adr,
        detail: `registry entry for ADR-${adr} has no decision file`,
      });
    }
  }

  // Ownership: every Accepted decision is owned or explicitly terminal.
  for (const [adr, entry] of byAdr) {
    if (!fileAdrs.has(adr)) continue;
    const terminal = entry.closureState === 'superseded' || entry.closureState === 'rejected';
    if (entry.decisionStatus === 'accepted' && !terminal) {
      const hasOwner = Array.isArray(entry.owningReleases) && entry.owningReleases.length > 0
        && typeof entry.evidenceOwner === 'string' && entry.evidenceOwner.length > 0;
      if (!hasOwner) {
        violations.push({
          code: 'OWNERSHIP_MISSING',
          adr,
          detail: 'Accepted ADR lacks owningReleases[] + evidenceOwner (or superseded/rejected)',
        });
      }
    }
    if (entry.closureState === 'superseded') {
      if (!entry.successor) {
        violations.push({
          code: 'SUCCESSOR_MISSING',
          adr,
          detail: 'closureState=superseded requires a successor',
        });
      } else if (!byAdr.has(entry.successor)) {
        violations.push({
          code: 'SUCCESSOR_UNKNOWN',
          adr,
          detail: `successor ADR-${entry.successor} has no registry entry`,
        });
      }
    }
    if (entry.closureState === 'rejected' && !entry.rationale) {
      violations.push({
        code: 'REJECTED_RATIONALE_MISSING',
        adr,
        detail: 'closureState=rejected requires an explicit rationale',
      });
    }
  }

  // Successor chains must terminate (no cycles).
  for (const [adr, entry] of byAdr) {
    const seen = new Set([adr]);
    let cursor = entry?.successor ?? null;
    while (cursor !== null && cursor !== undefined) {
      if (seen.has(cursor)) {
        violations.push({
          code: 'SUCCESSOR_CYCLE',
          adr,
          detail: `successor chain from ADR-${adr} revisits ADR-${cursor}`,
        });
        break;
      }
      seen.add(cursor);
      cursor = byAdr.get(cursor)?.successor ?? null;
    }
  }

  const byState = {};
  for (const state of CLOSURE_STATES) byState[state] = 0;
  for (const entry of entries) {
    if (CLOSURE_STATES.includes(entry?.closureState)) byState[entry.closureState] += 1;
  }

  return {
    ok: violations.length === 0,
    violations,
    summary: { files: files.length, entries: entries.length, byState },
  };
}

// --- CLI -------------------------------------------------------------------

function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--decisions') args.set('decisions', argv[i + 1]);
    if (argv[i] === '--registry') args.set('registry', argv[i + 1]);
    if (argv[i] === '--report') args.set('report', true);
  }
  const decisionsDir = resolve(args.get('decisions') ?? join(repoRoot, 'docs/architecture/decisions'));
  const registryPath = resolve(args.get('registry') ?? join(repoRoot, 'docs/architecture/adr-closure-registry.json'));

  const result = validateRegistry({ decisionsDir, registryPath });

  if (args.get('report') || result.ok) {
    const { files, entries, byState } = result.summary;
    process.stdout.write(
      `ADR closure registry: ${files} decision files, ${entries} entries — `
      + CLOSURE_STATES.map((s) => `${s}=${byState[s] ?? 0}`).join(' ')
      + `\nbaseline: ${readFileSync(registryPath, 'utf8').length > 0 ? 'see registry' : 'n/a'}\n`,
    );
  }
  if (!result.ok) {
    process.stderr.write(`ADR closure registry INVALID (${result.violations.length} violations):\n`);
    for (const v of result.violations) {
      process.stderr.write(`  [${v.code}] ADR-${v.adr ?? '-'}: ${v.detail}\n`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
