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
// SCAFFOLD ONLY (Pattern B, task #215).
// ============================================================================
// This file fixes the API CONTRACT (function signature) BEFORE the body-task
// lands. The function body is a stub that throws NotImplementedError. The full
// implementation (metadata.json parse + running-session lookup) is body-task
// AC-2 (#218 — extractInputs + readSelfSessionId).
// ============================================================================

/**
 * Read this subagent's parent session id (SRS §2b.4).
 *
 * Reads metadata.json → finds the entry with status:'running' → returns its
 * parentSessionId. Returns null when no running session is recorded (caller
 * must then fail with an explicit error, not proceed silently).
 *
 * @param metadataPath optional override path to the metadata file.
 * @returns the parent session id, or null if absent.
 *
 * SCAFFOLD stub — throws NotImplementedError. Body-task AC-2 (#218) implements
 * the real metadata.json parse.
 *
 * @see SRS-004 §2b.4
 * @see body-task AC-2 (#218) — implements the body
 */
export function readSelfSessionId(_metadataPath?: string): string | null {
  // SCAFFOLD stub — body-task AC-2 (#218) implements the real logic.
  throw new Error('NotImplemented: readSelfSessionId — see body-task AC-2 (#218), SRS §2b.4');
}
