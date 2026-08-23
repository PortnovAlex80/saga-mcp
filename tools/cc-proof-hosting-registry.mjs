#!/usr/bin/env node
// tools/cc-proof-hosting-registry.mjs
//
// ADR-092 / CC-U1 — validator for the CC closure proof-hosting manifest
// (tests/infrastructure/cc-proof-hosting-manifest.mjs) against:
//   1. the machine-readable acceptance-matrix export
//      (tools/run-acceptance-matrix.mjs --list-json — the structured group
//      registry; the human --list text is never parsed), and
//   2. the CI group invocations (.github/workflows/ci.yml).
//
// Both directions are proven (fail closed on every drift):
//   manifest -> matrix -> CI : every BLOCKING row's file is in the pinned
//       group's expanded run-set, the group exists (rename = red), the group
//       is invoked by CI (omission = red), and the file is not quarantined
//       (FLAKY/PRE-EXISTING-RED reclassification = red).
//   matrix -> manifest      : the dedicated registry group's run-set equals
//       the manifest blocking rows pinned to it (a file joining that group
//       without a manifest row = silent widening = red), and a CI-invoked
//       group unknown to the matrix = stale CI wiring = red.
//   registry bootstrap      : the manifest's own registryGroup must exist in
//       the matrix (REGISTRY_GROUP_UNKNOWN — a mutated/typo'd group name may
//       never silently skip the bijection block and validate ok=true), be
//       invoked by CI (REGISTRY_GROUP_NOT_INVOKED_BY_CI), and be anchored by
//       at least one blocking manifest row pinned to that same group
//       (REGISTRY_GROUP_UNANCHORED). CC-U1 repair 2026-08-23: the pure
//       validator previously failed OPEN on all three.
//   pending honesty         : pending rows carry non-empty tracker + reason
//       and can NEVER absorb a blocking proof — a pending row whose file is
//       hosted in any CI-invoked matrix group is a stale/dishonest pending
//       and fails closed.
//
// Exit code 0 = registry valid; 1 = violations (each printed with its code).
// Pure Node built-ins only. The validation core is pure over injected facts
// so the blocking test (tests/infrastructure/cc-proof-hosting.test.mjs) can
// run the full mutation battery without touching the repository.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CC_ROW_TYPES = Object.freeze(['blocking', 'pending']);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Extract the acceptance-matrix group names a CI (or any command) text
 * actually invokes, e.g. `node tools/run-acceptance-matrix.mjs --group X`.
 * Order-preserving, duplicates preserved (callers deduplicate as needed).
 */
export function extractInvokedGroups(text) {
  if (typeof text !== 'string') return [];
  const invoked = [];
  for (const m of text.matchAll(/--group(?:=|[ \t]+)([A-Za-z0-9_.-]+)/g)) {
    invoked.push(m[1]);
  }
  return invoked;
}

function isNonEmptyString(value, minLength = 1) {
  return typeof value === 'string' && value.trim().length >= minLength;
}

/**
 * Validate the proof-hosting manifest against injected repository facts.
 *
 * @param {object} input
 * @param {object} input.manifest   — the CC proof-hosting manifest object
 * @param {object} input.matrix     — parsed --list-json export
 * @param {string[]|null} [input.ciInvokedGroups]
 *   Group names the CI file invokes (null = do not check CI wiring).
 * @param {(file: string) => boolean} [input.fileExists]
 * @returns {{ok: boolean, violations: Array<{code: string, file?: string, detail: string}>, summary: object}}
 */
