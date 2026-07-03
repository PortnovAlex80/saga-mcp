// src/helpers/selfid.ts
//
// SRS-004 §2b.4 (Self-id sub-section) — read the parent session id of the
// currently-running subagent.
//
// The parent session id is NOT passed into extractInputs from outside; a
// subagent obtains it via this function. It reads the runner's metadata.json,
// finds the entry with status:'running', and returns its parentSessionId.
// Returns null when absent — the caller MUST then fail loudly (not silently).
//
// ============================================================================
// Implemented by body-task AC-2 (#218).
// ============================================================================

import { readFileSync } from 'node:fs';

/**
 * Default metadata.json location: the runner's per-agent runtime metadata.
 *
 * Resolved relative to the user home (`.zcode/agents/<self>/metadata.json`),
 * matching the SRS §2b.4 path convention `~/.zcode/agents/<self>/metadata.json`.
 * The `<self>` segment is the running agent id; it is read from the
 * `ZCODE_AGENT_ID` env var when set (the runner exports it for subagents).
 * When unset, this default points at the literal `agents/<self>/` directory —
 * callers normally pass `metadataPath` explicitly in production.
 */
export const DEFAULT_METADATA_PATH = (() => {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const selfId = process.env.ZCODE_AGENT_ID || '<self>';
  return `${home}/.zcode/agents/${selfId}/metadata.json`;
})();

/**
 * Read this subagent's parent session id (SRS §2b.4).
 *
 * Reads metadata.json → finds the entry with status:'running' → returns its
 * parentSessionId. Returns null when no running session is recorded (caller
 * must then fail with an explicit error, not proceed silently).
 *
 * The metadata file may take either shape:
 *   - an array of session records: `[{ status, parentSessionId, ... }]`
 *   - a single record:             `{ status, parentSessionId, ... }`
 * Both are tolerated; an array is searched in order, the first record with
 * `status === 'running'` wins.
 *
 * A missing/unreadable file is NOT an error here: it returns `null`, and the
 * CONTRACT is that the caller fails loudly with an explicit message (see
 * SRS §2b.4: "null при отсутствии → субагент падает с явной ошибкой (не тихо)").
 * Returning null rather than throwing keeps this function pure/testable and
 * pushes the loud-fail decision to the call-site, exactly per the contract.
 *
 * @param metadataPath optional override path to the metadata file
 *   (defaults to {@link DEFAULT_METADATA_PATH}).
 * @returns the parent session id, or null if no running session is recorded
 *   (or the file is missing/unreadable/unparseable).
 *
 * @see SRS-004 §2b.4
 */
export function readSelfSessionId(metadataPath?: string): string | null {
  const path = metadataPath ?? DEFAULT_METADATA_PATH;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Missing/unreadable metadata file → no running session known. Caller must
    // fail loudly (this function deliberately returns null, not throw, per the
    // SRS §2b.4 "null при отсутствии" contract).
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt metadata.json → treat as "no running session": null + caller
    // fails loudly. (Matches the "не тихий проход" contract: the caller throws
    // the explicit error; this helper reports the absence.)
    return null;
  }

  const records: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? [parsed]
      : [];

  for (const rec of records) {
    if (rec && typeof rec === 'object') {
      const r = rec as Record<string, unknown>;
      if (r['status'] === 'running') {
        const parent = r['parentSessionId'];
        if (typeof parent === 'string' && parent.length > 0) {
          return parent;
        }
      }
    }
  }

  // No record with status:'running' (and a non-empty parentSessionId) found.
  return null;
}
