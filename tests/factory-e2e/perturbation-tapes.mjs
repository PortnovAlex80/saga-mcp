// tests/factory-e2e/perturbation-tapes.mjs
//
// ADR-096 Phase 7 / W4 — the DETERMINISTIC PERTURBATION-SEED TAPE SELECTOR
// (qualification gate item 3: "three fresh whole-factory runs ... different
// deterministic perturbation seeds").
//
// WHAT THIS IS: SELECTION, NOT PERTURBATION. The W9 harness contract forbids
// random fault injection (src/factory-e2e/run-manifest.ts: "crash points are
// named and deterministic — random fault injection is structurally
// rejected"). A "seed" therefore must NOT invent new fault logic; it selects
// ONE NAMED TAPE from a frozen, versioned, enumerated table
// (perturbation-tapes.v1.json), and every tape is an already-declared
// deterministic scenario variant driven by an existing entrypoint.
//
// ENV CONTRACT: W9_PERTURBATION_SEED=<n> (non-negative integer).
//   seed n            -> tapes[n mod tapes.length]
//   absent/unparseable-> the default tape (index 0) — current behavior unchanged
//   in-lane tape      -> the entrypoint runs that tape's scenario (a conflicting
//                        explicit W9_SCENARIO is a typed error, never a guess)
//   out-of-lane tape  -> the entrypoint keeps its current behavior; the resolved
//                        tape name is STILL recorded in the evidence so no run
//                        is silently unattributable
//
// The .test.mjs wrappers forward process.env to their child drives, so the
// seed flows through the wrappers unchanged.

import { existsSync, readFileSync } from 'node:fs';

export const PERTURBATION_SEED_ENV = 'W9_PERTURBATION_SEED';
export const PERTURBATION_TAPE_TABLE_VERSION = 1;

let cachedTable = null;

/**
 * Load + structurally validate the frozen tape table. Throws
 * PERTURBATION_TAPE_TABLE_INVALID on any violation (this is a frozen
 * qualification artifact — a malformed table must never be silently
 * interpreted). Result is cached and frozen.
 */
export function loadPerturbationTapeTable() {
  if (cachedTable) return cachedTable;
  const url = new URL('./perturbation-tapes.v1.json', import.meta.url);
  let raw;
  try {
    raw = JSON.parse(readFileSync(url, 'utf8'));
  } catch (e) {
    throw new Error(`PERTURBATION_TAPE_TABLE_INVALID: cannot read ${url}: ${e.message}`);
  }
  const invalid = (why) => new Error(`PERTURBATION_TAPE_TABLE_INVALID: ${why}`);
  if (raw.kind !== 'saga-mcp.perturbation-tapes' || raw.version !== PERTURBATION_TAPE_TABLE_VERSION) {
    throw invalid(`expected kind 'saga-mcp.perturbation-tapes' version ${PERTURBATION_TAPE_TABLE_VERSION}`);
  }
  if (!Array.isArray(raw.tapes) || raw.tapes.length === 0) {
    throw invalid('tapes must be a non-empty array');
  }
  const seenNames = new Set();
  const seenManifestIds = new Set();
  raw.tapes.forEach((tape, i) => {
    if (tape.index !== i) throw invalid(`tapes[${i}].index must be ${i}, got ${String(tape.index)}`);
    for (const field of ['name', 'drive', 'manifestId']) {
      if (typeof tape[field] !== 'string' || tape[field].trim() === '') {
        throw invalid(`tapes[${i}].${field} must be a non-empty string`);
      }
    }
    if (tape.scenario !== null && (typeof tape.scenario !== 'string' || tape.scenario.trim() === '')) {
      throw invalid(`tapes[${i}].scenario must be null or a non-empty string`);
    }
    if (seenNames.has(tape.name)) throw invalid(`duplicate tape name '${tape.name}'`);
    seenNames.add(tape.name);
    if (seenManifestIds.has(tape.manifestId)) {
      throw invalid(`duplicate manifestId '${tape.manifestId}' — one tape per declared scenario`);
    }
    seenManifestIds.add(tape.manifestId);
    // The declared drive entrypoint must exist next to this helper.
    if (!existsSync(new URL(`./${tape.drive}`, import.meta.url))) {
      throw invalid(`tapes[${i}].drive '${tape.drive}' has no entrypoint next to perturbation-tapes.mjs`);
    }
  });
  const defaults = raw.tapes.filter((t) => t.default === true);
  if (defaults.length !== 1 || defaults[0].index !== 0) {
    throw invalid('exactly tapes[0] must carry default:true (the unseeded behavior)');
  }
  cachedTable = Object.freeze({
    ...raw,
    tapes: Object.freeze(raw.tapes.map((t) => Object.freeze({ ...t }))),
  });
  return cachedTable;
}