export function validateProofHosting({ manifest, matrix, ciInvokedGroups = null, fileExists = () => true }) {
  const violations = [];
  const push = (code, detail, file) => violations.push({ code, detail, ...(file ? { file } : {}) });

  const summary = { rows: 0, blocking: 0, pending: 0, groupsChecked: 0 };

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, violations: [{ code: 'MANIFEST_MALFORMED', detail: 'manifest must be an object' }], summary };
  }
  if (!Array.isArray(manifest.rows) || manifest.rows.length === 0) {
    return {
      ok: false,
      violations: [{ code: 'MANIFEST_MALFORMED', detail: 'manifest.rows must be a non-empty array (the CC proof-hosting surface may never be silently emptied)' }],
      summary,
    };
  }
  if (!isNonEmptyString(manifest.registryGroup)) {
    push('MANIFEST_MALFORMED', 'manifest.registryGroup (the dedicated exact-file matrix group) is required');
  }

  const groups = matrix && typeof matrix === 'object' && matrix.groups && typeof matrix.groups === 'object'
    ? matrix.groups
    : null;
  if (!groups) {
    push('MATRIX_EXPORT_MALFORMED', 'matrix.groups missing — the machine-readable export (run-acceptance-matrix.mjs --list-json) is the only accepted group registry');
  }
  const quarantine = groups && Array.isArray(matrix.quarantine) ? matrix.quarantine : [];
  const quarantinedPaths = new Set(quarantine.map((q) => q?.path));

  // CI wiring (when the caller provides the invoked groups).
  const invoked = Array.isArray(ciInvokedGroups) ? [...new Set(ciInvokedGroups)] : null;
  if (invoked !== null && groups) {
    for (const g of invoked) {
      if (!groups[g]) {
        push('CI_INVOKES_UNKNOWN_GROUP', `CI invokes '--group ${g}' but the acceptance matrix defines no such group (stale CI wiring after a rename/removal?)`);
      }
    }
  }

  const seenFiles = new Map();
  const blockingRows = [];
  for (const row of manifest.rows) {
    summary.rows += 1;
    if (!row || typeof row !== 'object' || !isNonEmptyString(row.file)) {
      push('ROW_MALFORMED', `row without a non-empty 'file' string: ${JSON.stringify(row)?.slice(0, 120)}`);
      continue;
    }
    const { file } = row;

    if (seenFiles.has(file)) {
      push('ROW_FILE_DUPLICATE', `file registered more than once (first typed '${seenFiles.get(file)}', again '${row.type ?? '?'}') — each CC proof file has exactly one hosting row`, file);
      continue;
    }
    seenFiles.set(file, row.type ?? '?');

    if (!fileExists(file)) {
      push('ROW_FILE_MISSING', `proof file missing on disk: ${file}`, file);
    }
    if (!isNonEmptyString(row.proof, 10)) {
      push('ROW_PROOF_MISSING', `row must state what the proof proves (non-empty 'proof'): ${file}`, file);
    }
    if (!CC_ROW_TYPES.includes(row.type)) {
      push('ROW_TYPE_INVALID', `type must be one of ${CC_ROW_TYPES.join('|')}, got ${JSON.stringify(row.type)}: ${file}`, file);
      continue;
    }

    if (row.type === 'pending') {
      summary.pending += 1;
      if (row.group !== undefined && row.group !== null) {
        push('PENDING_GROUP_FORBIDDEN', `a pending row must not pin a group (it is not hosted): ${file}`, file);
      }
      if (!isNonEmptyString(row.tracker, 15)) {
        push('PENDING_TRACKER_MISSING', `pending row requires a non-empty tracker (where the hosting debt is tracked): ${file}`, file);
      } else {
        const firstToken = row.tracker.trim().split(/\s+/)[0];
        if (/^[A-Za-z0-9_.@/-]+$/.test(firstToken) && firstToken.includes('/') && firstToken.includes('.')) {
          if (!fileExists(firstToken)) {
            push('PENDING_TRACKER_PATH_MISSING', `tracker names a repo path that does not exist: ${firstToken} (${file})`, file);
          }
        }
      }
      if (!isNonEmptyString(row.reason, 15)) {
        push('PENDING_REASON_MISSING', `pending row requires a non-empty reason (why it is not yet hosted): ${file}`, file);
      }
      // A pending row can never absorb a blocking proof: if the file IS
      // hosted in any CI-invoked matrix group, the honest type is blocking.
      if (groups && invoked !== null) {
        for (const [gName, g] of Object.entries(groups)) {
          if (!invoked.includes(gName)) continue;
          if (Array.isArray(g.files) && g.files.includes(file)) {
            push('PENDING_ABSORBS_HOSTED', `typed pending but HOSTED in the CI-invoked blocking group '${gName}' — a hosted critical proof must be a blocking row (stale pending / dishonest reclassification)`, file);
          }
        }
      }
      continue;
    }

    // blocking row
    summary.blocking += 1;
    blockingRows.push(row);
    if (!isNonEmptyString(row.group)) {
      push('BLOCKING_GROUP_MISSING', `blocking row requires the acceptance-matrix group that hosts it: ${file}`, file);
      continue;
    }
    if (groups) {
      const group = groups[row.group];
      if (!group) {
        push('GROUP_UNKNOWN', `blocking row pins group '${row.group}' but the acceptance matrix defines no such group (group renamed/removed?) — re-pin the row in the same reviewed change`, file);
      } else {
        summary.groupsChecked += 1;
        if (invoked !== null && !invoked.includes(row.group)) {
          push('GROUP_NOT_INVOKED_BY_CI', `group '${row.group}' hosts ${file} but CI never invokes '--group ${row.group}' (CI omission — a committed proof that proves nothing in CI)`, file);
        }
        if (!Array.isArray(group.files) || !group.files.includes(file)) {
          push('PROOF_NOT_HOSTED', `${file} is NOT in the '${row.group}' run-set (entry removed, glob drifted, or never added) — the pinned hosting must hold in BOTH directions`, file);
        }
      }
    }
    if (quarantinedPaths.has(file)) {
      push('PROOF_QUARANTINED', `${file} is quarantined — a critical CC blocking proof may not be reclassified FLAKY/PRE-EXISTING-RED to drop its hosting`, file);
    }
  }

  // Registry-group bootstrap validation + bijection: the dedicated exact-file
  // group's run-set must equal the manifest blocking rows pinned to it. This is
  // the matrix -> manifest direction for the registry's own hosting surface: a
  // file joining the group without a manifest row is silent scope widening;
  // a manifest row leaving the group is caught above as PROOF_NOT_HOSTED.
  //
  // CC-U1 repair 2026-08-23 (fail-closed bootstrap): the old guard ran the
  // whole block only `if (groups[registryGroup])`, so a manifest.registryGroup
  // mutated to an undefined group (typo / coordinated removal) silently
  // skipped every registry-group check and validated ok=true. The registry
  // group's own hosting truth is now typed and fail-closed on three axes:
  //   exists  — REGISTRY_GROUP_UNKNOWN
  //   invoked — REGISTRY_GROUP_NOT_INVOKED_BY_CI
  //   anchored — REGISTRY_GROUP_UNANCHORED (>=1 blocking row pinned to it)
  const registryGroup = isNonEmptyString(manifest.registryGroup) ? manifest.registryGroup : null;
  if (registryGroup && groups) {
    const registryGroupDef = groups[registryGroup];
    if (!registryGroupDef) {
      push('REGISTRY_GROUP_UNKNOWN', `manifest.registryGroup '${registryGroup}' is not defined in the acceptance matrix (typo, rename, or coordinated group+CI removal?) — the registry's own hosting group may never silently vanish`);
    } else {
      if (invoked !== null && !invoked.includes(registryGroup)) {
        push('REGISTRY_GROUP_NOT_INVOKED_BY_CI', `manifest.registryGroup '${registryGroup}' is defined in the matrix but CI never invokes '--group ${registryGroup}' — the registry's own group must be CI-invoked, not only declared`);
      }
      if (!blockingRows.some((r) => r.group === registryGroup)) {
        push('REGISTRY_GROUP_UNANCHORED', `manifest.registryGroup '${registryGroup}' is anchored by no blocking manifest row pinned to it — the registry group must host at least one registered blocking proof (the bijection anchor), not exist as an empty unproven shell`);
      }
      const inGroup = Array.isArray(registryGroupDef.files) ? registryGroupDef.files : [];
      const pinned = new Set(blockingRows.filter((r) => r.group === registryGroup).map((r) => r.file));
      for (const f of inGroup) {
        if (!pinned.has(f)) {
          push('REGISTRY_GROUP_WIDENED', `${f} runs in the '${registryGroup}' group but has no manifest blocking row pinned to it — the CC proof-registry surface cannot silently widen`, f);
        }
      }
      for (const f of pinned) {
        if (!inGroup.includes(f)) {
          push('REGISTRY_GROUP_ROW_NOT_HOSTED', `${f} is pinned to '${registryGroup}' by the manifest but absent from the group run-set`, f);
        }
      }
    }
  }

  return { ok: violations.length === 0, violations, summary };
}

