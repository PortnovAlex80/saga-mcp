/**
 * contracts/validators/common.d.mts - the TypeScript declaration of the
 * FRF-WP03 shared helpers (FRF-WP11 canonical home: the .mjs beside this
 * file is the runtime module; the docs-tree copy is a frozen byte-equal
 * snapshot pinned by the FRF removal guard).
 *
 * The helpers are deliberately loosely typed (unknown in, typed refusal
 * or canonical string out): they are pure content-addressing utilities
 * shared by every validator.
 */

export declare const REFUSAL_REASONS: readonly string[];

export declare function sortKeys(value: unknown): unknown;
export declare function canonicalJson(value: unknown): string;
export declare function sha256OfCanonical(value: unknown): string;
export declare function sha256OfText(text: string): string;
export declare function digestExcluding(value: Record<string, unknown>, excludedKeys: readonly string[]): string;

export declare function refused(reason: string, detail: string): { ok: false; refused: true; reason: string; detail: string };
export declare function sealed(kind: string, payload: unknown): { ok: true; kind: string; digest: string; ref: string; payload: unknown };
export declare function requireIdSet(universe: unknown, setName: string, purpose: string): { ids: readonly string[] } | { ok: false; refused: true; reason: string; detail: string };
export declare function resolveRefs(refs: unknown, setName: string, universe: unknown, options: { purpose: string }): { ok: true; refs: readonly string[] } | { ok: false; refused: true; reason: string; detail: string };
export declare function resolveBranchRefsWithinCitedScenarios(
  branchRefs: unknown,
  scenarioRefs: readonly string[],
  universe: unknown,
  options: { branchSetMissing: string; purpose: string },
): { ok: true; refs: readonly string[] } | { ok: false; refused: true; reason: string; detail: string };
export declare function setIdentical(
  actualIds: readonly string[],
  expectedIds: readonly string[],
  options: { extraRefusal?: string; missingRefusal?: string; subject: string },
): { ok: true } | { ok: false; refused: true; reason: string; detail: string };
export declare function findDuplicates(values: readonly unknown[]): readonly unknown[];
export declare function validateWithSchema(schema: unknown, instance: unknown): { ok: true } | { ok: false; refused: true; reason: string; detail: string };

export declare const ID_PATTERN: string;
export declare const SHA256_REF_PATTERN: string;
export declare const SHA256_HEX_PATTERN: string;