/**
 * Parse a raw seed value. Returns the non-negative integer seed, or null for
 * absent/empty/unparseable values (null = "no seed" = default tape; the
 * brief pins this — an unknown seed must leave current behavior unchanged).
 */
export function parsePerturbationSeed(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * seed -> tape by the frozen rule: null seed -> the default tape, otherwise
 * tapes[seed mod tapes.length] (every integer seed is in domain).
 */
export function selectPerturbationTape(table, seed) {
  if (seed === null || seed === undefined) {
    const def = table.tapes.find((t) => t.default === true);
    if (!def) throw new Error('PERTURBATION_TAPE_TABLE_INVALID: no default tape');
    return def;
  }
  return table.tapes[seed % table.tapes.length];
}

/**
 * Resolve the tape for an env (default: process.env). Frozen result carrying
 * the parsed seed (null when absent/unparseable) and the selected tape.
 */
export function resolvePerturbationTape(env = process.env) {
  const seedRaw = env[PERTURBATION_SEED_ENV];
  const seed = parsePerturbationSeed(seedRaw);
  const table = loadPerturbationTapeTable();
  const tape = selectPerturbationTape(table, seed);
  return Object.freeze({ seed, seedRaw: seedRaw === undefined ? null : seedRaw, tape, tapeName: tape.name });
}

/**
 * Full drive-entrypoint selection. Combines the seed contract with the
 * legacy explicit W9_SCENARIO selection:
 *
 *   - No seed: scenario = explicit W9_SCENARIO ?? fallbackScenario
 *     (byte-for-byte the pre-seed behavior).
 *   - Seed selecting an IN-LANE tape (tape.drive === driveFile) with a
 *     scenario: that scenario wins; a CONFLICTING explicit W9_SCENARIO is a
 *     typed error (W9_TAPE_CONFLICT) — never a silent guess. An agreeing
 *     W9_SCENARIO is fine.
 *   - Seed selecting an OUT-OF-LANE tape: scenario keeps its current
 *     resolution; applied=false; the tape name is still reported so the run
 *     is attributable.
 *
 * @param {object} opts
 * @param {object} [opts.env]        Environment (default process.env).
 * @param {string} opts.driveFile    This entrypoint's own filename (e.g.
 *                                   'w9-02-single-drive.mjs').
 * @param {string|null} [opts.fallbackScenario] Scenario this drive runs when
 *                                   nothing selects one (null = the drive's
 *                                   built-in default path).
 */
export function resolveDriveTapeSelection({ env = process.env, driveFile, fallbackScenario = null }) {
  const explicitRaw = env.W9_SCENARIO;
  const explicit = typeof explicitRaw === 'string' && explicitRaw.trim() !== '' ? explicitRaw.trim() : null;
  const { seed, seedRaw, tape, tapeName } = resolvePerturbationTape(env);

  let scenario = explicit ?? fallbackScenario;
  let applied = false;
  if (seed !== null && tape.drive === driveFile && tape.scenario !== null) {
    if (explicit !== null && explicit !== tape.scenario) {
      throw new Error(
        `W9_TAPE_CONFLICT: ${PERTURBATION_SEED_ENV}=${String(seedRaw)} selects tape '${tape.name}' `
        + `(scenario '${tape.scenario}') for ${driveFile}, but W9_SCENARIO='${explicit}' — unset one of them`,
      );
    }
    scenario = tape.scenario;
    applied = true;
  }
  return Object.freeze({ seed, seedRaw: seedRaw ?? null, tape, tapeName, scenario, applied });
}