// --- repository facts loader ------------------------------------------------

export function loadRepositoryFacts({ root = repoRoot } = {}) {
  const runner = path.join(root, 'tools', 'run-acceptance-matrix.mjs');
  const ciPath = path.join(root, '.github', 'workflows', 'ci.yml');

  const list = spawnSync(process.execPath, [runner, '--list-json'], { cwd: root, encoding: 'utf8' });
  if (list.status !== 0) {
    throw new Error(`run-acceptance-matrix.mjs --list-json failed (exit ${list.status}):\n${list.stderr}`);
  }
  let matrix;
  try {
    matrix = JSON.parse(list.stdout);
  } catch (error) {
    throw new Error(`--list-json did not emit parseable JSON: ${error.message}`);
  }

  const ciText = readFileSync(ciPath, 'utf8');
  // Strip YAML comments first: a comment mentioning "--group invocations"
  // must never register as a CI invocation (same discipline as the coverage
  // test's G4 no-hidden-failure scans).
  const ciNoComments = ciText.split(/\r?\n/).map((line) => line.replace(/(^|\s)#.*$/, '$1')).join('\n');
  const ciInvokedGroups = extractInvokedGroups(ciNoComments);
  const fileExists = (file) => existsSync(path.join(root, file));

  return { matrix, ciInvokedGroups, fileExists, ciPath };
}

// --- CLI --------------------------------------------------------------------

async function main() {
  const manifestUrl = pathToFileURL(path.join(repoRoot, 'tests', 'infrastructure', 'cc-proof-hosting-manifest.mjs')).href;
  const { CC_PROOF_HOSTING_MANIFEST } = await import(manifestUrl);
  const facts = loadRepositoryFacts();
  const result = validateProofHosting({ manifest: CC_PROOF_HOSTING_MANIFEST, ...facts });

  process.stdout.write(
    `[cc-proof-hosting] ADR-092 manifest: ${result.summary.rows} rows `
    + `(blocking=${result.summary.blocking}, pending=${result.summary.pending}); `
    + `${result.summary.groupsChecked} blocking hosting pin(s) checked against the CI-invoked matrix groups\n`,
  );
  if (!result.ok) {
    process.stderr.write(`CC proof-hosting registry INVALID (${result.violations.length} violations):\n`);
    for (const v of result.violations) {
      process.stderr.write(`  [${v.code}] ${v.file ? `${v.file}: ` : ''}${v.detail}\n`);
    }
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
